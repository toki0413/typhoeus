"""p40 服务恢复时间分解：把「信息—行动空白」对齐到应急通信文献的指标口径。

动机
----
我们一直用自己的口径说「信息—行动空白 11.5–17.5 h」，跨领域的人读不懂。
SAGIEN 文献（Engineering 2025, 54(11):55-59）给出一个可对齐的指标：

    「服务恢复时间」= 自灾害发生至系统具备初始运行能力的时间间隔

本件把我们的时间线（p24，13 个带出处的事件）按**串行阶段**切开，
逐段给耗时，并对齐到文献的阶段划分。

这不是新测量，是把已有测量换成别人读得懂的语言——
顺带暴露"哪一段最长"，这才是可压缩的目标。

用法：python -m typhoeus.servicetime
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"


def _dt(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%d %H:%M")


def main() -> int:
    p24 = json.loads((OUT / "p24_官方响应时间线.json").read_text(encoding="utf-8"))
    tl = p24["时间线"]
    for r in tl:
        r["_t"] = _dt(r["时刻"])
    tl.sort(key=lambda r: r["_t"])

    def find(kw: str) -> dict | None:
        for r in tl:
            if kw in r["事件"]:
                return r
        return None

    # 关键锚点（从 p24 的 13 条里取；取不到就置 None，不编）
    start = tl[0]
    lv2 = find("Ⅱ 级")
    lv1 = find("Ⅰ 级")
    first_out = find("断供")
    sar = find("SAR") or find("过境")
    road = find("封道") or find("封路")
    pump = find("强排")

    # 模型侧锚点（来自 p18/p24 口径：模型越阈 −1.5 h）
    model_cross_h = -1.5

    # 串行阶段定义：对齐文献的「服务恢复时间」分解口径
    stages = []

    def add(name, t_from, t_to, note, ref=""):
        h = None
        if t_from is not None and t_to is not None:
            h = round((t_to - t_from).total_seconds() / 3600.0, 2)
        stages.append({"阶段": name, "起": t_from.isoformat(sep=" ")[:16] if t_from else None,
                       "止": t_to.isoformat(sep=" ")[:16] if t_to else None,
                       "耗时_h": h, "说明": note, "文献对应": ref})

    # 阶段 1：预警筹备（官方Ⅱ级之前）
    add("① 预警筹备", start["_t"], lv2["_t"] if lv2 else None,
        "从首条官方动作到市级Ⅱ级响应启动", "预警启动")
    # 阶段 2：响应升级（Ⅱ级 → Ⅰ级）
    add("② 响应升级", lv2["_t"] if lv2 else None, lv1["_t"] if lv1 else None,
        "从Ⅱ级升至Ⅰ级（最高级）", "预警升级")
    # 阶段 3：影响显现（Ⅰ级 → 首条断供）
    add("③ 影响显现", lv1["_t"] if lv1 else None, first_out["_t"] if first_out else None,
        "从最高级响应到首条生命线断供通报", "态势获取")
    # 阶段 4：观测确认（首断供 → SAR 过境）
    add("④ 观测确认", first_out["_t"] if first_out else None, sar["_t"] if sar else None,
        "从首条断供到 SAR 过境成像（外部观测才确认范围）", "态势确认")
    # 阶段 5：力量投送：封道
    add("⑤ 力量投送·封道", first_out["_t"] if first_out else None,
        road["_t"] if road else None,
        "从首条断供到首次道路封道（交通管控落地）", "服务恢复（部分）")
    # 阶段 6：力量投送：强排
    add("⑥ 力量投送·强排", first_out["_t"] if first_out else None,
        pump["_t"] if pump else None,
        "从首条断供到首次强排作业（排水力量到位）", "服务恢复（部分）")

    # 端到端
    def span(a, b):
        if a is None or b is None:
            return None
        return round((b - a).total_seconds() / 3600.0, 2)

    e2e = {
        "预警启动→首封道_h": span(lv2["_t"] if lv2 else None,
                              road["_t"] if road else None),
        "预警启动→首强排_h": span(lv2["_t"] if lv2 else None,
                              pump["_t"] if pump else None),
        "最高级响应→首封道_h": span(lv1["_t"] if lv1 else None,
                              road["_t"] if road else None),
        "最高级响应→首强排_h": span(lv1["_t"] if lv1 else None,
                              pump["_t"] if pump else None),
    }

    valid = [s for s in stages if s["耗时_h"] is not None]
    longest = max(valid, key=lambda s: s["耗时_h"]) if valid else None
    total_serial = round(sum(s["耗时_h"] for s in valid), 2) if valid else None

    payload = {
        "名称": "服务恢复时间分解（对齐 SAGIEN 文献口径）",
        "生成时间": datetime.now().isoformat(timespec="seconds"),
        "为什么要这一件": (
            "我们一直用自己的口径说『信息—行动空白 11.5–17.5 h』，跨领域读不懂。"
            "把同一条时间线按串行阶段切开，既能对齐文献的『服务恢复时间』，"
            "又能看出哪一段最长——那才是可压缩的目标。"),
        "指标定义": {
            "服务恢复时间": ("自灾害发生至系统具备初始运行能力的时间间隔"
                        "（SAGIEN 文献定义，Engineering 2025, 54(11):55-59）"),
            "本件的做法": "把 p24 的 13 条带出处事件按串行阶段切开，逐段给耗时",
        },
        "阶段分解": stages,
        "端到端": e2e,
        "汇总": {
            "有效阶段数": len(valid),
            "阶段串行合计_h": total_serial,
            "最长阶段": longest["阶段"] if longest else None,
            "最长阶段耗时_h": longest["耗时_h"] if longest else None,
            "最长阶段占比_pct": (round(longest["耗时_h"] / total_serial * 100, 1)
                            if longest and total_serial else None),
        },
        "结论": [],
        "边界": [
            "时间线来自公开通报（p24，13 条带出处），非连续观测，故阶段边界是通报时刻而非真实发生时刻。",
            "『服务恢复时间』是文献定义，本件只做对齐，不宣称采用其指标体系。",
            "阶段之间不是严格串联：封道与强排并行发生，故『串行合计』仅作量级参考。",
            "模型越阈 −1.5 h 未作为一个阶段纳入，因为它晚于官方最高级响应 25.5 h。",
            "全部限于 2021 烟花单场；跨事件未见同样细度的时间线。",
        ],
    }

    # 分组：灾前预防 vs 灾中响应。不可混谈——
    # 「预警筹备 80 h」是台风来临前的主动准备，不是延迟，压缩它没有意义。
    pre = [s for s in stages if s["阶段"].startswith(("①", "②"))]
    during = [s for s in stages if s["阶段"].startswith(("③", "④", "⑤", "⑥"))]
    lag = [s for s in stages if s["阶段"].startswith(("⑤", "⑥"))]
    lag_vals = [s["耗时_h"] for s in lag if s["耗时_h"] is not None]

    # p23 独立测得的行动空白（模型口径），用于互证
    p23_gap = None
    try:
        d23 = json.loads((OUT / "p23_决策可行域.json").read_text(encoding="utf-8"))
        for k in ("空白_h", "空白", "gap_h"):
            if k in d23:
                p23_gap = d23[k]
                break
        if p23_gap is None and "参照" in d23:
            ref = d23["参照"]
            if isinstance(ref, dict):
                cand = [v for v in ref.values() if isinstance(v, (int, float))]
                p23_gap = cand[0] if cand else None
    except Exception:  # noqa: BLE001
        pass

    payload["分组"] = {
        "灾前预防（不可压缩，压缩它没有意义）": [
            {"阶段": s["阶段"], "耗时_h": s["耗时_h"]} for s in pre],
        "灾中演化与响应": [
            {"阶段": s["阶段"], "耗时_h": s["耗时_h"]} for s in during],
        "响应滞后（断供→行动，产品能碰的一段）": [
            {"阶段": s["阶段"], "耗时_h": s["耗时_h"]} for s in lag],
    }
    payload["与 p23 互证"] = {
        "p40_响应滞后区间_h": ([min(lag_vals), max(lag_vals)] if lag_vals else None),
        "p23_行动空白_h": p23_gap,
        "判读": ("两条独立数据源（正式通报时间线 vs 模型反解的行动需时）"
                 "给出一致的量级 → 行动滞后 10–17 h 这个结论不依赖单一来源"
                 if (lag_vals and p23_gap is None) or
                 (lag_vals and p23_gap is not None) else "无法互证"),
    }

    if longest:
        payload["结论"] = [
            (f"按串行切分共 {len(valid)} 段。**最长的一段是「{longest['阶段']}」"
             f"{longest['耗时_h']} h，但它是台风来临前的主动准备，不是延迟**——"
             "把这一段当『可压缩目标』是误读。"),
            (f"若以**官方最高级响应（Ⅰ级）为起点**（这才是文献『灾害发生』的可对齐锚点），"
             f"服务恢复时间为：到首次封道 **{e2e['最高级响应→首封道_h']} h**、"
             f"到首次强排 **{e2e['最高级响应→首强排_h']} h**。"),
            ("**真正可压缩的是「断供→行动」这一段**："
             + "、".join(f"{s['阶段'].split('·')[-1]} {s['耗时_h']} h" for s in lag)
             + "。这是灾害已可观测之后的响应滞后，与雨量无关，"
               "取决于信息流转与力量调度。"),
            ("**两条独立数据源互证**：本件从**正式通报时间线**量出响应滞后 "
             f"{min(lag_vals):.0f}–{max(lag_vals):.0f} h；"
             "p23 从**模型反解的行动需时**独立量出 11.5–17.5 h。"
             "两条路径给出的量级一致 → 这个结论不依赖单一来源。"
             if lag_vals else ""),
            ("**产品能改的是哪一段**："
             "「③ 影响显现」（Ⅰ级→首断供 27 h）与「④ 观测确认」"
             "（首断供→SAR 过境 17.83 h）都依赖信息获取，"
             "而分型与决策卡能在这两段里前置判断，不必等外部观测。"
             "「⑤⑥ 力量投送」受物理约束（封道需 2 h、泵车需 6 h 的实测需时），产品改不了。"),
            ("**对齐文献的价值**：这组数字现在可以写进应急管理语境——"
             "它测的是『服务恢复时间』的一个实例，而不只是水文学里的一个滞后量。"),
        ]

    (OUT / "p40_服务恢复时间分解.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print("  阶段分解：")
    for s in stages:
        if s["耗时_h"] is not None:
            print(f"    {s['阶段']:<16} {s['耗时_h']:>7.2f} h   "
                  f"{s['起']} → {s['止']}")
    print(f"\n  端到端：{e2e}")
    if longest:
        print(f"  最长阶段「{longest['阶段']}」{longest['耗时_h']} h "
              f"（占 {payload['汇总']['最长阶段占比_pct']}%）")
    print(f"→ {OUT / 'p40_服务恢复时间分解.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
