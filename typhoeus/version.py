"""提比翁 Demo —— 版本与向后兼容。

对应文档 14.4：语义化版本、文件格式冻结、影子运行、REST 只增不改。

Demo 阶段能落地的只有两条，但必须先立住，否则后续无法追溯：
  schema_version —— 输出物格式版本，只增不改，改了必须升号
  compat_check() —— 读旧版本输出物时给出版本差异，不静默改写
"""
from __future__ import annotations

import json

KERNEL_VERSION = "0.6.1-demo"
# 3.7.0 相对 3.6.0：**入渗的两个标定常数换成观测锚点**。
#
# 3.6.0 把入渗机制换成了Green-Ampt，但 `soil_theta0` 与 `net_sw_wm2`
# 两个常数是按"未饱和 + 阴天"定性判断定的，没有观测。本版本接入
# ERA5-Land（Open-Meteo archive-api，免 key，CC BY 4.0）把两个常数
# 换成有出处的值。
#
# 实测一：土壤在台风登陆前已接近饱和。
#   anchor 2021-07-25T06:00，宁波 0-7 cm 表层 sm=0.520 m³/m³，
#   按 θ_sat=0.46 / θ_res=0.08 做 +0.065 湿偏改正后 θ=0.987。
#   0-1cm / 0-7cm / 7-28cm 三层分别给 0.987 / 0.987 / 0.982，互证。
#   湿偏区间两端跨过 θ=1：bias=0.05 给 1.026，bias=0.08 给 0.947，
#   取中值 0.065 得 0.987。
#
#   但直接取 0.987 会让机制退化：tools/infil_diag.py 实测 72h钟形
#   雨场（imperv=0.75，有效容量 7.5 mm）下三档强度（4/16/40 mm/h）
#   的吸力增益全为 0.000 mm，入渗退化成常数 Ksat。θ0=0.45 时为
#   0.000 / 2.089 / 3.132 mm，机制才有区分度。
#
#   口径：观测测的是**自然地表**，计算域是压平建筑的**DSM 硬化面**。
#   不透水面阻断补给、压实层降渗透、管网快速排走，根区达不到自然
#   田面饱和度。所以观测值是城市值的**上界**，中间那个折减系数
#   （`urban_theta_frac`=0.456）目前无观测，显式参数化落盘。
#
# 实测二：净短波辐射原值低估1.95倍。
#   同窗口 `et0_fao_evapotranspiration` 72h 累计 5.47 mm。ET0 定义在
#   充分供水草地，而硬化面不蒸发，内核的土壤蒸发只发生在土壤层，
#   量纲上要乘 (1-impervious_frac)=0.25 对齐口径，目标 1.3675 mm。
#   由 Ghil-Sellers 潜热项反解 net_sw = 78.0 W/m²，原常量 40.0。
#   正算校核回 1.3675 mm，残差 0.00e+00。
#
# 影响量级（主链实测，ERA5 场，面雨量 259.1 mm）：
#   入渗 4.83 → 5.49 mm（Ksat 本底 2.69 / 吸力增益 2.80）
#   土壤蒸发 0.70 → 1.37 mm，能量闭合残差 0.0 MJ/m²
#   峰值水深 0.4928 → 0.4930 m
#   守恒残差 5.56e-09，正性通过，27 门槛仍 15 PASS / 5 FAIL / 7 BLOCKED
#
#   净短波改了 1.95 倍，但蒸发的绝对增量只有 0.67 mm，占面雨量 0.23%。
#   **校正后的量级依然不足** —— 这是实测结论，不是接入无效的托词。
#   θ0 从 0.45 到 0.987 会把入渗压到 0.80 mm，而峰值水深只动
#   0.4256 → 0.4256 m。入渗这一项在主链上已无杠杆，杠杆在管网能力
#   与地形分辨率（门槛 14 的根因）。
#
# 顺带修掉一个既存缺陷：`infil_mm` 只落在 kernel 段，门槛 14 从顶层
# ctx 读它，于是恒读到 0.0，note 输出"入渗总量仅 0.0 mm"这个假数字。
# 顶层补写并加断言，两处不一致直接 RuntimeError。
#
# 新增模块：`soilsrc`（数据接入 + 缓存 + 换算）、`soilcal`
# （观测 → 内核参数的两次口径转换）。测试 118 → 137 条。
SCHEMA_VERSION = "3.7.0"
MIN_READABLE_SCHEMA = "3.0.0"


def parse_semver(v: str) -> tuple[int, ...]:
    """解析语义化版本，非标准 Demo 后缀截断。"""
    core = v.split("-")[0]
    return tuple(int(x) for x in core.split(".") if x.isdigit())


def bump_minor(v: str) -> str:
    a, b, c = parse_semver(v)
    return f"{a}.{b+1}.0"


def check_compat(payload: dict) -> dict:
    """检查输出物兼容性。低于最小可读版本直接拒绝，不猜测字段含义。"""
    v = payload.get("schema_version", "0.0.0")
    cur, minr = parse_semver(v), parse_semver(MIN_READABLE_SCHEMA)
    if cur < minr:
        return {
            "readable": False,
            "reason": f"输出物版本 {v} 低于最小可读版本 {MIN_READABLE_SCHEMA}，拒绝读取",
        }
    if cur > parse_semver(SCHEMA_VERSION):
        return {
            "readable": True,
            "forward_compatible": False,
            "reason": f"输出物版本 {v} 高于本内核 {SCHEMA_VERSION}，字段可能缺失",
        }
    return {"readable": True, "forward_compatible": True, "reason": "兼容"}


def stamp(payload: dict) -> dict:
    payload.setdefault("schema_version", SCHEMA_VERSION)
    payload.setdefault("kernel_version", KERNEL_VERSION)
    return payload