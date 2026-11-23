import { clamp01 } from '../sim/spatial/fields';
import type { BuildingGraph } from '../sim/spatial/rooms';
import { FLOOR_H } from './constants';

export interface BuildingShot {
  roomId: string;
  position: [number, number, number];
  target: [number, number, number];
  zoom: number;
}

const SLOT_SPACING = 0.45;
const JITTER = 0.04;
const CAMERA_BACK = 7.5;
const TARGET_HEIGHT = 1.2;
const SMOKE_CLOSENESS = 0.8;
const SMOKE_DROP = 1.4;
const SMOKE_ZOOM = 0.5;
const LEAN_RANGE = 0.4;

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * 房间机位只由 roomId / floor / smoke / slot 决定，保证切镜稳定可复现。
 * position 与 target 都是世界坐标；target 是看向的点。
 */
export function shotFor(
  roomId: string,
  floor: number,
  smoke: number,
  slot = 0
): BuildingShot {
  const s = clamp01(smoke);
  const f = Math.max(0, Math.floor(floor));
  const hash = hashString(roomId);
  const jitter = ((hash % 101) / 100 - 0.5) * JITTER * 2;
  const offset = (slot - 5) * SLOT_SPACING + jitter;
  const lean = (((hash >>> 11) % 1000) / 1000 - 0.5) * LEAN_RANGE;
  const closeness = 1 + s * SMOKE_CLOSENESS;
  const targetY = f * FLOOR_H + TARGET_HEIGHT;

  return {
    roomId,
    position: [offset, targetY + FLOOR_H - s * SMOKE_DROP, CAMERA_BACK / closeness],
    target: [lean, targetY, 0],
    zoom: 1 + s * SMOKE_ZOOM,
  };
}

/** 用建筑内排序后的房间序号作为机位槽，保证同层机位有足够间距。 */
export function shotForRoom(
  graph: BuildingGraph,
  roomId: string,
  smoke: number
): BuildingShot {
  const ids = Object.keys(graph.rooms).sort();
  const slot = Math.max(0, ids.indexOf(roomId));
  const room = graph.rooms[roomId];
  return shotFor(roomId, room ? room.floor : 0, smoke, slot);
}
