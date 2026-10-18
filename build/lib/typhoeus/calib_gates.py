"""提比翁 —— 多事件标定的三条门槛（G25–G27）。

前24 条门槛量的是单场事件：能不能算准一场、算完能不能对外交付。
这三条量的是**跨场次**：同样的关系在 18 场历史上是否成立。

## 为什么这三条是商业化的必要条件

单场能算出"这次为什么涝"，算不出"这个改造能扛住几年一遇"。
后者才是规划修编、改造立项、保险核损三类业务的付款理由。价目表
目前的价格锚是"每减少 1% 损失的投入"，这个说法无法回答"投多少才
值得"——业主的决策语言是重现期。

## 三条判据各自防的是什么

**G25 事件数≥ 15。** 门槛 9 要求≥15 场。样本少于这个数，极值统计
的自由度不够，GPD 参数的置信区间会宽到覆盖不出有业务含义的区间。
这条不是形式要求：14 场与 18 场在重现期外推上的差别是可观的。

**G26 强度—损失关系单调且斜率为正。** 雨量涨而损失不涨，这条关系
不可用于任何改造收益论证。这条必须在标定现场测——样本十几个的时候
相关系数高不代表方向对，反向也能显著。

**G27 重现期分位单调递增且落在样本区间合理位置。** GPD 外推最容易
出的错是**非单调**：某些参数组合下 50 年一遇的雨量低于 20 年一遇。
这种错误在图上是一条上翘的曲线，不查单调性就看不出。

## 判据为什么不写成"越高越好"

这三条的判据都定在**结构条件**上（数量够、方向对、次序不乱），
不设在拟合优度的阈值上。原因：样本18 个时 R² 的抽样波动本身就有
±0.2 量级，把 R² ≥ 0.8 写成验收线，实际通过的判据是"这批数据的
随机划分方式"，而不是"这个关系成立"。结构条件不受样本量影响，
所以能当判据用。

强度—损失关系的 R² 与斜率照常输出，但在门槛里只作为参考量呈现。
"""
from __future__ import annotations

import json
from pathlib import Path

MIN_EVENTS = 15


def _load(outdir) -> dict:
    p = Path(outdir) / "multievent_calibration.json"
    if not p.exists():
        return {}
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def _g(gid, content, value, threshold, status, note=""):
    return {"id": gid, "content": content, "value": value,
            "threshold": threshold, "status": status, "note": note,
            "stage": "rescue", "cover": "economy"}


def measure_g25(rep: dict) -> dict:
    """事件数与年份跨度。"""
    n_ok = int(rep.get("n_events_ok", 0))
    span = rep.get("year_count") or 0
    lam = rep.get("lambda_per_year")
    if n_ok == 0:
        return _g(25, "多事件样本量", "0 场", f"≥{MIN_EVENTS} 场", "BLOCKED",
                  "无有效场次。批量标定未运行或全部场次失败。")
    status = "PASS" if n_ok >= MIN_EVENTS else "FAIL"
    note = (f"目录 {rep.get('n_events_catalog')} 场，实算成功 {n_ok} 场，"
            f"失败 {rep.get('n_events_skipped')} 场。"
            f"跨 {span} 年（{rep.get('year_span')}），"
            f"年均事件率 {lam} 场/年。")
    if rep.get("skipped"):
        for s in rep["skipped"]:
            note += f" [{s['年']} {s['台风']}] {s['原因']}"
    return _g(25, "多事件样本量", f"{n_ok} 场", f"≥{MIN_EVENTS} 场", status, note)


def measure_g26(rep: dict) -> dict:
    """强度—损失关系：斜率为正 + 单调无违背。"""
    il = rep.get("intensity_loss") or {}
    mono = rep.get("monotonicity") or {}
    if not il:
        return _g(26, "强度—损失关系", "未拟合", "斜率 > 0 且单调", "BLOCKED",
                  "强度—损失关系未拟合。")
    if not il.get("ok") and "log_log_slope" not in il:
        return _g(26, "强度—损失关系", "拟合失败", "斜率 > 0 且单调", "FAIL",
                  il.get("reason", "有效场次不足"))
    slope = il.get("log_log_slope", 0.0)
    n_viol = int(mono.get("n_violations", 0))
    slope_ok = bool(il.get("slope_positive"))
    mono_ok = bool(mono.get("passed"))
    status = "PASS" if (slope_ok and mono_ok) else "FAIL"
    note = (f"{il.get('form', '')}，斜率 {slope}，"
            f"截距 {il.get('intercept')}，R² {il.get('r2')}"
            f"（n={il.get('n')}）。")
    if not slope_ok:
        note += " 斜率为负，雨量增大时功能损失下降，与承灾机理相反。"
    if not mono_ok:
        note += f" 单调性违背 {n_viol} 处："
        for v in mono.get("violations", [])[:3]:
            note += (f"[{v['年']} {v['台风']}] {v['雨量_mm']} mm→Q {v['Q']}"
                     f"（相对降幅 {v.get('相对降幅_pct', '?')}%）；")
        note += mono.get("容差依据", "")
    note += (" R² 仅作参考：样本量十几个时其抽样波动达±0.2 量级，"
             "不作为验收判据。")
    return _g(26, "强度—损失关系",
              f"斜率 {slope} / 单调违背 {n_viol} 处",
              "斜率 > 0 且单调", status, note)


def measure_g27(rep: dict) -> dict:
    """重现期关系：极值外推不可用时判FAIL，并给经验频率口径。

    先看极值拟合可不可用。GPD 参数越界时（ξ 远超0.5、β ≤ 0、超阈值
    点太少），这条判 FAIL——不是"外推区间宽"，是"参数没估出来"。
    实测 13 场致涝样本下 MLE 给出 ξ = 6.34。

    拟合不可用不代表这一节无内容：经验频率法仍能报样本内的实测值。
    但它**不外推**，且实测分位非单调（T3 与 T5 同为 202.5 mm，
    T10 反而 73.5 mm），更长的重现期对应更小的雨量。这条非单调性
    本身就是「重现期概念在本样本上不成立」的直接证据，须写进note。
    """
    fit = rep.get("return_period_fit") or {}
    lv = rep.get("return_period_levels") or {}
    emp = rep.get("empirical_levels") or {}
    if not fit or not lv:
        return _g(27, "重现期关系", "未拟合", "分位单调递增", "BLOCKED",
                  "重现期关系未拟合。")
    if not fit.get("ok"):
        note = str(fit.get("reason", "GPD 参数不可辨识")).rstrip("。")
        if emp:
            note += f"。 经验频率口径：{emp.get('caveat', '')}"
        else:
            note += "。 无经验频率口径数据。"
        return _g(27, "重现期关系", "极值外推不可用", "分位单调递增",
                  "FAIL", note)
    levels = lv.get("levels") or {}
    pairs = []
    for T in (5, 10, 20, 50, 100):
        v = levels.get(f"T{T}", {}).get("面雨量_mm")
        if isinstance(v, (int, float)):
            pairs.append((T, float(v)))
    if len(pairs) < 2:
        return _g(27, "重现期关系", f"仅 {len(pairs)} 个有效分位",
                  "分位单调递增", "FAIL",
                  f"阈值 {fit.get('threshold_mm')} mm，"
                  f"超阈值样本 {fit.get('n_exceed')} 个，"
                  f"有效分位数不足。")
    mono = all(b[1] > a[1] for a, b in zip(pairs, pairs[1:]))
    mx = fit.get("max_mm")
    t_max = max(pairs, key=lambda p: p[1])
    over = bool(mx is not None and t_max[1] > float(mx))
    status = "PASS" if (mono and over) else "FAIL"
    note = (f"GPD ξ={fit.get('shape_xi')} β={fit.get('scale_beta')}，"
            f"阈值 {fit.get('threshold_mm')} mm（{fit.get('threshold_rule')}），"
            f"超阈值 {fit.get('n_exceed')}/{fit.get('n_total')} 场，"
            f"样本均值 {fit.get('mean_mm')} mm、最大 {mx} mm、"
            f"变异系数 {fit.get('sample_cv')}。"
            f"年均事件率 {lv.get('lambda_per_year')} 场/年。"
            f"分位：" + "、".join(f"T{T}={v:.0f} mm" for T, v in pairs) + "。")
    if not mono:
        note += " 分位非单调递增，GPD 外推无效。"
    if not over:
        note += (f" 最远分位 {t_max[1]:.0f} mm 未超过样本最大值 {mx} mm，"
                 f"外推未进入尾部区，结果不可用于超标准设计核算。")
    return _g(27, "重现期关系",
              f"{len(pairs)} 分位 " + "、".join(f"{v:.0f}" for _, v in pairs),
              "分位单调递增且超出样本最大值", status, note)


def run_all(outdir) -> list[dict]:
    """跑 G25–G27。缺产物时三条全报 BLOCKED，而不是 PASS。"""
    rep = _load(outdir)
    if not rep:
        meta = ((25, "多事件样本量", f"≥{MIN_EVENTS} 场"),
                (26, "强度—损失关系", "斜率 > 0 且单调"),
                (27, "重现期关系", "分位单调递增"))
        return [_g(i, t, "无产物", th, "BLOCKED",
                   "未找到 multievent_calibration.json，"
                   "多事件批量标定未运行。")
                for i, t, th in meta]
    return [measure_g25(rep), measure_g26(rep), measure_g27(rep)]


if __name__ == "__main__":
    import sys
    d = sys.argv[1] if len(sys.argv) > 1 else "out"
    for x in run_all(d):
        print(f"[{x['id']:2d}] {x['status']:8s} {x['content']}: {x['value']}"
              f"（判据 {x['threshold']}）")
        if x["note"]:
            print(f"      {x['note']}")
