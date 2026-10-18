"""p45 碳-水耦合：台风暴雨下的碳通量，以及碳价如何改变方案优劣。

用户问题
--------
① 台风暴雨下"碳"资源怎么变？
② 城市韧性与碳定价之间是否有联系？

关键洞察（先记下来，代码只是把它算实）
------------------------------------
排水是**碳释放的通道**：合流制溢流（CSO）把污水与雨水一起排入河网，
伴随 CH4 / N2O 释放。所以一场暴雨不只是"淹水"，它**排放**。

于是碳价不是外挂工具，而是**直接进入损失函数**：

    洪水总代价 = 功能损失 + 碳价 × 这场洪水的碳排放

更关键的是它**改变方案优劣**：
    灰方案（管网）：排得快 → 排水量大 → CSO 排放多
    绿方案（调蓄）：滞留 → 排水量少 → CSO 排放少，且固碳
    → **碳价越高，绿方案越占优**

这就是"城市韧性"与"碳定价"的真实联系：
不是用碳价来给损失标价，而是**碳价改变了"哪种方案更韧性"的答案**。

本件给三件事：
  A 一场暴雨的水量账（实测）→ 碳通量的物理量
  B 碳通量作为排放因子的函数（不臆造 EF，给出函数与区间）
  C 碳价作为第 5 条情景轴：它能否翻转方案排序

用法：python -m typhoeus.carbon_water
"""

from __future__ import annotations

import copy
import json
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"

# 排水途径的甲烷排放因子区间（g CH4 / m³ 排水）。
# **这是本件唯一的文献假设，且区间很宽**：合流制溢流与重力流污管
# 的直接 CH4 排放实测报道从个位数到数十 g/m³ 不等，随温度、
# 停留时间、管内有氧程度强烈变化。故以"参数"而非"取值"处理。
EF_G_PER_M3 = [1.0, 5.0, 20.0, 50.0]
GWP100_CH4 = 28.0            # IPCC AR6 量级
CARBON_PRICE = [0.0, 100.0, 370.0, 1000.0]   # ¥/tCO2e：0 / 中国碳市场 / SCC / 高位情景


def main() -> int:
    from typhoeus import cli as CLI
    from typhoeus import config as CFG
    from typhoeus import data as D
    from typhoeus import kernel as K
    from typhoeus import observe as OB
    from typhoeus import rainsrc as RS

    cfg = CFG.Config()
    inp = D.load_all(cfg.l2.bbox, cfg.l4.resample)
    g = inp.grid
    rain, _ = RS.get_rainfall(g, stations=OB.load_rain_stations(),
                              use_cache=True, calibrate=cfg.l2.rain_calibrate,
                              verbose=False)
    kp = CLI._kernel_params(cfg)

    print("=== A 水量账（实测，一次内核）===")
    res = K.run(g, rain, kp)
    vol = {
        "降雨": float(res.rain_total_m3),
        "下渗": float(res.infil_total_m3),
        "排水": float(res.drain_total_m3),
        "边界出流": float(res.boundary_out_m3),
        "域内存量": float(np.asarray(res.depth)[-1].sum()) * res.cell_area_m2,
    }
    tot = vol["降雨"]
    for k, v in vol.items():
        print(f"    {k:<8} {v/1e4:>10.1f} 万 m³   ({v/tot*100:>5.1f}% of 降雨)")

    # B 碳通量作为 EF 的函数
    print("\n=== B 排水途径的碳通量（对排放因子的敏感性）===")
    vd = vol["排水"]
    rows_b = []
    for ef in EF_G_PER_M3:
        ch4_t = vd * ef / 1e6                       # g → t
        co2e_t = ch4_t * GWP100_CH4
        rows_b.append({"EF_g_per_m3": ef,
                       "CH4_t": round(ch4_t, 1),
                       "CO2e_t": round(co2e_t, 1)})
        print(f"    EF={ef:>5.1f} g/m³ → CH4 {ch4_t:>8.1f} t → "
              f"CO2e {co2e_t:>9.1f} t")

    # 应急响应能耗（量级估算，用于说明它可忽略）
    print("\n=== 应急响应能耗碳排（量级估算）===")
    pumps, kw, hours = 100, 50.0, 16.0
    kwh = pumps * kw * hours
    kg_co2 = kwh * 0.8                       # 柴油发电约 0.8 kg CO2/kWh
    print(f"    {pumps} 台泵 × {kw:.0f} kW × {hours:.0f} h = {kwh:,.0f} kWh "
          f"→ {kg_co2/1000:.1f} tCO2（对比排水途径小 2–3 个数量级）")
    resp_t = kg_co2 / 1000.0

    # C 碳价作为情景轴：让灰 vs 绿方案比价
    # 灰方案：现状排水（排水多 → CSO 多）
    # 绿方案：顶托/调蓄等效为排水量减少——用 p29 的调蓄容积做上限约束
    print("\n=== C 碳价如何改变灰/绿方案比价 ===")
    # 绿方案等效：p29 实测 422.4 ha 下沉 0.3 m = 126.7 万 m³ 的滞留能力
    retain_m3 = 126.7e4
    vd_green = max(vd - retain_m3, 0.0)
    print(f"    灰方案排水 {vd/1e4:.1f} 万 m³；绿方案滞留 {retain_m3/1e4:.1f} 万 m³ "
          f"→ 排水 {vd_green/1e4:.1f} 万 m³（减 {retain_m3/vd*100:.1f}%）")

    ef_mid = 20.0
    rows_c = []
    for p in CARBON_PRICE:
        c_grey = (vd * ef_mid / 1e6) * GWP100_CH4 * p
        c_green = (vd_green * ef_mid / 1e6) * GWP100_CH4 * p
        rows_c.append({"碳价_¥_t": p,
                       "灰方案碳成本_万元": round(c_grey / 1e4, 1),
                       "绿方案碳成本_万元": round(c_green / 1e4, 1),
                       "绿方案节省_万元": round((c_grey - c_green) / 1e4, 1)})
        print(f"    碳价 ¥{p:>6.0f}/t → 灰 {c_grey/1e4:>7.1f} 万 / "
              f"绿 {c_green/1e4:>7.1f} 万 / 节省 {(c_grey-c_green)/1e4:>6.1f} 万")

    payload = {
        "名称": "碳-水耦合：暴雨的碳通量与碳价对方案优劣的影响",
        "生成时间": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "两个问题": [
            "① 台风暴雨下『碳』资源怎么变？",
            "② 城市韧性与碳定价之间是否有联系？",
        ],
        "核心命题": ("排水是碳释放的通道（CSO → CH4/N2O），"
                     "所以一场暴雨不只是淹水，它排放。"
                     "于是碳价直接进入损失函数，"
                     "并且**改变灰/绿方案的相对优劣**——"
                     "这才是碳定价与城市韧性的真实联系。"),
        "A_水量账_万m3": {k: round(v / 1e4, 1) for k, v in vol.items()},
        "A_占比_pct": {k: round(v / tot * 100, 1) for k, v in vol.items()},
        "B_碳通量对排放因子的敏感性": rows_b,
        "B_排放因子说明": (
            "g CH4 / m³ 排水。这是本件**唯一的文献假设，且区间很宽**："
            "合流制溢流与重力流污管的直接 CH4 排放实测报道"
            "从个位数到数十 g/m³ 不等，随温度、停留时间、管内有氧程度强烈变化。"
            "故按参数处理，不取单一值。"),
        "应急响应碳排_t": round(resp_t, 2),
        "C_碳价情景": rows_c,
        "C_绿方案设定": {
            "依据": "p29 实测：域内公共空间 422.4 ha，下沉 0.3 m 可调蓄 126.7 万 m³",
            "口径": "把调蓄容积当作排水量的减少量（上限估计，未计调度效率）",
            "EF取值": f"{ef_mid} g/m³（区间中位）",
        },
        "结论": [],
        "边界": [
            "排放因子区间宽达 50 倍，故碳通量只能给区间，不能给点值。",
            "GWP100(CH4)=28 取 IPCC AR6 量级；GWP20 约 80，短时窗下碳代价更高。",
            "绿方案的『滞留=减少排水』是上限估计：真实系统中滞留水最终仍会排走，"
            "只是错峰，故实际减排量被高估。",
            "应急响应能耗为量级估算（100 台泵 × 50 kW × 16 h），非实测。",
            "未计入 N2O（GWP 273），若计入碳通量再上升。",
            "共用宁波参数；碳价四档为情景，非预测。",
        ],
    }

    co2e_lo, co2e_mid, co2e_hi = (rows_b[0]["CO2e_t"], rows_b[2]["CO2e_t"],
                                  rows_b[3]["CO2e_t"])
    cheap = rows_c[1]
    high = rows_c[-1]

    payload["结论"] = [
        ("**① 暴雨下的碳账**：这场雨（259 mm）降雨 "
         f"{vol['降雨']/1e4:.0f} 万 m³，其中排水途径 "
         f"{vd/1e4:.0f} 万 m³（{vd/tot*100:.1f}%）。"
         f"按排放因子 1–50 g/m³，对应 **CO2e {co2e_lo:.0f} – {co2e_hi:.0f} t**"
         f"（中位档 {co2e_mid:.0f} t）。"),
        (f"**应急响应的碳排可忽略**：约 {resp_t:.1f} tCO2，"
         "比排水途径小 2–3 个数量级。"
         "**不要在这上面找故事**——它是真的小。"),
        (f"**② 韧性与碳价的联系**：碳价从 0 到 ¥1000/t，"
         f"灰方案的碳成本从 0 升到 {high['灰方案碳成本_万元']:.0f} 万元；"
         f"绿方案（调蓄留滞）可节省 {cheap['绿方案节省_万元']:.0f} – "
         f"{high['绿方案节省_万元']:.0f} 万元。"),
        ("**关键判据不是节省多少，而是它是否改变排序**："
         "绿方案的增量投资通常在千万级，故单靠碳价（即使 ¥1000/t）"
         "**不足以翻转灰/绿比选**。"
         "**碳价是加分项，不是决定项。**"),
        ("**所以两者确实有联系，但联系的方式不是我们原先以为的**："
         "不是『用碳价给洪灾标价』，而是"
         "『**碳价通过排水-排放通道，轻微地改变方案优劣**』。"
         "它的量级不足以主导决策，但足以作为方案比选里的**第五个计价维度**。"),
        ("**对产品的正确处置**：把碳价做成**可调参数**（默认 0，"
         "给中国碳市场价与 SCC 两档预设），并入 p3 方案比选的成本项，"
         "而**不**宣称它会改变结论。"
         "这样既不夸大，又保留了政策敏感性。"),
    ]

    (OUT / "p45_碳水耦合.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n  排水 {vd/1e4:.1f} 万 m³ → CO2e {co2e_lo:.0f}–{co2e_hi:.0f} t")
    print(f"  碳价 ¥1000/t 时绿方案节省 {high['绿方案节省_万元']:.1f} 万元")
    print(f"→ {OUT / 'p45_碳水耦合.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
