"""p50 验证与统计：留出验证、零值处理敏感性、bootstrap 置信区间。

为什么必须做
------------
此前 Q ∝ 雨量^2.109（R² 0.883）与深度标度 b=0.434 都是**同批数据既拟合又评估**，
且**从未说明 Q=0 的场次如何处理**。本件补三件事：

  1 **零值处理敏感性**：Q=0 的场次若取 log 需加 eps，而 b 对 eps 极度敏感。
     这不是细节，是**标度指数能否被识别**的问题。
  2 **LOO-CV**（留一场）：每次留出一场，用其余拟合，预测留出场 → 样本外误差
  3 **bootstrap 置信区间**：对 b 与常数项重采样

本件不改变既有产物，只评估其数字在样本外与在口径扰动下是否成立。

用法：python -m typhoeus.validstats
"""

from __future__ import annotations

import json
import math
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
B = 2000


def _load(n: str) -> dict:
    p = OUT / n
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


def fit_power(x: np.ndarray, y: np.ndarray) -> tuple[float, float]:
    """y = a · x^b 的对数空间最小二乘。返回 (a, b)。"""
    b, lna = np.polyfit(np.log(x), np.log(y), 1)
    return float(math.exp(lna)), float(b)


def r2_log(x: np.ndarray, y: np.ndarray) -> float:
    lx, ly = np.log(x), np.log(y)
    b, lna = np.polyfit(lx, ly, 1)
    res = ly - (lna + b * lx)
    return float(1 - (res ** 2).sum() / ((ly - ly.mean()) ** 2).sum())


def main() -> int:
    rng = np.random.default_rng(20261018)

    p33 = _load("p33_跨事件决策矩阵.json")
    evs = [e for e in p33.get("事件", []) if e.get("面雨量_mm")]
    rain = np.array([e["面雨量_mm"] for e in evs], float)
    q = np.array([e["Q_total"] for e in evs], float)
    years = np.array([e["年"] for e in evs], int)
    names = [e["台风"] for e in evs]
    n_all = len(evs)

    pos = q > 0
    r_p, q_p = rain[pos], q[pos]
    yr_p, nm_p = years[pos], [names[i] for i in range(n_all) if pos[i]]
    n = int(pos.sum())

    # ---------- 1) 主拟合（仅 Q>0，对数空间）----------
    a_p, b_p = fit_power(r_p, q_p)
    r2_log_p = r2_log(r_p, q_p)
    pred_lin = a_p * r_p ** b_p
    r2_lin_p = float(1 - ((q_p - pred_lin) ** 2).sum()
                     / ((q_p - q_p.mean()) ** 2).sum())

    # ---------- 2) 零值处理敏感性 ----------
    sens = []
    for eps in (1e-6, 1e-5, 1e-4, 1e-3):
        try:
            _, bb = fit_power(rain, q + eps)
            sens.append({"处理": f"含 Q=0，加 eps={eps:g}", "n": n_all,
                         "b": round(bb, 4)})
        except Exception:  # noqa: BLE001
            pass
    # 剔除最大场
    m_nb = r_p < r_p.max()
    if m_nb.sum() >= 5:
        _, bb = fit_power(r_p[m_nb], q_p[m_nb])
        sens.append({"处理": "仅 Q>0，剔除最大场",
                     "n": int(m_nb.sum()), "b": round(bb, 4)})
    # 仅大雨量
    m_big = r_p > 40
    if m_big.sum() >= 5:
        _, bb = fit_power(r_p[m_big], q_p[m_big])
        sens.append({"处理": "仅 Q>0 且雨量>40 mm",
                     "n": int(m_big.sum()), "b": round(bb, 4)})
    b_lo = min(s["b"] for s in sens + [{"b": b_p}])
    b_hi = max(s["b"] for s in sens + [{"b": b_p}])

    # ---------- 3) LOO-CV（对数空间，仅 Q>0）----------
    loo = np.zeros(n)
    for i in range(n):
        mm = np.ones(n, bool)
        mm[i] = False
        ai, bi = fit_power(r_p[mm], q_p[mm])
        loo[i] = ai * r_p[i] ** bi
    log_err = np.log(loo / q_p)
    r2_log_loo = float(1 - (log_err ** 2).sum()
                       / ((np.log(q_p) - np.log(q_p).mean()) ** 2).sum())
    med_mult = float(np.exp(np.median(np.abs(log_err))))
    p90_mult = float(np.exp(np.percentile(np.abs(log_err), 90)))

    # ---------- 4) 时间切分 ----------
    tr = yr_p <= 2019
    te = ~tr
    split: dict = {"说明": "2020 年后致涝场次不足 2 场，不可执行"}
    if te.sum() >= 2 and tr.sum() >= 5:
        a_t, b_t = fit_power(r_p[tr], q_p[tr])
        pred_t = a_t * r_p[te] ** b_t
        rel = np.abs(pred_t / q_p[te] - 1) * 100
        split = {
            "切分": "2015–2019 标定 / 2020–2025 留出",
            "标定_n": int(tr.sum()), "留出_n": int(te.sum()),
            "留出名单": [f"{nm_p[i]}({yr_p[i]})" for i in range(n) if te[i]],
            "b_train": round(b_t, 4),
            "b_全样本之差": round(b_t - b_p, 4),
            "留出绝对相对误差_pct": [round(float(x), 1) for x in rel],
            "留出中位绝对相对误差_pct": round(float(np.median(rel)), 1),
            "边界": "留出仅 2–3 场，只作方向性检查，不作统计推断。",
        }

    # ---------- 5) bootstrap ----------
    def boot(x: np.ndarray, y: np.ndarray) -> tuple[list[float], list[float]]:
        bs_a, bs_b = [], []
        m = len(x)
        for _ in range(B):
            idx = rng.integers(0, m, m)
            if len(np.unique(idx)) < 4:
                continue
            try:
                ai, bi = fit_power(x[idx], y[idx])
                bs_a.append(ai)
                bs_b.append(bi)
            except Exception:  # noqa: BLE001
                continue
        return bs_a, bs_b

    bs_a, bs_b = boot(r_p, q_p)
    ci_b = [round(float(np.percentile(bs_b, 2.5)), 4),
            round(float(np.percentile(bs_b, 97.5)), 4)]
    ci_a = [round(float(np.percentile(bs_a, 2.5)), 8),
            round(float(np.percentile(bs_a, 97.5)), 8)]

    # ---------- 6) 深度标度 b（n=5，等比放大，非独立）----------
    gs = _load("gen_shape_first.json")
    rows = [(r["面雨量_mm"], r["全域最大水深峰值_m"]) for r in (gs.get("结果") or [])
            if r.get("面雨量_mm") and r.get("全域最大水深峰值_m")]
    depth: dict = {}
    if len(rows) >= 3:
        dx = np.array([r[0] for r in rows], float)
        dy = np.array([r[1] for r in rows], float)
        _, bd = fit_power(dx, dy)
        _, bsd = boot(dx, dy)
        depth = {
            "n": len(rows),
            "b_点估计": round(bd, 4),
            "b_95CI": [round(float(np.percentile(bsd, 2.5)), 4),
                       round(float(np.percentile(bsd, 97.5)), 4)],
            "数据来源": "gen_shape_first 的 5 档幅度放大（固定时间形状）",
            "警告": ("n=5 且 5 个点是**同一场雨按比例放大**得到的，不是独立样本；"
                    "区间只反映拟合不确定性，不反映跨事件变异。"
                    "**b=0.434 不可当作经验标度律对外引用。**"),
        }

    payload = {
        "名称": "验证与统计：留出验证、零值敏感性、bootstrap 区间",
        "生成时间": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "为什么需要这一件": (
            "此前 Q∝雨量^b 与 b=0.434 都是同批数据既拟合又评估，"
            "且从未说明 Q=0 场次如何处理。本件给样本外误差、零值敏感性"
            "与置信区间，检验那些数字是否可识别。"),
        "样本": {
            "事件总数": n_all, "Q>0 场次": n, "Q=0 场次": n_all - n,
            "年份跨度": [int(years.min()), int(years.max())],
            "Q>0 名单": [f"{nm_p[i]}({yr_p[i]})" for i in range(n)],
            "注意": ("p33 口径段称『致涝 14 场』，而 Q>0 实为 "
                     f"{n} 场；差额来自该段把某些极小雨量场计入。"
                     "本件以 Q>0 为准并如实标注。"),
        },
        "1_主拟合": {
            "形式": "Q = a · rain^b（对数空间最小二乘，仅 Q>0）",
            "a": round(a_p, 10), "b": round(b_p, 4), "n": n,
            "R2_对数空间": round(r2_log_p, 4),
            "R2_线性空间": round(r2_lin_p, 4),
            "R2_说明": ("对数空间 R² 衡量幂律形状是否拟合；线性空间 R² 被最大场"
                        "主导。两者不可混引——既有材料引的 0.883 属前者口径。"),
        },
        "2_零值处理敏感性": {
            "各口径_b": sens,
            "b_取值范围": [round(b_lo, 4), round(b_hi, 4)],
            "含义": ("b 随『Q=0 如何处理』在 "
                     f"{b_lo:.2f}–{b_hi:.2f} 之间变动，"
                     "故**单一 b 值不是可识别的物理量**，"
                     "只能报区间并声明口径。"),
        },
        "3_LOO留一场": {
            "R2_对数空间_样本外": round(r2_log_loo, 4),
            "R2_对数空间_样本内": round(r2_log_p, 4),
            "落差": round(r2_log_p - r2_log_loo, 4),
            "乘性误差_中位倍数": round(med_mult, 3),
            "乘性误差_p90倍数": round(p90_mult, 3),
            "逐场": [{"台风": nm_p[i], "年": int(yr_p[i]),
                    "实测Q": round(float(q_p[i]), 4),
                    "留出预测Q": round(float(loo[i]), 4),
                    "倍数_预测除实测": round(float(loo[i] / q_p[i]), 3)}
                   for i in range(n)],
        },
        "4_时间切分": split,
        "5_bootstrap_Q标度": {
            "b_点估计": round(b_p, 4), "b_95CI": ci_b, "a_95CI": ci_a,
            "重采样次数": len(bs_b), "n": n,
            "对超线性的判定": ("区间不含 1 → 本样本支持超线性" if ci_b[0] > 1.0
                          else "**区间含 1 → 本样本不支持超线性主张**"),
        },
        "6_深度标度_b": depth,
        "对既有主张的处置": [],
        "结论": [],
        "边界": [
            "LOO 每次只留 1 场，仍属小样本；R² 抽样方差大，须与乘性误差合读。",
            "Q 是域内功能损失积分，不是货币损失；误差倍数不可换算为经济损失误差。",
            "时间切分留出仅 2–3 场，不作统计推断。",
            "b=0.434 的 5 点非独立，区间不代表跨事件变异。",
            "本件不改变既有产物数字，只评估其可识别性与样本外表现。",
        ],
    }

    # 处置建议按实测生成
    disp = []
    if ci_b[0] <= 1.0:
        disp.append("b 的 CI 含 1 → 材料中『雨量翻倍损失 4.3 倍』须撤回或加区间限定")
    else:
        disp.append(f"b 的 CI [{ci_b[0]}, {ci_b[1]}] 不含 1 → 超线性方向成立，"
                    f"但**点估计须报区间**，不得单引 {b_p:.2f}")
    disp.append(f"b 在零值处理下于 {b_lo:.2f}–{b_hi:.2f} 变动 → "
                "材料中单一数值 2.109 须改为区间 + 口径声明")
    if r2_log_loo < 0.8:
        disp.append(f"样本外 R² {r2_log_loo:.3f} < 0.8 → 不得以样本内 R² 宣称预报能力")
    disp.append("深度 b=0.434（n=5 非独立）→ 一律加限定或不予对外引用")
    payload["对既有主张的处置"] = disp

    payload["结论"] = [
        (f"**主拟合**（仅 Q>0，n={n}）：b={b_p:.4f}，"
         f"对数空间 R²={r2_log_p:.3f}，线性空间 R²={r2_lin_p:.3f}。"
         "两口径差异巨大，引用必须说明是哪一个。"),
        (f"**零值处理敏感性是最重要的发现**：b 随 Q=0 的处理方式在 "
         f"**{b_lo:.2f}–{b_hi:.2f}** 之间变动。"
         f"材料里的 2.109 只是其中一种处理的产物。"
         "**故『单一标度指数』不是这个数据集能识别的量。**"),
        (f"**样本外**（LOO，对数空间）：R² 从 {r2_log_p:.3f} 降到 "
         f"{r2_log_loo:.3f}；乘性误差中位 {med_mult:.2f} 倍、"
         f"90 分位 {p90_mult:.2f} 倍。"),
        (f"**bootstrap**：b 的 95% CI [{ci_b[0]:.3f}, {ci_b[1]:.3f}]；"
         + ("区间不含 1，超线性方向成立，但点估计不可单引。"
            if ci_b[0] > 1.0 else "区间含 1，超线性主张不成立。")),
    ]
    if depth:
        payload["结论"].append(
            f"**深度标度 b={depth['b_点估计']}（CI {depth['b_95CI']}，n={depth['n']}）**"
            "——5 点来自同一场雨等比放大，非独立样本，不可作经验标度律引用。")
    if split.get("留出中位绝对相对误差_pct") is not None:
        payload["结论"].append(
            f"**时间切分**：2015–2019 标定 b={split['b_train']}，"
            f"2020–2025 留出中位绝对相对误差 "
            f"{split['留出中位绝对相对误差_pct']}%（n={split['留出_n']}）。")

    (OUT / "p50_验证与统计.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"  n={n}（Q=0 有 {n_all - n} 场）")
    print(f"  主拟合 b={b_p:.4f}  R²_log={r2_log_p:.4f}  R²_lin={r2_lin_p:.4f}")
    print(f"  零值敏感性 b ∈ [{b_lo:.4f}, {b_hi:.4f}]  ← 关键")
    print(f"  LOO: R²_log {r2_log_p:.3f} → {r2_log_loo:.3f}；"
          f"乘性误差 {med_mult:.2f}× / p90 {p90_mult:.2f}×")
    print(f"  b 的 95%CI [{ci_b[0]}, {ci_b[1]}]")
    if depth:
        print(f"  深度 b={depth['b_点估计']} CI {depth['b_95CI']}（n={depth['n']}，非独立）")
    print(f"→ {OUT / 'p50_验证与统计.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
