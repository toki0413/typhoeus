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
  /** 佩戴空呼与防护装具：显著降低烟热累积，但仍非无敌 */
  masked: boolean;
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
    masked: false,
    downed: false,
  };
}

const STANCE: Record<Stance, { smoke: number; heat: number; move: number; drain: number }> = {
  upright: { smoke: 0.45, heat: 0.22, move: 1, drain: 0.06 },
  low: { smoke: 0.22, heat: 0.22, move: 0.6, drain: 0.03 },
  crawl: { smoke: 0.12, heat: 0.1, move: 0.4, drain: 0.03 },
};

/** 空呼与防护装具的暴露折减；消防员能支撑多次往返，但烟热仍在累积。 */
const MASK_SMOKE_FACTOR = 0.05;
const MASK_HEAT_FACTOR = 0.08;

export function stanceFactor(stance: Stance): number {
  return STANCE[stance].smoke;
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
  if (!Number.isFinite(dt) || dt <= 0) return;
  if (actor.downed) return;

  const profile = STANCE[actor.stance];
  const env = exposureAt(actor, room);
  const smokeFactor = actor.masked ? MASK_SMOKE_FACTOR : 1;
  const heatFactor = actor.masked ? MASK_HEAT_FACTOR : 1;
  actor.exposure.smoke = clamp01(
    actor.exposure.smoke + env.smoke * profile.smoke * smokeFactor * dt
  );
  actor.exposure.heat = clamp01(
    actor.exposure.heat + env.heat * profile.heat * heatFactor * dt
  );

  if (moving) {
    const drain = profile.drain * (1 + actor.load);
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
  if (!Number.isFinite(dx) || !Number.isFinite(dz) || !Number.isFinite(dt)) return;
  const len = Math.hypot(dx, dz);
  if (len <= 0) return;

  const loadPenalty = 1 - Math.min(0.45, actor.load * 0.45);
  const staminaPenalty = 0.6 + actor.stamina * 0.4;
  const speed = speedBase * STANCE[actor.stance].move * loadPenalty * staminaPenalty;
  const next = clampToRoom(
    actor.x + (dx / len) * speed * dt,
    actor.z + (dz / len) * speed * dt
  );
  actor.x = next.x;
  actor.z = next.z;
}
