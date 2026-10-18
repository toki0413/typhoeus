# 升级说明（v3.0.0 → v3.1.0）

升级时点 2026-10-15。内核 `0.1.0-demo` → `0.1.1-demo`，输出物 schema `3.0.0` → `3.1.0`。

本次升级落地 `ENGINEERING_MATURITY.md` 的 H2 / H4 / H6 / H1 与 `REN_BENCHMARK.md` 的 A1 / A2
及 `COMPETITIVE_ANALYSIS.md` 的 A3。**所有既有数值结论逐项未变**（守恒残差 3.52e-09、
峰值水深 0.752 m、Q_total 0.4373、割点 8.3 h、残差占比 6.38%、门槛 2 覆盖率 29.4%），
改动集中在正确性防线、可追溯性、门槛覆盖面与可验证性。

---

## 一、改动范围

### 1.1 新增文件

| 文件 | 职责 |
|---|---|
| `typhoeus/finiteness.py` | 非有限值防线：`NonFiniteError` / `count_nonfinite` / `assert_finite` / `finite_summary` |
| `typhoeus/tests.py` | 回归测试骨架，25 条用例（此前为零测试） |

### 1.2 修改文件

| 文件 | 改动 | 影响的既有接口 |
|---|---|---|
| `kernel.py` | 入口查雨量场；循环内 NaN 检查排在正性检查之前 | 无（新增防御性检查，正常输入输出不变） |
| `projection.py` | 承灾体系数外置；`capacity()` 除零退化保护；`ProjectionParams._validate()` | `aggregate()` 与 `check_monotone()` 签名不变，新增可选 `cfg` 参数 |
| `config.py` | L3 新增 `road_capacity` / `road_mix`；`load()` 未知字段告警 | `to_dict()` / `hash()` 输出结构变化（**hash 值改变**，见下） |
| `observe.py` | 新增 `depth_accuracy()` 与 `rain_check()`；导入 projection | 无 |
| `gates.py` | `_g()` 增加 `stage` / `cover` 参数；新增 `coverage_matrix()`；新增门槛 14/15 | `check_all()` 返回列表长度 13 → 15，每项多两个字段 |
| `compile.py` | 版本常量改从 `version.py` 导入；`Bundle.write()` 写盘前查兼容；体检指标包新增三段 | 输出物**只增字段**，未删改既有字段 |
| `cli.py` | 承灾体系数改从 L3 取；装配 `depth_accuracy` / `rain_check`；结论句条数动态化 | 无 |
| `version.py` | `SCHEMA_VERSION` 3.0.0 → 3.1.0，`KERNEL_VERSION` → 0.1.1-demo | `MIN_READABLE_SCHEMA` 保持 3.0.0 |

### 1.3 数据结构变化

**门槛结构**（`gates.py`，向后兼容）：

```python
# 改前
{"id": 1, "content": ..., "value": ..., "threshold": ..., "status": ..., "note": ...}
# 改后（新增两字段）
{"id": 1, ..., "note": ..., "stage": "rescue", "cover": "housing"}
```

**体检指标包**（`05_health_metrics.json`，新增 4 段）：

| 字段 | 内容 |
|---|---|
| `明细[].阶段` / `明细[].维度` | 每条门槛的两轴归属 |
| `覆盖矩阵` | 四阶段 × 五维度矩阵，含 `empty_cells` 空格清单 |
| `承灾体系数` / `承灾体系数区间` | a/b 系数与相对不确定区间 |
| `输入层校验` | 门槛 15 的完整数据，含采样偏倚说明 |

**新增两个观察层接口**：

```python
observe.depth_accuracy(res_depth, pts, grid, bbox=None) -> dict
# 返回 n / n_same_level / rate / mae_m / max_abs_diff_m /
#      by_type / by_type_detail / items / criterion

observe.rain_check(model_rain_mm, stations, bbox=None) -> dict
# 返回 model_mm / obs_mm / rel_err / rel_err_allcity /
#      obs_basis / n_stations / sampling_bias / allcity_mm
```

---

## 二、向后兼容性

| 维度 | 结论 |
|---|---|
| 函数签名 | 全部保持。`aggregate()` 的 `cfg` 参数为可选且有默认值 |
| 既有数值 | 逐项未变，测试与全链双重确认 |
| 输出物结构 | **只增字段**。3.1.0 产物可被 3.0.0 读取器忽略新增字段后正常解析 |
| `MIN_READABLE_SCHEMA` | 保持 3.0.0，不随本次升级提高——本次无破坏性变更 |
| `config_hash` | **由 `eda2fd58d2a8` 变为 `cb317a443cb4`** |
| `source_hash` | 不变（`40d07eb29407b4b6`） |

**`config_hash` 变化是预期行为，不是缺陷。** L3 新增了两个字段，四层参数的 JSON 内容变了，
hash 随之变化。这是 hash 机制按设计工作。若 hash 未变反而说明新增字段没进 `to_dict()`，
那才是 bug。此前的 hash 对承灾体系数不敏感——改那三个系数 hash 不变，这是本次修掉的问题。

**唯一需要下游注意的**：任何按 `config_hash == "eda2fd58d2a8"` 判定的旧脚本或旧文档需更新。

---

## 三、各改动的依据与实测

### 3.1 H2 NaN/Inf 防线

**修的问题**（本会话实测复现）：2×2 网格第 3 步注入一个 NaN 雨量，
`kernel.run` 返回 `positivity_ok=True`、`max_depth=nan`、`mass_resid=nan`、
`budget_mm` 全项 NaN——**守恒校验也一并失效**。

机制：NaN 与任何数比较恒为 False，`h.min() < -1e-12`、`h[h<0]`、
`np.where(h<min_depth_m,h,0)` 三处防线全漏。

**接入点三处**，按数据流向：

```python
# kernel.run 入口
assert_finite(rain_mm_h, "kernel.run 入口降雨场")

# kernel.run 循环内，正性检查之前（顺序是关键）
n_bad = count_nonfinite(h)
if n_bad:
    raise NonFiniteError(f"t={k*dt_h:.2f}h 水深场含 {n_bad} 个非有限值，...")
if h.min() < -1e-12:      # 这一行在 NaN 上恒为 False，必须排在后面
    positivity_ok = False

# projection.aggregate 入口
assert_finite(d, "projection.aggregate 入口水深时序")
```

**位置取舍**：防线放物理环节出口而非函数入口。入口检查会被 `_fill_depressions`
与产流项自身产生的中间态误杀；循环内检查带步号，能定位发散起点。

### 3.2 H4 版本单一来源

`SCHEMA_VERSION` 与 `KERNEL_VERSION` 此前在 `version.py` 与 `compile.py` 各定义一份，
改一处即漂移，且 `check_compat` 零调用。现改为：

```python
# compile.py
from .version import KERNEL_VERSION, SCHEMA_VERSION, check_compat

# Bundle.write 写盘前
for name, payload in self.outputs.items():
    verdict = check_compat(payload)
    if not verdict["readable"]:
        raise ValueError(f"{name} 版本不兼容：{verdict['reason']}")
    if not verdict.get("forward_compatible", True):
        print(f"[WARN] {name} {verdict['reason']}")
```

低版本阻断、高版本告警但不阻断——高版本产物是别人写的，结构仍可读。

### 3.3 H6 未知字段告警

`Config.load` 此前是静默 `if hasattr` 跳过。字段名拼错时用户看到"配置已加载"就以为新参数生效了，
实际它既没进对象也没进 hash。代价是两个不同意图的配置给出同一个 hash，"复算"失去意义。

现改为 `warnings.warn` 并列出该类当前的全部合法字段名。

### 3.4 A1 四阶段 × 五维度归档

两轴取自浙大 REN 的 ReCOVER 体系构造方式（`REN_BENCHMARK.md`），
**只作归档维度，不引入其 62 项指标**——那套以城市级统计与问卷为主，
本产品是街区级工程判据，塞进输出物会让报告变成填表。

矩阵的实际价值是暴露空格。实测 `empty_cells` 共 14 格，其中
**`rescue/economy`、`rescue/environment`、`rebuild/economy`、`rebuild/environment`
四格是任何阶段的任何门槛都没覆盖的**——即经济与环境两维全空。
`refuge`（避难期）与 `revival`（复兴期）两阶段除个别格外全部为空，
这两个阶段需要恢复时间维与规划评估模块才填得上。

### 3.5 A2 承灾体系数外置

`ROAD_CAPACITY` 三个系数此前写死在模块常量里，改动不进 `config_hash`，
而门槛 4/6/7 的判据全部建立在它们之上。现搬进 `L3_Strategy`，并加区间登记：

```python
ROAD_CAPACITY_TOL = {"支路": 0.20, "主干路": 0.20, "下穿立交": 0.30}
```

下穿立交区间最宽——该类型无桥下高程实测，a/b 只能按路宽与经验取值。

**顺带修掉一个静默缺陷**：`capacity()` 的分母 `b - 0.1` 在 `b ≤ 0.1` 时为 0，
除零使 `seg` 全为 inf，`np.clip` 把 inf 夹到 `a`，整条曲线塌成常数——
**D 仍然"单调"（常数列通过 `check_monotone`），但功能曲线完全失真**。
这是个不报错、只静默出错的坑。现加退化保护与 `ProjectionParams._validate()` 参数校验，
后者能报出单位错误（厘米当米用）。

### 3.6 A3 准确率门槛 14/15

**门槛 14 涝点水深命中率**（≥50%），分级口径用宁波官方四色分级，
分母是域内非合成点数。**为什么不并入门槛 2**：门槛 2 判空间排序能力，
门槛 14 判定量精度，两者可以一个 PASS 一个 FAIL，合并会掩盖"排序对而深度错"。

**门槛 15 降雨总量相对误差**（≤15%）。这是**输入层**校验——
此前全部门槛都在查末端或查内部一致性，没有任何一条查输入本身，
而所有输出物的准确性都继承输入的准确性。

两条实测结果：

```
门槛 14：命中率 5.9%（1/17），MAE 0.342 m，按类型 低洼小区 0/7、下穿立交 0/6、低洼路段 1/4
门槛 15：−25%（域内站口径 202 vs 269 mm）；对全市口径 −46%（202 vs 375 mm）
```

**门槛 15 暴露了一个采样偏倚**，必须写明：8 个实测站里只有 2 站在计算域内
（宁波站 121.56/29.87、海曙站 121.55/29.87），两者经度仅差 0.01°，
都不覆盖北部暴雨中心余姚（官方 475 mm）。用两个南部站均值 269 mm 作锚点会
**系统性低估观测侧**，使 −25% 看起来比实际乐观。两个口径都写进输出物。

两条门槛以 FAIL 交付是预期结果——它们的作用是标定失败幅度与根因，不是通过。

### 3.7 H1 回归测试

25 条用例，4.99 s，单测用 30×30 小网格不跑全链。每条锁一个具体失效方式：

| 分组 | 用例数 | 锁定对象 |
|---|---|---|
| NaN 防线 | 3 | 内核入口、投影入口、工具函数 |
| 内核三条硬约束 | 3 | 守恒、正性、供体出流预算 |
| 投影层 | 6 | 单调性、`acc/nt` 时间平均、割点语义、两个边界情形、除零退化 |
| 承灾体系数 | 4 | 外置生效、改系数改 hash、参数校验、容量单调 |
| 版本与配置 | 4 | 单一来源、高低版本兼容、未知字段告警、合法配置无告警 |
| 门槛两轴 | 2 | 每条门槛带轴、矩阵暴露空格 |
| 规划器与对账 | 2 | 贪心不等于按度、残差非零 |

写测试过程中发现 3 处**测试自身写错**而非代码有问题，已修正：
`decompose()` 的实际签名是 `(total, pred_climate, pred_excess, pred_engineering, cfg)`；
`RunResult` 的字段名是 `neg_loss_m3` 不是 `neg_loss_total_m3`；
a 与 b 分属**容量**与**水深**两个量纲，不存在 `a > b` 的约束。

---

## 四、验证方式与结果

### 4.1 测试

```
python -m pytest typhoeus/tests.py -q
→ 25 passed in 4.99s
```

### 4.2 全链运行

```
python -m typhoeus.cli run
```

与升级前逐项比对，全部一致：

| 指标 | 升级前 | 升级后 |
|---|---|---|
| 守恒残差 | 3.521e-09 | 3.521e-09 |
| 峰值水深 | 0.752 m @ 10.8 h | 0.752 m @ 10.8 h |
| 面雨量 | 202.5 mm | 202.5 mm |
| 割点时刻 | 8.3 h | 8.3 h |
| 峰值损失 | 3.56% | 3.56% |
| Q_total / 残差占比 | 0.4373 / 6.38% | 0.4373 / 6.38% |
| 涝点覆盖 | 5/17 = 29.4% | 5/17 = 29.4% |
| 恢复排序提升 | 7.5% | 7.5% |
| 门槛统计 | 4 / 3 / 6（13 条） | 4 / 5 / 6（15 条） |

门槛统计的变化全部来自新增的 14/15 两条 FAIL，原有 13 条状态未变。

### 4.3 输出确定性

连续两次运行逐字节比对，唯一差异是门槛 12 的耗时字段
（`"51.4 s"` vs `"46.2 s"`），属机器抖动而非确定性泄漏。

### 4.4 溯源

```
schema_version 3.1.0    kernel_version 0.1.1-demo
config_hash  cb317a443cb4   （因 L3 新增两字段，按设计改变）
source_hash  40d07eb29407b4b6  （不变）
```

---

## 五、仍存在的限制

**输入层偏差 −46% 未解决**，这是当前最大限制。降雨仍为台风路径参数化合成，
`R_MAX` / `R_FLOOR` / `RAD_EXP` / `T_HALF` 四个标定量决定面雨量。
改实测驱动需接 CMFD 2.0（0.1°/3h，1951–2024，开放获取），本次未做。

**门槛 14 命中率 5.9% 极低**，主因是降雨偏差，次因是 GLO-30 为 DSM
（30 m 像元无法表达下穿凹陷，6 个下立交点全部未命中）。
注意 7 个低洼小区点同样全部未命中——它们靠地形高程即可表达、不该因 DSM 失效，
这 7 点是检验降雨降尺度是否真有效的对照。

**6 条 BLOCKED 门槛的成因未变**：149 个内涝监测点非公开、Sentinel-1 未接、
逐时降雨与逐路段封路记录缺失、多事件序列不足。

**`planner.restore_order` 仍超线性**：60×60 网格 32 ms → 240×240 14055 ms。
本次未处理。

**工程基建仍是 Demo 水平**：非 git 仓库、无 CI、无 `pyproject.toml`、
`requirements.txt` 未锁定版本。测试放在 `typhoeus/tests.py` 而非独立 `tests/` 目录，
暂不满足 pytest 的默认发现约定（用显式路径调用）。

---

## 六、后续可优化项

按优先级：

**P0 · 输入层（解锁门槛 14/15 的唯一路径）**
接 CMFD 2.0 实测降雨，替换四个标定量。这一项完成后门槛 15 的 −46% 可望收敛到 15% 以内，
门槛 14 的命中率会同步改善——两者是同一条链，不是两件事。

**P0 · 工程基建**
`git init` + `.gitignore` + `requirements.txt` 钉版本 + 把 `tests.py` 移入 `tests/`
+ `.github/workflows/ci.yml`。CI 每次提交跑这 25 条用例（5 s，不构成负担）。

**P1 · 对象锚定**
把预置方案单的像元索引换成设施 ID + 到达时限 + 责任人。
需要设施台账，可先用手工 10 行小表验证关联逻辑。

**P1 · 恢复时间维**
`planner` 加恢复速率与资源档位，输出 R(t) 曲线。这一项能填上矩阵里
`refuge` 与 `revival` 两个阶段的空白。

**P2 · `planner` 去超线性 + AI 代理模型**
解决 500×700 网格的可行性。需先抽取台风子集降 `load_track` 的 13.9 s 占用。

**P2 · 子命令语义分离**
`run` / `check` / `report` 仍共用同一条全链路径，`check` 不比 `run` 少做任何事。
本次改动的错误分类（`NonFiniteError` 带 `code`）已为后续接全局错误处理铺好路。