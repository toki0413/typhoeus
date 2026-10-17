"""提比翁 —— 查询护栏：三条硬拒绝规则。

对应《AGENT_POSITIONING_REPORT》第 5.2 节。规则放在这一层而不是提示词
里，理由是提示词约束不住模型：它可能照做也可能不照做，而工具返回是
确定性的。同一个理由，本项目已有正确范式——`finiteness.assert_finite`
在检测到非有限值时直接 raise，内核宁可不出结果也不出坏结果。

三条规则各自的失效模式与判据：

**R1 越域拒绝**。计算域是 121.5501–121.6996E / 29.8404–29.9199N，
域外问题静默外推是产品最危险的失效——余姚在域外且是暴雨中心
（官方过程雨量 475 mm，域内站 283 mm），把域内结论套到余姚上误差
直接翻倍。拒绝而不是降级回答，因为域外没有可外推的物理基础，
给一个带"估计"标签的数字比不给更糟。

**R2 弱基线拒绝**。次模贪心的优势只在同时优于随机与按度两个基线时
成立；只优于一条时输出的是不可用结论。当前实测（72 h 窗）三策略
功能面积 30895 / 43892 / 40080，贪心确实双优，但这个结论依赖
`planner.functional_area` 的评分口径——口径错了排名会翻转（实测
缩到 0.7 h 窗时贪心 24.5 反而低于按度 29.4）。所以规则不是"检查
排名"，是"排名必须附带口径"，缺口径即拒。

**R3 单一口径拒绝**。降雨偏差域内口径 −8%、全市口径 −31%，差 23 个
百分点。只给单一口径的数字就是误导，而且读者分不清哪个是哪个。规则
要求：任何涉及雨量或功能损失的数字必须同时给出判据口径与参考口径，
并标明哪个是自样本。

三条规则的共同点：**不生成替代答案**。护栏的作用是拦住，不是兜底。
兜底会产生看起来可用的降级答案，而降级答案在下游与真答案无法区分。
"""
from __future__ import annotations

import json
from pathlib import Path

from .version import SCHEMA_VERSION

# 计算域实际范围。经 DEM 重采样后的格网覆盖，不是 config 里的请求框。
# 两者差零点几度，按请求框判会把测点在域外的站算进来。
DOMAIN = {
    "lon_min": 121.550139, "lon_max": 121.699583,
    "lat_min": 29.840417, "lat_max": 29.919861,
}


class RefusalError(ValueError):
    """硬拒绝。带 code 与可否重试的标记，供 MCP 层转成结构化错误。"""

    code = "REFUSED"

    def __init__(self, rule: str, reason: str, remedy: str = ""):
        self.rule = rule
        self.reason = reason
        self.remedy = remedy
        msg = f"[{rule}] {reason}"
        if remedy:
            msg += f" 处理办法：{remedy}"
        super().__init__(msg)

    def as_dict(self) -> dict:
        return {"refused": True, "rule": self.rule, "reason": self.reason,
                "remedy": self.remedy, "code": self.code}


# ---------- R1 越域 ----------

def check_in_domain(lon: float, lat: float, what: str = "查询点") -> dict:
    """点在计算域外即拒答。

    边界用闭区间。海曙站 lon=121.55 落在请求框内但在格网范围外，
    按格网判它是域外——它测的点在计算域外，插值权重没有定义。
    """
    try:
        lo, la = float(lon), float(lat)
    except (TypeError, ValueError) as e:
        raise RefusalError(
            "R1", f"{what}坐标不可解析：{e!r}",
            "给出 (lon, lat) 两个十进制度数") from e

    inside = (DOMAIN["lon_min"] <= lo <= DOMAIN["lon_max"]
              and DOMAIN["lat_min"] <= la <= DOMAIN["lat_max"])
    if not inside:
        raise RefusalError(
            "R1",
            f"{what} ({lo:.4f}E, {la:.4f}N) 在计算域外。"
            f"域范围 {DOMAIN['lon_min']:.4f}–{DOMAIN['lon_max']:.4f}E / "
            f"{DOMAIN['lat_min']:.4f}–{DOMAIN['lat_max']:.4f}N。"
            f"域内结论不能外推到域外——余姚过程雨量 475 mm，域内站283 mm，"
            f"外推误差直接翻倍",
            "改问域内点位，或先用别处数据处理该点位")
    return {"lon": lo, "lat": la, "in_domain": True}


# ---------- R2 弱基线 ----------

def check_order_usable(order_cmp: dict) -> dict:
    """恢复排序结论须同时优于两条基线，且评分口径齐备。

    双基线是门槛 6 的判据；口径齐备是本规则加的——排名对评分口径
    敏感，脱离口径的排名不可引用。
    """
    if not order_cmp:
        raise RefusalError(
            "R2", "恢复排序结论缺少 order_cmp，无法确认是否优于基线",
            "跑全链生成 02_recovery_order.json")

    gain = order_cmp.get("gain_over_baseline")
    if gain is None:
        raise RefusalError(
            "R2", "恢复排序结论缺 gain_over_baseline 字段",
            "该产物版本过旧，重新跑 `python -m typhoeus.cli run`")

    beats_both = order_cmp.get("beats_both")
    if beats_both is None:
        raise RefusalError(
            "R2", "恢复排序结论未做双基线校验，无法判断结论是否可用",
            "重新跑全链生成含『同时优于两基线』段的产物")

    if not beats_both:
        raise RefusalError(
            "R2",
            f"次模贪心未同时优于两条基线（对最优基线提升 {gain*100:+.1f}%），"
            f"排序结论不可用",
            "该口径下贪心不构成可交付的抢修顺序，"
            "改用按度排序或调整评分窗口后重算")

    # beats_both 与负提升自相矛盾：既然优于两条基线，对最优基线的
    # 提升不可能为负。这种数据不该存在，出现了说明比较逻辑坏了，
    # 而坏掉的比较逻辑给出的 beats_both 不可信。
    if gain <= 0.0:
        raise RefusalError(
            "R2",
            f"排序结论自相矛盾：标记为同时优于两基线，但对最优基线"
            f"的提升为 {gain*100:+.1f}%。比较逻辑与标记不一致，"
            f"排名不可信",
            "检查 planner.compare_orders 的基线比较，"
            "重算后再引用")

    caliber = {k: order_cmp.get(k)
               for k in ("horizon_h", "horizon_capped_at_72h",
                         "n_cmp_steps", "recovery_rate_per_h")}
    if caliber.get("horizon_h") is None:
        raise RefusalError(
            "R2", "恢复排序结论缺评分窗口，排名脱离口径不可引用",
            "提升幅度随窗口变化（实测 6 h 窗 +4.3%、72 h 窗 +29.6%），"
            "必须连同窗口引用")

    return {"gain_over_baseline": gain, "beats_both": True,
            "caliber": caliber}


# ---------- R3 单一口径 ----------

# 必须成对出现的口径字段。缺任一即拒答。
_PAIR_RULES = (
    (("rel_err_verdict", "rel_err_allcity"),
     "降雨偏差"),
    (("verdict_basis", "domain_basis"),
     "降雨口径来源"),
)

# 显式声明「不存在第二口径」的合法形态。字段no_second_basis 非空时
# 跳过成对检查——但必须同时给出 `缺什么`，说清补哪个口径要做什么。
#
# 这条不是给R3 开口子。R3 要防的是"有第二个口径却只给一个"，那种
# 情况下读者无从知道被省掉的那个是多少。多事件批量的驱动是参数化
# 合成场，域内站订正与全市面雨量这两个口径对它不适用——硬塞进去
# 反而是伪造一个不存在的对照。正确处置是明写"只有一个口径"以及
# "补第二个口径要做什么"，让读者自己判断这个限制可不可接受。
_NO_SECOND_BASIS_KEY = "no_second_basis"
_NO_SECOND_BASIS_MISSING = "what_is_missing"


def check_dual_basis(section: dict, where: str) -> dict:
    """涉及雨量/损失的数字必须同时给出判据口径与参考口径。

    唯一的例外形态是 `no_second_basis`：显式声明本口径无对照可用，
    且给出补齐路径。见 `_NO_SECOND_BASIS_KEY` 的说明。
    """
    if not section:
        raise RefusalError(
            "R3", f"{where}段为空，无从判断口径",
            "跑全链生成该段")

    if section.get(_NO_SECOND_BASIS_KEY):
        if not section.get(_NO_SECOND_BASIS_MISSING):
            raise RefusalError(
                "R3",
                f"{where}声明了无第二口径，但没写补齐路径。"
                f"读者无法判断这个限制能不能接受",
                f"给出 {_NO_SECOND_BASIS_MISSING}，"
                f"说明补第二个口径需要什么数据或操作")
        return True

    for keys, label in _PAIR_RULES:
        miss = [k for k in keys if section.get(k) is None]
        if miss:
            raise RefusalError(
                "R3",
                f"{where}的{label}只给了单一口径，缺 {miss}。"
                f"域内口径 −8% 与全市口径 −31% 差 23 个百分点，"
                f"只给一个就是误导",
                "同时给出判据口径与参考口径，并标明哪个是自样本。"
                f"若该驱动确实不存在第二口径，"
                f"改填 {_NO_SECOND_BASIS_KEY} 与 "
                f"{_NO_SECOND_BASIS_MISSING}")

    if section.get("in_sample") and section.get("rel_err") is not None \
            and section.get("rel_err_verdict") == section.get("rel_err"):
        raise RefusalError(
            "R3",
            f"{where}把自样本数字当判据口径用。"
            f"域内口径是订正锚点自身，比对结果在构造上接近零",
            "判据口径改用与订正锚点不同源的参考口径")
    return True


# ---------- 查询级护栏 ----------

def guard_query(payload: dict, outdir: Path | None = None) -> dict:
    """对一次工具返回做全量护栏。不通过即抛，不返回降级答案。

    这是 MCP 层唯一该调用的入口。护栏的失败必须是响亮的——静默
    放行等于把错误结论交给下游，而下游分不出它是不是错的。

    按产物实际字段判断，不假设段名。`06_health_report` 没有
    「输入层校验」段但它带 `面雨量_mm`，那同样是雨量数字，同样受
    R3 约束——护栏若只看段名就会漏掉它。
    """
    data = payload.get("数据") or {}
    name = payload.get("产物", "?")
    applied: list[str] = []

    if name == "恢复排序单":
        check_order_usable(_order_cmp_view(data))
        applied.append("R2")

    if name in ("预置方案单", "体检指标包", "标准体检报告"):
        ic = data.get("输入层校验")
        if ic:
            check_dual_basis(ic, name)
            applied.append("R3")
        elif data.get("触发阈值", {}).get("面雨量_72h_mm") is not None:
            # 触发阈值直接决定何时启动布点，缺口径就没法校准。
            raise RefusalError(
                "R3",
                f"{name}的触发阈值含面雨量 "
                f"{data['触发阈值']['面雨量_72h_mm']:.0f} mm 但未给偏差口径，"
                f"该阈值无法与实测雨量对齐",
                "补『输入层校验』段，或不在本产物里出现无口径的雨量阈值")
        elif data.get("面雨量_mm") is not None:
            raise RefusalError(
                "R3",
                f"{name}报了面雨量 {data['面雨量_mm']:.0f} mm 但未给偏差口径，"
                f"读者无从判断它与实测差多少",
                "补『输入层校验』段，或不在本产物里出现无口径的雨量数字")
    if name == "事件对账单":
        qd = data.get("Q分解") or {}
        if not qd:
            raise RefusalError(
                "R3", "事件对账单缺 Q 分解，功能损失无口径",
                "跑全链生成完整对账单")
        if qd.get("resid_share_pct") is None and qd.get("closed"):
            raise RefusalError(
                "R3", "Q 分解声称闭合但缺残差占比，闭合性无法核验",
                "重算对账分解")

    payload["护栏"] = {
        "R1_越域": "本次返回不含坐标，域检查在查询入口做",
        "R2_弱基线": "已校验双基线与评分窗口" if "R2" in applied
                  else "本次返回不含排序结论",
        "R3_单口径": "已校验双口径" if "R3" in applied
                   else "本次返回不含雨量口径数字",
        "schema_version": SCHEMA_VERSION,
    }
    return payload


def _order_cmp_view(recovery_order: dict) -> dict:
    """从编译后的恢复排序单还原成 order_cmp 视角的字段。"""
    cmp_ = recovery_order.get("策略对比") or {}
    cal = recovery_order.get("评分口径") or {}
    return {
        "gain_over_baseline": recovery_order.get("对基线提升"),
        "beats_both": recovery_order.get("同时优于两基线"),
        "horizon_h": cal.get("评分窗口_h"),
        "horizon_capped_at_72h": cal.get("窗口受72h事件窗封顶"),
        "n_cmp_steps": cal.get("比较步数"),
    }