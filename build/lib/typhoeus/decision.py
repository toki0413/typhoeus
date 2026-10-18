"""p23 决策可行域（v2）：信息—行动空白。

v1 的错误（已作废）：
    用「模型提前量 − 新闻报道滞后」得"净可用 5.96 h"。
    错在把**新闻报道时刻**当成**信息可用时刻**——新闻是事后记录，不是预警渠道。

v2 的正确框架（依据 p24 官方时间线）：
    模型在首事件前 1.5 h 就给出该处会积水的判据；
    官方的具体处置动作却发生在事件后 10 h（道路封道）与 16 h（强排）。
    ⇒ **信息已经存在，但从信息到行动之间空了 8.5–14.5 小时。**

    这段空白才是产品可争取的空间——不是"更早预警"（官方比模型还早 25.5 h），
    而是"**在信息已经足够的时候，把动作提前**"。

本件把空白量化，并按"若信息被立即用于行动"重算可执行清单。

用法：
    python -m typhoeus.decision
    python -m typhoeus.decision --gap 4        # 假定空白压到 4 h
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"

FIRST_EVENT = "2021-07-25 12:00"

# 时间锚点（全部相对首个断供事件，正=事件之后）
MODEL_INFO_H = -1.5        # 模型首次越阈（由 p18 提前量 19.33 h 反推）
OFFICIAL_L1_H = -27.0      # 官方 Ⅰ 级响应
ROAD_CLOSE_H = 10.0        # 道路封道
PUMPING_H = 16.0           # 强排作业

# 动作 → (所需提前量 h, 依据类型, 依据说明)
ACTIONS = [
    ("电梯停梯", 1.0, "工程假设", "物业通知 + 停梯操作"),
    ("道路封道", 2.0, "工程假设", "交警布控与绕行引导"),
    ("泵车/移动泵调度", 6.0, "实测依据",
     "2021 烟花：道路封道 22:00 → 强排次日 04:00，相隔 6 h"),
    ("人员转移", 12.0, "实测依据",
     "洞桥镇 5 万人，07-25 21:00 启动，07-26 镇区积水 220 cm"),
    ("工程改造（管网/调蓄）", 8760.0, "无需预警", "以年计"),
]


def feasible(budget_h: float) -> tuple[list[dict], list[dict]]:
    ok, no = [], []
    for name, need, src, basis in ACTIONS:
        rec = {"动作": name, "所需提前_h": need, "依据类型": src, "依据": basis}
        if budget_h >= need:
            rec["余量_h"] = round(budget_h - need, 2)
            ok.append(rec)
        else:
            rec["缺口_h"] = round(need - budget_h, 2)
            no.append(rec)
    return ok, no


def build(outdir: str = "out", verbose: bool = True,
          gap: float | None = None) -> dict:
    """gap = 假定把"信息→行动"空白压到多少小时（默认取实测 8.5 h，即以封道为参照）。"""
    gap_road = ROAD_CLOSE_H - MODEL_INFO_H          # 8.5
    gap_pump = PUMPING_H - MODEL_INFO_H             # 14.5
    budget = gap_road if gap is None else float(gap)

    ok, no = feasible(budget)

    # 三种空白水平下的可执行清单
    table = []
    for label, g in (("按封道参照（实测 8.5 h）", gap_road),
                     ("按强排参照（实测 14.5 h）", gap_pump),
                     ("若空白压到 4 h", 4.0),
                     ("若空白压到 1 h", 1.0)):
        o, n = feasible(g)
        table.append({"口径": label, "可用提前_h": round(g, 2),
                      "可执行": [x["动作"] for x in o],
                      "不可执行": [x["动作"] for x in n]})

    payload = {
        "名称": "决策可行域（v2）：信息—行动空白",
        "生成时间": datetime.now().isoformat(timespec="seconds"),
        "v1作废说明": {
            "v1结论": "净可用预警 = 19.33 − 13.37 = 5.96 h",
            "作废原因": "把新闻报道时刻当成信息可用时刻；新闻是事后记录，不是预警渠道",
            "见": "out/p24_官方响应时间线.json",
        },
        "问题": "信息什么时候就有了？动作什么时候才做？中间空了多少？",
        "时间锚点_相对首事件_h": {
            "官方Ⅰ级响应": OFFICIAL_L1_H,
            "模型首次越阈": MODEL_INFO_H,
            "道路封道": ROAD_CLOSE_H,
            "强排作业": PUMPING_H,
        },
        "空白": {
            "相对道路封道_h": round(gap_road, 2),
            "相对强排作业_h": round(gap_pump, 2),
            "解释": "模型在事件前 1.5 h 已有判据，而封道在事件后 10 h、强排在 16 h。",
        },
        "按参考空白下的可执行清单": {
            "参考空白_h": round(budget, 2), "可执行": ok, "不可执行": no,
        },
        "敏感性": table,
        "结论": (f"空白 {gap_road:.1f}–{gap_pump:.1f} h："
                 f"按封道参照（{gap_road:.1f} h），可执行 "
                 f"{len(feasible(gap_road)[0])} 类；"
                 f"按强排参照（{gap_pump:.1f} h），可执行 "
                 f"{len(feasible(gap_pump)[0])} 类。"),
        "边界": [
            "模型越阈时刻由 p18 中位提前量反推，非本事件具体格点实测。",
            "封道与强排为类别级时刻（该类首条记录），非特定涝点动作时刻。",
            "『信息已存在但未行动』不等于『行动可以提前』——"
            "还受人员到位、设备调运、决策权限制约，本件未建模这些约束。",
            "动作所需提前量中，泵车 6 h 与转移 12 h 有实测时序支撑，其余为工程假设。",
        ],
    }
    p = Path(outdir)
    p.mkdir(parents=True, exist_ok=True)
    (p / "p23_决策可行域.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    if verbose:
        print(f"  模型信息 {MODEL_INFO_H:+.1f} h（事件前 1.5）｜官方Ⅰ级 {OFFICIAL_L1_H:+.1f} h")
        print(f"  道路封道 {ROAD_CLOSE_H:+.1f} h → 空白 {gap_road:.1f} h")
        print(f"  强排作业 {PUMPING_H:+.1f} h → 空白 {gap_pump:.1f} h")
        print(f"\n  按封道参照（{budget:.1f} h）可执行（{len(ok)}）：")
        for x in ok:
            print(f"    ✓ {x['动作']:<20} 需 {x['所需提前_h']:>6.1f} h  "
                  f"余量 {x['余量_h']:>5.1f} h")
        print(f"  不可执行（{len(no)}）：")
        for x in no:
            print(f"    ✗ {x['动作']:<20} 需 {x['所需提前_h']:>6.1f} h  "
                  f"缺口 {x['缺口_h']:>5.1f} h")
        print(f"→ {p / 'p23_决策可行域.json'}")
    return payload


def main(argv: list[str] | None = None, gap: float | None = None) -> int:
    ap = argparse.ArgumentParser(prog="typhoeus.decision")
    ap.add_argument("outdir", nargs="?", default="out")
    ap.add_argument("--gap", type=float, default=None,
                    help="假定把信息→行动空白压到多少小时")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    payload = build(a.outdir, verbose=not a.json,
                    gap=gap if gap is not None else a.gap)
    if a.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
