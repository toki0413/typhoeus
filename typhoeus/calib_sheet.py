"""提比翁 —— 第七份产物：多事件标定单。

前六份产物全部基于**单场**事件：预置方案单、恢复排序单、事件对账单、
韧性价目表、体检指标包、标准体检报告。单场能回答"这次为什么涝"，
回答不了"这个改造能扛住几年一遇"。后者才是规划修编、改造立项、
保险核损三类业务的付款理由。

这份产物的定位因此与其他六份不同：它不是单场计算的附属说明，而是
**跨场次的标定结论**，两条结论一成一败：

**成立：强度—损失关系。** 实测斜率 2.109，即面雨量翻一倍功能
损失增 4.3 倍。14 个致涝场次、R² 0.883、单调性零违背、16 场残差全部闭合。
内涝损失的超线性在这里有实测支撑，可以进韧性价目表。
（注：此前写的是斜率 2.4155 / 5.3 倍，属上一轮标定的旧值；
以产物 `out/07_multievent_calibration.json` 的 2.109 / 4.3 倍为准。）

**不成立：重现期关系。** 13 场致涝场次的 MLE 给出 ξ = 5.93。合成
实验表明 ξ 在超阈值点为 7 个时只有 16% 的机会落回 ±0.5 的合理范围，
要到 79% 需 30 个点。经验频率法的实测分位非单调（T3 = T5 = 202.5 mm
而 T10 = 73.5 mm），说明这批样本里不存在稳定的重现期次序。

这份产物必须同时呈现两条结论。只写成功的那条，读者会以为重现期
已标定；只写失败的那条，读者会以为多事件序列没跑通。

## 为什么不是第七个门槛而是第七份产物

门槛 25–27 已经把这三条写成可执行判据（G25 样本量、G26强度—损失、
G27 重现期）。这份产物承载的是它们的**业务含义**：斜率 2.109 该
怎么用于改造立项论证、重现期标不出来时价目表的价格锚该怎么表述。

判据在门槛里，含义在这份单子里。两件事分开是为了让体检指标包
保持纯判据形态——它现在有 27 条，不能再往里塞说明性文本。
"""
from __future__ import annotations

import json
from pathlib import Path

from .version import SCHEMA_VERSION


def _load(outdir) -> dict:
    p = Path(outdir) / "multievent_calibration.json"
    if not p.exists():
        return {}
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def multievent_sheet(outdir) -> dict:
    """从 `multievent_calibration.json` 编译人读版标定单。

    这是唯一从**别的产物**编译出来的产物：前六份都从 ctx 单场计算，
    这份从批量标定结果读。因此它的口径由 `multievent` 模块保证，
    这里不做二次计算，只做呈现与口径固化。
    """
    rep = _load(outdir)
    if not rep:
        return {
            "名称": "多事件标定单",
            "状态": "未运行",
            "说明": ("多事件批量标定未运行。执行 "
                     "`python -m typhoeus.cli multievent` 后重新导出本单。"
                     "单场产物不依赖这份单子，缺它不影响前六份。"),
            "schema_version": SCHEMA_VERSION,
        }

    il = rep.get("intensity_loss") or {}
    fit = rep.get("return_period_fit") or {}
    emp = rep.get("empirical_levels") or {}
    mono = rep.get("monotonicity") or {}
    clo = rep.get("closure") or {}
    evs = rep.get("events") or []
    ok_evs = [e for e in evs if "Q_total" in e]

    return {
        "名称": "多事件标定单",
        "口径": ("18 场宁波周边 ≥8 级历史气旋（1990–2025），"
                 "同一套内核参数与投影参数批量实算，"
                 "Q 分解与事件对账单走同一个函数，逐位可比"),
        # 雨量口径段。R3 护栏要求任何出现雨量数字的产物都带口径段。
        # 这份单子的雨量全部来自**参数化合成场**（每场一次
        # kernel.rainfall_field），既非 ERA5 实算也非实测。主链那套
        # 「域内 vs 全市」双口径对它不适用——两个口径共享同一个驱动，
        # 摆在一起只是同一个数。填 no_second_basis 明写这个事实，
        # 而不是硬塞一个不存在的对照。
        "降雨口径": {
            "驱动": "参数化合成场（kernel.rainfall_field，18 场同一套参数）",
            "no_second_basis": (
                "本批 18 场全部由参数化合成场驱动。主链的域内站订正"
                "与官方全市面雨量这两个口径都建立在 ERA5 实算之上，"
                "对参数化场不适用——同一驱动下摆两个口径等于把同一个"
                "数报两遍。因此本单只给单一口径，并标明其偏差方向。"),
            "what_is_missing": (
                "18 场各拉一次 ERA5 再分析作为第二口径。届时参数化场"
                "与再分析之差即为该批样本的系统偏差，可整体平移曲线。"
                "本轮未做：批量标定的目的是拿标度关系，参数偏差是共模的，"
                "在标度关系里部分约掉。"),
            "偏差方向": ("参数化场未含地形抬升，量级偏保守："
                         "烟花实测 283 mm、该场参数化实算 202.5 mm，"
                         "低 28.5%"),
            "不可用于": ("任何绝对量级结论。仅可用于场次之间的相对比较"
                         "与标度关系（强度—损失、重现期次序）。"),
        },
        "样本": {
            "目录场次": rep.get("n_events_catalog"),
            "实算成功": rep.get("n_events_ok"),
            "跳过": rep.get("n_events_skipped"),
            "致涝场次": rep.get("n_flood_events"),
            "年份跨度": f"{rep.get('year_span')}（{rep.get('year_count')} 年）",
            "年均致涝事件率": f"{rep.get('lambda_per_year')} 场/年",
            "面雨量范围_mm": rep.get("rain_range_mm"),
            "功能损失范围_Q": rep.get("q_range"),
            "未致涝场次": rep.get("no_flood_events"),
            "跳过原因": rep.get("skipped"),
        },
        # ---------- 结论一：强度—损失关系成立 ----------
        "强度—损失关系": {
            "状态": "已标定" if il.get("ok") else "未标定",
            "关系式": il.get("form"),
            "斜率": il.get("log_log_slope"),
            "截距": il.get("intercept"),
            "R²": il.get("r2"),
            "有效场次": il.get("n"),
            "单调性违背处数": mono.get("n_violations"),
            "残差闭合": (f"{clo.get('n_closed')}/{clo.get('n_total')} 场，"
                        f"最大占比 {clo.get('max_resid_share_pct')}%"
                        f"（门槛 8 容差 20%）"),
            "斜率含义": ("面雨量翻一倍，功能损失增 "
                        f"{2 ** il.get('log_log_slope', 0):.1f} 倍。"
                        "内涝损失的超线性在这里有实测支撑，"
                        "不是假设。这个系数是改造收益论证的核心："
                        "它给出每增加 10 mm 面雨量对应的功能损失增量，"
                        "再配合韧性价目表的单位投入即可算出改造阈值。"),
            "用途": "可进韧性价目表，作为改造收益侧的分母",
        },
        # ---------- 结论二：重现期关系不成立 ----------
        "重现期关系": {
            "状态": ("不可标定" if not fit.get("ok") else "已标定"),
            "不可用原因": fit.get("reason"),
            "已尝试的估计量": fit.get("gpd_attempt"),
            "样本量需求": fit.get("sample_size_requirement"),
            "经验频率口径": {
                "说明": ("不外推，只报样本内实测值。"
                         "覆盖上限约 "
                         f"{emp.get('coverage_limit_years')} 年一遇。"),
                "分位": emp.get("levels"),
                "分位单调": emp.get("monotonic"),
                "单调性判读": emp.get("caveat"),
            },
            "业务影响": ("无法回答'这个改造能扛住几年一遇'。"
                         "规划修编与改造立项的付款理由建立在这个数上，"
                         "目前只能以历史场次的实测区间替代，"
                         "并在合同中明确'不含设计标准核算'。"
                         "恢复排序单与事件对账单不依赖重现期，"
                         "「这次为什么涝、这次怎么恢复」两项业务不受影响。"),
            "解锁条件": ("超阈值点从 7 个提到 30 个以上。两条路："
                         "① 接入 ERA5 再分析的历史场次，把致涝样本从 14 "
                         "扩到 30 以上；"
                         "② 把时窗从 72 h 延到覆盖台风全过程，"
                         "救回 HAIKUI 这类最近时刻落在窗外的场次。"
                         "前者更直接，后者顺带修掉一个已知的口径缺陷。"),
        },
        # ---------- 场次明细 ----------
        "场次明细": [
            {
                "年": e.get("年"), "台风": e.get("台风"),
                "72h面雨量_mm": e.get("72h面雨量_mm"),
                "峰值雨强_mm_h": e.get("峰值雨强_mm_h"),
                "峰值水深_m": e.get("峰值水深_m"),
                "Q_total": e.get("Q_total"),
                "残差占比_pct": e.get("残差占比_pct"),
                "状态": "未致涝" if (e.get("Q_total") or 0) <= 0 else "致涝",
            }
            for e in sorted(ok_evs,
                            key=lambda x: x.get("72h面雨量_mm") or 0)
        ],
        # ---------- CC 单独成段 ----------
        "CC标度": rep.get("cc_status"),
        "口径与偏差": rep.get("caveats"),
        "声明": ("强度—损失关系可用于改造收益论证；"
                 "重现期关系不可用于任何设计标准核算或定价。"
                 "两者不可混用。"),
        "schema_version": SCHEMA_VERSION,
    }


if __name__ == "__main__":
    import sys
    d = sys.argv[1] if len(sys.argv) > 1 else "out"
    print(json.dumps(multievent_sheet(d), ensure_ascii=False, indent=1))
