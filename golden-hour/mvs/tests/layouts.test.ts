import { describe, it, expect } from 'vitest';
import {
  LAYOUTS,
  createLayout,
  layoutById,
  validateLayout,
} from '../src/content/layouts';
import type { BuildingGraph } from '../src/sim/spatial/rooms';

function cloneGraph(graph: BuildingGraph): BuildingGraph {
  return {
    rooms: { ...graph.rooms },
    links: graph.links.map((link) => ({ ...link })),
  };
}

describe('户型内容', () => {
  it('4 个户型 id 唯一、label 非空，入口与目标都存在且不相等', () => {
    expect(LAYOUTS).toHaveLength(4);

    const ids = LAYOUTS.map((layout) => layout.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const layout of LAYOUTS) {
      expect(layout.label.trim().length).toBeGreaterThan(0);

      const graph = layout.build();
      expect(graph.rooms[layout.entrance]).toBeDefined();
      expect(graph.rooms[layout.target]).toBeDefined();
      expect(layout.entrance).not.toBe(layout.target);
    }
  });

  it('每个户型都能通过校验', () => {
    for (const layout of LAYOUTS) {
      expect(validateLayout(layout.build(), layout.entrance)).toEqual([]);
    }
  });

  it('房间数在 5–13，楼层在 0..2，每间房 8×8 格', () => {
    for (const layout of LAYOUTS) {
      const graph = layout.build();
      const rooms = Object.values(graph.rooms);

      expect(rooms.length).toBeGreaterThanOrEqual(5);
      expect(rooms.length).toBeLessThanOrEqual(13);

      for (const node of rooms) {
        expect(node.floor).toBeGreaterThanOrEqual(0);
        expect(node.floor).toBeLessThanOrEqual(2);
        expect(node.room.cells.length).toBe(64);
      }
    }
  });

  it('连接覆盖 door、stair 以及 window/ladder 之一', () => {
    for (const layout of LAYOUTS) {
      const graph = layout.build();
      const kinds = new Set(graph.links.map((link) => link.kind));

      expect(kinds.has('door')).toBe(true);
      expect(kinds.has('stair')).toBe(true);
      expect(kinds.has('window') || kinds.has('ladder')).toBe(true);
    }
  });

  it('未知 id 回退到第一个户型，classic 可以按 id 查到', () => {
    const fallback = createLayout('不存在的id');
    const first = LAYOUTS[0].build();

    expect(Object.keys(fallback.rooms).sort()).toEqual(Object.keys(first.rooms).sort());

    const classic = layoutById('classic');
    expect(classic).toBeDefined();
    expect(classic?.id).toBe('classic');
  });

  it('校验器能发现端点不存在的连接', () => {
    const base = layoutById('classic')!.build();
    const graph = cloneGraph(base);
    graph.links.push({
      id: 'LX',
      a: base.links[0].a,
      b: '不存在房间',
      kind: 'door',
      time: 2,
      risk: 0.1,
      blocked: false,
      aAnchor: { x: 0, z: 0 },
      bAnchor: { x: 0, z: 0 },
    });

    expect(validateLayout(graph, 'entrance').length).toBeGreaterThan(0);
  });

  it('校验器能发现耗时非正的连接', () => {
    const base = LAYOUTS[1].build();
    const graph = cloneGraph(base);
    graph.links.push({
      id: 'LX',
      a: base.links[0].a,
      b: base.links[0].b,
      kind: 'door',
      time: 0,
      risk: 0.1,
      blocked: false,
      aAnchor: { x: 0, z: 0 },
      bAnchor: { x: 0, z: 0 },
    });

    expect(validateLayout(graph, 'entrance').length).toBeGreaterThan(0);
  });
});
