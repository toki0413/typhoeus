/**
 * Phase 3 P3.2：多人救援（人群）模型。
 *
 * 一个 CrowdState 管理同房间的多个居民：按固定步长推进每个人的健康/恐慌，
 * 统计获救与失去（死亡）人数，并记录可复盘的事件。救援动作消耗模拟时间，
 * 期间的取舍会改变结果——先救轻伤还是先救濒死，是这一层要回答的问题。
 * 随机只来自 mulberry32 种子，不含 DOM/three/Math.random，可确定性重放。
 */

import { clamp01, type RoomState } from '../spatial/fields';
import type { ActorState } from '../spatial/actor';
import { mulberry32 } from '../rng';
import { FIXED_DT } from '../spatial/spread';
import { findResident, stepResident, type ResidentState } from './resident';

export type RescueVerb = 'lead' | 'carry';
export type RescueReason =
  | 'ok'
  | 'actor-downed'
  | 'already-rescued'
  | 'lost'
  | 'not-found'
  | 'too-far'
  | 'unconscious-needs-carry';

export interface RescueResult {
  ok: boolean;
  reason: RescueReason;
  residentId: string;
}

/** 多区域的门口：与抵达目标区域时的落点一致。 */
export const ZONE_EXIT = { x: -2.4, z: 0 };
/** 门口确认半径（米） */
export const CONFIRM_RADIUS = 1.5;

export type EscortReason =
  | 'ok'
  | 'actor-downed'
  | 'already-escorted'
  | 'already-rescued'
  | 'lost'
  | 'not-found'
  | 'too-far'
  | 'unconscious-needs-carry';

export interface EscortResult {
  ok: boolean;
  reason: EscortReason;
  residentId: string;
}

export type ConfirmReason = 'ok' | 'not-escorted' | 'already-rescued' | 'lost' | 'too-far';

export interface ConfirmResult {
  ok: boolean;
  reason: ConfirmReason;
  residentId: string;
}

export interface CrowdEvent {
  at: number;
  kind: 'rescued' | 'lost' | 'escorted';
  residentId: string;
  detail: string;
}

export interface CrowdState {
  roomId: string;
  seed: number;
  /** 由救援动作累计的模拟时间（秒） */
  t: number;
  residents: ResidentState[];
  rescued: number;
  lost: number;
  events: CrowdEvent[];
}

/** 牵行耗时（秒） */
export const LEAD_TIME = 4;
/** 背出耗时（秒） */
export const CARRY_TIME = 5;
/** 救援可及距离（米） */
export const RESCUE_REACH = 2;

/** 初始恐慌的确定性抖动幅度 */
const PANIC_JITTER = 0.05;

export function createCrowd(roomId: string, residents: ResidentState[], seed = 1): CrowdState {
  const rand = mulberry32(seed);
  // 按传入顺序消费随机数，保证同种子同输入得到同样的抖动
  for (const resident of residents) {
    resident.panic = clamp01(resident.panic + (rand() * 2 - 1) * PANIC_JITTER);
  }

  return {
    roomId,
    seed,
    t: 0,
    residents,
    rescued: 0,
    lost: 0,
    events: [],
  };
}

function distanceTo(resident: ResidentState, actor: ActorState): number {
  return Math.hypot(resident.x - actor.x, resident.z - actor.z);
}

/**
 * 优先救援顺序：健康越差越靠前，其次离玩家越近越靠前，最后按 id 保证确定性。
 * 已获救、已死亡与尚未被发现的躲藏者不会出现在列表里。
 */
export function survivorCandidates(crowd: CrowdState, actor: ActorState): ResidentState[] {
  return crowd.residents
    .filter((resident) => !resident.rescued && !resident.dead)
    .filter((resident) => findResident(resident, actor))
    .sort((a, b) => {
      if (a.health !== b.health) return a.health - b.health;
      const da = distanceTo(a, actor);
      const db = distanceTo(b, actor);
      if (da !== db) return da - db;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

/** 无人救援时的自然恶化；死亡一旦出现只记一次 lost 事件。 */
export function stepCrowd(crowd: CrowdState, room: RoomState, dt: number): void {
  if (!Number.isFinite(dt) || dt <= 0) return;

  for (const resident of crowd.residents) {
    stepResident(resident, room, dt);
  }
  crowd.t += dt;

  crowd.lost = crowd.residents.filter((resident) => resident.dead && !resident.rescued).length;

  for (const resident of crowd.residents) {
    if (!resident.dead || resident.rescued) continue;
    if (crowd.events.some((event) => event.kind === 'lost' && event.residentId === resident.id)) {
      continue;
    }
    crowd.events.push({
      at: crowd.t,
      kind: 'lost',
      residentId: resident.id,
      detail: `失去意识 ${resident.downedFor.toFixed(1)}s 后死亡`,
    });
  }
}

/**
 * 救援一名居民。校验不通过时立即返回原因且不消耗时间；
 * 通过后按动词消耗 4s/5s 的模拟时间（以 FIXED_DT 推进）。
 */
export function rescueResident(
  crowd: CrowdState,
  residentId: string,
  actor: ActorState,
  room: RoomState,
  verb: RescueVerb,
  reach = RESCUE_REACH
): RescueResult {
  if (actor.downed) return { ok: false, reason: 'actor-downed', residentId };

  const resident = crowd.residents.find((item) => item.id === residentId);
  if (!resident) return { ok: false, reason: 'not-found', residentId };

  if (resident.rescued) return { ok: false, reason: 'already-rescued', residentId };
  if (resident.dead) return { ok: false, reason: 'lost', residentId };
  if (!findResident(resident, actor)) return { ok: false, reason: 'not-found', residentId };
  if (distanceTo(resident, actor) > reach) {
    return { ok: false, reason: 'too-far', residentId };
  }
  // 失去意识（健康归零）的人无法牵着走，只能背
  if (verb === 'lead' && (resident.mood === 'unconscious' || resident.health <= 0)) {
    return { ok: false, reason: 'unconscious-needs-carry', residentId };
  }

  // 一旦开始救援，目标受保护直到完成：冻结掉血与死亡计时
  const wasCarried = resident.carried;
  resident.carried = true;

  const seconds = verb === 'carry' ? CARRY_TIME : LEAD_TIME;
  const ticks = Math.max(1, Math.round(seconds / FIXED_DT));
  for (let i = 0; i < ticks; i++) {
    stepCrowd(crowd, room, FIXED_DT);
  }
  resident.carried = wasCarried;

  resident.rescued = true;
  crowd.rescued++;
  crowd.events.push({
    at: crowd.t,
    kind: 'rescued',
    residentId,
    detail: `${verb === 'carry' ? '背出' : '牵出'}用时 ${seconds}s`,
  });

  return { ok: true, reason: 'ok', residentId };
}

/**
 * 把一名居民带离原位，等待送到门口确认。
 * 校验顺序与 rescueResident 一致，也会按动词消耗模拟时间、期间受 carried 保护；
 * 但成功后只标记 escorted，不增加 crowd.rescued，也不置 rescued。
 */
export function escortResident(
  crowd: CrowdState,
  residentId: string,
  actor: ActorState,
  room: RoomState,
  verb: RescueVerb,
  reach = RESCUE_REACH
): EscortResult {
  if (actor.downed) return { ok: false, reason: 'actor-downed', residentId };

  const resident = crowd.residents.find((item) => item.id === residentId);
  if (!resident) return { ok: false, reason: 'not-found', residentId };

  if (resident.rescued) return { ok: false, reason: 'already-rescued', residentId };
  if (resident.escorted) return { ok: false, reason: 'already-escorted', residentId };
  if (resident.dead) return { ok: false, reason: 'lost', residentId };
  if (!findResident(resident, actor)) return { ok: false, reason: 'not-found', residentId };
  if (distanceTo(resident, actor) > reach) {
    return { ok: false, reason: 'too-far', residentId };
  }
  // 失去意识（健康归零）的人无法牵着走，只能背
  if (verb === 'lead' && (resident.mood === 'unconscious' || resident.health <= 0)) {
    return { ok: false, reason: 'unconscious-needs-carry', residentId };
  }

  // 带离期间同样保护目标：冻结掉血与死亡计时
  resident.carried = true;

  const seconds = verb === 'carry' ? CARRY_TIME : LEAD_TIME;
  const ticks = Math.max(1, Math.round(seconds / FIXED_DT));
  for (let i = 0; i < ticks; i++) {
    stepCrowd(crowd, room, FIXED_DT);
  }

  // 成功后结束背起态，只保留“等待确认”
  resident.carried = false;
  resident.escorted = true;
  resident.hidden = false;
  crowd.events.push({
    at: crowd.t,
    kind: 'escorted',
    residentId,
    detail: '已带离，等待确认',
  });

  return { ok: true, reason: 'ok', residentId };
}

/**
 * 在门口确认送达：把 escorted 居民转为已救出，并计入 crowd.rescued。
 * 确认本身不消耗模拟时间，只校验状态与玩家到出口的距离。
 */
export function confirmResident(
  crowd: CrowdState,
  residentId: string,
  actor: ActorState
): ConfirmResult {
  // 倒地时无法完成交接，沿用“太远”让调用方给出位置类提示
  if (actor.downed) return { ok: false, reason: 'too-far', residentId };

  const resident = crowd.residents.find((item) => item.id === residentId);
  if (!resident) return { ok: false, reason: 'not-escorted', residentId };

  if (resident.rescued) return { ok: false, reason: 'already-rescued', residentId };
  if (resident.dead) return { ok: false, reason: 'lost', residentId };
  if (!resident.escorted) return { ok: false, reason: 'not-escorted', residentId };
  if (Math.hypot(actor.x - ZONE_EXIT.x, actor.z - ZONE_EXIT.z) > CONFIRM_RADIUS) {
    return { ok: false, reason: 'too-far', residentId };
  }

  resident.rescued = true;
  resident.escorted = false;
  crowd.rescued++;
  crowd.events.push({
    at: crowd.t,
    kind: 'rescued',
    residentId,
    detail: '送达门口确认',
  });

  return { ok: true, reason: 'ok', residentId };
}
