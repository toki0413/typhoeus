import { clamp01, roomSummary } from '../spatial/fields';
import type { ActorState } from '../spatial/actor';
import type { BuildingGraph, RoomLink } from '../spatial/rooms';
import { canTraverse, type Route } from './graph';
import { linkStaminaCost, takeLink } from './movement';

export interface TravelResult {
  ok: boolean;
  roomId: string;
  time: number;
  failedLink: RoomLink | null;
}

const SMOKE_EXPOSURE = 0.45;
const HEAT_EXPOSURE = 0.22;

/**
 * 先预检整条路线，再逐段结算体力与暴露。
 * 暴露按每段终点房间的烟/热 × 该段耗时累加；不推进火灾时钟（由调用方推进）。
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
    projected = clamp01(projected - linkStaminaCost(step, actor));
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
      const summary = roomSummary(node.room);
      actor.exposure.smoke = clamp01(
        actor.exposure.smoke + summary.smoke * SMOKE_EXPOSURE * step.time
      );
      actor.exposure.heat = clamp01(
        actor.exposure.heat + summary.heat * HEAT_EXPOSURE * step.time
      );
    }
    time += step.time;
  }

  return { ok: true, roomId: room, time, failedLink: null };
}
