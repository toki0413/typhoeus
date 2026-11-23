import type { AgentId } from '../spatial/agents';
import type { ToolCondition } from '../spatial/fields';

export type ToolId =
  | 'hose'
  | 'extinguisher'
  | 'axe'
  | 'fan'
  | 'thermal'
  | 'ladder'
  | 'rope';

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
  condition: ToolCondition;
}

export type CarryLoadout = Record<ToolId, CarryToolState>;

export const MAX_CARRY_WEIGHT = 1.4;

export const CARRY_CONDITION_FACTOR: Record<ToolCondition, number> = {
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
  for (const [id, tool] of Object.entries(loadout) as [ToolId, CarryToolState][]) {
    if (tool.charge > 0 && TOOL_SPECS[id]) total += TOOL_SPECS[id].weight;
  }
  return total;
}

export function gearLoad(loadout: CarryLoadout): number {
  const ratio = toolWeight(loadout) / MAX_CARRY_WEIGHT;
  return Math.min(1, Math.max(0, ratio));
}

export function canCarry(loadout: CarryLoadout, id: ToolId): boolean {
  const tool = loadout[id];
  if (!tool || !TOOL_SPECS[id]) return false;
  if (tool.charge > 0) return true;
  return toolWeight(loadout) + TOOL_SPECS[id].weight <= MAX_CARRY_WEIGHT + 1e-9;
}

/** 装上一件未携带的工具；超重或未知工具返回 false。 */
export function equipTool(loadout: CarryLoadout, id: ToolId): boolean {
  if (!canCarry(loadout, id)) return false;
  const tool = loadout[id];
  if (tool.charge > 0) return true;
  tool.charge = 1;
  tool.condition = 'ok';
  return true;
}

/** 卸下工具，重量归零。 */
export function unequipTool(loadout: CarryLoadout, id: ToolId): void {
  const tool = loadout[id];
  tool.charge = 0;
  tool.condition = 'empty';
}

export function toolAvailable(loadout: CarryLoadout, id: ToolId): boolean {
  const tool = loadout[id];
  return !!tool && tool.charge > 0 && CARRY_CONDITION_FACTOR[tool.condition] > 0;
}

export function consumeTool(
  loadout: CarryLoadout,
  id: ToolId,
  amount: number
): boolean {
  if (!Number.isFinite(amount) || amount <= 0) return false;
  const tool = loadout[id];
  if (!tool || !toolAvailable(loadout, id)) return false;
  if (amount > tool.charge + 1e-9) return false;

  tool.charge = Math.max(0, tool.charge - amount);
  if (tool.charge <= 0) {
    tool.charge = 0;
    tool.condition = 'empty';
  }
  return true;
}
