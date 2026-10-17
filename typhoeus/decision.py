"""p23 决策可行域：三条腿在"净可用预警时间"上咬合。

这是本项目唯一让三条腿真正交互的机制：

    气象腿 → 模型提前量（p18：19.33 h）
    信息腿 → 公开滞后（p16：13.37 h）
    ────────────────────────────────
    净可用预警 = 提前量 − 滞后（≈ 5.96 h）

    城建腿 → 各类动作所需提前量
    净可用 ≥ 所需 → 可执行；否则不可执行

**为什么这是交互而不是并列**：三条腿各自给出一个时间量，
只有相减之后才能回答"现在能做什么"。任何一个腿变了，可执行清单就变。

动作所需提前量的依据分两类，逐条标注：
    - 有实测依据的：来自 2021 烟花期间的真实动作时序（service_outages）
    - 工程假设的：无公开数据，按行业惯例估计，必须标注

用法：
    python -m typhoeus.decision
    python -m typhoeus.decision --scenario 338.8
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"

# 动作 → (所需提前量 h, 依据类型, 依据说明)
ACTIONS = [
    ("电梯停梯", 1.0, "工程假设", "物业通知 + 停梯操作，1 h 量级"),
    ("道路封道", 2.0, "工程假设", "交警布控与绕行引导，2 h 量级"),
    ("泵车/移动泵调度", 6.0, "实测依据",
     "2021 烟花：道路封道 07-25 22:00 → 强排作业 07-26 04:00，相隔 6 h"),
    ("人员转移", 12.0, "实测依据",
     "2021 烟花：洞桥镇 5 万人，07-25 21:00 启动，07-26 镇区积水 220 cm"),
    ("工程改造（管网/调蓄）", 8760.0, "无需预警", "以年计，不受预警时间约束"),
]

# 时间量来源（均可追溯到具体产物）
MODEL_LEAD_H = 19.33          # p18 提前量中位
DISCLOSE_LAG_H = 13.37        # p16 B 报道时滞中点
DISCLOSE_LAG_RANGE = (11.37, 15.37)
DISCLOSE_LAG_A_RANGE = (2.0, 12.0)   # p16 A 可分离样本下界范围


def feasible(net_h: float) -> tuple[list[dict], list[dict]]:
    """按净可用时间把动作分成可行/不可行两栏。"""
    ok, no = [], []
    for name, need, src, basis in ACTIONS:
        rec = {"动作": name, "所需提前_h": need, "依据类型": src, "依据": basis,
               "净可用_h": round(net_h, 2)}
        if net_h >= need:
            rec["余量_h"] = round(net_h - need, 2)
            ok.append(rec)
        else:
            rec["缺口_h"] = round(need - net_h, 2)
            no.append(rec)
    return ok, no


def build(outdir: str = "out", verbose: bool = True,
          lead: float | None = None, lag: float | None = None) -> dict:
    """lead / lag 可覆盖默认值（默认取 p18 / p16 的实测中位）。"""
    lead_h = MODEL_LEAD_H if lead is None else float(lead)
    lag_h = DISCLOSE_LAG_H if lag is None else float(lag)
    net_point = lead_h - lag_h
    # 区间：披露滞后取 B（分钟级）与 A（日级下界）两种口径的最宽范围
    net_worst = lead_h - DISCLOSE_LAG_RANGE[1]
    net_best = lead_h - min(DISCLOSE_LAG_A_RANGE[0], DISCLOSE_LAG_RANGE[0])

    ok, no = feasible(net_point)

    # 三个净可用水平下的可执行清单（敏感性）
    table = []
    for label, net in (("乐观（滞后取下界 2 h）", lead_h - 2.0),
                       ("中性（滞后 13.4 h）", net_point),
                       ("悲观（滞后取上界 15.4 h）", net_worst)):
        o, n = feasible(net)
        table.append({
            "口径": label, "净可用_h": round(net, 2),
            "可执行": [x["动作"] for x in o],
            "不可执行": [x["动作"] for x in n],
        })

    payload = {
        "名称": "决策可行域：三条腿在净可用预警时间上咬合",
        "生成时间": datetime.now().isoformat(timespec="seconds"),
        "问题": f"模型提前 {lead_h:.1f} h，但信息滞后 {lag_h:.1f} h —— 扣完之后还能做什么？",
        "交互机制": {
            "净可用预警_h = 模型提前量 − 公开滞后": None,
            "模型提前量": {"值_h": round(lead_h, 2), "来源": "p18 提前量中位（SAR 真值）"},
            "公开滞后": {"值_h": round(lag_h, 2), "区间_h": list(DISCLOSE_LAG_RANGE),
                      "来源": "p16 B 报道时滞（央广网，分钟级）",
                      "另一口径": {"区间_h": list(DISCLOSE_LAG_A_RANGE),
                               "来源": "p16 A 披露滞后下界（台账，日级）"}},
        },
        "净可用预警_h": {
            "点值": round(net_point, 2),
            "悲观": round(net_worst, 2),
            "乐观": round(net_best, 2),
        },
        "可执行": ok,
        "不可执行": no,
        "敏感性": table,
        "结论": (f"净可用 {net_point:.1f} h：可执行 {len(ok)} 类动作"
                 f"（{'、'.join(x['动作'] for x in ok)}）；"
                 f"不可执行 {len(no)} 类（{'、'.join(x['动作'] for x in no)}）。"),
        "边界": [
            "净可用 = 两个**不同样本**的时间量相减（p18 的水面提前量 − p16 的报道滞后），"
            "不是同地点同事件的配对测量。这是本件的最大弱点，必须随结论一起引用。",
            "若将来能配对（同一涝点的模型越阈时刻与官方通报时刻），本件应整件重算。",
            "动作所需提前量中，只有『泵车调度 6 h』与『人员转移 12 h』有 2021 烟花的实测时序支撑；"
            "其余为工程假设。",
            "净可用为负时，意味着模型再准也早不过公开信息——此时瓶颈完全在信息侧。",
        ],
    }
    p = Path(outdir)
    p.mkdir(parents=True, exist_ok=True)
    (p / "p23_决策可行域.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    if verbose:
        print(f"  模型提前 {lead_h} h − 公开滞后 {lag_h} h "
              f"= 净可用 {net_point:.2f} h  （悲观 {net_worst:.2f} / 乐观 {net_best:.2f}）")
        print(f"  可执行（{len(ok)}）：")
        for x in ok:
            print(f"    ✓ {x['动作']:<20} 需 {x['所需提前_h']:>6.1f} h  "
                  f"余量 {x['余量_h']:>5.1f} h  [{x['依据类型']}]")
        print(f"  不可执行（{len(no)}）：")
        for x in no:
            gap = x["缺口_h"]
            extra = f"  ← 只差 {gap*60:.0f} 分钟" if gap < 0.5 else ""
            print(f"    ✗ {x['动作']:<20} 需 {x['所需提前_h']:>6.1f} h  "
                  f"缺口 {gap:>5.2f} h{extra}")
        print(f"→ {p / 'p23_决策可行域.json'}")
    return payload


def main(argv: list[str] | None = None, lead: float | None = None,
         lag: float | None = None) -> int:
    ap = argparse.ArgumentParser(prog="typhoeus.decision")
    ap.add_argument("outdir", nargs="?", default="out")
    ap.add_argument("--lead", type=float, default=None,
                    help=f"模型提前量（h），默认 {MODEL_LEAD_H}")
    ap.add_argument("--lag", type=float, default=None,
                    help=f"公开滞后（h），默认 {DISCLOSE_LAG_H}")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    payload = build(a.outdir, verbose=not a.json,
                    lead=lead if lead is not None else a.lead,
                    lag=lag if lag is not None else a.lag)
    if a.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
