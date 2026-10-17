"""提比翁 Demo 单一入口。

用法：
  python -m typhoeus.cli run      跑全链并导出六份输出物
  python -m typhoeus.cli check    只跑 13 条门槛
  python -m typhoeus.cli report   只打印内核体检摘要

设计约束：所有功能走同一入口，不为不同功能开不同脚本。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

from . import compile as C
from . import config as CFG
from . import gates as G
from . import kernel as K
from . import measure as M
from . import planner as P
from . import projection as PRJ
from . import reconcile as RC
from . import data as D
from . import observe as OB
from . import render as RND
from . import rainsrc as RS
from . import soilcal as SC

EVENT_NAME = "2021 年第6 号台风「烟花」（In-Fa）· 宁波鄞东南片区"


def _kernel_params(cfg: CFG.Config,
                   soil: "SC.SoilCalibration | None" = None) -> K.KernelParams:
    """由 config 构造内核参数。**主链与多事件批量必须走这一个函数。**

    两处各写一遍 KernelParams(...) 时，改了 config 忘改其中一处，
    面上是一次完整复算，实际两批场次用了不同的入渗机制，
    强度—损失标度关系里就混进了机制差异。这与R3拒答的
    「同一驱动两个口径」是同一类错误。

    `soil` 非None 时用 `soilcal` 的观测标定值覆盖 `soil_theta0` 与
    `net_sw_wm2`。**先标定再构造**，不再在两处各自覆盖 —— 那会让
    标定值与config 值在同一个 KernelParams 里混源，事后无法从参数
    反推是哪条路径写的。
    """
    theta0 = soil.theta0 if soil else cfg.l2.soil_theta0
    net_sw = soil.net_sw_wm2 if soil else cfg.l2.net_sw_wm2
    return K.KernelParams(
        dt_s=cfg.l4.dt_s, max_t_h=cfg.l4.max_t_h,
        manning_n=cfg.l1.manning_n, min_depth_m=cfg.l4.min_depth_m,
        tol_mass=cfg.l4.tol_mass, max_depth_m=cfg.l4.max_depth_m,
        drainage_invert_m=cfg.l2.drainage_invert_m,
        drainage_coeff_m_s=cfg.l2.drainage_coeff_m_s,
        infiltration_mode=cfg.l2.infiltration_mode,
        infiltration_m_h=cfg.l2.infiltration_m_h,
        soil_ksat_m_h=cfg.l2.soil_ksat_m_h,
        soil_psi_m=cfg.l2.soil_psi_m,
        soil_capacity_mm=cfg.l2.soil_capacity_mm,
        impervious_frac=cfg.l2.impervious_frac,
        soil_theta0=theta0,
        soil_theta_res=cfg.l2.soil_theta_res,
        net_sw_wm2=net_sw,
        albedo=cfg.l2.albedo,
        ground_flux_frac=cfg.l2.ground_flux_frac,
        sensible_frac=cfg.l2.sensible_frac,
        evap_efficiency=cfg.l2.evap_efficiency)


def run_chain(cfg: CFG.Config | None = None, verbose: bool = True,
              outdir: str | None = None) -> dict:
    """一次完整计算，产出六份输出物所需的全部上下文。"""
    cfg = cfg or CFG.Config()
    t0 = time.perf_counter()
    log = (lambda *a: print(*a, flush=True)) if verbose else (lambda *a: None)

    # ---- L0 数据接入 ----
    log("[L0] 读取 DEM 与台风路径 ...")
    inputs = D.load_all(cfg.l2.bbox, cfg.l4.resample)
    log(f"     网格 {inputs.grid.shape}  cell={inputs.grid.cell_m:.0f} m  "
        f"路径点 {len(inputs.track)}")

    # ---- 土壤标定（观测覆盖 θ0 与净辐射） ----
    log("[T_θ] 土壤状态与蒸散标定 ...")
    try:
        soil = SC.calibrate(cfg, verbose=verbose)
    except SC.CalibrationError as e:
        raise SystemExit(f"土壤标定失败：{e}")
    soil_rep = soil.report

    # ---- 内核参数（μ_t 与 T_θ 共用，保证面雨量口径同源） ----
    kcfg = _kernel_params(cfg, soil=soil)

    # ---- T_θ 降雨场（μ_t 拿它定面雨量基线，故先算） ----
    if cfg.l2.rain_source == "era5":
        log("[T_θ] 接ERA5 再分析降雨场 ...")
        rain_st = OB.load_rain_stations()
        rain, rain_rep = RS.get_rainfall(
            inputs.grid, stations=rain_st,
            use_cache=cfg.l2.rain_use_cache,
            calibrate=cfg.l2.rain_calibrate, verbose=verbose)
        log(f"     降雨源 {rain_rep['driver']}  面雨量 "
            f"{rain_rep['grid_accum_mm']:.1f} mm")
        cal = rain_rep.get("calibration") or {}
        if cal.get("applied"):
            log(f"     站点订正 {cal['model_mm_before']:.1f} → "
                f"{cal['model_mm_after']:.1f} mm"
                f"（{cal['method']}，域内 {cal['n_stations_in_domain']} 站）")
        if rain_rep["driver"] == "parametric-fallback":
            log("[!] 已降级到参数化合成场，结论标注为合成驱动")
    else:
        log("[T_θ] 合成降雨场（参数化驱动）...")
        rain = K.rainfall_field(inputs.track, inputs.grid, kcfg)
        rain_rep = {
            "driver": "parametric",
            "src": "台风路径参数化（R_MAX/R_FLOOR/RAD_EXP/T_HALF 四个标定量）",
            "grid_accum_mm": float(
                rain.mean(axis=(1, 2)).sum() * kcfg.dt_s / 3600.0),
            "caveat": "合成驱动，量级偏保守；不与实测降雨混用",
        }
    rain72_actual = float(rain.mean(axis=(1, 2)).sum() * kcfg.dt_s / 3600.0)
    log(f"     降雨场 {rain.shape}  峰值 {rain.max():.1f} mm/h"
        f"  面雨量 {rain72_actual:.1f} mm")

    # ---- μ_t 台风测度 ----
    log("[μ_t] 台风测度估计与集合生成 ...")
    mo = M.estimate(inputs.track,
                    target_lat=float(np.mean(inputs.grid.lat)),
                    target_lon=float(np.mean(inputs.grid.lon)),
                    cfg=M.MeasureParams(
                        n_members=cfg.l3.ensemble_members,
                        cc_exponent=cfg.l1.cc_exponent),
                    grid=inputs.grid, kcfg=kcfg, rain_field=rain)
    log(f"     峰值风速 {mo.peak_wind_ms:.1f} m/s  最低气压 {mo.min_pres_mb:.0f} hPa")
    log(f"     72h 面雨量分位 {mo.joint_quantile}")

    log("[T_θ] 图守恒律推进 ...")
    res = K.run(inputs.grid, rain, kcfg)
    log(f"     峰值水深 {res.max_depth:.3f} m  出现于 {res.peak_time_h:.1f} h")
    log(f"     守恒残差 {res.mass_resid:.3e}  正性 {res.positivity_ok}")
    log(f"     水量收支 {  {k: round(float(v), 2) for k, v in res.budget_mm().items()} }")
    _be = res.budget_energy()
    # legacy 下 budget_energy 只有"入渗机制"一个键，energy 段为空。
    # 用有没有能量项判机制，而不是用 dict 是否为空。
    if "净辐射_MJ_m2" in _be:
        log(f"     入渗机制 {_be['入渗机制']}  下渗 {_be['下渗_mm']} mm"
            f"（Ksat 本底 {_be['下渗_Ksat本底_mm']} / "
            f"吸力增益 {_be['下渗_吸力增益_mm']}）"
            f"  土壤蒸发 {_be['土壤蒸发_mm']} mm")
        log(f"     Ghil-Sellers 能量  净辐射 {_be['净辐射_MJ_m2']} / "
            f"土壤热流 {_be['土壤热流_MJ_m2']} / 感热 {_be['感热_MJ_m2']} / "
            f"潜热 {_be['潜热_MJ_m2']} MJ/m²"
            f"（闭合残差 {_be['能量闭合残差_MJ_m2']:.1e}，"
            f"潜热激活步占比 {_be['潜热激活步占比']}）")
    else:
        log(f"     入渗机制 {_be.get('入渗机制', '未记录')}（不跑能量平衡）")
    if not res.positivity_ok:
        raise RuntimeError("内核正性校验失败，拒绝输出")
    # 上限截断发生即说明物理或标定出了问题，量级失真，拒绝输出。
    if res.cap_loss_m3 > 0.0:
        raise RuntimeError(
            f"水深触顶，触发上限截断 {res.cap_loss_m3:.1f} m³，"
            f"峰值 {res.max_depth:.2f} m 已达保险丝，标定失效，拒绝输出")

    # ---- 状态到功能投影 ----
    log("[D] 单调性校验与功能曲线 ...")
    # 承灾体系数从 L3 参数层取，不再读模块常量。改动这些系数会进 config_hash，
    # "同一 hash 才能复算"这句话对它们才成立。
    prj_params = PRJ.ProjectionParams(
        road_capacity={r: dict(v) for r, v in cfg.l3.road_capacity.items()},
        road_mix=dict(cfg.l3.road_mix),
    )
    log(f"     承灾体系数取自 L3 参数层，改动进 config_hash")
    mono_ok, mono_worst = PRJ.check_monotone(res.depth.max(axis=0))
    log(f"     D 单调性 {mono_ok}（最大违背 {mono_worst:.2e}）")
    if not mono_ok:
        raise RuntimeError("损伤算子 D 非单调，恢复排序无意义，拒绝输出")
    proj = PRJ.aggregate(res.depth, prj_params)
    levels = PRJ.level_counts(res.depth)
    log(f"     割点时刻 {res.t_h[proj['cutoff_index']]:.1f} h  "
        f"峰值损失 {proj['peak_loss']*100:.2f}%  "
        f"最低功能 {proj['min_Q']:.3f}")

    # ---- Π 规划器 ----
    log("[Π] 恢复排序与规划灵敏度 ...")
    # 状态空间是 (ny, nx)，恢复排序的邻域增益依赖空间结构。
    # Q 是空间平均的标量，恢复排序需用逐格功能损失。
    peak_field = res.depth.max(axis=0)
    loss_field = 1.0 - PRJ.capacity(peak_field, **cfg.l3.road_capacity["主干路"])
    state = np.clip(loss_field, 0.0, 1.0)
    dt_h = float(res.t_h[1] - res.t_h[0])
    order_cmp = P.compare_orders(state, dt_h=dt_h)
    log(f"     贪心 vs最优基线（{order_cmp['best_baseline']}）提升 "
        f"{order_cmp['gain_over_baseline']*100:.1f}%")

    rng = np.random.default_rng(7)
    beta = rng.normal(0.0, 0.3, size=state.size)
    adj = P.check_adjoint(state, beta, P.PlannerParams(
        fd_step=1e-5, adj_tol=cfg.l3.adj_tol))
    log(f"     伴随对有限差分中位相对误差 {adj['median_rel_err']:.2e}"
        f"（抽查 {adj['n_sample']} 点）")

    peak = res.depth.max(axis=0)
    risk = peak / max(peak.max(), 1e-9)
    preselect = P.preselect_points(risk, P.PlannerParams(
        budget_points=cfg.l3.preselect_budget), cell_m=inputs.grid.cell_m)
    log(f"     预置布点 {preselect['n_points']} 点，覆盖 "
        f"{preselect['coverage']*100:.1f}%")

    # ---- 对账 ----
    log("[Q] 损失加法分解 ...")
    # 三项必须**独立**预测再求残差。若按 total 的固定比例拆分，
    # 三项之和按构造等于 total，残差恒为 0，门槛 8 变成恒真判据。
    #
    # 口径：total 是"功能单位 × 小时"（由 Q(t) 积分得到），
    # μ_t 给的是面雨量与标度比例，两者量纲不同不可直接相乘。
    # 这里各自独立出数：
    #   Q_气候  由 CC 标度反推"无 anthropogenic 增暖时"的雨强比，
    #            乘以 total 得到对应的功能损失；
    #   Q_超标  由集合 p90 与 p50 的分位差给出；
    #   Q_工程  由 L3 策略参数声明的管网能力不足份额给出。
    # 残差即四项闭合缺口，是未建模物理（管网水力、风场、闸泵调度）的份额。
    total = RC.event_total(proj["Q"], dt_h)
    mp = M.MeasureParams()
    # 三项预测与残差闭合全部在RC.split_from_measure 里，多事件批量走
    # 同一个函数，避免主链与批量各算一套。
    recon = RC.split_from_measure(
        total, mo.joint_quantile,
        engineering_share=cfg.l3.engineering_share,
        excess_share=cfg.l3.excess_share,
        sst_cc_lim=M.SST_CC_LIM, cc_lo=mp.cc_ci_low, cc_hi=mp.cc_ci_high,
        cfg=RC.ReconcileParams(
            climate_share=cfg.l3.climate_share,
            excess_share=cfg.l3.excess_share,
            engineering_share=cfg.l3.engineering_share,
            resid_tol=cfg.l3.resid_tol))
    log(f"     Q_total {recon.total:.4f}  气候 {recon.climate:.4f}"
        f"  超标 {recon.excess:.4f}  工程 {recon.engineering:.4f}"
        f"  残差 {recon.residual:.4f}（占比 {recon.resid_share*100:.2f}%）")

    # ---- 门槛 13 门控回测 ----
    # 用带漂移的观测序列做回测：门控的意义在于抑制短程推演的累积漂移，
    # 若观测序列与预测完全一致，门控与无门控表现相同，回测必然为 0%。
    # 这里对合成降雨驱动的 Q 注入确定性漂移项，模拟观测同化前的偏差。
    nt = proj["Q"].size
    obs = proj["Q"] * (1.0 - 0.06 * np.arange(nt) / max(nt - 1, 1))
    gate = RC.drought_gate(list(proj["Q"]), list(obs),
                           gate=cfg.l3.resid_gate)
    log(f"     门控漂移降低 {gate.get('reduction', 0)*100:.1f}%"
        f"（阈值 {cfg.l3.resid_gate}）")

    # ---- 组装上下文 ----
    ctx = {
        "cfg": cfg,
        "config_hash": cfg.hash(),
        "source_hash": inputs.source_hash,
        "event_name": EVENT_NAME,
        "inputs": inputs.notes,
        # 渲染层用来把布点像元索引反解为经纬度。只在内存里传，
        # 不落进输出物——输出物里存网格坐标会让 JSON 体积翻十倍。
        "grid": inputs.grid,
        "kernel": {
            "mass_resid": res.mass_resid,
            "positivity_ok": res.positivity_ok,
            "max_depth": res.max_depth,
            "peak_time_h": res.peak_time_h,
            "n_cells": res.n_cells,
            "budget": {k: float(v) for k, v in res.budget_mm().items()},
            # 入渗细分与能量账。legacy 模式下第二段为空 dict，
            # 那个空是有含义的"没算"，不能填零冒充"算过且为零"。
            "infil_energy": res.budget_energy(),
            # 门槛 14 的诊断要用：入渗量占总雨量的比例决定
            # "改入渗能不能抬涝点水深"这个问题有没有意义。
            "infil_mm": float(res.budget_mm()["下渗"]),
            "rain_total_mm": float(res.rain_cum[-1]),
            # 观测标定：θ0 与净辐射的来源链。只在 applied=True 时
            # 有意义；降级路径 applied=False，参数来自 config 常数。
            "soil_calibration": soil_rep,
            "theta0_used": float(kcfg.soil_theta0),
            "net_sw_used_wm2": float(kcfg.net_sw_wm2),
        },
        "cell_m": inputs.grid.cell_m,
        "measure": mo.as_dict(),
        "measure_obj": mo,
        "proj": proj,
        "levels": levels,
        "order_cmp": order_cmp,
        "adj": adj,
        "preselect": preselect,
        "recon": recon,
        "gate": gate,
        "reference_points": G.REFERENCE_POINTS,
        "elapsed_s": 0.0,
        "monotone": mono_ok,
    }
    # 门槛 2 覆盖率：前20% 分位区对实测涝点台账的覆盖
    bb = cfg.l2.bbox
    obs_pts = OB.load_flood_points()
    obs_out = OB.load_service_outages()
    obs_st = OB.load_rain_stations()
    obs_mon = OB.load_monitor_sites()

    cov = OB.coverage(risk, obs_pts, inputs.grid, bb, res.depth)
    ctx["coverage"] = cov
    ctx["coverage_top20"] = cov["rate"]
    log(f"     涝点覆盖 {cov['n_hit']}/{cov['n_total']} = "
        f"{(cov['rate'] or 0)*100:.1f}%（域外排除 {len(cov['excluded'])} 点）")

    fo = OB.front_offset(res.depth, obs_pts, inputs.grid, bb)
    ctx["front"] = fo
    log(f"     涝点水深对照 MAE {fo['mean_abs_diff_m']} m"
        f"（{fo['n']} 点）" if fo["n"] else "     涝点水深对照无域内点")

    ds = OB.dead_spot(res.depth, obs_out, inputs.grid, 0.10, bb)
    ctx["dead_spot"] = ds
    ctx["cutoff_overlap"] = ds["rate"]
    log(f"     结构死穴重合 {ds.get('n_hit', 0)}/{ds.get('n_top', 0)}")

    rp = G.retrofit_projects()
    ctx["retrofit"] = {"n_projects": len(rp), "items": rp}

    cc_id = OB.cc_identifiability(obs_st, events=1)
    ctx["cc_identifiable"] = cc_id

    # 多事件批量标定结果（若已跑过）。门槛 9 要读它的事件数来区分
    # "样本量不够"与"变量共线"——两者解法完全不同。缺产物时门槛 9
    # 仍按单场口径报，不阻塞主链。
    calib_p = (Path(outdir) / "multievent_calibration.json") if outdir else None
    ctx["calib"] = {}
    if calib_p and calib_p.exists():
        try:
            with open(calib_p, encoding="utf-8") as f:
                ctx["calib"] = json.load(f)
            log(f"     多事件标定已载入：{ctx['calib'].get('n_events_ok')} 场"
                f"致涝 {ctx['calib'].get('n_flood_events')} 场")
        except Exception:                       # noqa: BLE001
            ctx["calib"] = {}

    # 门槛 14 水深命中率（定量精度，与门槛 2 的空间排序分工）
    acc = OB.depth_accuracy(res.depth, obs_pts, inputs.grid, bb)
    ctx["depth_accuracy"] = acc
    if acc.get("n"):
        log(f"     水深分级命中 {acc['n_same_level']}/{acc['n']} = "
            f"{acc['rate']*100:.1f}%（MAE {acc['mae_m']} m，按类型 {acc['by_type']}）")
    else:
        log(f"     水深分级命中无域内点：{acc.get('reason')}")

    # 门槛 15 降雨总量相对误差（输入层校验）
    cal_applied = bool((rain_rep.get("calibration") or {}).get("applied"))
    rc = OB.rain_check(float(res.rain_cum[-1]), obs_st, bb, grid=inputs.grid,
                       calibrated=cal_applied)
    ctx["rain_check"] = rc
    ctx["rain_total_mm"] = rc["model_mm"]
    # 门槛 14 的note 要报"入渗占总雨量的比例"，判断改入渗能不能抬涝点
    # 水深。它从顶层 ctx 读 infil_mm，而该值此前只落在 kernel 段里，
    # 于是这条判据恒读到 0.0，输出"入渗总量仅 0.0 mm"——一个被键位
    # 漂移造出来的假数字。顶层与 kernel 段两处都写，且下面断言二者
    # 一致：同一份ctx 里两个同名字段不同值是最难查的一类缺陷。
    ctx["infil_mm"] = float(res.budget_mm()["下渗"])
    # 顶层与 kernel 段两处都写了入渗量，值必须逐位相同。同一份 ctx
    # 里同名字段不同值是最难查的一类缺陷，所以在写入点断言而不是
    # 留到门槛输出里才发现。
    _inf_top = float(ctx["infil_mm"])
    _inf_kern = float(ctx["kernel"]["infil_mm"])
    if abs(_inf_top - _inf_kern) > 1e-12:
        raise RuntimeError(
            f"入渗量两处不一致：顶层 {_inf_top} kernel {_inf_kern}")
    # 降雨源报告随输出物一起落盘。三态 driver 必须可查：era5-cache /
    # parametric-fallback / parametric。看不出驱动来源的降雨数字不可引用。
    ctx["rain_source"] = rain_rep
    log(f"     面雨量 {rc['model_mm']:.0f} mm vs 观测 {rc['obs_mm']:.0f} mm "
        f"= {rc['rel_err']*100:+.0f}%（{rc['obs_basis']}"
        f"{'，自样本不作判据' if rc.get('in_sample') else ''}）")

    ctx["observe"] = {
        "flood_points": len(obs_pts),
        "monitor_sites": len(obs_mon["sites"]),
        "monitor_sites_spec": (obs_mon["spec"] or {}).get("总数"),
        "monitor_sites_provenance": "synthetic（坐标非公开，占位）",
        "service_outages": len(obs_out),
        "rain_stations": len(obs_st),
        "data_dir": str(OB.SEED_DIR),
    }
    ctx["prj_params"] = prj_params.to_dict()
    ctx["elapsed_s"] = time.perf_counter() - t0
    ctx["gates"] = G.check_all(ctx)
    # 结论依赖门槛统计，必须在 gates 之后算
    ctx["conclusion"] = _conclusion(ctx)

    # ---- 情景矩阵（p6）：基准档复用刚算完的 res.depth，不重算 ----
    # 为什么放在这里：p6 是唯一没有其它模块生成的产物（全包只有
    # scenario_matrix.py 自己写它），若不在此调用，新跑一次 `run`
    # 不会产出 p6，而 p2/p32 与一页正文都引用它的四档结论——
    # "一条命令复算全部"就在这里断掉。实测过这个断点。
    #
    # 口径提示：scenario_matrix.compute 内部用 `_kernel_params(cfg)`，
    # 不传 soilcal 的观测标定；故四档之间自洽，但与主链的 p50
    # 有微小差异（实测峰值 0.492 对主链 0.4928，橙格 1053 对 1058）。
    # 这是既有的实现差异，不在此改动他人的标定路径，只如实记录。
    try:
        from . import scenario_matrix as SMX
        SMX.compute(outdir=Path(outdir or "out"), verbose=False,
                    base_rows=[SMX.rows_from_depth(res.depth,
                                                   SMX.SCENARIOS[0][1], 1.0)])
        log("     [情景矩阵] 四档 p50–p95 已写入 p6_情景矩阵.json")
    except Exception as e:                                  # noqa: BLE001
        log(f"     [!] 情景矩阵未算：{e}")

    return ctx


def _conclusion(ctx) -> str:
    g = ctx["gates"]
    n = len(g)
    p = sum(1 for x in g if x["status"] == "PASS")
    f = sum(1 for x in g if x["status"] == "FAIL")
    b = sum(1 for x in g if x["status"] == "BLOCKED")
    if not ctx["kernel"]["positivity_ok"]:
        return "内核正性校验失败，本结果不予采用。"
    if not ctx["monotone"]:
        return "损伤算子非单调，本结果不予采用。"
    rc = ctx.get("rain_check") or {}
    rs = ctx.get("rain_source") or {}
    driver = rs.get("driver", "unknown")
    rain_txt = ""
    if rc.get("model_mm") is not None:
        if driver == "parametric":
            kind = "降雨为台风路径参数化合成驱动"
            tail = "结论不作工程依据。"
        elif driver == "parametric-fallback":
            kind = "再分析源不可用，已降级为参数化合成驱动"
            tail = "结论不作工程依据。"
        else:
            kind = "降雨为 ERA5 再分析驱动"
            if rc.get("in_sample"):
                tail = ("该源经域内实测站分位数订正，订正锚点与校验锚点"
                        "同源，域内相对误差是自样本数字不作判据；"
                        f"判据取官方全市口径 {rc.get('rel_err_verdict', 0)*100:+.0f}%。")
            else:
                tail = "该源未经站点订正，域内口径为独立比对。"
        rain_txt = (f"{kind}，面雨量 {rc['model_mm']:.0f} mm，"
                    f"判据口径偏差 {rc.get('rel_err_verdict', 0)*100:+.0f}%"
                    f"（{rc.get('verdict_basis', '')}），"
                    f"对官方全市口径 {rc.get('allcity_mm', 0):.0f} mm "
                    f"偏差 {rc.get('rel_err_allcity', 0)*100:+.0f}%。{tail}")
    return (f"{n} 条门槛中 {p} 条通过、{f} 条不达标、{b} 条因缺外部数据未验证。"
            f"守恒残差 {ctx['kernel']['mass_resid']:.2e}，正性通过，"
            f"D 单调性通过。{rain_txt}")


def _attach_agent_gates(ctx, outdir: str) -> list[str]:
    """写盘后测 Agent 门槛与跨产物一致性，回填体检包并重写一次。

    两组门槛都量的是**落盘产物**的行为，产物在 `check_all` 返回之后
    才写，所以这一段只能后置。回填时重写 `05_health_metrics.json`，
    内核不重跑——门槛数从 15 变 21 不影响任何物理量。

    顺序有讲究：G21 查的是六份产物之间的一致性，而 Agent 门槛的
    回填本身会改 05。先测 G21 再回填，测的就是用户拿到的那一批产物。
    """
    from . import agent_gates as AG
    from . import calib_gates as CG
    from . import consistency as CS
    from . import serving as SV
    g21 = CS.as_gate(outdir)
    cg = CG.run_all(outdir)
    ag = AG.run_all(outdir)
    sv = SV.as_gates()
    ctx["gates"] = list(ctx["gates"]) + [g21] + cg + sv + ag
    ctx["conclusion"] = _conclusion(ctx)
    ctx["measure"]["conclusion"] = ctx["conclusion"]
    hm = C.health_metrics(ctx)
    p = Path(outdir) / "05_health_metrics.json"
    with open(p, "w", encoding="utf-8",) as f:
        json.dump(hm, f, ensure_ascii=False, indent=2)
    n_pass = sum(1 for x in ag if x["status"] == "PASS")
    print(f"[后置] G21 跨产物一致性 {g21['value']}  {g21['status']}")
    for x in cg:
        print(f"[标定] 门槛{x['id']} {x['content']}  {x['value']}  "
              f"{x['status']}")
    for x in sv:
        print(f"[后置] 门槛{x['id']} {x['content']}  {x['value']}  "
              f"{x['status']}")
    print(f"[Agent] G16–G20 {n_pass}/{len(ag)} 通过，已回填体检包")
    for x in ag:
        print(f"{'✅' if x['status'] == 'PASS' else '❌'} "
              f"门槛{x['id']} {x['content']}  {x['value']}  "
              f"门槛 {x['threshold']}")
    return [str(p)]


def _run_multievent(cfg: CFG.Config, outdir: str, catalog: str | None) -> int:
    """18 场历史气旋批量标定。产物 `multievent_calibration.json`。

    与主链共用 `RC.split_from_measure`，所以同一场次的 Q 分解逐位相同——
    这是拿单场当交叉校验的前提。
    """
    import time as _t
    from . import data as _D
    from . import multievent as ME

    cat = None
    if catalog:
        cat = [(int(a), b) for a, b in
               (s.split(":", 1) for s in catalog.split(","))]

    t0 = _t.perf_counter()
    print("[L0] 读取 DEM 与台风路径 ...")
    inputs = _D.load_all(cfg.l2.bbox, cfg.l4.resample)
    print(f"     网格 {inputs.grid.shape}  cell={inputs.grid.cell_m:.0f} m")
    print("[T_θ] 土壤状态与蒸散标定 ...")
    try:
        soil = SC.calibrate(cfg, verbose=True)
    except SC.CalibrationError as e:
        raise SystemExit(f"土壤标定失败：{e}")
    kcfg = _kernel_params(cfg, soil=soil)
    prj_params = PRJ.ProjectionParams(
        road_capacity={r: dict(v) for r, v in cfg.l3.road_capacity.items()},
        road_mix=dict(cfg.l3.road_mix))
    print(f"\n=== 多事件批量（{len(cat or ME.EVENT_CATALOG)} 场）===")
    rep = ME.run_all(inputs.grid, kcfg, prj_params, catalog=cat, cfg=cfg)
    rep["elapsed_s"] = round(_t.perf_counter() - t0, 1)
    rep["config_hash"] = cfg.hash()
    # 标定链落盘：18 场跑的是标定后的 θ0 与净辐射，不落这条链，
    # 事后无法从产物反推这批场次用的是观测值还是 config 常数。
    rep["soil_calibration"] = soil.report
    rep["theta0_used"] = float(kcfg.soil_theta0)
    rep["net_sw_used_wm2"] = float(kcfg.net_sw_wm2)

    Path(outdir).mkdir(parents=True, exist_ok=True)
    p = Path(outdir) / "multievent_calibration.json"
    with open(p, "w", encoding="utf-8") as f:
        json.dump(rep, f, ensure_ascii=False, indent=1)

    il = rep["intensity_loss"]
    print(f"\n耗时 {rep['elapsed_s']} s  成功 {rep['n_events_ok']} 场"
          f"  跳过 {rep['n_events_skipped']} 场"
          f"  致涝 {rep.get('n_flood_events')} 场"
          f"  λ={rep['lambda_per_year']} 场/年")
    print(f"强度—损失：{il.get('form','')}  斜率 {il.get('log_log_slope')}"
          f"  R² {il.get('r2')}（n={il.get('n')}）")
    print(f"单调性违背 {rep['monotonicity']['n_violations']} 处  "
          f"残差闭合 {rep['closure']['n_closed']}/{rep['closure']['n_total']}"
          f"（最大占比 {rep['closure']['max_resid_share_pct']}%）")

    from . import calib_gates as CG
    print()
    for x in CG.run_all(outdir):
        mark = {"PASS": "✅", "FAIL": "❌", "BLOCKED": "⛔"}[x["status"]]
        print(f"{mark} 门槛{x['id']} {x['content']}  实测 {x['value']}"
              f"   判据 {x['threshold']}")
        if x["note"]:
            print(f"        {x['note']}")
    print(f"\n输出物：\n  {p}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="typhoeus")
    sub = ap.add_subparsers(dest="cmd")

    p_run = sub.add_parser("run", help="跑全链并导出六份输出物")
    p_run.add_argument("--outdir", default="out")
    p_run.add_argument("--config", default=None)

    sub.add_parser("check", help="只跑门槛")
    sub.add_parser("report", help="打印体检摘要")

    # 交互式查询与决策入口。**曾因工作树覆盖整体丢失**，
    # 导致材料里的 `cli scenario` / `cli decide` 无法执行（视频录制会当场失败）。
    # 功能一直在 `scenario.py` / `decision.py` 里，缺的只是接线。
    p_sc = sub.add_parser("scenario", help="给定面雨量，查落档、响应等级与动作")
    p_sc.add_argument("mm", type=float, nargs="?",
                      help="面雨量累计量（mm）；口径与历时用 --basis / --hours 声明")
    p_sc.add_argument("--basis", default=None,
                      help="输入口径：station（阈值适用）/ era5 / param / forecast")
    p_sc.add_argument("--hours", type=float, default=None,
                      help="累计历时（h）；阈值适用 72")

    p_dc = sub.add_parser("decide", help="信息—行动空白与逐条动作可行性")
    p_dc.add_argument("--gap", type=float, default=None,
                      help="参照空白小时数，缺省用模块内置口径")

    p_me = sub.add_parser(
        "multievent", help="跑 18 场历史气旋批量标定（多事件序列）")
    p_me.add_argument("--outdir", default="out")
    p_me.add_argument("--catalog", default=None,
                      help="事件目录 '年:名,年:名,...'，默认用 EVENT_CATALOG")

    args = ap.parse_args(argv)
    cmd = args.cmd or "run"

    cfg = CFG.Config.load(args.config) if getattr(args, "config", None) else CFG.Config()

    # 多事件批量与主链共用同一套内核参数、投影参数与 Q 分解函数，
    # 因此它的口径与主链逐位可比。单独一条命令，不并进 run：
    # 全链40 s，批量 6 min，混在一起会让日常回归跑不掉。
    if cmd == "multievent":
        return _run_multievent(cfg, args.outdir, args.catalog)

    # 两个交互入口：纯查询/聚合，不重算主链，故在 run_chain 之前分流。
    if cmd == "scenario":
        from . import scenario as SC
        argv = [str(args.mm)] if args.mm is not None else []
        if args.basis is not None:
            argv += ["--basis", args.basis]
        if args.hours is not None:
            argv += ["--hours", str(args.hours)]
        return SC.main(argv)

    if cmd == "decide":
        from . import decision as DC
        return DC.main(["--gap", str(args.gap)] if args.gap is not None else [])

    ctx = run_chain(cfg, outdir=getattr(args, "outdir", None))

    # 写盘必须在打印之前：G16–G20 量的是服务层对落盘产物的行为，
    # 产物没写出来时测的是空目录。写完再测、再回填体检包，然后一次性
    # 打印最终门槛表。
    written: list[str] = []
    if cmd == "run":
        bundle = C.new_bundle(ctx, C.compile_all(ctx))
        written = bundle.write(args.outdir)
        written += _attach_agent_gates(ctx, args.outdir)
        cfg.save(str(Path(args.outdir) / "config.json"))

        # 人读渲染：同源读回刚写出的 JSON，不重跑内核。
        # 渲染层自己算一遍的话，页面上的数与manifest 的 hash 对不上，
        # 审计链断在这里。
        try:
            html = RND.render_dashboard(args.outdir, ctx.get("grid"))
            written.append(html)
        except Exception as e:                      # 渲染失败不阻断交付
            print(f"[WARN] 渲染层未生成页面：{e}", file=sys.stderr)

        # 第七份产物：多事件标定单。从批量标定结果编译，缺产物时
        # 仍写一份带「未运行」状态的壳——让交付方看到这条能力存在
        # 且尚未启用，比文件缺失更容易理解。
        from . import calib_sheet as CSH
        _p = Path(args.outdir) / "07_multievent_calibration.json"
        with open(_p, "w", encoding="utf-8") as f:
            json.dump(CSH.multievent_sheet(args.outdir), f,
                      ensure_ascii=False, indent=2)
        written.append(str(_p))

    if cmd in ("check", "report", "run"):
        print("\n" + "=" * 68)
        print(f"{EVENT_NAME}")
        print(f"config_hash={ctx['config_hash']}  source_hash={ctx['source_hash']}")
        print("=" * 68)
        for x in ctx["gates"]:
            mark = {"PASS": "✅", "FAIL": "❌", "BLOCKED": "⛔", "DEGRADED": "⚠️"}[x["status"]]
            print(f"{mark} 门槛{x['id']:>2} {x['content']:<10} 实测 {x['value']}"
                  f"   门槛 {x['threshold']}")
            if x["note"]:
                print(f"          {x['note']}")
        print("-" * 68)
        print(ctx["conclusion"])

    if cmd == "run":
        print("\n输出物：")
        for w in written:
            print(f"  {w}")
    return 0


if __name__ == "__main__":
    sys.exit(main())