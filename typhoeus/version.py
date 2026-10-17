"""提比翁 Demo —— 版本与向后兼容。

对应文档 14.4：语义化版本、文件格式冻结、影子运行、REST 只增不改。

Demo 阶段能落地的只有两条，但必须先立住，否则后续无法追溯：
  schema_version —— 输出物格式版本，只增不改，改了必须升号
  compat_check() —— 读旧版本输出物时给出版本差异，不静默改写
"""
from __future__ import annotations

import json

KERNEL_VERSION = "0.6.0-demo"
# 3.6.0 相对 3.5.0：**入渗机制从地表水深驱动换成土壤饱和度驱动**。
#
# 原机制（保留为 `infiltration_mode="legacy"`）：
#   f = 稳定下渗率 × exp(-h/0.08)，衰减由**地表水深**驱动。
#   tools/infil_diag.py 实测缺陷（36×68 网格，72 h 钟形雨场）：
#   峰值雨强 2→40 mm/h（面雨量 59→1179 mm）时入渗总量锁在
#   49.2–60.0 mm，跨 12 倍雨量只变 22%。衰减量与土壤状态无关，
#   于是「雨越大水越多」被同一个指数按住。
#
# 新机制（默认 `green_ampt`）：
#   f = Ksat·(1 + ψ·Δθ/F)，F 是**累积下渗量**、Δθ 是剩余吸力，
#   叠 Ghil-Sellers 显式能量平衡 Rn = G + H + LE，LE 驱动土壤蒸发。
#   入渗能力由土壤状态决定，土壤饱和后退化为纯 Ksat。
#   能量闭合残差 < 1e-9 MJ/m²，潜热激活步占比由实测算据落盘。
#
# 两处标定错误在实施中被实测抓出并修正：
# 1. 有效土壤容量必须折减硬化面。宁波老城硬化率 70–80%，
#    不折减等于把整片城区当裸土农田，入渗被 30 mm 名义容量锁死，
#    59 mm 与 1179 mm 雨场的入渗只差 0.04 mm。
# 2. θ0=0.75 时仅剩 1.875 mm 可吸，场次一开始就饱和，
#    吸力增益在所有场次恒为 0，机制形同虚设。改 0.45。
#
# 主链实测影响（ERA5 场，面雨量 259.1 mm，峰值雨强 9.7 mm/h）：
#   入渗 75.76 → 4.83 mm，峰值水深 0.4629 → 0.4928 m。
#   涝点 MAE 0.359 → 0.33量级，方向正确但量级远不够：
#   观测下立交 0.50 m，模型抬 0.03 m 无济于事，门槛 14 仍 FAIL。
#   已定位的根因是峰值雨强（ERA5 9.7 vs 参数化场 16.43 mm/h），
#   不是入渗机制。入渗这一项到此为止，进一步杠杆在雨强分辨上。
#
# 口径修正：
#   `KernelParams` 构造抽到 `cli._kernel_params(cfg)`，主链与多事件
#   批量共用。两处各写一遍时，改 config 忘改其中一处会让两批场次
#   用不同入渗机制，强度—损失标度里混进机制差异。
#
# 测试 99 → 113 条。新增覆盖：守恒在加土壤状态与蒸发后仍闭合、
# 土壤侧恒等式 ΔS = 下渗 − 蒸发、有效容量是硬上限、硬化面折减
# 单调影响入渗、吸力增益随饱和衰减、legacy 不产出土壤账、
# 能量四项闭合、潜热激活如实报、拼错机制名必须 raise、
# 入渗参数进 config hash。
# 3.6.1 相对 3.6.0：**集合分位数的估计口径改了，产物数值随之变**。
#
# 三处实测缺陷：
# 1. 分位数取下标用 `int(q*len(vals))`，成员只有 5 个时 p80/p90/p95
#    全落在同一个成员上。产物里三个数完全相等（251.6 mm ×3），
#    而预置方案单的触发阈值直接取 p90、Q 分解的气候/超标项也取 p90，
#    "按分位数分级预案"当时是无内容的。
# 2. 成员缩放因子先在 CC 置信区间内均匀抽样再 clip 到 [0.85,1.15]，
#    约三分之一成员贴在边界上，分布形状被截断人为制造。现按
#    CC 区间当 95% 置信区间处理换成 σ=(hi−lo)/(2×1.96) 的正态抽样，
#    截断范围放宽到 [0.80,1.25]；默认成员数 5 → 200。
# 3. 渲染层读 `档位`/`note`，而价目表工件的字段名是
#    `档`/`区间`/`对应减少功能损失_pct`。键名对不上时页面三行的
#    首列与说明列为空，中间列显示数组字面量 `[2.0, 5.0]`。
#
# 主链实测影响（同一 ERA5 场，config_hash 92cd76c2ea3f）：
#   分位数 206.4/251.6/251.6/251.6 → **258.4/313.2/338.8/354.1**（严格单调）。
#   触发阈值面雨量 251.6 → 338.8 mm。
#   Q 分解超标项 0.0817 → 0.1079，残差项 −0.0464 → −0.0726，
#   残差占比 6.4% → 10.0%（门槛 8 判据 ≤20% 仍通过）。
#   空间覆盖率 0.239、建议布点 12、守恒残差 2.52e-10、排序提升 27.8%
#   **全部未变**——它们不经过测度分位数这条路径。
# 顺带两处：`cli report`/`check` 此前只统计 15 条内核门槛，与 `run`
#   的 27 条口径不一致，现三条命令同一张表（check/report 只读，不改写产物）；
#   Windows GBK 控制台打印 ℃ − 等字符会中断 `cli` 与 `mcp_selftest`，
#   两个入口改为 UTF-8 输出、不可编码字符替换。
# 测试 118 → 121 条，新增三条锁上述失效方式。
SCHEMA_VERSION = "3.6.1"
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