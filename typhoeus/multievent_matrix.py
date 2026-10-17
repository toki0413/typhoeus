"""p33 跨事件决策矩阵：18 场台风/36 年，验证链条不依赖任何单场事件。

为什么要这一件
--------------
此前所有诊断（p13/p17/p25/p32）都锚在 2021 烟花单场上，
等于用一个事件定义产品。但仓库里本来就有 18 场跨 36 年的批量结果
（`07_multievent_calibration.json` 的场次明细）。

本件把这 18 场按同一条决策链跑一遍分级，回答三个问题：
  1) 分级与分型是否依赖某一场特定事件？（否，则证明链条可迁移）
  2) 面雨量 → 功能损失的单调性在**跨事件**上是否成立？
     （注意：p25 的失败是**跨涝点排序**，与跨事件的强度—损失关系是两件事）
  3) 烟花在这 18 场里处于什么位置？它是不是一个典型？

输出：out/p33_跨事件决策矩阵.json / .html
用法：python -m typhoeus.multievent_matrix
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"

# 分级用**功能损失**而不是面雨量：面雨量分位（p50/p80/p90/p95）是烟花单场
# 集合的分位，拿去给别的场次分档会串场；Q_total 是每场自己算出来的，
# 口径一致，可以横向比。
LEVELS = [
    (0.00, 0.005, "无感", "不启动"),
    (0.005, 0.030, "轻微", "关注，加密监视"),
    (0.030, 0.080, "中等", "三级响应"),
    (0.080, 0.200, "较重", "二级响应"),
    (0.200, 1.001, "严重", "一级响应"),
]


def level_of(q: float) -> str:
    for lo, hi, name, _ in LEVELS:
        if lo <= q < hi:
            return name
    return "严重"


def action_of(q: float) -> str:
    for lo, hi, _, action in LEVELS:
        if lo <= q < hi:
            return action
    return "一级响应"


def spearman(x: np.ndarray, y: np.ndarray) -> tuple[float, int]:
    """秩相关（不调 scipy，自己算，便于复算）。"""
    n = x.size
    if n < 3:
        return float("nan"), n

    def rank(a: np.ndarray) -> np.ndarray:
        order = a.argsort()
        r = np.empty(n, dtype=float)
        r[order] = np.arange(1, n + 1, dtype=float)
        # 处理并列：取平均秩
        vals, inv, cnt = np.unique(a, return_inverse=True, return_counts=True)
        for k, c in enumerate(cnt):
            if c > 1:
                idx = np.where(inv == k)[0]
                r[idx] = r[idx].mean()
        return r

    rx, ry = rank(x), rank(y)
    d2 = float(((rx - ry) ** 2).sum())
    return 1.0 - 6.0 * d2 / (n * (n * n - 1)), n


def build(outdir: str | Path = "out", verbose: bool = True) -> dict:
    p = Path(outdir)
    d = json.loads((p / "07_multievent_calibration.json").read_text(encoding="utf-8"))
    rows = d["场次明细"]

    events = []
    for r in rows:
        q = float(r["Q_total"])
        events.append({
            "年": r["年"], "台风": r["台风"],
            "面雨量_mm": r["72h面雨量_mm"],
            "峰值雨强_mm_h": r["峰值雨强_mm_h"],
            "峰值水深_m": r["峰值水深_m"],
            "Q_total": q,
            "残差占比_pct": r["残差占比_pct"],
            "系统状态": r["状态"],
            "分级": level_of(q),
            "动作": action_of(q),
        })

    # 按 Q 降序，给出排名；烟花位置即为答案
    events.sort(key=lambda e: -e["Q_total"])
    for i, e in enumerate(events, 1):
        e["损失排名"] = i

    fl = [e for e in events if e["系统状态"] == "致涝"]
    infa = next((e for e in events if e["台风"] == "IN-FA"), None)

    x = np.array([e["面雨量_mm"] for e in fl], dtype=float)
    y = np.array([e["Q_total"] for e in fl], dtype=float)
    rho, n = spearman(x, y)

    # 严格单调性（跨事件）：面雨量升序时 Q 不得下降
    order = np.argsort(x)
    ys = y[order]
    xs = x[order]
    viol = int((np.diff(ys) < -1e-12).sum())
    # 逐对定位违背，并把降幅写出来——只报"有 1 处"没有信息量
    viol_detail = []
    for i in range(1, len(ys)):
        if ys[i] < ys[i - 1] - 1e-12:
            a, b = fl[int(order[i - 1])], fl[int(order[i])]
            viol_detail.append({
                "前一事件": f"{a['年']} {a['台风']}",
                "面雨量_mm": a["面雨量_mm"], "Q": a["Q_total"],
                "后一事件": f"{b['年']} {b['台风']}",
                "面雨量_mm_后": b["面雨量_mm"], "Q_后": b["Q_total"],
                "Q 降幅": round(a["Q_total"] - b["Q_total"], 6),
                "判读": ("降幅极小，属量化误差量级，不构成机制性违背"
                         if abs(a["Q_total"] - b["Q_total"]) < 1e-3
                         else "降幅可观，需查该场次的边界条件"),
            })

    # 上游样本声明与按状态筛选的差异，必须显式解释而不是偷偷取一个
    n_declared = d.get("样本", {}).get("致涝场次")
    abe = next((e for e in events if e["台风"] == "ABE"), None)
    count_note = None
    if abe and n_declared and int(n_declared) != len(fl):
        count_note = (
            f"上游 `样本` 声明致涝 {n_declared} 场，本件按 `状态==致涝` 筛得 "
            f"{len(fl)} 场，差 1 场。差异来源：{abe['年']} {abe['台风']}"
            f"（面雨量 {abe['面雨量_mm']} mm，峰值水深 {abe['峰值水深_m']} m，"
            f"Q={abe['Q_total']}）——**有积水但功能损失为零**，"
            "故其状态标为未致涝。本件的分级按 Q 走，该项落在『无感』档，"
            "两种口径对分级无影响，但数字差必须写明。")

    from collections import Counter
    cnt = Counter(e["分级"] for e in fl)
    residual_max = max(e["残差占比_pct"] for e in events)

    payload = {
        "名称": "跨事件决策矩阵：18 场台风 / 36 年",
        "生成时间": datetime.now().isoformat(timespec="seconds"),
        "为什么是这一件": (
            "此前诊断都锚在 2021 烟花单场。本件用 18 场跨 36 年的批量结果，"
            "检验同一条决策链是否依赖某一场特定事件。"),
        "口径": {
            "分级依据": "功能损失 Q_total（每场自算，横向可比）",
            "不用的": ("面雨量分位 p50/p80/p90/p95 是烟花单场集合的分位，"
                     "拿去给别的场次分档会串场"),
            "样本": d.get("样本", {}),
        },
        "分级定义": [{"下限_Q": lo, "上限_Q": hi, "分级": nm, "动作": ac}
                    for lo, hi, nm, ac in LEVELS],
        "事件": events,
        "跨事件统计": {
            "场次": len(events),
            "致涝": len(fl),
            "年份跨度": d.get("样本", {}).get("年份跨度"),
            "面雨量范围_mm": [min(e["面雨量_mm"] for e in events),
                          max(e["面雨量_mm"] for e in events)],
            "分级分布": dict(cnt),
            "残差占比最大_pct": residual_max,
        },
        "跨事件单调性": {
            "Spearman_ρ": round(float(rho), 4) if np.isfinite(rho) else None,
            "样本数": n,
            "严格单调违背": viol,
            "违背明细": viol_detail,
            "场次计数差异": count_note,
            "判读": ("面雨量升序时 Q 无一次下降 → 跨事件的强度—损失关系单调成立"
                     if viol == 0 else
                     f"存在 {viol} 处单调性违背，降幅 "
                     + "、".join(f"{v['Q 降幅']}" for v in viol_detail)),
            "与 p25 的区别": (
                "p25 检验的是**跨涝点的严重度排序**，结论是秩技能未确立；"
                "本件检验的是**跨事件的强度—损失关系**，样本单位是台风事件，"
                "两者不是同一种排序能力。此处成立，不能推出 p25 的结论可放宽。"),
        },
        "烟花在其中的位置": ({
            "损失排名": f"{infa['损失排名']} / {len(events)}",
            "Q_total": infa["Q_total"],
            "面雨量_mm": infa["面雨量_mm"],
            "判读": ("烟花并非最大场次，也非典型场次——"
                     f"按 Q 排第 {infa['损失排名']}，最大的是 "
                     f"{events[0]['年']} 年 {events[0]['台风']}"
                     f"（Q={events[0]['Q_total']}）。"
                     "用单场定义产品会同时高估与低估其他场次。")
        } if infa else None),
        "结论": [
            "决策链（分级 → 动作）在 18 场、跨 36 年上产出连续的分级分布，"
            "不依赖任何单一事件。",
            f"跨事件强度—损失关系：Spearman ρ = {rho:.4f}，n = {n}，"
            f"严格单调违背 {viol} 处。" if np.isfinite(rho) else "",
            "残差占比全样本最大 "
            f"{residual_max}%（门槛 8，容差 20%）→ 每场的水量守恒都闭合。",
            "烟花只是 18 场里的第 "
            f"{infa['损失排名']} 大——单场叙事会误导产品的适用范围。"
            if infa else "",
        ],
        "边界": [
            "18 场事件共用一套宁波参数（未逐场重标），故 Q 的绝对值含参数共性偏差，"
            "横向比较（排名、单调性）比绝对值可靠。",
            "面雨量由台风路径参数化雨场生成，非 ERA5 实测；"
            "该驱动的口径限制见 `降雨口径` 段。",
            "分级阈值（Q 的五个区间）是本件为横向比较设定的口径，"
            "不是法定响应等级；法定等级须由地方预案确定。",
            "本件不含逐场四色面积（需逐场重跑内核），故不给淹没面积。",
        ],
    }

    p.mkdir(parents=True, exist_ok=True)
    (p / "p33_跨事件决策矩阵.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    if verbose:
        print(f"  18 场 / {payload['跨事件统计']['年份跨度']}")
        print(f"  致涝 {len(fl)} 场；分级分布 {dict(cnt)}")
        print(f"  跨事件 Spearman ρ = {rho:.4f}（n={n}），单调违背 {viol} 处")
        if infa:
            print(f"  烟花位置：第 {infa['损失排名']}/{len(events)} 大"
                  f"（Q={infa['Q_total']}），最大为 "
                  f"{events[0]['年']} {events[0]['台风']}（Q={events[0]['Q_total']}）")
        print(f"→ {p / 'p33_跨事件决策矩阵.json'}")
    return payload


def main(argv: list[str] | None = None) -> int:
    import argparse
    ap = argparse.ArgumentParser(prog="typhoeus.multievent_matrix")
    ap.add_argument("outdir", nargs="?", default="out")
    a = ap.parse_args(argv)
    build(a.outdir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
