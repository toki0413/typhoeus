# Golden Hour · 多房间多波居民内容扩展计划

> 状态：核心完成（2026-11-23）。默认启用 5 区 10 人，`?zones=single` 回退单区域。
> 目标：把单房间 20–60 秒的一局扩展为多区域、10 名居民的一局，同时保持模拟确定性、单房间玩法和现有质量门禁。
>
> **2026-11-23 扩区记录：** 初版 3 区 6 人 → 4 区 8 人 → 5 区 10 人。
> 第五区域：classic 205 儿童房、narrow 205 儿童房、courtyard 205 儿童房、duplex 205-F2 儿童房，
> 每区 2 人、无火；总人数 10 人，存档/最佳记录键改为 `multi5` 以避免与旧记录混用。
> 最优路径模拟：10/10 救出，耗时 93.5 秒，空呼耗尽；真人操作会更长。

## 执行状态

| 任务 | 状态 | 提交 |
| --- | --- | --- |
| Z1 区域内容与户型扩展 | 完成 | `68f1e50` |
| Z2 多区域场景 | 完成 | `06d3bd8` |
| Z3 跨房间烟流 | 完成 | `b36751a` |
| Z4 多人群与区域目标 | 完成 | `8941fab` |
| Z5 入口接入与存档 v2 | 完成 | `acf91bb` |
| Z6 区域叙事与复盘标签 | 完成 | `b64440a` |
| Z7 性能、节奏与文档 | 完成 | 本文档提交 |

**实测：**
- 382 项测试增至 432 项（含区域、串烟、多人群、v2 存档、多区域性能）。
- 最优路径模拟：classic 5 区 10 人全部救出，模拟耗时 93.5 秒，空呼耗尽。
- 多区域单步（火场 + 串烟 + 多支人群 + 导演）1000 次平均低于 2ms。
- `npm run check`、`npm run verify` 全绿；JS 总计约 217/340 KB。
- 真人一局时长仍需试玩确认；模拟最短 93.5 秒，实际阅读、搜索、工具与操作会显著拉长。

---

## 0. 已锁定决策

| 决策 | 选择 |
| --- | --- |
| 规模 | 5 个救援区域，每区 2 名居民，共 10 人（初版 3 区 6 人） |
| 波次 | 全部居民开局存在，靠区域顺序、躲藏、烟流形成波次；不做定时刷怪 |
| 撤离 | 保持原地救出（沿用 `rescueResident` 原子动作），不做背回入口 |
| 上线方式 | 先以 `?zones=multi` 特性开关并存，验收后切为默认，保留 `?zones=single` 回退 |

---

## 1. 目标与非目标

**目标**
- 每局至少 3 个可进入的救援区域，区域之间通过门、窗、楼梯、破墙连接。
- 每个区域 2 名居民，至少 1 名躲藏；居民行为、健康、死亡仍由 `resident.ts` / `crowd.ts` 驱动。
- 火与烟至少影响两个区域：主火区起火，烟通过未坍塌连接进入其他区域。
- 完成一个区域后自动切换下一个目标区域，路线、居民面板、工具目标同步切换。
- 一局实测落在 5–8 分钟；同种子同操作可回放。

**非目标**
- 不做完整 CFD，不做跨房间火焰直接跳跃。
- 不做定时/剧本刷怪；不做背人返程。
- 不加新依赖，不引入战斗/耐久度。

---

## 2. 现状与缺口

| 现状 | 缺口 |
| --- | --- |
| `LayoutDefinition` 只有 1 个 `target` | 没有区域列表与每区居民定义 |
| `createScenarioForBuilding` 只点燃一个房间 | 需要多区域初始火与“无火但有居民”的区域 |
| `CrowdState` 单实例 | 需要按房间管理多支人群 |
| 烟只在房间内扩散 | 需要沿连接做房间间烟流 |
| `buildingMain` 固定 `def.targetRoom` | 需要动态目标与区域完成判定 |
| 存档只有单个 `crowd` | 需要多人群存档与旧格式迁移 |
| 评分总数固定 3 | 总数变为 6，并增加区域完成原因 |

关键文件：
- [layouts.ts](../../../mvs/src/content/layouts.ts)
- [scene.ts](../../../mvs/src/sim/spatial/scene.ts)
- [crowd.ts](../../../mvs/src/sim/agents/crowd.ts)
- [buildingMain.ts](../../../mvs/src/buildingMain.ts)
- [save.ts](../../../mvs/src/app/save.ts)
- [score.ts](../../../mvs/src/eval/score.ts)

---

## 3. 数据契约

### 3.1 区域与居民（新 `src/content/zones.ts`）

```ts
import type { FireClass } from '../sim/spatial/fields';

export interface ResidentSpec {
  id: string;
  /** 网格坐标；0..7 */
  x: number;
  y: number;
  health: number;
  panic: number;
  hidden: boolean;
}

export interface ZoneSpec {
  roomId: string;
  label: string;
  fireClass: FireClass;
  /** 为空表示该区域不初始起火，只承受串烟 */
  fire?: {
    cells: [number, number][];
    intensity: number;
  };
  residents: ResidentSpec[];
}

export function zone(spec: ZoneSpec): ZoneSpec;
```

### 3.2 场景（扩展 `scene.ts`）

```ts
export interface ZoneScenario extends ScenarioDefinition {
  zones: ZoneSpec[];
}

export function createZoneScenario(
  building: BuildingGraph,
  startRoom: string,
  zones: ZoneSpec[],
  id: string,
  seed: number
): ZoneScenario;
```

规则：
- 所有房间先 `quietRoom`。
- 只对 `zone.fire` 存在的区域写入燃料、火、热与 `fireClass`。
- `targetRoom` 保持为 `zones[0].roomId`，兼容旧入口；`zones` 为新字段。

### 3.3 多人群（新 `src/sim/agents/household.ts`）

```ts
export interface HouseholdState {
  zones: ZoneSpec[];
  crowds: Record<string, CrowdState>;
  /** 当前救援区域；null 表示全部结束 */
  activeRoomId: string | null;
  events: { at: number; roomId: string; kind: 'zone-done'; detail: string }[];
}

export function createHousehold(zones: ZoneSpec[], seed: number): HouseholdState;
export function stepHousehold(household: HouseholdState, graph: BuildingGraph, dt: number): void;
export function householdSummary(household: HouseholdState): {
  rescued: number;
  lost: number;
  total: number;
  done: number;
};
export function refreshActiveZone(household: HouseholdState): void;
```

- `stepHousehold` 对每个房间使用该房间的 `RoomState` 推进对应 Crowd，互不串用。
- 某区域 `rescued + lost >= residents.length` 时标记完成，日志 `zone-done`，并 `refreshActiveZone`。
- `refreshActiveZone` 选择第一个未完成区域；若全部完成则 `null`。

### 3.4 目标规划（新 `src/app/zonePlan.ts`，纯函数）

```ts
export type ZoneStatus = 'pending' | 'active' | 'done';

export function zoneStatuses(household: HouseholdState): Record<string, ZoneStatus>;
export function nextZoneId(household: HouseholdState): string | null;
export function zoneLabel(household: HouseholdState, roomId: string): string;
```

入口只消费这些纯函数，便于单测。

---

## 4. 系统设计

### 4.1 跨房间烟流（新 `src/sim/spatial/ventilation.ts`）

```ts
export const LINK_SMOKE_RATE = { door: 0.28, window: 0.5, breach: 0.18 };
export const CLOSED_SEEP = 0.06;

export function stepLinkSmoke(graph: BuildingGraph, dt: number, wind?: Wind): void;
```

- 只处理未坍塌且 `kind` 为 `door | window | breach` 的连接。
- 从平均烟高的房间流向低烟房间，`amount = diff * min(0.5, rate * openness * windBoost * dt)`。
- `openness`：对应开口 open/broken 为 1，关闭时 `CLOSED_SEEP`（缓慢渗烟）。
- `windBoost = 1 + max(0, wind·dir) * 0.8`，风向只加速、不逆转方向。
- 下风房间每格加 `amount`，上风房间每格减 `amount * 0.5`，clamp01。
- 不处理 stair/ladder，避免烟垂直瞬移；垂直串烟留给后续竖井模型。

### 4.2 场景推进顺序

```
stepScenario -> stepLinkSmoke -> stepHousehold -> stepDirector -> 采样/无线电
```

- 烟流在火灾场之后、导演之前，保证风与坍塌基于当前烟量。
- 单区域模式（`?zones=single`）跳过 `stepLinkSmoke` 与多 Crowd。

### 4.3 入口多区域流程

1. 解析 `?zones=multi`，从 `layout.zones` 创建 `createZoneScenario` 与 `createHousehold`。
2. `targetRoom()` 改为 `household.activeRoomId ?? def.zones[0].roomId`。
3. 路线只指向当前区域；到达后显示该区域居民与工具目标。
4. 区域完成时 `refreshActiveZone`，日志“201 已处理完，前往 203”，`recalcRoutes()`。
5. 所有区域完成或玩家倒地才结算。
6. 玩家移动只在当前区域生效；标记显示所有区域（隐藏者靠近才发现）。

### 4.4 内容分布（5 区域 / 10 人）

| 户型 | 主火区 | 烟侵区 A | 烟侵区 B | 第四区 | 第五区 | 新增内容 |
| --- | --- | --- | --- | --- | --- | --- |
| classic | 202 客厅（A） | 201 卧室 | 203 厨房 | 204 书房 | 205 儿童房 | 新增 201/203/204/205 房间 |
| narrow | 202 厨房（F） | 201 卧室 | 203 储物间 | 204 卧室 | 205 儿童房 | 新增 201/203/204/205 房间 |
| courtyard | 202 车库（B） | 201 住户 | 203 阁楼 | 204 储藏间 | 205 儿童房 | 新增 201/203/204/205 房间 |
| duplex | 202-F2 配电（E） | 202-F1 客厅 | garden-F1 | 203-F2 书房 | 205-F2 儿童房 | 复用现有 + 2 间新房间 |

每区 2 人：1 名可见、1 名躲藏；主火区居民血线略高，烟侵区更健康但路线更远。

---

## 5. UI / 叙事

- HUD：`救出 3/10 · 区域 2/5`，保留用时、空呼、风向。
- 区域条：5 个 chip，状态 `待救 / 进行 / 完成`，当前高亮；仅展示、不可点击跳关。
- 居民面板与工具面板只服务当前区域。
- 无线电：进入区域、区域完成、串烟到新区域各一条；不复用旧剧本。
- 复盘：条目增加 `zoneLabel`，例如“35.2s 背出 201-B”。

---

## 6. 存档、评分、回放

- `SaveInput` 增加 `households?: HouseholdState`，保留旧 `crowd`：
  - `SAVE_VERSION = 2`；
  - 读到 v1 且只有 `crowd` 时，迁移为单区域 `households`；
  - 测试覆盖 v1→v2 迁移。
- 评分：
  - `total = 10`，`rescued/total` 自动适配；
  - 增加原因“完成 x/5 区域”；
  - 错剂、暴露、用时惩罚保持不变。
- 最佳记录与幽灵曲线：聚合全部区域暴露，键仍为 `户型 + 种子`。
- 回放：`ReplayFrame` 增加可选 `zones` 聚合字段；哈希覆盖全部房间，保证同种子同输入一致。

---

## 7. 任务拆分（每步独立验收）

### Z1 区域内容与户型扩展

- [x] 新建 `src/content/zones.ts`
- [x] `LayoutDefinition` 增加 `zones: ZoneSpec[]`
- [x] classic 增加 201/203 房间与连接；courtyard 增加 201；duplex 复用现有房间
- [x] 测试 `tests/layout-zones.test.ts`：每户型 5 区域、每区 2 人、房间存在且可达
- [x] 验证：`npx vitest run tests/layout-zones.test.ts` + `tsc`

### Z2 多区域场景

- [x] `scene.ts` 新增 `createZoneScenario`
- [x] 测试 `tests/zone-scenario.test.ts`：只有声明 fire 的区域起火；非火区火=0；目标房间=zones[0]
- [x] 验证：场景推进 10 秒后火不跨房间跳跃

### Z3 跨房间烟流

- [x] 新建 `src/sim/spatial/ventilation.ts`
- [x] 测试 `tests/link-smoke.test.ts`：开门后低烟房间烟上升；关闭只缓慢渗透；坍塌链接停止；风向加速
- [x] 验证：3 个房间循环 1000 步 < 1ms

### Z4 多人群与目标规划

- [x] 新建 `src/sim/agents/household.ts`
- [x] 新建 `src/app/zonePlan.ts`
- [x] 测试 `tests/household.test.ts`：每支 Crowd 只推进自己房间；区域完成后切换；聚合统计正确
- [x] 测试 `tests/zone-plan.test.ts`：状态与下一区域选择确定性

### Z5 建筑入口接入

- [x] `buildingMain` 支持 `?zones=multi`，多 Crowd、动态目标、区域日志
- [x] 工具、移动、居民面板、标记切换到当前区域
- [x] 存档/评分/幽灵适配
- [x] 浏览器验证：4 区域切换、串烟、完成结算、无 error

### Z6 叙事与复盘

- [x] 区域相关无线电 3–5 条
- [x] 复盘条目带区域标签
- [x] 结算显示 `救出 x/10` 与区域完成数

### Z7 节奏与门禁

- [x] 编写最优路径模拟脚本，记录 5 区域 10 人的模拟耗时与真人操作预算
- [x] 调参：5 区 10 人模拟最短 93.5 秒（空呼耗尽）；真人 5–8 分钟目标继续试玩微调
- [x] `npm run check`、`npm run verify`、`?perf=1` 60fps
- [x] 更新 ROADMAP/长期计划与本文档状态

---

## 8. 验收标准

1. 每个户型 5 个救援区域，共 10 名居民。
2. 同一次火场可救出 0–10 人，结果差异来自区域顺序、搜索、工具与时间。
3. 烟能通过未坍塌连接进入相邻区域；坍塌/关门能阻断或减缓。
4. 区域完成后路线目标自动切换；不可达区域有明确提示。
5. 存档/继续恢复全部区域与居民状态；v1 存档可迁移。
6. 模拟最短 93.5 秒（空呼耗尽）；真人 5–8 分钟目标继续试玩确认；`?perf=1` 稳定 60fps。
7. `npm run check` 与 `npm run verify` 全绿。

---

## 9. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 内容量导致实现膨胀 | 固定 5 区域 10 人；特性开关并存 |
| 串烟不真实或过强 | 链接级流量 + 关闭渗透系数；测试上限与阻断 |
| 入口状态机复杂 | 新逻辑放 `household.ts` / `zonePlan.ts` 纯函数，入口只渲染 |
| 存档不兼容 | 版本 2 + v1 迁移测试 |
| 时长仍不达标 | 先测模拟耗时，再调转移时间/居民位置/烟流；不靠定时刷怪 |
| 旧单区域体验退化 | `?zones=single` 保留，验收后再切默认 |
