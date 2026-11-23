import { CELL_SIZE, ROOM_COLS, ROOM_ROWS } from './fields';

export const ROOM_SIZE_M = CELL_SIZE * ROOM_COLS;

export function worldToGrid(wx: number, wz: number): { x: number; y: number } {
  return {
    x: Math.floor((wx + ROOM_SIZE_M / 2) / CELL_SIZE),
    y: Math.floor((wz + ROOM_SIZE_M / 2) / CELL_SIZE),
  };
}

export function gridToWorld(x: number, y: number): { x: number; z: number } {
  return {
    x: (x + 0.5) * CELL_SIZE - ROOM_SIZE_M / 2,
    z: (y + 0.5) * CELL_SIZE - ROOM_SIZE_M / 2,
  };
}

export function clampToRoom(
  wx: number,
  wz: number,
  margin = 0.25
): { x: number; z: number } {
  const half = ROOM_SIZE_M / 2 - margin;
  const halfZ = (CELL_SIZE * ROOM_ROWS) / 2 - margin;
  return {
    x: Math.min(half, Math.max(-half, wx)),
    z: Math.min(halfZ, Math.max(-halfZ, wz)),
  };
}
