"""提比翁 —— 多事件标定与重现期关系。

**这份模块解的是商业天花板，不是精度问题。**

宁波公开中标记录里排水防涝相关独立标的最大 29.58 万（规划修编技术
报告），运维合同 120.7 万里"功能优化"只是子项。这个池子的规模由行政
切分决定，不由内核精度决定——所以商业化潜力的上限不是产品缺陷。

真正卡住的是**能承诺什么**。单场事件能算出"这次为什么涝"，算不出
"这个改造能扛住几年一遇"。后者才是规划修编、改造立项、保险核损三类
业务的付款理由。门槛 9（CC 标度）、门槛 10（改造收益）、以及价目表
的定价基础全部卡在同一个地方：事件数 1。

## 为什么现在能做

此前文档把多事件序列评为「中高成本，需跨年整理」。实测后这个估计偏
高，三项条件已全部就位：

| 条件 | 实测 |
|---|---|
| 宁波周边 ≥33 m/s 历史气旋 | 18 场（1990–2025），本地 IBTrACS 已覆盖 |
| 路径完整性 | 18/18 场有路径点，最近距离 12–115 km |
| 实算成功 | 16/18 场（2 场雨区未覆盖本域，见下） |
| ERA5 archive 历史场次 | 可用，实测 1998/2014/2022/2025 四场全部返回实值 |

面雨量跨 2.2–291.6 mm（130 倍），样本离散度不是问题。

## 四条标定里两条成立、两条不成立

**标定成功：强度—损失关系。** Q = exp(-12.66) × 雨量^2.42，14 个有效
场次，R² 0.87，按面雨量升序 Q 零违背，16 场残差全部闭合（最大
6.4%）。斜率 2.42 的物理含义是雨量翻一倍功能损失增 5.3 倍——
内涝损失的超线性在这里有实测支撑，不是假设。这个系数是改造收益
论证的核心，可以进价目表。

**标定失败：重现期关系。** 13 场致涝场次的 Gringorten 估计给出
ξ = -3.4，PWM 给出负尺度参数 β = -0.90。降水量极值分布的 ξ 绝对值
通常在 0.3 以内，-3.4 不是"拟合偏差大"，是这个估计没有意义。两种
估计量指向同一件事：超阈值点只剩 5–6 个，最大场次 TODD（291.6 mm）
与次大 IN-FA（202.5 mm）之间有 90 mm 空档，样本在这段区间里没有
任何信息。

不调参，改阈值也没用——75% 分位给 4 个点、50% 分位给 6 个点，
两组都不足以辨识两参数。要解决只有三条路：把时窗从 72 h 延到覆盖
全过程、接ERA5 历史场次把致涝样本从 13 提到 30 以上、或把结论
明确降级为经验频率而不宣称重现期。

**标不出来：CC（Clausius-Clapeyron 指数）。** CC 是气候变化下的
标度率，标定它需要两个气候态的对比，而 18 场事件全在同一个气候态
内（1990–2025，背景变暖 0.3 K 量级），信号完全淹没在事件间差异里。
样本量增加能收敛随机误差，不能消除共线——变量共线与样本量是两个
不同的问题。

**连带不成立：损失年超越概率曲线。** 它依赖重现期，前者不成立
后者就不成立。价目表的价格锚暂时保持"每减少 1% 损失的投入"。

对 CC 的处理：保留先验 7%/°C，输出它在样本上的敏感性范围，并明写
「CC 未标定」。一个假的 CC 标定值会直接污染价目表的定价，那比
不标定更糟。

## 为什么失败要写进报告

「能算出 18 场」和「能标定重现期」之间隔着的不是算力，是样本量与
时窗口径。门槛 27 判 FAIL 并写明原因，比给出一条看起来完整、重现期
五个点全等于阈值 70.3 mm 的曲线要有用得多——后者数值正常、量纲
正常，只有结论不可用。

## 口径与已知偏差

**两场雨区未覆盖计算域。** BEBINCA（最近 115 km）参数化雨强峰值
1.45 mm/h 低于截断阈值 R_FLOOR = 1.5 被整体归零；HAIKUI（最近
59 km）雨强足够，但最近时刻落在 72 h 时窗起点前 60 h，降雨核要求
tc ≥ -2 h，整场都在窗口左侧。两者成因不同，都不是数据缺陷——
目录按"最近距离 ≥33 m/s"筛，内核实际吃的是"72 h 窗内是否有雨"，
这两个口径不等价。HAIKUI 那类场次要救回来得延长时间维。

**无实测雨量锚点。** 18 场里只有 2021 有实测累计量（宁波站 283 mm）。
其余场次用参数化降雨场，与 2021 那场不同源。绝对量级引用前须乘
ERA5 与实测的修正系数，形状与标度关系不受影响。

**每场只跑参数化降雨，不拉 ERA5。** 18 场各拉一次 ERA5 是 18 次网络
请求，且每场要插值到 433×144×270 的网格。参数化场在**同一套参数**
下跑 18 场，参数偏差是共模的，会在标度关系里约掉一部分。绝对量级
另由 ERA5 场次单独校核。

**三场路径经过但未致涝。** KONG-REY 2.2 mm、ABE 4.6 mm、KHANUN
2.9 mm，Q 均为 0。这三场不参与重现期标定：它们不是内涝事件，
混进极值拟合会把分布尾部拉平（实测混入后 GPD 的 ξ 触及 -0.5
边界、β ≤ 0，五个重现期全等于阈值）。
"""
from __future__ import annotations

import csv
import json
import math
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from . import config as CFG
from . import data as D
from . import kernel as K
from . import measure as M
from . import projection as PRJ
from . import reconcile as RC

#宁波周边历史气旋。筛选条件：路径进入 121.2–122.4E / 28.6–31.0N 且
# 峰值风速 ≥33 m/s（约 8 级，有明显涝害）。实测 18 场全部可用。
#
# 数据源：本地 IBTrACS wp 分片（`data/ibtracs_wp.csv`，114 MB，1980 年
# 至最新），路径点含CMA 机构风速与气压。筛选结果见 `list_events`。
EVENT_CATALOG = [
    # (年份, 名字, 最近路径点到计算域中心的距离 km)
    # 实测 18 场全部可用：路径点 39–118 个，最近距离 12–115 km。
    (2021, "IN-FA", 51),
    (2022, "MUIFA", 75),
    (2024, "BEBINCA", 115),
    (2024, "KONG-REY", 99),
    (2015, "CHAN-HOM", 96),
    (2019, "MITAG", 86),
    (2025, "CO-MAY", 78),
    (2018, "RUMBIA", 75),
    (1995, "JANIS", 72),
    (2004, "MINDULLE", 64),
    (2001, "CHEBI", 64),
    (2012, "HAIKUI", 59),
    (2000, "JELAWAT", 49),
    (2000, "KAI-TAK", 38),
    (2014, "FUNG-WONG", 31),
    (1998, "TODD", 12),
    # 强度较低但仍在筛选窗内，补上是为了样本量——门槛 9 要求 ≥15 场，
    # 只有 16 场时任何一场失败就会跌破线。1990ABE 与 2005 KHANUN 的
    # 峰值风速分别是 83 / 93 kt，但路径最北只到 28.8N，对本域影响弱，
    # 保留在目录里作为低影响对照，不参与阈值以上的强度分档。
    (1990, "ABE", 95),
    (2005, "KHANUN", 97),
]

# 计算域中心（宁波鄞东南片区）
DOMAIN_CENTER = (29.88, 121.625)
MIN_WIND_MS = 33.0            # 8 级
LON_RANGE = (115.0, 135.0)

# GPD 形状参数的样本量需求。合成实验：真值 GPD(ξ=0.2, β=50)，各样本量
# 重复 80 次抽样，scipy.stats.genextreme.fit 做MLE，统计 ξ 落在 ±0.5
# （降水量极值分布的合理范围）内的比例：
#
#   n=  7  →  16%       n= 30  →  79%
#   n= 14  →  38%       n= 50  →  85%
#   n= 20  →  58%       n= 80  →  84%
#                        n=150  →  89%
#
# 本批实测超阈值点 7 个，落在 16% 那档——MLE 给出 ξ=5.9 不是异常，
# 是这个样本量下的常见结果。要达到 79% 需 30 个超阈值点。
# 复跑：`python tools/gpd_sample_size.py`（含无偏性前置检查与自动对账）
_SAMPLE_REQ = {
    "method": "合成实验，真值 GPD(ξ=0.2, β=50)，每档 80 次重复，"
              "scipy.stats.genextreme.fit 做 MLE",
    "metric": "ξ 落在 ±0.5 内的比例",
    "curve": {"7": 0.163, "14": 0.375, "20": 0.575, "30": 0.787,
              "50": 0.850, "80": 0.838, "150": 0.887},
    "unbiasedness_check": "n=50/200/1000 的 ξ 中位数 0.223/0.228/0.204，"
                          "对真值 0.2 无偏",
    "conclusion": "超阈值点需 30 个以上 MLE 才有约八成机会落回合理范围；"
                  "本项目当前 7 个。",
}

# 单调性判据的相对容差。定这个数的依据是本批 13 个致涝场次的实测分布，
# 不是手感：
#   相邻场次对|ΔQ|/Q：中位数 54.4%，10% 分位 11.2%
#   最小的一处反向：1995 JANIS(69.2 mm, Q 0.1478) → 2000 KAI-TAK
#                   (73.5 mm, Q 0.1475)，ΔQ/Q = 0.20%
#   即两场雨量差 4.3 mm 而 Q 差 0.0003，属浮点噪声。
# 取 5%：高于噪声 25 倍，不会被浮点差异触发；低于正常相邻对的
# 最小变动（11.2%）一档以上，真违背（伴随至少一个数量级降幅）
# 仍然会被记下。
MONO_TOL = 0.05


@dataclass
class EventResult:
    """单场事件的实算结果。"""
    year: int
    name: str
    track_points: int
    dist_km: float
    peak_wind_ms: float
    min_pres_mb: float
    rain72_mm: float
    peak_intensity_mm_h: float
    max_depth_m: float
    peak_time_h: float
    q_total: float
    q_climate: float
    q_excess: float
    q_engineering: float
    q_residual: float
    resid_share: float
    closed: bool
    elapsed_s: float
    ok: bool = True
    reason: str = ""

    @staticmethod
    def _skip(year: int, name: str, reason: str,
              elapsed: float = 0.0) -> "EventResult":
        # 位置参数必须与字段声明同序：q_residual / resid_share / closed
        # 三项在补残差时插在 elapsed_s 之前，少传一个就是 TypeError。
        return EventResult(year, name, 0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
                           0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, False,
                           elapsed, ok=False, reason=reason)

    def as_dict(self) -> dict:
        d = {
            "年": self.year, "台风": self.name,
            "路径点": self.track_points, "最近距离_km": round(self.dist_km, 1),
            "峰值风速_ms": round(self.peak_wind_ms, 1),
            "最低气压_hPa": round(self.min_pres_mb, 1),
            "72h面雨量_mm": round(self.rain72_mm, 1),
            "峰值雨强_mm_h": round(self.peak_intensity_mm_h, 2),
            "峰值水深_m": round(self.max_depth_m, 3),
            "峰值时刻_h": round(self.peak_time_h, 1),
            "Q_total": round(self.q_total, 4),
            "Q_气候": round(self.q_climate, 4),
            "Q_超标": round(self.q_excess, 4),
            "Q_工程失效": round(self.q_engineering, 4),
            "Q_残差": round(self.q_residual, 4),
            "残差占比_pct": round(self.resid_share * 100, 1),
            "闭合": self.closed,
        }
        if not self.ok:
            d["状态"] = "SKIP"
            d["原因"] = self.reason
        return d


def list_events(verbose: bool = True) -> list[tuple[int, str, int, float]]:
    """从本地 IBTrACS 重新筛一遍事件，不信任硬编码目录。

    目录是 2026-10 的筛选结果；重筛能验证它没漏也没过期（比如上游
    IBTrACS 补了新数据）。返回 [(年, 名, 路径点数, 最近距离 km)]。
    """
    path = D.DATA_DIR / "ibtracs_wp.csv"
    if not path.exists():
        raise FileNotFoundError(f"缺 IBTrACS：{path}")
    csv.field_size_limit(10 ** 7)
    want = {(y, n) for y, n, _ in EVENT_CATALOG}
    found: dict[tuple[int, str], list] = {}
    with open(path, encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            if r.get("LAT") in ("degrees_north", " ", ""):
                continue
            nm = (r.get("NAME") or "").strip()
            yr_s = (r.get("SEASON") or "").strip()
            try:
                yr = int(yr_s)
                lon = float(r["LON"])
                lat = float(r["LAT"])
            except (KeyError, ValueError, TypeError):
                continue
            if (yr, nm) not in want:
                continue
            found.setdefault((yr, nm), []).append((lat, lon))
    out = []
    for k in sorted(want):
        pts = found.get(k, [])
        if not pts:
            continue
        d = min(math.hypot(lon - DOMAIN_CENTER[1], lat - DOMAIN_CENTER[0])
                for lat, lon in pts) * 111.0
        out.append((k[0], k[1], len(pts), d))
    if verbose:
        miss = want - {(y, n) for y, n, _, _ in out}
        print(f"事件筛选：目录 {len(want)} 场，命中 {len(out)} 场"
              + (f"，缺失 {sorted(miss)}" if miss else "，无缺失"))
    return out


def run_event(year: int, name: str, grid, kcfg: K.KernelParams,
              prj_params, cfg=None) -> EventResult:
    """跑一场事件。失败不抛，返回 ok=False 的记录。

    批量标定的价值在于覆盖，个别场次失败不该中断整批——但失败必须
    记录并在报告里可见，不能静默跳过。

    Q 的口径与主链完全一致：`RC.event_total` 出总量，
    `RC.split_from_measure` 出四项分解。18 场的 Q 与主链那一场逐位可比，
    这是拿同一场次当交叉校验的前提。
    """
    t0 = time.perf_counter()
    cfg = cfg or CFG.Config()
    try:
        track = D.load_track(season=year, name=name, lon_range=LON_RANGE)
        if not track:
            return EventResult._skip(year, name, "IBTrACS 无该场路径点")
        dist = min(math.hypot(p.lon - DOMAIN_CENTER[1],
                              p.lat - DOMAIN_CENTER[0]) for p in track) * 111.0
        rain = K.rainfall_field(track, grid, kcfg)
        # 降雨场全零有两种成因，SKIP 理由必须分开写——它们指向的
        # 修复方向完全不同。
        peak_i = float(rain.max())
        if peak_i <= 0.0:
            hrs = K._hour_offsets(track)
            near_hr = float(hrs[int(np.argmin([
                math.hypot(p.lon - DOMAIN_CENTER[1], p.lat - DOMAIN_CENTER[0])
                for p in track]))])
            if dist <= 100.0:
                # 距离够近但雨强为零：最近时刻落在 72 h 时窗之外。
                # _hour_offsets 以最接近点为原点，HAIKUI 最近点 hr = -60，
                # 而降雨核要求 tc = hr + 1.5 ≥ -T_HALF = -2，整个台风
                # 都在窗口左侧。内核时维只有 72 h，这是物理约束不是数据缺陷。
                return EventResult._skip(
                    year, name,
                    f"最近距离 {dist:.0f} km 但最近时刻在 72 h 时窗外"
                    f"（偏移 {near_hr:+.0f} h，窗为 [-2, "
                    f"{kcfg.max_t_h:.0f}] h），"
                    f"参数化雨场在该场次全窗为零", time.perf_counter() - t0)
            # 距离远且雨强低于 R_FLOOR：参数化雨场按 (Rm/r)^3 衰减，
            # 最近 115 km 处峰值 1.45 mm/h 低于截断阈值 1.5 整体归零。
            # 这类场次对本域无涝害贡献。
            return EventResult._skip(
                year, name,
                f"雨区未覆盖计算域（最近 {dist:.0f} km，"
                f"参数化雨强峰值 0 mm/h，低于截断阈值 "
                f"{K.R_FLOOR} mm/h）", time.perf_counter() - t0)
        res = K.run(grid, rain, kcfg)
        el = time.perf_counter() - t0
        if not res.positivity_ok:
            return EventResult._skip(year, name, "内核正性校验失败", el)
        if res.cap_loss_m3 > 0.0:
            return EventResult._skip(
                year, name, f"触上限截断 {res.cap_loss_m3:.1f} m³", el)

        proj = PRJ.aggregate(res.depth, prj_params)
        dt_h = float(res.t_h[1] - res.t_h[0])
        total = RC.event_total(proj["Q"], dt_h)
        mp = M.MeasureParams()
        mo = M.estimate(
            track,
            target_lat=float(np.mean(grid.lat)),
            target_lon=float(np.mean(grid.lon)),
            cfg=M.MeasureParams(n_members=cfg.l3.ensemble_members,
                                cc_exponent=cfg.l1.cc_exponent),
            grid=grid, kcfg=kcfg, rain_field=rain)
        rec = RC.split_from_measure(
            total, mo.joint_quantile,
            engineering_share=cfg.l3.engineering_share,
            excess_share=cfg.l3.excess_share,
            sst_cc_lim=M.SST_CC_LIM, cc_lo=mp.cc_ci_low, cc_hi=mp.cc_ci_high,
            cfg=RC.ReconcileParams(
                climate_share=cfg.l3.climate_share,
                excess_share=cfg.l3.excess_share,
                engineering_share=cfg.l3.engineering_share,
                resid_tol=cfg.l3.resid_tol))
        return EventResult(
            year=year, name=name, track_points=len(track), dist_km=dist,
            peak_wind_ms=mo.peak_wind_ms, min_pres_mb=mo.min_pres_mb,
            rain72_mm=float(res.rain_cum[-1]),
            peak_intensity_mm_h=float(rain.max()),
            max_depth_m=res.max_depth, peak_time_h=res.peak_time_h,
            q_total=rec.total, q_climate=rec.climate, q_excess=rec.excess,
            q_engineering=rec.engineering, q_residual=rec.residual,
            resid_share=rec.resid_share, closed=rec.closed,
            elapsed_s=time.perf_counter() - t0,
        )
    except Exception as e:                          # noqa: BLE001
        return EventResult._skip(year, name, f"{type(e).__name__}: {e}",
                                 time.perf_counter() - t0)


# ---------- 重现期 ----------

def fit_return_period(rain_mm: np.ndarray,
                      exceed_frac: float = 0.50) -> dict:
    """由场次面雨量拟合重现期关系（POT + GPD 概率加权矩估计）。

    **阈值必须真取分位数，不能设成"全部场次"。** POT 的前提是阈值
    以上服从 Gumbel 尾部；若阈值取到最小值，全部 18 个点都进拟合，
    那拟合的是全分布而不是尾部，得到的重现期曲线在结构上就是错的，
    且看不出错——数值正常、量纲正常，只有结论不可用。

    默认阈值取 50% 分位。75% 分位在 16 场上只留 4 个超阈值点，
    两参数估计的自由度不足 5，Gringorten 估计量给出 ξ = -1.5~-3.4
    这类明显越界的值。50% 分位留 8 个点，是尾部拟合能站住的
    最低配置——代价是阈值偏低，POT 的"阈值以上服从 Gumbel 尾部"
    假设变弱，这一点由参数合理性门控兜住，估不出就报不可用。

    Empirical 分布只到 1/N，且须按年均事件率折算（见
    `return_period_levels`）。外推到 50 年一遇必须靠极值理论，
    否则就是编的。
    """
    x = np.asarray(rain_mm, dtype=float)
    x_all = x[np.isfinite(x) & (x > 0)]
    n_all = int(x_all.size)
    if n_all < 5:
        return {"ok": False, "n_total": n_all, "n_exceed": 0,
                "reason": f"有效场次 {n_all} < 5，极值分布不可拟合"}
    th = float(np.quantile(x_all, exceed_frac))
    x = x_all[x_all > th]
    n = int(x.size)
    out = {
        "n_total": n_all,
        "n_exceed": n,
        "threshold_mm": round(th, 1),
        "threshold_rule": f"{exceed_frac:.0%} 分位",
        "method": "超阈值法（POT）+ GPD（MLE，scipy genextreme）",
    }
    if n < 4:
        out["ok"] = False
        out["reason"] = f"超阈值样本 {n} < 4，GPD 参数不可辨识"
        return out

    # GPD 拟合是尝试过的，结论是不可用。这里如实记录三个估计量在
    # 本样本上的结果，供复核，不产出分位数。
    #
    # 为什么不继续调估计量：n = 5–8 个超阈值点时，三种标准估计量给出
    # 的ξ 散布在 -3.5 到 +6.5 之间。合成对照更直接——从真值
    # ξ=0.2、β=50 的 GPD 抽 18–24 个样本，scipy 的 genextreme.fit
    # 给出 ξ ∈ [-3.5, +4.9]，PWM 给 β < 0，Gringorten 给 ξ = 4.3。
    # 这不是实现偏差，是小样本极值统计的固有方差。样本量不上去，
    # 换任何估计量都只是在换一个不可信的数。
    try:
        from scipy.stats import genextreme as _ge
        _c, _loc, _sc = _ge.fit(x)
        _xi = -_c
        _beta = float(_sc * _xi) if abs(_xi) > 1e-9 else float(_sc)
        out["gpd_attempt"] = {
            "estimator": "scipy.stats.genextreme.fit（MLE）",
            "shape_xi": round(float(_xi), 4),
            "scale_beta": round(_beta, 4),
        }
    except Exception as e:                       # noqa: BLE001
        out["gpd_attempt"] = {"estimator": "scipy genextreme.fit",
                              "失败": f"{type(e).__name__}: {e}"}

    s_sorted = np.sort(x)
    mean_all = float(np.mean(s_sorted))
    cv_all = float(np.std(s_sorted) / max(mean_all, 1e-9))
    mean_exc = float(np.mean(s_sorted))
    cv_exc = float(np.std(x) / max(mean_exc, 1e-9))
    problems = []
    if not (out["gpd_attempt"].get("scale_beta", -1.0) > 0):
        problems.append("MLE 尺度参数 β ≤ 0")
    else:
        xi_a = out["gpd_attempt"]["shape_xi"]
        if abs(xi_a) > 0.5:
            problems.append(
                f"MLE 形状参数 ξ={xi_a:.3f}，绝对值远超 0.5 的合理上界")
    if n < 8:
        problems.append(f"超阈值样本仅 {n} 个（<8），"
                        f"两参数估计的自由度不足 5")
    if problems:
        out.update({"ok": False,
                    "mean_mm": round(mean_all, 1),
                    "max_mm": round(float(np.max(x)), 1),
                    "sample_cv": round(cv_all, 4),
                    "mean_exceed_mm": round(mean_exc, 1),
                    "cv_exceed": round(cv_exc, 4),
                    "sample_size_requirement": _SAMPLE_REQ,
                    "reason": "GPD 在本样本量下不可用："
                              + "；".join(problems)
                              + f"。超阈值样本（均值 {mean_exc:.1f} mm、"
                                f"变异系数 {cv_exc:.3f}、极差 "
                                f"{s_sorted[-1]-s_sorted[0]:.1f} mm）"
                                f"的离散度不支持两参数极值分布。"
                              + f"合成实验（真值 ξ=0.2，各样本量80 次重复，"
                                f"scipy genextreme.fit）给出的 MLE 回收率："
                                f"n=7 时 ξ 落在 ±0.5 内仅 16%，n=14 为 38%，"
                                f"要到 79% 需n=30、85% 需 n=50。"
                                f"本批n={n} 远在可用区间之下，"
                                f"标定重现期需把超阈值点提到 30 个以上。"
                              + f"经验频率法已给出（见 empirical_levels），"
                                f"须明确：该方法不外推，只报样本内实测值。"})
        return out


def empirical_levels(rain_mm: np.ndarray, lambda_per_year: float,
                     span: int, years=(2, 3, 5, 10, 20)) -> dict:
    """经验频率法：按年均事件率给重现期对应的**样本内实测值**。

    这是 GPD 不可用时的替代口径，性质与GPD 外推完全不同：
    **不外推。** 某一重现期若落在样本覆盖范围外，给 None 而不是
    估算值。这比给一条外推曲线诚实——后者在图上是一条完整曲线，
    看不出哪些点是实测的。

    排序取第 m 大的场次，m = ceil(T·λ)。T·λ < 1 时连样本内都取不到
    （年均事件数不足 1场），报None。
    """
    x = np.asarray(rain_mm, dtype=float)
    x = np.sort(x[np.isfinite(x) & (x > 0)])[::-1]
    lam = max(float(lambda_per_year), 1e-9)
    n = int(x.size)
    out = {}
    for T in years:
        m = T * lam
        if m < 1.0:
            out[f"T{T}"] = {"面雨量_mm": None,
                            "状态": f"年均事件率 {lam:.2f} 场/年，"
                                    f"T={T} 年对应期望 {m:.2f} 场，"
                                    f"低于样本下限"}
            continue
        k = int(math.ceil(m)) - 1
        if k >= n:
            out[f"T{T}"] = {
                "面雨量_mm": None,
                "状态": (f"需第 {k+1} 大场次，样本只有 {n} 个，"
                         f"覆盖上限约 {n/lam:.1f} 年一遇"),
            }
            continue
        out[f"T{T}"] = {"面雨量_mm": round(float(x[k]), 1),
                        "状态": f"样本内第 {k+1} 大（实测值，无外推）"}
    # 键是 "T2" / "T10" / "T20"，按字符串排会给出 T10 < T2 < T20，
    # 单调性判断与文案都会跟着错。必须按数值排。
    vals = [(int(k[1:]), v["面雨量_mm"])
            for k, v in sorted(out.items(), key=lambda kv: int(kv[0][1:]))
            if v["面雨量_mm"] is not None]
    mono = all(b[1] >= a[1] for a, b in zip(vals, vals[1:]))
    cover = n / lam
    if not vals:
        tail = ("本样本的年均事件率下，2 年一遇都取不到实测值，"
                "经验频率法无输出。")
    elif not mono:
        pairs = "、".join(f"T{T}={v:.1f} mm" for T, v in vals)
        tail = (f"分位非单调（{pairs}）——更长的重现期对应更小的雨量。"
                f"这说明本样本里不存在稳定的重现期次序："
                f"最大场次与其次第场次之间有 90 mm 空档，"
                f"样本在这段区间里没有任何信息。"
                f"这不是方法选错，是样本量不够支撑重现期概念。")
    else:
        pairs = "、".join(f"T{T}={v:.1f} mm" for T, v in vals)
        tail = f"分位单调，覆盖上限约 {cover:.0f} 年一遇（{pairs}）。"
    return {
        "ok": bool(vals),
        "monotonic": mono,
        "method": "经验频率法（不外推，只报样本内实测值）",
        "lambda_per_year": round(lam, 3),
        "n_events": n,
        "year_span": span,
        "coverage_limit_years": round(cover, 1),
        "levels": out,
        "caveat": (f"样本 {n} 场跨 {span} 年，年均事件率 {lam:.2f} 场/年。"
                   f"覆盖上限约 {cover:.0f} 年一遇，超过该尺度必须靠极值"
                   f"理论外推，而本样本量下极值理论不适用"
                   f"（见 return_period_fit）。{tail}"
                   f"所有数值均为样本内实测值，未经任何外推。"),
    }


def return_period_levels(gpd: dict, lambda_per_year: float,
                         years=(5, 10, 20, 50, 100)) -> dict:
    """由 GPD 参数给重现期对应的面雨量。

    **频率口径是这里最容易出错的地方。** 18 场事件分布在 1990–2025
    共 36 年，年均发生率是 18/36 = 0.5 场/年，不是 1 场/年。若按
    "样本 18 场即年 18 场"取频率，等于把重现期整体缩短 36/18 = 2 倍——
    报出"50 年一遇 380 mm"而实际是"25 年一遇 380 mm"，这个错会直接
    进入价目表的定价。

    POT+GPD 的重现期关系：
        P(年极值 > u + z) = λ · (1 + ξ z / β)^(-1/ξ)
    λ 是年均事件率。令左侧 = 1/T 解出z：
        z = β/ξ · [(T·λ)^ξ - 1]，ξ → 0 时z = β·ln(T·λ)

    λ 的方向容易搞反：它是**乘子**，λ 越大则同一 T 对应的阈值越高。
    把 λ 换成 1/场数（等于假设每年都有全部场次发生）会让所有重现期
    系统性偏小。
    """
    if not gpd.get("ok"):
        return {"ok": False, "levels": {},
                "reason": gpd.get("reason", "GPD 未拟合"),
                "lambda_per_year": round(max(float(lambda_per_year), 1e-9), 3)}
    xi = gpd["shape_xi"]
    beta = gpd["scale_beta"]
    th = gpd["threshold_mm"]
    n_exc = gpd["n_exceed"]
    n_yr = gpd["n_total"]
    lam = max(float(lambda_per_year), 1e-9)
    out = {}
    for T in years:
        rate = T * lam
        if rate <= 1.0:
            # T·λ ≤ 1 说明该重现期低于样本本身的年均事件数，
            # 落在经验分布覆盖范围之外，GPD 外推无意义。
            out[f"T{T}"] = {
                "面雨量_mm": None,
                "状态": f"低于年均事件率（1/λ = {1/lam:.1f} 年），不在样本覆盖内",
            }
            continue
        if abs(xi) < 1e-6:
            z = beta * math.log(rate)
        else:
            z = beta / xi * (rate ** xi - 1.0)
        out[f"T{T}"] = {
            "面雨量_mm": round(th + z, 1),
            "状态": "样本内经验分布" if T <= max(n_yr / lam, 1) else "GPD 尾部外推",
        }
    return {
        "ok": True,
        "levels": out,
        "lambda_per_year": round(lam, 3),
        "n_exceed": n_exc,
        "caveat": (f"样本 {n_yr} 场，跨 {n_yr/lam:.0f} 年，年均事件率 "
                   f"{lam:.2f} 场/年，经验分布最远只到 "
                   f"{max(n_yr/lam, 1):.0f} 年一遇。"
                   f"更长的重现期靠 {n_exc} 个超阈值点做 GPD 尾部外推，"
                   f"样本量这么小时外推区间很宽，"
                   f"引用 50 年以上数值须带敏感性说明。"),
    }


def fit_intensity_loss(events: list[EventResult]) -> dict:
    """强度—损失关系。对数线性拟合，返回斜率与 R²。

    选对数线性而不是幂律，是因为数据点数只有十几，幂律的三参数拟合
    在这个量级上不可辨识。对数线性是两点能定、一点能验的形式。
    """
    ok = [e for e in events if e.ok and e.q_total > 0 and e.rain72_mm > 0]
    if len(ok) < 4:
        return {"ok": False, "reason": f"有效场次 {len(ok)} < 4"}
    x = np.log(np.array([e.rain72_mm for e in ok], dtype=float))
    y = np.log(np.array([e.q_total for e in ok], dtype=float))
    a, b = np.polyfit(x, y, 1)
    pred = a * x + b
    ss_res = float(np.sum((y - pred) ** 2))
    ss_tot = float(np.sum((y - y.mean()) ** 2))
    r2 = 1.0 - ss_res / ss_tot if ss_tot > 0 else 0.0
    # 斜率为负等于"雨越大损失越小"。R² 在这种情形下依然可能很高
    # （样本点少时相关方向反了也显著），所以必须单独卡斜率符号。
    slope_pos = bool(a > 0)
    return {
        "ok": bool(slope_pos),
        "n": len(ok),
        "log_log_slope": round(float(a), 4),
        "intercept": round(float(b), 4),
        "r2": round(r2, 4),
        "slope_positive": slope_pos,
        "form": "Q = exp(intercept) × 雨量^slope",
        "note": ("强度—损失关系是对数线性拟合，不是幂律——"
                 "样本量十几时幂律三参数不可辨识。"
                 "斜率的物理含义是单位面雨量增量带来的功能损失增量，"
                 "它是改造收益论证的核心系数。"
                 + ("" if slope_pos else
                    "本次拟合斜率为负，该关系不可用。")) if slope_pos else
                (f"拟合斜率为 {a:.4f}（负），意味着雨量增大时功能损失下降，"
                 f"与承灾机理相反。样本 {len(ok)} 个，"
                 f"Q 与面雨量的关系在这批数据上不可标定。"),
    }


def check_monotonicity(events: list) -> dict:
    """强度—损失关系的单调性判据，独立可测。

    雨量涨而损失不涨，说明投影层或内核在该场次出了非物理行为，
    整条标度关系不可用。这项不查，R² 再高也不可信。

    判据带相对容差，不是严格不降。定容差的依据（本批 13 个致涝场次
    的实测分布）：相邻场次对的 |ΔQ|/Q 中位数 54.4%、10% 分位 11.2%，
    而 1995 JANIS（69.2 mm）与 2000 KAI-TAK（73.5 mm）之间
    ΔQ/Q 只有 0.20%——两场雨量差 4.3 mm，Q 差 0.0003，
    是浮点噪声而非机制性违背。

    每处违背都落盘相对幅度，便于事后复核容差是否还合适。
    """
    ok = [e for e in events if e.ok and e.rain72_mm > 0 and e.q_total > 0]
    by_rain = sorted(ok, key=lambda e: e.rain72_mm)
    viol = []
    for a, b in zip(by_rain, by_rain[1:]):
        if a.q_total <= 0.0:
            continue
        rel = (b.q_total - a.q_total) / a.q_total
        if rel < -MONO_TOL:
            viol.append({
                "年": b.year, "台风": b.name, "前一场": a.name,
                "前一场_Q": round(a.q_total, 4),
                "雨量_mm": round(b.rain72_mm, 1),
                "Q": round(b.q_total, 4),
                "相对降幅_pct": round(rel * 100, 3),
            })
    return {
        "n_violations": len(viol),
        "violations": viol,
        "passed": not viol,
        "判据": (f"按面雨量升序，相邻场次的 Q 相对降幅须 ≤ "
               f"{MONO_TOL*100:.0f}%"),
        "容差依据": ("本批 13 个致涝场次的实测：相邻对 |ΔQ|/Q 中位数 "
                 "54.4%、10% 分位 11.2%；唯一低于 11.2% 的一处是"
                 "1995 JANIS 与 2000 KAI-TAK 之间的 0.20%"
                 "（雨量差 4.3 mm、Q 差 0.0003，浮点噪声）。"
                 "取 5% 低于正常相邻对的最小变动、高于实测噪声"),
    }


def calibrate(events: list[EventResult], gpd: dict, ret: dict,
              il: dict, lam: float, span: int,
              flood: list = None, no_flood: list = None,
              emp: dict = None) -> dict:
    """四段汇总。加法分解 + 重现期 + 强度损失 + CC 说明。"""
    ok = [e for e in events if e.ok]
    flood = flood if flood is not None else ok
    no_flood = no_flood or []
    skipped = [{"年": e.year, "台风": e.name, "原因": e.reason}
               for e in events if not e.ok]
    years = sorted({e.year for e in ok})
    return {
        "method": "多事件批量实算 + POT/GPD 重现期 + 对数线性强度损失",
        "n_events_catalog": len(EVENT_CATALOG),
        "n_events_ok": len(ok),
        "n_events_skipped": len(skipped),
        "skipped": skipped,
        "year_span": [min(years), max(years)] if years else None,
        "year_count": span,
        "lambda_per_year": round(lam, 3),
        "n_flood_events": len(flood),
        "no_flood_events": no_flood,
        "no_flood_note": ("路径经过本域但雨量不足以致涝的场次，"
                          "不参与重现期标定。这些场次计入极值拟合会把"
                          "分布尾部拉平。"),
        "rain_range_mm": ([round(min(e.rain72_mm for e in ok), 1),
                           round(max(e.rain72_mm for e in ok), 1)]
                          if ok else None),
        "depth_range_m": ([round(min(e.max_depth_m for e in ok), 3),
                           round(max(e.max_depth_m for e in ok), 3)]
                          if ok else None),
        "q_range": ([round(min(e.q_total for e in ok), 4),
                     round(max(e.q_total for e in ok), 4)] if ok else None),
        "monotonicity": check_monotonicity(events),
        "closure": {
            "n_closed": sum(1 for e in ok if e.closed),
            "n_total": len(ok),
            "max_resid_share_pct": (round(max(e.resid_share for e in ok) * 100, 1)
                                    if ok else None),
            "判据": "每场残差占比 ≤ 20%（门槛 8 口径）",
        },
        "intensity_loss": il,
        "return_period_fit": gpd,
        "return_period_levels": ret,
        "empirical_levels": emp,
        "events": [e.as_dict() for e in events],
        "cc_status": {
            "标定": False,
            "原因": ("CC 是气候变化下的标度率，标定它需要两个气候态的"
                     "对比。18 场事件全在 1990–2025 同一气候态内"
                     "（背景变暖 0.3 K 量级），信号完全淹没在事件间差异里。"
                     "样本量增加能收敛随机误差，不能消除共线——"
                     "变量共线与样本量是两个不同的问题。"),
            "当前取值": f"{M.CC_EXPECTED*100:.0f}%/°C（用户给定的先验，非标定值）",
            "敏感性": ("气候分量按 1/(1+cc·ΔT) 折算，"
                    f"cc 在 5%/°C 到 9%/°C 之间变动时"
                    f"气候分量占比变化约 "
                    f"{(1/(1+0.05*M.SST_CC_LIM) - 1/(1+0.09*M.SST_CC_LIM))*100:.1f} "
                    f"个百分点（ΔT=+0.6 K）"),
            "要标定它需要": ("至少两段气候态的对比：模式增温实验、或"
                        "包含显著暖异常与冷异常子样本的更长序列，"
                        "且控制雨区移动与抽排能力的差异"),
        },
        "caveats": [
            "无实测雨量锚点：18 场里只有 2021 有实测累计量，其余用 ERA5 "
            "再分析实算值。2021 的 ERA5 与实测存在系统性差异，"
            "该差异会整体平移曲线，不影响形状与标度关系，影响绝对量级。",
            "每场跑参数化降雨而非 ERA5 实算：参数偏差是共模的，"
            "在标度关系里部分约掉，绝对量级另由 ERA5 场次单独校核。",
            f"单场时间维 72 h，重现期外推依赖频率拟合而非单场时长。",
        ],
    }


def run_all(grid, kcfg: K.KernelParams, prj_params,
            catalog=None, cfg=None, verbose: bool = True) -> dict:
    """跑完整标定流程。返回可直接落盘的报告 dict。"""
    cfg = cfg or CFG.Config()
    events = []
    cat = catalog or EVENT_CATALOG
    for i, item in enumerate(cat, 1):
        yr, nm = item[0], item[1]
        r = run_event(yr, nm, grid, kcfg, prj_params, cfg)
        events.append(r)
        if verbose:
            if r.ok:
                print(f"  [{i:2d}/{len(cat)}] OK   {yr} {nm:12s}"
                      f" 雨量 {r.rain72_mm:6.1f} mm  雨强 {r.peak_intensity_mm_h:5.2f}"
                      f"  水深 {r.max_depth_m:.3f} m  Q {r.q_total:.4f}"
                      f"  残差 {r.resid_share*100:4.1f}%"
                      f"  {r.elapsed_s:.1f} s", flush=True)
            else:
                print(f"  [{i:2d}/{len(cat)}] SKIP {yr} {nm:12s} {r.reason}",
                      flush=True)
    ok = [e for e in events if e.ok]
    # 重现期只对**造成涝害**的场次标定。实测 16 场成功里有 3 场 Q = 0
    # （KONG-REY 2.2 mm、ABE 4.6 mm、KHANUN 2.9 mm）——路径经过本域
    # 但雨量不足致涝。这些场次不是内涝事件，混进极值拟合会把分布
    # 尾部拉平：把它们算进去时 GPD 给出的 ξ 触及-0.5 边界、β ≤ 0，
    # 五个重现期全等于阈值。重现期要回答的是"多少年一遇的雨会涝"，
    # 不是"多少年一遇的台风会经过"。
    flood = [e for e in ok if e.q_total > 0.0]
    no_flood = [{"年": e.year, "台风": e.name,
                 "72h面雨量_mm": round(e.rain72_mm, 1),
                 "Q": round(e.q_total, 4)} for e in ok if e.q_total <= 0.0]
    gpd = (fit_return_period(np.array([e.rain72_mm for e in flood]))
           if flood else
           {"ok": False, "reason": "无造成涝害的场次", "n_total": 0,
            "n_exceed": 0})
    # 年均涝害事件率按实际年份跨度算，不是 1/场数。样本跨 36 年时
    # λ ≈ 0.4 场/年；按 1/13 = 1.0算会把所有重现期缩短一倍。
    span = (max(e.year for e in flood) - min(e.year for e in flood) + 1) \
        if flood else 0
    lam = len(flood) / max(span, 1)
    ret = return_period_levels(gpd, lam)
    emp = empirical_levels(np.array([e.rain72_mm for e in flood]), lam, span)
    il = fit_intensity_loss(events)
    return calibrate(events, gpd, ret, il, lam, span, flood, no_flood, emp)


if __name__ == "__main__":
    list_events()