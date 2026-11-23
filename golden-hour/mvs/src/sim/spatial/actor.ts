import { cellAt, clamp01, type RoomState } from './fields';
import { clampToRoom, worldToGrid } from './coords';

export type Stance = 'upright' | 'low' | 'crawl';

export interface ActorState {
  x: number;
  z: number;
  stance: Stance;
  load: number;
  stamina: number;
  exposure: { smoke: number; heat: number };
  downed: boolean;
}

export function createActor(x = -2.35, z = 0): ActorState {
  return {
    x,
    z,
    stance: 'upright',
    load: 0,
    stamina: 1,
    exposure: { smoke: 0, heat: 0 },
    downed: false,
  };
}

export function stanceFactor(stance: Stance): number {
  if (stance === 'crawl') return 0.12;
  if (stance === 'low') return 0.22;
  return 0.45;
}

export function exposureAt(
  actor: ActorState,
  room: RoomState
): { smoke: number; heat: number } {
  const g = worldToGrid(actor.x, actor.z);
  const x = Math.min(room.config.cols - 1, Math.max(0, g.x));
  const y = Math.min(room.config.rows - 1, Math.max(0, g.y));
  const c = cellAt(room, x, y);
  return { smoke: c.smoke + c.steam * 0.5, heat: c.heat };
}

export function stepActor(
  actor: ActorState,
  room: RoomState,
  dt: number,
  moving: boolean
): void {
  if (actor.downed) return;

  const env = exposureAt(actor, room);
  actor.exposure.smoke += env.smoke * stanceFactor(actor.stance) * dt;
  actor.exposure.heat += env.heat * (actor.stance === 'crawl' ? 0.1 : 0.22) * dt;

  if (moving) {
    const drain = (actor.stance === 'upright' ? 0.06 : 0.03) * (1 + actor.load);
    actor.stamina = clamp01(actor.stamina - drain * dt);
  } else {
    actor.stamina = clamp01(actor.stamina + 0.04 * dt);
  }

  if (actor.exposure.smoke + actor.exposure.heat >= 1) {
    actor.downed = true;
  }
}

export function moveActor(
  actor: ActorState,
  dx: number,
  dz: number,
  dt: number,
  speedBase = 1.6
): void {
  if (actor.downed) return;
  const len = Math.hypot(dx, dz);
  if (len <= 0) return;

  const stancePenalty = actor.stance === 'crawl' ? 0.4 : actor.stance === 'low' ? 0.6 : 1;
  const loadPenalty = 1 - Math.min(0.45, actor.load * 0.45);
  const staminaPenalty = 0.6 + actor.stamina * 0.4;
  const speed = speedBase * stancePenalty * loadPenalty * staminaPenalty;
  const next = clampToRoom(
    actor.x + (dx / len) * speed * dt,
    actor.z + (dz / len) * speed * dt
  );
  actor.x = next.x;
  actor.z = next.z;
}
