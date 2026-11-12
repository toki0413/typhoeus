# Foldit 式斑图解谜关卡 — 实施计划

## Context（为什么做、发现了什么）

用户已确认产品路线转向 **Foldit 式斑图设计关卡**：人负责高维空间搜索（画初始场），机器只做局部参数搜索（Wiggle）与随机抖动（Shake），评分对齐可验证的斑图目标。参数拟合模块退为工具，不再宣称“自动科研”。

在准备关卡时发现一个**必须先修的底层问题**：

1. [scientific.js](file:///workspace/commons/src/scientific.js#L114-L135) 的 `laplacian()` 不是真正的 Laplacian。权重和为 1.5，却只减去 `1×center`，常数场得到 `0.5` 而不是 `0`。
2. 预设 `D_u=1.0, D_v=0.5, dt=1.0` 在显式欧拉下远超稳定域，`clampSafe` 把发散结果压成均匀 `v=1`。
3. 因此科学引擎的斑图、λ_FT、D_box、H_v、L_c 全部建立在退化场上；这也是“看起来像科研但经不起追问”的根源之一。

**结论：Foldit 路线的前提是先让反应-扩散核心数值正确。** 否则关卡目标、评分、验证都是假的。

---

## Goals / Non-goals

**Goal**
- 一个可玩的新视图「解谜」：4 个关卡，画种子、调 f/k、Wiggle、Shake、提交评分、解锁下一关。
- 评分 = 结构匹配 + 空间布局 + 稳健性 + 墨量效率。
- 全部关卡标注“合成标定关卡，非实验数据”，通关后揭示隐藏参数与文献背景。

**Non-goal**
- 不接真实实验图 / 湿实验验证（下一阶段）。
- 不做后端、多人实时、Foldit 式脚本语言。
- 不保留旧的“自动拟合 = 科研”叙事。

---

## Phase 0 — 修正反应-扩散核心（阻塞项）

### 0.1 真 Laplacian

将 `laplacian()` 改为标准五点格式（torus / wall 两种边界）：

```js
lap = f[x-1] + f[x+1] + f[y-1] + f[y+1] - 4*f[x,y]
```

保留 `export function laplacian` 签名，避免其余模块改动。新增导出常量说明离散格式来源。

### 0.2 显式欧拉子步稳定性

在 `ReactionDiffusionEngine.step()` 内部按稳定域自动子步，禁止靠 clamp 掩盖发散：

```js
EXPLICIT_EULER_CFL = 0.25;          // 2D 五点 Laplacian 的 D·dt 上限
substeps = clamp(ceil(Dmax * dt / CFL), 1, 8);
for (let s = 0; s < substeps; s++) _substep(dt / substeps);
```

- `Dmax` 取当前 engine 的 `max(D_u, D_v)`，并乘 physics 的 `diffMult`。
- `_substep` 为现有 step 主体；`this.t += dt` 仍每次调用只加一次。
- 若 `substeps > 8`，抛出明确错误（数值不诚实，不静默截断）。

### 0.3 预设参数

- Gray-Scott 预设改为标准值：`D_u = 0.16`、`D_v = 0.08`、`dt = 1.0`，保留 f/k 分类。
- FHN / Brusselator 的 D 值由子步保护，不再自己改；跑 600 步验证有界。
- 种子约定：空白 `u=1,v=0`；画到的格子 `u=0.5,v=0.25`（标准 GS 激发条件），不再用 `v=1`。

### 0.4 重校准

- 用修正后的引擎重算 `PATTERN_LIBRARY` 中 RD 条目的 `signature`（λ_FT / D_box / E_field / L_c），并注明“由修正后求解器在 64×64、600 步下测得”。
- 更新任何把退化值（D≈1.97、H_v≈0）当基准的测试断言。

### 0.5 Phase 0 验收

- `laplacian(constant) === 0`；`laplacian(x²+y²) ≈ 4`。
- 纯扩散（f=k=0）随机场总质量相对漂移 < 1e-6（不依赖 clamp）。
- 5 个 GS 预设跑 600 步：无 NaN、场非均匀（std > 0.02）、占据率 0.05–0.95。
- 科学面板显示真实斑图，`npm test` 全绿。

---

## Phase 1 — 关卡逻辑（纯 JS，无 DOM）

新文件 `src/puzzle.js`：

```js
export const PUZZLE_LEVELS = [...];        // 4 关
export function makeMask(w, h, seed);       // 稀疏种子
export function stampMask(mask, x, y, {brush, erase});
export function shakeMask(mask, seed);
export function getTarget(levelId);         // 惰性生成 + 缓存
export function createSession(levelId);     // {mask, f, k, level, shakes, token}
export function evaluate(session, opts);    // 3 复现 + 评分
export async function wiggle(session, {budget=24, onProgress, isCancelled});
export function loadPuzzleProgress() / savePuzzleProgress();
```

### 关卡数据（初值，实施时按 0.5 验收标准校准）

| id | 类别 | 隐藏 f/k | 起始 f/k | 允许范围 | 步数 |
|---|---|---|---|---|---|
| `spots-garden` | 斑点 | 0.030 / 0.060 | 0.024 / 0.054 | f 0.020–0.040, k 0.052–0.068 | 480 |
| `stripes-river` | 条纹 | 0.014 / 0.052 | 0.022 / 0.058 | f 0.010–0.024, k 0.046–0.062 | 480 |
| `maze-brain` | 迷宫 | 0.026 / 0.058 | 0.034 / 0.052 | f 0.020–0.034, k 0.052–0.064 | 480 |
| `coral-reef` | 珊瑚/六边 | 0.040 / 0.062 | 0.030 / 0.056 | f 0.028–0.048, k 0.054–0.070 | 480 |

每关：`inkFree = 0.06`、`inkCap = 0.22`、`replicates = 3`、`zoneGrid = 8`。实施时若目标布局信息在 480 步已洗掉，则下调该关步数到 240–360，以“目标 8×8 区域密度 std ≥ 0.08”为准。

### 评分公式（0–100）

设目标特征 `T`，候选 3 次复现特征 `F_i`：

- `d = featureDistance(T, mean(F_i))`
- `S_struct = 100 · exp(−d²)`
- 布局：8×8 区域密度向量 `Z`，余弦相似度 `cos`
  `S_layout = 100 · cos · min(1, S_struct/60)`
- 稳健：`σ = mean_{i<j} featureDistance(F_i,F_j)`
  `S_robust = 100 · exp(−σ²) · min(1, S_struct/50)`
- 墨量：`ink = paintedCells/4096`
  `S_ink = 100 · clamp((inkCap − ink)/(inkCap − inkFree), 0, 1)`；`paintedCells < 8` 判无效
- 总分：`0.50·S_struct + 0.25·S_layout + 0.15·S_robust + 0.10·S_ink`

复现：第 0 次用原始 mask；第 1/2 次由 `mulberry32(hash(level.seed, i))` 翻转 1% 格子，用于测稳健性。

### Wiggle / Shake

- **Wiggle**：只调 f/k，不动 mask。3 轮坐标下降，每轮各试 ±step 两个邻点，step 每轮减半；固定 24 次评估上限；目标函数 `S_struct + 0.5·S_layout`（单复现）；按三位小数缓存去重；每 4 次 `await` 并检查取消令牌。
- **Shake**：`mulberry32(hash(level.seed, shakeIndex))`，清 10 个已占格、加 10 个空格；保证剩余 ≥ 8 格；同 index 完全可复现。

### 进度存储

`localStorage['commons.puzzle.v1']`，结构：

```json
{ "spots-garden": { "best": 87, "stars": 2, "params": {"f":0.03,"k":0.06}, "updatedAt": 0 } }
```

使用私有 `safeStorage()`（照抄 `leaderboard.js` 的降级模式），损坏 JSON 静默回落。

---

## Phase 2 — UI 与集成

### 新文件 `src/ui/puzzle-view.js`

`createPuzzleView({ state, toast }) -> { render, activate, deactivate }`

- 关卡卡片：名称、类别、锁定状态、最好成绩/星级。
- 工作区：
  - 目标预览 canvas（120×120，固定 backing store，CSS 放大 + `image-rendering: pixelated`）
  - 工作 canvas（240×240 backing store，CSS 自适应）
  - 显示模式：`结果 / 种子 / 差异热图`，绘制时自动切到种子
- 控件：画笔半径（2–8 格）、橡皮、清空、f/k 滑杆、预览、Wiggle、Shake、提交评分、重置。
- 分数面板：总分 + 4 条分项条 + 目标/当前特征对照。
- 通关揭示：隐藏 f/k、类别、文献引用（Gray & Scott 1984 / Pearson 1993）、诚实声明。
- 解锁：第 1 关常开；上一关 best ≥ 60 解锁下一关。
- 生命周期：`token` 自增；每次 await 后校验 `token` 与 `state.view === 'puzzle'`；`deactivate()` 丢弃在途结果。canvas 不依赖 `clientWidth`（隐藏时为 0），固定 64×64 backing store。

### 集成改动

- [index.html](file:///workspace/commons/index.html#L36-L41)：导航加 `<button data-view="puzzle">解谜</button>`；在 `#view-lineage` 后加 `<main id="view-puzzle" class="view"></main>`。
- [app.js](file:///workspace/commons/src/app.js#L204-L205)：`import { createPuzzleView }`；实例化 `puzzleView`。
- [app.js](file:///workspace/commons/src/app.js#L2607-L2619)：`switchView` 视图数组加 `'puzzle'`，进入 `puzzleView.activate()`，离开 `deactivate()`。
- [app.js](file:///workspace/commons/src/app.js#L3486-L3541)：主循环条件改为 `state.view !== 'compare' && state.view !== 'puzzle'`；音频 tick 同样排除 `puzzle`。
- [app.js](file:///workspace/commons/src/app.js#L2748-L2753)：MutationObserver 节点列表加 `#view-puzzle`，让新滑杆自动获得填充与拖拽手感。
- `styles.css`：新增 `.puzzle-*`，复用现有纸白/黑/朱红 token 与 `.view-head`、`.btn`；窄屏单列，canvas `touch-action:none`。

---

## Phase 3 — 验证

### 自动化测试（新增 `test/puzzle.test.mjs`）

1. `laplacian(constant) === 0`；二次场近似 4。
2. GS 预设 600 步：非均匀、有界、无 NaN。
3. `getTarget` 同关卡两次结果逐字节一致且命中缓存。
4. 用隐藏 mask/参数评估：`S_struct ≈ 100`、`total ≥ 95`。
5. 错类（条纹特征对斑点目标）：`S_struct < 35`、`total < 55`。
6. 空白 mask：`total < 20`，所有分项有限且 ∈ [0,100]。
7. Wiggle 同输入两次：f/k 差 < 1e-9、评估数 ≤ 24、mask 不变。
8. Shake 同 index 两次字节相等；墨量变化 ≤ 20 格。
9. 进度存取往返一致；损坏 JSON 不抛错。

`package.json` 增加 `test:puzzle` 并串入 `test`。

### 手动 / 浏览器验证

- `npm test` 全绿；`npm run build && cp commons.html www/index.html`。
- 浏览器进入「解谜」：
  - 第 1 关画 2–3 笔 → 预览出现斑图；分数分项合理。
  - Wiggle 期间按钮禁用、有进度、可切页不报错。
  - 提交后出现星级与隐藏参数揭示。
  - 下一关按 best ≥ 60 解锁。
- 回到培育台：科学引擎显示真实斑图（不再均匀），指标非退化，无控制台错误。
- 窄屏（≤560 断点）静态核查：画布、滑杆、按钮不重叠。

---

## 诚实边界（写入 UI 与文档）

- 关卡目标由已知参数合成，是**合成标定关卡**，不是实验数据。
- 通关揭示的参数不是唯一解；只说明“同浏览器、同种子可复现”。
- 斑图类别参考 Gray & Scott 1984、Pearson 1993 的分类，不宣称参数区间逐点对应论文。
- 真实实验图与湿实验验证是下一阶段，不在本次交付。

---

## 关键文件

- 修改：`src/scientific.js`、`src/engines.js`、`src/config.js`（如涉及预设）、`src/patterns.js`、`index.html`、`src/app.js`、`styles.css`、`package.json`
- 新增：`src/puzzle.js`、`src/ui/puzzle-view.js`、`test/puzzle.test.mjs`
- 参考复用：`src/fit.js`（特征提取/距离）、`src/rng.js`（mulberry32）、`src/ui/science-panel.js`（UI 工厂模式）、`src/leaderboard.js`（safeStorage 降级模式）

## 实施顺序

1. Phase 0 求解器修正 + 基准测试（先跑通，避免在错误物理上做关卡）。
2. Phase 1 关卡逻辑 + 评分 + 单元测试（无 DOM，先保证可复现）。
3. Phase 2 UI 与视图集成。
4. Phase 3 全量测试、构建、浏览器验证、窄屏检查。
