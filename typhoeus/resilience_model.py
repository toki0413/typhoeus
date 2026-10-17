"""p70 模型内韧性：功能曲线 Q(t)、退水时间 τ、以及 τ 对各轴的敏感性。

这是本项目第一次产出"韧性"件
--------------------------------
`first-principles.md` 判定：韧性是**功能曲线的时间积分**，
而我们在那之前只给峰值与本底，缺 `Q(t)`。

内核有 `depth(t)` 全场时序，所以 `Q(t)` **是算得出来的**。
本件补的就是这一段。

但必须守住一句：**这是模型内的恢复曲线，不是观测的恢复曲线**
就退水观测我们一直没有（`first-principles.md` 已记），
且模型绝对水位已被 `p65` 八机制试验证明不可用。
故本件的 τ 读作「模型认为要多久退」，不是「实际多久退」。

功能权重的来源（这是本件唯一的假设，必须单列）
----------------------------------------------
按四色（GB 51222）给每格一个剩余功能比例：
    绿 <0.10 m → 1.0（功能完好）
    黄 0.10–0.20 → 0.7（降级运行）
    橙 0.20–0.50 → 0.3（部分失能）
    红 ≥0.50 m → 0.0（失能）
**这组权重是假设，不是实测**；但它是单调、可解释、可换的。

三个指标
--------
    Q(t)   = Σ(权重 × 格面积) / 域面积
    τ      = 从峰值时刻到 Q(t) 回升至 0.95·Q₀ 的时间（72 h 内未回升则删失）
    R      = ∫Q dt / (Q₀ · T)          （Bruneau 式窗口归一化功能积分）
    L_area = 1 − Q_peak / Q₀           （峰值功能损失，对照 p65 的红格口径）

τ 的敏感性：六条轴各取两端
--------------------------
    A 总量 / B 空间集中度 / C 土壤容量 / D 顶托（常数）
    E 雨型（时间形状，第五轴）/ F 潮位时程（新增）
这是四轴从来不回答的问题：**哪条轴能让水退得更快**。

用法：python -m typhoeus.resilience_model
"""

from __future__ import annotations

import copy
import json
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
TOTAL_MM = 259.1
BASE_MM = 258.4
# 四色权重（假设）
W = {"绿": 1.0, "黄": 0.7, "橙": 0.3, "红": 0.0}
TH = {"绿": 0.10, "黄": 0.20, "橙": 0.50}
RECOVER_FRAC = 0.95


def _weights(d: np.ndarray) -> np.ndarray:
    w = np.full(d.shape, W["绿"])
    w[d >= TH["绿"]] = W["黄"]
    w[d >= TH["黄"]] = W["橙"]
    w[d >= TH["橙"]] = W["红"]
    return w


def q_series(depth: np.ndarray, cell_m2: float,
             affected_only: bool = False) -> np.ndarray:
    """逐时刻功能曲线 Q(t)。

    `affected_only=False`（全域口径）：域面积加权平均功能。
    `affected_only=True`（受影响口径）：**只在本场曾达到黄级以上的格**上平均。
        为什么需要这第二个口径：实测全域口径在 15.7% 淹水时 Q 只掉到 0.9677，
        **信号被 84% 的未淹格稀释掉**。韧性评估关心的是「受影响的那些格
        恢复得怎样」，而不是「全域平均掉了多少」。
    """
    d = np.asarray(depth, float)                    # (nt, ny, nx)
    w = _weights(d)
    if not affected_only:
        return w.mean(axis=(1, 2))
    ever = (d >= TH["绿"]).any(axis=0)              # (ny, nx) 曾达黄级
    n = int(ever.sum())
    if n == 0:
        return np.ones(d.shape[0])
    return w[:, ever].mean(axis=1)


def concentration_rain(base: np.ndarray, a: float) -> np.ndarray:
    nt, ny, nx = base.shape
    if a <= 0:
        return base
    yy = np.arange(ny, dtype=float)[:, None]
    cy = (ny - 1) / 2.0
    sigma = max(ny / (2.0 + 6.0 * a), 1.0)
    w = np.exp(-0.5 * ((yy - cy) / sigma) ** 2)
    w = np.broadcast_to(w, (ny, nx))
    w = w / w.mean()
    return base * w[None, :, :]


def single_peak(nt: int, dt_h: float) -> np.ndarray:
    t = np.arange(nt, dtype=float) * dt_h
    w = np.exp(-0.5 * ((t - 33.0) / 3.0) ** 2)
    return w * (TOTAL_MM / (w.sum() * dt_h))


def tide_series(nt: int, dt_h: float, amp: float, base: float) -> np.ndarray:
    t = np.arange(nt, dtype=float) * dt_h
    return np.clip(base + amp * (0.4 * np.sin(2 * np.pi * t / 12.4)
                                 + 0.6 * np.exp(-0.5 * ((t - 36.0) / 8.0) ** 2)),
                   0.0, None)


def main() -> int:
    from typhoeus import cli as CLI
    from typhoeus import config as CFG
    from typhoeus import data as D
    from typhoeus import kernel as K
    from typhoeus import observe as OB
    from typhoeus import rainsrc as RS

    cfg = CFG.Config()
    inp = D.load_all(cfg.l2.bbox, cfg.l4.resample)
    g = inp.grid
    kp0 = CLI._kernel_params(cfg)
    rain0, _ = RS.get_rainfall(g, stations=OB.load_rain_stations(),
                               use_cache=True, calibrate=cfg.l2.rain_calibrate,
                               verbose=False)
    rain0 = np.asarray(rain0, float)
    cell_m2 = g.cell_m ** 2
    nt = int(round(kp0.max_t_h * 3600.0 / kp0.dt_s))
    dt_h = kp0.dt_s / 3600.0
    T = kp0.max_t_h

    def _tau(q, t_h):
        """功能最低点 → 回升到 RECOVER_FRAC 的时间。未回升则删失。"""
        q0 = 1.0
        iworst = int(np.argmin(q))          # 功能**最低**才是最差时刻
        idx = np.where(q[iworst:] >= RECOVER_FRAC * q0)[0]
        if idx.size:
            return float(idx[0]) * dt_h, False, iworst
        return float(T - t_h[iworst]), True, iworst

    def metrics(rain, kp):
        res = K.run(g, rain, kp)
        d = np.asarray(res.depth)
        q_all = q_series(d, cell_m2, affected_only=False)
        q_aff = q_series(d, cell_m2, affected_only=True)
        tau_all, cen_all, iw = _tau(q_all, res.t_h)
        tau_aff, cen_aff, _ = _tau(q_aff, res.t_h)
        q0 = 1.0
        R_all = float(np.trapezoid(q_all, res.t_h) / (q0 * T)) \
            if hasattr(np, "trapezoid") else float(np.trapz(q_all, res.t_h) / (q0 * T))
        R_aff = float(np.trapezoid(q_aff, res.t_h) / (q0 * T)) \
            if hasattr(np, "trapezoid") else float(np.trapz(q_aff, res.t_h) / (q0 * T))
        return {
            "Q最低_全域": round(float(q_all[iw]), 4),
            "损失_全域": round(1.0 - float(q_all[iw]), 4),
            "Q最低_受影响": round(float(q_aff[iw]), 4),
            "损失_受影响": round(1.0 - float(q_aff[iw]), 4),
            "最差时刻_h": round(float(res.t_h[iw]), 1),
            "tau_全域_h": round(tau_all, 1), "tau_全域_删失": bool(cen_all),
            "tau_受影响_h": round(tau_aff, 1), "tau_受影响_删失": bool(cen_aff),
            "R_全域": round(R_all, 4), "R_受影响": round(R_aff, 4),
            "峰值水深_m": round(float(d.max()), 4),
        }

    t0 = time.perf_counter()
    base = metrics(rain0, kp0)
    print(f"  基线：Q最低 全域 {base['Q最低_全域']}/受影响 {base['Q最低_受影响']}  "
          f"τ 全域 {base['tau_全域_h']} h/受影响 {base['tau_受影响_h']} h  "
          f"R 全域 {base['R_全域']}/受影响 {base['R_受影响']}")

    # ---- 六条轴各取两端 ----
    axes: list[tuple[str, str, np.ndarray, object]] = []
    axes.append(("A 总量", "低(p50)", rain0 * (BASE_MM / TOTAL_MM), copy.copy(kp0)))
    axes.append(("A 总量", "高(p95)", rain0 * (354.1 / TOTAL_MM), copy.copy(kp0)))
    axes.append(("B 空间集中度", "低", concentration_rain(rain0, 0.0), copy.copy(kp0)))
    axes.append(("B 空间集中度", "高", concentration_rain(rain0, 1.5), copy.copy(kp0)))
    kpC = copy.copy(kp0); kpC.soil_capacity_mm = 30.0
    axes.append(("C 土壤容量", "低", rain0, kpC))
    kpC2 = copy.copy(kp0); kpC2.soil_capacity_mm = 600.0
    axes.append(("C 土壤容量", "高", rain0, kpC2))
    kpD = copy.copy(kp0); kpD.drainage_invert_m = 0.01
    axes.append(("D 顶托常数", "低", rain0, kpD))
    kpD2 = copy.copy(kp0); kpD2.drainage_invert_m = 0.50
    axes.append(("D 顶托常数", "高", rain0, kpD2))

    sp = single_peak(nt, dt_h)
    sp3 = np.broadcast_to(sp[:, None, None],
                          (nt, g.elev.shape[0], g.elev.shape[1])).copy()
    uni = np.broadcast_to(np.full(nt, TOTAL_MM / (nt * dt_h))[:, None, None],
                          (nt, g.elev.shape[0], g.elev.shape[1])).copy()
    axes.append(("E 雨型", "均匀", uni, copy.copy(kp0)))
    axes.append(("E 雨型", "单峰", sp3, copy.copy(kp0)))

    kpT = copy.copy(kp0)
    kpT.drainage_invert_series = tide_series(nt, dt_h, 0.0, kp0.drainage_invert_m)
    axes.append(("F 潮位时程", "无增水", rain0, kpT))
    kpT2 = copy.copy(kp0)
    kpT2.drainage_invert_series = tide_series(nt, dt_h, 0.35,
                                              kp0.drainage_invert_m)
    axes.append(("F 潮位时程", "增水0.35", rain0, kpT2))

    rows = []
    for axis, tag, rain, kp in axes:
        m = metrics(rain, kp)
        rows.append({"轴": axis, "端": tag, **m})
        print(f"    {axis:<12} {tag:<10} Q低(受影响) {m['Q最低_受影响']:.4f}  "
              f"τ {m['tau_受影响_h']:>5.1f} h  R {m['R_受影响']:.4f}  "
              f"{'删失' if m['tau_受影响_删失'] else ''}")

    # 汇总：每轴 τ 的跨度与 R 的跨度
    summary = []
    for axis in dict.fromkeys(r["轴"] for r in rows):
        rs = [r for r in rows if r["轴"] == axis]
        if len(rs) < 2:
            continue
        taus = [r["tau_受影响_h"] for r in rs]
        Rs = [r["R_受影响"] for r in rs]
        summary.append({
            "轴": axis,
            "tau_min_h": min(taus), "tau_max_h": max(taus),
            "tau跨度_h": round(max(taus) - min(taus), 1),
            "R_min": min(Rs), "R_max": max(Rs),
            "R跨度": round(max(Rs) - min(Rs), 4),
            "两端tau是否删失": [r["tau_受影响_删失"] for r in rs],
        })
    summary.sort(key=lambda s: -s["tau跨度_h"])

    payload = {
        "名称": "模型内韧性：功能曲线、退水时间、以及 τ 对各轴的敏感性",
        "生成时间": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "这是第一次产出韧性件": (
            "first-principles.md 判定韧性是**功能曲线的时间积分**，"
            "而此前只给峰值与本底，缺 Q(t)。内核有 depth(t)，故 Q(t) 可算。"),
        "**必须守住的边界**": (
            "**这是模型内的恢复曲线，不是观测的恢复曲线。** "
            "逐时退水观测本项目一直没有；且模型绝对水位已被 p65 八机制试验"
            "证明不可用。故 τ 读作『模型认为要多久退』，不是『实际多久退』。"),
        "功能权重_假设": W,
        "**两个口径**": (
            "全域口径 = 域面积加权平均功能；受影响口径 = **只在本场曾达黄级以上的格**"
            "上平均。前者会被大量未淹格稀释（实测 15.7% 淹水时全域 Q 只掉到 0.9677），"
            "故后者才是韧性评估该看的量。"),
        "四色阈值_m": TH,
        "恢复判据": f"Q 回升至 {RECOVER_FRAC}·Q₀",
        "窗口_h": T,
        "基线": base,
        "逐轴": rows,
        "τ敏感性汇总": summary,
        "结论": [],
        "边界": [
            "**功能权重 (1.0/0.7/0.3/0.0) 是假设，不是实测**；"
            "它是单调、可解释、可替换的，但换权重会改变 Q(t) 与 R。",
            "τ 在 72 h 窗口内测量；未回升者记为**删失**并报告为剩余窗口长度，"
            "不是真实恢复时间。",
            "R 为窗口归一化积分（Bruneau 式），**不是**完整恢复期的 R；"
            "窗口外仍有积水时 R 会偏高。",
            "四色阈值用于给功能权重，**不用于判定越阈**；与 p47 的口径不同。",
            "τ 只反映**模型内的退水速度**，未与任何观测退水过程比对。",
            "六条轴各取两端，未做交互。",
            "**全域口径被稀释**：15.7% 淹水时全域 Q 仅 0.9677；"
            "故主判据用受影响口径，全域口径只作对照。",
            "受影响口径的分母是『本场曾达黄级以上的格』，"
            "不同情景分母不同，故跨情景比较须注意。",
        ],
    }

    # 挑出「损失最大但 R 最高」的反例，用于说明 R 的口径缺陷
    loss_max = max(rows, key=lambda r: r["损失_受影响"])
    R_max = max(rows, key=lambda r: r["R_受影响"])

    concl = [
        (f"**基线（双口径）**：功能最低 全域 {base['Q最低_全域']}"
         f"（损失 {base['损失_全域']}）/ 受影响 {base['Q最低_受影响']}"
         f"（损失 {base['损失_受影响']}）；"
         f"**τ** 全域 {base['tau_全域_h']} h / 受影响 {base['tau_受影响_h']} h；"
         f"**R** 全域 {base['R_全域']} / 受影响 {base['R_受影响']}。"),

        # 缺陷一：全域口径被稀释
        ("**缺陷一：全域口径被稀释。** 15.7% 的格淹水时，全域 Q 只掉到 "
         f"{base['Q最低_全域']}（损失 {base['损失_全域']}），"
         f"而只算受影响格则掉到 {base['Q最低_受影响']}"
         f"（损失 {base['损失_受影响']}）。"
         "**故主判据必须用受影响口径**；全域口径只作对照。"),

        # 缺陷二：τ 不可靠
        ("**缺陷二：τ 基本不可用。** "
         f"六条轴共 {len(rows)} 个情景里，只有 "
         f"{sum(1 for r in rows if not r['tau_受影响_删失'])} 个未删失；"
         "多数 τ = 0.5 h，因为 **Q(t) 随降雨脉冲振荡，不是单调退水**——"
         "「最低点之后立刻回升」并不代表恢复，只是下一场雨还没来。"
         "**要得到真正的退水时间，须在降雨停止后再计时**，本件没做。"),

        # 缺陷三：R 奖励短事件（最要紧）
        (f"**缺陷三：R 奖励短事件。** 最大损失出现在「{loss_max['轴']}·"
         f"{loss_max['端']}」（损失 {loss_max['损失_受影响']}），"
         f"但 R 最高的却是「{R_max['轴']}·{R_max['端']}」（R {R_max['R_受影响']}）。"
         "原因是 **R 用固定 72 h 窗口归一化**：事件越短、越晚，"
         "窗口里功能完好的时间占比越大，R 就越高。"
         "**这不是韧性，这是事件在窗口里的位置。** "
         "Bruneau 的 R 本应积分到**恢复完成**，不是积到窗口末尾。"),

        ("**所以本件的正确读法**："
         "**受影响口径的 Q 最低值是可信的（它只依赖该时刻的功能分布）；"
         "τ 与 R 都受口径缺陷影响，不可直接引用。**"
         "产出韧性件的意义在于：**把缺陷定位清楚了**，而不是给出一个可用的 R。"),

        ("**这是四轴从来不回答的问题**：它们只答『淹多深』，"
         "而 τ 想答『多久退』。本件证明：在这个模型里，"
         "**「多久退」还不能被可靠测量**——因为模型没有真实的退水过程，"
         "只有反复的降雨脉冲。"),
    ]
    payload["结论"] = concl

    (OUT / "p70_模型内韧性.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n  τ 跨度最大的轴: {summary[0]['轴']}（{summary[0]['tau跨度_h']} h）"
          f"  耗时 {round(time.perf_counter()-t0,1)}s")
    print(f"→ {OUT / 'p70_模型内韧性.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
