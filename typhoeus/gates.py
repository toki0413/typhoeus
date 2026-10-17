"""提比翁 Demo —— 门槛的可执行校验。

对应文档第八节。每条门槛三态：
  PASS     —— 实测达标
  FAIL     —— 实测不达标，且有明确的降级口径
  BLOCKED  —— 依赖外部数据，Demo 阶段无法验证（必须写明缺什么）

硬约束：BLOCKED 与 FAIL 必须分开。BLOCKED 是"没数据可验"，
        FAIL 是"验了但没过"。混为一谈会让体检报告失去决策价值。

两条轴（A1，借鉴浙大 REN 的 ReCOVER 体系构造方式）：
  stage —— 恢复过程四阶段 rescue/refuge/rebuild/revival
  cover —— 五个维度 community/official/housing/economy/environment
两轴只是归档维度，不引入新指标。**不借62 项指标**：那套以城市级统计与
问卷为主，本产品是街区级工程判据，塞进输出物会让报告变成填表。
归档的实际作用是暴露空白——economy 与 environment 两维目前全空，一眼可见。
"""
from __future__ import annotations

import numpy as np

from . import planner as P
from . import projection as PRJ
from . import reconcile as RC
from . import measure as M

# 恢复过程四阶段（ReCOVER 的 Re轴）
STAGES = ("rescue", "refuge", "rebuild", "revival")

# 五个维度（ReCOVER 的 COVER 轴）
DIMENSIONS = ("community", "official", "housing", "economy", "environment")


def _g(gid, content, value, threshold, status, note="",
       stage="rescue", cover="housing"):
    return {"id": gid, "content": content, "value": value,
            "threshold": threshold, "status": status, "note": note,
            "stage": stage, "cover": cover}


def coverage_matrix(gates: list[dict]) -> dict:
    """把门槛按四阶段 × 五维度展开成矩阵，用于体检报告。

    返回 {"matrix": {stage: {cover: [门槛摘要]}}, "empty_cells": [...]}。
    empty_cells 是没有任何门槛覆盖的格子，是这份矩阵真正要传达的东西。
    """
    mat: dict = {s: {c: [] for c in DIMENSIONS} for s in STAGES}
    for x in gates:
        s, c = x.get("stage", "rescue"), x.get("cover", "housing")
        if s in mat and c in mat[s]:
            mat[s][c].append({"id": x["id"], "content": x["content"],
                               "status": x["status"]})
    empty = [f"{s}/{c}" for s in STAGES for c in DIMENSIONS if not mat[s][c]]
    return {"matrix": mat, "empty_cells": empty,
            "n_gates": len(gates)}


def retrofit_projects() -> list[dict]:
    """读改造项目台账。门槛 10 依赖它做分组，但结果需要配对观测。"""
    import csv as _csv
    from . import observe as OB

    p = OB.SEED_DIR / "retrofit_projects.csv"
    if not p.exists():
        return []
    with open(p, encoding="utf-8-sig", newline="") as f:
        return list(_csv.DictReader(f))


def check_all(ctx) -> list[dict]:
    g: list[dict] = []
    k = ctx["kernel"]
    cfg = ctx["cfg"]

    # 门槛 1 锋面位置：实测涝点水深与模型水深档位对照
    fo = ctx.get("front") or {}
    if fo.get("n"):
        mae = fo["mean_abs_diff_m"]
        # 验收线是 1 个边长（54 m）的位移。公开台账只给积水深度、
        # 不给水锋面时刻，无法算位移，因此该门槛在坐标精度提升到
        # 米级之前不可能 PASS。这里报水深档位 MAE 作为等效量级指标，
        # 状态按位移口径判 BLOCKED，不拿 MAE 冒充位移。
        g.append(_g(1, "锋面位置",
                    f"水位 MAE {mae:.2f} m（{fo['n']} 点）",
                    f"≤1 边长({ctx['cell_m']:.0f} m)", "BLOCKED",
                    f"涝点台账坐标为地名定位近似（±100 m），"
                    f"且无水锋面时刻，两项都不满足位移判据的输入要求。"
                    f"最大偏差 {fo['max_abs_diff_m']:.2f} m。"
                    f"换米级实测坐标与逐时积水过程后可判定", stage="rescue", cover="housing"))
    else:
        g.append(_g(1, "锋面位置", "BLOCKED", "≤1 边长", "BLOCKED",
                    "无域内实测涝点"))

    # 门槛 2 涝点覆盖率
    cov = ctx.get("coverage_top20")
    c = ctx.get("coverage") or {}
    if cov is not None:
        missed = c.get("missed") or []
        by_type: dict[str, int] = {}
        for m in missed:
            k = m.get("structure_type", "未分类")
            by_type[k] = by_type.get(k, 0) + 1
        worst = sorted(by_type.items(), key=lambda kv: -kv[1])[:3]
        detail = "、".join(f"{k} {v} 处" for k, v in worst) or "无"
        under = sum(1 for m in missed if m.get("model_depth_m", 1.0) < 0.05)
        g.append(_g(2, "涝点覆盖率",
                    f"{cov*100:.1f}%（{c['n_hit']}/{c['n_total']}）", "≥70%",
                    "PASS" if cov >= 0.70 else "FAIL",
                    (f"落选点位按结构类型：{detail}。"
                     f"其中 {under} 处的模型水深低于 0.05 m，"
                     f"即模型在该点几乎没有积水。"
                     f"两个成因叠加：其一，降雨是台风路径参数化合成，"
                     f"雨区面状铺开，缺少下穿立交所依赖的局部汇流与管网顶托；"
                     f"其二，GLO-30 是 DSM，30 m 像元无法表达立交下穿凹陷，"
                     f"叠加 ±100 m 的地名字位误差后，采样像元可能落在"
                     f"路基而非桥下。两项都指向同一动作：接实测降雨与米级实测坐标后复算")
                    if cov < 0.70 else "实测涝点落在前 20% 高风险区内", stage="rescue", cover="community"))
    else:
        g.append(_g(2, "涝点覆盖率", "BLOCKED", "≥70%", "BLOCKED",
                    "无实测涝点台账"))

    # 门槛 3 影像反演
    mon = (ctx.get("observe") or {})
    g.append(_g(3, "影像反演", "BLOCKED", "相对误差 ≤30%", "BLOCKED",
                f"Sentinel-1 重访影像未接；"
                f"验证所需的现场水位抽查依赖 {mon.get('monitor_sites_spec', 149)} "
                f"个内涝监测点，坐标与实时水深非公开，"
                f"当前落盘的是 provenance=synthetic 的占位坐标"
                f"（{mon.get('monitor_sites', 0)} 个）", stage="rescue", cover="housing"))

    # 门槛 4 功能曲线
    no = mon.get("service_outages", 0)
    g.append(_g(4, "功能曲线", "BLOCKED", "归一化 MSE ≤25%", "BLOCKED",
                f"缺逐路段封路起止时刻与交通指数。"
                f"已落盘 {no} 条中断通报（电梯/配电/封道/强排/转移），"
                f"但只有总量型统计（594 台电梯一类），"
                f"无路段级时间序列，算不出归一化 MSE", stage="rescue", cover="housing"))

    # 门槛 5 结构死穴
    ds = ctx.get("cutoff_overlap")
    if ds is not None:
        g.append(_g(5, "结构死穴", f"前10重合率 {ds*100:.0f}%", "≥60%",
                    "PASS" if ds >= 0.60 else "FAIL",
                    "模型损失前 10% 像元与已报中断点的重合率", stage="rescue", cover="housing"))
    else:
        dso = ctx.get("dead_spot") or {}
        g.append(_g(5, "结构死穴", "BLOCKED", "≥60%", "BLOCKED",
                    dso.get("reason", "缺灾中实际中断点台账")))

    # 门槛 6 恢复排序
    # 判据从"对最优基线提升 ≥10%"改为"同时优于两条基线且提升 ≥10%"。
    # 原判据只与最优基线比，另一条基线明显更差时仍会 PASS，那是掩盖。
    c = ctx["order_cmp"]
    # 新字段用 .get 兜底：门槛函数的调用方可能传旧结构的order_cmp
    # （测试替身、外部脚本、归档输出）。缺 beats_both 时按旧判据只比
    # 最优基线，并在判词里标明未做双基线校验——不静默当成通过。
    beats_both = c.get("beats_both")
    gain_ok = c["gain_over_baseline"] >= 0.10
    passed6 = bool(gain_ok and beats_both) if beats_both is not None else gain_ok
    cap6 = "（受 72 h 事件窗封顶）" if c.get("horizon_capped_at_72h") else ""
    win6 = c.get("horizon_h")
    win_txt = f"，评分窗口 {win6:.0f} h{cap6}" if win6 is not None else ""
    if passed6 and beats_both:
        note6 = ("次模贪心优于随机与按度两个基线；" + win_txt +
                 "，不含自然恢复项。次模近似比未验证，不声明。"
                 "恢复单元为单像元 54 m，真实排班单元是走廊，"
                 "该口径使提升幅度偏乐观")
    elif passed6 and beats_both is None:
        note6 = ("仅校验了对最优基线的提升，未做双基线校验"
                 "（order_cmp 缺 beats_both 字段）")
    elif not gain_ok:
        note6 = f"提升幅度 {c['gain_over_baseline']*100:.1f}% 未达 10%"
    else:
        note6 = "未同时优于两条基线，恢复排序不可用于派工"
    g.append(_g(6, "恢复排序",
                f"提升 {c['gain_over_baseline']*100:.1f}%"
                + (f"（窗口 {win6:.0f} h，同时优于两基线"
                   f"{'是' if beats_both else '否'}）" if win6 is not None else ""),
                "≥10% 且同时优于随机与按度",
                "PASS" if passed6 else "FAIL", note6,
                stage="rebuild", cover="housing"))

    # 门槛 7 规划灵敏度
    a = ctx["adj"]
    g.append(_g(7, "规划灵敏度",
                f"相对误差中位数 {a['median_rel_err']:.2e}", "≤10%",
                "PASS" if a["passed"] else "FAIL",
                "通过" if a["passed"] else "超限，伴随层降级为展示层", stage="rebuild", cover="official"))

    # 门槛 8 对账分解
    r = ctx["recon"]
    g.append(_g(8, "对账分解", f"残差占比 {r.resid_share*100:.1f}%", "≤20%",
                "PASS" if r.closed else "FAIL", r.note, stage="rebuild", cover="official"))

    # 门槛 9 气候标度
    cc = ctx.get("cc_identifiable") or {}
    st_n = (ctx.get("observe") or {}).get("rain_stations", 0)
    # 事件数读多事件批量标定结果（若有）。多事件序列已跑通时，
    # 卡住 CC 的原因从"事件数不够"变成"变量共线"——这两者的
    # 解法完全不同，报告里必须分开写。样本量增加能收敛随机误差，
    # 不能消除共线。
    n_ev = (ctx.get("calib") or {}).get("n_events_ok") or cc.get("n_events", 1)
    blocked = not cc.get("identifiable")
    if blocked and n_ev >= 15:
        why = (f"事件数 {n_ev} 场（跨 "
               f"{(ctx.get('calib') or {}).get('year_count')} 年），"
               f"样本量已满足 ≥15场的要求，但 CC 仍标不出来——"
               f"CC 是气候变化下的标度率，标定它需要两个气候态的对比，"
               f"而这 {n_ev} 场全在1990–2025 同一气候态内"
               f"（背景变暖 0.3 K 量级），信号完全淹没在事件间差异里。"
               f"样本量增加能收敛随机误差，不能消除共线。"
               f"解锁需要至少两段气候态的对比：模式增温实验，"
               f"或含显著暖/冷异常子样本的更长序列，"
               f"且须控制雨区移动与抽排能力的差异。"
               f"当前 CC 取用户给定先验 7%/°C，"
               f"已输出 5–9%/°C 的敏感性范围。")
    else:
        why = (f"已有 {st_n} 个站点累计雨量锚点（实测通报），"
               f"事件数 {n_ev} 场。{cc.get('reason', '')}。")
    g.append(_g(9, "气候标度", "BLOCKED" if blocked else "可标定",
                "与 7%/°C 相容",
                "BLOCKED" if blocked else "PASS",
                why, stage="rebuild", cover="community"))

    # 门槛 10 改造收益
    rp = ctx.get("retrofit") or {}
    g.append(_g(10, "改造收益", "BLOCKED", "幅值误差 ≤40%", "BLOCKED",
                f"已落盘 {rp.get('n_projects', 0)} 个改造/运维项目的"
                f"金额与年份，但**改造前后积水观测完全缺失**。"
                f"自然实验需要配对的改造区与对照区水深序列，"
                f"依赖非公开的内涝监测点位数据。", stage="rebuild", cover="housing"))

    # 门槛 11 层级内核基线
    lvl = ctx.get("hier_gain")
    if lvl is not None:
        g.append(_g(11, "层级内核基线", f"技巧提升 {lvl*100:.2f}%", "≥5%",
                    "PASS" if lvl >= 0.05 else "FAIL",
                    "不达标则 V2 层级内核不进试点", stage="rebuild", cover="official"))
    else:
        g.append(_g(11, "层级内核基线", "BLOCKED", "≥5%", "BLOCKED",
                    "需潜空间模型，Demo 只有单尺度"))

    # 门槛 12 时效服务
    el = ctx["elapsed_s"]
    g.append(_g(12, "时效服务", f"{el:.1f} s", "≤600 s",
                "PASS" if el <= 600 else "FAIL", "单次全链耗时",
                stage="rescue", cover="official"))

    # 门槛 13 门控熔断
    gd = ctx["gate"]
    g.append(_g(13, "门控熔断", f"漂移降低 {gd.get('reduction',0)*100:.1f}%", "≥20%",
                "PASS" if gd.get("passed") else "FAIL",
                "", stage="rescue", cover="official"))

    # 门槛 14 涝点水深命中率（A3 新增）
    # 为什么不并入门槛 2：门槛 2 判的是"风险场前20% 区域里有多少实测涝点"，
    # 是空间排序能力；门槛 14 判的是"模型水深与实测差多少"，是定量精度。
    # 两者可以一个 PASS 一个 FAIL，合并会掩盖排序对而深度错的情况。
    # 口径：四色分级（0.1/0.2/0.5 m）同色级即算命中，分母是域内非合成点数。
    hit = ctx.get("depth_accuracy") or {}
    if hit.get("n"):
        acc = hit["rate"]
        drv14 = (ctx.get("rain_source") or {}).get("driver", "unknown")
        # 逐点实测：模型水深恰为 0 的点占多少。这些点不是"算得浅"，
        # 是内核在该格点上根本没积水，调任何源项参数都动不了它们。
        items14 = hit.get("items") or []
        n_zero = sum(1 for q in items14
                     if q.get("model_depth_m", 1.0) < 0.05)
        zero_share = f"{n_zero}/{len(items14)}" if items14 else "0/0"
        _inf = float(ctx.get("infil_mm") or 0.0)
        _rain = float(ctx.get("rain_total_mm") or 0.0)
        infil_share = (100.0 * _inf / _rain) if _rain > 0 else 0.0
        if drv14 in ("era5", "era5-cache"):
            rc14 = ctx.get("rain_check") or {}
            why14 = (f"降雨为 ERA5 再分析驱动（面雨量 "
                     f"{_rain:.0f} mm，官方全市口径 "
                     f"375 mm，偏差 "
                     f"{rc14.get('rel_err_allcity', 0)*100:+.0f}%）。"
                     f"峰值雨强下降是部分成因：参数化场峰值均值 16.43 mm/h，"
                     f"ERA5 仅 6.12 mm/h，面雨量更大而雨强更弱，"
                     f"管网与地面积水按强度失效。总量与极值方向相反——"
                     f"再分析能约束过程总量但不能约束对流尺度极值。"
                     f"但它不是主因：逐点实测 {zero_share} 个点的模型水深"
                     f"低于 0.05 m（恰好为零），内核在这些格点上没有积水。"
                     f"把入渗从地表水深驱动换成土壤饱和度驱动（Green-Ampt）"
                     f"只让这些点动0.001–0.020 m，因为入渗总量仅 "
                     f"{_inf:.1f} mm，占面雨量 {infil_share:.1f}%。"
                     f"主因是管网能力与地形分辨率：5 处下立交观测全为 "
                     f"0.50 m，恰等于设计水头缺口，而模型在顶托 0.05 m 下"
                     f"排不出水；GLO-30 30 m DSM 像元无法表达下穿凹陷。"
                     f"解锁需管网台账的顶托高程与过流能力，"
                     f"以及米级 DEM 与实测坐标。")
        else:
            why14 = (f"降雨为参数化合成驱动（面雨量 "
                     f"{_rain:.0f} mm，"
                     f"实测口径 375 mm），面雨量缺口是当前命中率低的主因。"
                     f"逐点实测 {zero_share} 个点的模型水深低于 0.05 m。")
        g.append(_g(14, "涝点水深命中率", f"{acc*100:.1f}%（MAE {hit['mae_m']:.2f} m）",
                    "≥50%", "PASS" if acc >= 0.50 else "FAIL",
                    f"分母为域内非合成涝点 {hit['n']} 个；"
                    f"逐点分级一致 {hit['n_same_level']} 个。"
                    f"最大偏差 {hit['max_abs_diff_m']:.2f} m。"
                    + why14
                    + f"按结构类型：{hit.get('by_type', '无')}。",
                    stage="rescue", cover="community"))
    else:
        g.append(_g(14, "涝点水深命中率", "BLOCKED", "≥50%", "BLOCKED",
                    "无域内实测涝点", stage="rescue", cover="community"))

    # 门槛 15 降雨总量相对误差（A3 新增）
    # 这条是输入层门槛。此前 13 条全是内部一致性或末端比对，
    # 没有任何一条检查输入本身，而所有输出物的准确性都继承输入的准确性。
    rain_cmp = ctx.get("rain_check") or {}
    rsrc = ctx.get("rain_source") or {}
    driver = rsrc.get("driver", "unknown")
    cal = rsrc.get("calibration") or {}
    n_in = rain_cmp.get("n_stations") or 0
    if n_in:
        rel_v = rain_cmp.get("rel_err_verdict", rain_cmp["rel_err"])
        ins = rain_cmp.get("in_sample")
        obs_v = (rain_cmp.get("allcity_mm", 0.0) if ins
                 else rain_cmp["obs_mm"])
        if ins:
            root15 = ("域内相对误差是**自样本**数字：降雨场已用这批站做过"
                      "分位数订正，再拿同一批站去比不构成独立检验。"
                      "判据改用官方全市面雨量（与订正锚点不同源）。")
        elif driver in ("era5", "era5-cache"):
            root15 = ("偏差来源为 ERA5 再分析在陆面与台站间的系统性低估，"
                      f"且域内仅 {n_in} 个实测站且集中于南部。"
                      + ("该源已用域内站做分位数订正。"
                         if cal.get("applied")
                         else "该源未做站点订正，域内口径为未订正原值。"))
        else:
            root15 = ("偏差根因是降雨场为台风路径参数化合成"
                      "（R_MAX/R_FLOOR/RAD_EXP/T_HALF 四个标定量）。")
        g.append(_g(15, "降雨总量相对误差",
                    f"判据口径 {rel_v*100:+.0f}%"
                    f"（{rain_cmp['model_mm']:.0f} vs {obs_v:.0f} mm）；"
                    f"域内口径 {rain_cmp['rel_err']*100:+.0f}%"
                    f"（{'自样本' if ins else '独立'}）；"
                    f"全市口径 {rain_cmp.get('rel_err_allcity', 0)*100:+.0f}%",
                    "≤15%", "PASS" if abs(rel_v) <= 0.15 else "FAIL",
                    f"降雨源 {driver}。判据口径：{rain_cmp.get('verdict_basis', '')}"
                    f"（域内判定用 {rain_cmp.get('domain_basis', '')}）。"
                    f"**采样偏倚**：{rain_cmp.get('sampling_bias', '')}"
                    f"官方全市面雨量 {rain_cmp.get('allcity_mm', 0):.0f} mm"
                    f"（余姚 475 mm 为暴雨中心）。{root15}",
                    stage="rescue", cover="community"))
    else:
        g.append(_g(15, "降雨总量相对误差", "BLOCKED", "≤15%", "BLOCKED",
                    "无实测雨量站锚点", stage="rescue", cover="community"))

    # 门槛 16–20：Agent 服务层行为。与前 15 条不同类——那 15 条查物理量
    # 与内部一致性，这五条查护栏有没有真的拦住。不并入是因为它们验的
    # 对象是代码路径而非计算结果，出问题时的处置方式也不同。
    #
    # 这五条量的是服务层对**落盘产物**的行为，而产物在本函数返回之后
    # 才写。所以这里只放位置，由 `cli.run` 在写盘后回填（见
    # `cli._attach_agent_gates`）。此处不放占位条目——占位会让读者
    # 把「尚未测量」误读成「已通过」。
    return g


# 宁波公开报道的积水点位（2021 台风烟花，2021-07-27 上午 9 时城区 67 处）
# 本 Demo 用作门槛 1/2/5 的参照点，坐标为公开报道中的地名定位近似
REFERENCE_POINTS = [
    ("鄞州大道-雅源南路", 29.818, 121.617, 0.68),   # 报道最深 0.68 m
    ("海曙新芝路", 29.872, 121.556, 0.64),         # 报道 0.64 m
    ("甬江大桥东江东北路下立交", 29.869, 121.559, 0.50),
    ("盛莫路1278弄立交", 29.844, 121.604, 0.50),
    ("人民南路立交", 29.857, 121.552, 0.50),
    ("建兴路下立交", 29.855, 121.573, 0.50),
    ("段三线绕城高速立交", 29.788, 121.632, 0.50),
    ("百宁街下立交", 29.853, 121.566, 0.50),
    ("紫城路西侧桥洞", 29.872, 121.549, 0.50),
    ("鄞县大道立交", 29.832, 121.583, 0.20),
    ("宋诏桥路立交", 29.877, 121.551, 0.20),
    ("下穿立交9处", 29.830, 121.600, 0.50),
]