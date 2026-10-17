"""p61 汇流集中：D8 路由能否同时消掉面积过预测与点位低估。

验收（全部来自既有实测，不新设口径）
------------------------------------
  面积：湿格占比应从 19.1% 降向 **2.19%**（p56 湿季 SAR）
  点位：17 点均值应从 0.0366 升向 **0.396**（观测均值）
  MAE ：应从 0.3593 降向 **0.0909**（p58 留出验证的加性校正水平）
  **可证伪预测**：若集中做对，p58 那个 0.36 m 加性偏移应**自然消失**
                 （残差均值 → 0）

用法：python -m typhoeus.concentration_fix
"""

from __future__ import annotations

import copy
import json
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"

RATES = (0.0, 0.01, 0.02, 0.05, 0.10, 0.20)
WET_TH = 0.05
TARGET_AREA = 2.19
TARGET_PT = 0.396
TARGET_MAE = 0.0909


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
    base_kp = CLI._kernel_params(cfg)
    area_ha = float(g.elev.size) * (g.cell_m ** 2) / 1e4

    rows = []
    for rate in RATES:
        kp = copy.copy(base_kp)
        kp.concentration_rate = float(rate)
        t0 = time.perf_counter()
        res = K.run(g, rain, kp)
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
        wet_pct = float((peak >= WET_TH).sum()) * (g.cell_m ** 2) / 1e4 \
            / area_ha * 100
        rows.append({
            "route_rate": rate,
            "峰值最大_m": round(float(peak.max()), 4),
            "湿格面积_pct": round(wet_pct, 3),
            "面积相对观测倍数": round(wet_pct / TARGET_AREA, 2),
            "点位均值_m": round(float(np.nanmean(mod_pt)), 4),
            "点位MAE_m": round(float(np.nanmean(np.abs(resi))), 4),
            "残差均值_m": round(float(np.nanmean(resi)), 4),
            "残差全为正": bool(np.all(resi > 0)),
            "守恒残差": float(f"{res.mass_resid:.2e}"),
            "内核_s": el,
        })
        print(f"    rate {rate:>5.2f}  峰值 {peak.max():.4f}  "
              f"湿格 {wet_pct:6.2f}%（{wet_pct/TARGET_AREA:4.2f}×）  "
              f"点位 {np.nanmean(mod_pt):.4f}  MAE {np.nanmean(np.abs(resi)):.4f}  "
              f"残差均值 {np.nanmean(resi):+.4f}")

    base = rows[0]
    # 目标：同时接近三个目标值
    def dist(r):
        return (abs(r["湿格面积_pct"] - TARGET_AREA) / TARGET_AREA
                + abs(r["点位MAE_m"] - TARGET_MAE) / TARGET_MAE)
    best = min(rows[1:], key=dist)
    improved_both = [r for r in rows
                     if r["点位MAE_m"] < base["点位MAE_m"]
                     and r["湿格面积_pct"] < base["湿格面积_pct"]]
    offset_gone = [r for r in rows if abs(r["残差均值_m"]) < 0.05]

    payload = {
        "名称": "汇流集中（D8 路由）：能否同时消掉两个误差",
        "生成时间": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "机制": (
            "每步把 rate×水深 沿 D8 最陡下降方向移到下游格。"
            "无下游格（局部洼地/边界）不参与，水留在原地——即填洼成塘。"
            "这是水文学标准做法，不引入动量方程，故模型仍不是水动力模型。"),
        "守恒说明": (
            "每个供体格失去的量恰好加到唯一一个受体格，故总量不变；"
            "np.add.at 处理重复索引，避免把多个供体的水只记一次。"),
        "为什么不改 Manning 通量": (
            "Manning 通量 ∝ h^(5/3)，浅水时几乎不动，是摊薄的直接原因；"
            "但改它等于改既有标定（n 已标定），会连带全部历史结论。"
            "D8 路由是**新增一路**，默认 0 时逐位不变，风险可控。"),
        "扫描": rows,
        "基线": base,
        "同时改善": bool(improved_both),
        "最优": best,
        "验收目标": {"湿格面积_pct": TARGET_AREA, "点位均值_m": TARGET_PT,
                 "点位MAE_m": TARGET_MAE,
                 "说明": "三者均来自既有实测（p56/p25/p58），非新设口径"},
        "可证伪预测": {
            "预测": "若集中做对，p58 的 0.36 m 加性偏移应自然消失（残差均值 → 0）",
            "实测消失的方案": [r["route_rate"] for r in offset_gone],
            "是否消失": bool(offset_gone),
        },
        "结论": [],
        "边界": [
            "D8 路由是**运动学**，不模拟流速与回水；对下穿隧道这类封闭地形，"
            "真实汇流是管网+路面双通道，本件只有路面。",
            "rate 是**无量纲步进比例**，无实测可标定；本件只报其对输出的影响，"
            "不主张某个 rate 是真值。",
            "目标值 2.19% 来自 SAR 水面（含常年水体），模型湿格不含，"
            "两者定义不同，故面积只作方向依据。",
            "8.72 倍的面积差与 10.8 倍的点位差来自**同一次**对比，"
            "故『同一股水摊薄』的算术自洽不等于物理因果已被证明。",
            "未做跨事件验证：本件只调一场雨（烟花）。",
        ],
    }

    concl = [
        (f"**基线**：湿格 {base['湿格面积_pct']}%（{base['面积相对观测倍数']}×）、"
         f"点位均值 {base['点位均值_m']}、MAE {base['点位MAE_m']}、"
         f"残差均值 {base['残差均值_m']:+}。"),
        ("**扫描趋势**："
         + "；".join(f"rate {r['route_rate']:.2f}→面积{r['湿格面积_pct']:.1f}%/MAE{r['点位MAE_m']:.3f}"
                    for r in rows)),
    ]
    if improved_both:
        b = min(improved_both, key=dist)
        concl.append(
            f"**存在同时改善两者的方案**：rate={b['route_rate']} 时"
            f"面积 {b['湿格面积_pct']}%、MAE {b['点位MAE_m']}、"
            f"残差均值 {b['残差均值_m']:+}。"
            "→ **汇流集中确实同时修两个误差**。")
    else:
        concl.append(
            "**不存在同时改善两者的方案。** 需检查 D8 是否被 DSM 压平建筑"
            "造成的假洼地困住，或 rate 量级不当。")
    if offset_gone:
        concl.append(
            f"**可证伪预测成立**：rate ∈ {[r['route_rate'] for r in offset_gone]} 时"
            "残差均值已降到 ±0.05 m 内，即 p58 那个 0.36 m 偏移**自然消失**。"
            "→ 偏移确由『水没被集中』这一物理缺陷所致。")
    else:
        concl.append(
            "**可证伪预测未成立**：残差均值仍未降到 ±0.05 m 内。"
            "→ 说明除汇流集中外还有第二个机制未找到。")
    payload["结论"] = concl

    (OUT / "p61_汇流集中.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n  最优 rate={best['route_rate']}  面积 {best['湿格面积_pct']}%  "
          f"MAE {best['点位MAE_m']}  残差均值 {best['残差均值_m']:+}")
    print(f"  同时改善: {bool(improved_both)}  偏移消失: {bool(offset_gone)}")
    print(f"→ {OUT / 'p61_汇流集中.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
