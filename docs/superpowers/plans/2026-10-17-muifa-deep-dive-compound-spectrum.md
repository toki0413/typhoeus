# 梅花深挖 + 一页正文复合全谱升维 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 2022 梅花（MUIFA）跑通与烟花同构的五步决策链产出，并把 `submission/01_一页正文.md` 升维为"风-雨-潮-涝复合气候风险全谱"叙事。

**Architecture:** 不改烟花任何产物与默认配置路径（保指纹）。梅花深挖走独立驱动器 `tools/muifa_deep_dive.py`，复用内核/投影/对账/测度等既有纯函数；ERA5 降雨为 2022 年事件缓存，与参数化口径并列双跑。一页正文原地升级。

**Tech Stack:** Python 3（numpy/scipy，无新增依赖）、Open-Meteo archive API（免 key）、IBTrACS 本地路径、既有 typhoeus 包。

## Global Constraints

- **指纹不动**：默认路径 `config_hash 92cd76c2ea3f`、`source_hash 40d07eb29407b4b6` 跑完本计划全部任务后逐项复验不变。
- **三态纪律**：每个新声称带 PASS/FAIL/BLOCKED 与出处；梅花无实测台账，**只主张"链条可迁移"，不主张"精度迁移"**。
- **不覆盖 `out/` 现有文件**：梅花产物一律落 `runs/out_muifa/`。
- **回归**：`pytest typhoeus/tests.py` 全程 125 条口径不回归（允许新增通过项）。
- **文档语言**：中文；数字全部可由命令复算。
- **时间盒**：全部任务须在 2026-10-19 12:00 前完成（截止当天 24:00 要留出装订与视频时间）。

---

### Task 1: 参数化口径单场复跑（零代码改动）

**Files:**
- Create: `runs/out_muifa/multievent_calibration.json`

**Interfaces:**
- Produces: `runs/out_muifa/multievent_calibration.json` 中 MUIFA 单场记录，字段与 `out/07_multievent_calibration.json` 的场次明细一致（年/台风/路径点/最近距离_km/峰值风速_ms/最低气压_hPa/72h面雨量_mm/峰值雨强_mm_h/峰值水深_m/峰值时刻_h/Q_total/Q_气候/Q_超标/Q_工程失效/Q_残差/残差占比_pct/闭合）。

- [ ] **Step 1: 单场批量**

```bash
python -m typhoeus.cli multievent --catalog "2022:MUIFA" --outdir runs/out_muifa
```

预期：输出 `[1/1] OK 2022 MUIFA ... 雨量 40.7 mm ... Q 0.0703 ... 残差 6.4%`，落盘 `runs/out_muifa/multievent_calibration.json`。

- [ ] **Step 2: 与既有批量结果逐字段对账**

```bash
PYTHONIOENCODING=utf-8 python - <<'EOF'
import json
a = json.load(open('runs/out_muifa/multievent_calibration.json', encoding='utf-8'))
b = json.load(open('out/07_multievent_calibration.json', encoding='utf-8'))
ra = [e for e in a['场次明细'] if e['台风'] == 'MUIFA'][0]
rb = [e for e in b['场次明细'] if e['台风'] == 'MUIFA'][0]
diff = {k: (ra.get(k), rb.get(k)) for k in rb if ra.get(k) != rb.get(k)}
print('差异:', diff if diff else '无——参数化口径逐位复现')
EOF
```

预期：打印"无——参数化口径逐位复现"（浮点末位差异须归因记录）。

- [ ] **Step 3: Commit**

```bash
git add runs/out_muifa/multievent_calibration.json && git commit -m "feat(muifa): 参数化口径单场复跑，与批量结果对账一致"
```

---

### Task 2: 梅花公开通报检索与台账落盘

**Files:**
- Create: `data/seed/flood_points_2022_muifa.csv`（如检索到）
- Create: `data/seed/service_outages_2022_muifa.csv`（如检索到）

**Interfaces:**
- Produces: 两个 CSV，列格式与 2021 版完全一致——涝点表：`point_id,name,district,lon,lat,depth_m,observed_at,structure_type,source,provenance,coord_precision`；断供表：`outage_id,category,target,lon,lat,start_at,restored_at,magnitude,unit,source,provenance`（category 限 lifeline.py 六类：道路封道/下穿立交封道/电梯停梯/配电停供/人员转移/强排作业；时间格式 `%Y-%m-%d %H:%M`）。
- Consumes: 下游 Task 4/5 按文件存在与否决定对照分析做不做。

- [ ] **Step 1: 检索**

用 WebSearch 查："梅花 2022 宁波 积水 内涝 通报"、"台风梅花 宁波 下穿立交 积水 2022年9月"、"梅花 宁波 停电 停梯 断供 2022"。每条命中须能落到具体 source（机构+日期）。

- [ ] **Step 2: 按 2021 格式落盘**

每行带 `source`（通报机构+日期）与 `provenance=实测公开通报`；坐标精度沿用 ±100 m 口径；查不到精确坐标的点不编坐标，单独记入报告"无法定位"清单。

- [ ] **Step 3: 如实记录缺口**

两个文件各写一份三态摘要（检索到 n 条 / 域内 m 条 / 无法定位 k 条），写进 `docs/muifa-deep-dive.md` 骨架（Task 7 补全）。检索不到就创建空骨架并标 BLOCKED（缺：梅花宁波段可定位通报）。

- [ ] **Step 4: Commit**

```bash
git add data/seed/*_2022_muifa.csv docs/muifa-deep-dive.md
git commit -m "feat(muifa): 公开通报台账（检索到N条/无则BLOCKED骨架）"
```

---

### Task 3: ERA5 2022 降雨拉取（事件缓存，默认路径不变）

**Files:**
- Modify: `typhoeus/rainsrc.py`（仅加可选参数，默认值与现状逐字相同）
- Create: `data/seed/rain_reanalysis_era5_muifa2022.npz`

**Interfaces:**
- Consumes: `typhoeus/rainsrc.py` 的 `fetch_era5` / `load_cache` / `save_cache`（先读 `rainsrc.py:50-240` 确认签名，再动手）。
- Produces: 梅花 ERA5 缓存 npz，形状契约 `(433, 144, 270) float32`（nt=72h/600s+1，grid 144×270），时间窗 2022-09-12T00:00 至 2022-09-15T23:00，anchor = 路径最接计算域中心的时刻（由 IBTrACS 路径程序化计算，梅花过境宁波在 2022-09-14 至 09-15，先打印路径最近点时刻确认再定窗）。

- [ ] **Step 1: 确认梅花窗口与 anchor**

```bash
PYTHONIOENCODING=utf-8 python - <<'EOF'
from typhoeus import data as D
track = D.load_track(season=2022, name='MUIFA', lon_range=(115.0, 135.0))
import math
c = (29.88, 121.625)
d = [(math.hypot(p.lon-c[1], p.lat-c[0]), p.time) for p in track]
d.sort()
print('最近点:', d[0])
EOF
```

预期：打印最近距离与时刻；据此定 anchor（打印值）与时窗（anchor ±36 h 对齐到日界）。

- [ ] **Step 2: 给 rainsrc 加可选参数**

`get_rainfall` 与 `fetch_era5` 增加可选参数 `event_window=None, anchor_iso=None, cache_key=None`；为 `None` 时行为与现状逐位相同（模块常量 `EVENT_START/EVENT_END/ANCHOR_ISO` 作为默认值引用，不得复制字面量）。`load_cache/save_cache` 支持 `cache_key` 分键，默认键 "era5" 不变。

- [ ] **Step 3: 拉取并缓存**

```bash
PYTHONIOENCODING=utf-8 python - <<'EOF'
from typhoeus import config as CFG, data as D, rainsrc as RS
cfg = CFG.Config()
grid = D.load_all(cfg.l2.bbox, cfg.l4.resample)[0]
rain, rep = RS.get_rainfall(grid, stations=None, use_cache=False,
                            calibrate=False, verbose=True,
                            event_window=("2022-09-12", "2022-09-15"),
                            anchor_iso="<Step1打印的anchor>",
                            cache_key="era5_muifa2022")
print('形状:', rain.shape, '累计:', float(rain.sum(axis=(1,2)).max()))
EOF
```

预期：返回实值（非全零），形状 `(433, 144, 270)`，`data/seed/rain_reanalysis_era5_muifa2022.npz` 落盘，stdout 报告 driver=era5。

- [ ] **Step 4: 默认路径回归 + 指纹**

```bash
python -m typhoeus.cli run --skip-matrix
```
预期：与既有产物一致，`out/config.json` 的 `config_hash` 仍为 `92cd76c2ea3f`、`source_hash` 仍为 `40d07eb29407b4b6`（若 `source_hash` 定义覆盖 seed 目录且新 npz 使其变化，须在 Task 7 报告中归因写明；`config_hash` 必须不变）。

- [ ] **Step 5: Commit**

```bash
git add typhoeus/rainsrc.py data/seed/rain_reanalysis_era5_muifa2022.npz
git commit -m "feat(rainsrc): 事件窗口/缓存分键可选参数化，拉取梅花ERA5双口径之锚"
```

---

### Task 4: 梅花双口径内核跑 + 归因分型（m17）

**Files:**
- Create: `tools/muifa_deep_dive.py`
- Create: `runs/out_muifa/m17_归因分解.json`

**Interfaces:**
- Consumes: `D.load_track(season=2022, name="MUIFA", lon_range=(115.0,135.0))`、`K.rainfall_field(track, grid, kcfg)`、`K.run(grid, rain, kcfg)`、`PRJ.aggregate(res.depth, prj_params)`、`RC.event_total(proj["Q"], dt_h)`、`RS.get_rainfall(..., cache_key="era5_muifa2022")`、`CFG.Config()`。组装方式照抄 `typhoeus/cli.py:510-515`（grid/kcfg/prj_params 三件套）。
- Produces: `runs/out_muifa/m17_归因分解.json`，schema 对齐 `out/p17_归因分解.json`（先读该文件确认键名）；双口径并排列：parameterized / era5 各一组分型结果。

- [ ] **Step 1: 写驱动器骨架**

`tools/muifa_deep_dive.py` 结构（照 `typhoeus/attribution.py:74-203` 的机制，换数据来源）：

```python
"""梅花 2022 全链深挖驱动器。复用烟花主链纯函数，不改任何既有模块行为。"""
from typhoeus import config as CFG, data as D, kernel as K, projection as PRJ
from typhoeus import reconcile as RC, rainsrc as RS
# run(grid, kcfg, prj_params) 三件套组装照 cli.py:510-515
# 双口径雨场：parameterized = K.rainfall_field(track, grid, kcfg)
#             era5 = RS.get_rainfall(..., cache_key="era5_muifa2022")
# 归因：同一雨场跑三次内核（排水系数 0 / 1.2e-3 / 1.2e-2），
#      峰值水深三段分解 + 四型分型（机制照 attribution.py，参数不照抄其硬编码）
```

- [ ] **Step 2: 跑通双口径并落盘**

```bash
PYTHONIOENCODING=utf-8 python tools/muifa_deep_dive.py attribution
```
预期：打印两场口径的峰值水深/Q/分型摘要，写 `runs/out_muifa/m17_归因分解.json`。

- [ ] **Step 3: Commit**

```bash
git add tools/muifa_deep_dive.py runs/out_muifa/m17_归因分解.json
git commit -m "feat(muifa): 双口径内核跑+归因分型 m17"
```

---

### Task 5: 梅花情景翻转带 + 反解门槛（m20/m21-m22）

**Files:**
- Modify: `tools/muifa_deep_dive.py`
- Create: `runs/out_muifa/m19-m20_决策稳定性.json`、`runs/out_muifa/m21-m22_反问题.json`

**Interfaces:**
- Consumes: Task 4 的双口径雨场与内核入口；Task 2 的涝点 CSV（存在则做点位反解，不存在则反解整段标 BLOCKED）。
- Produces: 两文件 schema 对齐 `out/p19-p20_代价排序与决策稳定性.json`、`out/p21-p22_反问题.json`（先读确认键名）。

- [ ] **Step 1: 情景档定义（写明口径）**

梅花无自己的四档分位先例，采用**强度阶梯**：以该口径 72h 面雨量为基准 ×{0.75, 1.0, 1.5, 2.0} 四档（依据：18 场目录面雨量跨 2.2–291.6 mm 共 130 倍离散，倍数档在样本覆盖内）；产物内写明方法出处与本口径性质（强度阶梯 ≠ 事件分位）。每档一次内核，逐点峰值 min–max 即翻转带（机制照 `decisions.py:129-146`）。

- [ ] **Step 2: 反解**

涝点 CSV 存在：对域内点做排水系数二分（机制照 `inverse.py:48-101`，TARGETS 换成梅花点，无点型先验则只按结构类型标）；CSV 不存在：文件仍落盘，内容标 BLOCKED 并写明"缺梅花可定位涝点通报"。

- [ ] **Step 3: 跑通落盘 + Commit**

```bash
PYTHONIOENCODING=utf-8 python tools/muifa_deep_dive.py decisions inverse
git add tools/muifa_deep_dive.py runs/out_muifa/ && git commit -m "feat(muifa): 情景翻转带与反解门槛 m20/m21-m22"
```

---

### Task 6: 梅花规划决策卡（m32）

**Files:**
- Modify: `tools/muifa_deep_dive.py`
- Create: `runs/out_muifa/m32_规划决策卡.json`、`runs/out_muifa/m32_规划决策卡.html`

**Interfaces:**
- Consumes: `runs/out_muifa/` 下 m17/m19-m20/m21-m22 四件 + 涝点 CSV（有则逐点，无则只出全域行）。
- Produces: 与 `out/p32_规划决策卡.json` 同构（每点一行：分型→手段 / 翻转带→可信度 / 反解→投入方向；可信度四标签规则照 `decision_card.py:119-131`）。

- [ ] **Step 1: 聚合落盘**

```bash
PYTHONIOENCODING=utf-8 python tools/muifa_deep_dive.py card
```
预期：JSON + HTML 落盘；无台账时每点行由"域覆盖+分型"合成，凡涉实测的列一律"未验证"标签。

- [ ] **Step 2: Commit**

```bash
git add tools/muifa_deep_dive.py runs/out_muifa/ && git commit -m "feat(muifa): 规划决策卡 m32"
```

---

### Task 7: 深挖报告 + 烟花↔梅花对比表

**Files:**
- Modify: `docs/muifa-deep-dive.md`（Task 2 骨架上补全）

**Interfaces:**
- Consumes: Task 1–6 全部产物。

- [ ] **Step 1: 写报告**，固定章节：
  1. 双口径降雨对照（参数化 vs ERA5：峰值/累计/空间质心，差异归因口径）；
  2. 内核结果对照（峰值水深/Q/残差闭合，两场并列表）；
  3. 五步链条逐步三态（分级→病因→手段→门槛→可信度，逐步给 PASS/BLOCKED 与出处）；
  4. 烟花↔梅花同构对比表（同列：面雨量/峰值水深/Q/分型格局/翻转带/反解门槛/可信度覆盖）；
  5. 可迁移性判定——**链条可迁移 PASS（两场同构跑通），精度迁移不主张（梅花无实测台账）**；
  6. 诚实边界（参数化雨量 40.7 mm 与通报量级差异、ERA5 无站点订正、锚点单一）。

- [ ] **Step 2: 复算验证**——报告内每个数字给出复跑命令（Task 1–6 的命令原样收录）。

- [ ] **Step 3: Commit**

```bash
git add docs/muifa-deep-dive.md && git commit -m "docs(muifa): 全链深挖报告与烟花梅花对比表"
```

---

### Task 8: 一页正文 v2（复合气候风险全谱升维）

**Files:**
- Modify: `submission/01_一页正文.md`（原地升级）

**Interfaces:**
- Consumes: Task 7 报告、18 场批量（`out/07_multievent_calibration.json`）、p13 生命线、`docs/water-system-synthesis.md`（潮-顶托诊断）、spec。

- [ ] **Step 1: 重构为四层叙事**：
  1. **国家层**：国办 2021 实施意见 2025 死线 → 每城欠一份"可复算的内涝治理答案"；
  2. **方法层**：五步链 + 敢拒答，普适；18 场跨 36 年批量标定 + 梅花第二场全链深挖 = 不绑定单一事件；
  3. **实证层**：烟花 32 件产物（现有数字全部保留，降为本节）；
  4. **复合全谱三态标格**：雨-涝 PASS / 潮-顶托 BLOCKED（缺河网水位逐时接口，已诊断 5/17 点）/ 风 未接入（明示）/ 生命线 p13 PASS；附赛道三层任务链↔三条腿↔产物映射表。

- [ ] **Step 2: 自检**——每个新声称指到产物文件；无"全谱"字样的夸大（风灾格明示未接入）；更新 `submission/00_提交材料对照索引.md` 第四节状态（一页正文已完成、新增深挖材料）。

- [ ] **Step 3: Commit**

```bash
git add submission/ && git commit -m "docs(submission): 一页正文v2——复合气候风险全谱升维+梅花第二事件证据"
```

---

### Task 9: 全局回归 + 指纹终验

- [ ] **Step 1:** `pytest typhoeus/tests.py` —— 125 条口径不回归。
- [ ] **Step 2:** `python -m typhoeus.cli run` 全链——`config_hash 92cd76c2ea3f` 不变；`source_hash` 若变，归因到新 npz/新 CSV 并写入报告。
- [ ] **Step 3:** `git log --oneline -12` 确认 9 个任务提交齐整；工作区干净。
- [ ] **Step 4: Commit**（如有指纹归因补丁）

---

## Self-Review 记录

- **Spec 覆盖**：spec 设计一→Task 1–7；spec 设计二→Task 8；spec 验证→Task 9 各步。覆盖完整。
- **占位符扫描**：无 TBD/TODO；Task 3 Step 1 的 anchor 值由命令打印决定（数据驱动，非占位符），`<Step1打印的anchor>` 在 Step 3 使用前已被 Step 1 实际产出。
- **类型一致性**：Task 4–6 的 m17/m19-m20/m21-m22/m32 命名在 Task 6/7 的消费侧一致；`cache_key="era5_muifa2022"` 在 Task 3 生产、Task 4 消费，拼写一致。
