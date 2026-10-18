"""情景档匹配：给定面雨量（或从事件产物读取），回答"按哪一档执行"。

这是场景 S1/S2（汛前预置 / 汛中响应）的执行入口。
输入一个 **72 h、148 站插值口径**的面雨量，输出应启动的响应等级、
动作要求、人员装备配置，以及该量级在已标定分位分布中的位置。

**本接口的三条硬限制（每一条都会让结论错档，故必须显式声明）**

1. **口径**：阈值只对「148 站插值 + 标定」成立。实测同一场 IN-FA：
   站插 259.1 mm、ERA5 五点均值 189.9 mm、单点 181.3 mm、
   p33 参数化 202.5 mm。差 22–30%。填错口径会**掉两档**
   （190 mm 判「常态/0 处布点」，实际需三级响应/12 处）。
   → 用 `--basis` 声明；非 `station` 会给出告警。
2. **历时**：阈值是 72 h 累计。给 24 h 的量或 12 h 的量来套，无效。
   → 用 `--hours` 声明；非 72 会告警。
3. **时序**：本接口**答不了"什么时候"**。越阈时刻对雨型极敏感
   （`gen_shape_first` 实测跨度 350.5%），而备灾 deadline 正取决于它。
   要回答"什么时候"，必须同时给**历时或雨强**，本接口不收。

用法：
  python -m typhoeus.scenario 338.8                       # 站插口径，72 h
  python -m typhoeus.scenario 190 --basis era5            # 会告警并给换算参照
  python -m typhoeus.scenario --event                     # 用当前 out/ 事件的面雨量
  python -m typhoeus.scenario --percentile 0.9            # 直接给分位档
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 与 `typhoeus.scenario_matrix` 的四档一致（p6 的那一套），**不是** p1 的
# `触发阈值.台风测度` 那一套。两者数值不同且都"对"，因为它们是**两个构造**：
#   · 这里（p6/scenario_matrix）：降雨放大的设计档
#     258.4 / 313.2 / 338.8 / 354.1（×1.00 / ×1.21 / ×1.31 / ×1.37）
#   · p1 的 `台风测度`：台风测度序列的经验分位，且上三档被最大值钳住
#     206.4 / 251.6 / 251.6 / 251.6（触发阈值取 251.6）
# 后果：同一场 IN-FA 的 259.1 mm，本模块判「p50 / 常态 / 0 处布点」，
# 而 p1 判「过 251.6 阈值 → 布 12 处」。**两个产物对同一场雨给出相反建议。**
# 详见 docs/rainfall-basis-gap.md 第九节。此处先如实标注，不擅自改动 p1。
SCENARIOS = [("p50", 258.4), ("p80", 313.2), ("p90", 338.8), ("p95", 354.1)]

# 阈值的适用口径与历时。改这两个值等于改产品的定义，必须同步全部材料。
THRESHOLD_BASIS = "station"
THRESHOLD_HOURS = 72.0

# 非适用口径的**参照比值**（仅用于提示量级，不是换算系数）。
# 实测单场（IN-FA）：站插 259.1 / ERA5 五点均值 189.9 = 1.36。
# 样本量 1，不可外推——所以这里只报比值，不自动换算。
BASIS_NOTE = {
    "station": "阈值适用口径",
    "era5": "ERA5 网格点或网格均值。实测单场约为站插口径的 0.73 倍"
            "（189.9/259.1），样本 1，不可外推；直接套用会系统性低估",
    "param": "台风路径参数化口径（p33 用）。实测单场约为站插的 0.78 倍"
             "（202.5/259.1）；p33 已声明不可与分位混用",
    "forecast": "集合或确定性预报的格点值。与 era5 同类，约 0.73 倍；"
                "且未含预报不确定性",
}

# 低于 p50 的档（mm < 258.4）。**"常态"只能落在这里**：
# p50 等于既有基线事件（烟花 259.1 mm）本身，而那场雨实际造成了断供、
# 封道与 17.5 ha 红格。把 p50 的动作写成"常态/0 处"是原实现的错误——
# 等于说"我们建这套产品的那个事件不需要任何动作"。
NORMAL_ACTION = ("常态", "按常规汛期巡查执行；优先点位每 12 h 一次",
                 "常规值守", "0 处")

ACTIONS = {
    # p50 = 基线事件档（≈烟花 259.1 mm）。这是"已发生的致灾事件"，
    # 不是"常态"：需要加强值守与下穿立交盯守，但尚未到预案启动线。
    "p50": ("加强（基线事件档）",
            "优先点位每 6 h 一次；下穿立交/桥洞派专人盯守",
            "1 组（2 人）加强班", "6 处"),
    # p80 = 基线以上一档：布点到位但不宣布响应，作启动前的最后准备。
    "p80": ("三级响应前置", "优先点位每 3 h 一次；12 处布点全部到位待命",
            "2 组（4 人）+ 排涝车 1 台在位", "12 处"),
    "p90": ("三级响应（预案启动线）", "优先点位每 2 h 一次；全部下穿立交预置警示与绕行牌",
            "2 组（4 人）+ 排涝车 1 台待命", "12 处（模型建议布点数）"),
    "p95": ("三级响应加强", "优先点位连续盯守；低洼小区逐栋走访提示",
            "3 组（6 人）+ 排涝车 2 台待命", "12 处 + 低洼小区 7 处走访"),
}


def match(mm: float, *, basis: str = THRESHOLD_BASIS,
          hours: float = THRESHOLD_HOURS) -> dict:
    """把面雨量落到情景档。低于 p50 也给出该档，并注明低于最低档。

    `basis` / `hours` 不是可选的装饰：阈值只对 (station, 72 h) 成立，
    偏离时会返回 `告警` 列表，调用方必须把它带到输出里。
    """
    level = SCENARIOS[0][0]
    for name, thr in SCENARIOS:
        if mm >= thr:
            level = name
    below = mm < SCENARIOS[0][1]
    # 低于 p50 时不用 p50 的动作——p50 是基线**致灾**事件，
    # 它的动作不是"常态"。常态属于 p50 以下这一段。
    lvl, action, crew, sites = (NORMAL_ACTION if below else ACTIONS[level])

    warns: list[str] = []
    basis = (basis or THRESHOLD_BASIS).strip().lower()
    if basis not in BASIS_NOTE:
        warns.append(f"未知口径 {basis!r}，按非适用口径处理")
    if basis != THRESHOLD_BASIS:
        notes = BASIS_NOTE.get(basis, "该口径与阈值不同源")
        warns.append(
            f"口径不符：阈值的适用口径是 {THRESHOLD_BASIS}，输入为 {basis}。"
            f"{notes}。本次结论按原始数值给出，未做换算，可能系统性低估。")
    if abs(float(hours) - THRESHOLD_HOURS) > 1e-9:
        warns.append(
            f"历时不符：阈值是 {THRESHOLD_HOURS:.0f} h 累计，输入为 {hours:.0f} h。"
            "不同历时的累计量不可直接比较。")

    return {
        "面雨量_mm": round(float(mm), 1),
        "历时_h": float(hours),
        "输入口径": basis,
        "阈值适用口径": THRESHOLD_BASIS,
        "阈值适用历时_h": THRESHOLD_HOURS,
        "口径": ("面雨量分位仅对『148 站插值 + 标定』口径、72 h 历时成立；"
                 "ERA5 网格点、单点值、p33 参数化值不可直接套用。"
                 "详见 docs/rainfall-basis-gap.md。"),
        "情景档": level,
        "响应等级": lvl,
        "动作要求": action,
        "人员与装备": crew,
        "布点": sites,
        "低于最低档": below,
        "分位参照": [{"档": k, "面雨量_mm": v} for k, v in SCENARIOS],
        # 本接口的能力边界，随结果一起返回，不靠文档提醒
        "能回答": ["该量级落在哪一档", "应启动什么等级", "该配多少人、多少装备、多少布点"],
        "不能回答": [
            "**什么时候**越阈——越阈时刻对雨型极敏感（实测跨度 350.5%），"
            "本接口只收总量，答不了",
            "**某个具体点位**会淹多深——点尺度命中率 0%（17 点实测）",
            "**本次输入的雨是否真会发生**——本接口不预报，只做给定量的查表",
        ],
        "告警": warns,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="typhoeus.scenario", description="情景档匹配与响应等级建议")
    ap.add_argument("mm", nargs="?", type=float,
                    help="面雨量累计量（mm）；口径与历时用 --basis / --hours 声明")
    ap.add_argument("--basis", default=THRESHOLD_BASIS,
                    choices=sorted(BASIS_NOTE),
                    help=f"输入雨量的口径（阈值适用 {THRESHOLD_BASIS}）")
    ap.add_argument("--hours", type=float, default=THRESHOLD_HOURS,
                    help=f"累计历时（h）；阈值适用 {THRESHOLD_HOURS:.0f} h")
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

    r = match(mm, basis=a.basis, hours=a.hours)
    if a.json:
        print(json.dumps(r, ensure_ascii=False, indent=2))
        return 0

    print(f"输入              : {r['面雨量_mm']} mm / {r['历时_h']:.0f} h"
          f"（口径 {r['输入口径']}）")
    print(f"落档              : {r['情景档']}")
    print(f"响应等级          : {r['响应等级']}")
    print(f"动作要求          : {r['动作要求']}")
    print(f"人员与装备        : {r['人员与装备']}")
    print(f"布点              : {r['布点']}")
    if r["低于最低档"]:
        print("注：低于 p50 档，按最低档（常态）执行。")
    print("分位参照          : " + " · ".join(f"{k} {v:.1f} mm" for k, v in SCENARIOS))
    # 口径声明必须在最后仍然可见：用户拿 ERA5 网格值或单点值来填，
    # 结论会系统性偏低（实测 190 mm 判「常态/0 处布点」，实际需三级响应）。
    print(f"口径              : {r['口径']}")
    for w in r["告警"]:
        print(f"[告警] {w}")
    # 能力边界随结果一起打印，不靠读者去翻文档
    print("能回答            : " + "；".join(r["能回答"]))
    print("不能回答          : " + "；".join(x.split("——")[0]
                                            for x in r["不能回答"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
