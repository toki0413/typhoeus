/**
 * Phase 5 P5.4：存档与恢复。
 *
 * 整份存档只由普通对象与数组组成，可直接 JSON 序列化；不涉及 DOM、three、
 * 随机数与真实时间，时间一律取模拟时刻，保证同一存档可确定性恢复。
 */

import type { ScenarioDefinition } from '../sim/spatial/scene';
import type { ActorState } from '../sim/spatial/actor';
import type { CrowdState } from '../sim/agents/crowd';
import type { DirectorState } from '../sim/events/director';
import type { CarryLoadout } from '../sim/interaction/tools';

export const SAVE_VERSION = 1;

export interface SaveInput {
  def: ScenarioDefinition;
  actor: ActorState;
  crowd: CrowdState;
  director: DirectorState;
  currentRoom: string;
  /** 随身器材余量与状态；旧存档没有该字段，缺省时按新建器材处理。 */
  loadout?: CarryLoadout;
}

export interface GameSave extends SaveInput {
  version: number;
  /** 存档对应的模拟时刻（取 def 目标房间的 room.t），不是真实时间 */
  simTime: number;
}

/** 以当前状态生成存档；时刻从目标房间读取，避免引入真实时间。 */
export function createSave(input: SaveInput): GameSave {
  return {
    version: SAVE_VERSION,
    simTime: input.def.building.rooms[input.def.targetRoom].room.t,
    ...input,
  };
}

/** 所有字段都是 JSON 安全的普通数据，直接字符串化即可。 */
export function serializeSave(save: GameSave): string {
  return JSON.stringify(save);
}

/** 解析并校验存档；版本不符或缺关键字段时抛出中文错误。 */
export function deserializeSave(text: string): GameSave {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('存档解析失败：不是合法的 JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('存档格式错误：根节点必须是对象');
  }

  const record = parsed as Partial<GameSave>;
  if (record.version !== SAVE_VERSION) {
    throw new Error(
      `存档版本不兼容：期望 ${SAVE_VERSION}，实际 ${String(record.version)}`
    );
  }

  for (const key of ['def', 'actor', 'crowd', 'director'] as const) {
    const value = record[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`存档缺少字段：${key}`);
    }
  }

  return record as GameSave;
}

/** FNV-1a 32 位；用于比较两份存档是否等价。 */
export function saveHash(save: GameSave): number {
  const text = JSON.stringify(save);
  let hash = 0x811c9dc5;

  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash >>> 0;
}
