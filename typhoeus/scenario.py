"""情景档匹配：给定面雨量（或从事件产物读取），回答"按哪一档执行"。

这是场景 S1/S2（汛前预置 / 汛中响应）的执行入口：
输入一个 72 h 面雨量，输出应启动的响应等级、动作要求、人员装备配置，
以及该量级在已标定分位分布中的位置。

用法：
  python -m typhoeus.scenario 338.8            # 直接给面雨量
  python -m typhoeus.scenario --event           # 用当前 out/ 事件的面雨量
  python -m typhoeus.scenario --percentile 0.9  # 直接给分位档
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 与 typhoeus.products 的情景档保持一致（同一份分位数，不另立口径）
SCENARIOS = [("p50", 258.4), ("p80", 313.2), ("p90", 338.8), ("p95", 354.1)]

ACTIONS = {
    "p50": ("常态", "按常规汛期巡查执行；优先点位每 12 h 一次", "常规值守", "0 处"),
    "p80": ("加强", "优先点位每 6 h 一次；下穿立交/桥洞派专人盯守", "1 组（2 人）加强班", "6 处"),
    "p90": ("三级响应（预案启动线）", "优先点位每 2 h 一次；全部下穿立交预置警示与绕行牌",
            "2 组（4 人）+ 排涝车 1 台待命", "12 处（模型建议布点数）"),
    "p95": ("三级响应加强", "优先点位连续盯守；低洼小区逐栋走访提示",
            "3 组（6 人）+ 排涝车 2 台待命", "12 处 + 低洼小区 7 处走访"),
}


def match(mm: float) -> dict:
    """把面雨量落到情景档。低于 p50 也给出该档，并注明低于最低档。"""
    level = SCENARIOS[0][0]
    for name, thr in SCENARIOS:
        if mm >= thr:
            level = name
    below = mm < SCENARIOS[0][1]
    lvl, action, crew, sites = ACTIONS[level]
    return {
        "面雨量_72h_mm": round(float(mm), 1),
        "情景档": level,
        "响应等级": lvl,
        "动作要求": action,
        "人员与装备": crew,
        "布点": sites,
        "低于最低档": below,
        "分位参照": [{"档": k, "面雨量_mm": v} for k, v in SCENARIOS],
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="typhoeus.scenario", description="情景档匹配与响应等级建议")
    ap.add_argument("mm", nargs="?", type=float, help="72 h 面雨量（mm）")
    ap.add_argument("--event", action="store_true", help="用 out/ 当前事件的面雨量")
    ap.add_argument("--percentile", type=float, default=None, help="直接指定分位（0.5/0.8/0.9/0.95）")
    ap.add_argument("--outdir", default="out")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    a = ap.parse_args(argv)

    if a.percentile is not None:
        key = f"p{int(round(a.percentile * 100))}"
        for name, thr in SCENARIOS:
            if name == key:
                mm = thr
                break
        else:
            print(f"未知分位 {a.percentile}；可选 0.5 / 0.8 / 0.9 / 0.95", file=sys.stderr)
            return 2
    elif a.event or a.mm is None:
        p = Path(a.outdir) / "01_preset_plan.json"
        if not p.exists():
            print(f"缺少 {p}；请先跑 `python -m typhoeus.cli run` 或直接给出面雨量", file=sys.stderr)
            return 2
        mm = float(json.loads(p.read_text(encoding="utf-8"))["输入层校验"]["model_mm"])
    else:
        mm = a.mm

    r = match(mm)
    if a.json:
        print(json.dumps(r, ensure_ascii=False, indent=2))
        return 0

    print(f"输入面雨量（72 h）: {r['面雨量_72h_mm']} mm")
    print(f"落档              : {r['情景档']}")
    print(f"响应等级          : {r['响应等级']}")
    print(f"动作要求          : {r['动作要求']}")
    print(f"人员与装备        : {r['人员与装备']}")
    print(f"布点              : {r['布点']}")
    if r["低于最低档"]:
        print("注：低于 p50 档，按最低档（常态）执行。")
    print("分位参照          : " + " · ".join(f"{k} {v:.1f} mm" for k, v in SCENARIOS))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
