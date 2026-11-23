import type { AgentId } from '../spatial/agents';

export type ToolId =
  | 'hose'
  | 'extinguisher'
  | 'axe'
  | 'fan'
  | 'thermal'
  | 'ladder'
  | 'rope';

export type CarryCondition = 'ok' | 'expired' | 'depressurized' | 'broken' | 'empty';

export interface ToolSpec {
  id: ToolId;
  label: string;
  kind: 'agent' | 'breach' | 'vent' | 'sense' | 'access';
  /** 灭火类工具对应的灭火剂 */
  agent?: AgentId;
  /** 携带重量 */
  weight: number;
}

export const TOOL_SPECS: Record<ToolId, ToolSpec> = {
  hose: { id: 'hose', label: '水带', kind: 'agent', agent: 'water', weight: 0.35 },
  extinguisher: {
    id: 'extinguisher',
    label: '灭火器',
    kind: 'agent',
    agent: 'dryPowder',
    weight: 0.25,
  },
  axe: { id: 'axe', label: '破拆斧', kind: 'breach', weight: 0.2 },
  fan: { id: 'fan', label: '排烟机', kind: 'vent', weight: 0.25 },
  thermal: { id: 'thermal', label: '热像仪', kind: 'sense', weight: 0.15 },
  ladder: { id: 'ladder', label: '梯子', kind: 'access', weight: 0.35 },
  rope: { id: 'rope', label: '绳索', kind: 'access', weight: 0.15 },
};

export interface CarryToolState {
  id: ToolId;
  charge: number;
  condition: CarryCondition;
}

export type CarryLoadout = Record<ToolId, CarryToolState>;

export const MAX_CARRY_WEIGHT = 1.4;

export const TOOL_CONDITION_FACTOR: Record<CarryCondition, number> = {
  ok: 1,
  expired: 0.2,
  depressurized: 0.35,
  broken: 0,
  empty: 0,
};

export function createToolLoadout(): CarryLoadout {
  return {
    hose: { id: 'hose', charge: 1, condition: 'ok' },
    extinguisher: { id: 'extinguisher', charge: 1, condition: 'ok' },
    axe: { id: 'axe', charge: 1, condition: 'ok' },
    fan: { id: 'fan', charge: 1, condition: 'ok' },
    thermal: { id: 'thermal', charge: 1, condition: 'ok' },
    ladder: { id: 'ladder', charge: 0, condition: 'empty' },
    rope: { id: 'rope', charge: 0, condition: 'empty' },
  };
}

export function toolWeight(loadout: CarryLoadout): number {
  let total = 0;
  for (const tool of Object.values(loadout)) {
    if (tool.charge > 0) total += TOOL_SPECS[tool.id].weight;
  }
  return total;
}

export function canCarry(loadout: CarryLoadout, id: ToolId): boolean {
  if (loadout[id].charge > 0) return true;
  return toolWeight(loadout) + TOOL_SPECS[id].weight <= MAX_CARRY_WEIGHT;
}

export function toolAvailable(loadout: CarryLoadout, id: ToolId): boolean {
  const tool = loadout[id];
  return tool.charge > 0 && TOOL_CONDITION_FACTOR[tool.condition] > 0;
}

/** 消耗工具；不可用或余量不足时返回 false。 */
export function consumeTool(
  loadout: CarryLoadout,
  id: ToolId,
  amount: number
): boolean {
  if (!Number.isFinite(amount) || amount <= 0) return false;
  const tool = loadout[id];
  if (!toolAvailable(loadout, id)) return false;

  tool.charge = Math.max(0, tool.charge - amount);
  if (tool.charge <= 0) {
    tool.charge = 0;
    tool.condition = 'empty';
  }
  return true;
}
