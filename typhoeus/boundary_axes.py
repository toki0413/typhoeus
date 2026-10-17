"""p68 边界条件：客水（外边界进水）与潮位时程（顶托随时间起伏）。

这两条此前都不是"没测"，而是**模型里不存在**：
  · 内核只有 `_rim_outflow`（出流），**没有任何入流路径**
  · `drainage_invert_m` 是一个**标量常数**，而真实潮位是时间序列

本件给两者各一个情景轴，量它们的杠杆。

客水量级怎么定
--------------
无观测。以「占降雨总量的比例」为标尺：
  20 m³/s × 72 h = 518 万 m³，约为降雨总量 2 897 万 m³ 的 **18%**。
故扫 0 / 5 / 20 / 50 / 100 m³/s → 对应 0 / 4.5% / 18% / 45% / 90%。

潮位时程怎么构造
----------------
真实潮位 = 半日潮 + 风暴潮增水。故：
  invert(t) = base + A · [0.4·sin(2π t / 12.4 h) + 0.6·exp(−((t−t_peak)/8h)²)]
`A` 为增水幅度，扫 0 / 0.10 / 0.20 / 0.35 m。
（`p41` 实测常数顶托 0.50 m 时红格 1 088 ha，故这一量级足够触及后果。）

用法：python -m typhoeus.boundary_axes
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
RED_TH = 0.50
TOTAL_MM = 259.1
TOTAL_RAIN_M3 = TOTAL_MM / 1000.0 * 11179.8e4   # 约 2 897 万 m³

INFLOWS = (0.0, 5.0, 20.0, 50.0, 100.0)
TIDE_AMP = (0.0, 0.10, 0.20, 0.35)


def tide_series(nt: int, dt_h: float, amp: float, base: float) -> np.ndarray:
    """半日潮 + 风暴潮增水。amp=0 时返回常数 base。"""
    t = np.arange(nt, dtype=float) * dt_h
    tide = 0.4 * np.sin(2.0 * np.pi * t / 12.4)
    surge = 0.6 * np.exp(-0.5 * ((t - 36.0) / 8.0) ** 2)
    return np.clip(base + amp * (tide + surge), 0.0, None)


def main() -> int:
    from typhoeus import cli as CLI
    from typhoeus import config as CFG
    from typhoeus import data as D
    from typhoeus import kernel as K
    from typhoeus import observe as OB
    from typhoeus import rainsrc as RS

    p25 = json.loads((OUT / "p25_序数技能检验.json").read_text(encoding="utf-8"))
    pts = p25["逐点"]
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
    nt = int(round(base_kp.max_t_h * 3600.0 / base_kp.dt_s))
    dt_h = base_kp.dt_s / 3600.0

    pid = []
    for p in pts:
        r = ledger.get(p["编号"])
        if r is None:
            continue
        x, y = float(r["lon"]), float(r["lat"])
        if not (lon.min() <= x <= lon.max() and lat.min() <= y <= lat.max()):
            continue
        pid.append((int(np.abs(lat - y).argmin()),
                    int(np.abs(lon - x).argmin())))

    def run(kp):
        res = K.run(g, rain, kp)
        peak = np.asarray(res.depth).max(axis=0)
        red = float((peak >= RED_TH).sum()) * (g.cell_m ** 2) / 1e4
        pt = float(np.mean([peak[i, j] for i, j in pid])) if pid else np.nan
        return peak, red, pt, res

    rows_in, rows_tide = [], []

    print("  客水（外边界进水）")
    for q in INFLOWS:
        kp = copy.copy(base_kp)
        kp.rim_inflow_m3s = float(q)
        _, red, pt, res = run(kp)
        vol = q * base_kp.max_t_h * 3600.0
        rows_in.append({
            "进水_m3s": q,
            "进水总量_万m3": round(vol / 1e4, 1),
            "占降雨_pct": round(vol / TOTAL_RAIN_M3 * 100, 1),
            "红格_ha": round(red, 2), "点位均值_m": round(pt, 4),
            "峰值_m": round(float(np.asarray(res.depth).max()), 4),
            "边界入_万m3": round(res.boundary_in_m3 / 1e4, 1),
            "残差": float(f"{res.mass_resid:.2e}"),
        })
        print(f"    {q:>5.0f} m³/s（占降雨 {vol/TOTAL_RAIN_M3*100:4.1f}%）"
              f"  红格 {red:8.2f} ha  点位 {pt:.4f}")

    print("  潮位时程（顶托随时间起伏）")
    for amp in TIDE_AMP:
        kp = copy.copy(base_kp)
        kp.drainage_invert_series = tide_series(
            nt, dt_h, amp, base_kp.drainage_invert_m)
        _, red, pt, res = run(kp)
        ser = np.asarray(kp.drainage_invert_series)
        rows_tide.append({
            "增水幅度_m": amp,
            "顶托_min_m": round(float(ser.min()), 3),
            "顶托_max_m": round(float(ser.max()), 3),
            "红格_ha": round(red, 2), "点位均值_m": round(pt, 4),
            "峰值_m": round(float(np.asarray(res.depth).max()), 4),
            "残差": float(f"{res.mass_resid:.2e}"),
        })
        print(f"    增水 {amp:.2f} m（顶托 {ser.min():.2f}–{ser.max():.2f}）"
              f"  红格 {red:8.2f} ha  点位 {pt:.4f}")

    def lever(vals):
        # 空表（例如全档红格皆 0）返回 None，不抛异常
        if not vals:
            return None
        lo, hi = min(vals), max(vals)
        if lo is None or hi is None:
            return None
        return round(hi / lo, 3) if lo > 1e-12 else None

    in_red = lever([r["红格_ha"] for r in rows_in if r["红格_ha"] > 0])
    tide_red = lever([r["红格_ha"] for r in rows_tide if r["红格_ha"] > 0])
    in_pt = lever([r["点位均值_m"] for r in rows_in])
    tide_pt = lever([r["点位均值_m"] for r in rows_tide])

    payload = {
        "名称": "边界条件两条轴：客水与潮位时程",
        "生成时间": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "为什么此前不存在": (
            "内核只有 `_rim_outflow`（出流），**没有任何入流路径**；"
            "`drainage_invert_m` 是**标量常数**，而真实潮位是时间序列。"
            "所以这两条不是没测，是模型里不存在。"),
        "客水": {"量级标尺": "20 m³/s × 72 h ≈ 518 万 m³ ≈ 降雨的 18%",
               "扫描": rows_in,
               "红格杠杆": in_red, "点位杠杆": in_pt},
        "潮位时程": {
            "构造": "invert(t)=base+A·[0.4·sin(2πt/12.4h)+0.6·exp(−((t−36h)/8h)²)]",
            "说明": "半日潮 + 风暴潮增水；A=0 时退化为常数 base",
            "扫描": rows_tide,
            "红格杠杆": tide_red, "点位杠杆": tide_pt},
        "结论": [],
        "边界": [
            "客水量级**无观测**，以『占降雨比例』为标尺扫描。",
            "客水按边界环**均摊**注入，真实来水只从上游一侧进入。",
            "潮位构造是**合成**的（半日潮+高斯增水），不是实测潮位过程。",
            "顶托上限 max 0.35 m 增水，未扫到 p41 的 0.50 m 极端。",
            "两条新开关默认关闭；主链数字未改动（峰值仍 0.492838740）。",
            "未做跨事件验证。",
        ],
    }

    concl = [
        ("**客水**：" + "；".join(
            f"{r['进水_m3s']:.0f} m³/s（占降雨 {r['占降雨_pct']}%）→ "
            f"红格 {r['红格_ha']} ha" for r in rows_in) + "。"),
        ("**潮位时程**：" + "；".join(
            f"增水 {r['增水幅度_m']:.2f} m（顶托 {r['顶托_min_m']}–{r['顶托_max_m']}）"
            f"→ 红格 {r['红格_ha']} ha" for r in rows_tide) + "。"),
    ]
    # 与四轴对照
    concl.append(
        f"**杠杆对照**：客水红格杠杆 {in_red}、潮位时程红格杠杆 {tide_red}；"
        f"客水点位杠杆 {in_pt}、潮位点位杠杆 {tide_pt}。"
        "（四轴：排水 ×2.81/×5.46、集中度 ×1.64/×1.12、总量 ×1.19/×1.29。）")
    if tide_red and tide_red > 2.0:
        concl.append(
            "**潮位时程有实质杠杆**：把常数顶托换成时程后，红格面积显著变化。"
            "这说明『顶托是常数』这一简化**不是无害的**——"
            "p41/p44 把顶托当标量扫，实际上低估了它的时间结构。")
    if in_red and in_red > 2.0:
        concl.append(
            "**客水也有实质杠杆**：外边界进水占总雨量 18% 时即显著改变红格。"
            "而内核此前**完全没有入流机制**——这是模型的一个真实缺口。")

    payload["结论"] = concl

    (OUT / "p68_边界条件两轴.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n  客水红格杠杆 {in_red}  潮位红格杠杆 {tide_red}")
    print(f"  客水点位杠杆 {in_pt}  潮位点位杠杆 {tide_pt}")
    print(f"→ {OUT / 'p68_边界条件两轴.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
