"""提比翁 Demo —— μ_t 台风测度层。

对应文档 6.1：台风测度估计、CC 与超 CC 标度漂移修正（带置信区间）、集合生成。

关键约束（决定 Q 加法分解能否闭合）：
  气候项 Q_气候 与超标项 Q_超标 必须分开计量。
  若不分开，事件对账里"本可避免的损失"会被混进"不可归因的气候负荷"，
  对账单就失去决策价值。所以本模块显式返回两个分量，不合并。
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

# 平准化位势 SST_CClim：工业化前全球均温 +0.6 K（IPCC AR6）
SST_CC_LIM = 0.6
# Clausius-Clapeyron 标度（K^-1）：文档门槛 9 要求与 7%/°C 相容时降级表述
CC_EXPECTED = 0.07


@dataclass
class MeasureParams:
    """策略参数（L3 层）。"""

    n_members: int = 200  # 集合成员数；低于 ~50 时高分位会挤在同一批成员上
    seed: int = 20210725  # 固定使主链可复现；做稳定性研究时逐种子重抽
    cc_exponent: float = 0.07      # 标度率；门槛 9 会用真实序列回校
    cc_ci_low: float = 0.05# 下置信
    cc_ci_high: float = 0.09       # 上置信
    min_wind_ms: float = 8.0# 台风影响下限风速
    threshold_mm_h: float = 0.5    # 超标降雨判定阈值（mm/h）


@dataclass
class Measure:
    """一次台风过程的测度估计结果。"""

    peak_wind_ms: float
    min_pres_mb: float
    landfall_hours: float# 距宁波最近的登陆/最接近时刻，小时
    joint_quantile: dict          # 各分位的前 72 小时面雨量，mm
    climate_component: float      # Q_气候 归因部分
    excess_component: float       # Q_超标 归因部分
    cc_scaling: float
    cc_consistent: bool            # 置信区间是否与 7%/°C 相容
    members: list = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "peak_wind_ms": round(self.peak_wind_ms, 2),
            "min_pres_mb": round(self.min_pres_mb, 1),
            "landfall_hours": round(self.landfall_hours, 1),
            "joint_quantile_mm": {k: round(v, 1) for k, v in self.joint_quantile.items()},
            "Q_climate": round(self.climate_component, 2),
            "Q_excess": round(self.excess_component, 2),
            "cc_scaling_pct_per_K": round(self.cc_scaling * 100, 2),
            "cc_consistent_with_7pct": self.cc_consistent,
            "ensemble_size": len(self.members),
        }


def estimate(track, target_lat: float = 29.87, target_lon: float = 121.55,
             cfg: MeasureParams = MeasureParams(),
             grid=None, kcfg=None, rain_field: np.ndarray | None = None) -> Measure:
    """由路径估台风测度。

    做法：
    1. 用中心气压差算强度指数 BE；
    2. 用最近距离定登陆时刻；
    3. 按 CC 标度生成 n_members 个集合成员（对气压差与雨强施加区间扰动，
       扰动幅度来自 cc_ci_low/ci_high），每个成员算出72 小时面雨量；
    4. 分位数即联合分布的边缘化结果。
    """
    winds = [p.vmax_ms for p in track]
    pres = [p.pres_mb for p in track]
    peak_w = max(winds)
    min_p = min(pres)

    # 距宁波最近点
    dists = []
    for p in track:
        dx = (p.lon - target_lon) * 111.32 * math.cos(math.radians(target_lat))
        dy = (p.lat - target_lat) * 110.54
        dists.append(math.hypot(dx, dy))
    k_near = int(np.argmin(dists))
    # 路径点间隔 6 小时，编号即小时偏移
    landfall_h = k_near * 6.0

    # 集合：雨强对气压差做区间扰动
    rng = np.random.default_rng(cfg.seed)
    members = []
    base_dp = max(1010.0 - min_p, 5.0)
    # 标定基线取自降雨场实算，不另设解析式。
    # 直接调 kernel.rainfall_field 算一次实测路径的面雨量，
    # 再按气压差幂律缩放出集合成员。若在这里另写"mm/h 峰值 × 有效时长"
    # 的经验公式，两处口径必然对不上——实测路径窗内有 14 个路径点，
    # 每点的雨区只有部分落在计算域内，解析式无法反映这部分损失。
    base_rain72 = 0.0
    if rain_field is not None:
        base_rain72 = float(rain_field.mean(axis=(1, 2)).sum()
                            * kcfg.dt_s / 3600.0)
    elif grid is not None and kcfg is not None:
        from .kernel import rainfall_field
        r = rainfall_field(track, grid, kcfg)
        base_rain72 = float(r.mean(axis=(1, 2)).sum() * kcfg.dt_s / 3600.0)
    if base_rain72 <= 0.0:
        # 无网格时退回解析式，仅保证函数可用，量级不作为结论。
        from .kernel import T_HALF as _K_T_HALF
        from .kernel import _hour_offsets
        hrs = _hour_offsets(track)
        n_pts = sum(1 for x in hrs if -2.0 <= x + 1.5 <= 72.0 + 2.0)
        base_rain72 = 11.3 * n_pts * 2.0 * math.sqrt(2.0 * math.pi) * _K_T_HALF
    mid_cc = 0.5 * (cfg.cc_ci_low + cfg.cc_ci_high)
    # 把 [cc_ci_low, cc_ci_high] 当作 95% 置信区间处理，换算成标度率的
    # 标准差，再让每个成员从正态分布抽取缩放因子。旧写法是在区间内
    # 均匀抽样后 clip 到 [0.85,1.15]，约三分之一成员会贴在两个边界上，
    # 分布形状被截断人为制造。
    cc_sigma = (cfg.cc_ci_high - cfg.cc_ci_low) / (2 * 1.96)
    for m in range(cfg.n_members):
        z = float(rng.normal(1.0, cc_sigma / max(mid_cc, 1e-6)))
        jitter = float(np.clip(z, 0.80, 1.25))
        dp = base_dp * jitter
        # 面雨量按气压差幂律缩放，指数 1.4 取自暖海面增幅的经验区间。
        rain72 = base_rain72 * (dp / base_dp) ** 1.4
        members.append({
            "member": m,
            "cc_scale": mid_cc * jitter,
            "dp_hpa": dp,
            "base_rain72_mm": round(base_rain72, 1),
            "rain72_mm": rain72,
        })

    vals = np.array([x["rain72_mm"] for x in members], dtype=float)
    qs = {f"p{int(q*100)}": float(np.quantile(vals, q))
          for q in (0.5, 0.8, 0.9, 0.95)}

    # 气候与超标分离：气候项按 1/(1+cc·ΔT) 折算，超标项为余量
    cc = cfg.cc_exponent
    clim_frac = 1.0 / (1.0 + cc * SST_CC_LIM)
    mid = qs["p90"]
    climate = mid * clim_frac
    excess = mid - climate

    return Measure(
        peak_wind_ms=peak_w,
        min_pres_mb=min_p,
        landfall_hours=landfall_h,
        joint_quantile=qs,
        climate_component=climate,
        excess_component=excess,
        cc_scaling=cc,
        cc_consistent=(cfg.cc_ci_low <= CC_EXPECTED <= cfg.cc_ci_high),
        members=members,
    )


def gate_residual(pred: np.ndarray, obs: np.ndarray, gate: float = 0.15
                  ) -> tuple[bool, float]:
    """门槛 13：残差门控。

    返回（是否放行、残差）。残差超过 gate 说明短程推演已漂移，
    该时刻起结果降级为展示层，不参与决策。
    """
    if obs.size == 0:
        return True, 0.0
    denom = np.maximum(np.abs(obs).mean(), 1e-9)
    r = float(np.abs(pred - obs).mean() / denom)
    return bool(r <= gate), r