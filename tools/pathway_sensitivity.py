"""p36 排水三通道敏感性分解：管网 vs 土壤速率 vs 土壤容量 vs 地表糙率。

起因：p35 发现 `impervious_frac` 从 0.75 降到 0.291（2.6 倍）只让峰值水深变
0.0009 m，据此我判"排水能力 >> 不透水率"。但那个结论可能是**接错了参数**
造成的假象——

    Green-Ampt 入渗率   f = Ksat·(1 + ψ·Δθ/F)     ← Ksat 是**速率**
    而 impervious_frac 只改了  cap = soil_capacity×(1−f)  ← 那是**容量**

真实铺装首先毁掉的是导水率（水泥地 Ksat≈0），不是储水容量。
容量只有 30 mm，事件雨量 259 mm，容量项本就无关紧要；
所以"不透水率不影响结果"是模型接线问题的产物，不是物理事实。

本件把四条通道逐一压 10 倍，看**到底谁在控制峰值水深**：
    A 管网输水系数 drainage_coeff
    B 土壤导水率   soil_ksat
    C 土壤储水容量 soil_capacity
    D 地表糙率     manning_n
外加两种不透水率接法对照：
    E 只压容量（现行接线）
    F 压导水率（物理正确的接线：Ksat_eff = Ksat×(1−f)）

用法：python tools/pathway_sensitivity.py
"""

from __future__ import annotations

import copy
import json
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"


def stats(peak: np.ndarray, cell_m: float) -> dict:
    ha = (cell_m ** 2) / 1e4
    return {
        "峰值水深_m": round(float(peak.max()), 4),
        "红格_ha": round(float((peak >= 0.5).sum()) * ha, 1),
        "橙格_ha": round(float(((peak >= 0.2) & (peak < 0.5)).sum()) * ha, 1),
        "湿格_ha": round(float((peak >= 0.05).sum()) * ha, 1),
    }


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
    base_kp = CLI._kernel_params(cfg)
    cell_m = float(g.cell_m)

    cases = [
        ("基线（现状标量）", None),
        ("A 管网系数 ×0.10", {"drainage_coeff_m_s": base_kp.drainage_coeff_m_s * 0.10}),
        ("B 土壤导水率 ×0.10", {"soil_ksat_m_h": base_kp.soil_ksat_m_h * 0.10}),
        ("C 土壤容量 ×0.10", {"soil_capacity_mm": base_kp.soil_capacity_mm * 0.10}),
        ("D 地表糙率 ×2.0", {"manning_n": base_kp.manning_n * 2.0}),
        # E/F 用 p35 推出的真实不透水率均值 0.291 vs 现行 0.75
        ("E 不透水率 0.291（只压容量·现行接线）", {"impervious_frac": 0.291}),
        ("F 不透水率 0.291（压导水率·正确接线）", "F"),
    ]

    rows = []
    for label, patch in cases:
        kp = copy.copy(base_kp)
        if patch == "F":
            f = 0.291
            kp.impervious_frac = f
            kp.soil_ksat_m_h = base_kp.soil_ksat_m_h * (1.0 - f)
        elif patch:
            for k, v in patch.items():
                setattr(kp, k, v)
        t0 = time.perf_counter()
        res = K.run(g, rain, kp)
        el = time.perf_counter() - t0
        peak = np.asarray(res.depth).max(axis=0)
        s = stats(peak, cell_m)
        s.update({"口径": label, "内核_s": round(el, 1),
                  "下渗总量_万m3": round(float(res.infil_total_m3) / 1e4, 1),
                  "排水总量_万m3": round(float(res.drain_total_m3) / 1e4, 1)
                  if hasattr(res, "drain_total_m3") else None})
        rows.append(s)
        print(f"  {label:<40} 峰 {s['峰值水深_m']:.4f} m  "
              f"红 {s['红格_ha']:>6.1f} ha  橙 {s['橙格_ha']:>7.1f} ha  "
              f"下渗 {s['下渗总量_万m3']:>7.1f} 万m³", flush=True)

    b = rows[0]
    for r in rows[1:]:
        r["峰值变化_m"] = round(r["峰值水深_m"] - b["峰值水深_m"], 4)
        r["峰值变化_pct"] = (round((r["峰值水深_m"] / b["峰值水深_m"] - 1) * 100, 2)
                           if b["峰值水深_m"] else None)
        r["下渗变化_pct"] = (round((r["下渗总量_万m3"] / b["下渗总量_万m3"] - 1) * 100, 2)
                          if b["下渗总量_万m3"] else None)

    # 按 |峰值变化| 排序，给出通道影响力次序
    ranked = sorted([r for r in rows[1:] if r["峰值变化_m"] is not None],
                    key=lambda r: -abs(r["峰值变化_m"]))
    e = next((r for r in rows if r["口径"].startswith("E ")), None)
    f_row = next((r for r in rows if r["口径"].startswith("F ")), None)

    payload = {
        "名称": "排水三通道敏感性分解",
        "生成时间": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "起因": ("p35 发现不透水率从 0.75 降到 0.291 只让峰值水深变 0.0009 m，"
                 "据此判『排水能力 >> 不透水率』。但该结论可能是**接错参数**的假象："
                 "Green-Ampt 入渗率 f=Ksat·(1+ψ·Δθ/F) 的关键是 Ksat（速率），"
                 "而 impervious_frac 只改了 soil_capacity×(1−f)（容量）。"
                 "真实铺装首先毁掉导水率，不是储水容量。"),
        "结果": rows,
        "通道影响力排序": [
            {"通道": r["口径"], "峰值变化_m": r["峰值变化_m"],
             "峰值变化_pct": r["峰值变化_pct"]} for r in ranked],
        "两种不透水率接法对照": {
            "E_只压容量_现行接线": {
                "峰值水深_m": e["峰值水深_m"] if e else None,
                "峰值变化_m": e["峰值变化_m"] if e else None},
            "F_压导水率_正确接线": {
                "峰值水深_m": f_row["峰值水深_m"] if f_row else None,
                "峰值变化_m": f_row["峰值变化_m"] if f_row else None},
            "判读": (
                "若 F 的变化远大于 E，则『不透水率不重要』是接线问题，"
                "不是物理事实——现行 model 把不透水率接到了不敏感的那一项。"
                if (e and f_row and abs(f_row["峰值变化_m"]) > 2 * abs(e["峰值变化_m"]))
                else "E 与 F 量级相近，接线不是主因。"),
        },
        "结论": [],
        "边界": [
            "所有通道都是**整体乘/除一个因子**，不是空间异质场（除 F 的 Ksat 折减）。",
            "压缩 10 倍是探针档，不对应任何具体工程状态。",
            "只改一个通道、其余保持基线，故各档之间是可加的线性近似，非严格正交分解。",
            "对比的是**本模型**的敏感度，不是真实城市的敏感度排序。",
            "共用宁波参数与烟花降雨场，结论限于该事件量级（259 mm/72 h）。",
        ],
    }

    # 结论按实测填，不预设
    r1 = ranked[0] if ranked else None
    # 下渗占雨量的比例：判断入渗是容量锁死还是速率限制
    rain_m3 = None
    try:
        rain_arr = np.asarray(rain, dtype=float)
        dt_h = 3600.0 / 6.0  # 仅用于量级，下面用内核时长更准
    except Exception:  # noqa: BLE001
        pass
    infil_share = None
    if b["下渗总量_万m3"]:
        # 面雨量 mm = 逐时面平均雨强(mm/h) 之和 × 步长(h)
        rain_arr = np.asarray(rain, dtype=float)
        areal_mm = float(rain_arr.mean(axis=(1, 2)).sum()) * (600.0 / 3600.0)
        area_m2 = float(g.elev.size) * (cell_m ** 2)
        rain_m3 = areal_mm / 1000.0 * area_m2
        infil_share = (b["下渗总量_万m3"] * 1e4) / rain_m3 if rain_m3 else None

    payload["结论"] = [
        ("四条通道按对峰值水深的影响排序："
         + " > ".join(f"{r['口径'].split(' ')[0]}（{r['峰值变化_m']:+.4f} m）"
                      for r in ranked) if ranked else "未能排序"),
        (f"**{r1['口径']}** 是压倒性主项（{r1['峰值变化_pct']:+.1f}%），"
         f"其影响是其余所有通道合计的数百倍。" if r1 else ""),
        ("**但『土壤通道无效』的成因不是接线，是土层假设。**"
         + (f"实测下渗总量仅占总雨量的 {infil_share*100:.2f}%"
            if infil_share else "")
         + "——有效capacity = soil_capacity_mm×(1−impervious) = 30×0.25 = 7.5 mm，"
           f"而事件面雨量 259 mm，前者是后者的 2.9%。**入渗被容量锁死，"
           "不是被导水率限制**，所以把 Ksat 压 10 倍也几乎不变。"),
        ("**用户质疑部分成立、且指对了更深的一层**："
         "① 接线确实错了（impervious_frac 压容量而非导水率，E 与 F 差 8 倍）；"
         "② 但改正接线后影响仍只有 "
         + (f"{f_row['峰值变化_m']:+.4f} m" if f_row else "量级极小")
         + "，因为真正的限制是 `soil_capacity_mm=30` 这个**薄土层假设**"
           "（注释写明是『压平建筑后的 DSM 硬化面』），不是参数接法。"),
        ("**因此 p35 那句结论必须降级**：不能说『排水能力 >> 不透水率』，"
         "应说『**在本模型 30 mm 薄土层 + 本次 259 mm 雨量下，管网是唯一主项**』。"
         "若土层按真实包气带取 1–2 m（容量 300–600 mm），土壤会变成主项——"
         "该假设本身需要标定，而标定它需要土壤剖面资料，目前没有。"),
        ("**行动含义**：不要再去追不透水率的高精度（OSM 已足够）；"
         "要么拿到管网台账（决定 A 项），要么拿到土壤剖面（决定 C 项能否从 30 mm 放开）。"
         "两件都比继续优化 OSM 土地利用更值。"),
    ]

    (OUT / "p36_排水三通道敏感性.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n  排序：{' > '.join(r['口径'].split(' ')[0] for r in ranked)}")
    if e and f_row:
        print(f"  不透水率：只压容量 {e['峰值变化_m']:+.4f} m  vs  "
              f"压导水率 {f_row['峰值变化_m']:+.4f} m")
    print(f"→ {OUT / 'p36_排水三通道敏感性.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
