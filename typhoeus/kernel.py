"""提比翁 Demo —— L1 内核层 T_θ：图守恒律求解器。

核心主张（对应文档 6.1）：街道积水与带源汇LWR 交通流方程同构，
守恒性与正性由算子结构保证，而不是靠训练数据拟合出来。

本模块实现图形式的水量守恒推进：
  状态 z =各节点水深h
 转移算子 T_θ = 干湿判别 + 通量算子 + 源项（降雨-蒸发-下渗）
约束：
 守恒性 —— 全域水量变化 = 源项累计（残差 ≤ tol_mass）
  正性   —— min(h) ≥ 0，不出现负水深
任一不满足则 raise，内核拒绝输出。这是门槛与判别准则的硬边界。

地表-土壤-大气界面的处理（2026-10 引入，机制可切换）：
  legacy  —— 稳定下渗率随地表水深指数衰减。v0.5.0 之前的口径，
              保留是为了让改造效果可对照、可回滚。
  green_ampt —— Green-Ampt 入渗：f = Ksat·(1 + ψ·Δθ/F)，F 是累积下渗量。
              驱动量是**土壤饱和度**而非地表水深，土壤一旦饱和入渗
              断崖下降，剩余雨水全部转地表径流。
              叠 Ghil-Sellers 显式能量平衡：Rn → 土壤热流 / 感热 / 潜热，
              潜热驱动土壤蒸发，蒸发消耗的那部分土壤水正是维持入渗
              能力所需的 Δθ。能量项对本场景是否激活由实测算据说话，
              见 budget_mm() 的能量段与 measure 的机制核验。
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .finiteness import NonFiniteError, assert_finite, count_nonfinite

G = 9.81
RHO_W = 1000.0        # 水密度 kg/m³
LV = 2.45e6           # 汽化潜热 J/kg，20 ℃


@dataclass
class KernelParams:
    """求解参数（L4 层）。这些是数值参数，不是可标定的物理参数。"""

    dt_s: float = 600.0          # 时间步长，10 min
    max_t_h: float = 72.0        # 推演时长上限
    flux_exponent: float = 5.0 / 3.0   # h^(5/3) Manning 流量指数
    manning_n: float = 0.016     # 沥青路面糙率
    min_depth_m: float = 1e-4# 干湿判别阈值
    tol_mass: float = 1e-6      # 守恒残差容差（相对）
    max_depth_m: float = 3.0    # 水深上限，超出即判定数值失稳
    # 管网排水：顶托高程（m，管顶低于此高程不排水）与过流系数。
    # 取值标定：宁波主城区干管顶托多在地面下 0.5-1.5 m，
    # 但**地面积水**要进入管网需先填满竖井与连接段，
    # Demo 用0.05 m 作为等效起排阈值，具体值由管网台账标定。
    drainage_invert_m: float = 0.05
    drainage_coeff_m_s: float = 1.2e-3
    # 排水能力的**空间乘子场**（可选）。None = 全域均匀，与既有行为逐位一致。
    # 真实管网输水能力沿街道强异质：主干管与支管差一个量级，
    # 下穿立交往往只靠一根支管。用统一标量会把低洼点"抽干"，
    # 使模型在这些点始终无积水（p13/p17 的"模型无水型"）。
    #
    # 该场**不进 config_hash**（它是 KernelParams 上的场，不是 Config 四层参数），
    # 但改变推演结果，故由 `drainage_fingerprint()` 单独定影并随产物落盘。
    # 配了场却没声明档案名（`drainage_profile` 仍为 "uniform"）时 `run()` 直接抛。
    # 注：本字段与其内核支持曾在一次工作树覆盖中整体丢失，
    # 因 dataclass 允许动态设属性，赋值不报错但内核不读，形成**静默空操作**。
    drainage_mult: object = None
    drainage_profile: str = "uniform"
    # ---- 汇流集中（D8 路由）----
    # 每步把一部分地表水沿**最陡下降方向**移到下游格。0 = 关闭，逐位不变。
    #
    # 为什么需要它：Manning 通量 ∝ h^(5/3)，浅水时几乎不动，于是水被摊成
    # 一大片薄层——实测湿格面积是 SAR 的 8.7 倍、点位水深只有观测的 1/10.8。
    # 体积守恒算术显示两个误差是同一股水被摊薄（p60）：
    # 0.0366 m × 8.72 = 0.319 m，而实测均值 0.396 m。
    #
    # D8 路由是水文学标准做法（非水力模型），只做"把水搬到低处"，
    # 不引入动量方程。故本模型仍**不是水动力模型**。
    concentration_rate: float = 0.0
    # 路由用的高程是否先填洼。False = 原始 DSM（水会困在 4754 个小坑里，
    # 实测湿格只到 15.6%）；True = priority-flood 填后地形（水可跨小坑到达真汇）。
    concentration_use_filled: bool = False
    # 入渗机制。green_ampt 用土壤饱和度驱动，legacy 用地表水深驱动。
    # 两者都进 config_hash —— 机制选择本身就是模型身份的一部分。
    infiltration_mode: str = "green_ampt"
    infiltration_m_h: float = 1.2e-3        # legacy 模式专用：稳定下渗率

    # ---- Green-Ampt 入渗参数（L2 场地层，此处给内核可运行的默认值）----
    # 饱和导水率 m/h。宁波粉质黏土实测 3.6e-3~3.6e-2 m/h，但计算域
    # 是压平建筑后的 DSM 硬化面，直接用原状土值会让 72 h 入渗量
    # 超过降雨量。取值由 tools/infil_diag.py 的机制扫描标定。
    soil_ksat_m_h: float = 1.2e-3
    # 湿润锋吸力头 m。粉质黏土湿润锋吸力水头典型 0.05-0.15 m。
    soil_psi_m: float = 0.10
    # 根区土壤水容量 mm（可被湿润锋充水的深度对应的水当量）。
    # 决定饱和所需的累积入渗量：容量除以 Ksat 即饱和时间尺度。
    soil_capacity_mm: float = 30.0
    # 硬化面占比。全场 30 mm 土层等于假设整片计算域都是裸土，
    # 而宁波老城屋顶+路面硬化率实测 70-80%。有效土壤容量按
    # 容量 × (1 - 硬化面占比) 计，取 0.75 时有效容量 7.5 mm。
    # 实测依据（tools/infil_diag.py，72 h 钟形雨场，36×68 网格）：
    # 硬化面折减缺失时，入渗总量被容量锁死在 20.2 mm，59 mm 雨与
    # 1179 mm 雨的入渗差 0.04 mm —— 那不是饱和机制在起作用，
    # 是把整片城区当成了裸土农田。
    impervious_frac: float = 0.75
    # 初始含水率（占饱和容量的比例）。台风季前期有前期降雨，
    # 但并非场次开始时土壤已饱和。
    # 实测（tools/infil_diag.py，72 h 钟形雨场，imperv=0.75，
    # 有效容量 7.5 mm）：θ0=0.75 时仅剩 1.875 mm 可吸，等于一进场
    # 就饱和，吸力增益在所有场次恒为 0，机制形同虚设；
    # θ0=0.45 留 4.1 mm 余量，强弱场次才在增益上有区分。
    soil_theta0: float = 0.45
    # 残余含水率（占饱和容量比例），土壤水不能再低于此值。
    soil_theta_res: float = 0.08

    # ---- Ghil-Sellers 能量平衡参数 ----
    # 净短波辐射 W/m²。台风遮蔽条件下远低于晴空。
    net_sw_wm2: float = 40.0
    # 地表反照率。湿润沥青 0.08，城镇综合 0.15。
    albedo: float = 0.15
    # 土壤热流占净辐射比例（Ghil-Sellers 的 G 项）。
    ground_flux_frac: float = 0.25
    # 感热占净辐射比例（H 项）。剩余部分给潜热（LE 项）。
    sensible_frac: float = 0.45

    # 蒸发折减系数：潜热通量只有一部分真正消耗土壤水，
    # 其余被大气湍流与平流带走。缺这个折减，能量预算的闭合项
    # 会把蒸发放大成降雨量量级。
    evap_efficiency: float = 0.65


@dataclass
class RunResult:
    """一次推演的全部时序输出。累计量统一为 m³，避免类型混用。"""

    t_h: np.ndarray            # (nt,) 时间轴，小时
    depth: np.ndarray          # (nt, ny, nx) 水深场，m
    rain_cum: np.ndarray# (nt,) 累计面雨量，mm
    rain_total_m3: float       # 累计降雨总量，m³
    infil_total_m3: float      # 累计下渗，m³
    drain_total_m3: float      # 累计排水，m³
    boundary_out_m3: float     # 累计边界出流，m³
    dry_loss_m3: float         # 干湿判别截断的水量，m³（数值损耗，非物理）
    cap_loss_m3: float         # 水深上限截断的水量，m³（数值损耗，非物理）
    neg_loss_m3: float         # 负水深修正的水量，m³（数值损耗，非物理）
    mass_resid: float# 守恒残差（相对）
    positivity_ok: bool        # 正性是否满足
    n_cells: int
    cell_area_m2: float
    # ---- Green-Ampt / 能量平衡诊断（不参与守恒等式，是入渗量的细分）----
    infiltration_mode: str = "legacy"
    evap_total_m3: float = 0.0     # 累计土壤蒸发，m³
    soil_final_m3: float = 0.0     # 根区土壤水期末储量，m³
    soil_init_m3: float = 0.0      # 根区土壤水期初储量，m³
    ksat_total_m3: float = 0.0     # 以 Ksat 纯量级下渗的水量，m³
    energy: dict = field(default_factory=dict)
    # 排水空间乘子场的定影串。"uniform" = 未启用乘子。
    # 与 config_hash 并列构成一次推演的完整身份：config_hash 覆盖不到这个场。
    drainage_fingerprint: str = "uniform"

    @property
    def max_depth(self) -> float:
        return float(self.depth.max())

    @property
    def peak_time_h(self) -> float:
        k = int(np.argmax(self.depth.max(axis=(1, 2))))
        return float(self.t_h[k])

    def budget_mm(self) -> dict:
        """水量收支表（mm，面平均），用于守恒核对。"""
        a = self.cell_area_m2 * self.n_cells
        f = 1000.0 / a
        return {
            "降雨": self.rain_total_m3 * f,
            "下渗": self.infil_total_m3 * f,
            "排水": self.drain_total_m3 * f,
            "边界出流": self.boundary_out_m3 * f,
            "干湿截断": self.dry_loss_m3 * f,
            "上限截断": self.cap_loss_m3 * f,
            "负值修正": self.neg_loss_m3 * f,
            "域内存量": float(self.depth[-1].sum()) * self.cell_area_m2 * f,
        }

    def budget_energy(self) -> dict:
        """入渗细分与能量收支（mm / MJ·m⁻²，面平均）。

        两组恒等式，各自闭合，不要混着读：

          地表侧：下渗 = Ksat 本底 + 吸力增益
            两者都只是下渗量的分量，蒸发不在这一侧。
          土壤侧：土壤储水变化 = 下渗 − 土壤蒸发
            蒸发从土壤走，不经过地表，所以它不在上一式里。

        `饱和判据`：吸力增益 = 储水变化 + 蒸发 − Ksat本底。
        土壤饱和时该值趋零，入渗退回纯 Ksat，此时弱降雨也蓄不住水，
        场次之间的水深差异才会拉开。
        """
        a = self.cell_area_m2 * self.n_cells
        f = 1000.0 / a
        infil = self.infil_total_m3 * f
        ksat = self.ksat_total_m3 * f
        evap = self.evap_total_m3 * f
        dsoil = (self.soil_final_m3 - self.soil_init_m3) * f
        d = {
            "入渗机制": self.infiltration_mode,
            "下渗_mm": round(infil, 4),
            "下渗_Ksat本底_mm": round(ksat, 4),
            "下渗_吸力增益_mm": round(infil - ksat, 4),
            "土壤储水变化_mm": round(dsoil, 4),
            "土壤蒸发_mm": round(evap, 4),
            "吸力增益占比": round((infil - ksat) / max(infil, 1e-9), 4),
        }
        d.update(self.energy)
        return d


def _hour_offsets(track) -> list[float]:
    """全部路径点相对**最接近计算域**那个点的小时偏移。

    时间基准取距目标点最近的路径点，不是路径首点。IBTrACS 的 WP 分片给出
    的是完整生命史：烟花 118 个点跨 2021-07-16 至 07-31 共 351 h，而内核
    时窗只有 72 h。若以首点为基准，台风直到第 210 h 才靠近宁波，
    降雨核的 `break` 会在循环开头就触发，整个降雨场退化成全零。

    无有效时间戳时退回按索引等间隔（每点 6 小时），并以最接近点为原点。
    返回值可以为负——表示先于最接近时刻的路径，这段时间对应台风外围
    雨，是内陆降雨的主要来源，不能截断。
    """
    import datetime as _dt

    times: list = []
    for q in track:
        ts = getattr(q, "t", None)
        if isinstance(ts, str):
            try:
                times.append(_dt.datetime.fromisoformat(ts.replace("Z", "")))
            except ValueError:
                times.append(None)
        else:
            times.append(None)

    lats = np.array([q.lat for q in track], dtype=np.float64)
    lons = np.array([q.lon for q in track], dtype=np.float64)
    # 目标区中心取路径包围盒与网格无关的粗略口径：这里用路径中纬度
    # 最接近北纬 30 度的点作为基准点，避免额外耦合 config。
    ref_lat = float(np.clip(30.0, lats.min(), lats.max()))
    k_ref = int(np.argmin(np.abs(lats - ref_lat)))

    base = times[k_ref]
    out: list[float] = []
    for i, t in enumerate(times):
        if base is None or t is None:
            out.append((i - k_ref) * 6.0)
        else:
            out.append((t - base).total_seconds() / 3600.0)
    return out


# 降雨参数化模型的标定量。提到模块级，measure.estimate 的集合估计
# 直接引用同一组数值，避免两处各自标定出一套对不上的雨量。
# 用实测路径后重标过：WP 分片给出完整生命史，72 h 窗内落进 14 个路径点，
# 每个点各铺一个 T_HALF 半宽的钟形核，核间重叠使总雨量是单点的十余倍。
R_MAX = 11.3   # mm/h，眼壁附近瞬时峰值
R_FLOOR = 1.5  # mm/h，低于此值不计产流（小于下渗，无净效应）
RAD_EXP = 3.0  # 径向衰减指数，越大雨区越集中
T_HALF = 2.0   # h，单个路径点的时间核半宽


def rainfall_field(track, grid, cfg: KernelParams) -> np.ndarray:
    """由台风路径合成逐时降雨场（mm/h），形状 (nt, ny, nx)。

    Demo 阶段没有接 CMFD/雷达，用台风参数化降雨模型：雨强由台风中心
    距与中心气压差决定，方位角上带右旋非对称（北半球台风）。
    这是**合成驱动**，所有由它推出的阈值指标在报告中标注为合成驱动，
    不与实测降雨混用。

    时间上用钟形核而非方波：方波让每个路径点的 6 小时窗口内雨强恒定，
    一个 60 km 雨区维持 46 mm/h 达 6 小时就是 276 mm，过程总量直接冲到
    600 mm 以上，比华东台风登陆实际过程雨量高出��倍。钟形核让雨区随台风
    中心移动而涨落，总量落在合理量级。
    """
    ny, nx = grid.shape
    lon2d, lat2d = np.meshgrid(grid.lon, grid.lat)
    nt = int(cfg.max_t_h * 3600 / cfg.dt_s) + 1
    t_h = np.arange(nt) * cfg.dt_s / 3600.0

    lat0 = float(np.mean(track[0].lat))
    # R_MAX / R_FLOOR / RAD_EXP / T_HALF 见模块级常量。
    # 标定结果（实测路径）：面雨量 203 mm、峰值雨强 24 mm/h、
    # 峰值水深 0.75 m。面雨量落在华东台风登陆过程的 250-350 mm 区间的
    # 下沿，参数化降雨未含地形抬升，量级偏保守；峰值水深略高于
    # 烟花宁波实测最深的 0.68 m，作为合成驱动下的量级上界。

    acc = np.zeros((nt, ny, nx), dtype=np.float64)
    hours = _hour_offsets(track)

    for k, p in enumerate(track):
        tc = hours[k] + 1.5                # 核中心：路径点覆盖窗口的中点
        # 时间窗过滤而非 break：hours 允许为负且路径可能回曲，
        # break 会在遇到第一个超出上界的点时终止整条路径。
        if tc < -T_HALF or tc > cfg.max_t_h + T_HALF:
            continue

        dx = (lon2d - p.lon) * 111320.0 * np.cos(np.radians(lat0))
        dy = (lat2d - p.lat) * 110540.0
        r = np.hypot(dx, dy) / 1000.0

        # 气压差驱动强度
        dp = max(1010.0 - p.pres_mb, 5.0)
        peak = R_MAX * (dp / 50.0)
        # 环流半径随强度增大
        Rm = max(60.0, 180.0 - 2.4 * p.vmax_kts)
        base = peak * (Rm / np.maximum(r, Rm * 0.30)) ** RAD_EXP
        # 右旋非对称：东北侧增强
        th = np.arctan2(dy, dx)
        asym = 1.0 + 0.22 * np.cos(th - np.pi / 3.0)
        q = np.clip(base * asym, 0.0, R_MAX * 1.6)
        q[q < R_FLOOR] = 0.0

        w = np.exp(-0.5 * ((t_h - tc) / T_HALF) ** 2)
        acc += w[:, None, None] * q[None, :, :]

    return acc.astype(np.float32)


def priority_flood_fill(z: np.ndarray) -> np.ndarray:
    """标准 priority-flood 填洼：返回每个格可排出的最低高程。

    边界视为出口。填后地形上任意格都有通向边界的不上升路径，
    故其 D8 下游不会困在局部小坑里。
    """
    import heapq

    ny, nx = z.shape
    filled = np.array(z, dtype=np.float64, copy=True)
    closed = np.zeros((ny, nx), bool)
    pq: list[tuple[float, int, int]] = []

    def push(i: int, j: int, base: float) -> None:
        if closed[i, j]:
            return
        filled[i, j] = max(float(z[i, j]), base)
        closed[i, j] = True
        heapq.heappush(pq, (filled[i, j], i, j))

    for i in range(ny):
        push(i, 0, -np.inf)
        push(i, nx - 1, -np.inf)
    for j in range(nx):
        push(0, j, -np.inf)
        push(ny - 1, j, -np.inf)

    nb = ((-1, 0), (1, 0), (0, -1), (0, 1),
          (-1, -1), (-1, 1), (1, -1), (1, 1))
    while pq:
        zc, i, j = heapq.heappop(pq)
        for di, dj in nb:
            a, b = i + di, j + dj
            if 0 <= a < ny and 0 <= b < nx and not closed[a, b]:
                push(a, b, zc)
    return filled


def d8_downstream(z: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """由高程场算 D8 最陡下降下游索引。

    返回 `(rows, cols)`，均为 int64、形状同 z；`rows < 0` 表示该格**无下游**
    （局部洼地或边界），水就留在那里——这正是"填洼成塘"的行为。

    边界用 `mode="edge"` 填充，使边界格的域外邻居与自身等高，
    故边界不会把水推出域外（出域由 `_rim_outflow` 单独处理）。
    """
    ny, nx = z.shape
    zp = np.pad(z, 1, mode="edge")
    best = np.full((ny, nx), 0.0)
    ri = np.full((ny, nx), 0, dtype=np.int64)
    ci = np.full((ny, nx), 0, dtype=np.int64)
    steps = ((-1, -1, 2 ** 0.5), (-1, 0, 1.0), (-1, 1, 2 ** 0.5),
             (0, -1, 1.0), (0, 1, 1.0),
             (1, -1, 2 ** 0.5), (1, 0, 1.0), (1, 1, 2 ** 0.5))
    for dy, dx, dist in steps:
        cand = zp[1 + dy:1 + dy + ny, 1 + dx:1 + dx + nx]
        slope = (z - cand) / dist
        ok = (slope > 1e-12) & (slope > best)
        best = np.where(ok, slope, best)
        ri = np.where(ok, dy, ri)
        ci = np.where(ok, dx, ci)
    rows = np.arange(ny, dtype=np.int64)[:, None] + ri
    cols = np.arange(nx, dtype=np.int64)[None, :] + ci
    valid = best > 0.0
    return (np.where(valid, rows, -1), np.where(valid, cols, -1))


def drainage_fingerprint(cfg: KernelParams) -> str:
    """排水空间乘子场的定影串。

    `config_hash` 只覆盖 Config 的四层参数，覆盖不到这个场；而它会改变推演
    结果。所以凡启用非均匀排水的 run，产物必须同时带这个串，否则"同一
    config_hash 才能复算"这条主张在这里是漏的。

    均匀（未启用乘子）返回 "uniform"，与既有行为逐位一致。
    """
    import hashlib

    m = getattr(cfg, "drainage_mult", None)
    if m is None:
        return "uniform"
    a = np.asarray(m, dtype=np.float64)
    digest = hashlib.sha256(
        np.round(a, 6).tobytes() + str(a.shape).encode()).hexdigest()[:10]
    prof = getattr(cfg, "drainage_profile", "uniform") or "uniform"
    return f"{prof}@{a.shape[0]}x{a.shape[1]}:{digest}"


def run(grid, rain_mm_h: np.ndarray, cfg: KernelParams = KernelParams()) -> RunResult:
    """图守恒律推进。

    离散：格点 i 存水深 h_i。边通量 q_{i->j} = (1/n) * h_f^(5/3) * sqrt(slope_f)，
    slope_f 由总水位差驱动，干湿判别用 h_f = max(h_i - z_i, 0)。
    源项：降雨 - 下渗 - 蒸发 - 排水（排水按容量上限线性抽取）。

    入渗机制由 cfg.infiltration_mode 选。green_ampt 模式下每格额外带
    一个根区土壤水状态 S（m 水当量），它不是显式变量而是累积量，
    但必须逐格独立：饱和是**局部**过程，用域平均会让整场同时饱和，
    那正是原机制「入渗量锁死」的成因。
    """
    elev = grid.elev.astype(np.float64)
    ny, nx = elev.shape
    area = grid.cell_m ** 2
    nt = rain_mm_h.shape[0]
    dt_h = cfg.dt_s / 3600.0
    dt_s = cfg.dt_s

    if cfg.infiltration_mode not in ("green_ampt", "legacy"):
        raise ValueError(
            f"infiltration_mode={cfg.infiltration_mode!r} 未知，"
            f"合法值：'green_ampt' / 'legacy'")

    # 洼地填充：内部填平并给ε 排水梯度，边界不动地形。
    # 边界出流由 _rim_outflow 显式计算，不靠"把边缘压低"制造出口。
    z = _fill_depressions(elev)
    # 汇流集中的 D8 下游索引：与时间无关，整场只算一次。
    # 默认 concentration_rate=0 时不使用，故不影响既有结果。
    if getattr(cfg, 'concentration_rate', 0.0) > 0.0:
        _z_route = (priority_flood_fill(z)
                    if getattr(cfg, 'concentration_use_filled', False) else z)
        _d8_rows, _d8_cols = d8_downstream(_z_route)
    else:
        _d8_rows, _d8_cols = (None, None)


    h = np.zeros((ny, nx), dtype=np.float64)
    depth = np.zeros((nt, ny, nx), dtype=np.float32)

    # 根区土壤水：逐格状态，初值占**有效**饱和容量的 soil_theta0。
    # 用「占饱和容量的比例」初始化而不是绝对 mm，这样改 capacity
    # 不会静默改掉初始湿润程度。
    #
    # 有效容量 = 名义容量 × (1 - 硬化面占比)。硬化面上没有孔隙，
    # 不折减就等于把整片城区当裸土农田，容量锁死会盖过饱和机制。
    #
    # legacy 模式下这些量必须为 0：土壤状态不被读取、不被更新，
    # 若照样初始化并落盘，budget_energy 会报出一个 legacy 根本不
    # 存在的"土壤储水 6889 m³"，读起来像真的有土层。
    if cfg.infiltration_mode == "green_ampt":
        cap = cfg.soil_capacity_mm / 1000.0 * (1.0 - cfg.impervious_frac)
        soil = np.full((ny, nx), cap * cfg.soil_theta0, dtype=np.float64)
        soil_init = float(soil.sum()) * area
        # Green-Ampt 的 F 是累积下渗量。同样逐格独立，量纲 m。
        f_cum = np.zeros((ny, nx), dtype=np.float64)
    else:
        cap = 0.0
        soil = np.zeros((0, 0), dtype=np.float64)
        soil_init = 0.0
        f_cum = np.zeros((0, 0), dtype=np.float64)

    rain_cum = np.zeros(nt)
    total_rain = 0.0
    total_rain_mm = 0.0
    total_infil = 0.0
    total_drain = 0.0
    total_boundary_out = 0.0
    total_dry_loss = 0.0
    total_cap_loss = 0.0
    total_neg_loss = 0.0
    total_evap = 0.0
    total_ksat = 0.0
    positivity_ok = True
    # 能量核算累计（MJ/m² 面平均，入 run 结束换算）
    e_net = e_ground = e_sensible = e_latent = 0.0
    lat_active_steps = 0

    # 常数
    inv_n = 1.0 / cfg.manning_n

    max_h = cfg.min_depth_m * 0.5

    # 入口查雨量输入。缺这一步时，一个 NaN 会静默穿过全部三道防线：
    # `h.min() < -1e-12` 与 `h > 0` 对 NaN 恒为 False，正性与守恒两项
    # 判据同时失效，run() 照常返回 positivity_ok=True。
    assert_finite(rain_mm_h, "kernel.run 入口降雨场")

    for k in range(nt):
        # rain_mm_h[k] 是该时段内的平均雨强（mm/h）。
        # 增量水深 = 雨强(mm/h) × dt_h(h)，单位天然就是mm，转米只需除1000。
        # 注意不要再除一次 3600：dt_h 已经是小时，重复换算会把雨量缩小 3600 倍。
        rain_inc = (rain_mm_h[k] / 1000.0) * dt_h# m
        rain_cum[k] = total_rain_mm + float(rain_inc.mean() * 1000.0)

        # 源项
        h = h + rain_inc
        total_rain += float(rain_inc.sum() * area)
        total_rain_mm += float(rain_inc.mean() * 1000.0)

        # ---- 下渗 ----
        if cfg.infiltration_mode == "legacy":
            # 旧机制：稳定下渗率随地表水深指数衰减。
            # 实测缺陷（tools/infil_diag.py，36×68 网格 12 h 钟形雨场）：
            # 峰值雨强 2→40 mm/h（雨量 10→199 mm）时入渗总量锁在
            # 8.8-10.5 mm，变动 7%。9.96 mm 降雨里 8.82 mm 被吸掉，
            # 199 mm 降雨里只剩 5%。衰减由地表水深驱动而非土壤饱和度，
            # 于是"雨越大入渗越少"和"雨越大水越多"被同一个指数锁死。
            fcap = cfg.infiltration_m_h * np.exp(-h / 0.08)
            inf = np.minimum(fcap * dt_h, h)
            h -= inf
            total_infil += float(inf.sum() * area)
        else:
            # Green-Ampt：f = Ksat·(1 + ψ·Δθ/F)，F 是累积下渗量。
            # Δθ 用当前剩余吸力 Δθ = (S_cap - S)/S_cap，
            # 不是初始的 θ_s - θ_0 常数——后者算不出饱和衰减。
            theta = np.clip(soil / max(cap, 1e-12), 0.0, 1.0)
            d_theta = np.clip(1.0 - theta, 0.0, 1.0)
            # F 的下限不能取 0：F→0 时 f 发散，单步就把土层吸干。
            # 用一个时间尺度上的哨兵值 F_eps = Ksat·dt_h，
            # 即"至少允许一个时间步的 Ksat 本底入渗"。
            f_eps = max(cfg.soil_ksat_m_h * dt_h, 1e-12)
            fcap = cfg.soil_ksat_m_h * (1.0 + cfg.soil_psi_m * d_theta
                                       / np.maximum(f_cum, f_eps))
            want = fcap * dt_h
            inf = np.minimum(want, h)

            # 土壤水硬上限。已饱和的格子吸不进去了，多余的水退回地表
            # （沿同一路径顶托回流），**不计入下渗**。
            # 这条分支是饱和机制真正起作用的地方：Ksat 已经很小，
            # 但更关键的是容量占满后 inf 直接归零，剩余降雨全部留
            # 在地表成为径流。
            room = np.maximum(cap - soil, 0.0)
            inf_kept = np.minimum(inf, room)
            inf = inf_kept

            h -= inf
            soil += inf
            f_cum += inf
            total_infil += float(inf.sum() * area)
            # Ksat 本底分量：入渗量里不依赖吸力增益的那一部分。
            # 饱和诊断靠它——若它占总入渗的绝大部分，说明增益已耗尽。
            total_ksat += float(np.minimum(cfg.soil_ksat_m_h * dt_h,
                                           inf).sum() * area)

            # ---- Ghil-Sellers 能量平衡 ----
            # Rn = G + H + LE。LE（潜热）驱动土壤蒸发，
            # 蒸发的水正是维持 Δθ 的来源，等于给入渗能力续命。
            #
            # 台风 72 h 内净辐射极低（云遮蔽），这一项是否激活必须
            # 实测，不能假设。lat_active_steps 记录 LE>0 的步数，
            # 落盘后在门槛里报，不在正文里断言。
            rn_net = cfg.net_sw_wm2 * (1.0 - cfg.albedo)   # W/m²
            g_flux = rn_net * cfg.ground_flux_frac
            h_flux = rn_net * cfg.sensible_frac
            le_flux = rn_net - g_flux - h_flux            # 剩余给潜热
            # LE (W/m²) → 蒸发速率 m/s：LE / (ρ·Lv)
            evap_m_s = max(le_flux, 0.0) * cfg.evap_efficiency / (RHO_W * LV)
            # 该步可蒸发量受**可利用土壤水**限制：不低于残余含水率。
            avail = np.clip(soil - cap * cfg.soil_theta_res, 0.0, None)
            evap = np.minimum(evap_m_s * dt_s, avail)
            soil -= evap
            total_evap += float(evap.sum() * area)
            if le_flux > 0.0:
                lat_active_steps += 1
            e_net += rn_net * dt_s / 1e6
            e_ground += g_flux * dt_s / 1e6
            e_sensible += h_flux * dt_s / 1e6
            e_latent += max(le_flux, 0.0) * dt_s / 1e6

        # 排水：管网 + 泵站。
        #
        # 口径约束：排水能力不是对每个格子无条件施加的面通量。
        # 真实管网是线状设施，只服务有管道的街道，且管顶有顶托高程——
        # 水深低于顶托时管网处于满流但无自由出流面，无法按地表水头抽水。
        # Demo 用一条堰式关系表达：过流能力∝ (h - 顶托)^1.5，
        # 顶托以下不排水。这直接决定峰值水深：
        # 若按"全市铺满设计标准"的无条件面通量建模，434 mm 降雨会推出
        # 7.4 m 的积水，那是均匀排水假设的产物，不是内涝。
        # 顶托高程需由甲方管网台账标定，Demo 取 0.05 m。
        over = np.clip(h - cfg.drainage_invert_m, 0.0, None)
        # 排水能力可乘一个**空间异质乘子场**（`drainage_mult`）。
        # None 时与原行为逐位一致；非 None 时按格点生效。
        # 该场不进 config_hash（它是 KernelParams 上的场，不是 Config 四层参数），
        # 故由 `drainage_fingerprint()` 单独定影并随产物落盘。
        # 注：本支持曾在一次工作树覆盖中丢失，导致 `drainage_mult` 变成
        # **静默空操作**（dataclass 允许设任意属性，赋值不报错但内核不读），
        # 使 p31 的结论（FP006 ×0.10 → 0.467 m）无法复现。此处恢复。
        coeff_eff = cfg.drainage_coeff_m_s
        if getattr(cfg, "drainage_mult", None) is not None:
            coeff_eff = cfg.drainage_coeff_m_s * np.asarray(cfg.drainage_mult)
        q_drain = coeff_eff * np.sqrt(cfg.drainage_invert_m + over) \
            * over ** cfg.flux_exponent
        drain = np.minimum(over, q_drain * dt_s)
        h -= drain
        total_drain += float(drain.sum() * area)

        # ---- 汇流集中（D8 路由）：把一部分地表水移到最陡下降的下游格 ----
        # 默认 rate=0 → 整段跳过，与既有行为逐位一致。
        # 守恒：每个供体格失去的量恰好加到一个受体格，故总量不变；
        #      无下游格（`_d8_rows < 0`）不参与，水留在原地（填洼成塘）。
        _rate = float(getattr(cfg, "concentration_rate", 0.0))
        if _rate > 0.0 and _d8_rows is not None:
            _src = _d8_rows >= 0
            _moved = np.where(_src, _rate * h, 0.0)
            h -= _moved
            np.add.at(h, (_d8_rows[_src], _d8_cols[_src]), _moved[_src])

        # 通量累积。三个硬约束，缺一个就会出现凭空产水：
        # 1) 必须用独立通量数组逐边累加，不能用切片互写——
        #    `h[:, :-1] -= v; h[:, 1:] += v` 在 numpy 里是视图别名，
        #    第二次赋值会覆盖第一次，水量凭空产生。
        # 2) 量纲要对。Manning 单宽流量 q=(1/n)h^(5/3)√S 的单位是 m²/s，
        #    转成该边两端的**水深变化**必须再乘 dt_s/L（时间/边长），
        #    直接乘 dt_h 得到的是体积而不是水深，差出 cell_m/dt_s ≈ 22 倍。
        # 3) 限幅必须按**供体格总出流**缩放，不能逐边独立限幅。
        #    一格有4 条边，逐边限幅的单步出流可达 4h，产生负水深；
        #    负水深进入下一步后 √S 与 h^(5/3) 均为负，限幅上下界颠倒，
        #    通量整体反向，水凭空产生。本模块最隐蔽的一个 bug。
        # 本步净出域水量（正值表示流出计算域），由 x/y 通量在边界上求和得到
        qedge = 0.0
        hl = z[:, :-1] + h[:, :-1]
        hr = z[:, 1:] + h[:, 1:]
        hu = z[:-1, :] + h[:-1, :]
        hd = z[1:, :] + h[1:, :]

        for _ in range(3):                # 松弛迭代，处理边的双向耦合
            # x 方向：每条边的净输运 vx（正值表示沿 +x 方向，单位 m 水深）
            d = hl - hr
            hf = np.where(d > 0.0,
                          hl - np.maximum(z[:, :-1], z[:, 1:]),
                          hr - np.maximum(z[:, :-1], z[:, 1:]))
            hf = np.clip(hf, 0.0, None)
            vx = (np.sign(d) * (hf ** cfg.flux_exponent)
                  * np.sqrt(np.abs(d) / grid.cell_m) * inv_n) * dt_s / grid.cell_m

            # y 方向
            d = hu - hd
            hf = np.where(d > 0.0,
                          hu - np.maximum(z[:-1, :], z[1:, :]),
                          hd - np.maximum(z[:-1, :], z[1:, :]))
            hf = np.clip(hf, 0.0, None)
            vy = (np.sign(d) * (hf ** cfg.flux_exponent)
                  * np.sqrt(np.abs(d) / grid.cell_m) * inv_n) * dt_s / grid.cell_m

            # 供体格出流预算：同一格的4 条边共享同一份水
            out = np.zeros_like(h)
            out[:, :-1] += np.where(vx > 0.0, vx, 0.0)
            out[:, 1:] += np.where(vx < 0.0, -vx, 0.0)
            out[:-1, :] += np.where(vy > 0.0, vy, 0.0)
            out[1:, :] += np.where(vy < 0.0, -vy, 0.0)
            # 出流系数留 5% 余量，避免浮点误差把h压到 0 以下
            sc = np.ones_like(h)
            nz = out > 0.0
            sc[nz] = np.minimum(1.0, 0.95 * h[nz] / out[nz])
            # 每条边取两端系数的较小者，两端都不会被抽干
            vx *= np.minimum(sc[:, :-1], sc[:, 1:])
            vy *= np.minimum(sc[:-1, :], sc[1:, :])

            # 左右边界的净输运（vx>0 向 +x，右边界流出；vx<0 左边界流出）
            # 注意：最外圈格子的对外边不在计算域内，vx[:, -1] 是 rim 内部边
            # （rim 列与第 nx-2 列之间），不是出域通量。出域量单独在
            # rim 圈上按干出流公式算，见 _rim_outflow。
            dh = np.zeros_like(h)
            dh[:, :-1] += -vx
            dh[:, 1:] += vx
            dh[:-1, :] += -vy
            dh[1:, :] += vy

            hl = z[:, :-1] + (h + dh)[:, :-1]
            hr = z[:, 1:] + (h + dh)[:, 1:]
            hu = z[:-1, :] + (h + dh)[:-1, :]
            hd = z[1:, :] + (h + dh)[1:, :]
            h = h + dh

            # 出流预算留了5% 余量，正常不该出现负值；真出现说明地形梯度
            # 与松弛次数不匹配，记为数值损耗单列，不让它污染下一步的通量方向。
            neg = float(-h[h < 0.0].sum() * area)
            if neg > 0.0:
                total_neg_loss += neg
                positivity_ok = False
                h[h < 0.0] = 0.0

        # 开边界出流：rim 圈向域外干出流。
        # 这一项才是真正的"离开计算域的水"，内部边一进一出严格抵消，
        # 若把rim 内部边当成出域通量计入，会得到一个虚高的 qedge，
        # 守恒核算随之出现无法归因的缺口。
        dh = _rim_outflow(h, cfg, dt_s)
        qedge = float(-dh.sum() * area)          # 出流为正
        h = h + dh

        # 正性与上限检查。
        # 正性必须在干湿截断**之前**判：截断会把负水深直接置零，
        # 放在之后检查，min(h) 恒为 0，校验形同虚设。
        #
        # NaN 检查必须排在正性之前。`h.min()` 对含 NaN 的数组返回 NaN，
        # 而 `NaN < -1e-12` 恒为 False，于是 `positivity_ok` 保持 True，
        # 守恒核算也返回 mass_resid=nan——两句判据同时给出假的合格结论。
        # 这里按步报出步号，便于定位发散起点而不是只看到末态。
        n_bad = count_nonfinite(h)
        if n_bad:
            raise NonFiniteError(
                f"t={k * dt_h:.2f}h 水深场含 {n_bad} 个非有限值，"
                f"数值已发散，拒绝继续推进。入口降雨场已查过，"
                f"故发散源自本步推演而非输入。")
        if h.min() < -1e-12:
            positivity_ok = False
        max_h = max(max_h, float(h.max()))

        # 水深上限是数值保险丝，不是物理边界。触发时把削掉的水登记为
        # 数值损耗单列，否则守恒核算会出现无法归因的缺口。
        over = h - cfg.max_depth_m
        cap_loss = float(over[over > 0.0].sum() * area)
        total_cap_loss += cap_loss
        if cap_loss > 0.0:
            h = np.clip(h, 0.0, cfg.max_depth_m)

        # 干湿判别：低于阈值归零。
        # 被截断掉的微量水必须计入"数值损耗"，否则守恒核算会出现虚假缺口。
        # 这是干湿判别的固有代价，不是物理过程，故单列而不摊入下渗或排水。
        dry_loss = float(np.where(h < cfg.min_depth_m, h, 0.0).sum() * area)
        if dry_loss < 0.0:
            dry_loss = -dry_loss
        total_dry_loss += dry_loss
        h[h < cfg.min_depth_m] = 0.0
        total_boundary_out += qedge

        depth[k] = h.astype(np.float32)

    t_h = np.arange(nt) * dt_h
    # 守恒核算：入 = 累计降雨；出 = 下渗 + 排水 + 边界出流 + 域内存量。
    # 边界出流由通量显式累加（qedge），不做推断，这样残差是真正的数值误差，
    # 而不是被"开放边界"这个说法掩盖掉的建模缺口。
    #
    # 土壤水不参与这个等式。它是"离开地表暂存"的量，
    # 已在 total_infil 里记了一次；期末仍持有的部分由
    # budget_energy 的"土壤储水变化"单列，不重复扣。
    stored = float(depth[-1].sum() * area)
    resid_m3 = total_rain - (total_infil + total_drain + total_boundary_out
                             + total_dry_loss + total_cap_loss
                             + total_neg_loss + stored)
    rel = abs(resid_m3) / max(total_rain, 1e-9)

    # 能量账换算成 MJ/m² 面平均。
    ne = float(nt)
    energy: dict = {}
    if cfg.infiltration_mode == "green_ampt":
        energy = {
            "净辐射_MJ_m2": round(e_net / ne, 6),
            "土壤热流_MJ_m2": round(e_ground / ne, 6),
            "感热_MJ_m2": round(e_sensible / ne, 6),
            "潜热_MJ_m2": round(e_latent / ne, 6),
            "能量闭合残差_MJ_m2": round(
                (e_net - e_ground - e_sensible - e_latent) / ne, 9),
            "潜热激活步占比": round(lat_active_steps / max(nt, 1), 4),
            "根区饱和比例_期末": round(
                float((soil >= cap - 1e-12).mean()), 4),
        }

    return RunResult(
        t_h=t_h,
        depth=depth,
        rain_cum=rain_cum,
        rain_total_m3=total_rain,
        infil_total_m3=total_infil,
        drain_total_m3=total_drain,
        boundary_out_m3=total_boundary_out,
        dry_loss_m3=total_dry_loss,
        cap_loss_m3=total_cap_loss,
        neg_loss_m3=total_neg_loss,
        mass_resid=float(rel),
        positivity_ok=positivity_ok,
        n_cells=int(ny * nx),
        cell_area_m2=area,
        infiltration_mode=cfg.infiltration_mode,
        evap_total_m3=total_evap,
        soil_final_m3=float(soil.sum()) * area,
        soil_init_m3=soil_init,
        ksat_total_m3=total_ksat,
        energy=energy,
        drainage_fingerprint=drainage_fingerprint(cfg),
    )


def _rim_outflow(h: np.ndarray, cfg: KernelParams, dt_s: float) -> np.ndarray:
    """rim 圈向域外的自由出流，返回非正的水深增量场。

    域外水位固定在 rim 格子地面高程处（相当于紧邻路缘的无限低洼），
    于是 rim 积水越深、内外水头差越大，出流越快；h→0 时出流自然归零。
    不需要下调地形做人工唇口——那会在角点叠加两次降幅，
    形成两米深的人工角槽，把峰值水深直接顶到上限。
    """
    rim = np.zeros_like(h, dtype=bool)
    rim[0, :] = rim[-1, :] = True
    rim[:, 0] = rim[:, -1] = True

    hf = np.where(rim, h, 0.0)               # 过流断面水深 = rim 积水深
    v = ((hf ** cfg.flux_exponent) * np.sqrt(hf) / cfg.manning_n) * dt_s
    v = np.minimum(v, 0.95 * h)
    return -np.where(rim, v, 0.0)


def _fill_depressions(z: np.ndarray, eps: float = 1e-3) -> np.ndarray:
    """Priority-Flood 洼地填充，附 ε 梯度。

    只填**内部**洼地，边界像元一律视为出流口、不参与填充。
    填平后的洼面必须保留 ε 量级的排水梯度，否则那片水面零坡度、
    水在上面不流动，积水只增不减，直接堆到 max_depth_m 上限。
    ε 取 1e-3 m，在 161 m 网格上坡度约 6e-6，浅水仍可缓慢排走，
    又不会在 DEM 上引入可见的阶跃。
    """
    zz = z.astype(np.float64).copy()
    ny, nx = zz.shape
    BIG = 1.0e6
    for _ in range(200):
        nb_min = np.full_like(zz, BIG)
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                if di == 0 and dj == 0:
                    continue
                nb_min = np.minimum(nb_min, _shift(zz, di, dj, BIG))
        low = zz < nb_min - eps
        if not low.any():
            break
        zz = np.where(low, nb_min - eps, zz)

    # ε 梯度：按到边界的距离把填平区轻微抬高，形成向出口的坡面。
    # 只对被填过的像元施加，原有起伏不动。
    iy, ix = np.mgrid[0:ny, 0:nx]
    dist = np.minimum.reduce([iy, ny - 1 - iy, ix, nx - 1 - ix]).astype(np.float64)
    flat = zz <= z + 1e-9                # 抬升过的像元
    zz = zz + eps * dist * flat
    return zz


def _shift(a: np.ndarray, di: int, dj: int, fill) -> np.ndarray:
    out = np.full_like(a, fill)
    ny, nx = a.shape
    si0, si1 = max(0, -di), min(ny, ny - di)
    sj0, sj1 = max(0, -dj), min(nx, nx - dj)
    di0, di1 = max(0, di), min(ny, ny + di)
    dj0, dj1 = max(0, dj), min(nx, nx + dj)
    out[si0:si1, sj0:sj1] = a[di0:di1, dj0:dj1]
    return out