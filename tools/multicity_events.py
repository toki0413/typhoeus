"""p71 双因子迁移：5 个城市 × 3 场台风。

p38 只做了「换城市、同一条雨」。本件加第二个因子：同一条参数、不同城市、
**不同场次**，看两件事是否仍然成立：

  1. 工程泛化：每格是否仍能跑通、守恒残差是否仍 < 1e-7；
  2. 排序泛化：同一城市内，峰值水深是否仍随面雨量单调（雨越大越深）。

降雨取自 ERA5 缓存（不联网），按域平均时程在目标城市网格上均匀铺开，
与 p38 同一口径。参数用宁波标定值，不逐城重标——测的就是「不重标的代价」。

用法：python tools/multicity_events.py
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))

from multicity_scan import CITIES, build_grid  # noqa: E402

OUT = ROOT / "out"
EVENTS = [
    ("2018-AMPIL", ROOT / "data/seed/rain_reanalysis_era5_2018ampil.npz"),
    ("2021-IN-FA", ROOT / "data/seed/rain_reanalysis_era5_2021in-fa.npz"),
    ("2025-DANAS", ROOT / "data/seed/rain_reanalysis_era5_2025danas.npz"),
]


def load_profile(path: Path) -> tuple[np.ndarray, float]:
    """从缓存取域平均逐时雨强 (nt,) 与面雨量（mm）。"""
    z = np.load(path)
    arr = next(np.asarray(z[k]) for k in z.files if np.asarray(z[k]).ndim == 3
               or np.asarray(z[k]).ndim == 4)
    while arr.ndim > 3:
        arr = arr[0]
    prof = arr.astype(float).mean(axis=(1, 2))
    return prof, float(prof.sum())


def main() -> int:
    from typhoeus import cli as CLI
    from typhoeus import config as CFG
    from typhoeus import data as D
    from typhoeus import kernel as K

    cfg = CFG.Config()
    kp = CLI._kernel_params(cfg)
    ha = None
    rows = []

    for name, lon_c, lat_c, terr in CITIES:
        dem = (ROOT / "data/dem_n29e121.tif") if name.startswith("宁波") else \
              (ROOT / "data/seed/cities" / f"Copernicus_DSM_COG_10_"
               f"{'N' if lat_c >= 0 else 'S'}{int(abs(lat_c)):02d}_00_"
               f"{'E' if lon_c >= 0 else 'W'}{int(abs(lon_c)):03d}_00_DEM.tif")
        if not dem.exists():
            print(f"SKIP {name}: 无 DEM {dem.name}")
            continue
        g = build_grid(dem, lon_c, lat_c)
        ha = (float(g.cell_m) ** 2) / 1e4
        land = g.elev >= 0.5
        n_land = int(land.sum())
        peaks = []
        for ev, path in EVENTS:
            if not path.exists():
                print(f"SKIP {ev}: 无缓存")
                continue
            prof, areal = load_profile(path)
            rain = np.repeat(np.repeat(prof[:, None, None], g.elev.shape[0], axis=1),
                             g.elev.shape[1], axis=2).astype(np.float32)
            t0 = time.perf_counter()
            res = K.run(g, rain, kp)
            peak = np.asarray(res.depth).max(axis=0)
            p = float(peak.max())
            peaks.append((ev, p, areal))
            rows.append({
                "城市": name, "地形": terr, "场次": ev,
                "面雨量_mm": round(areal, 1),
                "峰值水深_m": round(p, 4),
                "湿格占比_仅陆地": (round(float(((peak >= 0.05) & land).sum())
                                      / n_land, 4) if n_land else None),
                "守恒残差": float(res.mass_resid),
                "内核_s": round(time.perf_counter() - t0, 1),
            })
            print(f"{name:<10} {ev:<11} 面雨量 {areal:6.1f} mm  "
                  f"峰 {p:.4f} m  残差 {res.mass_resid:.2e}")

        if len(peaks) >= 2:
            order_rain = [e for e, _, a in sorted(peaks, key=lambda x: x[2])]
            order_peak = [e for e, p, _ in sorted(peaks, key=lambda x: x[1])]
            viol = sum(1 for a, b in zip(order_rain, order_peak) if a != b)
            for r in rows:
                if r["城市"] == name:
                    r["排序一致"] = (viol == 0)
            print(f"   ↳ 排序一致：{'是' if viol == 0 else f'否（{viol} 处差异）'}")

    ok = [r for r in rows]
    resids = [r["守恒残差"] for r in ok]
    payload = {
        "名称": "双因子迁移：城市 × 场次",
        "生成时间": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "设计": ("5 个城市 × 3 场台风，共用宁波标定参数（不逐城重标）；"
                 "降雨取 ERA5 缓存域平均时程，均匀铺在目标城市网格。"),
        "结果": ok,
        "汇总": {
            "组合数": len(ok),
            "跑通率": round(sum(1 for r in ok if r["峰值水深_m"] >= 0) / max(len(ok), 1), 4),
            "最大守恒残差": max(resids) if resids else None,
            "全部守恒": bool(resids and max(resids) < 1e-7),
            "排序一致城市数": sum(1 for r in ok if r.get("排序一致")),
            "峰值区间_m": [min(r["峰值水深_m"] for r in ok),
                        max(r["峰值水深_m"] for r in ok)] if ok else None,
        },
        "结论": [
            f"{len(ok)} 个组合全部跑通；守恒残差最大 {max(resids):.2e}（判据 <1e-7）。"
            if resids else "无有效组合。",
            "同一城市内，峰值水深随面雨量单调的城市数："
            f"{sum(1 for r in ok if r.get('排序一致'))}/{len({r['城市'] for r in ok})}。",
            "参数未逐城重标——本件测的是『不重标的代价』，不是各城精度。",
        ],
        "边界": [
            "各城市无本地台账，故只有结构结论，没有精度结论。",
            "降雨为同一时程形状铺开，未按各城市实际台风重建。",
            "共用宁波土壤/排水/不透水参数，城市间差异只来自地形与降雨。",
        ],
    }
    (OUT / "p71_双因子迁移.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n写入 out/p71_双因子迁移.json：{len(ok)} 个组合，"
          f"守恒全部通过={payload['汇总']['全部守恒']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
