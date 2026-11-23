/**
 * Phase 3 P3.1：居民（受困者）行为模型。
 *
 * 每个居民读取自己所在格的烟/热：健康与伤情按固定速率变化，恐慌随烟热升降；
 * 恐慌超过阈值的居民会朝附近烟最小的相邻格自行避险；失去意识后彻底静止。
 * 更新过程只依赖房间场与 dt，不含随机数、DOM 或 three，可确定性重放。
 */

import { cellAt, clamp01, type RoomState } from '../spatial/fields';
import { clampToRoom, worldToGrid } from '../spatial/coords';
import type { ActorState } from '../spatial/actor';

export type ResidentMood = 'calm' | 'panic' | 'hidden' | 'unconscious';

export interface ResidentState {
  id: string;
  roomId: string;
  x: number;
  z: number;
  mood: ResidentMood;
  /** 0..1，随烟/热上升，安全时缓慢回落 */
  panic: number;
  /** 躲藏状态；初始 mood='hidden' 的居民为 true */
  hidden: boolean;
  /** 1..0 */
  health: number;
  /** 0..1，累计伤情（只增不减，供复盘/视图使用） */
  injury: number;
  /** 被背起中 */
  carried: boolean;
  /** 已救出 */
  rescued: boolean;
}

/** 每秒健康损失：烟与热各一项 */
const SMOKE_DAMAGE_RATE = 0.05;
const HEAT_DAMAGE_RATE = 0.04;

/** 恐慌上升：呛烟比炙烤更快击溃心理，所以烟的权重更高 */
const SMOKE_PANIC_GAIN = 0.6;
const HEAT_PANIC_GAIN = 0.4;
/** 安全格里的恐慌回落速度（每秒） */
const PANIC_RELAX = 0.08;
/** 超过该阈值才主动避险 */
const PANIC_THRESHOLD = 0.4;

/** 判定“安全格”的烟/热上限，低于此值开始镇定 */
const SAFE_SMOKE = 0.05;
const SAFE_HEAT = 0.1;

/** 避险移动速度 m/s */
const FLEE_SPEED = 1.2;
/** 与当前格烟量比较时的容差，避免浮点抖动导致原地反复 */
const SMOKE_EPSILON = 1e-9;

export function createResident(
  roomId: string,
  x = 0,
  z = 0,
  id = `resident-${roomId}`
): ResidentState {
  return {
    id,
    roomId,
    x,
    z,
    mood: 'calm',
    panic: 0,
    hidden: false,
    health: 1,
    injury: 0,
    carried: false,
    rescued: false,
  };
}

/** 在当前格 8 邻域里找烟最小的格；没有更低者（或同烟）返回 null。 */
function calmestNeighbour(
  room: RoomState,
  gx: number,
  gy: number
): { x: number; y: number } | null {
  const currentSmoke = cellAt(room, gx, gy).smoke;
  let best: { x: number; y: number } | null = null;
  let bestSmoke = currentSmoke;

  // 固定遍历顺序保证同分时结果确定
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = gx + dx;
      const ny = gy + dy;
      if (nx < 0 || ny < 0 || nx >= room.config.cols || ny >= room.config.rows) continue;
      const smoke = cellAt(room, nx, ny).smoke;
      if (smoke < bestSmoke - SMOKE_EPSILON) {
        bestSmoke = smoke;
        best = { x: nx, y: ny };
      }
    }
  }

  return best;
}

export function stepResident(resident: ResidentState, room: RoomState, dt: number): void {
  // 被背起或已救出的居民受保护：轻伤不再累积，也不自行移动
  if (resident.rescued || resident.carried) return;
  if (!Number.isFinite(dt) || dt <= 0) return;

  const g = worldToGrid(resident.x, resident.z);
  const gx = Math.min(room.config.cols - 1, Math.max(0, g.x));
  const gy = Math.min(room.config.rows - 1, Math.max(0, g.y));
  const cell = cellAt(room, gx, gy);

  const damage = (cell.smoke * SMOKE_DAMAGE_RATE + cell.heat * HEAT_DAMAGE_RATE) * dt;
  resident.health = clamp01(resident.health - damage);
  resident.injury = clamp01(resident.injury + damage);

  if (cell.smoke <= SAFE_SMOKE && cell.heat <= SAFE_HEAT) {
    resident.panic = clamp01(resident.panic - PANIC_RELAX * dt);
  } else {
    resident.panic = clamp01(
      resident.panic + (cell.smoke * SMOKE_PANIC_GAIN + cell.heat * HEAT_PANIC_GAIN) * dt
    );
  }

  if (resident.health <= 0) {
    resident.mood = 'unconscious';
    resident.hidden = false;
    return;
  }

  // 躲藏居民不移动，心情固定为 hidden
  if (resident.hidden) {
    resident.mood = 'hidden';
    return;
  }

  resident.mood = resident.panic > PANIC_THRESHOLD ? 'panic' : 'calm';
  if (resident.panic <= PANIC_THRESHOLD) return;

  const target = calmestNeighbour(room, gx, gy);
  if (!target) return;

  const dx = Math.sign(target.x - gx);
  const dz = Math.sign(target.y - gy);
  const len = Math.hypot(dx, dz);

  const next = clampToRoom(
    resident.x + (dx / len) * FLEE_SPEED * dt,
    resident.z + (dz / len) * FLEE_SPEED * dt
  );
  resident.x = next.x;
  resident.z = next.z;
}

export function findResident(
  resident: ResidentState,
  actor: ActorState,
  radius = 2
): boolean {
  if (resident.rescued) return false;
  if (!resident.hidden) return true;
  return Math.hypot(resident.x - actor.x, resident.z - actor.z) <= radius;
}
