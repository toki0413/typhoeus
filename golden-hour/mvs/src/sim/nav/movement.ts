import { clamp01 } from '../spatial/fields';
import type { ActorState } from '../spatial/actor';
import type { RoomLink } from '../spatial/rooms';
import { canTraverse } from './graph';

/** 进入一条连接；返回是否成功。楼梯/梯子按连接耗时扣体力。 */
export function takeLink(actor: ActorState, link: RoomLink): boolean {
  if (!canTraverse(link, actor)) return false;

  if (link.kind === 'stair' || link.kind === 'ladder') {
    actor.stamina = clamp01(actor.stamina - link.time * 0.012 * (1 + actor.load));
  }
  if (link.kind === 'breach' || link.kind === 'window') {
    actor.stamina = clamp01(actor.stamina - link.time * 0.02);
  }

  return true;
}
