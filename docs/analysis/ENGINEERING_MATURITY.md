# 工程成熟度评估与改进方案

评估时点 2026-10-15。评估对象 `demo/typhoeus`（12 模块 3173 行）、`demo/tools`（1 文件 526 行）。
基线运行：config_hash `eda2fd58d2a8`，source_hash `40d07eb29407b4b6`，全链 38.9 s，
13 条门槛 4 PASS / 3 FAIL / 6 BLOCKED。

本文的每条现状问题都对应可复现的实测命令，结论不靠推测。

---

## 一、九维成熟度评分

评分口径：5 = 商业级可直接交付；4 = 可交付但有明确改进项；3 = 可演示不可交付；2 = 仅内部可用；1 = 缺失或存在正确性风险。

| 维度 | 评分 | 现状问题 |
|---|---|---|
| 功能完整性 | **2.5** | 三个子命令（`run`/`check`/`report`）共用同一条全链路径，`check` 不比 `run` 少做任何事、`report` 也不落盘。命令语义与实现不符。交互层完全缺失（无界面、无实时接入、无角色权限），六份输出物全是机器 JSON，非技术读者不可用 |
| 架构设计 | **3.5** | 分层清晰（data/kernel/measure/projection/planner/reconcile/observe/compile/gates），六份输出物从一次 `run()` 编译而来，无重复计算链。但 `version.py` 定义了 `check_compat`/`bump_minor` 却**零调用**；`SCHEMA_VERSION` 与 `KERNEL_VERSION` 在 `version.py` 与 `compile.py` **重复定义**且数值相同，改一处即漂移。`version.py` 49 行是死代码 |
| 性能与可扩展性 | **2** | 实测性能分布（38.9 s 总量）：`load_track` **13 895 ms（38%）**、`kernel.run` 15 920 ms（41%）、`rainfall_field` 3 963 ms、`planner.compare_orders` 2 681 ms、`projection` 795 ms、`load_dem` 2 565 ms。`load_track` 为取 118 行而全表扫 25 万行 CSV，且三级回落会重复扫两个文件。`planner.restore_order` 超线性：60×60 网格 32 ms → 120×120 293 ms → 240×240 **14 055 ms**（节点数 ×48，耗时 ×440），当前 144×270 侥幸能过，扩到全市域（≈500×700）不可用 |
| 安全性 | **4** | 无 `requests`/`urllib`/`socket`/`subprocess`/`eval`/`exec`/`pickle`。文件写入仅 3 处，路径全部由参数推导，可预测。数据许可约束写在文档与台账 `provenance` 字段里。扣分项：无输入 schema 校验、路径未做规范化（Windows 下 `--outdir C:\foo` 与 `C:/foo` 会落不同目录）、无敏感数据分级 |
| 稳定性与容错 | **2** | **NaN 可绕过全部三道内核防线**。实测：对 2×2 网格在第 3 步注入一个 NaN 雨量，`kernel.run` 返回 `positivity_ok=True`、`max_depth=nan`、`mass_resid=nan`、`budget_mm` 全项 NaN——**守恒校验也一并失效**。机制是 Python/NumPy 里 `NaN` 与任何数比较恒为 False（`nan < -1e-12` → False、`nan > 0.0` → False），因此 `h.min() < -1e-12`、`h[h<0]`、`np.where(h<min_depth_m,h,0)` 三处全部漏过。`projection.aggregate` 对含 NaN 输入返回 `Q.min()=nan`，直达输出物。`data.load_dem` 出口有 NaN 防线（`np.isfinite` 检查 + `nanmedian` 填充），但数据源一旦换成实测降雨或多瓦片拼接，下游无任何防线。全仓仅 4 处 `except`，全是窄类型解析容错，无全局错误处理与降级路径 |
| 测试覆盖与质量保障 | **1** | **零测试**：无 `tests/` 目录、无 `test_*.py`、无 `pytest.ini`/`tox.ini`/`conftest.py`。全部 3173 行代码无一行被自动化验证。这个分数不是"覆盖率低"，是"覆盖率不存在"。已知的 8 个内核 bug（numpy 视图别名、量纲错配、限幅按边、`acc/nt` 时间平均、`1/√affected` 二次稀释、`break` 提前终止、NaN 绕过、正数判据恒真）全部靠人工 debug 发现，没有一条能被回归测试拦住 |
| 可观测性与日志 | **2** | 全用 `print()` 输出，无 `logging` 模块、无日志级别、无结构化日志、无 trace_id。单次运行的阶段耗时靠 `time.perf_counter()` 插桩打印，不是可查询的指标。门槛 13 的残差门控机制在架构上是可观测性的正确方向（残差超阈值降级），但其输入 `obs = Q*(1-0.06*t)` 是模拟序列，不是真观测，门控在数据上是空的 |
| 部署运维 | **1** | 非 git 仓库（`fatal: not a git repository`）。无 `pyproject.toml`/`setup.py`/`requirements.txt`/`Dockerfile`/`docker-compose.yml`/`.github`/`.pre-commit-config.yaml`。依赖版本当前是 numpy 2.4.4 / scipy 1.17.1 / rasterio 1.5.2，**未锁定**。数据文件（283 MB）直接躺在 `data/` 里，无获取脚本、无校验和。无法部署、无法复现环境、无法交接 |
| 文档与开发者体验 | **3** | 模块 docstring 质量高，每处非显然的物理/数值决策都写了"为什么"（如"numpy 视图别名，第二次赋值会覆盖第一次"、"正性必须在干湿截断之前判"）。`COVERAGE.md` 与 `PRODUCT_MATURITY.md` 完整。扣分项：无 README（新人不知道从哪读起）、无 API 文档、`Config.load` 静默忽略未知字段（用户会误以为新参数生效）、无 changelog |

**综合：2.2 / 5。** 定位是"**可演示的验收工具**"，内核物理实现的质量明显高于工程基建的质量。核心算法守恒残差 3.52e-09、正性通过、D 单调性通过，这些是真做对了的；但零测试、零部署配置、零 CI 使它无法承受一次真实交付。

**该保的与该补的**：内核三条硬约束（逐边累加、量纲对齐、供体出流预算）与三条口径纪律（守恒核算、provenance 必检、坐标精度必声明）是资产，必须原样保留。工程基建（测试、依赖锁定、版本管理、错误处理）是从零开始。

---

## 二、改进项（按优先级）

优先级判据：**是否阻塞真实交付 > 是否影响正确性 > 投入产出比**。

### 高优先级

| # | 改进项 | 预期收益 | 改动范围 | 依赖 |
|---|---|---|---|---|
| H1 | 建回归测试骨架，守住 8 个已知 bug | 每个内核修改都有回归网；后续改物理不用重新 debug | 新建 `tests/`（8–12 个用例）、`pytest.ini`、`conftest.py` | 无 |
| H2 | 内核与投影层加 NaN/Inf 防线 | 消除"脏数据静默产出看似正常的数字"这一最严重的正确性风险 | `kernel.py`（run 前 + 循环内）、`projection.py`（aggregate 入口）、新增 `_assert_finite` 工具 | 无 |
| H3 | `load_track` 加缓存与索引 | 全链 38.9 s → 约 25 s（-36%）；三级回落的重复扫消除 | `data.py`（路径级缓存或预抽 `ibtracs_tracks.csv` 索引子集） | 无 |
| H4 | 版本常量单一来源 + 启用 `check_compat` | 消除版本漂移；输出物能被旧版内核安全读取 | `version.py` 改为唯一来源，`compile.py` 改为 import；`Bundle.write` 前调 `check_compat` | 无 |
| H5 | 建 git 仓库 + 依赖锁定 + README | 从"不可交接"到"可交接、可复现" | `git init`、`.gitignore`（排除 283 MB 数据）、`requirements.txt`（钉版本）、`README.md` | 无 |
| H6 | `Config.load` 未知字段改为显式报错或警告 | 消除"以为参数生效了"的静默失败 | `config.py` | 无 |
| H7 | 全局错误处理与阶段化降级 | 单点失败不再整链崩；错误信息带上下文 | 新建 `errors.py`、`cli.py` 的 `main()` 包 try/except | H2 |

### 中优先级

| # | 改进项 | 预期收益 | 改动范围 | 依赖 |
|---|---|---|---|---|
| M1 | `planner.restore_order` 去超线性 | 扩到全市域（≈500×700）仍可用；当前规模提速约 10 倍 | `planner.py`（分层增益 + 优先队列，或按损失阈值分块贪心） | 无 |
| M2 | 子命令语义分离 | `check` 不重跑内核、`report` 落盘 | `cli.py`（拆 `run_chain` 为可复用阶段 + 结果缓存） | 无 |
| M3 | 结构化日志替代 print | 运行记录可检索、可聚合、可回放 | 新建 `logging` 配置，替换 `log = lambda` | 无 |
| M4 | 输出物双层（机器 JSON + 人读渲染） | 六份 JSON 对非技术读者可用 | `compile.py`（加渲染层），不改内核 | 无 |
| M5 | `kernel.run` 分块以控内存 | `depth` 数组 433×144×270×4B = 67 MiB，扩域后会翻倍 | `kernel.py`（memmap 或分块回传） | M1 |
| M6 | CI 流水线 | 每次提交自动跑测试与门槛 | `.github/workflows/` | H1、H5 |
| M7 | 数据获取脚本与校验和 | 283 MB 数据可一键重建 | 新建 `tools/fetch_data.py`、`.sha256` | H5 |

### 低优先级

| # | 改进项 | 预期收益 | 改动范围 | 依赖 |
|---|---|---|---|---|
| L1 | API 文档（docstring 转文档站） | 开发者上手成本下降 | Sphinx/MkDocs 配置 | H1 |
| L2 | changelog 与发布流程 | 版本可追溯 | `CHANGELOG.md` + 语义化版本落地 | H4、H5 |
| L3 | 性能基准集 | 改动引起的性能回归可发现 | `benchmarks/` + 门槛 12 时效的基线快照 | M1 |
| L4 | 输入 schema 校验（如 pydantic） | 配置错误在入口即报 | `config.py` | H6 |

**不做的事**：不为补齐打分而给内核加"看起来更现代"的抽象层。当前模块划分已经能支撑商业级演进，缺的是测试和基建，不是重构。

---

## 三、高优先级项的实施细节

### H1 回归测试骨架

**范围**：新建 `tests/`，8–12 个用例，不追求覆盖率数字。

必须覆盖的用例（每个对应一个已修 bug，防止回归）：

| 用例 | 断言 | 对应的历史 bug |
|---|---|---|
| `test_mass_conservation` | 降雨 = 下渗 + 排水 + 边界出流 + 三项数值损耗 + 域内存量，残差 ≤ 1e-6 | 视图别名、量纲错配 |
| `test_positivity_before_clip` | 正性检查在干湿截断之前；注入负 h 时 `positivity_ok=False` | 检查放在截断之后形同虚设 |
| `test_flux_budget_by_donor` | 单步出流 ≤ 0.95·h，无负水深 | 逐边限幅导致 4h 出流 |
| `test_no_dry_on_edge` | 边缘不出现人工深槽 | 角点被行列两次下调叠加成 2 m |
| `test_track_hour_offsets` | 118 点实测路径的 offsets 范围 -213 至 138 h | 原点取首点导致降雨场全零 |
| `test_rainfall_total_range` | 面雨量落在 150–350 mm | 标定量随数据源漂移 |
| `test_q_not_double_counted` | `aggregate` 不做 `acc/nt` 时间平均；`event_total > 0` | 三项分解退化成 0 |
| `test_gate13_not_vacuous` | 门控在给定漂移序列上 `reduction > 0` | 绝对阈值使门控永不触发 |
| `test_greedy_beats_degree` | 贪心与按度排序结果**不同** | 两者按构造相同，提升恒 0 |
| `test_recon_residual_nonzero` | 三项独立预测时残差 ≠ 0 | 固定比例拆分使残差恒 0 |
| `test_provenance_filter` | 合成来源的点不进入门槛判定 | 合成数据冒充实测 |
| `test_bbox_filter` | 域外点不计入覆盖率 | 覆盖率虚高 |
| `test_output_deterministic` | 两次运行输出逐字节相同 | 非确定字段泄漏 |

**验收标准**：13 条用例全绿；`pytest --tb=short -q` 单次 < 30 s（用小网格 fixture，不跑全链）；CI（`workflows/ci.yml`）在每次 push 上自动执行。

**风险点**：全链测试 39 s 会拖慢 CI。做法是 `conftest.py` 里提供 30×30 小网格 fixture，单测用小网格，只有 `test_output_deterministic` 跑一次全链并标记 `@pytest.mark.slow`。

### H2 NaN/Inf 防线

**范围**：新增 `typhoeus/finiteness.py`，提供 `assert_finite(arr, where)` 与 `count_nonfinite`；在三个入口接入。

接入点与判据：

```python
# data.py load_dem 出口（已有 isfinite 检查，补 Inf 与"填完仍有 NaN"的确认）
# kernel.run 循环内，每步 rain_inc 与 h 各查一次
n_bad = count_nonfinite(h)
if n_bad:
    raise NonFiniteError(f"t={k*dt_h:.2f}h 有 {n_bad} 个非有限值水深，"
                         f"输入或数值发散，拒绝继续推进")
# projection.aggregate 入口
assert_finite(d, "水深时序")
```

**验收标准**：注入 NaN 的用例（`test_nan_rejected`）在内核层抛 `NonFiniteError` 而非静默通过；`projection.aggregate` 对含 NaN 的输入抛错；正常路径的守恒残差与阈值不变（3.52e-09 不劣化）。

**风险点**：`_fill_depressions` 与 `median_filter` 可能引入 NaN，防线加得太早会误杀。做法是防线放在**每个物理环节的出口**而非函数入口，且 `data.py` 的出口检查在填充之后（填充若无效果说明瓦片全空，此时 `np.isfinite(arr).any()` 已先行报错）。

### H3 `load_track` 缓存

**范围**：`data.py`。两个方案，建议 A。

方案 A（推荐）：抽取一次子集。`tools/prepare_track.py` 从 `ibtracs_wp.csv` 抽出 2021 IN-FA（以及后续要用的年份），落 `data/ibtracs_tracks.csv`（约 130 行）。`load_track` 优先读该文件。

方案 B：模块级 `@lru_cache`，进程内复用。三级回落会跨进程重复扫描，收益仅限单进程多次调用。

**验收标准**：`load_track` < 100 ms（当前 13 895 ms）；全链 < 26 s；`source_hash` 保持 `40d07eb29407b4b6` 不变。

**风险点**：低。已实测确认 `source_hash` 的两个组成是"DEM 文件首 1 MiB 摘要 + 路径点序列"，与台风文件本身无关，因此抽取子集不改变 hash，新旧输出物仍可比。这与之前判断的"会变"不同——`_sha256` 作用在 DEM 上而非台风文件上。唯一需注意的是子集文件若被手工编辑，`source_hash` 会变而数据内容变化却可能被忽略，因此在 `tools/prepare_track.py` 里加一步"抽取结果与原文件逐行 diff 并打印行数"的自检。

### H4 版本单一来源

**范围**：`version.py` 保留唯一定义；`compile.py` 删掉本地两行，改 `from .version import SCHEMA_VERSION, KERNEL_VERSION`；`Bundle.write` 写盘前对每个 payload 调 `check_compat`。

```python
# compile.py Bundle.write 内
for name, payload in self.outputs.items():
    verdict = V.check_compat(payload)
    if not verdict["readable"]:
        raise SchemaError(f"{name} 版本不兼容：{verdict['reason']}")
    if not verdict.get("forward_compatible", True):
        warnings.warn(f"{name} 来自更高版本内核：{verdict['reason']}")
```

**验收标准**：`grep -rn "SCHEMA_VERSION = " typhoeus/` 只命中 `version.py` 一处；构造一个 `schema_version="1.0.0"` 的 payload 喂给 `Bundle.write` 抛错；正常写出 6 份 + manifest 不变。

**风险点**：低。唯一注意是 `compile.py` 顶部 `SCHEMA_VERSION = "3.0.0"` 删除后，所有引用需走 import，改漏会 `NameError`，CI 立刻发现。

### H5 工程基建

**范围**：

1. `git init` + `.gitignore`：`data/*.tif`、`data/*.csv`（283 MB 不入库）、`out/`、`__pycache__/`、`*.pyc`、`.workbuddy/`
2. `data/README.md`：三个数据文件各自的来源 URL、许可（IBTrACS 无署名限制 / Copernicus 免费开放但需标注）、体积、`sha256`
3. `requirements.txt`（钉版本）：`numpy==2.4.4`、`scipy==1.17.1`、`rasterio==1.5.2`，加 `pytest==8.x`
4. `README.md`：一句话定位、单命令跑通、模块地图（哪层管什么）、门槛三态含义、已知局限（降雨合成、监测点非公开）
5. `tools/fetch_data.py`：按 `data/README.md` 的 URL 下载 + 校验 sha256 + 断点续传

**验收标准**：新机器按 README 能在 10 分钟内跑出与本仓 `out/` 逐字节相同的输出物；`pip install -r requirements.txt` 后版本与 `pip freeze` 一致。

**风险点**：283 MB 数据不入库意味着仓库不自包含。取舍是明确的——GitHub 单文件 100 MB 硬限，且数据可按 URL 重建。若要求仓库自包含，改用 Git LFS，成本上升。**建议先不入库，用 fetch 脚本 + 校验和**，并把数据快照放独立的发布页。

### H6 `Config.load` 未知字段

```python
# config.py load() 内，替换现有静默 setattr 分支
unknown = [k for k in v if not hasattr(obj, k)]
if unknown:
    warnings.warn(f"{key} 含未知字段 {unknown}，已忽略。"
                  f"若期望其生效，请检查字段名拼写与内核版本")
```

**验收标准**：给 config JSON 塞一个未知字段，运行时出现 warning；合法 config 加载无 warning；`Config.load(cfg).hash() == cfg.hash()` 仍成立。

**风险点**：无。只是把静默失败变成显式提示。

### H7 全局错误处理

**范围**：新建 `errors.py` 定义 `TyphoeusError`（基类）、`NonFiniteError`、`SchemaError`、`DataAccessError`、`ConservationError`；`cli.py` 的 `main()` 包一层：

```python
def main(argv=None) -> int:
    try:
        ctx = run_chain(cfg)
    except TyphoeusError as e:
        print(f"[{e.code}] {e}", file=sys.stderr)
        print("已中止，未写出任何输出物", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("已中断", file=sys.stderr)
        return 130
```

错误码让调用方能程序化处理；`return 2` 与 `130` 让 shell 能区分。

**验收标准**：注入 NaN 的 DEM，`python -m typhoeus.cli run` 返回码 2 且 stderr 有 `[NONFINITE]` 前缀，`out/` 目录不被创建或保持原样；正常路径返回码 0。

**风险点**：`run_chain` 中途失败时 `Bundle.write` 尚未执行，因此不会有半套输出物——这一点当前已经成立（写盘在最后），改造时不要破坏这个顺序。

---

## 四、改进后的目标状态

按上表做完高优先级七项，成熟度从 2.2 提升到约 **3.4**：功能完整性仍受交互层缺失限制（2.5 → 3.0，子命令语义修正），架构设计 3.5 → 4.0（版本单一来源），性能 2 → 3.0（-36% 耗时 + 扩展性隐患标注），安全性 4 → 4.5，稳定性 2 → 3.5（NaN 防线 + 全局错误处理），测试 1 → 3.0（骨架 + CI），可观测性 2 → 2.5（结构化日志），部署运维 1 → 3.5（git + 依赖锁定 + fetch 脚本），文档 3 → 3.5（README）。

**这个分数仍不够交付，但已经可以拿去做试点**：一个能跑测试、能重建环境、能定位错误、能追溯版本的 Demo，在区水务局面前的说服力和现在完全不同。

中优先级做完（M1 规划器去超线性 + M4 双层输出 + M6 CI）到 **3.9**，具备单区试点条件。低优先级属于交付后的持续投入。

**与 `PRODUCT_MATURITY.md` 的分工**：那份是产品形态（面向业务方），本文是工程成熟度（面向交付方）。两者的关键结论一致——当前是验收工具不是作业工具，缺的不是算法是基建。
