# 提比翁 Typhoeus

城市内涝情景推演与验收工具。把一次台风过程解成四个可核对的动作：**预置方案 → 抢修排序 → 事件对账 → 韧性定价**，每个数字都带口径、可复算、可追责。

内核 v0.6.1-demo / 输出物格式 v3.7.0 / `config_hash` `e464fea5962b`

## 作为 DSH 插件安装

```bash
dsh plugin --profile web add github:toki0413/typhoeus
```

前置：`pipx install typhoeus`（或 `pip install typhoeus`），并设置 `TYPHOEUS_HOME` 指向放 `data/` 与 `out/` 的目录；不设则回落 `~/.typhoeus`。装好后可用 9 个只读工具：预置方案、抢修排序、事件对账、韧性定价、体检指标、体检报告、多事件标定、涝点卡、坐标查询。

本地值班台：`typhoeus-web`，浏览器打开 `http://127.0.0.1:8765`。

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
| pytest | 9.1.1 | 154 条回归测试 |
| mcp | 可选 | MCP 只读服务（9 个工具） |

**无 pandas 依赖**（本机装有但代码未引用）。**零环境变量、零 API key** —— 外部网络调用只有 Open-Meteo archive-api 免 key 接口（降雨 + 土壤状态两条），且都带本地缓存。

纯 CPU，无GPU 依赖。单次全链约 50 s。

---

## 目录结构

```
typhoeus-demo/
├── README.md                # 本文件：定位、安装、结果、边界
├── package.json             # DSH 插件清单（dsh.bundle 指向 dsh-plugin/）
├── pyproject.toml           # Python 包与三个命令：typhoeus / typhoeus-mcp / typhoeus-web
├── typhoeus/                # 主包，92 模块 / 25,333 行（下列为节选）
│   ├── tests.py      (2529)  # 154 条测试
│   ├── multievent.py ( 815)  # 18 场历史气旋批量标定
│   ├── kernel.py     ( 707)  # 图守恒律求解器 + Green-Ampt 入渗 + Ghil-Sellers 能量平衡
│   ├── cli.py        ( 622)  # 命令行入口 + KernelParams 单一构造源
│   ├── soilcal.py    ( 202)  # 观测 → 内渗参数的两次口径转换
│   ├── rainsrc.py    ( 507)  # 降雨源（ERA5 / 参数化合成场）
│   ├── soilsrc.py    ( 253)  # 土壤源（ERA5-Land 土壤湿度 + ET0，免key）
│   ├── observe.py    ( 448)  # 涝点台账、监测点、覆盖率与深度精度
│   ├── render.py     ( 436)  # 报告编译
│   ├── gates.py      ( 378)  # 27 条门槛实现
│   ├── compile.py    ( 377)  # 七份输出物编译
│   ├── agent_gates.py( 357)  # G16–G24 Agent 侧门槛
│   ├── planner.py    ( 298)  # 次模贪心恢复排序
│   ├── mcp_server.py ( 472)  # MCP 只读服务（9 个工具）
│   ├── data.py       ( 297)  # DEM 与台风路径加载
│   ├── guardrails.py ( 288)  # R1–R4 硬拒绝规则
│   ├── serving.py    ( 262)  # 缓存与调用预算
│   ├── projection.py ( 254)  # 承灾体水深→功能损失
│   ├── config.py     ( 211)  # 四层参数 + config_hash
│   ├── calib_gates.py( 192)  # G25–G27 多事件门槛
│   ├── calib_sheet.py( 189)  # 第七份产物「多事件标定单」
│   ├── reconcile.py  ( 173)  # Q 分解（主链与批量共用一份公式）
│   ├── measure.py    ( 167)  # 面雨量与联合分位数集合估计
│   ├── consistency.py(168)  # G21 跨产物一致性（12 对）
│   ├── version.py    (143)  # 版本单一来源
│   ├── finiteness.py ( 61)  # 非有限值防线
├── tools/                   # 诊断与自测脚本
│   ├── infil_diag.py        # 入渗机制 A/B 诊断
│   ├── gpd_sample_size.py   # GPD 样本量需求合成实验
│   ├── mcp_selftest.py      # MCP 自测与故障注入
│   └── make_seed_data.py    # 占位数据生成
├── dsh-plugin/              # DSH 插件包：清单、挂载补丁、自检、图标、中英说明
├── tools/                   # 诊断与自测脚本；tools/pkg/ 是安装/验收/值班台脚本
├── docs/
│   ├── analysis/            # 产品、工程、数据、竞品等 15 份评估
│   └── adr/                 # 架构决策记录
├── data/                    # 计算域数据（DEM、台风路径、台账；大文件不入库）
├── out/                     # 一次推演的八份产物 + 页面 + manifest
└── submission/              # 提交材料索引与正文
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
# 给它你的数，它给你只属于这个数的答案（秒级）
python -m typhoeus.cli demo --rain 320 --remaining 8
python -m typhoeus.cli demo --rain 320 --remaining 8 --map   # 再跑积水场（+90 s）

# 给它气象台的逐时预报曲线 —— 这样它才能回答「什么时候」
python -m typhoeus.cli demo --rain-series-file storm.csv --remaining 6
python -m typhoeus.cli demo --rain-series "0.5,0.8,2.1,3.4"

# 看 AI 到底承担什么：这个命令会显示规则程序判不出来的那一格
python -m typhoeus.demo --compare 354.1 338.8


python -m typhoeus.cli run          # 跑全链并导出全部输出物（约 90 s）
python -m typhoeus.cli check        # 只跑门槛
python -m typhoeus.cli report       # 打印体检摘要
python -m typhoeus.cli multievent   # 18 场历史气旋批量标定（约 280 s）
```

`demo` 的五段输出全部由你的输入决定：你的输入 → 该启动什么 → 来不来得及 →
逐点积水与越阈时刻 → 这条结论的边界。**换雨量、换剩余时间、换时间形状，答案都变。**

标量输入只能答「多严重」，**逐时序列才能答「什么时候」**——
实测同一总量、不同时间形状，越阈时刻相差 26 小时。

不给参数时用 2021 年台风「烟花」作示例。

### 参数

```bash
python -m typhoeus.cli run --outdir ./myout --config ./myconfig.json
python -m typhoeus.cli multievent --catalog "2021:IN-FA,2014:FUNG-WONG"
```

### 测试

```bash
python -m pytest typhoeus/tests.py -q          # 154 条，约 15 s
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

### 土壤源：ERA5-Land 土壤湿度与 ET0

同一个免key接口还提供土壤状态与参考蒸散，用于给入渗机制的两个标定常数提供观测锚点：

```bash
# 逐变量探测可用性（reference_evapotranspiration 实测 HTTP 400，不可用）
python -m typhoeus.soilsrc --probe

# 拉取并缓存到 data/seed/soil_state_era5land.npz（5 KB）
python -m typhoeus.soilsrc

# 查看标定链：观测 θ → 城市 θ，ET0 → 净短波
python -m typhoeus.soilcal
```

实测结论（2021 烟花，anchor `2021-07-25T06:00`）：

| 量 | 实测 | 内核原值 | 校准后 |
|---|---|---|---|
| 表层土壤相对饱和度 θ | **0.987**（三层互证0.987/0.987/0.982） | 0.45（定性判断） | 0.45× 城市折减 0.456 |
| 72h ET0 累计 | 5.47 mm | — | — |
| 净短波辐射 | 由 ET0 反解 78.0 W/m² | 40.0（定性判断） | 77.98 |

θ 观测是自然地表的值，计算域是城市硬化面，中间那层折减系数无观测，显式参数化在 `L2_site.urban_theta_frac`。直接取观测值会让 Green-Ampt 退化成常数入渗 —— 实测三档强度下吸力增益全为 0.000 mm，而θ0=0.45 时为 0.000 / 2.089 / 3.132 mm。

主链影响：入渗 4.83 → 5.49 mm，土壤蒸发 0.70 → 1.37 mm，峰值水深 0.4928 → 0.4930 m，守恒残差 5.56e-09。入渗这一项在主链上已无杠杆 —— θ0 改到 0.987 会把入渗压到 0.80 mm，而峰值水深只动 0.4256 → 0.4256 m。

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

| 文件 | 内容 |
|---|---|
| `01_preset_plan.json` | 预置方案单 |
| `02_recovery_order.json` | 恢复排序单 |
| `03_event_reconciliation.json` | 事件对账单（Q 分解 + 涝点逐点对照） |
| `04_resilience_pricing.json` | 韧性价目表 |
| `05_health_metrics.json` | 体检指标包 |
| `06_health_report.json` | 标准体检报告（含入渗与能量段） |
| `07_multievent_calibration.json` | 多事件标定单 |
| `config.json` / `manifest.json` | 配置与来源指纹 |

---

## 已知限制

以下不是待修的 bug，是当前口径的边界：

- **涝点水深命中率 0%**（MAE 0.36 m）。17 个域内涝点中 12 个模型水深恰好为 0.000——内核在这些格点上没有积水。入渗仅占总雨量 1.9%，调参动不了。根因是管网能力（5 处下立交观测全为 0.50 m，模型在顶托 0.05 m 下排不出水）与地形分辨率（GLO-30 30 m DSM 无法表达下穿凹陷）。
- **降雨总量偏差 −31%**（259.1 mm vs 官方全市 375 mm）。ERA5 再分析能约束过程总量，不能约束对流尺度极值。
- **重现期关系不可标定**。超阈值点仅 7 个，GPD 的 MLE 给 ξ=5.93；合成实验证明 n=7 时 ξ 落回 ±0.5 的概率仅 16%，需 n≥30。经验频率法已提供但**不外推**。
- **气候标度 CC 用的是先验值**（7%/°C），非标定结果。16 场事件全在 1990–2025 同一气候态内，信号淹没在事件间差异里。
- **149 个内涝监测点坐标是 `provenance=synthetic` 占位**，实测水深非公开。
- **Agent 化收益无实测支撑**。G24 因无 LLM API key 整条 BLOCKED，当前所有「Agent 提效」的表述都是推断。

---

## 文档

| 文件 | 内容 |
|---|---|
| `docs/analysis/PRODUCT_MATURITY.md` | 产品形态评估 |
| `docs/analysis/ENGINEERING_MATURITY.md` | 工程成熟度与改进计划 |
| `docs/analysis/COVERAGE.md` | 承灾体系与四色分级口径 |
| `docs/analysis/DATA_SOURCE_EVAL.md` | 数据源评估 |
| `docs/analysis/COMPETITIVE_ANALYSIS.md` | 竞品对比 |
| `docs/analysis/REN_BENCHMARK.md` | 浙大 REN 对比 |
| `docs/analysis/AGENT_FORM_EVAL.md` | Agent 形态评估 |
| `docs/analysis/AGENT_POSITIONING_REPORT.md` | Agent 定位报告 |
| `docs/analysis/COMPOUND_RISK_PLAN.md` | 复合风险方案 |
| `docs/analysis/WORLD_MODEL_HJEPA.md` | H-JEPA 世界模型方案 |
| `docs/analysis/DOC_GAP_ANALYSIS.md` | 文档缺口分析 |
| `docs/analysis/UPGRADE_v3.1.md` | v3.1 升级记录 |
| `version.py` | **版本与全部口径修正的权威记录**，改动前先读它 |