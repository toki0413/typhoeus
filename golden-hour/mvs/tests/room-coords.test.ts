import { describe, it, expect } from 'vitest';
import {
  ROOM_SIZE_M,
  clampToRoom,
  gridToWorld,
  worldToGrid,
} from '../src/sim/spatial/coords';

describe('房间坐标', () => {
  it('房间边长是 6 米', () => {
    expect(ROOM_SIZE_M).toBe(6);
  });

  it('网格中心与世界坐标互为逆运算', () => {
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const w = gridToWorld(x, y);
        expect(worldToGrid(w.x, w.z)).toEqual({ x, y });
      }
    }
  });

  it('把越界点夹回房间内', () => {
    expect(clampToRoom(99, -99)).toEqual({ x: 2.75, z: -2.75 });
  });
});
