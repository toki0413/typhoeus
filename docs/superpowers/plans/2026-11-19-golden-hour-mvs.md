# 《黄金时间》MVS 实施计划（第二章 · 回燃门）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做出一个 10–12 分钟可玩的最小切片：一栋两层老楼、一名班组、一次回燃门判断，以及一张可导出的复盘卡。

**Architecture:** 确定性模拟（20Hz 固定步长）与 Three.js 渲染严格分离。模拟层不依赖 DOM，可单测；渲染层只读状态。场景静态几何合并为单一网格，控制在 draw call 预算内。

**Tech Stack:** TypeScript、Vite、Three.js、Vitest。

---

## 文件结构

```
golden-hour/mvs/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── index.html
├── src/
│   ├── main.ts
│   ├── sim/
│   │   ├── rng.ts
│   │   ├── types.ts
│   │   ├── world.ts
│   │   ├── smoke.ts
│   │   ├── step.ts
│   │   └── door.ts
│   ├── eval/
│   │   └── debrief.ts
│   ├── render/
│   │   ├── scene.ts
│   │   ├── agents.ts
│   │   └── smoke.ts
│   └── ui/
│       ├── hud.ts
│       ├── door.ts
│       └── debrief.ts
└── tests/
    ├── rng.test.ts
    ├── smoke.test.ts
    ├── door.test.ts
    ├── debrief.test.ts
    ├── determinism.test.ts
    └── geometry.test.ts
```

---

## Task 1: 项目脚手架与确定性随机数

**Files:**
- Create: `golden-hour/mvs/package.json`
- Create: `golden-hour/mvs/tsconfig.json`
- Create: `golden-hour/mvs/vite.config.ts`
- Create: `golden-hour/mvs/index.html`
- Create: `golden-hour/mvs/src/sim/rng.ts`
- Create: `golden-hour/mvs/tests/rng.test.ts`

- [ ] **Step 1: 写 package.json**

```json
{
  "name": "golden-hour-mvs",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite --host 0.0.0.0 --port 5174",
    "build": "tsc --noEmit && vite build",
    "test": "vitest run",
    "preview": "vite preview --host 0.0.0.0 --port 4174"
  },
  "dependencies": {
    "three": "^0.170.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vite": "^5.4.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: 写 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "lib": ["ES2022", "DOM"],
    "types": ["vitest/globals"]
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: 写 vite.config.ts**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  build: { target: 'es2022' },
  test: { environment: 'node' },
});
```

- [ ] **Step 4: 写 index.html**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>黄金时间 · MVS</title>
    <style>
      html, body { margin: 0; height: 100%; background: #0d0f12; overflow: hidden; }
      #app { display: block; width: 100vw; height: 100vh; }
      .panel {
        position: fixed; background: rgba(15,18,22,.82); color: #e8e6e1;
        border: 1px solid rgba(255,255,255,.14); padding: 10px 12px;
        font: 12px/1.6 ui-monospace, "Noto Sans Mono CJK SC", monospace;
      }
      #hud { top: 16px; left: 16px; }
      #door-ui { left: 50%; bottom: 32px; transform: translateX(-50%); display: none; }
      #debrief { inset: 0; display: none; overflow: auto; padding: 40px; }
      button { font: inherit; margin-right: 8px; padding: 6px 10px; }
    </style>
  </head>
  <body>
    <canvas id="app"></canvas>
    <div id="hud" class="panel"></div>
    <div id="door-ui" class="panel"></div>
    <div id="debrief" class="panel"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 5: 写失败测试 tests/rng.test.ts**

```ts
import { describe, it, expect } from 'vitest';
import { mulberry32 } from '../src/sim/rng';

describe('mulberry32', () => {
  it('同一种子产生同一序列', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('结果落在 [0, 1)', () => {
    const r = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
```

- [ ] **Step 6: 安装依赖并跑测试，确认失败**

Run: `cd golden-hour/mvs && npm install && npm test`
Expected: FAIL，提示找不到 `../src/sim/rng`。

- [ ] **Step 7: 实现 src/sim/rng.ts**

```ts
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
```

- [ ] **Step 8: 跑测试，确认通过**

Run: `cd golden-hour/mvs && npm test`
Expected: PASS，2 个测试通过。

- [ ] **Step 9: 提交**

```bash
git add golden-hour/mvs
git commit -m "feat(mvs): scaffold project and deterministic rng"
```

---

## Task 2: 模拟状态与初始世界

**Files:**
- Create: `golden-hour/mvs/src/sim/types.ts`
- Create: `golden-hour/mvs/src/sim/world.ts`
- Test: `golden-hour/mvs/tests/world.test.ts`

- [ ] **Step 1: 写失败测试 tests/world.test.ts**

```ts
import { describe, it, expect } from 'vitest';
import { createWorld } from '../src/sim/world';

describe('createWorld', () => {
  it('初始状态满足基本不变量', () => {
    const s = createWorld('GH-FIRE-MVS');
    expect(s.seed).toBe('GH-FIRE-MVS');
    expect(s.smoke).toHaveLength(2);
    expect(s.smoke.every((v) => v >= 0 && v <= 1)).toBe(true);
    expect(s.victim.alive).toBe(true);
    expect(s.door.checked).toBe(false);
    expect(s.phase).toBe('plan');
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `cd golden-hour/mvs && npx vitest run tests/world.test.ts`
Expected: FAIL，找不到 `../src/sim/world`。

- [ ] **Step 3: 实现 src/sim/types.ts**

```ts
export type Phase = 'plan' | 'execute' | 'debrief';

export type Order =
  | { kind: 'search'; floor: number }
  | { kind: 'suppress'; floor: number }
  | { kind: 'rescue'; floor: number };

export type EventType = 'evidence' | 'omission' | 'rescue' | 'death' | 'injury';

export interface SimEvent {
  at: number;
  type: EventType;
  anchorId?: string;
  detail?: string;
}

export interface DoorState {
  checked: boolean;
  temp: 'unknown' | 'hot';
  waitUntil: number | null;
  safe: boolean;
  opened: boolean;
}

export interface SimState {
  seed: string;
  t: number;
  phase: Phase;
  fire: number;
  smoke: number[];
  heat: number[];
  exposure: { smoke: number; heat: number; strain: number };
  crew: { floor: number; progress: number; order: Order | null; atDoor: boolean };
  door: DoorState;
  victim: { alive: boolean; rescued: boolean };
  resources: { extinguisher: number; rope: number; kit: number };
  events: SimEvent[];
}
```

- [ ] **Step 4: 实现 src/sim/world.ts**

```ts
import type { SimState } from './types';

export function createWorld(seed: string): SimState {
  return {
    seed,
    t: 0,
    phase: 'plan',
    fire: 0.12,
    smoke: [0, 0],
    heat: [0, 0],
    exposure: { smoke: 0, heat: 0, strain: 0 },
    crew: { floor: 0, progress: 0, order: null, atDoor: false },
    door: { checked: false, temp: 'unknown', waitUntil: null, safe: false, opened: false },
    victim: { alive: true, rescued: false },
    resources: { extinguisher: 2, rope: 1, kit: 1 },
    events: [],
  };
}
```

- [ ] **Step 5: 跑测试，确认通过**

Run: `cd golden-hour/mvs && npx vitest run tests/world.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add golden-hour/mvs/src/sim golden-hour/mvs/tests/world.test.ts
git commit -m "feat(mvs): add sim state and initial world"
```

---

## Task 3: 烟气与暴露

**Files:**
- Create: `golden-hour/mvs/src/sim/smoke.ts`
- Create: `golden-hour/mvs/src/sim/step.ts`
- Test: `golden-hour/mvs/tests/smoke.test.ts`

- [ ] **Step 1: 写失败测试 tests/smoke.test.ts**

```ts
import { describe, it, expect } from 'vitest';
import { stepSmoke } from '../src/sim/smoke';
import { createWorld } from '../src/sim/world';
import { stepSim } from '../src/sim/step';

const advance = (s: ReturnType<typeof createWorld>, sec: number) => {
  for (let i = 0; i < sec * 20; i++) stepSim(s, 1 / 20);
};

describe('stepSmoke', () => {
  it('有火时一层烟气上升且不超过 1', () => {
    const smoke = [0, 0];
    for (let i = 0; i < 20 * 30; i++) stepSmoke(smoke, 0.8, 1 / 20);
    expect(smoke[0]).toBeGreaterThan(0.5);
    expect(smoke[1]).toBeGreaterThan(0);
    expect(smoke.every((v) => v <= 1)).toBe(true);
  });

  it('烟气会向上层传递', () => {
    const smoke = [0.9, 0];
    stepSmoke(smoke, 0, 1 / 20);
    expect(smoke[1]).toBeGreaterThan(0);
  });

  it('无火时烟气会衰减', () => {
    const smoke = [0.8, 0.8];
    stepSmoke(smoke, 0, 1 / 20);
    expect(smoke[0]).toBeLessThan(0.8);
    expect(smoke[1]).toBeLessThan(0.8);
  });
});

describe('stepSim', () => {
  it('暴露值随停留时间上升且不超过 1', () => {
    const s = createWorld('x');
    advance(s, 60);
    expect(s.exposure.smoke).toBeGreaterThan(0);
    expect(s.exposure.smoke).toBeLessThanOrEqual(1);
    expect(s.t).toBeCloseTo(60, 1);
  });

  it('40 秒前火势不会封顶，之后加速', () => {
    const s = createWorld('x');
    advance(s, 40);
    expect(s.fire).toBeLessThan(0.95);
    const at40 = s.fire;
    advance(s, 5);
    expect(s.fire - at40).toBeGreaterThan(0.05);
  });

  it('班组到达一层门时 atDoor 为真', () => {
    const s = createWorld('x');
    s.crew.order = { kind: 'search', floor: 1 };
    advance(s, 10);
    expect(s.crew.floor).toBe(1);
    expect(s.crew.atDoor).toBe(true);
  });

  it('楼层越界不会产生 NaN 暴露值', () => {
    const s = createWorld('x');
    s.crew.order = { kind: 'search', floor: 5 };
    advance(s, 30);
    expect(s.crew.floor).toBeLessThanOrEqual(1);
    expect(Number.isFinite(s.exposure.smoke)).toBe(true);
  });

  it('门等待到期只写入一次证据', () => {
    const s = createWorld('x');
    s.door.checked = true;
    s.door.temp = 'hot';
    s.door.waitUntil = s.t + 1;
    advance(s, 2);
    s.door.waitUntil = s.t + 1;
    advance(s, 2);
    const count = s.events.filter((e) => e.anchorId === 'K-BACKDRAFT-WAIT').length;
    expect(count).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `cd golden-hour/mvs && npx vitest run tests/smoke.test.ts`
Expected: FAIL，找不到 `smoke.ts` / `step.ts`。

- [ ] **Step 3: 实现 src/sim/smoke.ts**

```ts
export const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export function stepSmoke(smoke: number[], fire: number, dt: number): void {
  smoke[0] = clamp01(smoke[0] + (fire * 0.3 - smoke[0] * 0.3) * dt);
  for (let i = 1; i < smoke.length; i++) {
    const inflow = smoke[i - 1] * 0.12;
    const outflow = smoke[i] * 0.2;
    smoke[i] = clamp01(smoke[i] + (inflow - outflow) * dt);
  }
}
```

- [ ] **Step 4: 实现 src/sim/step.ts**

```ts
import type { SimState } from './types';
import { clamp01, stepSmoke } from './smoke';

export function stepSim(s: SimState, dt: number): void {
  s.t += dt;

  const fireGrowth = s.t < 40 ? 0.012 : 0.02;
  s.fire = clamp01(s.fire + fireGrowth * dt);

  stepSmoke(s.smoke, s.fire, dt);

  for (let i = 0; i < s.smoke.length; i++) {
    const target = Math.max(0, s.fire - i * 0.13) * 0.85;
    s.heat[i] = clamp01(s.heat[i] + (target - s.heat[i]) * dt * 0.5);
  }

  if (s.crew.order) {
    const target = Math.min(s.crew.order.floor, s.smoke.length - 1);
    if (s.crew.floor < target) {
      s.crew.progress += dt * 0.2;
      if (s.crew.progress >= 1) {
        s.crew.progress -= 1;
        s.crew.floor += 1;
      }
    }
    s.crew.atDoor = s.crew.floor === 1 && target === 1;
  } else {
    s.crew.atDoor = false;
  }

  const f = Math.min(s.crew.floor, s.smoke.length - 1);
  s.exposure.smoke = clamp01(s.exposure.smoke + s.smoke[f] * 0.55 * dt);
  s.exposure.heat = clamp01(s.exposure.heat + s.heat[f] * 0.22 * dt);
  s.exposure.strain = clamp01(s.exposure.strain + 0.06 * dt);

  if (!s.door.safe && s.door.waitUntil !== null && s.t >= s.door.waitUntil) {
    s.door.waitUntil = null;
    if (s.door.checked && s.door.temp === 'hot') {
      s.door.safe = true;
      s.events.push({
        at: s.t,
        type: 'evidence',
        anchorId: 'K-BACKDRAFT-WAIT',
        detail: '等待后烟色转灰白、呼吸减弱',
      });
    }
  }
}
```

- [ ] **Step 5: 跑测试，确认通过**

Run: `cd golden-hour/mvs && npx vitest run tests/smoke.test.ts`
Expected: PASS，3 个测试通过。

- [ ] **Step 6: 提交**

```bash
git add golden-hour/mvs/src/sim golden-hour/mvs/tests/smoke.test.ts
git commit -m "feat(mvs): add smoke, heat and exposure simulation"
```

---

## Task 4: 回燃门状态机与证据

**Files:**
- Create: `golden-hour/mvs/src/sim/door.ts`
- Test: `golden-hour/mvs/tests/door.test.ts`

- [ ] **Step 1: 写失败测试 tests/door.test.ts**

```ts
import { describe, it, expect } from 'vitest';
import { createWorld } from '../src/sim/world';
import { stepSim } from '../src/sim/step';
import { checkDoor, waitDoor, openDoor } from '../src/sim/door';

const advance = (s: ReturnType<typeof createWorld>, seconds: number) => {
  for (let i = 0; i < seconds * 20; i++) stepSim(s, 1 / 20);
};

describe('回燃门', () => {
  it('试温并等待后开门，救出被困者', () => {
    const s = createWorld('x');
    checkDoor(s);
    waitDoor(s);
    advance(s, 31);
    openDoor(s);
    expect(s.door.safe).toBe(true);
    expect(s.victim.rescued).toBe(true);
    expect(s.victim.alive).toBe(true);
  });

  it('未试温直接开门，回燃且记录遗漏', () => {
    const s = createWorld('x');
    openDoor(s);
    expect(s.victim.alive).toBe(false);
    expect(s.victim.rescued).toBe(false);
    expect(s.events.some((e) => e.type === 'omission' && e.anchorId === 'O-DOOR-TEMP')).toBe(true);
  });

  it('试温后直接开门，仍会回燃并记录失败证据', () => {
    const s = createWorld('x');
    checkDoor(s);
    openDoor(s);
    expect(s.victim.alive).toBe(false);
    expect(s.events.some((e) => e.anchorId === 'K-BACKDRAFT-FAIL')).toBe(true);
  });

  it('试温本身写入证据 K-DOOR-TEMP', () => {
    const s = createWorld('x');
    checkDoor(s);
    expect(s.door.temp).toBe('hot');
    expect(s.events.some((e) => e.anchorId === 'K-DOOR-TEMP')).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `cd golden-hour/mvs && npx vitest run tests/door.test.ts`
Expected: FAIL，找不到 `../src/sim/door`。

- [ ] **Step 3: 实现 src/sim/door.ts**

```ts
import type { SimState } from './types';
import { clamp01 } from './smoke';

export function checkDoor(s: SimState): void {
  if (s.door.checked || s.door.opened) return;
  s.door.checked = true;
  s.door.temp = 'hot';
  s.events.push({
    at: s.t,
    type: 'evidence',
    anchorId: 'K-DOOR-TEMP',
    detail: '手背试温：门把烫手',
  });
}

export function waitDoor(s: SimState): void {
  if (s.door.opened || s.door.safe || s.door.waitUntil !== null) return;
  s.door.waitUntil = s.t + 30;
}

export function openDoor(s: SimState): void {
  if (s.door.opened) return;
  s.door.opened = true;

  if (!s.door.checked) {
    s.events.push({
      at: s.t,
      type: 'omission',
      anchorId: 'O-DOOR-TEMP',
      detail: '未进行门温试探',
    });
  }

  if (s.door.safe) {
    s.victim.rescued = true;
    s.victim.alive = true;
    s.events.push({
      at: s.t,
      type: 'rescue',
      anchorId: 'K-RESCUE',
      detail: '开门后救出被困者',
    });
    return;
  }

  s.victim.alive = false;
  s.victim.rescued = false;
  s.exposure.heat = clamp01(s.exposure.heat + 0.5);
  s.events.push({
    at: s.t,
    type: 'death',
    anchorId: 'K-BACKDRAFT-FAIL',
    detail: '回燃，火球冲出',
  });
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `cd golden-hour/mvs && npx vitest run tests/door.test.ts`
Expected: PASS，4 个测试通过。

- [ ] **Step 5: 提交**

```bash
git add golden-hour/mvs/src/sim/door.ts golden-hour/mvs/tests/door.test.ts
git commit -m "feat(mvs): add backdraft door state machine and evidence"
```

---

## Task 5: 复盘卡

**Files:**
- Create: `golden-hour/mvs/src/eval/debrief.ts`
- Test: `golden-hour/mvs/tests/debrief.test.ts`

- [ ] **Step 1: 写失败测试 tests/debrief.test.ts**

```ts
import { describe, it, expect } from 'vitest';
import { createWorld } from '../src/sim/world';
import { stepSim } from '../src/sim/step';
import { checkDoor, openDoor } from '../src/sim/door';
import { buildDebrief } from '../src/eval/debrief';

describe('buildDebrief', () => {
  it('未试温开门时，遗漏清单包含门温试探', () => {
    const s = createWorld('GH-FIRE-MVS');
    stepSim(s, 1 / 20);
    openDoor(s);
    const card = buildDebrief(s);
    expect(card.omissions).toContain('未进行门温试探');
    expect(card.tactical.lost).toBe(1);
  });

  it('成功救援时，学习记录包含门温与等待', () => {
    const s = createWorld('GH-FIRE-MVS');
    checkDoor(s);
    s.door.waitUntil = s.t - 1;
    stepSim(s, 1 / 20);
    openDoor(s);
    const card = buildDebrief(s);
    expect(card.tactical.rescued).toBe(1);
    const ids = card.learning.map((l) => l.anchorId);
    expect(ids).toContain('K-DOOR-TEMP');
    expect(ids).toContain('K-BACKDRAFT-WAIT');
  });

  it('复盘卡带章节与标准版本信息', () => {
    const card = buildDebrief(createWorld('x'));
    expect(card.provenance.chapter).toBe(2);
    expect(card.provenance.standardEdition).toBe('IFRC-2025');
    expect(card.provenance.assistedMode).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `cd golden-hour/mvs && npx vitest run tests/debrief.test.ts`
Expected: FAIL，找不到 `../src/eval/debrief`。

- [ ] **Step 3: 实现 src/eval/debrief.ts**

```ts
import type { SimState } from '../sim/types';

export interface LearningRecord {
  anchorId: string;
  attempts: number;
  correct: number;
}

export interface DebriefCard {
  schemaVersion: 'mvs-1';
  seed: string;
  tactical: {
    rescued: number;
    trapped: number;
    lost: number;
    resourcesConsumed: Record<string, number>;
    elapsedSec: number;
    exposurePeak: { smoke: number; heat: number; strain: number };
  };
  learning: LearningRecord[];
  omissions: string[];
  timeline: Array<{ atSec: number; type: string; label: string }>;
  provenance: {
    standardEdition: string;
    assistedMode: boolean;
    evidenceGrade: 'A' | 'B';
    chapter: 1 | 2 | 3;
    chapterPreset: boolean;
  };
}

export function buildDebrief(s: SimState): DebriefCard {
  const map = new Map<string, LearningRecord>();

  for (const e of s.events) {
    if (!e.anchorId || e.anchorId.startsWith('O-')) continue;
    const r = map.get(e.anchorId) ?? { anchorId: e.anchorId, attempts: 0, correct: 0 };
    r.attempts += 1;
    if (e.type === 'evidence' || e.type === 'rescue') r.correct += 1;
    map.set(e.anchorId, r);
  }

  return {
    schemaVersion: 'mvs-1',
    seed: s.seed,
    tactical: {
      rescued: s.victim.rescued ? 1 : 0,
      trapped: s.victim.rescued ? 0 : 1,
      lost: s.victim.alive ? 0 : 1,
      resourcesConsumed: { extinguisher: 1 },
      elapsedSec: Math.round(s.t),
      exposurePeak: {
        smoke: round2(s.exposure.smoke),
        heat: round2(s.exposure.heat),
        strain: round2(s.exposure.strain),
      },
    },
    learning: [...map.values()],
    omissions: s.events
      .filter((e) => e.type === 'omission')
      .map((e) => e.detail ?? e.anchorId ?? '未知遗漏'),
    timeline: s.events.map((e) => ({
      atSec: Math.round(e.at),
      type: e.type,
      label: e.detail ?? e.anchorId ?? '',
    })),
    provenance: {
      standardEdition: 'IFRC-2025',
      assistedMode: false,
      evidenceGrade: 'A',
      chapter: 2,
      chapterPreset: true,
    },
  };
}

const round2 = (v: number): number => Math.round(v * 100) / 100;
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `cd golden-hour/mvs && npx vitest run tests/debrief.test.ts`
Expected: PASS，3 个测试通过。

- [ ] **Step 5: 提交**

```bash
git add golden-hour/mvs/src/eval golden-hour/mvs/tests/debrief.test.ts
git commit -m "feat(mvs): build debrief card with omissions and provenance"
```

---

## Task 6: 确定性回放

**Files:**
- Create: `golden-hour/mvs/tests/determinism.test.ts`
- Modify: `golden-hour/mvs/src/sim/step.ts`

- [ ] **Step 1: 写失败测试 tests/determinism.test.ts**

```ts
import { describe, it, expect } from 'vitest';
import { createWorld } from '../src/sim/world';
import { stepSim } from '../src/sim/step';
import { checkDoor, waitDoor, openDoor } from '../src/sim/door';

function run(seed: string) {
  const s = createWorld(seed);
  for (let i = 0; i < 20 * 20; i++) stepSim(s, 1 / 20);
  checkDoor(s);
  waitDoor(s);
  for (let i = 0; i < 20 * 31; i++) stepSim(s, 1 / 20);
  openDoor(s);
  for (let i = 0; i < 20 * 5; i++) stepSim(s, 1 / 20);
  return JSON.stringify(s);
}

describe('确定性', () => {
  it('同种子同操作序列得到完全相同的状态', () => {
    expect(run('GH-FIRE-MVS')).toBe(run('GH-FIRE-MVS'));
  });

  it('不同种子不要求不同，但字符串必须可解析', () => {
    const s = JSON.parse(run('A'));
    expect(Array.isArray(s.events)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试**

Run: `cd golden-hour/mvs && npx vitest run tests/determinism.test.ts`
Expected: PASS。若失败，检查 `stepSim` 中是否使用了 `Math.random()` 或 `Date.now()`。

- [ ] **Step 3: 确认模拟层没有非确定性来源**

Run: `rg -n "Math.random|Date.now|performance.now" golden-hour/mvs/src/sim`
Expected: 无输出。若有，替换为状态中的 `t` 或种子化随机。

- [ ] **Step 4: 提交**

```bash
git add golden-hour/mvs/tests/determinism.test.ts golden-hour/mvs/src/sim
git commit -m "test(mvs): lock deterministic simulation"
```

---

## Task 7: 合并静态几何与场景

**Files:**
- Create: `golden-hour/mvs/src/render/scene.ts`
- Test: `golden-hour/mvs/tests/geometry.test.ts`

- [ ] **Step 1: 写失败测试 tests/geometry.test.ts**

```ts
import { describe, it, expect } from 'vitest';
import { buildStaticGeometry, STATIC_MESH_COUNT } from '../src/render/scene';

describe('静态几何', () => {
  it('所有建筑构件被合并成一个几何体', () => {
    const g = buildStaticGeometry();
    expect(STATIC_MESH_COUNT).toBe(1);
    expect(g.attributes.position.count).toBeGreaterThan(0);
  });

  it('两层楼板都在几何体内', () => {
    const g = buildStaticGeometry();
    g.computeBoundingBox();
    const box = g.boundingBox!;
    expect(box.min.y).toBeLessThanOrEqual(-0.2);
    expect(box.max.y).toBeGreaterThanOrEqual(6);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `cd golden-hour/mvs && npx vitest run tests/geometry.test.ts`
Expected: FAIL，找不到 `../src/render/scene`。

- [ ] **Step 3: 实现 src/render/scene.ts**

```ts
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export const STATIC_MESH_COUNT = 1;
const FLOOR_H = 3;

export function buildStaticGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  const addBox = (w: number, h: number, d: number, x: number, y: number, z: number) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    parts.push(g);
  };

  for (let f = 0; f < 2; f++) {
    const base = f * FLOOR_H;
    addBox(26, 0.3, 14, 0, base, 0);
    addBox(26, FLOOR_H, 0.3, 0, base + FLOOR_H / 2, -7);
    addBox(0.3, FLOOR_H, 14, -13, base + FLOOR_H / 2, 0);
    addBox(0.3, FLOOR_H, 14, 13, base + FLOOR_H / 2, 0);
    for (let x = -13; x <= 13; x += 6.5) {
      addBox(0.28, FLOOR_H, 0.28, x, base + FLOOR_H / 2, 7);
    }
  }

  return mergeGeometries(parts, false)!;
}

export function createScene(): {
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  renderer: THREE.WebGLRenderer;
} {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.shadowMap.enabled = false;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d0f12);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 300);
  const frustum = 16;
  const aspect = window.innerWidth / window.innerHeight;
  camera.left = -frustum * aspect;
  camera.right = frustum * aspect;
  camera.top = frustum;
  camera.bottom = -frustum;
  camera.position.set(28, 24, 28);
  camera.lookAt(0, 3, 0);
  camera.updateProjectionMatrix();

  scene.add(new THREE.HemisphereLight(0x8fa3b8, 0x14181d, 1.1));
  const key = new THREE.DirectionalLight(0xffe0c0, 1.2);
  key.position.set(24, 36, 18);
  scene.add(key);

  const building = new THREE.Mesh(
    buildStaticGeometry(),
    new THREE.MeshStandardMaterial({ color: 0x4a515a, roughness: 0.95 })
  );
  scene.add(building);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.MeshStandardMaterial({ color: 0x121519, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.16;
  scene.add(ground);

  return { scene, camera, renderer };
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `cd golden-hour/mvs && npx vitest run tests/geometry.test.ts`
Expected: PASS，2 个测试通过。

- [ ] **Step 5: 提交**

```bash
git add golden-hour/mvs/src/render/scene.ts golden-hour/mvs/tests/geometry.test.ts
git commit -m "feat(mvs): merge static building geometry into one mesh"
```

---

## Task 8: 班组与烟层渲染

**Files:**
- Create: `golden-hour/mvs/src/render/agents.ts`
- Create: `golden-hour/mvs/src/render/smoke.ts`

- [ ] **Step 1: 实现 src/render/agents.ts**

```ts
import * as THREE from 'three';
import type { SimState } from '../sim/types';

export function createAgents(scene: THREE.Scene): {
  mesh: THREE.InstancedMesh;
  update: (s: SimState) => void;
} {
  const geo = new THREE.CapsuleGeometry(0.24, 0.72, 3, 8);
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.85 });
  const mesh = new THREE.InstancedMesh(geo, mat, 2);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.setColorAt(0, new THREE.Color(0x5fa88a));
  mesh.setColorAt(1, new THREE.Color(0xd9c27a));
  scene.add(mesh);

  const dummy = new THREE.Object3D();

  return {
    mesh,
    update(s: SimState) {
      const y = s.crew.floor * 3 + 0.55 + s.crew.progress * 3;
      dummy.position.set(-9.5, y, -4.2);
      dummy.rotation.y = 0;
      dummy.updateMatrix();
      mesh.setMatrixAt(0, dummy.matrix);

      dummy.position.set(4.4, 3 + 0.55, 2.4);
      dummy.updateMatrix();
      mesh.setMatrixAt(1, dummy.matrix);

      mesh.instanceMatrix.needsUpdate = true;
    },
  };
}
```

- [ ] **Step 2: 实现 src/render/smoke.ts**

```ts
import * as THREE from 'three';
import type { SimState } from '../sim/types';

export function createSmoke(scene: THREE.Scene): {
  update: (s: SimState) => void;
  group: THREE.Group;
} {
  const group = new THREE.Group();
  scene.add(group);

  const boxes: THREE.Mesh[] = [];
  for (let f = 0; f < 2; f++) {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(24, 1, 12),
      new THREE.MeshBasicMaterial({
        color: 0x9aa3ad,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      })
    );
    m.position.set(0, f * 3 + 0.5, 0);
    group.add(m);
    boxes.push(m);
  }

  return {
    group,
    update(s: SimState) {
      for (let f = 0; f < 2; f++) {
        const v = s.smoke[f];
        const h = Math.max(0.02, v * 2.6);
        boxes[f].scale.y = h;
        boxes[f].position.y = f * 3 + h / 2 + 0.15;
        (boxes[f].material as THREE.MeshBasicMaterial).opacity = v * 0.34;
      }
    },
  };
}
```

- [ ] **Step 3: 类型检查**

Run: `cd golden-hour/mvs && npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 4: 提交**

```bash
git add golden-hour/mvs/src/render
git commit -m "feat(mvs): render instanced crew and layered smoke"
```

---

## Task 9: 界面与交互

**Files:**
- Create: `golden-hour/mvs/src/ui/hud.ts`
- Create: `golden-hour/mvs/src/ui/door.ts`
- Create: `golden-hour/mvs/src/ui/debrief.ts`
- Create: `golden-hour/mvs/src/main.ts`
- Modify: `golden-hour/mvs/src/render/scene.ts`

- [ ] **Step 1: 实现 src/ui/hud.ts**

```ts
import type { SimState } from '../sim/types';

export function createHud(root: HTMLElement): { update: (s: SimState) => void } {
  return {
    update(s: SimState) {
      root.innerHTML = [
        `<div>seed ${s.seed}</div>`,
        `<div>t ${s.t.toFixed(1)}s</div>`,
        `<div>烟 ${Math.round(s.smoke[s.crew.floor] * 100)}%</div>`,
        `<div>热 ${Math.round(s.exposure.heat * 100)}%</div>`,
        `<div>体力 ${Math.round(s.exposure.strain * 100)}%</div>`,
      ].join('');
    },
  };
}
```

- [ ] **Step 2: 实现 src/ui/door.ts**

```ts
import type { SimState } from '../sim/types';
import { checkDoor, waitDoor, openDoor } from '../sim/door';

export function createDoorUi(root: HTMLElement): { update: (s: SimState) => void } {
  let checked = false;

  root.addEventListener('contextmenu', (e) => e.preventDefault());

  root.innerHTML = `
    <div>回燃门：右键选择</div>
    <button data-act="check">按住试温</button>
    <button data-act="wait">等 30 秒</button>
    <button data-act="open">开门</button>
  `;

  let holdTimer: number | null = null;

  const act = (name: string) => {
    const s = (window as unknown as { __sim: SimState }).__sim;
    if (!s || s.door.opened) return;
    if (name === 'check') {
      checked = true;
      checkDoor(s);
    }
    if (name === 'wait') waitDoor(s);
    if (name === 'open') openDoor(s);
  };

  root.addEventListener('pointerdown', (e) => {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn || btn.dataset.act !== 'check') return;
    holdTimer = window.setTimeout(() => act('check'), 600);
  });

  root.addEventListener('pointerup', () => {
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  });

  root.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn) return;
    const name = btn.dataset.act;
    if (name === 'wait' || name === 'open') act(name);
  });

  return {
    update(s: SimState) {
      const atDoor = s.crew.atDoor && !s.door.opened;
      root.style.display = atDoor ? 'block' : 'none';
      const checkBtn = root.querySelector<HTMLButtonElement>('[data-act="check"]')!;
      checkBtn.textContent = checked || s.door.checked ? '已试温（烫）' : '按住试温';
      checkBtn.disabled = s.door.checked;
    },
  };
}
```

- [ ] **Step 3: 实现 src/ui/debrief.ts**

```ts
import type { DebriefCard } from '../eval/debrief';

export function renderDebrief(root: HTMLElement, card: DebriefCard): void {
  const rows = card.timeline
    .map((t) => `<li>${t.atSec}s · ${t.type} · ${t.label}</li>`)
    .join('');
  const omissions = card.omissions.length
    ? card.omissions.map((o) => `<li>${o}</li>`).join('')
    : '<li>无</li>';

  root.innerHTML = `
    <h2>行动后回顾</h2>
    <p>救出 ${card.tactical.rescued} / 被困 ${card.tactical.trapped} / 死亡 ${card.tactical.lost}</p>
    <h3>时间线</h3><ul>${rows}</ul>
    <h3>遗漏清单</h3><ul>${omissions}</ul>
    <h3>学习记录</h3>
    <ul>${card.learning.map((l) => `<li>${l.anchorId} · ${l.correct}/${l.attempts}</li>`).join('')}</ul>
    <button id="export">导出复盘卡 JSON</button>
  `;

  root.querySelector('#export')?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(card, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `debrief-${card.seed}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
}
```

- [ ] **Step 4: 实现 src/main.ts**

```ts
import { createWorld } from './sim/world';
import { stepSim } from './sim/step';
import { buildDebrief } from './eval/debrief';
import { createScene } from './render/scene';
import { createAgents } from './render/agents';
import { createSmoke } from './render/smoke';
import { createHud } from './ui/hud';
import { createDoorUi } from './ui/door';
import { renderDebrief } from './ui/debrief';

const canvas = document.getElementById('app') as HTMLCanvasElement;
const hudRoot = document.getElementById('hud')!;
const doorRoot = document.getElementById('door-ui')!;
const debriefRoot = document.getElementById('debrief')!;

const sim = createWorld('GH-FIRE-MVS');
(window as unknown as { __sim: typeof sim }).__sim = sim;

const { scene, camera, renderer } = createScene();
renderer.setSize(window.innerWidth, window.innerHeight);
canvas.replaceWith(renderer.domElement);
renderer.domElement.id = 'app';

const agents = createAgents(scene);
const smoke = createSmoke(scene);
const hud = createHud(hudRoot);
const doorUi = createDoorUi(doorRoot);

window.addEventListener('resize', () => {
  const aspect = window.innerWidth / window.innerHeight;
  const frustum = 16;
  camera.left = -frustum * aspect;
  camera.right = frustum * aspect;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// 规划阶段：按 Enter 下达搜索二层指令
window.addEventListener('keydown', (e) => {
  if (e.code === 'Enter' && sim.phase === 'plan') {
    sim.phase = 'execute';
    sim.crew.order = { kind: 'search', floor: 1 };
  }
  if (e.code === 'KeyT' && sim.phase === 'execute') {
    for (let i = 0; i < 600; i++) stepSim(sim, 1 / 20);
  }
});

const DT = 1 / 20;
let acc = 0;
let last = performance.now();

function frame(now: number) {
  requestAnimationFrame(frame);
  const raw = Math.min((now - last) / 1000, 0.25);
  last = now;

  if (sim.phase === 'execute') {
    acc += raw;
    while (acc >= DT) {
      stepSim(sim, DT);
      acc -= DT;
    }
    if (sim.door.opened) {
      sim.phase = 'debrief';
      debriefRoot.style.display = 'block';
      renderDebrief(debriefRoot, buildDebrief(sim));
    }
  }

  agents.update(sim);
  smoke.update(sim);
  hud.update(sim);
  doorUi.update(sim);
  renderer.render(scene, camera);
}

requestAnimationFrame(frame);
```

- [ ] **Step 5: 类型检查与构建**

Run: `cd golden-hour/mvs && npm run build`
Expected: 构建成功，无 TypeScript 错误。

- [ ] **Step 6: 手动验收**

Run: `cd golden-hour/mvs && npm run dev`

打开 `http://localhost:5174`，逐项检查：

- 能看到两层楼、班组从一层走向二层。
- 走到门前时，底部出现“试温 / 等 30 秒 / 开门”。
- 直接点“开门”：复盘页出现，遗漏清单里有“未进行门温试探”。
- 重开后按住“试温”约 0.6 秒，点“等 30 秒”，按 `T` 快进 30 秒，再点“开门”：复盘页显示救出 1 人。
- 点“导出复盘卡 JSON”，文件能下载并包含 `provenance.chapter === 2`。

- [ ] **Step 7: 提交**

```bash
git add golden-hour/mvs
git commit -m "feat(mvs): wire planning, door interaction and debrief ui"
```

---

## 验收清单

- [ ] `npm test` 全部通过（rng、world、smoke、door、debrief、determinism、geometry）。
- [ ] `npm run build` 成功，产物体积记录在提交说明里。
- [ ] 不试温开门 → 遗漏清单出现 O-DOOR-TEMP。
- [ ] 试温 + 等待 + 开门 → 救出 1 人。
- [ ] 同种子同操作，复现完全相同的状态。
- [ ] 静态建筑为 1 个合并网格。
- [ ] 复盘卡可导出，含章节与标准版本字段。

---

## 明确不做

自救无线电、X 光、结构听觉、专家影子、能力图谱、每日种子、xAPI 导出、三章存档、组织者手册。这些在规格里有，但不属于 MVS。
