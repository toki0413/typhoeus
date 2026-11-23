import { cellAt, clamp01, type RoomState } from './fields';
import { worldToGrid } from './coords';
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
}

const OCCUPANT_SMOKE_RATE = 0.05;
const OCCUPANT_HEAT_RATE = 0.04;
const CARRY_PROTECTION = 0.4;

export function createOccupant(
  x = 2.2,
  z = 2,
  id = 'resident-202'
): OccupantState {
  return { id, x, z, mood: 'panic', carried: false, rescued: false, health: 1 };
}

export function distance(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

export function attachOccupant(actor: ActorState, occupant: OccupantState): boolean {
  if (occupant.rescued || occupant.carried) return false;
  if (distance(actor.x, actor.z, occupant.x, occupant.z) > 0.9) return false;
  occupant.carried = true;
  actor.load = clamp01(actor.load + 0.55);
  return true;
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
  if (occupant.rescued) return false;

  if (!occupant.carried) {
    if (distance(actor.x, actor.z, occupant.x, occupant.z) > 0.9) return false;
  }

  const opening = room.openings[exit];
  if (!opening.open && !opening.broken) return false;

  const exitX = exit === 'door' ? -3 : 3;
  if (distance(actor.x, actor.z, exitX, 0) > 1.2) return false;

  occupant.rescued = true;
  occupant.carried = false;
  actor.load = clamp01(actor.load - 0.55);
  return true;
}
