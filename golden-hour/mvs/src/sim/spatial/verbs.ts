import {
  cellAt,
  clamp01,
  inBounds,
  isFuelRich,
  type OpeningId,
  type RoomState,
  type ToolLoadout,
} from './fields';
import { AGENTS, agentEffect, agentHazard, type AgentId } from './agents';
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

export type ToolKey = keyof ToolLoadout;

const AGENT_TOOL: Partial<Record<AgentId, ToolKey>> = {
  water: 'water',
  dryPowder: 'dryPowder',
  co2: 'co2',
  foam: 'foam',
  wetChemical: 'wetChemical',
  sand: 'sand',
};

/** 开门。富燃料 + 门板高温会埋下回燃，约 0.9 秒后兑现。 */
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
  const band = o.temp < 0.22 ? 'cool' : o.temp < 0.4 ? 'warm' : 'hot';
  return {
    band,
    celsius: Math.round(20 + o.temp * 620),
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
}

const EMPTY_SPRAY = (agent: AgentId): SprayResult => ({
  ok: false,
  agent,
  effect: 0,
  hazard: 0,
  misagent: false,
  outOfAgent: false,
  extinguished: 0,
});

/**
 * 对着 (cx, cy) 施放灭火剂。
 *
 * 效率与危险都来自 `agents.ts` 的矩阵：水灭 A 类有效，对 B 类会飞溅，
 * 对 D 类会发生剧烈反应。用错剂时火势、烟、热反而上升。
 */
export function spray(
  state: RoomState,
  agent: AgentId,
  cx: number,
  cy: number,
  options: { radius?: number; amount?: number } = {}
): SprayResult {
  const tool = AGENT_TOOL[agent];
  const amount = options.amount ?? 0.22;
  const radius = options.radius ?? 2;
  if (!tool || state.tools[tool] <= 0) {
    return { ...EMPTY_SPRAY(agent), outOfAgent: true };
  }

  state.tools[tool] = Math.max(0, state.tools[tool] - amount);

  // 喷到门/窗时，直接给门板降温并打湿；湿门在短时间内难以被回燃点燃。
  for (const id of ['door', 'window'] as const) {
    const o = state.openings[id];
    const dist = Math.hypot(cx - o.x, cy - o.y);
    if (dist > radius + 0.6) continue;
    const falloff = 1 - Math.min(1, dist / (radius + 0.001));
    o.temp = clamp01(o.temp - amount * AGENTS[agent].cooling * falloff * 3.5);
    if (AGENTS[agent].leavesWater) {
      o.wet = clamp01(o.wet + amount * falloff * 3);
    }
  }

  let effect = 0;
  let hazardTotal = 0;
  let misagent = false;
  let extinguished = 0;
  const spec = AGENTS[agent];

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (!inBounds(state.config, x, y)) continue;
      const dist = Math.hypot(dx, dy);
      if (dist > radius) continue;
      const falloff = 1 - dist / (radius + 0.001);
      const dmg = amount * falloff;

      const c = cellAt(state, x, y);
      const eff = agentEffect(agent, c.fireClass);
      const haz = agentHazard(agent, c.fireClass);

      if (c.fire > 0.02) {
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

  if (misagent) {
    state.log.push({
      at: state.t,
      kind: 'misagent',
      detail: `${agentLabel(agent)} 用错了火类，火势反而扩大`,
    });
  }

  return {
    ok: true,
    agent,
    effect,
    hazard: hazardTotal,
    misagent,
    outOfAgent: false,
    extinguished,
  };
}

function agentLabel(agent: AgentId): string {
  const labels: Record<AgentId, string> = {
    water: '水',
    foam: '泡沫',
    dryPowder: '干粉',
    co2: '二氧化碳',
    wetChemical: '湿化学剂',
    sand: '沙土',
    blanket: '灭火毯',
  };
  return labels[agent];
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
  agent: 'water' | 'foam',
  cx: number,
  cy: number
): SprayResult {
  const result = spray(state, agent, cx, cy, { radius: 2.4, amount: 0.16 });
  state.log.push({ at: state.t, kind: 'cool', detail: '冷却周边，避免直接冲击液面' });
  return result;
}
