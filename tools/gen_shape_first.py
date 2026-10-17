"""形状优先策略的可行性检验：哪些结论对降雨幅度敏感？

背景：模型对短历时强对流的**幅度**低估约 10 倍，但**形状**可能仍可用。
问题：如果只用形状、把幅度当待定标量，哪些产品结论还能站住？

设计：同一时间形状（Open-Meteo best_match 实测曲线），幅度按 k 倍放大，
      k ∈ {1, 2, 3, 5, 10}。观察三类量的变化：
        A. 峰值水深
        B. 达到 0.27 m 的**时刻**（依赖幅度）
        C. 达到 0.27 m 的**累计面雨量**（可能不依赖幅度）

若 C 稳定 → 产品应输出"累计雨量触发阈值"，而不是"时刻"。
这就是"形状优先"的正确形态：把需要准幅度的量，换成模型内禀的量。
"""

from __future__ import annotations

import json
import ssl
import urllib.request
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
CACHE = ROOT / "data" / "seed" / "zhengzhou"
LON_MIN, LON_MAX = 113.58, 113.72
LAT_MIN, LAT_MAX = 34.70, 34.82
SCALES = [1.0, 2.0, 3.0, 5.0, 10.0]
THRESH = 0.27          # 下穿立交断行水深
CTX = ssl.create_default_context()
UA = {"User-Agent": "Mozilla/5.0 typhoeus-shapeprobe"}


def fetch_profile() -> np.ndarray:
    """Open-Meteo best_match 逐时降水（与主链同口径）。"""
    url = ("https://archive-api.open-meteo.com/v1/archive"
           "?latitude=34.75&longitude=113.65"
           "&start_date=2021-07-19&end_date=2021-07-22"
           "&hourly=precipitation&timezone=UTC")
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA),
                                timeout=90, context=CTX) as r:
        j = json.loads(r.read().decode("utf-8", "replace"))
    return np.array([v or 0.0 for v in j["hourly"]["precipitation"]], dtype=float)


def build_grid():
    import rasterio
    from rasterio.warp import Resampling, reproject

    from typhoeus import data as D

    with rasterio.open(CACHE / "dem_n34e113.tif") as src:
        elev = src.read(1).astype("float64")
        tr, crs = src.transform, src.crs
    ny, nx = 144, 270
    dst = np.full((ny, nx), np.nan, dtype="float64")
    dtr = rasterio.transform.from_bounds(LON_MIN, LAT_MIN, LON_MAX, LAT_MAX, nx, ny)
    reproject(source=elev, destination=dst, src_transform=tr, src_crs=crs,
              dst_transform=dtr, dst_crs="EPSG:4326",
              resampling=Resampling.bilinear, dst_nodata=np.nan)
    dst = np.nan_to_num(dst, nan=float(np.nanmedian(dst)))
    return D.Grid(lon=np.linspace(LON_MIN, LON_MAX, nx),
                  lat=np.linspace(LAT_MIN, LAT_MAX, ny), elev=dst,
                  cell_m=float(((LON_MAX - LON_MIN) * 111320.0 / nx
                                + (LAT_MAX - LAT_MIN) * 110540.0 / ny) / 2))


def main() -> int:
    from typhoeus import cli as CLI
    from typhoeus import config as CFG
    from typhoeus import kernel as K

    cfg = CFG.Config()
    g = build_grid()
    kp = CLI._kernel_params(cfg)
    nt = int(kp.max_t_h * 3600 / kp.dt_s) + 1

    prof_h = fetch_profile()
    src_t = np.linspace(0, 1, len(prof_h))
    dst_t = np.linspace(0, 1, nt)
    base = np.interp(dst_t, src_t, prof_h)          # 形状（mm/h），峰值 19.3
    shape = base / max(base.max(), 1e-9)            # 归一化形状，峰值 = 1
    dt_h = kp.dt_s / 3600.0

    print(f"  形状：{len(prof_h)} 个逐时点插值到 {nt} 步；原始峰值 "
          f"{prof_h.max():.1f} mm/h，累计 {prof_h.sum():.1f} mm")

    rows = []
    for k in SCALES:
        prof = shape * (prof_h.max() * k)           # 峰值 = 19.3 × k
        rain = np.repeat(np.repeat(prof[:, None, None], g.elev.shape[0], axis=1),
                         g.elev.shape[1], axis=2).astype(np.float32)
        res = K.run(g, rain, kp)
        depth = np.asarray(res.depth)               # (T, ny, nx)
        peakf = depth.max(axis=0)
        total = float(prof.mean() * dt_h * nt)

        # 内涝"发生"的定义：受淹面积（水深≥0.27 m 的格点占比）首次超过 0.5%
        # 用全域最大水深会把"某一个格子先淹"当成发生，判据失真。
        area_frac = (depth >= THRESH).mean(axis=(1, 2))
        cross = np.where(area_frac >= 0.005)[0]
        t_cross = float(cross[0]) * dt_h if cross.size else None
        # 累计雨量必须是 sum×dt（积分），不是 mean×dt
        cum_at_cross = (float(prof[:cross[0] + 1].sum()) * dt_h
                        if cross.size else None)
        series = depth.max(axis=(1, 2))

        rows.append({
            "幅度倍数_k": k,
            "峰值雨强_mm_h": round(float(prof.max()), 1),
            "面雨量_mm": round(total, 1),
            "峰值水深_m": round(float(peakf.max()), 3),
            "全域最大水深峰值_m": round(float(series.max()), 4),
            "达0.27m时刻_h": round(t_cross, 2) if t_cross is not None else None,
            "达0.27m所需累计_mm": round(cum_at_cross, 1) if cum_at_cross is not None else None,
        })
        print(f"  k={k:>4}  峰值 {prof.max():6.1f} mm/h  面雨量 {total:6.1f} mm  "
              f"→ 水深 {peakf.max():.3f} m  越阈 t={rows[-1]['达0.27m时刻_h']} h  "
              f"累计 {rows[-1]['达0.27m所需累计_mm']} mm", flush=True)

    # 敏感性：以 k=1 为基准的相对变化
    b = rows[0]
    for r in rows:
        r["峰值水深_相对k1"] = round(r["峰值水深_m"] / max(b["峰值水深_m"], 1e-9), 3)
        if r["达0.27m时刻_h"] is not None and b["达0.27m时刻_h"]:
            r["时刻_相对k1"] = round(r["达0.27m时刻_h"] / b["达0.27m时刻_h"], 3)
        if r["达0.27m所需累计_mm"] and b["达0.27m所需累计_mm"]:
            r["累计阈值_相对k1"] = round(
                r["达0.27m所需累计_mm"] / b["达0.27m所需累计_mm"], 3)

    cum_vals = [r["达0.27m所需累计_mm"] for r in rows if r["达0.27m所需累计_mm"]]
    t_vals = [r["达0.27m时刻_h"] for r in rows if r["达0.27m时刻_h"] is not None]
    cum_spread = (max(cum_vals) / min(cum_vals) - 1) if len(cum_vals) > 1 else None
    t_spread = (max(t_vals) / min(t_vals) - 1) if len(t_vals) > 1 else None

    # 深度对幅度的标度指数：depth = a · k^b  →  b = Δln(depth)/Δln(k)
    ks = np.array([r["幅度倍数_k"] for r in rows], dtype=float)
    ds = np.array([r["峰值水深_m"] for r in rows], dtype=float)
    b_exp = float(np.polyfit(np.log(ks), np.log(ds), 1)[0])
    payload_extra = {"深度标度指数_b": round(b_exp, 3),
                     "k倍数10时深度倍数": round(10 ** b_exp, 2)}

    payload = {
        "名称": "形状优先策略可行性：哪些结论对降雨幅度敏感",
        "生成时间": __import__("time").strftime("%Y-%m-%dT%H:%M:%S"),
        "设计": ("同一时间形状（Open-Meteo best_match 实测曲线），幅度按 k 倍放大，"
                 f"k ∈ {SCALES}；观察峰值水深、越阈时刻、越阈累计雨量三类量的变化"),
        "形状": {"来源": "Open-Meteo best_match 2021-07-19..22 逐时",
                 "原始峰值_mm_h": round(float(prof_h.max()), 1),
                 "原始累计_mm": round(float(prof_h.sum()), 1)},
        "结果": rows,
        "敏感性": {
            "峰值水深_随k单调": bool(all(
                rows[i]["峰值水深_m"] <= rows[i + 1]["峰值水深_m"]
                for i in range(len(rows) - 1))),
            **payload_extra,
            "越阈时刻_跨度": round(t_spread, 3) if t_spread is not None else None,
            "越阈累计雨量_跨度": round(cum_spread, 3) if cum_spread is not None else None,
        },
        "结论": [
            ("峰值水深随幅度单调上升，故『深多少』必须依赖准的幅度；"
             "这是形状优先救不了的部分。"),
            (f"越阈**时刻**随幅度变化跨度 {t_spread:.1%}"
             if t_spread is not None else "越阈时刻未能确定"),
            (f"越阈**累计雨量**跨度 {cum_spread:.1%}"
             if cum_spread is not None else "越阈累计雨量未能确定"),
            "**若累计雨量阈值明显比时刻稳定**，产品应输出『累计雨量到 X mm 时断行』，"
            "而不是『几点断行』——前者是模型内禀量，后者需要准的雨强。",
        ],
        "边界": [
            "越阈用**全域平均水深**判定，不是某个具体涝点；郑州无本地台账。",
            "形状取自 Open-Meteo，本身在强对流上的时序也可能失真，未与实测时序比对。",
            "只放大幅度、不改形状，故本件隔离的是'幅度'这一个维度。",
            "共用宁波参数，未针对郑州标定。",
        ],
    }
    (OUT / "gen_shape_first.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n  时刻跨度 {t_spread:.1%}" if t_spread is not None else "\n  时刻跨度 —",
          end="")
    print(f"  累计阈值跨度 {cum_spread:.1%}" if cum_spread is not None else "  累计阈值跨度 —")
    print(f"  深度标度指数 b = {b_exp:.3f}（k×10 → 深度×{10**b_exp:.2f}）")
    print(f"→ {OUT / 'gen_shape_first.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
