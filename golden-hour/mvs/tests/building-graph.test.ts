import { describe, it, expect } from 'vitest';
import { createBuilding } from '../src/sim/spatial/rooms';

describe('建筑房间图', () => {
  it('包含入口、楼梯、202 与消防梯', () => {
    const graph = createBuilding();
    expect(graph.rooms.entrance).toBeDefined();
    expect(graph.rooms['stair-F1']).toBeDefined();
    expect(graph.rooms['room-202-F1']).toBeDefined();
    expect(graph.rooms['escape-F1']).toBeDefined();
  });

  it('每个连接的两端都存在', () => {
    const graph = createBuilding();
    for (const link of graph.links) {
      expect(graph.rooms[link.a]).toBeDefined();
      expect(graph.rooms[link.b]).toBeDefined();
    }
  });

  it('202 至少有三种不同的入口连接', () => {
    const graph = createBuilding();
    const links = graph.links.filter(
      (l) => l.a === 'room-202-F1' || l.b === 'room-202-F1'
    );
    const kinds = new Set(links.map((l) => l.kind));
    expect(kinds.size).toBeGreaterThanOrEqual(3);
  });

  it('链接 id 唯一且两次构建稳定', () => {
    const a = createBuilding();
    const b = createBuilding();
    const ids = a.links.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(b.links.map((l) => l.id)).toEqual(ids);
  });

  it('所有连接默认关闭且未破拆', () => {
    const graph = createBuilding();
    expect(graph.links.every((l) => !l.opening.open && !l.opening.broken)).toBe(true);
  });
});
