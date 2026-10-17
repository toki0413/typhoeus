"""提比翁 Demo —— 编译层：一个内核长出六份输出物。

对应文档第一节的六份输出物：
  预置方案单 / 恢复排序单 / 事件对账单 / 韧性价目表 / 体检指标包 / 标准体检报告

关键约束：一份内核长出六份，不允许为每份输出物单开一条计算链。
本模块只做"格式"，所有数值来自同一次 run() 的结果对象。
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from . import gates as G
from . import measure as M
from . import planner as P
from . import projection as PRJ
from . import reconcile as RC
from .version import KERNEL_VERSION, SCHEMA_VERSION, check_compat

def demo_note(ctx) -> str:
    """随降雨源动态生成全局caveat。

    原来这句话是硬编码的"降雨由台风路径参数化合成"。接入 ERA5 后
    它就是错的——写错的caveat 比没有caveat 更危险，它会让读者对
    全部输出物的来源判断失准。
    """
    rc = ctx.get("rain_check") or {}
    rs = ctx.get("rain_source") or {}
    driver = rs.get("driver", "unknown")
    cal = rs.get("calibration") or {}
    allcity = rc.get("allcity_mm", 0.0)
    rel_a = rc.get("rel_err", 0.0)
    rel_c = rc.get("rel_err_allcity", 0.0)

    if driver in ("era5", "era5-cache"):
        tail = ""
        if cal.get("applied"):
            tail = (f"该源已用域内 {cal.get('n_stations_in_domain', 0)} 个实测站"
                    f"做分位数订正，订正锚点与门槛 15 的观测侧同源，"
                    f"故域内口径偏差（{rel_a*100:+.0f}%）是自样本数字，"
                    f"不作判据。")
        # 阈值类指标里涝点水深命中率最依赖雨强分布，而再分析给的是
        # 被平滑过的格点均值。总量口径与极值口径因此落在不同方向上，
        # 引用任一个都要连同另一起来源一起说。
        tail += ("再分析能约束过程总量但不能约束对流尺度极值："
                 "涝点水深命中率（门槛 14）在面雨量口径改善的同时归零，"
                 "峰值雨强只有参数化场的约三分之一，管网与地面积水按强度"
                 "失效。未接 CMFD 2.0 与雷达实测。")
        return (f"降雨驱动为 ERA5 再分析（经 Open-Meteo archive-api，免 key），"
                f"非台风路径参数化合成。面雨量对域内站口径偏差 {rel_a*100:+.0f}%、"
                f"对官方全市面雨量 {allcity:.0f} mm 偏差 {rel_c*100:+.0f}%。"
                f"{tail}")
    if driver == "parametric-fallback":
        return ("降雨源不可用，已降级为台风路径参数化合成驱动。"
                "所有由降雨驱动的阈值指标均为合成驱动下的结果，"
                "不与实测降雨混用、不作为工程结论。"
                "降雨总量相对实测的偏差已在门槛 15 单列。")
    return ("降雨由台风路径参数化合成，未接 CMFD 或雷达实测；"
            "所有由降雨驱动的阈值指标均为合成驱动下的结果，"
            "不与实测降雨混用、不作为工程结论。"
            "降雨总量相对实测的偏差已在门槛 15 单列。")


def _manifest_caveat(ctx) -> str:
    return demo_note(ctx)


def new_bundle(ctx, outputs: dict) -> "Bundle":
    """从 ctx 构造 Bundle，全局 caveat 在这里绑定。

    唯一构造入口。Bundle 不持有 ctx，所以 caveat 必须在构造时取好——
    直接在 `write` 里调`demo_note(ctx)` 会拿到一个不存在的名字。
    """
    return Bundle(
        config_hash=ctx["config_hash"],
        source_hash=ctx["source_hash"],
        measure=ctx["measure"],
        summary={"event": ctx["event_name"], "conclusion": ctx["conclusion"]},
        gates=ctx["gates"],
        outputs=outputs,
        caveat=demo_note(ctx),
    )


@dataclass
class Bundle:
    """一次运行的全部产物。六份输出物从这里出去。"""

    config_hash: str
    source_hash: str
    measure: dict
    summary: dict
    gates: list
    outputs: dict
    # 全局caveat 随降雨源变，写死就成错误声明。构造时由调用方从ctx
    # 取好传进来：Bundle 只持有产物，不持有 ctx。
    caveat: str = ""

    def write(self, outdir: str) -> list[str]:
        d = Path(outdir)
        d.mkdir(parents=True, exist_ok=True)
        written = []

        # 写盘前逐份查版本兼容性。输出物一旦落盘就成了对外凭据，
        # 低于最小可读版本的产物写出去，读取方只能猜字段含义。
        # 高于本内核版本的产物给出警告但不阻断——那是别人写的，
        # 字段可能缺失但结构仍可读，阻断会把别人的正常升级挡在门外。
        for name, payload in self.outputs.items():
            verdict = check_compat(payload)
            if not verdict["readable"]:
                raise ValueError(f"{name} 版本不兼容：{verdict['reason']}")
            if not verdict.get("forward_compatible", True):
                print(f"[WARN] {name} {verdict['reason']}")
        for name, payload in self.outputs.items():
            p = d / f"{name}.json"
            with open(p, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, indent=2)
            written.append(str(p))
        # 六份产物的清单
        manifest = {
            "schema_version": SCHEMA_VERSION,
            "kernel_version": KERNEL_VERSION,
            "config_hash": self.config_hash,
            "source_hash": self.source_hash,
            "outputs": sorted(self.outputs.keys()),
            "caveat": self.caveat or (
                "未提供全局 caveat。Bundle 构造时须传入 demo_note(ctx) 的结果，"
                "否则这份清单对来源的声明是空的"),
        }
        pm = d / "manifest.json"
        with open(pm, "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)
        written.append(str(pm))
        return written


def _pick(seq, idx):
    return seq[int(np.clip(idx, 0, len(seq) - 1))]


# ---------- 1预置方案单 ----------

def preset_plan(ctx) -> dict:
    m = ctx["measure"]
    ps = ctx["preselect"]
    rc = ctx.get("rain_check") or {}
    out = {
        "名称": "预置方案单",
        "适用场景": "汛前预置布点与巡查排班",
        "台风测度": m["joint_quantile_mm"],
        "建议布点数": ps["n_points"],
        "覆盖率": round(ps["coverage"], 3),
        "布点坐标像元": ps["coords"][:12],
        "触发阈值": {
            "面雨量_72h_mm": m["joint_quantile_mm"].get("p90", 0.0),
            "最大风速_ms": m["peak_wind_ms"],
        },
        "处置": "按分位数分级预案，p90 分位以上启动全域布点",
        "schema_version": SCHEMA_VERSION,
    }
    # 触发阈值是读者会直接拿去用的数字，必须同时给两件事：这个分位
    # 相对实测偏多少，以及模型算的是多大的雨。少任何一件，阈值就
    # 是个无法校准的数——实测偏 31% 时按251.6 mm 启动布点，实际
    # 对应的雨量不是 251.6 mm。
    if rc:
        out["输入层校验"] = rc
    return out


# ---------- 2 恢复排序单 ----------

def recovery_order(ctx) -> dict:
    c = ctx["order_cmp"]
    # .get 兜底：允许读旧结构的 order_cmp（归档输出、外部脚本）。
    # 缺评分口径字段时该段留空并标注，不让旧数据在编译期崩掉。
    win = c.get("horizon_h")
    stc = c.get("steps_to_clear")
    return {
        "名称": "恢复排序单",
        "适用场景": "灾后通路抢修排序",
        "策略对比": {
            "次模贪心功能面积": round(c["greedy_area"], 1),
            "随机基线功能面积": round(c["random_area"], 1),
            "按度基线功能面积": round(c["degree_area"], 1),
        },
        "对基线提升": round(c["gain_over_baseline"], 4),
        "同时优于两基线": c.get("beats_both"),
        "评分口径": {
            "评分窗口_h": round(win, 2) if win is not None else None,
            "窗口受72h事件窗封顶": c.get("horizon_capped_at_72h"),
            "自然恢复项": "不含（评分只比较恢复次序本身，不掺入恢复动力学）",
            "比较步数": c.get("n_cmp_steps"),
            "基线处理": "随机与按度截断到与贪心等长，同一时间窗内比清空进度",
            "清空全量所需步数": stc,
        },
        "贪心前10序": c["greedy_order_head"],
        "按度前10序": c["degree_order_head"],
        "声明": "次模近似比未在本Demo 验证，不声明近似比数值。"
                "提升幅度随评分窗口变化（实测 6 h 窗 +4.3%、72 h 窗 +29.6%），"
                "引用本值须连同窗口。恢复单元为单像元 54 m，"
                "真实排班单元是走廊，该口径使提升幅度偏乐观",
        "schema_version": SCHEMA_VERSION,
    }


# ---------- 3 事件对账单 ----------

def event_reconciliation(ctx) -> dict:
    r: RC.Reconciliation = ctx["recon"]
    fo = ctx.get("front") or {}
    cov = ctx.get("coverage") or {}
    qd = r.as_dict()
    # 冗余给出可干预总量，让韧性价目表不必从两个分量反推。
    # 反推在四舍五入后会对不上：按落盘精度 0.05 + 0.01 = 0.06，
    # 全精度是 0.0534 + 0.0072 = 0.0605，差 0.0005。
    qd["Q可干预"] = round(float(qd["Q_excess"]) + float(qd["Q_engineering"]), 4)
    return {
        "名称": "事件对账单",
        "事件": ctx["event_name"],
        "Q分解": qd,
        "闭合性": "四项相加等于事件总量" if r.closed else "残差超门槛，降级为展示层",
        "实测校验": {
            "涝点总数": cov.get("n_total"),
            "命中数": cov.get("n_hit"),
            "覆盖率": (round(cov["rate"], 4)
                     if cov.get("rate") is not None else None),
            "域外排除点": cov.get("excluded", []),
            "水位MAE_m": fo.get("mean_abs_diff_m"),
            "水位最大偏差_m": fo.get("max_abs_diff_m"),
            "逐点对照": fo.get("items", []),
            "落选点位": cov.get("missed", []),
        },
        "schema_version": SCHEMA_VERSION,
    }


# ---------- 4韧性价目表 ----------

def resilience_pricing(ctx) -> dict:
    m = ctx["measure"]
    q = ctx["proj"]
    return {
        "名称": "韧性价目表",
        "口径": "每减少 1%峰值功能损失的工程投入区间（万元），Demo 量级估算",
        "档位": [
            {
                "档": "Ⅰ级：布点与感知",
                "单位": "万元/点位",
                "区间": [2.0, 5.0],
                "对应减少功能损失_pct": 1.0,
            },
            {
                "档": "Ⅱ级：小型排水改造",
                "单位": "万元/片区",
                "区间": [300.0, 800.0],
                "对应减少功能损失_pct": 8.0,
            },
            {
                "档": "Ⅲ级：泵站与闸控",
                "单位": "万元/站",
                "区间": [800.0, 2000.0],
                "对应减少功能损失_pct": 15.0,
            },
        ],
        "依据": {
            # 精度与事件对账单的 Q 分解对齐（同为 4 位）。两处精度
            # 不同会让跨产物核对得到假阳性，见 `consistency` 模块。
            "气候分量_Q": round(ctx["recon"].climate, 4),
            "超标分量_Q": round(ctx["recon"].excess, 4),
            "工程失效分量_Q": round(ctx["recon"].engineering, 4),
            "可干预总量": round(ctx["recon"].excess + ctx["recon"].engineering, 4),
        },
        "声明": "量级估算，Demo 阶段不作报价依据",
        "schema_version": SCHEMA_VERSION,
    }


# ---------- 5 体检指标包 ----------

def health_metrics(ctx) -> dict:
    g = ctx["gates"]
    return {
        "名称": "体检指标包",
        "指标总数": len(g),
        "PASS": sum(1 for x in g if x["status"] == "PASS"),
        "FAIL": sum(1 for x in g if x["status"] == "FAIL"),
        "DEGRADED": sum(1 for x in g if x["status"] == "DEGRADED"),
        "BLOCKED": sum(1 for x in g if x["status"] == "BLOCKED"),
        "明细": [
            {
                "编号": x["id"],
                "验证内容": x["content"],
                "实测值": x["value"],
                "门槛": x["threshold"],
                "状态": x["status"],
                "根因": x["note"],
                "阶段": x.get("stage"),
                "维度": x.get("cover"),
            }
            for x in g
        ],
        # 四阶段 × 五维度覆盖矩阵。两轴借鉴浙大 REN 的 ReCOVER 体系构造方式，
        # 但只作归档维度用，不引入其 62 项指标——那套以城市级统计与问卷为主，
        # 本产品是街区级工程判据。矩阵的实际作用是暴露空格：
        # economy 与 environment 两维当前完全无门槛覆盖。
        "覆盖矩阵": G.coverage_matrix(g),
        # 门槛 6 的提升值在「明细」里是嵌在字符串中的（"提升 29.6%
        # （窗口 72 h...）"），无法参与数值核对。这里冗余一个数值，
        # 供 G21 跨产物一致性闸比对。
        "门槛6提升": (round(ctx["order_cmp"]["gain_over_baseline"], 4)
                  if ctx.get("order_cmp") else None),
        "承灾体系数": ctx.get("prj_params", {}).get("road_capacity"),
        "承灾体系数区间": PRJ.ROAD_CAPACITY_TOL,
        "输入层校验": ctx.get("rain_check", {}),
        "降雨源": ctx.get("rain_source", {}),
        "数据接入": ctx.get("observe", {}),
        "schema_version": SCHEMA_VERSION,
    }


# ---------- 6 标准体检报告 ----------

def health_report(ctx) -> dict:
    g = ctx["gates"]
    k = ctx["kernel"]
    return {
        "名称": "标准体检报告",
        "事件": ctx["event_name"],
        "内核版本": KERNEL_VERSION,
        "config_hash": ctx["config_hash"],
        "source_hash": ctx["source_hash"],
        "守恒性": {
            "相对残差": k["mass_resid"],
            "容差": ctx["cfg"].l4.tol_mass,
            "通过": bool(k["mass_resid"] <= ctx["cfg"].l4.tol_mass),
            "水量收支_mm": {kk: round(vv, 2)
                            for kk, vv in (k.get("budget") or {}).items()},
        },
        # 入渗机制与能量账。Green-Ampt + Ghil-Sellers 的落盘位置。
        # legacy 模式下后半段为空，那表示"该机制不跑能量平衡"，
        # 不是"跑了且恰好为零"。
        "入渗机制": (k.get("infil_energy") or {}).get("入渗机制",
                                                "未记录"),
        "正性": {"通过": bool(k["positivity_ok"])},
        "入渗与能量": {kk: vv for kk, vv in (k.get("infil_energy") or {}).items()
                  if kk != "入渗机制"},
        "面雨量_mm": round(k.get("rain_total_mm", 0.0), 1),
        "峰值水深_m": round(k["max_depth"], 3),
        "峰值时刻_h": round(k["peak_time_h"], 2),
        "积水分级占比": ctx["levels"],
        # 面雨量是雨量数字，读者必然会拿它跟实测比。不给偏差口径，
        # 护栏规则 R3 会拒绝这份产物发布——护栏拒的不是文档风格，
        # 是"报了一个数字却不说明它可不可信"。
        "输入层校验": ctx.get("rain_check", {}),
        "数据来源": ctx.get("inputs", {}),
        "数据接入": ctx.get("observe", {}),
        "结论": ctx["conclusion"],
        "caveat": demo_note(ctx),
        "schema_version": SCHEMA_VERSION,
    }


COMPILERS = {
    "01_preset_plan": preset_plan,
    "02_recovery_order": recovery_order,
    "03_event_reconciliation": event_reconciliation,
    "04_resilience_pricing": resilience_pricing,
    "05_health_metrics": health_metrics,
    "06_health_report": health_report,
}


def compile_all(ctx) -> dict:
    return {name: fn(ctx) for name, fn in COMPILERS.items()}