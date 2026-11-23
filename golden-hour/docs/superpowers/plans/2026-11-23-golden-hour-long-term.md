# Golden Hour 消防沙盒 · 长期实施规格与计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把《Golden Hour》从两段脚本切片扩展成可自由行动的系统性火灾沙盒：火、烟、热、氧、水、结构、器材、居民共用一套规则，同一目标至少三条可行路线/三种解法。

**Architecture:** 以 6×6 m 单房间粗网格为最小模拟单元，建筑只是「房间图 + 连接」；模拟层（`src/sim/**`）纯 TypeScript、固定 10 Hz、种子确定性，绝不依赖 Three/DOM；渲染层只读快照并插值。Phase 0.5 先把单房间补成完整闭环（蒸汽、背负、暴露、复盘），Phase 1 再扩建筑与自由路线，Phase 2–5 依次加工具矩阵、居民压力、沙盒事件、内容打磨。

**Tech Stack:** Vite 5 + TypeScript 5（strict）+ Three.js 0.170 + Vitest 2 + Puppeteer（视觉/音频门禁）+ 原生 DOM HUD。

---

## 0. 文档范围与使用方式

这是**长期规格**，覆盖 Phase 0.5 → Phase 5。写作原则：

- **Milestone A（Phase 0.5）** 提供逐行可执行任务：失败测试 → 实现 → 通过 → 提交。
- **Milestone B（Phase 1 核心）** 提供接口、文件、测试与代码级任务；B5/B6 的整合任务在 B1–B4 合并后展开。
- **Phase 2–5** 提供规格、文件清单、必须存在的测试与验收标准；进入对应阶段前，按本文件同一模板展开为可执行任务。
- 任何阶段都不得破坏第 3 节的系统不变量与第 10 节的质量门禁。

**仓库根目录：** `/workspace/golden-hour/mvs`
**模拟包：** `src/sim/spatial/`
**可玩入口：** `room.html`（Phase 0.5）、`building.html`（Phase 1）
**计划文件位置：** `docs/superpowers/plans/2026-11-23-golden-hour-long-term.md`

---

## 1. 北极星与设计支柱

一栋可以自由进出的居民楼火灾沙盒。玩家只有有限工具，靠对火、烟、热、风、水、结构的理解，自己决定从哪进、怎么救、先救谁、什么时候撤；同一个目标至少有三条可行路线/三种解法，系统会对每个动作做出符合直觉的连锁反应。

1. **系统优先于脚本**：不写「这扇门只能这样开」，只写门的材料、温度、缝隙、两侧气压与火类。
2. **多解**：门、窗、墙、火、被困者，每个障碍至少三种有效动词。
3. **自由路线**：水平 + 垂直移动（楼梯、消防梯、窗、破拆、屋顶），用体力和负重限制，而不是空气墙。
4. **环境即提示**：烟色、热浪、门把温度、声音、材料变化告诉玩家系统状态，不用任务箭头。
5. **代价与取舍**：水、灭火剂、破拆工具、时间、体力都是资源；快不等于安全。
6. **专业化教育**：灭火剂 × 火类、器材失效、就地取材、窒息/回燃/带电/金属火，每个判断都有可解释的后果。

**明确不做：** 开放世界、耐久度、战斗循环、完整 CFD/刚体物理、爬一切。

---

## 2. 现状基线（2026-11-23 已验证）

| 模块 | 现状 |
| --- | --- |
| `src/sim/spatial/fields.ts` | 8×8 粗网格，Cell 含 fuel/fire/heat/smoke/oxygen/water/structure/combustibility/smokeYield/fireClass；Opening 含 open/broken/temp/wet/backdraftTrigger；ToolState 含 charge/condition |
| `src/sim/spatial/spread.ts` | `FIXED_DT = 0.1`；通风、扩散、蔓延、燃烧、水抑制、结构、门温、回燃 |
| `src/sim/spatial/verbs.ts` | `openOpening/breakOpening/measureOpening/spray/isolate/smother/coolSurrounds/inspectTool` |
| `src/sim/spatial/agents.ts` | A/B/C/D/E/F × 水/泡沫/干粉/CO₂/湿化学/沙土/覆盖 的效率与危险矩阵 |
| `src/sim/spatial/improvised.ts` | 湿棉被、锅盖、食盐、水桶、湿毛巾、断电、关门、破窗 |
| `src/render/roomView.ts` | Three 俯视 + WebGL 不可用时 Canvas2D 降级 |
| `src/roomMain.ts` / `room.html` | 可玩单房间切片：移动、低姿、测温、开关门窗、喷剂、就地取材 |
| 测试 | `tests/room-spatial.test.ts` 17 项；全仓 169 项通过 |
| 门禁 | `npm run check` 绿；JS gzip 192.6 KB / 200 KB；3D 资产 1924.3 KB / 2662.4 KB |

**已知债务（必须在本计划内解决）：**

1. 玩家位置、暴露、胜负仍在 `roomMain.ts`，不在模拟层，无法确定性回放。
2. `worldToGrid/gridToWorld` 在 `roomView.ts` 内重复定义，建筑阶段会继续复制。
3. JS 包体只剩 7.4 KB 余量，Phase 1 必然超预算。
4. 单房间没有蒸汽、没有被困者，还没有「救出」这一层。
5. 旧的两层走廊切片仍占 `src/main.ts`，不能一次性推倒。

---

## 3. 系统不变量（任何阶段不得破坏）

1. **确定性**：模拟只接受 `dt` 与输入事件；`src/sim/**` 内禁止 `Math.random()`、`Date.now()`、DOM、Three。随机必须走 `src/sim/rng.ts` 的种子函数。
2. **场渲染分离**：`src/sim/**` 不 import `three`；渲染层不得修改 Cell 数值。
3. **固定步长**：模拟 10 Hz（`FIXED_DT`），渲染 60 Hz；用累加器推进，不做可变步长物理。
4. **单一最小单元**：单房间与整栋楼使用同一个 `RoomState` 与 `stepRoom`；建筑只增加房间图与连接，不复制火灾逻辑。
5. **每个动词有后果**：任何玩家动作必须产生可测的场变化、资源变化或状态变化，并返回 `lesson`（为什么有效/无效/危险）。
6. **数据驱动**：火类 × 灭火剂、器材状态、材料、房间布局都是表/数据，不是散落的 `if`。
7. **门禁绿**：每个任务结束必须 `npm run check` 通过；视觉/音频改动还要 `npm run verify`。
8. **旧切片可回退**：新系统通过独立入口/特性开关并存，旧教学关在 Phase 5 前始终可运行。

---

## 4. 目标文件结构

```
src/sim/
  spatial/
    fields.ts        # Cell / Opening / RoomState / createRoom / summary
    spread.ts        # 固定步长场更新
    agents.ts        # 灭火剂 × 火类矩阵
    improvised.ts    # 就地取材
    verbs.ts         # 单房间动词
    coords.ts        # 世界坐标 ↔ 网格（新）
    actor.ts         # 玩家状态：姿态/负重/体力/暴露（新）
    rescue.ts        # 被困者：健康/背负/撤离（新）
    rooms.ts         # 房间图与连接（新，Phase 1）
    scene.ts         # 场景定义：种子 + 布局 + 初始火情（新，Phase 1）
  nav/
    graph.ts         # 可行走图与路线搜索（新，Phase 1）
    movement.ts      # 移动、上下楼、负重与体力（新，Phase 1）
  interaction/
    tools.ts         # 水带/灭火器/破拆斧/排烟机/热像仪/梯绳（新，Phase 2）
    multiSolution.ts # 障碍 → 有效动词注册表（新，Phase 2）
  agents/
    resident.ts      # 居民行为（新，Phase 3）
    crowd.ts         # 多人救援（新，Phase 3）
  events/
    director.ts      # 风、窗失效、结构坍塌（新，Phase 4）
  replay.ts          # 种子 + 输入日志回放（新，Phase 4）
src/render/
  roomView.ts        # 单房间视图（已有）
  buildingView.ts    # 建筑剖视/切镜（新，Phase 1）
  buildingCam.ts     # 纯相机数据：每个房间的机位（新，Phase 1）
src/roomMain.ts      # Phase 0.5 可玩入口（已有，改造）
src/buildingMain.ts  # Phase 1 可玩入口（新）
src/app/
  budget.ts          # 纯预算计算（新，Phase 0.5）
  scenarioSelect.ts  # 教学关/沙盒切换（新，Phase 1）
scripts/
  budget.mjs         # 纯函数：入口分组与预算判定（新）
  check-bundle.mjs   # 读取脚本函数执行门禁（改造）
```

**边界规则：**

- `fields/spread/agents/improvised/verbs` 只依赖彼此，不依赖 `actor/rescue/nav`。
- `actor` 依赖 `fields/coords`；`rescue` 依赖 `fields/coords/actor`。
- `rooms` 依赖 `fields`；`nav` 依赖 `rooms/actor`。
- 渲染与入口可以依赖全部模拟层；模拟层不得反向依赖。

---

## 5. 数据契约

### 5.1 场（在现有基础上新增 steam 与能见度）

```ts
// src/sim/spatial/fields.ts
export interface Cell {
  fuel: number;
  fire: number;
  heat: number;
  smoke: number;
  /** 新增：蒸汽 0..1，水遇高温产生，降低能见度 */
  steam: number;
  oxygen: number;
  water: number;
  structure: number;
  combustibility: number;
  smokeYield: number;
  fireClass: FireClass;
}

export function roomSummary(state: RoomState): {
  fire: number;
  heat: number;
  smoke: number;
  steam: number;
  oxygen: number;
  fuel: number;
  structure: number;
  /** 0..1，1 为看得清 */
  visibility: number;
};
```

### 5.2 坐标

```ts
// src/sim/spatial/coords.ts
export const ROOM_SIZE_M: number;

export function worldToGrid(wx: number, wz: number): { x: number; y: number };
export function gridToWorld(x: number, y: number): { x: number; z: number };
export function clampToRoom(wx: number, wz: number, margin?: number): { x: number; z: number };
```

### 5.3 玩家状态

```ts
// src/sim/spatial/actor.ts
export type Stance = 'upright' | 'low' | 'crawl';

export interface ActorState {
  x: number;
  z: number;
  stance: Stance;
  /** 0..1，背人后上升 */
  load: number;
  /** 0..1 */
  stamina: number;
  exposure: { smoke: number; heat: number };
  downed: boolean;
}

export function createActor(x?: number, z?: number): ActorState;
export function stanceFactor(stance: Stance): number;
export function exposureAt(
  actor: ActorState,
  room: RoomState
): { smoke: number; heat: number };
export function stepActor(
  actor: ActorState,
  room: RoomState,
  dt: number,
  moving: boolean
): void;
export function moveActor(
  actor: ActorState,
  dx: number,
  dz: number,
  dt: number,
  speedBase?: number
): void;
```

### 5.4 被困者

```ts
// src/sim/spatial/rescue.ts
export type OccupantMood = 'calm' | 'panic' | 'unconscious';

export interface OccupantState {
  id: string;
  x: number;
  z: number;
  mood: OccupantMood;
  carried: boolean;
  rescued: boolean;
  /** 1..0 */
  health: number;
  /** 背起时实际加到玩家身上的负重，用于精确回退 */
  carryLoad: number;
}

export function createOccupant(x?: number, z?: number, id?: string): OccupantState;
export function attachOccupant(actor: ActorState, occupant: OccupantState): boolean;
export function syncCarriedOccupant(occupant: OccupantState, actor: ActorState): void;
export function stepOccupant(occupant: OccupantState, room: RoomState, dt: number): void;
export function nearestOpenExit(
  room: RoomState,
  x: number,
  z: number
): 'door' | 'window' | null;
export function extractOccupant(
  occupant: OccupantState,
  actor: ActorState,
  room: RoomState,
  exit: 'door' | 'window'
): boolean;
```

### 5.5 房间图（Phase 1）

```ts
// src/sim/spatial/rooms.ts
export interface RoomBounds { x: number; z: number; w: number; d: number; }

export interface RoomNode {
  id: string;
  floor: number;
  bounds: RoomBounds;
  room: RoomState;
}

export type LinkKind = 'door' | 'window' | 'stair' | 'ladder' | 'breach';

export interface RoomLink {
  id: string;
  a: string;
  b: string;
  kind: LinkKind;
  opening: Opening;
  /** 通过耗时（秒） */
  time: number;
  /** 风险 0..1，用于路线评分 */
  risk: number;
  blocked: boolean;
  aAnchor: { x: number; z: number };
  bAnchor: { x: number; z: number };
}

export interface BuildingGraph {
  rooms: Record<string, RoomNode>;
  links: RoomLink[];
}

export function createBuilding(): BuildingGraph;
```

### 5.6 路线（Phase 1）

```ts
// src/sim/nav/graph.ts
import type { ActorState } from '../spatial/actor';
import type { BuildingGraph, RoomLink } from '../spatial/rooms';

export interface Route {
  steps: RoomLink[];
  time: number;
  risk: number;
  score: number;
}

export function canTraverse(link: RoomLink, actor: ActorState): boolean;
export function findRoutes(
  graph: BuildingGraph,
  from: string,
  to: string,
  actor: ActorState,
  limit?: number
): Route[];
```

### 5.7 场景与复盘（Phase 1/4）

```ts
// src/sim/spatial/scene.ts
export interface ScenarioDefinition {
  id: string;
  seed: number;
  building: BuildingGraph;
  startRoom: string;
  objectives: string[];
  initialFire: { roomId: string; x: number; y: number; fire: number }[];
}

export interface ScenarioSnapshot {
  t: number;
  roomId: string;
  actor: ActorState;
  occupants: OccupantState[];
  rooms: Record<string, { fire: number; smoke: number; heat: number; oxygen: number }>;
  objectivesDone: string[];
}
```

---

## 6. 里程碑总览

| 里程碑 | 交付物 | 验收 | 门禁 |
| --- | --- | --- | --- |
| A · Phase 0.5 | 蒸汽、玩家状态、被困者背负/撤离、可玩切片闭环、预算按入口 | 三种解法都能救出居民；蒸汽与低姿影响可观察 | `npm run check` |
| B · Phase 1 | 3 层房间图、可行走图、三条到 202 的路线、建筑切镜 | 三条路线耗时/风险不同；楼梯坍塌后仍有替代路线 | `npm run check` + `verify:visual` |
| C · Phase 2 | 工具矩阵、资源重量、上下文动词轮盘 | 每个障碍 ≥3 有效动词；每个动词有可测场变化 | `npm run check` |
| D · Phase 3 | 居民 Agent、多人救援、失败由系统产生 | 同种子不同打法救出 0–3 人 | `npm run check` |
| E · Phase 4 | 事件导演、种子回放、因果复盘 | 同种子不同输入 → 不同演化；回放完全一致 | `npm run check` |
| F · Phase 5 | 3–5 户型、教学演练、可访问性、存档 | 5–8 分钟一局，60fps，完整门禁 | `npm run check` + `verify` |

---

## 7. Milestone A — Phase 0.5 可执行计划

**执行状态（2026-11-23）：A1–A6 已完成，A7 随本文档一起收尾。**

| 任务 | 状态 | 提交 |
| --- | --- | --- |
| A1 坐标模块 | 完成 | `4f693fe`、`d8a265d` |
| A2 蒸汽与能见度 | 完成 | `eaf4bde`、`07fd4a9` |
| A3 玩家状态与暴露 | 完成 | `c36954e`、`da866d5` |
| A4 被困者与撤离 | 完成 | `ebfcd13`、`efd895c` |
| A5 可玩切片整合 | 完成 | `88f41c5`、`cb89986` |
| A6 按入口包体预算 | 完成 | `0920c21`、`8d24278` |

**目标：** 单房间从「能灭火」变成「能救人」，并把玩家状态、暴露、胜负收进模拟层。

### Task A1: 抽出房间坐标模块

**Files:**
- Create: `src/sim/spatial/coords.ts`
- Create: `tests/room-coords.test.ts`
- Modify: `src/render/roomView.ts`（改为 import，不改行为）

- [ ] **Step 1: 写失败测试**

```ts
// tests/room-coords.test.ts
import { describe, it, expect } from 'vitest';
import {
  ROOM_SIZE_M,
  clampToRoom,
  gridToWorld,
  worldToGrid,
} from '../src/sim/spatial/coords';

describe('房间坐标', () => {
  it('房间边长是 6 米', () => {
    expect(ROOM_SIZE_M).toBe(6);
  });

  it('网格中心与世界坐标互为逆运算', () => {
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const w = gridToWorld(x, y);
        expect(worldToGrid(w.x, w.z)).toEqual({ x, y });
      }
    }
  });

  it('把越界点夹回房间内', () => {
    expect(clampToRoom(99, -99)).toEqual({ x: 2.75, z: -2.75 });
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/room-coords.test.ts`
Expected: FAIL，`Failed to resolve import "../src/sim/spatial/coords"`。

- [ ] **Step 3: 实现坐标模块**

```ts
// src/sim/spatial/coords.ts
import { CELL_SIZE, ROOM_COLS, ROOM_ROWS } from './fields';

export const ROOM_SIZE_M = CELL_SIZE * ROOM_COLS;

export function worldToGrid(wx: number, wz: number): { x: number; y: number } {
  return {
    x: Math.floor((wx + ROOM_SIZE_M / 2) / CELL_SIZE),
    y: Math.floor((wz + ROOM_SIZE_M / 2) / CELL_SIZE),
  };
}

export function gridToWorld(x: number, y: number): { x: number; z: number } {
  return {
    x: (x + 0.5) * CELL_SIZE - ROOM_SIZE_M / 2,
    z: (y + 0.5) * CELL_SIZE - ROOM_SIZE_M / 2,
  };
}

export function clampToRoom(
  wx: number,
  wz: number,
  margin = 0.25
): { x: number; z: number } {
  const half = ROOM_SIZE_M / 2 - margin;
  const halfZ = (CELL_SIZE * ROOM_ROWS) / 2 - margin;
  return {
    x: Math.min(half, Math.max(-half, wx)),
    z: Math.min(halfZ, Math.max(-halfZ, wz)),
  };
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/room-coords.test.ts`
Expected: 3 passed。

- [ ] **Step 5: 让 roomView 复用坐标模块**

在 `src/render/roomView.ts` 顶部加入：

```ts
import { ROOM_SIZE_M, worldToGrid, gridToWorld } from '../sim/spatial/coords';
```

把函数内两处本地定义替换为：

```ts
const size = ROOM_SIZE_M;
const cellSize = ROOM_SIZE_M / 8;
```

删除函数末尾重复的 `worldToGrid/gridToWorld` 定义，`return { ..., worldToGrid, gridToWorld, size }` 保持不变。

- [ ] **Step 6: 跑单房间测试与构建**

Run: `npx vitest run tests/room-spatial.test.ts tests/room-coords.test.ts && npx tsc --noEmit`
Expected: 全部通过，无类型错误。

- [ ] **Step 7: 提交**

```bash
git add src/sim/spatial/coords.ts tests/room-coords.test.ts src/render/roomView.ts
git commit -m "refactor(mvs): extract room coordinate helpers"
```

---

### Task A2: 蒸汽反馈

**Files:**
- Modify: `src/sim/spatial/fields.ts`
- Modify: `src/sim/spatial/spread.ts`
- Create: `tests/room-steam.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/room-steam.test.ts
import { describe, it, expect } from 'vitest';
import { cellAt, createRoom, roomSummary } from '../src/sim/spatial/fields';
import { runRoom } from '../src/sim/spatial/spread';
import { spray } from '../src/sim/spatial/verbs';

describe('蒸汽反馈', () => {
  it('水打到高温表面会产生蒸汽，能见度下降', () => {
    const room = createRoom();
    const source = cellAt(room, 5, 4);
    source.heat = 1;
    source.fire = 0.9;

    const before = roomSummary(room);
    spray(room, 'water', 5, 4, { radius: 1, amount: 0.3 });
    runRoom(room, 1.5);
    const after = roomSummary(room);

    expect(after.steam).toBeGreaterThan(0.001);
    expect(after.visibility).toBeLessThan(before.visibility);
    // 隔离蒸汽对能见度的贡献：visibility = 1 - smoke*0.6 - steam*0.4
    expect(1 - after.smoke * 0.6 - after.visibility).toBeGreaterThan(0.0005);
  });

  it('蒸汽会随时间散开，不会永久糊住能见度', () => {
    const room = createRoom();
    cellAt(room, 5, 4).heat = 0.95;
    cellAt(room, 5, 4).fire = 0.7;
    spray(room, 'water', 5, 4, { radius: 1, amount: 0.3 });
    runRoom(room, 1.5);
    const peak = roomSummary(room).steam;
    runRoom(room, 12);
    expect(roomSummary(room).steam).toBeLessThan(peak);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/room-steam.test.ts`
Expected: FAIL，`roomSummary(...).steam` 为 `undefined`。

- [ ] **Step 3: 给 Cell 与 summary 加 steam / visibility**

`src/sim/spatial/fields.ts`：

```ts
export interface Cell {
  fuel: number;
  fire: number;
  heat: number;
  smoke: number;
  steam: number;
  oxygen: number;
  water: number;
  structure: number;
  combustibility: number;
  smokeYield: number;
  fireClass: FireClass;
}
```

`emptyCell()` 增加 `steam: 0`。

`roomSummary` 改为：

```ts
export function roomSummary(state: RoomState): {
  fire: number;
  heat: number;
  smoke: number;
  steam: number;
  oxygen: number;
  fuel: number;
  structure: number;
  visibility: number;
} {
  const n = state.cells.length;
  let fire = 0;
  let heat = 0;
  let smoke = 0;
  let steam = 0;
  let oxygen = 0;
  let fuel = 0;
  let structure = 0;
  for (const c of state.cells) {
    fire += c.fire;
    heat += c.heat;
    smoke += c.smoke;
    steam += c.steam;
    oxygen += c.oxygen;
    fuel += c.fuel;
    structure += c.structure;
  }
  const avgSmoke = smoke / n;
  const avgSteam = steam / n;
  return {
    fire: fire / n,
    heat: heat / n,
    smoke: avgSmoke,
    steam: avgSteam,
    oxygen: oxygen / n,
    fuel: fuel / n,
    structure: structure / n,
    visibility: clamp01(1 - avgSmoke * 0.6 - avgSteam * 0.4),
  };
}
```

- [ ] **Step 4: 在扩散与施水中更新蒸汽**

`src/sim/spatial/spread.ts` 先加入具名常量：

```ts
const STEAM_DIFFUSION = 1.4;
const STEAM_THRESHOLD = 0.1;
const STEAM_GAIN = 1.8;
const STEAM_DECAY = 0.12;
```

`diffuse` 改为同时扩散 smoke/oxygen/heat/steam：

```ts
function diffuse(state: RoomState, dt: number): void {
  const { config, cells } = state;
  const n = cells.length;
  const smoke = new Float32Array(n);
  const oxygen = new Float32Array(n);
  const heat = new Float32Array(n);
  const steam = new Float32Array(n);

  const kSmoke = Math.min(0.9, SMOKE_DIFFUSION * dt);
  const kOxy = Math.min(0.9, OXYGEN_DIFFUSION * dt);
  const kHeat = Math.min(0.9, HEAT_DIFFUSION * dt);
  const kSteam = Math.min(0.9, 1.4 * dt);

  for (let y = 0; y < config.rows; y++) {
    for (let x = 0; x < config.cols; x++) {
      const i = index(config, x, y);
      const c = cells[i];
      let sAcc = c.smoke;
      let oAcc = c.oxygen;
      let hAcc = c.heat;
      let stAcc = c.steam;
      let count = 1;

      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + dx;
        const ny = y + dy;
        if (!inBounds(config, nx, ny)) continue;
        const nb = cells[index(config, nx, ny)];
        sAcc += nb.smoke;
        oAcc += nb.oxygen;
        hAcc += nb.heat;
        stAcc += nb.steam;
        count += 1;
      }

      smoke[i] = clamp01(c.smoke + (sAcc / count - c.smoke) * kSmoke);
      oxygen[i] = clamp01(c.oxygen + (oAcc / count - c.oxygen) * kOxy);
      heat[i] = clamp01(c.heat + (hAcc / count - c.heat) * kHeat);
      steam[i] = clamp01(c.steam + (stAcc / count - c.steam) * kSteam);
    }
  }

  for (let i = 0; i < n; i++) {
    cells[i].smoke = smoke[i];
    cells[i].oxygen = oxygen[i];
    cells[i].heat = heat[i];
    cells[i].steam = steam[i];
  }
}
```

`applyWater` 改为：

```ts
function applyWater(state: RoomState, dt: number): void {
  for (const c of state.cells) {
    if (c.water > 0) {
      if (c.heat > STEAM_THRESHOLD) {
        const vapor = c.water * (c.heat - STEAM_THRESHOLD) * STEAM_GAIN * dt;
        c.steam = clamp01(c.steam + vapor);
        c.heat = clamp01(c.heat - vapor * 0.6);
      }

      c.fire = clamp01(c.fire - c.water * 0.9 * dt);
      c.heat = clamp01(c.heat - c.water * 0.5 * dt);
      c.water = Math.max(0, c.water - 0.12 * dt);
    }

    // 蒸汽衰减必须在水分支外，否则水膜干后蒸汽会永远留在房里。
    c.steam = clamp01(c.steam - c.steam * STEAM_DECAY * dt);
  }
}
```

`fields.ts` 的能见度权重也提取常量：

```ts
const VISIBILITY_SMOKE_WEIGHT = 0.6;
const VISIBILITY_STEAM_WEIGHT = 0.4;

visibility: clamp01(
  1 - avgSmoke * VISIBILITY_SMOKE_WEIGHT - avgSteam * VISIBILITY_STEAM_WEIGHT
),
```

- [ ] **Step 5: 运行，确认通过**

Run: `npx vitest run tests/room-steam.test.ts tests/room-spatial.test.ts`
Expected: 全部通过。

- [ ] **Step 6: 提交**

```bash
git add src/sim/spatial/fields.ts src/sim/spatial/spread.ts tests/room-steam.test.ts
git commit -m "feat(mvs): steam generation and visibility feedback"
```

---

### Task A3: 玩家状态与暴露

**Files:**
- Create: `src/sim/spatial/actor.ts`
- Create: `tests/room-actor.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/room-actor.test.ts
import { describe, it, expect } from 'vitest';
import { createRoom } from '../src/sim/spatial/fields';
import {
  createActor,
  moveActor,
  stepActor,
} from '../src/sim/spatial/actor';

describe('玩家状态', () => {
  it('低姿比站立吸入更慢', () => {
    const room = createRoom();
    for (const c of room.cells) {
      c.smoke = 0.8;
      c.steam = 0;
      c.heat = 0;
    }
    const upright = createActor(0, 0);
    const low = createActor(0, 0);
    low.stance = 'low';

    for (let i = 0; i < 20; i++) {
      stepActor(upright, room, 0.1, false);
      stepActor(low, room, 0.1, false);
    }

    expect(low.exposure.smoke).toBeLessThan(upright.exposure.smoke);
  });

  it('持续高热暴露会让玩家倒地', () => {
    const room = createRoom();
    for (const c of room.cells) {
      c.heat = 1;
      c.smoke = 0;
      c.steam = 0;
    }
    const actor = createActor(0, 0);
    for (let i = 0; i < 100; i++) stepActor(actor, room, 0.1, false);
    expect(actor.downed).toBe(true);
  });

  it('负重越高移动越慢', () => {
    const light = createActor(0, 0);
    const loaded = createActor(0, 0);
    loaded.load = 0.8;

    moveActor(light, 1, 0, 1);
    moveActor(loaded, 1, 0, 1);

    expect(loaded.x).toBeLessThan(light.x);
  });

  it('移动被夹在房间边界内', () => {
    const actor = createActor(0, 0);
    moveActor(actor, 1, 0, 10);
    expect(actor.x).toBe(2.75);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/room-actor.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 actor.ts**

```ts
// src/sim/spatial/actor.ts
import { cellAt, clamp01, type RoomState } from './fields';
import { clampToRoom, worldToGrid } from './coords';

export type Stance = 'upright' | 'low' | 'crawl';

export interface ActorState {
  x: number;
  z: number;
  stance: Stance;
  load: number;
  stamina: number;
  exposure: { smoke: number; heat: number };
  downed: boolean;
}

export function createActor(x = -2.35, z = 0): ActorState {
  return {
    x,
    z,
    stance: 'upright',
    load: 0,
    stamina: 1,
    exposure: { smoke: 0, heat: 0 },
    downed: false,
  };
}

export function stanceFactor(stance: Stance): number {
  if (stance === 'crawl') return 0.12;
  if (stance === 'low') return 0.22;
  return 0.45;
}

export function exposureAt(
  actor: ActorState,
  room: RoomState
): { smoke: number; heat: number } {
  const g = worldToGrid(actor.x, actor.z);
  const x = Math.min(room.config.cols - 1, Math.max(0, g.x));
  const y = Math.min(room.config.rows - 1, Math.max(0, g.y));
  const c = cellAt(room, x, y);
  return { smoke: c.smoke + c.steam * 0.5, heat: c.heat };
}

export function stepActor(
  actor: ActorState,
  room: RoomState,
  dt: number,
  moving: boolean
): void {
  if (actor.downed) return;

  const env = exposureAt(actor, room);
  actor.exposure.smoke += env.smoke * stanceFactor(actor.stance) * dt;
  actor.exposure.heat += env.heat * (actor.stance === 'crawl' ? 0.1 : 0.22) * dt;

  if (moving) {
    const drain = (actor.stance === 'upright' ? 0.06 : 0.03) * (1 + actor.load);
    actor.stamina = clamp01(actor.stamina - drain * dt);
  } else {
    actor.stamina = clamp01(actor.stamina + 0.04 * dt);
  }

  if (actor.exposure.smoke + actor.exposure.heat >= 1) {
    actor.downed = true;
  }
}

export function moveActor(
  actor: ActorState,
  dx: number,
  dz: number,
  dt: number,
  speedBase = 1.6
): void {
  if (actor.downed) return;
  const len = Math.hypot(dx, dz);
  if (len <= 0) return;

  const stancePenalty = actor.stance === 'crawl' ? 0.4 : actor.stance === 'low' ? 0.6 : 1;
  const loadPenalty = 1 - Math.min(0.45, actor.load * 0.45);
  const staminaPenalty = 0.6 + actor.stamina * 0.4;
  const speed = speedBase * stancePenalty * loadPenalty * staminaPenalty;
  const next = clampToRoom(
    actor.x + (dx / len) * speed * dt,
    actor.z + (dz / len) * speed * dt
  );
  actor.x = next.x;
  actor.z = next.z;
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/room-actor.test.ts`
Expected: 4 passed。

- [ ] **Step 5: 提交**

```bash
git add src/sim/spatial/actor.ts tests/room-actor.test.ts
git commit -m "feat(mvs): actor stance, load, stamina and exposure"
```

---

### Task A4: 被困者与撤离

**Files:**
- Create: `src/sim/spatial/rescue.ts`
- Create: `tests/room-rescue.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/room-rescue.test.ts
import { describe, it, expect } from 'vitest';
import { createRoom } from '../src/sim/spatial/fields';
import { createActor } from '../src/sim/spatial/actor';
import {
  attachOccupant,
  createOccupant,
  extractOccupant,
  stepOccupant,
} from '../src/sim/spatial/rescue';

describe('被困者与撤离', () => {
  it('离得太远不能背起', () => {
    const actor = createActor(-2.3, 0);
    const occupant = createOccupant(2.2, 2);
    expect(attachOccupant(actor, occupant)).toBe(false);
    expect(occupant.carried).toBe(false);
  });

  it('靠近后可以背起，负重上升', () => {
    const actor = createActor(1.9, 2);
    const occupant = createOccupant(2.2, 2);
    expect(attachOccupant(actor, occupant)).toBe(true);
    expect(occupant.carried).toBe(true);
    expect(actor.load).toBeGreaterThan(0.5);
  });

  it('背到打开的门边才算获救，关门时失败', () => {
    const room = createRoom();
    const actor = createActor(-2.4, 0);
    const occupant = createOccupant(-2.2, 0);
    attachOccupant(actor, occupant);

    expect(extractOccupant(occupant, actor, room, 'door')).toBe(false);

    room.openings.door.open = true;
    expect(extractOccupant(occupant, actor, room, 'door')).toBe(true);
    expect(occupant.rescued).toBe(true);
  });

  it('浓烟中健康下降，归零后失去意识', () => {
    const room = createRoom();
    for (const c of room.cells) c.smoke = 0.9;
    const occupant = createOccupant(0, 0);
    for (let i = 0; i < 300; i++) stepOccupant(occupant, room, 0.1);
    expect(occupant.health).toBe(0);
    expect(occupant.mood).toBe('unconscious');
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/room-rescue.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 rescue.ts**

```ts
// src/sim/spatial/rescue.ts
import { cellAt, clamp01, type RoomState } from './fields';
import { gridToWorld, worldToGrid } from './coords';
import type { ActorState } from './actor';

export type OccupantMood = 'calm' | 'panic' | 'unconscious';

export interface OccupantState {
  id: string;
  x: number;
  z: number;
  mood: OccupantMood;
  carried: boolean;
  rescued: boolean;
  health: number;
  /** 背起时实际加到玩家身上的负重，用于精确回退 */
  carryLoad: number;
}

const OCCUPANT_SMOKE_RATE = 0.05;
const OCCUPANT_HEAT_RATE = 0.04;
const CARRY_PROTECTION = 0.4;
const ATTACH_RANGE = 0.9;
const EXIT_RANGE = 1.2;
const CARRY_LOAD = 0.55;

export function createOccupant(
  x = 2.2,
  z = 2,
  id = 'resident-202'
): OccupantState {
  return {
    id,
    x,
    z,
    mood: 'panic',
    carried: false,
    rescued: false,
    health: 1,
    carryLoad: 0,
  };
}

export function distance(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

export function attachOccupant(actor: ActorState, occupant: OccupantState): boolean {
  if (actor.downed) return false;
  if (occupant.rescued || occupant.carried) return false;
  if (distance(actor.x, actor.z, occupant.x, occupant.z) > ATTACH_RANGE) return false;

  const applied = Math.min(1 - actor.load, CARRY_LOAD);
  actor.load = clamp01(actor.load + applied);
  occupant.carryLoad = applied;
  occupant.carried = true;
  return true;
}

/** 背起后让居民跟随玩家位置；每帧在 stepOccupant 前调用。 */
export function syncCarriedOccupant(occupant: OccupantState, actor: ActorState): void {
  if (!occupant.carried) return;
  occupant.x = actor.x;
  occupant.z = actor.z;
}

export function stepOccupant(
  occupant: OccupantState,
  room: RoomState,
  dt: number
): void {
  if (occupant.rescued) return;
  if (!Number.isFinite(dt) || dt <= 0) return;

  const g = worldToGrid(occupant.x, occupant.z);
  const x = Math.min(room.config.cols - 1, Math.max(0, g.x));
  const y = Math.min(room.config.rows - 1, Math.max(0, g.y));
  const c = cellAt(room, x, y);
  const protection = occupant.carried ? CARRY_PROTECTION : 1;

  occupant.health = clamp01(
    occupant.health -
      (c.smoke * OCCUPANT_SMOKE_RATE + c.heat * OCCUPANT_HEAT_RATE) * protection * dt
  );
  if (occupant.health <= 0) occupant.mood = 'unconscious';
}

/** 返回离 (x,z) 最近的已打开/已破拆出口；没有可用出口时返回 null。 */
export function nearestOpenExit(
  room: RoomState,
  x: number,
  z: number
): 'door' | 'window' | null {
  let best: 'door' | 'window' | null = null;
  let bestDist = Infinity;

  for (const id of ['door', 'window'] as const) {
    const opening = room.openings[id];
    if (!opening.open && !opening.broken) continue;
    const point = gridToWorld(opening.x, opening.y);
    const d = distance(x, z, point.x, point.z);
    if (d < bestDist) {
      bestDist = d;
      best = id;
    }
  }

  return best;
}

export function extractOccupant(
  occupant: OccupantState,
  actor: ActorState,
  room: RoomState,
  exit: 'door' | 'window'
): boolean {
  if (actor.downed) return false;
  if (occupant.rescued) return false;

  const opening = room.openings[exit];
  if (!opening.open && !opening.broken) return false;

  const exitPoint = gridToWorld(opening.x, opening.y);
  if (distance(actor.x, actor.z, exitPoint.x, exitPoint.z) > EXIT_RANGE) return false;

  if (!occupant.carried) {
    if (distance(actor.x, actor.z, occupant.x, occupant.z) > ATTACH_RANGE) return false;
    if (distance(occupant.x, occupant.z, exitPoint.x, exitPoint.z) > EXIT_RANGE) {
      return false;
    }
  }

  const wasCarried = occupant.carried;
  occupant.rescued = true;
  occupant.carried = false;
  if (wasCarried) {
    actor.load = Math.max(0, actor.load - occupant.carryLoad);
    occupant.carryLoad = 0;
  }
  return true;
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/room-rescue.test.ts`
Expected: 10 passed（执行时在原 5 项基础上补了：背负位置跟随、获救后冻结、引导撤离不掉负重、NaN dt、最近开启出口）。

- [ ] **Step 5: 提交**

```bash
git add src/sim/spatial/rescue.ts tests/room-rescue.test.ts
git commit -m "feat(mvs): victim carry, health decay and extraction"
```

---

### Task A5: 把玩家/被困者接进可玩切片

**Files:**
- Modify: `src/roomMain.ts`
- Modify: `room.html`
- Modify: `src/render/roomView.ts`（蒸汽着色）

- [ ] **Step 1: 增加 UI 元素**

`room.html` 的 `#actions` 中加入：

```html
<button data-action="carry" class="primary">背人 / 撤离 C</button>
```

`#hint` 改为：

```html
<div><kbd>W A S D</kbd> 移动 · <kbd>Shift</kbd> 低姿 · <kbd>C</kbd> 背人/撤离</div>
<div><kbd>E</kbd> 开门 · <kbd>R</kbd> 开窗 · <kbd>Q</kbd> 测温</div>
<div><kbd>1</kbd> 水 · <kbd>2</kbd> 干粉 · <kbd>3</kbd> CO₂ · <kbd>4</kbd> 湿棉被 · <kbd>5</kbd> 断电 · <kbd>6</kbd> 关门</div>
```

- [ ] **Step 2: 删除 roomMain 里的自维护 player/exposure**

`src/roomMain.ts` 顶部加入：

```ts
import { createActor, moveActor, stepActor } from './sim/spatial/actor';
import {
  attachOccupant,
  createOccupant,
  extractOccupant,
  stepOccupant,
} from './sim/spatial/rescue';
```

删除：

```ts
let player = { x: -2.35, z: 0 };
let exposure = { smoke: 0, heat: 0 };
```

替换为：

```ts
const actor = createActor();
let occupant = createOccupant();
let unconsciousLogged = false;
```

- [ ] **Step 3: 改写移动与暴露**

`update(dt)` 中，把玩家移动与暴露两段替换为：

```ts
actor.stance = lowStance ? 'low' : 'upright';

const speedInput = { x: dx, z: dz };
const moving = Math.hypot(speedInput.x, speedInput.z) > 0;
if (moving) moveActor(actor, speedInput.x, speedInput.z, dt);

stepActor(actor, room, dt, moving);
syncCarriedOccupant(occupant, actor);
stepOccupant(occupant, room, dt);
```
（`syncCarriedOccupant` 必须在 `stepOccupant` 之前，否则会按背起点采样健康。）

`playerGrid()` 改为围绕 `actor`：

```ts
function playerGrid(): { x: number; y: number } {
  const g = view.worldToGrid(actor.x, actor.z);
  return {
    x: Math.min(room.config.cols - 1, Math.max(0, g.x)),
    y: Math.min(room.config.rows - 1, Math.max(0, g.y)),
  };
}
```

- [ ] **Step 4: 增加背人/撤离动作**

在 `action(name)` 中、`closeDoor` 分支之后加入：

```ts
if (name === 'carry') {
  if (occupant.carried) {
    const exit = nearestOpenExit(room, actor.x, actor.z);
    const ok = exit !== null && extractOccupant(occupant, actor, room, exit);
    addLog(
      ok ? '把居民带出火场，任务完成。' : '先把人背到打开的门或窗边再撤。',
      ok ? 'lesson' : 'info'
    );
  } else if (attachOccupant(actor, occupant)) {
    addLog(
      occupant.mood === 'unconscious'
        ? '居民已经失去意识，只能硬背，移动会明显变慢。'
        : '背起居民，移动会明显变慢。',
      'lesson'
    );
  } else {
    addLog('离居民太远，先靠近再背。', 'info');
  }
  return;
}
```

- [ ] **Step 5: 更新 HUD 与结局**

`updateHud()` 的自身暴露改为：

```ts
const self = clamp01(actor.exposure.smoke + actor.exposure.heat);
```

`checkOutcome()` 改为：

```ts
function checkOutcome(): void {
  if (ended) return;
  const s = roomSummary(room);

  if (actor.downed) {
    end(
      '你被烟和热压倒了',
      '暴露超限。低姿、湿毛巾、先排烟都能降低吸入；别在浓烟里硬撑。'
    );
    return;
  }

  if (occupant.rescued) {
    end(
      '居民已救出',
      `用时 ${room.t.toFixed(1)} 秒，水耗 ${room.stats.waterUsed.toFixed(2)}，烟排出 ${room.stats.smokeVented.toFixed(2)}。`
    );
    return;
  }

  if (occupant.health <= 0 && occupant.mood === 'unconscious' && !unconsciousLogged) {
    unconsciousLogged = true;
    addLog('居民失去意识，尽快背出去。', 'danger');
  }
}
```

- [ ] **Step 6: 渲染被困者与蒸汽**

`src/render/roomView.ts` 的 `RoomView` 接口与 `sync` 增加入参：

```ts
export interface RoomView {
  sync(
    state: RoomState,
    actor: { x: number; z: number },
    dt: number,
    occupant?: { x: number; z: number; rescued: boolean }
  ): void;
  // 其余不变
}
```

`roomMain.ts` 的帧循环里把旧调用替换为：

```ts
view.sync(room, actor, dt, occupant);
```

在 `sync` 的 Canvas2D 分支里、玩家之后绘制倒地人形（未获救时）：

```ts
if (occupant && !occupant.rescued) {
  const ox = originX + ((occupant.x + size / 2) / size) * board;
  const oy = originY + ((occupant.z + size / 2) / size) * board;
  ctx.beginPath();
  ctx.fillStyle = '#c39a7f';
  ctx.arc(ox, oy, cell * 0.22, 0, Math.PI * 2);
  ctx.fill();
}
```

Three 分支里加一个简化的倒地盒子，位置随 `occupant` 更新。

`src/render/roomView.ts` 的地板着色加入蒸汽：

```ts
color.lerp(new THREE.Color(0xbfc7cf), clamp01(cell.steam * 0.5));
```

- [ ] **Step 7: 跑门禁**

Run: `npm run check`
Expected: 全部通过；HUD 不报错；包体不得超当前预算（若超，先做 Task A6）。

- [ ] **Step 8: 提交**

```bash
git add src/roomMain.ts room.html src/render/roomView.ts
git commit -m "feat(mvs): playable carry-and-extract loop in room slice"
```

---

### Task A6: 包体预算按入口拆分

**Files:**
- Create: `scripts/budget.mjs`
- Create: `tests/budget.test.ts`
- Modify: `scripts/check-bundle.mjs`
- Modify: `vite.config.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/budget.test.ts
import { describe, it, expect } from 'vitest';
// @ts-expect-error 纯 JS 门禁脚本没有类型声明
import { evaluateBudget, groupEntries } from '../scripts/budget.mjs';

describe('包体预算', () => {
  it('按文件名前缀分组 gzip', () => {
    const grouped = groupEntries([
      { name: 'main-a.js', gzip: 10 },
      { name: 'main-b.js', gzip: 5 },
      { name: 'room-a.js', gzip: 7 },
      { name: 'three.module-x.js', gzip: 100 },
    ]);
    expect(grouped).toEqual({ main: 15, room: 7, 'three.module': 100 });
  });

  it('超出预算返回失败项', () => {
    const failures = evaluateBudget({ main: 2048, room: 512 }, { main: 1024, room: 1024 });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('main');
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/budget.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现纯预算模块**

```js
// scripts/budget.mjs
export function groupEntries(files) {
  const groups = new Map();
  for (const file of files) {
    const entry = file.name.split('-')[0];
    groups.set(entry, (groups.get(entry) ?? 0) + file.gzip);
  }
  return Object.fromEntries(groups);
}

export function evaluateBudget(summary, budgets) {
  const failures = [];
  for (const [name, bytes] of Object.entries(summary)) {
    const budget = budgets[name];
    if (budget === undefined) continue;
    if (bytes > budget) {
      failures.push(
        `${name} ${(bytes / 1024).toFixed(1)}KB > ${(budget / 1024).toFixed(1)}KB`
      );
    }
  }
  return failures;
}

export const ENTRY_BUDGETS = {
  main: 60 * 1024,
  room: 80 * 1024,
  building: 90 * 1024,
  'three.module': 170 * 1024,
};

export const TOTAL_JS_BUDGET = 340 * 1024;
```

- [ ] **Step 4: 改写 check-bundle 使用新模块**

```js
// scripts/check-bundle.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  ENTRY_BUDGETS,
  TOTAL_JS_BUDGET,
  evaluateBudget,
  groupEntries,
} from './budget.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');

if (!existsSync(dist)) {
  console.error('dist/ 不存在，先运行 npm run build');
  process.exit(1);
}

const gzipSize = (path) => gzipSync(readFileSync(path)).length;
const assetDir = join(dist, 'assets');

const jsFiles = readdirSync(assetDir).filter((n) => n.endsWith('.js'));
const files = jsFiles.map((name) => ({
  name,
  gzip: gzipSize(join(assetDir, name)),
}));

const entries = groupEntries(files);
const totalJs = Object.values(entries).reduce((a, b) => a + b, 0);

const media = readdirSync(assetDir)
  .filter((n) => /\.(glb|gltf|bin|ktx2)$/.test(n))
  .reduce((sum, n) => sum + readFileSync(join(assetDir, n)).length, 0);

console.log('入口 gzip：', entries);
console.log(`JS 总计 gzip ${(totalJs / 1024).toFixed(1)} KB / ${(TOTAL_JS_BUDGET / 1024).toFixed(0)} KB`);
console.log(`3D 资产 ${(media / 1024).toFixed(1)} KB / 2662.4 KB`);

const failures = evaluateBudget(entries, ENTRY_BUDGETS);
if (totalJs > TOTAL_JS_BUDGET) {
  failures.push(`JS 总计 ${(totalJs / 1024).toFixed(1)}KB > ${(TOTAL_JS_BUDGET / 1024).toFixed(0)}KB`);
}
if (media > 2.6 * 1024 * 1024) {
  failures.push('3D 资产超预算');
}

if (failures.length) {
  console.error('包体超预算：', failures);
  process.exit(1);
}

console.log('包体预算通过');
```

- [ ] **Step 5: 运行测试与门禁**

Run: `npx vitest run tests/budget.test.ts && npm run build && npm run check:bundle`
Expected: 2 passed；包体预算通过。

- [ ] **Step 6: 提交**

```bash
git add scripts/budget.mjs scripts/check-bundle.mjs tests/budget.test.ts vite.config.ts
git commit -m "chore(mvs): per-entry bundle budgets"
```

---

### Task A7: 更新路线图状态

**Files:**
- Modify: `ROADMAP.md`

- [ ] **Step 1: 勾选 Phase 0.5 已完成项**

把 `ROADMAP.md` 中「蒸汽」「背负/引导被困者」改为 `[x]`，并在 Phase 0 的状态段追加：

```markdown
- Phase 0.5 完成：蒸汽与能见度、玩家姿态/负重/体力/暴露、被困者健康与背负撤离、可玩切片闭环、按入口包体预算。
```

- [ ] **Step 2: 提交**

```bash
git add ../ROADMAP.md
git commit -m "docs: mark phase 0.5 completion"
```

---

## 8. Milestone B — Phase 1 核心任务

**执行状态（2026-11-23）：B1–B6 已完成。**

| 任务 | 状态 | 提交 |
| --- | --- | --- |
| B1 房间图 | 完成 | `b3ad15f`、`4db069e` |
| B2 路线搜索 | 完成 | `9d3a5f5`、`76a7d5d`、`5615b12` |
| B3 上下楼成本 | 完成 | `1d40a9b`、`4ceb252` |
| B4 建筑相机 | 完成 | `de6f87d`、`b90a662` |
| B5a 建筑场景 | 完成 | `13337ae`、`7929c9d` |
| B5b 建筑切片 | 完成 | `1f278bd`、`f752221` |
| B6 场景选择 | 完成 | `3d238aa`、`a60af23` |
| 整合终审修复 | 完成 | `490eea8` |

**目标：** 3 层建筑图、可行走图、三条到 202 的路线、房间切镜。

### Task B1: 房间图与建筑骨架

**Files:**
- Create: `src/sim/spatial/rooms.ts`
- Create: `tests/building-graph.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/building-graph.test.ts
import { describe, it, expect } from 'vitest';
import { createBuilding } from '../src/sim/spatial/rooms';

describe('建筑房间图', () => {
  it('包含入口、楼梯、202 与消防梯', () => {
    const graph = createBuilding();
    expect(graph.rooms.entrance).toBeDefined();
    expect(graph.rooms['stair-F1']).toBeDefined();
    expect(graph.rooms['room-202-F1']).toBeDefined();
    expect(graph.rooms['escape-F1']).toBeDefined();
  });

  it('每个连接的两端都存在', () => {
    const graph = createBuilding();
    for (const link of graph.links) {
      expect(graph.rooms[link.a]).toBeDefined();
      expect(graph.rooms[link.b]).toBeDefined();
    }
  });

  it('202 至少有三条不同入口连接', () => {
    const graph = createBuilding();
    const links = graph.links.filter(
      (l) => l.a === 'room-202-F1' || l.b === 'room-202-F1'
    );
    const kinds = new Set(links.map((l) => l.kind));
    expect(kinds.size).toBeGreaterThanOrEqual(3);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/building-graph.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 rooms.ts**

```ts
// src/sim/spatial/rooms.ts
import { createRoom, type Opening, type RoomState } from './fields';

export interface RoomBounds {
  x: number;
  z: number;
  w: number;
  d: number;
}

export interface RoomNode {
  id: string;
  floor: number;
  bounds: RoomBounds;
  room: RoomState;
}

export type LinkKind = 'door' | 'window' | 'stair' | 'ladder' | 'breach';

export interface RoomLink {
  id: string;
  a: string;
  b: string;
  kind: LinkKind;
  time: number;
  risk: number;
  blocked: boolean;
  aAnchor: { x: number; z: number };
  bAnchor: { x: number; z: number };
}

export interface BuildingGraph {
  rooms: Record<string, RoomNode>;
  links: RoomLink[];
}

let seq = 0;
function link(
  a: string,
  b: string,
  kind: LinkKind,
  time: number,
  risk: number
): RoomLink {
  seq += 1;
  return {
    id: `L${seq}`,
    a,
    b,
    kind,
    time,
    risk,
    blocked: false,
    aAnchor: { x: 0, z: 0 },
    bAnchor: { x: 0, z: 0 },
  };
}

export function createBuilding(): BuildingGraph {
  seq = 0;
  const rooms: Record<string, RoomNode> = {};
  const add = (id: string, floor: number, x: number, z: number) => {
    rooms[id] = { id, floor, bounds: { x, z, w: 6, d: 6 }, room: createRoom() };
  };

  add('entrance', 0, -8, 8);
  add('lobby-F0', 0, -2, 8);
  add('stair-F0', 0, 4, 8);
  add('stair-F1', 1, 4, 8);
  add('stair-F2', 2, 4, 8);
  add('room-201-F1', 1, -2, 2);
  add('room-202-F1', 1, 4, 2);
  add('room-202-F2', 2, 4, 2);
  add('escape-F1', 1, 10, 2);
  add('escape-F2', 2, 10, 2);
  add('roof', 3, 4, -4);

  const links: RoomLink[] = [];
  links.push(link('entrance', 'lobby-F0', 'door', 2, 0.02));
  links.push(link('lobby-F0', 'stair-F0', 'door', 3, 0.03));
  links.push(link('stair-F0', 'stair-F1', 'stair', 8, 0.08));
  links.push(link('stair-F1', 'stair-F2', 'stair', 8, 0.1));
  links.push(link('stair-F1', 'room-201-F1', 'door', 3, 0.15));
  links.push(link('stair-F1', 'room-202-F1', 'door', 4, 0.25));
  links.push(link('stair-F2', 'room-202-F2', 'door', 3, 0.2));
  links.push(link('room-202-F1', 'escape-F1', 'window', 2, 0.3));
  links.push(link('escape-F1', 'escape-F2', 'ladder', 6, 0.35));
  links.push(link('escape-F2', 'roof', 'ladder', 4, 0.3));
  links.push(link('room-202-F2', 'room-202-F1', 'breach', 5, 0.5));
  links.push(link('entrance', 'escape-F1', 'ladder', 5, 0.2));

  return { rooms, links };
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/building-graph.test.ts`
Expected: 3 passed。

- [ ] **Step 5: 提交**

```bash
git add src/sim/spatial/rooms.ts tests/building-graph.test.ts
git commit -m "feat(mvs): building room graph"
```

---

### Task B2: 路线搜索

**Files:**
- Create: `src/sim/nav/graph.ts`
- Create: `tests/route-search.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/route-search.test.ts
import { describe, it, expect } from 'vitest';
import { createBuilding } from '../src/sim/spatial/rooms';
import { createActor } from '../src/sim/spatial/actor';
import { canTraverse, findRoutes } from '../src/sim/nav/graph';

describe('路线搜索', () => {
  it('入口到 202 至少三条路线，且类型不同', () => {
    const graph = createBuilding();
    const routes = findRoutes(graph, 'entrance', 'room-202-F1', createActor(), 3);
    expect(routes.length).toBe(3);

    const kinds = routes.map((r) => r.steps.map((s) => s.kind).join('>'));
    expect(kinds.some((k) => k.includes('stair'))).toBe(true);
    expect(kinds.some((k) => k.includes('ladder'))).toBe(true);
    expect(kinds.some((k) => k.includes('breach'))).toBe(true);
  });

  it('楼梯全部坍塌后仍能到达 202', () => {
    const graph = createBuilding();
    for (const link of graph.links) {
      if (link.kind === 'stair') link.blocked = true;
    }
    const routes = findRoutes(graph, 'entrance', 'room-202-F1', createActor(), 3);
    expect(routes.length).toBeGreaterThanOrEqual(1);
    expect(routes.every((r) => r.steps.every((s) => s.kind !== 'stair'))).toBe(true);
  });

  it('负重过高时不能走消防梯', () => {
    const graph = createBuilding();
    const loaded = createActor();
    loaded.load = 0.9;
    const routes = findRoutes(graph, 'entrance', 'room-202-F1', loaded, 3);
    expect(routes.every((r) => r.steps.every((s) => s.kind !== 'ladder'))).toBe(true);
  });

  it('canTraverse 对梯子检查体力与负重', () => {
    const graph = createBuilding();
    const ladder = graph.links.find((l) => l.kind === 'ladder')!;
    const actor = createActor();
    expect(canTraverse(ladder, actor)).toBe(true);
    actor.load = 0.9;
    expect(canTraverse(ladder, actor)).toBe(false);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/route-search.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 graph.ts**

```ts
// src/sim/nav/graph.ts
import type { ActorState } from '../spatial/actor';
import type { BuildingGraph, RoomLink } from '../spatial/rooms';

export interface Route {
  steps: RoomLink[];
  time: number;
  risk: number;
  score: number;
}

export function canTraverse(link: RoomLink, actor: ActorState): boolean {
  if (link.blocked) return false;
  if (link.kind === 'ladder') return actor.load < 0.7 && actor.stamina > 0.25;
  if (link.kind === 'window') return actor.load < 0.6;
  return true;
}

function dijkstra(
  graph: BuildingGraph,
  from: string,
  to: string,
  banned: Set<string>,
  actor: ActorState
): Route | null {
  const dist = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, RoomLink>();
  const visited = new Set<string>();
  const queue: string[] = [from];

  while (queue.length) {
    queue.sort((a, b) => (dist.get(a) ?? Infinity) - (dist.get(b) ?? Infinity));
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    if (id === to) break;

    for (const link of graph.links) {
      if (banned.has(link.id)) continue;
      if (!canTraverse(link, actor)) continue;

      const next = link.a === id ? link.b : link.b === id ? link.a : null;
      if (!next) continue;

      const cost = (dist.get(id) ?? Infinity) + link.time + link.risk * 20;
      if (cost < (dist.get(next) ?? Infinity)) {
        dist.set(next, cost);
        prev.set(next, link);
        queue.push(next);
      }
    }
  }

  if (!dist.has(to)) return null;

  const steps: RoomLink[] = [];
  let cursor = to;
  while (cursor !== from) {
    const link = prev.get(cursor);
    if (!link) return null;
    steps.unshift(link);
    cursor = link.a === cursor ? link.b : link.a;
  }

  const time = steps.reduce((sum, l) => sum + l.time, 0);
  const risk = steps.reduce((sum, l) => sum + l.risk, 0) / Math.max(1, steps.length);
  return { steps, time, risk, score: time + risk * 20 };
}

export function findRoutes(
  graph: BuildingGraph,
  from: string,
  to: string,
  actor: ActorState,
  limit = 3
): Route[] {
  const found: Route[] = [];
  const seen = new Set<string>();
  const bans: Set<string>[] = [new Set()];

  while (bans.length && found.length < limit) {
    const banned = bans.shift()!;
    const route = dijkstra(graph, from, to, banned, actor);
    if (!route) continue;

    const key = route.steps.map((s) => s.id).join('>');
    if (!seen.has(key)) {
      seen.add(key);
      found.push(route);
    }

    for (const step of route.steps) {
      const next = new Set(banned);
      next.add(step.id);
      bans.push(next);
    }
  }

  return found;
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/route-search.test.ts`
Expected: 4 passed。若「三种类型」断言不满足，检查 `createBuilding` 的连接是否覆盖 stair/ladder/breach。

- [ ] **Step 5: 提交**

```bash
git add src/sim/nav/graph.ts tests/route-search.test.ts
git commit -m "feat(mvs): route search with traversal constraints"
```

---

### Task B3: 移动与上下楼

**Files:**
- Create: `src/sim/nav/movement.ts`
- Create: `tests/nav-movement.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/nav-movement.test.ts
import { describe, it, expect } from 'vitest';
import { createActor } from '../src/sim/spatial/actor';
import { createBuilding } from '../src/sim/spatial/rooms';
import { canTraverse } from '../src/sim/nav/graph';
import { takeLink } from '../src/sim/nav/movement';

describe('上下楼与连接', () => {
  it('走楼梯消耗体力但不失败', () => {
    const graph = createBuilding();
    const stair = graph.links.find((l) => l.kind === 'stair')!;
    const actor = createActor();
    const before = actor.stamina;
    expect(takeLink(actor, stair)).toBe(true);
    expect(actor.stamina).toBeLessThan(before);
  });

  it('负重过高时梯子拒绝通过', () => {
    const graph = createBuilding();
    const ladder = graph.links.find((l) => l.kind === 'ladder')!;
    const actor = createActor();
    actor.load = 0.9;
    expect(canTraverse(ladder, actor)).toBe(false);
    expect(takeLink(actor, ladder)).toBe(false);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/nav-movement.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 movement.ts**

```ts
// src/sim/nav/movement.ts
import { clamp01 } from '../spatial/fields';
import type { ActorState } from '../spatial/actor';
import type { RoomLink } from '../spatial/rooms';
import { canTraverse } from './graph';

/** 进入一条连接；返回是否成功。楼梯/梯子按连接耗时扣体力。 */
export function takeLink(actor: ActorState, link: RoomLink): boolean {
  if (!canTraverse(link, actor)) return false;
  if (link.kind === 'stair' || link.kind === 'ladder') {
    actor.stamina = clamp01(actor.stamina - link.time * 0.012 * (1 + actor.load));
  }
  if (link.kind === 'breach' || link.kind === 'window') {
    actor.stamina = clamp01(actor.stamina - link.time * 0.02);
  }
  return true;
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/nav-movement.test.ts`
Expected: 2 passed。

- [ ] **Step 5: 提交**

```bash
git add src/sim/nav/movement.ts tests/nav-movement.test.ts
git commit -m "feat(mvs): vertical traversal cost"
```

---

### Task B4: 建筑相机数据

**Files:**
- Create: `src/render/buildingCam.ts`
- Create: `tests/building-camera.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/building-camera.test.ts
import { describe, it, expect } from 'vitest';
import { shotFor } from '../src/render/buildingCam';

describe('建筑切镜', () => {
  it('不同房间的机位不同', () => {
    const a = shotFor('room-202-F1', 1, 0);
    const b = shotFor('room-201-F1', 1, 0);
    expect(a.position.join(',')).not.toBe(b.position.join(','));
  });

  it('烟越浓，机位越贴近、越压低', () => {
    const clear = shotFor('room-202-F1', 1, 0);
    const smoky = shotFor('room-202-F1', 1, 0.9);
    expect(smoky.zoom).toBeGreaterThan(clear.zoom);
    expect(smoky.position[1]).toBeLessThan(clear.position[1]);
  });

  it('同一输入结果稳定', () => {
    expect(shotFor('room-202-F1', 1, 0.4)).toEqual(shotFor('room-202-F1', 1, 0.4));
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/building-camera.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 buildingCam.ts**

```ts
// src/render/buildingCam.ts
export interface BuildingShot {
  roomId: string;
  position: [number, number, number];
  target: [number, number, number];
  zoom: number;
}

export function shotFor(roomId: string, floor: number, smoke: number): BuildingShot {
  const seed = roomId
    .split('')
    .reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  const offset = ((seed % 7) - 3) * 0.25;
  const closeness = 1 + smoke * 0.8;

  return {
    roomId,
    position: [offset, 4.2 + floor * 3 - smoke * 1.4, 7.5 / closeness],
    target: [0, floor * 3 + 1.2, 0],
    zoom: 1 + smoke * 0.5,
  };
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/building-camera.test.ts`
Expected: 3 passed。

- [ ] **Step 5: 提交**

```bash
git add src/render/buildingCam.ts tests/building-camera.test.ts
git commit -m "feat(mvs): deterministic building camera shots"
```

---

### Task B5–B6: 建筑场景整合与教学关并存（B1–B4 合并后展开）

**B5 交付物：**
- `src/render/buildingView.ts`：按 `BuildingGraph` 渲染 3 层剖视、房间地面着色（火/烟/热）、门/窗/楼梯/消防梯连接。
- `src/buildingMain.ts` + `building.html`：从 `entrance` 出生，WASD 移动，靠近连接按空格切换房间；HUD 显示当前路线、暴露、体力、负重。
- `src/sim/spatial/scene.ts`：`ScenarioDefinition` 与 `ScenarioSnapshot`，先实现一个固定布局、1 名居民、1 个火源的场景。
- 验收测试 `tests/building-scenario.test.ts`：
  - 从入口出发，三条路线都能到达 `room-202-F1`。
  - 三条路线的 `time/risk` 两两不同。
  - 楼梯坍塌后，至少一条非楼梯路线仍可达。
  - 同一场景推进 60 秒，房间火/烟值确定。

**B6 交付物：**
- `src/app/scenarioSelect.ts`：URL 参数 `?scenario=tutorial|building|room`，默认 `tutorial` 保持旧切片。
- `index.html` 的入口按钮增加「建筑沙盒（实验）」。
- 验收测试 `tests/scenario-select.test.ts`：
  - 未知参数回退 `tutorial`。
  - `building` 返回建筑入口配置。
  - 旧切片入口不被删除。

**状态：** B5/B6 已按上述粒度完成并合入（见本节状态表）。建筑切片使用 Canvas2D 视图，
路线选择、每段行程结算与背人撤离已在浏览器验证。

---

## 9. Phase 2–5 规格与任务地图

> 以下阶段在进入前展开为可执行计划；这里锁定文件、接口、必须存在的测试与验收，避免实现时漂移。

### Phase 2 — 工具与多解矩阵

**执行状态（2026-11-23）：Phase 2 核心已完成。**

| 任务 | 状态 | 提交 |
| --- | --- | --- |
| P2.1 工具资源模型 | 完成 | `0a99975`、`f3f04b0` |
| P2.2/P2.3 多解矩阵与特殊工具 | 完成 | `ab99575`、`a4b949f` |
| P2.4 工具轮盘 | 完成 | `81bc9d0`、`902b265` |

已落地：17 个动词（门 4 / 窗 3 / 墙 3 / 火 5 / 居民 3）、携带工具重量与装备、
按次消耗与余量判断、热像扫描、排烟、破拆、旧工具面板替换为轮盘。
梯子/绳已建模，但路线接入留到后续阶段。

**新文件：**
- `src/sim/interaction/tools.ts`：`ToolId = 'hose' | 'extinguisher' | 'axe' | 'fan' | 'thermal' | 'ladder' | 'rope'`
- `src/sim/interaction/multiSolution.ts`：`Obstacle = 'door' | 'window' | 'wall' | 'fire' | 'occupant'`，`verbsFor(obstacle): Verb[]`
- `src/ui/toolWheel.ts`：上下文动词轮盘（不阻塞移动）
- `tests/tool-matrix.test.ts`、`tests/tool-resources.test.ts`

**必须存在的测试：**
1. `每个障碍至少三种有效动词`：对 `door/window/wall/fire/occupant`，`verbsFor` 返回 ≥3 项，且每项在测试场景中产生可测状态变化。
2. `水带资源耗尽后拒绝喷水`：`hose.tank` 从 >0 降到 0，`spray` 返回 `outOfAgent=true`。
3. `灭火器当量与火类匹配`：同当量下，干粉灭 B 类比水有效；水灭 B 类 `hazard>0`。
4. `排烟机改变烟流向`：对准窗口使用后，窗口附近 `smoke` 下降、下风向房间 `smoke` 上升。
5. `热像仪揭示门后热区`：未使用时 `measure` 只给门温；使用后返回门后格子的 `heat` 与 `fuelRich`。
6. `破拆斧改变结构`：对墙使用后 `structure` 下降，达到阈值后生成 `breach` 连接。

**验收：** 解法矩阵测试全绿；每个动词有 `lesson`；UI 轮盘不打断移动。

### Phase 3 — 居民与压力

**执行状态（2026-11-23）：核心完成。**

| 任务 | 状态 | 提交 |
| --- | --- | --- |
| P3.1 居民 Agent | 完成 | `2a46490` |
| P3.2 多人救援 | 完成 | `f45cf83` |
| P3.3 入口接入与居民视图 | 完成 | `e17262a` |
| P3.4 文档与门禁 | 完成 | 本文档提交 |

**新文件：**
- `src/sim/agents/resident.ts`：`ResidentState`（mood/panic/hidden/health/injury/downedFor/dead），`stepResident(resident, room, dt)`
- `src/sim/agents/crowd.ts`：`CrowdState`、救援优先级、牵/背、种子确定性、获救/失去统计
- `src/render/residents.ts`：居民状态 → 标记（纯数据，不碰 DOM）
- `tests/resident.test.ts`、`tests/crowd.test.ts`、`tests/resident-markers.test.ts`

**必须存在的测试（已全部落地）：**
1. `恐慌居民会远离烟`：初始靠近火源，10 秒后与火源距离增大。
2. `躲藏居民只在搜索半径内被发现`：距离 >2 m 时不可交互，靠近后可见。
3. `失去意识后只能背`：`mood='unconscious'` 或 `health<=0` 时 `lead` 失败、`carry` 成功。
4. `伤情随时间恶化`：烟/热暴露下 `health` 单调下降；归零后 3 秒宽限期结束即死亡。
5. `救援顺序改变结果`：同种子、3 名居民，先救 A 与先救 B 产生不同的获救人数（0–3）。
6. `失败由系统产生`：烟毒/热致死与玩家倒地均由模拟状态触发，不依赖对话分支。

**入口接入说明：**
- `building.html` 的 202 房间放置 3 名居民，抵达后通过居民面板选择“牵”或“背”；每次救援消耗 4/5 秒，期间火场与其余居民继续演化。
- 建筑入口按消防员佩戴空呼处理（`ActorState.masked`）：烟热仍累积，但足以支撑多次进出；居民没有保护，因此救援顺序与时间直接决定 0–3 的结果。
- 入口按“同处一室即可施救”处理（`ROOM_REACH`），室内逐米位移与躲藏搜索留到后续阶段。

**验收：** 同一次火场能救出 0–3 人，差异来自行动而非剧本。

### Phase 4 — 沙盒事件与复盘

**执行状态（2026-11-23）：核心完成。**

| 任务 | 状态 | 提交 |
| --- | --- | --- |
| P4.1 事件导演 | 完成 | `bc829e9` |
| P4.2 种子回放 | 完成 | `5accf89` |
| P4.3 因果复盘 | 完成 | `ce9c346` |
| P4.4 入口接入 | 完成 | `f5a8968` |
| P4.5 文档与门禁 | 完成 | 本文档提交 |

**新文件：**
- `src/sim/events/director.ts`：风、窗失效、楼梯/楼板坍塌
- `src/sim/replay.ts`：种子 + 输入日志 → 快照序列
- `src/eval/causal.ts`：动作 → 因果解释
- `tests/replay.test.ts`、`tests/director.test.ts`、`tests/causal.test.ts`

**必须存在的测试（已全部落地）：**
1. `同种子同输入回放完全一致`：两次运行的 cell fire 序列哈希相同。
2. `同种子不同输入产生不同演化`：哈希不同。
3. `坍塌条件`：结构 < 0.35 且热 > 0.6 持续 N 秒才坍塌，不是定时脚本。
4. `风向改变烟扩散`：改变风向后，下风向房间 `smoke` 增速上升。
5. `复盘能指到具体动作`：debrief 条目包含动作 id、时刻、场变化。

**入口接入说明：**
- 建筑入口按 15s/30s 的固定日程切风，HUD 显示方位与风速；风沿未坍塌的 door/window/breach 连接把烟从下风向搬走或搬入。
- 窗户温度超过阈值会高温失效（破窗形成通风口）；房间结构 < 0.35 且热 > 0.6 连续 6 秒即坍塌，封锁所有相邻连接并立刻刷新路线。
- 旅行与救援都会记录前后场快照；结算时取最近 6 条动作，显示时间、动作、房间与中文因果摘要。
- 暴露曲线对比与训练模式留到 Phase 5。

**验收：** 同种子不同打法产生不同火场演化与复盘结论。

### Phase 5 — 内容与打磨

**新文件：**
- `src/content/layouts/*.ts`：3–5 个户型
- `src/content/materials.ts`：材料表（可燃性、导热、强度、烟产率）
- `src/content/drills.ts`：测温、回燃、低姿、破拆演练
- `src/app/save.ts`：存档/中断续玩
- `tests/content.test.ts`、`tests/performance.test.ts`、`tests/save.test.ts`

**必须存在的测试：**
1. `每种户型都能生成合法房间图`：连接两端存在、无孤立房间。
2. `材料表覆盖所有 FireClass`：每个火类至少一种材料。
3. `演练关有明确成功条件`：测温/回燃/低姿各一个可测条件。
4. `单房间 stepRoom 在 8×8 下 < 1ms`：跑 1000 步取平均。
5. `存档可恢复`：序列化 → 反序列化 → 继续推进 10 秒结果一致。
6. `门禁全绿`：`npm run check`、`npm run verify`。

**验收：** 一局 5–8 分钟，桌面稳定 60fps，移动端降级可玩。

---

## 10. 质量门禁与预算

### 每任务必跑

```bash
cd /workspace/golden-hour/mvs
npx vitest run tests/<本任务测试>.ts
npx tsc --noEmit
```

### 每里程碑必跑

```bash
cd /workspace/golden-hour/mvs
npm run check          # tsc + 全部 vitest + build + 包体
npm run verify         # 视觉 + 音频（改渲染/音频时）
```

### 预算策略

| 项 | 预算 | 说明 |
| --- | --- | --- |
| main 入口 | 60 KB gzip | 旧教学关，保持可运行 |
| room 入口 | 80 KB gzip | 单房间切片 |
| building 入口 | 90 KB gzip | 建筑沙盒（Phase 1 起） |
| rescue 共享 chunk | 30 KB gzip | 救援模块，供多个入口复用 |
| modulepreload 辅助 | 8 KB gzip | Vite 预加载垫片 |
| three.module | 170 KB gzip | 共享 vendor，单独记账 |
| JS 总计 | 340 KB gzip | 超出即失败 |
| 3D 资产 | 2.6 MB | 现有预算不变 |

**原则：** 新入口必须动态加载（`import()`），不得把所有场景打进入口 chunk；共享 Three 单独成 vendor chunk。

---

## 11. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 包体持续膨胀 | 门禁失败、首屏变慢 | 按入口预算；动态 import；Three 单独 chunk；场景数据外置 |
| 模拟与渲染耦合 | 无法确定性测试 | `src/sim/**` 禁止 Three/DOM；渲染只读快照 |
| 涌现结果不可控 | 难复现、难测试 | 固定步长 + 种子 + 输入日志；回放哈希测试 |
| 单房间规则无法扩建筑 | Phase 1 返工 | 房间图只组合 `RoomState`，不复制火灾逻辑 |
| 专业内容变成说明文字 | 失去教育价值 | 每个知识点必须绑定可测场变化与 `lesson` |
| 旧切片被破坏 | 失去可回退基线 | 独立入口 + URL 参数；Phase 5 前不删 |
| 性能不足 | 移动端卡顿 | 8×8 场、10 Hz、Worker（必要时）、按需渲染 |

---

## 12. 自检（写完计划后执行）

**1. 规格覆盖**

| 规格项 | 对应任务 |
| --- | --- |
| 蒸汽与能见度 | A2 |
| 玩家姿态/负重/体力/暴露 | A3、A5 |
| 被困者背负与撤离 | A4、A5 |
| 包体可持续 | A6 |
| 房间图与建筑 | B1 |
| 三条自由路线 | B2 |
| 上下楼与负重限制 | B3 |
| 房间切镜 | B4 |
| 建筑场景与旧切片并存 | B5–B6 |
| 工具多解矩阵 | Phase 2 |
| 居民与 0–3 人结果 | Phase 3 |
| 种子回放与因果复盘 | Phase 4 |
| 内容/性能/存档 | Phase 5 |

**2. 占位符扫描**

- Milestone A 每个代码步骤都有完整实现；无 TBD/TODO。
- Milestone B5–B6 明确标注「B1–B4 合并后展开」，不属于可执行步骤，避免伪造未建系统的代码。
- Phase 2–5 使用「必须存在的测试」而非空泛描述。

**3. 类型一致性**

- `RoomState`、`Cell`、`Opening`、`ToolState` 沿用现有字段；新增 `steam` 同步更新 `emptyCell` 与 `roomSummary`。
- `ActorState` 在 A3 定义，A5/B2/B3 使用同一字段名 `x/z/stance/load/stamina/exposure/downed`。
- `OccupantState` 在 A4 定义，A5 使用 `carried/rescued/health/mood`。
- `RoomLink` 在 B1 定义，B2/B3 使用 `kind/time/risk/blocked`。
- `Route` 在 B2 定义，B5 使用 `steps/time/risk/score`。

---

## 13. 执行方式

Milestone A 可直接按 Task A1 → A7 顺序执行，每个任务一次提交。
Milestone B 先做 B1 → B4，合并后再展开 B5/B6。
Phase 2–5 进入前，复制本文件的任务模板，为每个阶段新建 `docs/superpowers/plans/YYYY-MM-DD-phase-N.md`。
