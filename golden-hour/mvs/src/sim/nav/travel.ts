import { FIXED_DT } from '../spatial/spread';
import { stepActor, type ActorState } from '../spatial/actor';
import type { BuildingGraph, RoomLink } from '../spatial/rooms';
import { canTraverse, type Route } from './graph';
import { linkStaminaCost, takeLink } from './movement';

export interface TravelResult {
  ok: boolean;
  roomId: string;
  time: number;
  failedLink: RoomLink | null;
}

/**
 * 先预检整条路线，再逐段结算体力与暴露。
 * 每段把玩家放在房间入口锚点，用 stepActor 按该房间的实际格值累积暴露。
 * 不推进火灾时钟（由调用方推进）。
 */
export function travelRoute(
  graph: BuildingGraph,
  route: Route,
  actor: ActorState,
  fromRoom: string
): TravelResult {
  let projected = actor.stamina;
  for (const step of route.steps) {
    if (!canTraverse(step, { ...actor, stamina: projected })) {
      return { ok: false, roomId: fromRoom, time: 0, failedLink: step };
    }
    projected = Math.max(0, projected - linkStaminaCost(step, actor));
  }

  let room = fromRoom;
  let time = 0;

  for (const step of route.steps) {
    if (!takeLink(actor, step)) {
      return { ok: false, roomId: room, time, failedLink: step };
    }
    room = step.a === room ? step.b : step.a;

    const node = graph.rooms[room];
    if (node) {
      actor.x = 0;
      actor.z = 0;
      const ticks = Math.max(1, Math.round(step.time / FIXED_DT));
      for (let i = 0; i < ticks; i++) {
        stepActor(actor, node.room, FIXED_DT, true);
      }
    }

    time += step.time;
  }

  return { ok: true, roomId: room, time, failedLink: null };
}
