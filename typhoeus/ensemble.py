"""p51 参数集合不确定性：一个数不是结论，是一个分布的一个样本。

为什么必须做
------------
此前所有结论都来自**一次确定性推演**（一套参数、一个峰值水深、一个 Q）。
但那些参数大多**没有本地标定**：顶托高程、过流系数、土层厚度、不透水率、
前期土壤含水率，都是文献量级或单场反推。

本件做参数集合（Latin Hypercube，N=24），输出：
  1 峰值水深 / 红格面积 / Q 的分布（P10–P50–P90）
  2 各参数与输出的秩相关 → 谁是主控
  3 单次确定性推演落在分布的哪个分位 → 既有的那个数是否"典型"

不做的事：不给参数后验（需观测似然，本项目缺逐时水位序列）。

用法：python -m typhoeus.ensemble
"""

from __future__ import annotations

import copy
import json
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"

# 参数名 → (下限, 上限, 依据)
RANGES = {
    # p41 实测：顶托 0.01→0.50 使峰值 +154%，是全模型最敏感参数
    "drainage_invert_m": (0.01, 0.10, "p41 敏感性；管网台账缺失，取地面下 1–10 cm 等效起排"),
    # 过流系数：基准 1.2e-3，取 ±1 倍量级
    "drainage_coeff_m_s": (0.6e-3, 2.4e-3, "基准 1.2e-3 的 0.5–2 倍"),
    # p37 实测：30→600 mm 使峰值 −4.7%，下渗 1.9%→32%
    "soil_capacity_mm": (30.0, 300.0, "p37 区间下段；600 mm 属极端，取 300 为上限"),
    # p35 OSM 实测 0.291；城建密度升高取到 0.6
    "impervious_frac": (0.291, 0.600, "p35 实测 0.291 至密集建成区 0.6"),
    # 前期土壤含水率：p41 实测 θ0 0.05→0.95 仅使峰值变 0.0034 m，故设宽区间
    "soil_theta0": (0.10, 0.40, "p41 实测该参数几乎不影响峰值，区间宽以示无关"),
}

N_SAMPLES = 24
RED_TH = 0.50   # GB 51222 红级


def lhs(n: int, d: int, rng: np.random.Generator) -> np.ndarray:
    """Latin Hypercube：每维分层 + 随机置换。"""
    u = np.zeros((n, d))
    for j in range(d):
        strata = (np.arange(n) + rng.random(n)) / n
        u[:, j] = strata[rng.permutation(n)]
    return u


def spearman(x: np.ndarray, y: np.ndarray) -> float:
    def rank(v):
        order = np.argsort(v)
        r = np.empty(len(v), float)
        r[order] = np.arange(1, len(v) + 1, dtype=float)
        return r
    rx, ry = rank(x), rank(y)
    rx -= rx.mean()
    ry -= ry.mean()
    den = float(np.sqrt((rx ** 2).sum() * (ry ** 2).sum()))
    return float((rx * ry).sum() / den) if den else float("nan")


def main() -> int:
    from typhoeus import cli as CLI
    from typhoeus import config as CFG
    from typhoeus import data as D
    from typhoeus import kernel as K
    from typhoeus import observe as OB
    from typhoeus import rainsrc as RS

    rng = np.random.default_rng(20261018)

    cfg = CFG.Config()
    inp = D.load_all(cfg.l2.bbox, cfg.l4.resample)
    g = inp.grid
    rain, _ = RS.get_rainfall(g, stations=OB.load_rain_stations(),
                              use_cache=True, calibrate=cfg.l2.rain_calibrate,
                              verbose=False)
    base_kp = CLI._kernel_params(cfg)
    area_ha = float(g.elev.size) * (g.cell_m ** 2) / 1e4

    names = list(RANGES)
    lo = np.array([RANGES[k][0] for k in names])
    hi = np.array([RANGES[k][1] for k in names])
    U = lhs(N_SAMPLES, len(names), rng)
    X = lo + U * (hi - lo)

    runs = [{
        "run": "基准（现状参数）",
        "params": {k: round(getattr(base_kp, k), 6) if hasattr(base_kp, k) else None
                   for k in names},
    }]
    # 基准先跑
    t0 = time.perf_counter()
    r0 = K.run(g, rain, base_kp)
    d0 = np.asarray(r0.depth)
    peak0 = float(d0.max())
    red0 = float((d0.max(axis=0) >= RED_TH).sum() * (g.cell_m ** 2) / 1e4)
    q0 = float(r0.drain_total_m3) / max(float(r0.rain_total_m3), 1e-9)
    runs[0].update({"峰值_m": round(peak0, 4), "红格_ha": round(red0, 3),
                    "Q": round(q0, 4), "守恒残差": float(f"{r0.mass_resid:.2e}")})
    print(f"  基准：峰值 {peak0:.4f} m  红格 {red0:.2f} ha  Q {q0:.4f}")

    ok = 0
    for i in range(N_SAMPLES):
        kp = copy.copy(base_kp)
        p = {}
        for j, k in enumerate(names):
            v = float(X[i, j])
            setattr(kp, k, v)
            p[k] = round(v, 6)
        try:
            r = K.run(g, rain, kp)
        except Exception as e:  # noqa: BLE001
            runs.append({"run": i, "params": p, "错误": type(e).__name__})
            continue
        d = np.asarray(r.depth)
        peak = float(d.max())
        red = float((d.max(axis=0) >= RED_TH).sum() * (g.cell_m ** 2) / 1e4)
        q = float(r.drain_total_m3) / max(float(r.rain_total_m3), 1e-9)
        runs.append({"run": i, "params": p, "峰值_m": round(peak, 4),
                     "红格_ha": round(red, 3), "Q": round(q, 4),
                     "守恒残差": float(f"{r.mass_resid:.2e}")})
        ok += 1
        if (i + 1) % 6 == 0:
            print(f"    {i + 1}/{N_SAMPLES} 完成")

    good = [x for x in runs[1:] if "峰值_m" in x]
    peaks = np.array([x["峰值_m"] for x in good])
    reds = np.array([x["红格_ha"] for x in good])
    qs = np.array([x["Q"] for x in good])

    def perc(a):
        return {"P10": round(float(np.percentile(a, 10)), 4),
                "P50": round(float(np.percentile(a, 50)), 4),
                "P90": round(float(np.percentile(a, 90)), 4),
                "均值": round(float(a.mean()), 4),
                "变异系数": round(float(a.std(ddof=1) / a.mean()), 4)
                if a.mean() else None}

    # 秩相关：参数 vs 输出
    sens = {}
    for j, k in enumerate(names):
        col = np.array([x["params"][k] for x in good], float)
        sens[k] = {
            "vs_峰值": round(spearman(col, peaks), 3),
            "vs_红格": round(spearman(col, reds), 3),
            "依据": RANGES[k][2],
        }
    ranked = sorted(sens, key=lambda k: -abs(sens[k]["vs_峰值"]))

    # 基准落在分布哪个分位
    pct_rank = float((peaks < peak0).mean() * 100)

    payload = {
        "名称": "参数集合不确定性：峰值与红格的分布",
        "生成时间": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "为什么需要这一件": (
            "此前所有结论都来自**一次确定性推演**。而顶托、过流系数、土层厚度、"
            "不透水率、前期含水率大多没有本地标定。本件给这些参数一个合理区间，"
            "看输出有多宽——**一个数不是结论，是一个分布的一个样本**。"),
        "设计": {
            "采样": f"Latin Hypercube，N={N_SAMPLES}（另加 1 次基准）",
            "成功次数": ok,
            "参数个数": len(names),
            "参数区间": {k: {"下限": RANGES[k][0], "上限": RANGES[k][1],
                          "依据": RANGES[k][2]} for k in names},
            "事件": "2021 烟花（实测面雨量，与主链同源）",
            "红级阈值_m": RED_TH,
        },
        "输出分布": {
            "峰值水深_m": perc(peaks),
            "红格面积_ha": perc(reds),
            "排水占比Q": perc(qs),
        },
        "基准落位": {
            "基准峰值_m": round(peak0, 4),
            "在集合中的分位_pct": round(pct_rank, 1),
            "解读": ("基准落在集合的 "
                     f"{pct_rank:.0f}% 分位；"
                     + ("接近中位，属典型取值。" if 25 <= pct_rank <= 75
                        else "偏离中位，说明基准参数不是集合的中心——"
                             "单次确定性推演可能系统性偏高或偏低。")),
        },
        "参数敏感性": sens,
        "敏感度排序": ranked,
        "逐次结果": runs,
        "结论": [],
        "边界": [
            "参数区间是**文献量级与单场反推**，不是本地标定的后验分布；"
            "故输出分布是『认知不确定性』的粗估，不是频率意义上的概率。",
            "未含降雨驱动的集合：降雨固定为实测，故本件只反映参数不确定性。",
            "N=24 只够看量级与排序，不足以分解交互作用（未做 Sobol 分解）。",
            "秩相关只捕捉单调关系；本模型对多数参数近似单调，故可用，但不等于因果。",
            "基准的 Q 定义为「排水量/降雨量」，与 p33 的功能损失 Q 不同名不同义。",
        ],
    }

    payload["结论"] = [
        (f"**峰值水深**：P10 {payload['输出分布']['峰值水深_m']['P10']} / "
         f"P50 {payload['输出分布']['峰值水深_m']['P50']} / "
         f"P90 {payload['输出分布']['峰值水深_m']['P90']} m，"
         f"变异系数 {payload['输出分布']['峰值水深_m']['变异系数']}。"),
        (f"**红格面积**：P10 {payload['输出分布']['红格面积_ha']['P10']} / "
         f"P50 {payload['输出分布']['红格面积_ha']['P50']} / "
         f"P90 {payload['输出分布']['红格面积_ha']['P90']} ha。"
         "红格面积的相对离散远大于峰值水深——**面积类指标比深度类更不稳**。"),
        ("**主控参数**（按与峰值的秩相关绝对值排序）："
         + "；".join(f"{k}（ρ={sens[k]['vs_峰值']:+.2f}）" for k in ranked[:3])
         + "。"),
        (f"**基准落位**：{pct_rank:.0f}% 分位。"
         + ("接近中位，单次推演可代表典型情形。"
            if 25 <= pct_rank <= 75 else
            "**偏离中位**——单次确定性推演不能代表典型情形，"
            "对外只报单值会系统性误导。")),
        ("**对产品的处置**：凡引用峰值或红格，都应同时给出该集合的 P10–P90；"
         "只报单值的结论应标为『基准参数下的一个样本』。"),
    ]

    (OUT / "p51_参数集合不确定性.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    o = payload["输出分布"]
    print(f"  峰值 P10–P90: {o['峰值水深_m']['P10']}–{o['峰值水深_m']['P90']} m"
          f"（P50 {o['峰值水深_m']['P50']}）")
    print(f"  红格 P10–P90: {o['红格面积_ha']['P10']}–{o['红格面积_ha']['P90']} ha")
    print(f"  主控: {ranked[:3]}")
    print(f"  基准落位 {pct_rank:.0f}% 分位")
    print(f"→ {OUT / 'p51_参数集合不确定性.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
