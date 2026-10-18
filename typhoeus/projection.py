"""提比翁 Demo —— 状态到功能投影层（单调损伤算子 D）。

对应文档 6.1：水深场 -> 容量场 -> 需求加权聚合为功能曲线族 Q(t)；
割点为状态空间几何解。

关键约束：
  D必须单调非减（水越深，功能越低），否则恢复排序失去意义。
  深度阈值对齐宁波官方积水四色分级：0.1 / 0.2 / 0.5 m。
  单调性是硬门槛，由 check_monotone 显式校验，不通过则拒绝输出。
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .finiteness import assert_finite

# 宁波官方积水分级（内涝监测点四级）
DEPTH_LEVELS = (0.10, 0.20, 0.50)
LEVEL_NAMES = ("绿 <0.1m", "黄 0.1-0.2m", "橙 0.2-0.5m", "红 ≥0.5m")

# 道路类型与通行能力衰减（单位：通行能力保留比例）
#
# 取值来源与不确定度（`../docs/analysis/REN_BENCHMARK.md` A2）：这三个系数决定全部功能量级，
# 但此前写死在模块常量里，改动不进 config_hash，门槛 4/6/7 的判据全部
# 建在无出处的两字母系数上。现外置为 ProjectionParams 的字段。
#
#   a = 半损水深（m）：通行能力降到 (1-a) 的水深
#   b = 中断水深（m）：通行能力降到 a 的水深
#
# 标定依据：现行值使 434 mm 过程雨量下峰值水深落在 0.94 m 量级，
# 与 2021 烟花实测的城区最深 0.68 m 同量级。未取得逐路段实测通行数据，
# 属工程经验值。**改动本表必须同时改 config 与输出物的 note。**
ROAD_CAPACITY = {
    "支路": {"a": 0.25, "b": 0.45},   # 0.25m 半损，0.45m 中断
    "主干路": {"a": 0.35, "b": 0.60},
    "下穿立交": {"a": 0.12, "b": 0.25},
}
ROAD_MIX = {"支路": 0.60, "主干路": 0.30, "下穿立交": 0.10}

# 各路型系数的不确定区间（相对 ±），用于敏感性分析。
# 下穿立交的区间最宽：该类型无桥下高程实测，a/b 只能按路宽与经验取值。
ROAD_CAPACITY_TOL = {
    "支路": 0.20,
    "主干路": 0.20,
    "下穿立交": 0.30,
}


@dataclass
class ProjectionParams:
    """策略参数（L3）。

    承灾体系数外置（A2）：road_capacity / road_mix 从模块常量搬进参数对象，
    使 L3 策略层的改动能进 config_hash。改动前改一个系数不影响 hash，
    意味着"复算"这句话对最关键的三个系数不成立。
    """

    # 各需求方的功能权重与不可替代性
    weights: dict = None
    # 承灾体：路型-> {a: 半损水深, b: 中断水深}。None 时取模块默认值。
    road_capacity: dict = None
    # 路网占比。None 时取模块默认值。
    road_mix: dict = None

    def __post_init__(self):
        if self.weights is None:
            self.weights = {
                "通勤": 0.30,
                "急救通道": 0.35,
                "物资配送": 0.20,
                "通勤供电": 0.15,
            }
        if self.road_capacity is None:
            self.road_capacity = {r: dict(v) for r, v in ROAD_CAPACITY.items()}
        if self.road_mix is None:
            self.road_mix = dict(ROAD_MIX)
        self._validate()

    def _validate(self) -> None:
        """承灾体系数的口径校验。

        校验放在这里而不是 `capacity()` 里：`capacity` 只见到一对 a/b，
        看不到同组其他路型，也看不到路网占比，跨字段的一致性查不了。
        静默的系数错误会一路走到输出物，读者只会看到"功能损失 3.56%"
        这样的数字，看不出系数本身不自洽。
        """
        for road, ab in self.road_capacity.items():
            a, b = ab["a"], ab["b"]
            if not (0.0 <= a <= 1.0):
                raise ValueError(f"{road} 的半损容量 a={a} 越界，应在 [0,1]")
            # 量纲检查排在"b 与 a 的次序"之前：b ≤ 绿级阈值时，
            # 报单位错误比报次序错误更接近根因——前者只需把厘米改成米，
            # 后者会让人去查本来就没错的水深阈值。
            if b <= DEPTH_LEVELS[0]:
                raise ValueError(
                    f"{road} 的中断水深 b={b} m 不高于绿级阈值 "
                    f"{DEPTH_LEVELS[0]} m，量纲不自洽——半损与中断水深"
                    f"都应在绿级之上。请核对单位是米不是厘米")
        s = sum(self.road_mix.values())
        if abs(s - 1.0) > 1e-6:
            raise ValueError(f"路网占比之和为 {s}，应为 1.0")

    def to_dict(self) -> dict:
        """序列化，供 config hash 与输出物登记。"""
        return {"weights": self.weights,
                "road_capacity": self.road_capacity,
                "road_mix": self.road_mix}


def capacity(h: np.ndarray, a: float = 0.25, b: float = 0.45) -> np.ndarray:
    """单调损伤算子 D：水深 -> 通行能力保留比。

    D(h) = 1,                h <= 0.1
         = 1 - (h-0.1)/(b-0.1) * (1-a),  0.1 < h <= b
         = a,                 h > b
    该函数在 [0, +inf) 上单调不增，即功能随水深单调不增（容量单调）。

    退化保护：分母 `b - 0.1` 在 b ≤ 0.1 时为0 或负。
    除零会让 seg 全为 inf，`np.clip` 把 inf 夹到 a，于是整条曲线塌成常数 a，
    **D 仍然"单调"（常数列通过 check_monotone），但功能曲线完全失真**——
    这是一个不会报错、只静默出错的坑。b ≤ 0.1 的物理含义是
    "半损与中断水深都低于绿级阈值"，即该类路型在0.1 m 就已中断，
    此时取 a 为容量上限是正确的退化。参数校验在 ProjectionParams 里做，
    这里只保证函数本身不会除零。
    """
    h = np.asarray(h, dtype=np.float64)
    lo, hi = DEPTH_LEVELS[0], float(b)
    if hi - lo <= 1e-12:
        # 退化：b 落在绿级阈值以内，按"该处即中断"处理
        return np.where(h <= lo, 1.0, a)
    seg = np.clip(1.0 - (h - lo) / (hi - lo) * (1.0 - a), a, 1.0)
    return np.where(h <= lo, 1.0, seg)


def check_monotone(h: np.ndarray, **kw) -> tuple[bool, float]:
    """校验D的单调性。返回（是否单调、最大违背幅度）。"""
    hs = np.linspace(0.0, 1.0, 200)
    caps = capacity(hs, **kw)
    diff = np.diff(caps)
    worst = float(-diff.min()) if diff.size else 0.0
    return bool(diff.max() <= 1e-12), worst


def aggregate(depth: np.ndarray, cfg: ProjectionParams = ProjectionParams()) -> dict:
    """把水深时序聚合成功能曲线 Q(t) 与割点。

    depth: (nt, ny, nx) 水深场，m
    返回功能曲线（按需求分）、综合 Q(t)、割点时刻。

    两条实现约束：
    1) 逐时聚合，不对整个三维场做 float64 提升。433x144x270 的 float64
       副本是 128 MiB，三种路型各算一次直接爆内存；单步 float32 提升只占
       16 KiB。
    服务人口口径：Q 取**功能保持率**，基准为无灾时刻的容量 1.0。
    逐时损失 = 空间平均容量损失，即面积加权的服务能力下降幅度：

        Q(t) = 1 - cap_avg(t)

    Demo 没有人口栅格，按人口在计算域内均匀分布处理，因此这是
    **损失下界**：宁波实际人口集中在老城区低洼处，那里恰是水深最大的
    区域，按人口加权后的真实损失高于此值。

    两条已排除的错误口径：
    - "空间平均容量 × 1/√affected 权重"：该权重的归一化分母若取全时段
      均值，affected=0 的无灾时刻会得到 1/√1e-3 = 31.6 倍权重，Q(0)
      被抬到无灾基线的 31.6 倍，割点落在起雨瞬间 1.5 h、最低功能 0.133。
    - "空间平均容量损失 × affected"：二次稀释。`1 - cap_avg` 已经是全
      网格面积加权损失，再乘受影响面积占比等于把同一批格子数了两遍，
      峰值功能损失被压到 0.07%，量级失真。
    """
    nt = depth.shape[0]
    d = np.asarray(depth)
    if d.dtype != np.float32:
        d = d.astype(np.float32)

    # NaN 防线。`capacity()` 里的 `np.where(h <= lo, 1.0, seg)` 对 NaN 取
    # else 分支，seg 也变NaN；一路到 `Q.min()` 时 aggregate 返回
    # min_Q=nan 而不报错，nan 直接写进 04_resilience_pricing.json。
    # 投影层是水深的最后一个消费者，在这里拦比在输出物里拦更早。
    assert_finite(d, "projection.aggregate 入口水深时序")

    # 各路型的空间平均容量，逐时算
    #
    # 注意这里逐时取的是该时刻的空间平均，不是全时段的时间平均。
    # 写成 `acc += mean(cap); caps = acc / nt` 会把整条曲线压成 1/nt：
    # t=0 无灾时容量为 1.0，除以 433 步后变成 0.0023，再被需求权重
    # 放大回 0.0067，Q(0) 恒小于 Q(t)，event_total 恒为 0，
    # 门槛 8 的三项分解全部退化成 0。
    caps = {road: np.zeros(nt) for road in cfg.road_capacity}
    for road, ab in cfg.road_capacity.items():
        a, b = ab["a"], ab["b"]
        for k in range(nt):
            caps[road][k] = float(capacity(d[k], a, b).mean())

    affected = (d > DEPTH_LEVELS[0]).reshape(nt, -1).mean(axis=1)

    # 需求加权：不同需求对不同道路类型的依赖不同
    q_by_demand = {}
    for name, w in cfg.weights.items():
        # 急救与配电对下穿立交更敏感，物资配送对主干路更敏感
        if name in ("急救通道", "通勤供电"):
            mix = {"支路": 0.25, "主干路": 0.30, "下穿立交": 0.45}
        elif name == "物资配送":
            mix = {"支路": 0.35, "主干路": 0.45, "下穿立交": 0.20}
        else:
            mix = {"支路": 0.60, "主干路": 0.30, "下穿立交": 0.10}
        q = np.zeros(nt)
        for road, wm in mix.items():
            q += wm * caps[road]
        q_by_demand[name] = q

    # 综合功能保持率
    Q = np.zeros(nt)
    for name, w in cfg.weights.items():
        Q += w * q_by_demand[name]

    # 割点：功能跌至事件最低点的 80% 恢复水平的时刻，即损失达到
    # 峰值损失的 80%。不取"跌破 Q(0) 的 80%"——合成降雨下功能损失
    # 幅度只有 2% 至 7%，绝对阈值 0.8·Q(0) 在整个 72 h 窗内都不会被
    # 跌破，割点恒等于窗口末端（第 72 h），语义上等于没有割点。
    loss = 1.0 - Q
    loss_max = float(loss.max())
    if loss_max <= 1e-9:
        cutoff, thresh = 0, 0.0
    else:
        thresh = 0.80 * loss_max
        below = np.where(loss >= thresh)[0]
        cutoff = int(below[0]) if below.size else int(np.argmax(loss))

    return {
        "Q": Q,
        "Q_by_demand": q_by_demand,
        "capacity_by_road": caps,
        "affected_share": affected,
        "cutoff_index": cutoff,
        "cutoff_value": float(Q[cutoff]),
        "cutoff_loss": float(1.0 - Q[cutoff]),
        "peak_loss": loss_max,
        "min_Q": float(Q.min()),
        "final_Q": float(Q[-1]),
    }


def level_counts(depth: np.ndarray) -> dict:
    """峰值时刻各积水分级像元占比（对齐宁波四色分级）。"""
    peak = depth.max(axis=0)
    out = {}
    prev = 0.0
    for i, lv in enumerate((0.10, 0.20, 0.50, np.inf)):
        mask = (peak >= prev) & (peak < lv)
        out[LEVEL_NAMES[min(i, 3)]] = float(mask.sum() / peak.size)
        prev = lv
    return out