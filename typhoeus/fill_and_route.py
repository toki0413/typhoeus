"""p64 填洼后再路由：能否真正把水汇到少数低点。

p61 的发现：D8 路由在**原始 DSM** 上只把湿格压到 15.57%，而局部洼地占 12.2%
——水被收进 4754 个小坑。本件在 **priority-flood 填后地形** 上路由，
让水跨过小坑到达真正的汇。

用法：python -m typhoeus.fill_and_route
"""

from __future__ import annotations

import copy
import csv
import json
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
WET_TH = 0.05
TARGET_AREA = 2.19

RATES = (0.05, 0.10, 0.20, 0.35)


def main() -> int:
    from typhoeus import cli as CLI
    from typhoeus import config as CFG
    from typhoeus import data as D
    from typhoeus import kernel as K
    from typhoeus import observe as OB
    from typhoeus import rainsrc as RS

    p25 = json.loads((OUT / "p25_序数技能检验.json").read_text(encoding="utf-8"))
    pts = p25["逐点"]
    obs = np.array([p["观测_m"] for p in pts], float)
    with open(ROOT / "data/seed/flood_points_2021_infa.csv",
              encoding="utf-8-sig") as f:
        ledger = {r["point_id"]: r for r in csv.DictReader(f)}

    cfg = CFG.Config()
    inp = D.load_all(cfg.l2.bbox, cfg.l4.resample)
    g = inp.grid
    lon, lat = np.asarray(g.lon), np.asarray(g.lat)
    rain, _ = RS.get_rainfall(g, stations=OB.load_rain_stations(),
                              use_cache=True, calibrate=cfg.l2.rain_calibrate,
                              verbose=False)
    base_kp = CLI._kernel_params(cfg)
    area_ha = float(g.elev.size) * (g.cell_m ** 2) / 1e4

    z = np.asarray(g.elev, float)
    filled = K.priority_flood_fill(z)
    dep = np.maximum(filled - z, 0.0)
    print(f"  填洼：容量 {dep.mean()*1000:.1f} mm，"
          f"有洼地格 {(dep>1e-6).mean()*100:.1f}%，"
          f"填后最大抬升 {dep.max():.2f} m")

    rows = []
    for use_filled in (False, True):
        for rate in RATES:
            kp = copy.copy(base_kp)
            kp.concentration_rate = float(rate)
            kp.concentration_use_filled = bool(use_filled)
            t0 = time.perf_counter()
            try:
                res = K.run(g, rain, kp)
            except Exception as e:  # noqa: BLE001
                print(f"    filled={use_filled} rate={rate} 失败 {type(e).__name__}")
                continue
            el = round(time.perf_counter() - t0, 1)
            peak = np.asarray(res.depth).max(axis=0)
            mod_pt = []
            for p in pts:
                r = ledger.get(p["编号"])
                if r is None:
                    mod_pt.append(np.nan)
                    continue
                x, y = float(r["lon"]), float(r["lat"])
                i = int(np.abs(lat - y).argmin())
                j = int(np.abs(lon - x).argmin())
                mod_pt.append(float(peak[i, j]))
            mod_pt = np.array(mod_pt, float)
            resi = obs - mod_pt
            wet = float((peak >= WET_TH).sum()) * (g.cell_m ** 2) / 1e4 \
                / area_ha * 100
            rows.append({
                "填洼后路由": bool(use_filled), "rate": rate,
                "峰值最大_m": round(float(peak.max()), 4),
                "湿格面积_pct": round(wet, 3),
                "面积相对观测倍数": round(wet / TARGET_AREA, 2),
                "点位均值_m": round(float(np.nanmean(mod_pt)), 4),
                "点位MAE_m": round(float(np.nanmean(np.abs(resi))), 4),
                "残差均值_m": round(float(np.nanmean(resi)), 4),
                "守恒残差": float(f"{res.mass_resid:.2e}"),
            })
            print(f"    filled={str(use_filled):<5} rate={rate:<5} "
                  f"湿格 {wet:6.2f}%（{wet/TARGET_AREA:4.2f}×）  "
                  f"点位 {np.nanmean(mod_pt):.4f}  "
                  f"MAE {np.nanmean(np.abs(resi)):.4f}  "
                  f"残差 {np.nanmean(resi):+.4f}")

    if not rows:
        raise SystemExit("无成功运行")

    base = {"湿格面积_pct": 19.09, "点位均值_m": 0.0366,
            "点位MAE_m": 0.3593, "残差均值_m": 0.3593}
    best = min(rows, key=lambda r: r["面积相对观测倍数"])
    best_mae = min(rows, key=lambda r: r["点位MAE_m"])
    both = [r for r in rows
            if r["湿格面积_pct"] < base["湿格面积_pct"]
            and r["点位均值_m"] > base["点位均值_m"]]
    offset_gone = [r for r in rows if abs(r["残差均值_m"]) < 0.05]

    payload = {
        "名称": "填洼后再路由：能否把水汇到少数低点",
        "生成时间": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "动机": ("p61 实测 D8 在原始 DSM 上只把湿格压到 15.57%，"
               "而局部洼地占 12.2%（4754 个）——水被收进 4754 个小坑。"
               "故先 priority-flood 填洼，再在填后地形上算 D8。"),
        "填洼统计": {
            "容量_mm": round(float(dep.mean() * 1000), 1),
            "有洼地格占比_pct": round(float((dep > 1e-6).mean() * 100), 1),
            "最大抬升_m": round(float(dep.max()), 2),
        },
        "扫描": rows,
        "基线_未路由": base,
        "最优面积": best,
        "最优MAE": best_mae,
        "同时改善": bool(both),
        "可证伪预测": {
            "预测": "若摊薄由小坑困水造成，填洼后路由应使面积显著下降",
            "是否消失偏移": bool(offset_gone),
        },
        "结论": [],
        "边界": [
            "填洼会**消除所有洼地**（包括真实洼地），故路由在填后地形上不会滞留，"
            "水最终会走向边界出口；这与『水应积在低洼区』存在张力——"
            "本件的路由只用填后地形定**方向**，蓄水仍按原始地形计算。",
            "rate 无实测可标定，只报其对输出的影响。",
            "填洼容量 167.4 mm 含建筑压平造成的假洼地。",
            "未做跨事件验证。",
        ],
    }

    concl = [
        ("**扫描**：" + "；".join(
            f"{'填洼' if r['填洼后路由'] else '原始'} rate {r['rate']} → "
            f"面积 {r['湿格面积_pct']:.2f}%/MAE {r['点位MAE_m']:.3f}"
            for r in rows) + "。"),
        (f"**最优面积 {best['湿格面积_pct']}%（{best['面积相对观测倍数']}×）"
         f"@ 填洼={best['填洼后路由']} rate={best['rate']}**；"
         f"最优 MAE {best_mae['点位MAE_m']}。"),
    ]
    if both:
        concl.append(
            "**存在面积下降且点位上升的方案**："
            + "、".join(f"填洼={r['填洼后路由']}/rate={r['rate']}" for r in both)
            + "。")
    else:
        concl.append("**没有方案同时做到面积下降与点位上升。**")
    if offset_gone:
        concl.append("**偏移消失**：残差均值已降到 ±0.05 m 内。")
    else:
        concl.append(
            "**偏移未消失**：残差均值仍在 ±0.05 m 外，还有机制未找到。")
    payload["结论"] = concl

    (OUT / "p64_填洼后路由.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n  最优面积 {best['湿格面积_pct']}%"
          f"（{best['面积相对观测倍数']}×）@filled={best['填洼后路由']} "
          f"rate={best['rate']}")
    print(f"  同时改善 {bool(both)}  偏移消失 {bool(offset_gone)}")
    print(f"→ {OUT / 'p64_填洼后路由.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
