import {
  cellAt,
  clamp01,
  inBounds,
  isFuelRich,
  type FireClass,
  type OpeningId,
  type RoomState,
  type ToolCondition,
  type ToolKey,
} from './fields';
import { AGENTS, FIRE_CLASSES, agentEffect, agentHazard, type AgentId } from './agents';
import { openingOpen, shouldBackdraft } from './spread';

export interface OpenResult {
  opened: boolean;
  backdraft: boolean;
}

export interface MeasureResult {
  band: 'cool' | 'warm' | 'hot';
  /** 示意温度，仅用于 HUD 与复盘，不参与物理 */
  celsius: number;
  risk: number;
  fuelRich: boolean;
}

const AGENT_TOOL: Partial<Record<AgentId, ToolKey>> = {
  water: 'water',
  dryPowder: 'dryPowder',
  co2: 'co2',
  foam: 'foam',
  wetChemical: 'wetChemical',
  sand: 'sand',
};

/** 器材状态直接打折：过期的干粉喷出来像撒粉，压力不足打不到火点。 */
export const TOOL_CONDITION_FACTOR: Record<ToolCondition, number> = {
  ok: 1,
  expired: 0.2,
  depressurized: 0.35,
  broken: 0.1,
  empty: 0,
};

export const TOOL_ADVICE: Record<ToolCondition, string> = {
  ok: '压力表在绿区、铅封完好，可以正常使用。',
  expired: '已过有效期：干粉可能结块，喷射无力，别指望它单独灭火。',
  depressurized: '压力不足：射程与覆盖都不够，先找替代手段。',
  broken: '水带或喷头破损：会漏水，效率很低。',
  empty: '已经用空了。',
};

export interface ToolInspection {
  key: ToolKey;
  condition: ToolCondition;
  charge: number;
  usable: boolean;
  advice: string;
}

export function inspectTool(state: RoomState, key: ToolKey): ToolInspection {
  const t = state.tools[key];
  return {
    key,
    condition: t.condition,
    charge: t.charge,
    usable: t.charge > 0 && TOOL_CONDITION_FACTOR[t.condition] > 0,
    advice: TOOL_ADVICE[t.condition],
  };
}

/** 开门。富燃料 + 门板高温 + 门未打湿，会埋下回燃，约 0.9 秒后兑现。 */
export function openOpening(state: RoomState, id: OpeningId): OpenResult {
  const o = state.openings[id];
  if (openingOpen(o)) return { opened: false, backdraft: false };

  o.open = true;
  state.lastOpened = id;
  state.lastOpenedAt = state.t;
  const backdraft = shouldBackdraft(state, id);
  state.pendingBackdraft = backdraft;
  state.log.push({
    at: state.t,
    kind: 'open',
    detail: id === 'door' ? '打开房门' : '打开窗户',
  });
  return { opened: true, backdraft };
}

/** 破拆门板 / 打碎窗玻璃。 */
export function breakOpening(state: RoomState, id: OpeningId): OpenResult {
  const o = state.openings[id];
  if (o.broken) return { opened: false, backdraft: false };
  o.broken = true;
  state.lastOpened = id;
  state.lastOpenedAt = state.t;
  const backdraft = shouldBackdraft(state, id);
  state.pendingBackdraft = backdraft;
  state.log.push({
    at: state.t,
    kind: 'break',
    detail: id === 'door' ? '破拆门板' : '击碎窗玻璃',
  });
  return { opened: true, backdraft };
}

/** 贴门/窗测温。门温直接告诉玩家回燃可能性。 */
export function measureOpening(state: RoomState, id: OpeningId): MeasureResult {
  const o = state.openings[id];
  const band = o.temp < 0.12 ? 'cool' : o.temp < 0.3 ? 'warm' : 'hot';
  return {
    band,
    celsius: Math.round(20 + o.temp * 700),
    risk: state.backdraftRisk,
    fuelRich: isFuelRich(state),
  };
}

export interface SprayResult {
  ok: boolean;
  agent: AgentId;
  /** 实际造成的灭火量 */
  effect: number;
  /** 用错剂造成的反噬总量 */
  hazard: number;
  misagent: boolean;
  outOfAgent: boolean;
  /** 有多少格的火被压到 0.02 以下 */
  extinguished: number;
  /** 给玩家看的解释：为什么有效 / 为什么危险 / 为什么没效果 */
  lesson: string;
}

function goodLesson(agent: AgentId, fireClass: FireClass): string {
  return `${AGENTS[agent].label}适用于 ${FIRE_CLASSES[fireClass].label}：${FIRE_CLASSES[fireClass].fuels}。`;
}

function badLesson(agent: AgentId, fireClass: FireClass): string {
  const cls = FIRE_CLASSES[fireClass];
  return `危险：${AGENTS[agent].label}不能用于 ${cls.label}。${cls.fallback}`;
}

function weakLesson(agent: AgentId, fireClass: FireClass): string {
  return `${AGENTS[agent].label}对 ${FIRE_CLASSES[fireClass].label} 效果有限。${FIRE_CLASSES[fireClass].fallback}`;
}

/**
 * 对着 (cx, cy) 施放灭火剂。
 *
 * 效率、危险与器材状态共同决定结果：水灭 A 类有效，对 B 类会飞溅；
 * 过期干粉即使选对了火类也打不灭。
 */
export function spray(
  state: RoomState,
  agent: AgentId,
  cx: number,
  cy: number,
  options: { radius?: number; amount?: number; free?: boolean } = {}
): SprayResult {
  const base: SprayResult = {
    ok: false,
    agent,
    effect: 0,
    hazard: 0,
    misagent: false,
    outOfAgent: false,
    extinguished: 0,
    lesson: '',
  };

  const tool = AGENT_TOOL[agent];
  if (!tool && agent !== 'blanket') {
    return { ...base, outOfAgent: true, lesson: '这个场景没有这种器材。' };
  }

  let conditionFactor = 1;
  if (tool && !options.free) {
    const t = state.tools[tool];
    if (t.charge <= 0) {
      return {
        ...base,
        outOfAgent: true,
        lesson: `${AGENTS[agent].label}不可用：已经用空了。`,
      };
    }
    conditionFactor = TOOL_CONDITION_FACTOR[t.condition];
    if (conditionFactor <= 0) {
      return {
        ...base,
        outOfAgent: true,
        lesson: `${AGENTS[agent].label}不可用：${TOOL_ADVICE[t.condition]}`,
      };
    }
    t.charge = Math.max(0, t.charge - (options.amount ?? 0.22));
  }

  const amount = options.amount ?? 0.22;
  const radius = options.radius ?? 2;

  const spec = AGENTS[agent];
  if (spec.leavesWater) state.stats.waterUsed += amount * conditionFactor;

  // 喷到门/窗时，直接给门板降温并打湿；湿门在短时间内难以被回燃点燃。
  for (const id of ['door', 'window'] as const) {
    const o = state.openings[id];
    const dist = Math.hypot(cx - o.x, cy - o.y);
    if (dist > radius + 0.6) continue;
    const falloff = 1 - Math.min(1, dist / (radius + 0.001));
    o.temp = clamp01(o.temp - amount * spec.cooling * conditionFactor * falloff * 3.5);
    if (spec.leavesWater) {
      o.wet = clamp01(o.wet + amount * conditionFactor * falloff * 3);
    }
  }

  let effect = 0;
  let hazardTotal = 0;
  let misagent = false;
  let extinguished = 0;
  let dominantClass: FireClass | null = null;
  const span = Math.ceil(radius);

  for (let dy = -span; dy <= span; dy++) {
    for (let dx = -span; dx <= span; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (!inBounds(state.config, x, y)) continue;
      const dist = Math.hypot(dx, dy);
      if (dist > radius) continue;
      const falloff = 1 - dist / (radius + 0.001);
      const dmg = amount * conditionFactor * falloff;

      const c = cellAt(state, x, y);
      const eff = agentEffect(agent, c.fireClass);
      const haz = agentHazard(agent, c.fireClass);

      if (c.fire > 0.02) {
        dominantClass = dominantClass ?? c.fireClass;
        c.fire = clamp01(c.fire - dmg * eff * 2.4);
        c.heat = clamp01(c.heat - dmg * spec.cooling * 1.6);
        if (spec.leavesWater) c.water = clamp01(c.water + dmg * 1.4);
        effect += dmg * eff;

        if (haz > 0) {
          misagent = true;
          hazardTotal += haz;
          c.fire = clamp01(c.fire + dmg * haz * 1.8);
          c.smoke = clamp01(c.smoke + dmg * haz * 1.6);
          c.heat = clamp01(c.heat + dmg * haz * 0.6);
          // 液体/金属飞溅：把火带到相邻格
          for (const [nx, ny] of [
            [x + 1, y],
            [x - 1, y],
            [x, y + 1],
            [x, y - 1],
          ]) {
            if (!inBounds(state.config, nx, ny)) continue;
            const nb = cellAt(state, nx, ny);
            nb.fire = clamp01(nb.fire + dmg * haz * 0.5);
          }
        }

        if (c.fire <= 0.02) extinguished += 1;
      } else {
        c.heat = clamp01(c.heat - dmg * spec.cooling * 1.2);
        if (spec.leavesWater) c.water = clamp01(c.water + dmg);
      }
    }
  }

  let lesson: string;
  if (misagent && dominantClass) {
    lesson = badLesson(agent, dominantClass);
    state.log.push({ at: state.t, kind: 'misagent', detail: `${spec.label}用错了火类，火势反而扩大` });
  } else if (dominantClass) {
    lesson = agentEffect(agent, dominantClass) >= 0.6 ? goodLesson(agent, dominantClass) : weakLesson(agent, dominantClass);
  } else {
    lesson = '附近没有明火，只做了降温。';
  }

  return {
    ok: true,
    agent,
    effect,
    hazard: hazardTotal,
    misagent,
    outOfAgent: false,
    extinguished,
    lesson,
  };
}

/** 关门窗限氧：没有对应灭火剂时的替代处置。 */
export function isolate(state: RoomState): void {
  for (const id of ['door', 'window'] as const) {
    state.openings[id].open = false;
    state.openings[id].broken = false;
  }
  state.log.push({ at: state.t, kind: 'vent', detail: '关闭开口，限制供氧' });
  state.lastOpened = null;
  state.lastOpenedAt = null;
  state.pendingBackdraft = false;
}

/** 覆盖窒息：沙土 / 灭火毯，短半径、无飞溅。 */
export function smother(
  state: RoomState,
  agent: 'sand' | 'blanket',
  cx: number,
  cy: number
): SprayResult {
  return spray(state, agent, cx, cy, { radius: 1.2, amount: 0.3 });
}

/** 只冷却、不指望灭火：对准周边喷水/泡沫，压温但避开液面。 */
export function coolSurrounds(
  state: RoomState,
  cx: number,
  cy: number
): SprayResult {
  const result = spray(state, 'water', cx, cy, { radius: 2.4, amount: 0.16 });
  state.log.push({ at: state.t, kind: 'cool', detail: '冷却周边，避免直接冲击液面' });
  return result;
}
