import { clamp01 } from '../spatial/fields';
import type { ActorState } from '../spatial/actor';
import type { RoomLink } from '../spatial/rooms';
import { canTraverse } from './graph';

const STAIR_STAMINA_PER_SECOND = 0.012;
const FORCE_STAMINA_PER_SECOND = 0.02;

/**
 * 进入一条连接。
 *
 * 只做资格判定与体力代价：不推进时间、不移动位置、不改房间。
 * 每次通过只应调用一次，避免重复扣体力。
 */
export function takeLink(actor: ActorState, link: RoomLink): boolean {
  if (actor.downed) return false;
  if (!Number.isFinite(link.time) || link.time < 0) return false;
  if (!Number.isFinite(actor.load) || !Number.isFinite(actor.stamina)) return false;
  if (!canTraverse(link, actor)) return false;

  const load = Math.max(0, actor.load);
  const stamina = Math.max(0, actor.stamina);

  if (link.kind === 'stair' || link.kind === 'ladder') {
    actor.stamina = clamp01(
      stamina - link.time * STAIR_STAMINA_PER_SECOND * (1 + load)
    );
  }
  if (link.kind === 'breach' || link.kind === 'window') {
    // 破拆/翻窗是固定爆发消耗，不随负重线性放大。
    actor.stamina = clamp01(stamina - link.time * FORCE_STAMINA_PER_SECOND);
  }

  return true;
}
