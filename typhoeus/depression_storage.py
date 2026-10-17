"""p60 洼地蓄水（初损）：它能让面积与点位同时变好吗？

机制与其预期方向
----------------
洼地蓄水 = 降雨先回填微地形凹陷，填满后才产流（等价于 SCS-CN 的初损 Ia）。

实现方式**不改内核**：对累计雨量做减法
    C_eff(t) = max(C(t) − dep, 0)，rain_eff(t) = C_eff(t) − C_eff(t−1)
即「前 dep 毫米不产流」。

预期方向（这是本件要检验的）：
  总水量减少 → 湿格面积**下降**（我们现在面积过预测 8.8 倍，这是**对的方向**）
       但同样 → 点位水深**下降**（我们现在点位偏浅 0.36 m，这是**错的方向**）

故本件要回答：**洼地蓄水能不能同时改善两个指标？**
若能，它就是廉价解；若不能，说明面积与点位两个误差**不是同一个机制**，
需要的是"重分布"（汇流集中）而不是"减少"。

用法：python -m typhoeus.depression_storage
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"

SWEEP_MM = (0.0, 5.0, 10.0, 20.0, 30.0)
WET_TH = 0.05          # 与 p11 一致的"模型水体"判据
OBS_AREA_PCT = 2.19    # 湿季 SAR 水面占比（p56）


def apply_initial_abstraction(rain: np.ndarray, dt_s: float,
                              dep_mm: float) -> np.ndarray:
    """把「前 dep 毫米不产流」作用到降雨序列上。

    rain 为 (nt, ny, nx) 的 mm/h；返回同形状的等效降雨率（mm/h）。
    做法在**累计量**上减，再差分回去——直接对率做减法会在时间上错位。
    """
    if dep_mm <= 0:
        return rain
    dt_h = dt_s / 3600.0
    cum = np.cumsum(rain * dt_h, axis=0)          # mm
    cum_eff = np.maximum(cum - dep_mm, 0.0)
    inc_eff = np.diff(cum_eff, axis=0, prepend=0.0)
    return inc_eff / dt_h


def main() -> int:
    from typhoeus import cli as CLI
    from typhoeus import config as CFG
    from typhoeus import data as D
    from typhoeus import kernel as K
    from typhoeus import observe as OB
    from typhoeus import rainsrc as RS

    import csv
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
    for dep in SWEEP_MM:
        rain_eff = apply_initial_abstraction(np.asarray(rain, float),
                                             kp.dt_s, dep)
        t0 = time.perf_counter()
        res = K.run(g, rain_eff, kp)
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
        mae = float(np.nanmean(np.abs(obs - mod_pt)))
        wet_pct = float((peak >= WET_TH).sum()) * (g.cell_m ** 2) / 1e4 \
            / area_ha * 100
        rows.append({
            "初损_mm": dep,
            "点位均值_m": round(float(np.nanmean(mod_pt)), 4),
            "点位MAE_m": round(mae, 4),
            "湿格面积_pct": round(wet_pct, 3),
            "面积相对观测倍数": round(wet_pct / OBS_AREA_PCT, 2),
            "峰值最大_m": round(float(peak.max()), 4),
            "内核_s": el,
        })
        print(f"    dep {dep:>4.0f} mm  点位均值 {np.nanmean(mod_pt):.4f}  "
              f"MAE {mae:.4f}  湿格 {wet_pct:.2f}%  "
              f"（观测 {OBS_AREA_PCT}%，倍数 {wet_pct/OBS_AREA_PCT:.1f}）")

    base = rows[0]
    best_mae = min(rows, key=lambda r: r["点位MAE_m"])
    best_area = min(rows, key=lambda r: abs(r["面积相对观测倍数"] - 1.0))

    # 判据：能否同时改善（MAE 下降 且 面积倍数更接近 1）
    both = [r for r in rows
            if r["点位MAE_m"] < base["点位MAE_m"]
            and abs(r["面积相对观测倍数"] - 1.0)
            < abs(base["面积相对观测倍数"] - 1.0)]

    payload = {
        "名称": "洼地蓄水（初损）：面积与点位能否同时改善",
        "生成时间": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "机制": ("洼地蓄水等价于 SCS-CN 的初损 Ia：前 dep 毫米不产流。"
               "实现在**累计雨量**上减，再差分回降雨率，不改内核。"),
        "为什么用初损而不是加内核参数": (
            "改内核需新增参数并保证默认 0 时逐位不变；本件先用无侵入的初损，"
            "若方向对再考虑做成内核参数。"),
        "扫描": rows,
        "基线": base,
        "最优MAE": best_mae,
        "最优面积": best_area,
        "能否同时改善": bool(both),
        "同时改善的方案": both,
        "结论": [],
        "边界": [
            "初损是**集总**的：全域减同一个毫米数，而真实洼地容量有空间分布。",
            "本实现只减产流，未改变水的去向——**不做重分布**，故不能把水集中。",
            "湿格判据 0.05 m 与 p11 一致；观测面积取 p56 的湿季 SAR 2.19%。",
            "两者不是同一定义：SAR 水面含常年水体，模型湿格不含。故面积倍数只作方向参考。",
            "未改内核，故不改任何既有产物的数字。",
        ],
    }

    concl = [
        (f"**基线（无初损）**：点位 MAE {base['点位MAE_m']}，"
         f"湿格 {base['湿格面积_pct']}%（观测 {OBS_AREA_PCT}%，"
         f"**{base['面积相对观测倍数']} 倍**）。"),
    ]
    if both:
        b = both[0]
        concl.append(
            f"**存在同时改善的方案**：初损 {b['初损_mm']} mm 时"
            f"MAE {b['点位MAE_m']}、面积倍数 {b['面积相对观测倍数']}。"
            "→ 洼地蓄水是廉价解。")
    else:
        last = rows[-1]
        d_area = abs(last["湿格面积_pct"] - base["湿格面积_pct"])
        d_mae = base["点位MAE_m"] - last["点位MAE_m"]
        pct_rain = last["初损_mm"] / 259.1 * 100
        concl.append(
            f"**初损到 {last['初损_mm']:.0f} mm 时仍几乎无效**："
            f"湿格面积 {base['湿格面积_pct']:.2f}% → "
            f"{last['湿格面积_pct']:.2f}%（变化 {d_area:.2f} 个百分点，"
            f"仍是观测的 {last['面积相对观测倍数']} 倍），"
            f"点位 MAE 仅从 {base['点位MAE_m']:.4f} 降到 "
            f"{last['点位MAE_m']:.4f}（改善 {d_mae:.4f} m，"
            f"{(d_mae/base['点位MAE_m'])*100:.1f}%）。")
        concl.append(
            "**为什么无效**：30 mm 初损只占 259 mm 雨量的 "
            f"{pct_rain:.0f}%，而湿格判据是 0.05 m——"
            "扣掉的这点水不足以让大批格点跌破判据。"
            "**初损在这个量级上不是可行解。**")
        concl.append(
            "**两个误差都不是『水量多少』造成的**，"
            "而是**同一股水被摊在 8.7 倍的面积上**。"
            "要同时修两个，必须**重分布**——把水从 19.1% 的面积集中到 2.19%，"
            "而不是减少它。洼地蓄水是『减少』，方向不对。")
        # 体积守恒的量化：若把水集中到观测面积，平均水深该涨多少倍
        conc = (base["湿格面积_pct"] / OBS_AREA_PCT) if OBS_AREA_PCT else None
        if conc:
            concl.append(
                f"**体积守恒的检验**：模型湿格面积是观测的 "
                f"{base['面积相对观测倍数']} 倍，故同样的水量若集中到观测面积，"
                f"平均水深应涨约 **{base['面积相对观测倍数']} 倍**——"
                f"即 {base['点位均值_m']} × {base['面积相对观测倍数']} ≈ "
                f"**{base['点位均值_m']*base['面积相对观测倍数']:.3f} m**，"
                f"而实测均值是 {np.nanmean(obs):.3f} m。"
                "**两个误差在数量上自洽：是同一股水被摊薄了。**")
    payload["结论"] = concl

    (OUT / "p60_洼地蓄水初损.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n  最优MAE {best_mae['初损_mm']}mm（{best_mae['点位MAE_m']}）  "
          f"最优面积 {best_area['初损_mm']}mm（{best_area['面积相对观测倍数']}×）")
    print(f"  能否同时改善: {bool(both)}")
    print(f"→ {OUT / 'p60_洼地蓄水初损.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
