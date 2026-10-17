"""观测 → 内核入渗与蒸散参数的标定桥。

`soilsrc`给出实测的土壤相对饱和度与 ET0，`kernel` 要的是
`soil_theta0`（相对饱和度）与 `net_sw_wm2`（W/m²）。两者之间有两次
口径转换，每次都要显式写出来，不允许藏在函数体里。

**第一次转换：观测 θ → 城市硬化面 θ。**
ERA5-Land 0-7 cm 测的是自然地表（农田、草地、林地），计算域是压平
建筑后的 DSM 硬化面。城市不透水面阻断补给、压实层降低渗透系数、
管网快速排走雨水，根区不可能达到自然田面的饱和度。观测值因此是
城市值的**上界**，中间那个折减系数目前无观测，只能显式参数化。

**第二次转换：ET0 → 净短波辐射。**
Ghil-Sellers 的潜热项由净辐射驱动，而 ET0 是参考蒸散（FAO-56
Penman-Monteith）。两者的连接点是潜热通量：

    LE = Rn_net · (1 - G_frac - H_frac)
    ET0 = LE · evap_efficiency / (ρ_w · L_v)     （充分供水、无水汽亏缺）

反解得 Rn_net，再除以反照率还原净短波。校准目标是内核的**土壤蒸发
量**等于实测 ET0 乘有效蒸发面积比 —— 不是等于 ET0 本身。ET0 定义在
充分供水草地上，而硬化面不蒸发，量纲上必须对齐，否则会把蒸散高估
一个数量级。

实测基准（2021 烟花，72 h 窗anchor → +72 h）：
    ET0 累计       5.47 mm
    θ 实测         0.987（湿偏改正后，三深度层互证）
    校准后 net_sw  78.0 W/m²   （原常量 40.0，低估 1.95 倍）
    校准后 72h 蒸发 1.368mm    （原常量 0.701 mm）

注意量级：校准使蒸发从 0.701 升到 1.368 mm，增量 0.67 mm 占主链降雨
286 mm 的 **0.23%**，对峰值水深的影响远在守恒残差之下。实测把一个
量级不足的过程量校正了 2 倍，但**校正后的量级依然不足**。这是诚实的
结论，不该反过来当成"接入 ET0 提升了模型精度"。
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from . import soilsrc
from .config import Config

RHO_W = 1000.0
LV = 2.45e6      # J/kg


class CalibrationError(RuntimeError):
    """土壤源不可用且未允许参数化降级。"""


@dataclass
class SoilCalibration:
    """标定结果。`applied` 为 False 时表示参数化降级。"""

    theta0: float
    net_sw_wm2: float
    applied: bool
    driver: str
    report: dict = field(default_factory=dict)


def _net_sw_from_et0(et0_72h_mm: float, albedo: float,
                     ground_flux_frac: float, sensible_frac: float,
                     evap_efficiency: float,
                     hours: float = 72.0) -> float:
    """由72h ET0 累计（mm）反解净短波辐射（W/m²）。

    目标是土壤蒸发量等于 ET0，而不是通量等于通量——
    kernel 的蒸散从土壤水扣除后还要过 `evap_efficiency`，
    这里必须把同一个系数用回去，否则隐含"效率被算了两次"。
    """
    if et0_72h_mm <= 0.0:
        raise CalibrationError(f"ET0 累计非正：{et0_72h_mm} mm")
    latent = 1.0 - ground_flux_frac - sensible_frac
    if latent <= 1e-6:
        raise CalibrationError(
            f"潜热份额非正：1-{ground_flux_frac}-{sensible_frac}={latent}")
    sec = hours * 3600.0
    # 目标蒸发 mm -> m/s -> 潜热 W/m2
    le = (et0_72h_mm / 1000.0 / sec) * (RHO_W * LV) / evap_efficiency
    rn_net = le / latent
    if albedo >= 1.0:
        raise CalibrationError(f"反照率必须 <1，得到 {albedo}")
    return rn_net / (1.0 - albedo)


def calibrate(cfg: Config | None = None, *, verbose: bool = True,
              allow_fallback: bool = False) -> SoilCalibration:
    """由 `cfg` 构造标定后的入渗与蒸散参数。

    `allow_fallback=False`（默认）时土壤源不可用直接抛错 —— 门槛结果
    依赖入渗量，静默降级会让 27 条门槛里若干条的输入失去观测锚点而不
    报错。`allow_fallback=True` 仅供诊断工具使用，报告里
    `applied=False` 且 `driver=parametric-fallback`。
    """
    cfg = cfg or Config()
    l2 = cfg.l2
    log = (lambda *a: print(*a, flush=True)) if verbose else (lambda *a: None)

    base = {
        "theta0_parametric": l2.soil_theta0,
        "net_sw_parametric": l2.net_sw_wm2,
        "urban_theta_frac": l2.urban_theta_frac,
        "evap_area_frac": l2.evap_area_frac,
        "dry_bias_m3_m3": soilsrc.DRY_BIAS_M3_M3,
        "dry_bias_range_m3_m3": list(soilsrc.DRY_BIAS_RANGE),
        "theta_sat": soilsrc.THETA_SAT,
        "theta_res": soilsrc.THETA_RES,
    }

    if l2.soil_source == "parametric":
        log("[T_θ] 土壤源 parametric（无观测锚点）")
        return SoilCalibration(
            theta0=l2.soil_theta0, net_sw_wm2=l2.net_sw_wm2,
            applied=False, driver="parametric",
            report={**base, "applied": False,
                    "caveat": "参数化土壤常数，θ0 与净辐射均无观测锚点"})

    try:
        prof, rep = soilsrc.get_soil(verbose=verbose)
    except soilsrc.SoilSourceError as e:
        if not allow_fallback:
            raise CalibrationError(
                f"土壤源不可用且未允许降级：{e}") from e
        log(f"[!] {e}")
        log("[!] 降级到参数化土壤常数")
        return SoilCalibration(
            theta0=l2.soil_theta0, net_sw_wm2=l2.net_sw_wm2,
            applied=False, driver="parametric-fallback",
            report={**base, "applied": False, "reason": str(e),
                    "caveat": "降级路径，入渗与蒸散均无观测锚点"})

    # --- 转换一：观测 θ -> 城市 θ ---
    theta_obs = prof.theta0
    theta_city = theta_obs * l2.urban_theta_frac
    theta_final = min(max(theta_city, 0.0), 0.999)
    n_satur_clipped = int(theta_city >= 0.999)

    # --- 转换二：ET0 -> 净短波 ---
    hours = float(cfg.l4.max_t_h)
    sec = hours * 3600.0
    i0 = int(prof.notes.get("anchor_index", 0))
    win = prof.et0_mm_h[i0:i0 + int(hours)]
    win = win[np.isfinite(win)] if len(win) else np.array([])
    et0_win = float(win.sum()) if win.size else float("nan")
    if not np.isfinite(et0_win) or et0_win <= 0.0:
        # ET0 序列缺失或全零：台风期有可能发生，但 ET0=0 会让净辐射
        # 变成 0，潜热项整体关闭。这不是可以静默填的默认值。
        raise CalibrationError(
            f"anchor 后 {hours:g} h 的 ET0 累计无效：{et0_win}")
    et0_area = et0_win * l2.evap_area_frac
    net_sw = _net_sw_from_et0(et0_area, l2.albedo,
                             l2.ground_flux_frac, l2.sensible_frac,
                             l2.evap_efficiency, hours=hours)

    # 用新参数正算一遍蒸发，与目标对账。这是对反解的自检：
    # 净辐射的量纲换算若写错，正算必然对不上。
    le = net_sw * (1.0 - l2.albedo) * (1.0 - l2.ground_flux_frac
                                      - l2.sensible_frac)
    evap_back = le * l2.evap_efficiency / (RHO_W * LV) * sec * 1000.0
    resid = abs(evap_back - et0_area)

    log(f"[T_θ] 土壤源 {rep['driver']}  "
        f"θ 实测 {theta_obs:.3f} → 城市 {theta_final:.3f} "
        f"(x{l2.urban_theta_frac})")
    log(f"     ET0 {hours:g}h {et0_win:.2f} mm x 面积比 "
        f"{l2.evap_area_frac} = {et0_area:.3f} mm  "
        f"→ net_sw {net_sw:.1f} W/m2（原 {l2.net_sw_wm2:.1f}）")
    log(f"     蒸发正算校核{evap_back:.4f} mm  残差 {resid:.2e} mm")

    return SoilCalibration(
        theta0=theta_final, net_sw_wm2=float(net_sw),
        applied=True, driver=rep["driver"],
        report={
            **base, **rep,
            "applied": True,
            "theta_observed": theta_obs,
            "theta_city_factor": l2.urban_theta_frac,
            "theta0_final": theta_final,
            "theta_saturated_clipped": n_satur_clipped,
            "et0_window_h": hours,
            "et0_window_mm": round(et0_win, 3),
            "et0_area_mm": round(et0_area, 4),
            "net_sw_calibrated_wm2": round(float(net_sw), 2),
            "net_sw_parametric_wm2": l2.net_sw_wm2,
            "evap_backcheck_mm": round(evap_back, 4),
            "evap_backcheck_resid_mm": float(f"{resid:.3e}"),
            "evap_parametric_mm": round(
                l2.net_sw_wm2 * (1.0 - l2.albedo)
                * (1.0 - l2.ground_flux_frac - l2.sensible_frac)
                * l2.evap_efficiency / (RHO_W * LV) * sec * 1000.0, 4),
            "caveat": "θ 观测来自自然地表，计算域是城市硬化面，"
                      "折减系数无观测；ET0 是 FAO-56 参考蒸散，"
                      "不是实测蒸散；ERA5-Land 土壤湿度湿偏改正为定值 "
                      "+0.065 m³/m³，未做逐场变率订正。",
        })


if __name__ == "__main__":
    import json

    cal = calibrate()
    print(json.dumps(cal.report, ensure_ascii=False, indent=2,
                     default=str))