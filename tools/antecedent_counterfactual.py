"""p41 前期条件反事实：同一场雨，季节不同后果差多少？

问题
----
反季节极端事件（冬季/早春的暴雨）在历史目录里**零样本**——
18 场台风全在 6–10 月。所以我们无法用历史验证，只能做**反事实推理**：

    给定这一场雨，若前期条件是冬季的（偏干）vs 台风季的（偏湿），后果差多少？

现状缺陷（已查证）
------------------
`soil_theta0 = 0.45`（初始含水率，占有效饱和容量）是**全域常数**，
代码注释写明「台风季前期有前期降雨」——
**这是把季节假设焊死成一个数**，反季节事件会被用错的前期状态模拟。

两条前期条件轴
--------------
  A 土壤前期含水率 soil_theta0：季节干湿的直接代理
  B 管网顶托高程 drainage_invert_m：河网/潮位水位的直接代理
    （p30 已定性：涝点高出河网中位 5.63 m，仅 5/17 点可能受顶托；
     反季节枯水期顶托更低、台风期高潮位顶托更高）

用法：python tools/antecedent_counterfactual.py
"""

from __future__ import annotations

import copy
import json
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"

THETA0 = [0.05, 0.20, 0.45, 0.70, 0.95]
INVERT = [0.01, 0.05, 0.20, 0.50]


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
    base = CLI._kernel_params(cfg)
    cell_m = float(g.cell_m)
    ha = (cell_m ** 2) / 1e4
    rain_arr = np.asarray(rain, dtype=float)
    areal_mm = float(rain_arr.mean(axis=(1, 2)).sum()) * (600.0 / 3600.0)

    def run(theta0: float, invert: float) -> dict:
        kp = copy.copy(base)
        kp.soil_theta0 = theta0
        kp.drainage_invert_m = invert
        t0 = time.perf_counter()
        res = K.run(g, rain, kp)
        el = time.perf_counter() - t0
        peak = np.asarray(res.depth).max(axis=0)
        return {
            "θ0": theta0, "顶托_m": invert,
            "峰值水深_m": round(float(peak.max()), 4),
            "湿格_ha": round(float((peak >= 0.05).sum()) * ha, 1),
            "橙格_ha": round(float(((peak >= 0.2) & (peak < 0.5)).sum()) * ha, 1),
            "红格_ha": round(float((peak >= 0.5).sum()) * ha, 1),
            "下渗_万m3": round(float(res.infil_total_m3) / 1e4, 1),
            "守恒残差": float(res.mass_resid),
            "内核_s": round(el, 1),
        }

    print(f"  降雨：面雨量 {areal_mm:.1f} mm（同一场雨，全程不变）")
    print(f"\n=== A 土壤前期含水率 θ0（顶托固定 {base.drainage_invert_m} m）===")
    rows_a = []
    for th in THETA0:
        r = run(th, base.drainage_invert_m)
        rows_a.append(r)
        print(f"    θ0={th:<5} 峰 {r['峰值水深_m']:.4f} m  "
              f"湿 {r['湿格_ha']:>7.1f} ha  橙 {r['橙格_ha']:>6.1f}  "
              f"下渗 {r['下渗_万m3']:>7.1f} 万m³", flush=True)

    print(f"\n=== B 管网顶托高程（θ0 固定 {base.soil_theta0}）===")
    rows_b = []
    for iv in INVERT:
        r = run(base.soil_theta0, iv)
        rows_b.append(r)
        print(f"    顶托={iv:<5} 峰 {r['峰值水深_m']:.4f} m  "
              f"湿 {r['湿格_ha']:>7.1f} ha  橙 {r['橙格_ha']:>6.1f}  "
              f"红 {r['红格_ha']:>6.1f}", flush=True)

    # 反事实包络：最干/最低顶托 vs 最湿/最高顶托
    print("\n=== C 反事实包络（两条轴同时取极值）===")
    best = run(THETA0[0], INVERT[0])      # 冬季枯水：前期干 + 顶托低
    worst = run(THETA0[-1], INVERT[-1])   # 台风高潮位：前期饱和 + 顶托高
    base_r = run(base.soil_theta0, base.drainage_invert_m)
    for tag, r in (("冬季枯水（θ0=0.05,顶托=0.01）", best),
                   ("现状（θ0=0.45,顶托=0.05）", base_r),
                   ("台风高潮位（θ0=0.95,顶托=0.50）", worst)):
        print(f"    {tag:<30} 峰 {r['峰值水深_m']:.4f} m  "
              f"湿 {r['湿格_ha']:>7.1f} ha  橙 {r['橙格_ha']:>6.1f}  "
              f"红 {r['红格_ha']:>6.1f}")

    env_peak = (round(worst["峰值水深_m"] - best["峰值水深_m"], 4),
                round((worst["峰值水深_m"] / max(best["峰值水深_m"], 1e-9) - 1) * 100, 1))
    env_orange = round(worst["橙格_ha"] - best["橙格_ha"], 1)
    env_wet = round(worst["湿格_ha"] - best["湿格_ha"], 1)

    a_span = (max(r["峰值水深_m"] for r in rows_a)
              - min(r["峰值水深_m"] for r in rows_a))
    b_span = (max(r["峰值水深_m"] for r in rows_b)
              - min(r["峰值水深_m"] for r in rows_b))

    payload = {
        "名称": "前期条件反事实：反季节事件的风险包络",
        "生成时间": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "问题": ("反季节极端事件在历史目录里零样本（18 场台风全在 6–10 月），"
                 "无法用历史验证。只能做反事实推理：给定同一场雨，"
                 "若前期条件是冬季偏干 vs 台风季偏湿，后果差多少？"),
        "已查证的缺陷": {
            "soil_theta0": ("=0.45 为全域常数，代码注释写明"
                            "『台风季前期有前期降雨』——把季节假设焊死成一个数"),
            "drainage_invert_m": ("=0.05 为全域常数，是河网/潮位水位的代理；"
                                  "p30 已定性仅 5/17 点可能受顶托"),
        },
        "降雨": {"面雨量_mm": round(areal_mm, 1)},
        "A_土壤前期含水率扫描": rows_a,
        "B_顶托高程扫描": rows_b,
        "C_反事实包络": {
            "冬季枯水": best, "现状": base_r, "台风高潮位": worst,
            "峰值包络_m": env_peak[0], "峰值包络_pct": env_peak[1],
            "橙格包络_ha": env_orange, "湿格包络_ha": env_wet,
        },
        "敏感性": {
            "θ0_单独跨度_m": round(a_span, 4),
            "顶托_单独跨度_m": round(b_span, 4),
            "两轴联合跨度_m": env_peak[0],
        },
        "结论": [],
        "边界": [
            "这是**干预（do-算子）**实验，不是严格意义的反事实——"
            "因为真实前期状态没有观测，只能设定而非反演。",
            "θ0 与顶托均作全空间均一改动，未做空间异质场（真实季节差异有空间结构）。",
            "反季节事件还有其它差异未纳入：雨型（对流 vs 层状）、"
            "植被截留、管网淤积、下游潮位过程。",
            "同一场雨取自烟花（259 mm/72 h）；反季节暴雨的雨型可能完全不同。",
            "共用宁波参数，无本地验证。",
        ],
    }

    payload["结论"] = [
        (f"土壤前期含水率 θ0 从 {THETA0[0]} 到 {THETA0[-1]}（干→饱和），"
         f"峰值水深变化 {a_span:.4f} m"
         + ("（几乎无效）" if a_span < 0.01 else "")),
        (f"管网顶托高程从 {INVERT[0]} 到 {INVERT[-1]} m，"
         f"峰值水深变化 {b_span:.4f} m"
         + ("（几乎无效）" if b_span < 0.01 else "")),
        (f"两轴同时取极值（冬季枯水 vs 台风高潮位），"
         f"峰值水深差 **{env_peak[0]} m（{env_peak[1]}%）**，"
         f"橙格差 {env_orange} ha、湿格差 {env_wet} ha。"),
        ("**这就是反季节事件的误差包络**：即便把两条前期轴都推到极值，"
         "峰值水深仍在同一量级" if abs(env_peak[1]) < 30 else
         "**这就是反季节事件的误差包络**：两条前期轴推到极值，"
         "峰值水深跨量级变化——前期条件不可忽略"),
        ("**因此对反季节事件的正确表述**："
         "本模型可以给出『给定雨量的后果量级』，"
         "但**不能声称已考虑季节差异**——因为前期状态是设定值而非反演值。"
         "要真正处理反季节，必须补两样：① 前期土壤湿度的遥感反演（可做）；"
         "② 河网/潮位逐时水位（浙江水雨情平台有通道，见 official-data-sources）。"),
        ("**与『世界模型反事实』的差距要说清**："
         "真正的反事实需要『看到实际发生了什么（abduction）→ 干预 → 预测』。"
         "我们现在只有第二、三步，缺第一步——因为没有前期状态的观测。"
         "这不是模型能力问题，是观测缺口。"),
    ]

    (OUT / "p41_前期条件反事实.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n  θ0 单独跨度 {a_span:.4f} m  顶托单独跨度 {b_span:.4f} m  "
          f"联合 {env_peak[0]:+.4f} m（{env_peak[1]:+.1f}%）")
    print(f"→ {OUT / 'p41_前期条件反事实.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
