# 提比翁 Typhoeus

城市内涝情景推演与验收工具。把一次台风过程解成四个可核对的动作：**预置方案 → 抢修排序 → 事件对账 → 韧性定价**，每个数字都带口径、可复算、可追责。

内核 v0.6.0-demo / 输出物格式 v3.6.1 / `config_hash` `92cd76c2ea3f`

---

## 项目用途

提比翁不是预报工具，是**验收工具**。它回答的是「这个片区在 2021 年烟花那场台风里，功能损失是多少、抢修顺序该按谁排、这笔钱换回来多少」，而不是「明天会不会下雨」。

三条硬约束由算子结构保证，不是拟合出来的：

| 约束 | 当前实测 | 判据 |
|---|---|---|
| 守恒性 | 残差 2.52e-10 | ≤ `tol_mass` = 1e-6 |
| 正性 | 通过 | `min(h) ≥ 0` |
| 功能曲线单调 | 通过 | D 随水深单调不增 |

任一不满足则 raise，内核拒绝输出。27 条门槛各自独立判据，判据定在结构条件上而非拟合优度阈值 —— 门槛 26 明确写着「R² 在样本量十几个时抽样波动 ±0.2，不作验收判据」。

当前状态：**15 条通过 / 5 条不达标 / 7 条因缺外部数据未验证**。7 条 BLOCKED 全部指向数据缺口而非模型缺陷。

---

## 技术栈

| 组件 | 版本 | 用途 |
|---|---|---|
| Python | ≥ 3.11（开发于 3.13.14） | — |
| numpy | 2.4.4 | 图守恒律求解器全部数值计算 |
| scipy | 1.17.1 | GPD 极值分布拟合（`stats.genextreme`） |
| rasterio | 1.5.2 | GLO-30 DEM 读取与重采样 |
| pytest | 9.1.1 | 121 条回归测试 |
| mcp | 可选 | MCP 只读服务（7 个工具） |

**无 pandas 依赖**（本机装有但代码未引用）。**零环境变量、零 API key** —— 唯一的外部网络调用是 Open-Meteo archive-api 免 key 接口，且带本地缓存。

纯 CPU，无GPU 依赖。单次全链约 50 s。

---

## 目录结构

```
demo/
├── typhoeus/                # 主包，9354 行
│   ├── kernel.py     (707)  # 图守恒律求解器 + Green-Ampt 入渗 + Ghil-Sellers 能量平衡
│   ├── multievent.py (815)  # 18 场历史气旋批量标定
│   ├── cli.py        (576)  # 命令行入口 + KernelParams 单一构造源
│   ├── rainsrc.py    (507)  # 降雨源（ERA5 / 参数化合成场）
│   ├── observe.py    (448)  # 涝点台账、监测点、覆盖率与深度精度
│   ├── render.py     (436)  # 报告编译
│   ├── gates.py      (378)  # 27 条门槛实现
│   ├── compile.py    (377)  # 七份输出物编译
│   ├── agent_gates.py(357)  # G16–G24 Agent 侧门槛
│   ├── planner.py    (298)  # 次模贪心恢复排序
│   ├── mcp_server.py (297)  # MCP 只读服务
│   ├── data.py       (297)  # DEM 与台风路径加载
│   ├── guardrails.py (288)  # R1–R4 硬拒绝规则
│   ├── serving.py    (262)  # 缓存与调用预算
│   ├── projection.py (254)  # 承灾体水深→功能损失
│   ├── config.py     (199)  # 四层参数 + config_hash
│   ├── calib_gates.py(192)  # G25–G27 多事件门槛
│   ├── calib_sheet.py(189)  # 第七份产物「多事件标定单」
│   ├── reconcile.py  (173)  # Q 分解（主链与批量共用一份公式）
│   ├── measure.py    (167)  # 面雨量与联合分位数集合估计
│   ├── consistency.py(158)  # G21 跨产物一致性
│   ├── version.py    ( 88)  # 版本单一来源
│   ├── finiteness.py ( 61)  # 非有限值防线
│   └── tests.py      (1887) # 121 条测试
├── tools/                   # 诊断与自测脚本
│   ├── infil_diag.py        # 入渗机制 A/B 诊断
│   ├── gpd_sample_size.py   # GPD 样本量需求合成实验
│   ├── mcp_selftest.py      # MCP 自测与故障注入
│   └── make_seed_data.py    # 占位数据生成
├── data/                    # 320 MB
│   ├── dem_n29e121.tif      # GLO-30 DSM（43 MB）
│   ├── ibtracs_wp.csv       # IBTrACS 西北太平洋分片（110 MB）
│   ├── ibtracs.csv          # 简版（119 MB）
│   └── seed/                # 涝点台账、雨量站、停运通报等
├── out/                     # 七份输出物 + config.json + manifest.json
├── *.md                     # 13 份分析与评估文档
└── README.md
```

---

## 安装

```bash
cd demo

# 建议用虚拟环境
python -m venv .venv
# Windows:   .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate

pip install "numpy>=2.0" "scipy>=1.11" "rasterio>=1.3" "pytest>=8.0"

# 可选：MCP 服务
pip install mcp
```

rasterio 的 GDAL 依赖在 Windows 上若安装失败，改用：

```bash
pip install rasterio --only-binary=:all:
```

---

## 运行

```bash
python -m typhoeus.cli run          # 跑全链，导出七份输出物（约 50 s）
python -m typhoeus.cli check        # 只跑门槛
python -m typhoeus.cli report       # 打印体检摘要
python -m typhoeus.cli multievent   # 18 场历史气旋批量标定（约 280 s）
```

### 参数

```bash
python -m typhoeus.cli run --outdir ./myout --config ./myconfig.json
python -m typhoeus.cli multievent --catalog "2021:IN-FA,2014:FUNG-WONG"
```

### 测试

```bash
python -m pytest typhoeus/tests.py -q          # 121 条，约 4 s
python tools/mcp_selftest.py                   # MCP 通过率 + 故障注入 10 项
python tools/infil_diag.py                     # 入渗机制 A/B 诊断
python tools/gpd_sample_size.py                # GPD 样本量合成实验
```

---

## 环境变量配置

**本项目不需要任何环境变量。**

没有 API key、没有数据库密码、没有第三方服务凭证。降雨数据走 Open-Meteo archive-api 的免 key 接口：

```
https://archive-api.open-meteo.com/v1/archive
```

首次运行会拉取并缓存到 `data/seed/rain_reanalysis_era5.npz`（48 MB），之后 `rain_use_cache=True` 直接命中缓存。缓存缺失或接口不可用时降级到台风路径参数化合成场，并在产物中显式标注驱动来源 —— 该口径只可用于场次间相对比较，**不可用于任何绝对量级结论**。

配置通过 `out/config.json` 管理，四层结构：

| 层 | 关键项 |
|---|---|
| `L1_physical` | 物理常数（g、Manning 糙率、CC 标度） |
| `L2_site` | 场地与输入（`bbox`、`dem_file`、降雨源、**入渗机制参数**） |
| `L3_strategy` | 决策偏好（气候/超标/工程三分占比、承灾体系数） |
| `L4_solver` | 数值参数（时间步长、时长、干湿阈值） |

改动 `config.json` 后 `config_hash` 变，产物全部标脏。**同一 hash 才能复算**，这是审计要求。

配置文件含未知字段时会显式 warning 而非静默跳过 —— 字段名拼错时用户能看到提示，而不是以为新参数已生效。

---

## 常用命令速查

```bash
# 改入渗机制做 A/B 对比（Green-Ampt ← → legacy）
python -c "
import sys; sys.path.insert(0,'.')
from typhoeus import config as CFG, kernel as K, cli as CLI, rainsrc as RS, observe as OB, data as D
cfg = CFG.Config(); inp = D.load_all(cfg.l2.bbox, cfg.l4.resample)
rain,_ = RS.get_rainfall(inp.grid, stations=OB.load_rain_stations(), use_cache=True, calibrate=True, verbose=False)
for m in ('legacy','green_ampt'):
    kc = CLI._kernel_params(cfg); kc.infiltration_mode = m
    r = K.run(inp.grid, rain, kc); b = r.budget_mm()
    print(f'{m:11s} peak={r.max_depth:.4f}m infil={b[\"下渗\"]:.2f}mm')
"
# 实测输出：
#   legacy      peak=0.4629m infil=75.76mm
#   green_ampt  peak=0.4928m infil=4.83mm

# 看 27 条门槛的完整判定理由
python -m typhoeus.cli check

# 核对跨产物一致性（G21）
python -c "
import sys; sys.path.insert(0,'.')
from typhoeus import consistency as CO
import json; print(json.dumps(CO.check(), ensure_ascii=False, indent=1))
"

# 升级内核后必须重跑全链，否则 manifest 里的版本号对不上
python -m typhoeus.cli run
```

---

## 输出物

### 计算件（内部）

| 文件 | 内容 |
|---|---|
| `01_preset_plan.json` | 预置方案单 |
| `02_recovery_order.json` | 恢复排序单 |
| `03_event_reconciliation.json` | 事件对账单（Q 分解 + 涝点逐点对照） |
| `04_resilience_pricing.json` | 韧性价目表 |
| `05_health_metrics.json` | 体检指标包 |
| `06_health_report.json` | 标准体检报告（含入渗与能量段） |
| `07_multievent_calibration.json` | 多事件标定单 |
| `08_flood_cards.json` / `citizen.html` | 涝点转译卡 28 张 + 公众页 |
| `dashboard.html` | 内部看板 |
| `config.json` / `manifest.json` | 配置与来源指纹 |

### 产品件（岗位可用，随 `run` 自动生成）

| 文件 | 给谁 | 内容 |
|---|---|---|
| `p1_情景阈值表_值班室.html` | 防汛值班室 | 四档情景的**值守等级 / 巡查频次 / 人员装备** + 优先点位排班清单 + **逐时雨情与越阈时刻** |
| `p2_情景损失单_规划岗.html` | 规划岗 | 损失四项分解 + 四色面积 + 恢复次序 + **极端值口径情景矩阵** + **多源面雨量交叉验证** |
| `p3_方案比选件_规划岗.html` | 规划岗 | 三档投入—收益对照 + 推荐次序 + 可立即执行动作 + 与基线比较基准 |
| `p4_偏差诊断与残差校正.html` | 技术审查方 | 17 点系统偏差诊断 + **两道可检验判据**（模型是否有信息 / 校正是否有效） |
| `p5_偏差校正表.json` | 系统集成方 | 偏差诊断的机器可读版 |
| `p6_情景矩阵.json` | 系统集成方 | 四档情景的空间峰值、分位数、四色面积、超阈格点数 |
| `p7_逐时雨情.json` | 系统集成方 | 逐时面雨强剖面、累计曲线、四档越阈时刻 |
| `p8_遥感淹没范围验证.html` | 技术审查方 | 留出集 IoU 与 Otsu 基线对比（7 次运行全部优于基线）+ 本机推理复现 + 宁波推理的 BLOCKED 声明 |
| `p9_遥感验证指标.json` | 系统集成方 | 遥感验证的机器可读版（逐次运行指标、判据三态、权重指纹） |
| `p0_情景—规划机_产品件.json` | 系统集成方 | 产品件底座：情景、场景、执行入口、技术参数与边界 |

**一次运行共 23 个文件，同批落盘、同一 `config_hash`。**

### 情景档匹配（交互查询）

```bash
python -m typhoeus.cli scenario 338.8            # 给定面雨量 → 响应等级与动作
python -m typhoeus.cli scenario --percentile 0.95
python -m typhoeus.cli scenario --json           # 用当前事件面雨量，输出 JSON
```

### 分阶段耗时（`run` 结束自动打印）

| 段 | 默认 | `--skip-matrix` |
|---|---|---|
| 数据接入（DEM + 台风路径 + 降雨取数/缓存） | ~6.1 s | ~6.1 s |
| 内核求解（μ_t 测度 + 图守恒律） | ~6.2 s | ~6.1 s |
| 情景矩阵（p80/p90/p95 三档内核；p50 复用主链水深） | ~20.5 s | ~0.4 s |
| 门槛体检（27 条） | <0.1 s | <0.1 s |
| 测度与规划等 | ~1.9 s | ~1.9 s |
| 产品与诊断层（p0–p9 共 12 个文件） | ~3.9 s | ~3.9 s |
| **全链合计** | **~35 s** | **~15 s** |

`--skip-matrix` 省 3 次内核求解，代价是 `p6` 与 `p2` 的极端值节不完整——只用于快速回归，交付前须跑默认模式。内核单次求解约 6.2 s 全部花在逐时循环内（profile 无旁支开销），提速须改数值路径，会动复算指纹，故不做。

---

## 已知限制

以下不是待修的 bug，是当前口径的边界：

- 🆕 **面积型验证 FAIL（IoU 0.0847）**。用 AWS 公共桶取到的 Sentinel-1B（2021-07-25 IW GRD）
  做本地对照：模型淹没面积占比 **18.98%** vs SAR 水面 **2.35%**，**水面铺宽约 8 倍**，
  IoU 0.0847（判据 ≥0.5）。但**召回率 0.708**——模型覆盖了大部分真实水面，是**超集**。
  这与下面的点位诊断是同一物理事实的两面：**模型的水是摊薄的，不是集中的**。
  完整对照见 `out/p11_面积型验证.json` 与 `out/p8_遥感淹没范围验证.html` 第四节。
  ⚠️ 该件的 VH 通道用 `VV − 6.752 dB` 代理（真实 VH 因 AWS 限速未下完），补后须重跑；
  SAR 水面含常年河网，严格做法需旱季基线影像做差。
- 🆕 **生命线断供预判 FAIL（可核对样本仅 1 条）**。`out/p13_生命线断供预判.json`：
  10 条真实断供通报中，**8 条在计算域外**（海曙/镇海/奉化）、1 条为聚合口径，
  **可逐点核对的只有 1 条**（江北长岛花园电梯停梯），且该点模型峰值 **0.0002 m**
  （阈值 0.10 m），判 FAIL。域内 17 个涝点中，模型只越阈 **1 个**，观测越阈 **16 个**。
  **这个 FAIL 说明了架构上的事：生命线逻辑本身是通的**（FP002 在 07-25 15:20
  越 15 cm 阈值，观测 0.64 m 来自 07-27，提前量近两天），
  **但它忠实地传播了点位水深的零**。因此交通/电力/医疗各层不能建在点位水深不可用的模型上。
- **涝点水深命中率 0%**（MAE 0.36 m）。17 个域内涝点中 12 个模型水深恰好为 0.000——内核在这些格点上没有积水。Green-Ampt 机制下入渗总量 0.0 mm（占面雨量 0.0%），调参动不了。根因是管网能力（5 处下立交观测全为 0.50 m，模型在顶托 0.05 m 下排不出水）与地形分辨率（GLO-30 30 m DSM 无法表达下穿凹陷）。
- **降雨总量偏差 −31%**（259.1 mm vs 官方全市 375 mm）。ERA5 再分析能约束过程总量，不能约束对流尺度极值。
  注：该项已用 **CHIRPS-2.0 独立源交叉验证**——三个独立来源在计算域上给出 202.5 / 234.3 / 259.1 mm
  的一致区间，与官方全市口径的差异**来自区域范围**（全市含北部余姚暴雨中心 475 mm），
  而非模型误差。见 `out/p2_情景损失单_规划岗.html` 第三节。
- **重现期关系不可标定**。超阈值点仅 7 个，GPD 的 MLE 给 ξ=5.93；合成实验证明 n=7 时 ξ 落回 ±0.5 的概率仅 16%，需 n≥30。经验频率法已提供但**不外推**。
- **气候标度 CC 用的是先验值**（7%/°C），非标定结果。16 场事件全在 1990–2025 同一气候态内，信号淹没在事件间差异里。
- **149 个内涝监测点坐标是 `provenance=synthetic` 占位**，实测水深非公开。
- **Agent 化收益无实测支撑**。G24 因无 LLM API key 整条 BLOCKED，当前所有「Agent 提效」的表述都是推断。
- **CMFD / CMPAS 未接入**：读取器已交付（`typhoeus/cmfd.py`、`typhoeus/cmpas.py`，自测 PASS），
  但 TPDC 与 CMA 的免登录下载只对 <1 GiB 数据集开放（TPDC 前端源码判据），
  两份目标数据为 1049.8 GiB / 45.2 GiB，须账号登录取 FTP 凭据。见 `docs/product-spec.md` §7.1。

---

## 文档

| 文件 | 内容 |
|---|---|
| `PRODUCT_MATURITY.md` | 产品形态评估 |
| `ENGINEERING_MATURITY.md` | 工程成熟度与改进计划 |
| `COVERAGE.md` | 承灾体系与四色分级口径 |
| `DATA_SOURCE_EVAL.md` | 数据源评估 |
| `COMPETITIVE_ANALYSIS.md` | 竞品对比 |
| `REN_BENCHMARK.md` | 浙大 REN 对比 |
| `AGENT_FORM_EVAL.md` | Agent 形态评估 |
| `AGENT_POSITIONING_REPORT.md` | Agent 定位报告 |
| `COMPOUND_RISK_PLAN.md` | 复合风险方案 |
| `WORLD_MODEL_HJEPA.md` | H-JEPA 世界模型方案 |
| `DOC_GAP_ANALYSIS.md` | 文档缺口分析 |
| `UPGRADE_v3.1.md` | v3.1 升级记录 |
| `version.py` | **版本与全部口径修正的权威记录**，改动前先读它 |