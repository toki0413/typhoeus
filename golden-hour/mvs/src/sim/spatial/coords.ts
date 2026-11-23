import { CELL_SIZE, ROOM_COLS, ROOM_ROWS } from './fields';

export const ROOM_SIZE_X = CELL_SIZE * ROOM_COLS;
export const ROOM_SIZE_Z = CELL_SIZE * ROOM_ROWS;
export const ROOM_SIZE_M = ROOM_SIZE_X;

const DEFAULT_MARGIN = 0.25;

/** 世界坐标 → 网格索引。结果始终夹在 0..cols-1 / 0..rows-1。 */
export function worldToGrid(wx: number, wz: number): { x: number; y: number } {
  const x = Math.floor((wx + ROOM_SIZE_X / 2) / CELL_SIZE);
  const y = Math.floor((wz + ROOM_SIZE_Z / 2) / CELL_SIZE);
  return {
    x: Math.min(ROOM_COLS - 1, Math.max(0, x)),
    y: Math.min(ROOM_ROWS - 1, Math.max(0, y)),
  };
}

/** 网格索引 → 该格中心的世界坐标。 */
export function gridToWorld(x: number, y: number): { x: number; z: number } {
  return {
    x: (x + 0.5) * CELL_SIZE - ROOM_SIZE_X / 2,
    z: (y + 0.5) * CELL_SIZE - ROOM_SIZE_Z / 2,
  };
}

export function clampToRoom(
  wx: number,
  wz: number,
  margin = DEFAULT_MARGIN
): { x: number; z: number } {
  const halfX = ROOM_SIZE_X / 2 - margin;
  const halfZ = ROOM_SIZE_Z / 2 - margin;
  return {
    x: Math.min(halfX, Math.max(-halfX, wx)),
    z: Math.min(halfZ, Math.max(-halfZ, wz)),
  };
}
