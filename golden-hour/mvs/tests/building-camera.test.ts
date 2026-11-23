import { describe, it, expect } from 'vitest';
import { createBuilding } from '../src/sim/spatial/rooms';
import { shotFor, shotForRoom } from '../src/render/buildingCam';

describe('建筑切镜', () => {
  it('不同房间的机位不同', () => {
    const a = shotFor('room-202-F1', 1, 0, 0);
    const b = shotFor('room-201-F1', 1, 0, 1);
    expect(a.position.join(',')).not.toBe(b.position.join(','));
  });

  it('烟越浓，机位越贴近、越压低', () => {
    const clear = shotFor('room-202-F1', 1, 0);
    const smoky = shotFor('room-202-F1', 1, 1);
    expect(smoky.zoom).toBeGreaterThan(clear.zoom);
    expect(smoky.position[1]).toBeLessThan(clear.position[1]);
  });

  it('同一输入结果稳定', () => {
    expect(shotFor('room-202-F1', 1, 0.4, 3)).toEqual(shotFor('room-202-F1', 1, 0.4, 3));
  });

  it('建筑里 11 个房间的机位互不相同且有最小间距', () => {
    const graph = createBuilding();
    const ids = Object.keys(graph.rooms);
    const shots = ids.map((id) => shotForRoom(graph, id, 0));
    const keys = new Set(shots.map((shot) => shot.position.join(',')));
    expect(keys.size).toBe(ids.length);

    const xs = shots.map((shot) => shot.position[0]).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(0.3);
    }
  });

  it('烟浓度被钳制在 0..1', () => {
    expect(shotFor('room-202-F1', 1, 2)).toEqual(shotFor('room-202-F1', 1, 1));
    expect(shotFor('room-202-F1', 1, -1)).toEqual(shotFor('room-202-F1', 1, 0));
  });

  it('负楼层被钳制到 0', () => {
    expect(shotFor('room-202-F1', -3, 0)).toEqual(shotFor('room-202-F1', 0, 0));
  });

  it('目标高度随楼层上升', () => {
    const first = shotFor('room-202-F1', 0, 0);
    const third = shotFor('room-202-F1', 2, 0);
    expect(third.target[1]).toBeGreaterThan(first.target[1]);
  });

  it('返回结构包含 roomId 回显', () => {
    expect(shotFor('room-202-F1', 1, 0).roomId).toBe('room-202-F1');
  });
});
