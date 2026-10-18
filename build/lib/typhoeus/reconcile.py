"""提比翁 Demo —— 观测同化与对账层。

对应文档 6.1：事件后 Q 损失加法分解
    Q = Q_气候 + Q_超标 + Q_工程失效 + Q_残差，四项闭合为事件总量。

关键约束（门槛 8）：残差项占比 ≤20%。超限时必须公开标注未建模物理，
不得把残差静默摊入其他三项——那会让对账单变成一份看起来完整、
实则无法追责的账单。

同时承载门槛 13 的残差门控：短程推演漂移超过阈值即降级为展示层。
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np


@dataclass
class ReconcileParams:
    """策略参数（L3）。"""

    climate_share: float = 0.55    # 气候分量占总量比例（由 μ_t 给出，此处为占位）
    excess_share: float = 0.25      # 超标分量占比
    engineering_share: float = 0.15 # 工程失效占比（管网/泵站能力不足）
    resid_tol: float = 0.20# 门槛 8 容差


@dataclass
class Reconciliation:
    """一份事件对账。"""

    total: float
    climate: float
    excess: float
    engineering: float
    residual: float
    closed: bool
    resid_share: float
    note: str = ""
    extra: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        # 精度取 4 位。2 位时 Q_engineering = 0.0072 会落成 0.01，
        # 只剩一位有效数字，而残差本身就在 ±0.03 量级——这个精度下
        # 四个分量之和与总量的关系无法核验。另外韧性价目表的依据段
        # 存的是全精度，两处精度不一致会让跨产物核对得到假阳性
        # （门槛 21 查的就是这个）。
        return {
            "Q_total": round(self.total, 4),
            "Q_climate": round(self.climate, 4),
            "Q_excess": round(self.excess, 4),
            "Q_engineering": round(self.engineering, 4),
            "Q_residual": round(self.residual, 4),
            "closed": self.closed,
            "resid_share_pct": round(self.resid_share * 100, 1),
            "note": self.note,
            **self.extra,
        }


def decompose(
    total: float,
    pred_climate: float,
    pred_excess: float,
    pred_engineering: float,
    cfg: ReconcileParams = ReconcileParams(),
) -> Reconciliation:
    """Q 损失加法分解，四项闭合到事件总量。

    total: 事件总功能损失（由功能曲线 Q(t) 积分得到）
    pred_*: 前三项的预测分量
    残差 = total -前三项之和；闭合判定用 |残差| / total ≤ tol。
    """
    resid = total - (pred_climate + pred_excess + pred_engineering)
    share = abs(resid) / max(abs(total), 1e-9)
    closed = bool(share <= cfg.resid_tol)
    note = ""
    if not closed:
        note = (f"残差占比 {share*100:.1f}% 超过 {cfg.resid_tol*100:.0f}% 门槛，"
                f"残差项对应未建模物理（管网水力、城市风场、闸泵调度），"
                f"该事件对账在演示中降级为展示层。")
    return Reconciliation(
        total=total,
        climate=pred_climate,
        excess=pred_excess,
        engineering=pred_engineering,
        residual=resid,
        closed=closed,
        resid_share=share,
        note=note,
    )


def event_total(Q: np.ndarray, dt_h: float) -> float:
    """事件总功能损失 = Q(t) 低于初值的部分对时间的积分。"""
    Q = np.asarray(Q, dtype=np.float64)
    q0 = Q[0]
    loss = np.maximum(q0 - Q, 0.0)
    return float(np.trapezoid(loss, dx=dt_h)) if hasattr(np, "trapezoid") \
        else float(np.trapz(loss, dx=dt_h))


def split_from_measure(total: float, joint_quantile: dict,
                       engineering_share: float, excess_share: float,
                       sst_cc_lim: float, cc_lo: float, cc_hi: float,
                       cfg: ReconcileParams = ReconcileParams(),
                       ) -> Reconciliation:
    """由 μ_t 分位数与 CC 区间出Q 的前三项预测，返回闭合结果。

    **主链与多事件批量必须走这一个函数。** 三项预测各自独立：气候项
    由 CC 标度反推、超标项由集合 p90 与 p50 的分位差给出、工程项由
    L3 声明的管网能力缺口给出。三处各写一遍公式，参数一改就会让主链
    与批量的 Q 分解对不上，而这种不一致在产物里表现为两个数——正是
    门槛 21 要抓的东西。

    量纲：total 是「功能单位 × 小时」（Q(t) 对时间的积分），μ_t 给的是
    面雨量与标度比例，两者量纲不同，不可直接相乘。
    """
    cc_mid = 0.5 * (cc_lo + cc_hi)
    clim_ratio = 1.0 / (1.0 + cc_mid * sst_cc_lim)
    # 雨强比到功能损失的响应是超线性的：内涝损失随雨强增长快于线性，
    # 用幂1.6 表达（与 projection.capacity 的分段线性斜率同源）。
    pred_climate = total * clim_ratio ** 1.6
    p50 = float(joint_quantile.get("p50", 0.0))
    p90 = float(joint_quantile.get("p90", 0.0))
    exceed_frac = float(np.clip((p90 - p50) / max(p90, 1e-9), 0.0, 1.0))
    denom = max(excess_share + engineering_share, 1e-9)
    pred_excess = total * exceed_frac * excess_share / denom
    pred_eng = total * engineering_share * (1.0 - clim_ratio) / denom
    rec = decompose(total, pred_climate, pred_excess, pred_eng, cfg)
    rec.extra["cc_mid_pct_per_K"] = round(cc_mid * 100, 2)
    rec.extra["climate_ratio"] = round(clim_ratio, 4)
    rec.extra["exceed_frac_p90_over_p50"] = round(exceed_frac, 4)
    return rec


def drought_gate(pred_series: list[float], obs_series: list[float],
                 gate: float = 0.20) -> dict:
    """门槛 13：残差门控回测。

    对比带门控与无门控两种策略的漂移，返回漂移降低比。
    门控策略在残差超阈值时冻结更新，漂移应显著低于无门控。

    阈值口径：gate 是**相对残差**（占观测均值的比例），不是绝对差。
    功能曲线归一化后绝对差普遍在 1e-3 量级，用绝对阈值会让门控
    永不触发，回测结果恒为 0%，门槛变成一个恒假判据。
    """
    p = np.asarray(pred_series, dtype=np.float64)
    o = np.asarray(obs_series, dtype=np.float64)
    if p.size < 3 or o.size != p.size:
        return {"passed": False, "reason": "序列过短或长度不匹配"}

    denom = max(float(np.abs(o).mean()), 1e-12)
    # 无门控：全部预测直接累积漂移
    drift_free = float(np.abs(np.cumsum(p - o)).max())
    # 门控：相对残差超阈值处把预测拉回观测（冻结 + 重锚）
    p_gated = p.copy()
    n_fire = 0
    for k in range(1, p_gated.size):
        resid = abs(p_gated[k - 1] - o[k - 1]) / denom
        if resid > gate:
            p_gated[k] = o[k - 1]      # 冻结并重锚
            n_fire += 1
    drift_gated = float(np.abs(np.cumsum(p_gated - o)).max())
    reduction = (drift_free - drift_gated) / max(drift_free, 1e-9)
    return {
        "drift_free": drift_free,
        "drift_gated": drift_gated,
        "reduction": float(reduction),
        "n_gate_fired": n_fire,
        "threshold": gate,
        "passed": bool(reduction >= 0.20),
    }