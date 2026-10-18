"""用正确量级（~167 mm）重测初损：那个 0.36 m 偏移会不会消失？

p60 只扫到 30 mm，而 priority-flood 实算 DSM 洼地容量是 **167.4 mm**
（占 259.1 mm 降雨的 64.6%）。小了一个半数量级，故当时的"无效"结论
只对 0-30 mm 成立，不能外推。
"""

import csv
import json
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
SWEEP = (0.0, 50.0, 100.0, 130.0, 167.0, 200.0, 240.0)
WET_TH = 0.05
TARGET_AREA = 2.19


def apply_ia(rain, dt_s, dep_mm):
    if dep_mm <= 0:
        return rain
    dt_h = dt_s / 3600.0
    cum = np.cumsum(rain * dt_h, axis=0)
    eff = np.maximum(cum - dep_mm, 0.0)
    inc = np.diff(eff, axis=0, prepend=0.0)
    return inc / dt_h


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
        meta = {r["point_id"]: r for r in csv.DictReader(f)}

    cfg = CFG.Config()
    inp = D.load_all(cfg.l2.bbox, cfg.l4.resample)
    g = inp.grid
    lon, lat = np.asarray(g.lon), np.asarray(g.lat)
    rain, _ = RS.get_rainfall(g, stations=OB.load_rain_stations(),
                              use_cache=True, calibrate=cfg.l2.rain_calibrate,
                              verbose=False)
    kp = CLI._kernel_params(cfg)
    area_ha = float(g.elev.size) * (g.cell_m ** 2) / 1e4

    rows = []
    for dep in SWEEP:
        t0 = time.perf_counter()
        res = K.run(g, apply_ia(np.asarray(rain, float), kp.dt_s, dep), kp)
        el = round(time.perf_counter() - t0, 1)
        peak = np.asarray(res.depth).max(axis=0)
        mod_pt = []
        for p in pts:
            m = meta.get(p["编号"])
            if not m:
                mod_pt.append(np.nan)
                continue
            x, y = float(m["lon"]), float(m["lat"])
            i = int(np.abs(lat - y).argmin())
            j = int(np.abs(lon - x).argmin())
            mod_pt.append(float(peak[i, j]))
        mod_pt = np.array(mod_pt, float)
        resi = obs - mod_pt
        wet = float((peak >= WET_TH).sum()) * (g.cell_m ** 2) / 1e4 / area_ha * 100
        rows.append({
            "初损_mm": dep, "峰值最大_m": round(float(peak.max()), 4),
            "湿格面积_pct": round(wet, 3),
            "面积相对观测倍数": round(wet / TARGET_AREA, 2),
            "点位均值_m": round(float(np.nanmean(mod_pt)), 4),
            "点位MAE_m": round(float(np.nanmean(np.abs(resi))), 4),
            "残差均值_m": round(float(np.nanmean(resi)), 4),
            "下渗_万m3": round(float(res.infil_total_m3) / 1e4, 1),
            "排水_万m3": round(float(res.drain_total_m3) / 1e4, 1),
            "守恒残差": float(f"{res.mass_resid:.2e}"),
        })
        print(f"    dep {dep:>5.0f} mm  湿格 {wet:6.2f}%（{wet/TARGET_AREA:4.2f}×）"
              f"  点位 {np.nanmean(mod_pt):.4f}  MAE {np.nanmean(np.abs(resi)):.4f}"
              f"  残差均值 {np.nanmean(resi):+.4f}")

    base = rows[0]
    best_mae = min(rows, key=lambda r: r["点位MAE_m"])
    best_area = min(rows, key=lambda r: abs(r["面积相对观测倍数"] - 1.0))
    offset_gone = [r for r in rows if abs(r["残差均值_m"]) < 0.05]
    both = [r for r in rows
            if r["点位MAE_m"] < base["点位MAE_m"]
            and abs(r["面积相对观测倍数"] - 1.0)
            < abs(base["面积相对观测倍数"] - 1.0)]

    payload = {
        "名称": "按 DSM 实算洼地容量（167 mm）重测初损",
        "生成时间": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "为什么重测": (
            "p60 只扫到 30 mm，而 priority-flood 实算 DSM 洼地容量是 "
            "**167.4 mm**（占 259.1 mm 降雨的 **64.6%**），"
            "小了一个半数量级。故 p60 的『初损无效』只对 0-30 mm 成立，不可外推。"),
        "洼地容量来源": {
            "方法": "priority-flood 填洼，容量 = mean(z_filled − z)",
            "容量_mm": 167.4,
            "占降雨_pct": 64.6,
            "有洼地格占比_pct": 22.1,
            "这些格的平均洼深_mm": 757.8,
            "说明": "22.1% 的格是洼地，其平均深度 758 mm；折算全域 167.4 mm",
        },
        "扫描": rows,
        "基线": base,
        "最优MAE": best_mae,
        "最优面积": best_area,
        "同时改善": bool(both),
        "可证伪预测": {
            "预测": "若偏移由洼地蓄水造成，大初损时残差均值应趋 0",
            "残差均值 <0.05 的方案": [r["初损_mm"] for r in offset_gone],
            "是否消失": bool(offset_gone),
        },
        "结论": [],
        "边界": [
            "初损是**集总**的（全域减同一毫米数），真实洼地容量有空间分布。",
            "priority-flood 的容量包含**建筑压平造成的假洼地**，可能高估真实蓄水。",
            "初损只减水量、不改去向，**在结构上不能实现重分布**。",
            "湿格判据 0.05 m；SAR 目标 2.19% 含常年水体，定义不同。",
            "未做跨事件验证。",
        ],
    }

    concl = [
        (f"**基线**：湿格 {base['湿格面积_pct']}%（{base['面积相对观测倍数']}×）、"
         f"点位均值 {base['点位均值_m']}、MAE {base['点位MAE_m']}、"
         f"残差均值 {base['残差均值_m']:+}。"),
        (f"**最优面积在初损 {best_area['初损_mm']:.0f} mm"
         f"（{best_area['面积相对观测倍数']}×）**，"
         f"最优 MAE 在初损 {best_mae['初损_mm']:.0f} mm"
         f"（{best_mae['点位MAE_m']}）。"),
    ]
    if both:
        concl.append(
            "**存在同时改善两者的方案**："
            + "；".join(f"{r['初损_mm']:.0f}mm→面积{r['湿格面积_pct']:.2f}%/MAE{r['点位MAE_m']:.3f}"
                       for r in both)
            + "。")
    else:
        concl.append(
            "**仍不存在同时改善两者的方案**：初损能压面积，但让点位更浅。")
    if offset_gone:
        concl.append(
            "**可证伪预测成立**：大初损时残差均值已降到 ±0.05 m 内。"
            "→ 那个 0.36 m 偏移主要由**洼地蓄水缺失**造成，"
            "不是『汇流缺失』。")
    else:
        concl.append(
            "**可证伪预测未成立**：即使用 167 mm 的正确量级，残差均值仍未降到 ±0.05 m。"
            "→ 偏移不能单由洼地蓄水解释。")
    payload["结论"] = concl

    (OUT / "p62_洼地容量重测.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n  最优面积 {best_area['初损_mm']:.0f}mm"
          f"（{best_area['面积相对观测倍数']}×）"
          f"  最优MAE {best_mae['初损_mm']:.0f}mm（{best_mae['点位MAE_m']}）")
    print(f"  同时改善 {bool(both)}  偏移消失 {bool(offset_gone)}")
    print(f"→ {OUT / 'p62_洼地容量重测.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
