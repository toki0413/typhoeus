"""提比翁 Demo —— 配置与审计层（参数四层+ config hash）。

对应文档 13.1：L1 物理常数 / L2 场地参数 / L3 策略参数 / L4 求解参数，
配config hash 复算。

关键约束：同一 hash 才能复算。config 变了输出物必须标脏，
否则"复算"这个说法就不成立。这是审计要求，不是工程洁癖。
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from dataclasses import fields as dataclass_fields


@dataclass
class L1_Physical:
    """L1 物理常数层：不随场地变化，改动需重新标定全局。"""

    g: float = 9.81
    manning_n: float = 0.016# 沥青路面糙率
    cc_exponent: float = 0.07       # Clausius-Clapeyron 标度 K^-1
    sst_cc_lim: float = 0.6         # 平准化位势增量 K
    kinematic_viscosity: float = 1.31e-6  # m²/s，20 ℃ 水


@dataclass
class L2_Site:
    """L2 场址与输入数据层：随片区变化，换片区须重新标定。"""

    # 降雨源。parametric = 台风路径参数化合成场（历史默认）；
    # era5 = 经 Open-Meteo archive-api 取 ERA5 再分析（免 key）。
    # 两者口径差异必须随输出物一起落盘，见 rainsrc.get_rainfall 的报告。
    rain_source: str = "era5"
    # 是否用域内实测站对再分析做分位数订正。关掉则直接用 ERA5 原值，
    # 此时面雨量偏低但口径更"干净"——不掺入任何站点信息。
    rain_calibrate: bool = True
    # 降雨场缓存。离线复现靠它；关掉则每次实时拉取（慢且依赖网络）。
    rain_use_cache: bool = True

    bbox: dict = field(default_factory=lambda: {
        "lon_min": 121.55, "lon_max": 121.70,
        "lat_min": 29.84, "lat_max": 29.92,
    })
    dem_file: str = "dem_n29e121.tif"
    dem_is_dsm: bool = True         # 关键：GLO-30 是 DSM
    flatten_building_m: float = 12.0
    design_drainage_yr: int = 15    # 宁波排涝标准 15-20 年一遇
    storage_capacity_mm: float = 30.0
    # 管网排水顶托高程（m）。管顶埋深多在地面下 0.5-1.5 m，
    # 但地面积水进入管网需先填满竖井与连接段，Demo 用0.05 m 等效起排阈值。
    # 标定依据：该值直接决定峰值水深，从 0（无条件面排水）提到 0.05 后
    # 434 mm 降雨下的峰值水深由 7.41 m 降到 1.07 m。
    drainage_invert_m: float = 0.05
    # 管网过流系数（m/s），堰式关系 q = C·√(h0+Δh)·Δh^(5/3)。
    # 标定依据：使 334 mm 过程雨量下峰值水深落在 0.94 m 量级。
    drainage_coeff_m_s: float = 1.2e-3
    # 入渗机制。green_ampt = 土壤饱和度驱动（Green-Ampt + Ghil-Sellers
    # 能量平衡），legacy = 地表水深驱动的稳定下渗率衰减（v0.5.0 之前口径）。
    # 机制选择进 config_hash —— 它是模型身份的一部分。
    infiltration_mode: str = "green_ampt"
    # legacy 模式专用：稳定下渗率 m/h。城镇硬化面高，雨水几乎不渗透。
    infiltration_m_h: float = 1.2e-3
    # 饱和导水率 m/h。宁波粉质黏土实测 3.6e-3~3.6e-2 m/h，但计算域
    # 是压平建筑后的 DSM 硬化面，取原状土值会让 72 h 入渗量超过降雨量。
    soil_ksat_m_h: float = 1.2e-3
    # 湿润锋吸力头 m。粉质黏土典型 0.05-0.15 m。
    soil_psi_m: float = 0.10
    # 根区土壤水容量 mm。决定饱和所需的累积入渗量：
    # (有效容量 × (1-θ0)) / Ksat 即饱和时间尺度。
    soil_capacity_mm: float = 30.0
    # 硬化面占比（屋顶 + 路面）。宁波老城实测 70-80%。
    # 有效土壤容量 = 容量 × (1 - 该值)，取 0.75 时为 7.5 mm。
    impervious_frac: float = 0.75
    # 初始相对含水率（占饱和容量比例）。
    #
    # 标定依据（v0.6.1，typhoeus/soilsrc.py 实测 ERA5-Land）：
    # 烟花登陆 anchor 2021-07-25T06:00，宁波 0-7 cm 表层sm=0.520 m³/m³，
    # 按 θ_sat=0.46/θ_res=0.08 并做 +0.065 湿偏改正后**实测 θ=0.987**，
    # 即土壤在台风登陆前已接近饱和。0-1 cm / 0-7 cm / 7-28 cm 三个深度层
    # 分别给 0.987 / 0.987 / 0.982，三层互证，不是单层噪声。
    #
    # 但内核里直接取 0.987 会让 Green-Ampt 退化成常数入渗：tools/
    # infil_diag.py 实测 72h 钟形雨场（imperv=0.75，有效容量 7.5 mm）
    # 下 θ0=0.987 时吸力增益在三个强度档恒为 0.000 mm，场次间失去区分。
    # 取 0.45 时弱/中/强场次吸力增益为 0.000 / 2.089 / 3.132 mm。
    #
    # 口径说明：观测是**自然地表**的土壤含水，计算域是**压平建筑的 DSM
    # 硬化面**（宁波老城硬化面占比 70-80%）。城市不透水面阻断补给，
    # 压实层与管网快速排走雨水，根区不可能达到自然田面的饱和度。
    # 因此 0.45 代表"城市硬化面下的相对初始含水率"，实测 0.987 是它的
    # **上界**。两者不矛盾，缺的是中间那个城市折减系数，目前无观测。
    soil_theta0: float = 0.45
    # 残余相对含水率。土壤水不能再低于此值。
    soil_theta_res: float = 0.08
    # ---- Ghil-Sellers 能量平衡 ----
    # 净短波辐射 W/m²。**可被观测覆盖**：soil_source=era5land 时由
    # `soilsrc.get_soil()` 的 ET0 反推（见 `_net_sw_from_et0`）。
    # 常量值40.0 是 v0.5.0 的定性标定，无观测锚点。
    net_sw_wm2: float = 40.0
    # 土壤初始状态与蒸散驱动的数据源。
    #   era5land  —— ERA5-Land 免key（Open-Meteo archive-api），接实测
    #   parametric —— 参数化常数，无观测锚点
    # 它决定 `soil_theta0` 与 `net_sw_wm2` 是否被观测覆盖。
    soil_source: str = "era5land"
    # 城市折减系数：观测给的是自然地表 θ，计算域是硬化面，中间这层
    # 无观测。0.45 = 实测 0.987 x 0.456。设 1.0 即直接采用观测值
    # （代价：Green-Ampt 吸力增益归零，见 soil_theta0 注释）。
    urban_theta_frac: float = 0.456
    # 有效蒸发面积占全域比。硬化面不蒸发，蒸散只在土壤层发生，
    # 故ET0 要乘 (1 - impervious_frac) 才能与内核口径对齐。
    evap_area_frac: float = 0.25
    # 地表反照率。湿润沥青 0.08，城镇综合 0.15。
    albedo: float = 0.15
    # 土壤热流与感热占净辐射的比例，剩余给潜热。
    ground_flux_frac: float = 0.25
    sensible_frac: float = 0.45
    # 潜热通量中真正消耗土壤水的比例，其余被湍流与平流带走。
    evap_efficiency: float = 0.65


@dataclass
class L3_Strategy:
    """L3 策略参数层：规划器与决策偏好，改动不需重算物理。"""

    ensemble_members: int = 5
    preselect_budget: int = 12
    adj_tol: float = 0.10
    # 残差门控阈值（相对残差，占观测均值比例）。功能曲线归一化后
    # 逐步残差峰值约0.03，阈值取 0.02 才能在漂移累积前触发；
    # 取 0.20 会让门控永不触发，门槛 13 退化为恒假判据。
    resid_gate: float = 0.02
    resid_tol: float = 0.20
    climate_share: float = 0.55
    excess_share: float = 0.25
    engineering_share: float = 0.15

    # 承灾体：路型 -> {a: 半损水深 m, b: 中断水深 m}。
    # 此前这三个系数写死在 projection.py 的模块常量里，改动不进 config_hash，
    # 而门槛 4/6/7 的判据全部建立在它们之上——"同一 hash 才能复算"
    # 对最关键的三个系数不成立。现搬进 L3 层。
    # 标定依据与区间见 projection.ROAD_CAPACITY 的注释。
    road_capacity: dict = field(default_factory=lambda: {
        "支路": {"a": 0.25, "b": 0.45},
        "主干路": {"a": 0.35, "b": 0.60},
        "下穿立交": {"a": 0.12, "b": 0.25},
    })
    # 路网占比，与 road_capacity 同步才有效。
    road_mix: dict = field(default_factory=lambda: {
        "支路": 0.60, "主干路": 0.30, "下穿立交": 0.10,
    })


@dataclass
class L4_Solver:
    """L4 求解参数层：数值参数，只影响速度与稳定性。"""

    dt_s: float = 600.0
    max_t_h: float = 72.0
    resample: int = 2
    min_depth_m: float = 1e-4
    tol_mass: float = 1e-6
    # 数值保险丝。Demo 实测峰值 0.94 m，取 3.0 有3倍余量；
    # 触发即说明物理或标定出了问题，截断量单列登记为数值损耗。
    max_depth_m: float = 3.0
    flux_relax: int = 3


@dataclass
class Config:
    l1: L1_Physical = field(default_factory=L1_Physical)
    l2: L2_Site = field(default_factory=L2_Site)
    l3: L3_Strategy = field(default_factory=L3_Strategy)
    l4: L4_Solver = field(default_factory=L4_Solver)

    def to_dict(self) -> dict:
        return {
            "L1_physical": asdict(self.l1),
            "L2_site": asdict(self.l2),
            "L3_strategy": asdict(self.l3),
            "L4_solver": asdict(self.l4),
        }

    def hash(self) -> str:
        """config hash：四层参数的 SHA256前 12 位。"""
        blob = json.dumps(self.to_dict(), sort_keys=True, ensure_ascii=False)
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:12]

    def save(self, path: str) -> None:
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"config_hash": self.hash(), **self.to_dict()},
                      f, ensure_ascii=False, indent=2)

    @staticmethod
    def load(path: str) -> "Config":
        """从JSON 读配置。

        未知字段显式告警（`ENGINEERING_MATURITY.md` H6）。此前是静默
        `if hasattr` 跳过：字段名拼错、或者用了旧版本内核的字段名，
        用户看到"配置已加载"就以为新参数生效了，实际它没进对象也没进 hash。
        静默失败在这里的代价特别大——它让"复算"失去意义，
        因为两个不同意图的配置会给同一个 hash。
        """
        import warnings

        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        c = Config()
        for key, cls in (("L1_physical", L1_Physical), ("L2_site", L2_Site),
                         ("L3_strategy", L3_Strategy), ("L4_solver", L4_Solver)):
            if key in d:
                obj = cls()
                unknown = [k for k in d[key] if not hasattr(obj, k)]
                for k, v in d[key].items():
                    if hasattr(obj, k):
                        setattr(obj, k, v)
                if unknown:
                    warnings.warn(
                        f"配置 {key} 含未知字段 {unknown}，已忽略。"
                        f"若期望其生效，请检查字段名拼写与内核版本"
                        f"（当前 {cls.__name__} 定义的字段："
                        f"{[f.name for f in dataclass_fields(cls)]}）",
                        stacklevel=2)
                setattr(c, key.split("_")[0].lower(), obj)
        return c