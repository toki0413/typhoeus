import { cellAt, clamp01, type RoomState } from './fields';
import { gridToWorld, worldToGrid } from './coords';
import type { ActorState } from './actor';

export type OccupantMood = 'calm' | 'panic' | 'unconscious';

export interface OccupantState {
  id: string;
  x: number;
  z: number;
  mood: OccupantMood;
  carried: boolean;
  rescued: boolean;
  health: number;
  /** 背起时实际加到玩家身上的负重，用于精确回退 */
  carryLoad: number;
}

const OCCUPANT_SMOKE_RATE = 0.05;
const OCCUPANT_HEAT_RATE = 0.04;
const CARRY_PROTECTION = 0.4;
const ATTACH_RANGE = 0.9;
const EXIT_RANGE = 1.2;
const CARRY_LOAD = 0.55;

export function createOccupant(
  x = 2.2,
  z = 2,
  id = 'resident-202'
): OccupantState {
  return {
    id,
    x,
    z,
    mood: 'panic',
    carried: false,
    rescued: false,
    health: 1,
    carryLoad: 0,
  };
}

export function distance(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

/** 返回离 (x,z) 最近的已打开/已破拆出口；没有可用出口时返回 null。 */
export function nearestOpenExit(
  room: RoomState,
  x: number,
  z: number
): 'door' | 'window' | null {
  let best: 'door' | 'window' | null = null;
  let bestDist = Infinity;

  for (const id of ['door', 'window'] as const) {
    const opening = room.openings[id];
    if (!opening.open && !opening.broken) continue;
    const point = gridToWorld(opening.x, opening.y);
    const d = distance(x, z, point.x, point.z);
    if (d < bestDist) {
      bestDist = d;
      best = id;
    }
  }

  return best;
}

export function attachOccupant(actor: ActorState, occupant: OccupantState): boolean {
  if (actor.downed) return false;
  if (occupant.rescued || occupant.carried) return false;
  if (distance(actor.x, actor.z, occupant.x, occupant.z) > ATTACH_RANGE) return false;

  const applied = Math.min(1 - actor.load, CARRY_LOAD);
  actor.load = clamp01(actor.load + applied);
  occupant.carryLoad = applied;
  occupant.carried = true;
  return true;
}

/** 背起后让居民跟随玩家位置；每帧在 stepOccupant 前调用。 */
export function syncCarriedOccupant(occupant: OccupantState, actor: ActorState): void {
  if (!occupant.carried) return;
  occupant.x = actor.x;
  occupant.z = actor.z;
}

export function stepOccupant(
  occupant: OccupantState,
  room: RoomState,
  dt: number
): void {
  if (occupant.rescued) return;
  if (!Number.isFinite(dt) || dt <= 0) return;

  const g = worldToGrid(occupant.x, occupant.z);
  const x = Math.min(room.config.cols - 1, Math.max(0, g.x));
  const y = Math.min(room.config.rows - 1, Math.max(0, g.y));
  const c = cellAt(room, x, y);
  const protection = occupant.carried ? CARRY_PROTECTION : 1;

  occupant.health = clamp01(
    occupant.health -
      (c.smoke * OCCUPANT_SMOKE_RATE + c.heat * OCCUPANT_HEAT_RATE) * protection * dt
  );
  if (occupant.health <= 0) occupant.mood = 'unconscious';
}

export function extractOccupant(
  occupant: OccupantState,
  actor: ActorState,
  room: RoomState,
  exit: 'door' | 'window'
): boolean {
  if (actor.downed) return false;
  if (occupant.rescued) return false;

  const opening = room.openings[exit];
  if (!opening.open && !opening.broken) return false;

  const exitPoint = gridToWorld(opening.x, opening.y);
  if (distance(actor.x, actor.z, exitPoint.x, exitPoint.z) > EXIT_RANGE) return false;

  if (!occupant.carried) {
    if (distance(actor.x, actor.z, occupant.x, occupant.z) > ATTACH_RANGE) return false;
    if (distance(occupant.x, occupant.z, exitPoint.x, exitPoint.z) > EXIT_RANGE) return false;
  }

  const wasCarried = occupant.carried;
  occupant.rescued = true;
  occupant.carried = false;
  if (wasCarried) {
    actor.load = Math.max(0, actor.load - occupant.carryLoad);
    occupant.carryLoad = 0;
  }
  return true;
}
