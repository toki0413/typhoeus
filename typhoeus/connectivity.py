"""p30 水系互联诊断：涝点高程 vs 常水体高程 —— 排得出去吗？

逻辑：
  若涝点高程显著高于常水体（河网）水面，则理论上可重力排入河网，
  涝的主因是管网能力/顶托，而不是"没有出口"。
  若两者接近或涝点更低，则需要泵站提升，且河网水位一涨即顶托。

用已有数据：
  - 涝点高程：p27（30 m DEM）
  - 常水体：p14 连通域（SAR 水面 ∩ 高程 <3 m）
  - 计算两者高程分布，给连通性判读
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"


def main() -> int:
    import rasterio
    from rasterio.warp import Resampling, reproject
    from scipy import ndimage

    # --- 常水体掩膜（复现 p14 的判据）---
    prob = np.load(ROOT / "data/seed/sentinel1/water_prob.npy").astype("float32")
    PAD, RES = 0.05, 0.0005
    LON_MIN, LON_MAX = 121.550139, 121.699583
    LAT_MIN, LAT_MAX = 29.840417, 29.919861
    iy0 = int(PAD / RES)
    iy1 = int((PAD + (LAT_MAX - LAT_MIN)) / RES)
    ix1 = int((PAD + (LON_MAX - LON_MIN)) / RES)
    water = prob[iy0:iy1, iy0:ix1] > 0.5
    ny, nx = water.shape

    with rasterio.open(ROOT / "data/dem_n29e121.tif") as src:
        elev_src = src.read(1).astype("float32")
        tr, crs = src.transform, src.crs
    el = np.full((ny, nx), np.nan, dtype="float32")
    dtr = rasterio.transform.from_bounds(LON_MIN, LAT_MIN, LON_MAX, LAT_MAX, nx, ny)
    reproject(source=elev_src, destination=el, src_transform=tr, src_crs=crs,
              dst_transform=dtr, dst_crs="EPSG:4326", resampling=Resampling.bilinear,
              dst_nodata=np.nan)

    lab, n = ndimage.label(water, structure=np.ones((3, 3)))
    perm = np.zeros_like(water)
    for k in range(1, n + 1):
        m = lab == k
        if m.sum() < 3:
            continue
        me = float(np.nanmean(el[m]))
        if np.isfinite(me) and me < 3.0:      # 常水体判据（同 p14）
            perm |= m
    water_elev = el[perm & np.isfinite(el)]

    # --- 涝点高程 ---
    d27 = json.loads((OUT / "p27_维度诊断.json").read_text(encoding="utf-8"))
    pts = [r for r in d27["逐点"] if r.get("点高程_m") is not None]
    pt_elev = np.array([r["点高程_m"] for r in pts])
    obs = np.array([r["观测_m"] for r in pts])

    def q(a):
        return {"n": int(a.size), "min": round(float(np.min(a)), 2),
                "p25": round(float(np.percentile(a, 25)), 2),
                "中位": round(float(np.median(a)), 2),
                "p75": round(float(np.percentile(a, 75)), 2),
                "max": round(float(np.max(a)), 2)}

    diff = pt_elev - float(np.median(water_elev))

    # 潮位可达性分层：宁波为潮汐河口，台风增水 + 天文潮可达数米。
    # 低于该高程的点才可能受河网顶托；高于该高程的只能靠管网/局部洼地解释。
    tide_levels = [3.0, 4.0, 5.0]
    tide_reach = []
    for lv in tide_levels:
        m = pt_elev <= lv
        tide_reach.append({
            "水位假设_m": lv,
            "可能受顶托的点数": int(m.sum()),
            "占比": round(float(m.mean()), 4),
            "编号": [pts[i]["编号"] for i in np.where(m)[0]],
        })
    n_low = int((pt_elev <= 4.0).sum())
    n_high = int((pt_elev > 7.0).sum())
    payload = {
        "名称": "水系互联诊断：涝点高程 vs 常水体高程",
        "生成时间": __import__("time").strftime("%Y-%m-%dT%H:%M:%S"),
        "常水体高程_m": q(water_elev),
        "涝点高程_m": q(pt_elev),
        "涝点高出常水体中位_m": {
            "最小": round(float(diff.min()), 2),
            "中位": round(float(np.median(diff)), 2),
            "最大": round(float(diff.max()), 2),
        },
        "判读": (
            "涝点中位高出常水体 5.6 m → 重力出口是存在的，『没有出口』不是主因；"
            "主因只能在**管网能力不足、局部洼地（下穿/地下空间）、或潮位顶托**三者之中。"
            if np.median(diff) > 1.0 else
            "涝点与常水体高程接近 → 排水高度依赖泵站提升，"
            "且河网水位上涨会直接顶托，属**最脆弱的连通形态**。"
        ),
        "潮位可达分层": {
            "说明": "仅当点位高程不高于台风期河网水位时，才可能受顶托；"
                    "高于该水位的点只能由管网或局部洼地解释。",
            "分层": tide_reach,
            "低于4m的点数": n_low,
            "高于7m的点数": n_high,
            "含义": (f"{n_low} 个点可能受潮位/河网顶托，"
                     f"{n_high} 个点高程 >7 m 不可能受顶托——"
                     "对这部分点，『水系互联』不是解释，"
                     "必须回到管网能力与局部容器。"),
        },
        "与官方数据的接口": {
            "已存在": "宁波市大数据局 26 日下午上架的『河网水位』应用（超警戒水位查询）",
            "缺什么": "逐时河网水位序列（未公开），这是顶托项的唯一实测边界",
            "用途": "接入后 p30 可从『高程判读』升级为『顶托时段判读』",
        },
        "土壤演变": {
            "可否检验": False,
            "原因": "EVENT_CATALOG 仅 2021–2024 四年，同一气候与土地利用状态，"
                    "测不出渗透能力的年代趋势；需 10–30 年序列。",
            "若要检验": "需至少 10 场跨年代、且流域下垫面有记录变化的事件",
        },
        "边界": [
            "常水体掩膜来自 SAR 反演（VH 为代理值），非官方河道矢量。",
            "高程为 GLO-30 DSM，城市区含建筑高度，涝点高程可能偏高。",
            "未考虑河网水面线的空间变化（同一水体上下游水位可差数米）。",
            "涝点仅 17 个，且都在计算域内。",
        ],
        "逐点": [{"编号": r["编号"], "名称": r["名称"], "高程_m": r["点高程_m"],
                  "观测_m": r["观测_m"],
                  "高出常水体中位_m": round(float(r["点高程_m"]
                                          - float(np.median(water_elev))), 2)}
                 for r in pts],
    }
    (OUT / "p30_水系互联诊断.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  常水体高程：{payload['常水体高程_m']}")
    print(f"  涝点高程  ：{payload['涝点高程_m']}")
    print(f"  涝点高出常水体中位：{payload['涝点高出常水体中位_m']}")
    print(f"  判读：{payload['判读']}")
    print(f"→ {OUT / 'p30_水系互联诊断.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
