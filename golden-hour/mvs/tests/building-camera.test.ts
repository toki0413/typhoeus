import { describe, it, expect } from 'vitest';
import { createBuilding } from '../src/sim/spatial/rooms';
import { shotFor } from '../src/render/buildingCam';

describe('建筑切镜', () => {
  it('不同房间的机位不同', () => {
    const a = shotFor('room-202-F1', 1, 0);
    const b = shotFor('room-201-F1', 1, 0);
    expect(a.position.join(',')).not.toBe(b.position.join(','));
  });

  it('烟越浓，机位越贴近、越压低', () => {
    const clear = shotFor('room-202-F1', 1, 0);
    const smoky = shotFor('room-202-F1', 1, 0.9);
    expect(smoky.zoom).toBeGreaterThan(clear.zoom);
    expect(smoky.position[1]).toBeLessThan(clear.position[1]);
  });

  it('同一输入结果稳定', () => {
    expect(shotFor('room-202-F1', 1, 0.4)).toEqual(shotFor('room-202-F1', 1, 0.4));
  });

  it('建筑里 11 个房间的机位互不相同', () => {
    const graph = createBuilding();
    const ids = Object.keys(graph.rooms);
    const keys = new Set(
      ids.map((id) => {
        const shot = shotFor(id, graph.rooms[id].floor, 0);
        return shot.position.join(',');
      })
    );
    expect(keys.size).toBe(ids.length);
  });
});
