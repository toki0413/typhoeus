import type { FireClass } from './fields';

/**
 * 灭火剂与火灾类别的匹配表。
 *
 * 这张表就是“专业知识”的落点：同一个动作（喷水）对 A 类有效，对 B 类会把油火打散，
 * 对 D 类金属火甚至会发生剧烈反应。玩家没有对应灭火剂时，只能改用隔离 / 冷却 / 覆盖 / 撤离。
 */
export type AgentId =
  | 'water'
  | 'foam'
  | 'dryPowder'
  | 'co2'
  | 'wetChemical'
  | 'sand'
  | 'blanket';

export interface AgentSpec {
  id: AgentId;
  label: string;
  /** 对各类火的灭火效率 0..1 */
  effect: Record<FireClass, number>;
  /** 用错剂的反噬强度 0..1 */
  hazard: Record<FireClass, number>;
  /** 附带的冷却能力 */
  cooling: number;
  /** 是否留下水膜（持续抑制） */
  leavesWater: boolean;
}

const none: Record<FireClass, number> = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 };

function effects(overrides: Partial<Record<FireClass, number>>): Record<FireClass, number> {
  return { ...none, ...overrides };
}

export const AGENTS: Record<AgentId, AgentSpec> = {
  water: {
    id: 'water',
    label: '水枪 / 水带',
    effect: effects({ A: 1, F: 0.05 }),
    hazard: effects({ B: 0.85, C: 0.2, D: 1, E: 0.9, F: 0.9 }),
    cooling: 1,
    leavesWater: true,
  },
  foam: {
    id: 'foam',
    label: '泡沫',
    effect: effects({ A: 0.65, B: 1, F: 0.1 }),
    hazard: effects({ D: 0.4, E: 0.7 }),
    cooling: 0.7,
    leavesWater: true,
  },
  dryPowder: {
    id: 'dryPowder',
    label: 'ABC 干粉',
    effect: effects({ A: 0.85, B: 0.9, C: 1, E: 0.85, F: 0.2 }),
    hazard: effects({ D: 0.1 }),
    cooling: 0.15,
    leavesWater: false,
  },
  co2: {
    id: 'co2',
    label: '二氧化碳',
    effect: effects({ A: 0.35, B: 0.9, C: 0.9, E: 1, F: 0.15 }),
    hazard: effects({ D: 0.3 }),
    cooling: 0.35,
    leavesWater: false,
  },
  wetChemical: {
    id: 'wetChemical',
    label: '湿化学（F 类）',
    effect: effects({ F: 1, A: 0.15 }),
    hazard: effects({ D: 0.6, E: 0.6 }),
    cooling: 0.6,
    leavesWater: true,
  },
  sand: {
    id: 'sand',
    label: '干沙 / 覆盖',
    effect: effects({ D: 1, B: 0.7, F: 0.6 }),
    hazard: none,
    cooling: 0.1,
    leavesWater: false,
  },
  blanket: {
    id: 'blanket',
    label: '灭火毯 / 覆盖窒息',
    effect: effects({ F: 1, B: 0.5, A: 0.55 }),
    hazard: effects({ C: 0.2 }),
    cooling: 0,
    leavesWater: false,
  },
};

export interface FireClassInfo {
  label: string;
  fuels: string;
  recommended: AgentId[];
  /** 没有对应灭火剂时的替代处置 */
  fallback: string;
}

export const FIRE_CLASSES: Record<FireClass, FireClassInfo> = {
  A: {
    label: 'A 类 · 固体',
    fuels: '木材、纸张、布料、沙发',
    recommended: ['water', 'foam', 'dryPowder'],
    fallback: '没有水或干粉时：关门限氧、冷却周边、撤离等专业队。',
  },
  B: {
    label: 'B 类 · 液体',
    fuels: '汽油、油漆、松香水',
    recommended: ['foam', 'dryPowder', 'co2'],
    fallback: '没有泡沫/干粉时：断源、用沙土覆盖、冷却桶壁，严禁直流水柱冲击液面。',
  },
  C: {
    label: 'C 类 · 气体',
    fuels: '天然气、液化气',
    recommended: ['dryPowder', 'co2'],
    fallback: '没有干粉时：先关阀断气，不要贸然扑灭火焰（可能积聚可燃气），通风并撤离。',
  },
  D: {
    label: 'D 类 · 金属',
    fuels: '镁、钠、铝粉',
    recommended: ['sand'],
    fallback: '没有 D 类干粉/干沙时：只用干燥食盐或干沙覆盖隔离，严禁水、泡沫、CO₂。',
  },
  E: {
    label: 'E 类 · 带电',
    fuels: '配电箱、插座、电缆',
    recommended: ['co2', 'dryPowder'],
    fallback: '没有 CO₂/干粉时：先切断电源，再按 A 类处置；未断电严禁用水。',
  },
  F: {
    label: 'F 类 · 食用油',
    fuels: '厨房油锅、油脂',
    recommended: ['wetChemical', 'blanket'],
    fallback: '没有湿化学剂时：盖锅盖或灭火毯窒息、关火，严禁用水（会爆燃）。',
  },
};

export function agentEffect(agent: AgentId, fireClass: FireClass): number {
  return AGENTS[agent].effect[fireClass];
}

export function agentHazard(agent: AgentId, fireClass: FireClass): number {
  return AGENTS[agent].hazard[fireClass];
}

export function recommendedAgents(fireClass: FireClass): AgentId[] {
  return FIRE_CLASSES[fireClass].recommended;
}

export function isWrongAgent(agent: AgentId, fireClass: FireClass): boolean {
  return agentHazard(agent, fireClass) > 0.3 && agentEffect(agent, fireClass) < 0.3;
}

/** 哪些灭火剂对这类火既有效又安全，可直接用于 UI 的“正确工具”提示。 */
export function safeAgents(fireClass: FireClass): AgentId[] {
  return (Object.keys(AGENTS) as AgentId[]).filter(
    (id) => agentEffect(id, fireClass) >= 0.6 && agentHazard(id, fireClass) < 0.3
  );
}
