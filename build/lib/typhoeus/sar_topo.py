"""SAR 水面连通域分析（p14）：用拓扑把常水体与疑似新增积水分开。

背景：p11 的面积型验证用了"全部 SAR 水面"，而其中大部分是常年河网，
把宽口径 IoU 拉得很低（0.0847）。本件回答"其中有多少可能是新增积水"。

斑块级判据（不需要河道矢量）：
  - 面积（格数 × 像元面积，0.0005° ≈ 3098 m²）
  - 平均高程（GLO-30）—— 宁波河网多在 0–3 m，街区积水多在 3 m 以上
  - 形状指数（边界长²/面积）—— 河道细长
  - 是否触域边界 —— 河道通常流出域外

用法：python -m typhoeus.sar_topo
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
S1 = ROOT / "data" / "seed" / "sentinel1"
OUT = ROOT / "out"

PAD_DEG, RES = 0.05, 0.0005
LON_MIN, LON_MAX = 121.550139, 121.699583
LAT_MIN, LAT_MAX = 29.840417, 29.919861
CELL_M2 = (RES * 111320.0) ** 2          # ≈ 3098 m²
PERMANENT_ELEV = 3.0                     # m，常水体高程上界
MIN_CELLS = 3


def build(outdir: str = "out", verbose: bool = True) -> dict | None:
    """读 SAR 水面概率 → 连通域 → 分类 → 落盘 p14。缺文件返回 None。"""
    prob_p = S1 / "water_prob.npy"
    dem_p = ROOT / "data" / "dem_n29e121.tif"
    if not prob_p.exists() or not dem_p.exists():
        if verbose:
            print("  [跳过] 缺 water_prob.npy 或 DEM（需先跑 AWS Sentinel-1 流程）")
        return None

    from scipy import ndimage

    prob = np.load(prob_p).astype("float32")
    iy0 = int(PAD_DEG / RES)
    iy1 = int((PAD_DEG + (LAT_MAX - LAT_MIN)) / RES)
    ix1 = int((PAD_DEG + (LON_MAX - LON_MIN)) / RES)
    p = prob[iy0:iy1, iy0:ix1]
    water = p > 0.5
    ny, nx = water.shape

    import rasterio
    from rasterio.warp import Resampling, reproject

    with rasterio.open(dem_p) as src:
        elev = src.read(1).astype("float32")
        tr, crs = src.transform, src.crs
    el = np.full((ny, nx), np.nan, dtype="float32")
    dtr = rasterio.transform.from_bounds(LON_MIN, LAT_MIN, LON_MAX, LAT_MAX, nx, ny)
    reproject(source=elev, destination=el, src_transform=tr, src_crs=crs,
              dst_transform=dtr, dst_crs="EPSG:4326",
              resampling=Resampling.bilinear, dst_nodata=np.nan)

    lab, n = ndimage.label(water, structure=np.ones((3, 3)))
    sizes = ndimage.sum(water, lab, range(1, n + 1))
    border = np.zeros_like(water)
    border[0, :] = border[-1, :] = border[:, 0] = border[:, -1] = True

    patches = []
    for k in range(1, n + 1):
        m = lab == k
        cells = int(sizes[k - 1])
        if cells < MIN_CELLS:
            continue
        mean_el = (float(np.nanmean(el[m])) if np.isfinite(el[m]).any()
                   else float("nan"))
        peri = int((ndimage.binary_dilation(m) & ~m).sum())
        rec = {
            "label": k, "格数": cells,
            "面积_公顷": round(cells * CELL_M2 / 1e4, 3),
            "平均高程_m": round(mean_el, 2) if np.isfinite(mean_el) else None,
            "形状指数": round((peri ** 2) / max(cells, 1), 2),
            "触域边界": bool((m & border).any()),
        }
        rec["类别"] = ("常水体" if (rec["平均高程_m"] is not None
                             and rec["平均高程_m"] < PERMANENT_ELEV
                             and (rec["面积_公顷"] > 2.0 or rec["触域边界"]))
                       else "疑似新增积水")
        patches.append(rec)

    perm = [x for x in patches if x["类别"] == "常水体"]
    add = [x for x in patches if x["类别"] == "疑似新增积水"]
    a_perm, a_add = (sum(x["面积_公顷"] for x in perm),
                     sum(x["面积_公顷"] for x in add))
    total = a_perm + a_add

    payload = {
        "名称": "SAR 水面连通域分析（拓扑）",
        "生成时间": datetime.now().isoformat(timespec="seconds"),
        "目的": "把常水体与疑似新增积水分开，修正 p11 宽口径 IoU 的已知缺陷",
        "方法": {
            "连通": "8 邻接（scipy.ndimage.label）",
            "常水体判据": f"平均高程 < {PERMANENT_ELEV} m 且（面积 > 2 公顷 或 触域边界）",
            "像元面积_m2": round(CELL_M2, 1),
        },
        "汇总": {
            "连通分量数": int(n),
            "有效斑块数": len(patches),
            "常水体": {"个数": len(perm), "面积_公顷": round(a_perm, 2)},
            "疑似新增积水": {"个数": len(add), "面积_公顷": round(a_add, 2)},
            "新增占全部水面": round(a_add / total, 4) if total else None,
            "水面总占比": round(float(water.mean()), 6),
        },
        "斑块": sorted(patches, key=lambda t: -t["面积_公顷"]),
        "边界": [
            "分类用高程与形状阈值，非河道矢量；阈值未标定。",
            "SAR 为瞬时快照（2021-07-25 21:50 UTC），非过程最大淹没。",
            "VH 通道为代理值，待真实 VH 补齐后重跑。",
            "『疑似新增积水』含雨中湿路面与浅层积水，未做风雨致粗糙度校正。",
        ],
    }
    p_out = Path(outdir)
    p_out.mkdir(parents=True, exist_ok=True)
    (p_out / "p14_SAR水面连通域.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    if verbose:
        s = payload["汇总"]
        print(f"  SAR 连通域：常水体 {s['常水体']['面积_公顷']} 公顷 / "
              f"疑似新增积水 {s['疑似新增积水']['面积_公顷']} 公顷"
              f"（新增占 {s['新增占全部水面']:.1%}）")
    return payload


if __name__ == "__main__":
    build(verbose=True)
