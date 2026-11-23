import { describe, it, expect } from 'vitest';
import { createBuilding } from '../src/sim/spatial/rooms';
import { createActor } from '../src/sim/spatial/actor';
import { canTraverse, findRoutes } from '../src/sim/nav/graph';

describe('路线搜索', () => {
  it('入口到 202 至少三条路线，且类型不同', () => {
    const graph = createBuilding();
    const routes = findRoutes(graph, 'entrance', 'room-202-F1', createActor(), 3);
    expect(routes.length).toBe(3);

    const kinds = routes.map((r) => r.steps.map((s) => s.kind).join('>'));
    expect(kinds.some((k) => k.includes('stair'))).toBe(true);
    expect(kinds.some((k) => k.includes('ladder'))).toBe(true);
    expect(kinds.some((k) => k.includes('breach'))).toBe(true);
  });

  it('楼梯全部坍塌后仍能到达 202', () => {
    const graph = createBuilding();
    for (const link of graph.links) {
      if (link.kind === 'stair') link.blocked = true;
    }
    const routes = findRoutes(graph, 'entrance', 'room-202-F1', createActor(), 3);
    expect(routes.length).toBeGreaterThanOrEqual(1);
    expect(routes.every((r) => r.steps.every((s) => s.kind !== 'stair'))).toBe(true);
  });

  it('负重过高时不能走消防梯', () => {
    const graph = createBuilding();
    const loaded = createActor();
    loaded.load = 0.9;
    const routes = findRoutes(graph, 'entrance', 'room-202-F1', loaded, 3);
    expect(routes.every((r) => r.steps.every((s) => s.kind !== 'ladder'))).toBe(true);
  });

  it('canTraverse 对梯子检查体力与负重', () => {
    const graph = createBuilding();
    const ladder = graph.links.find((l) => l.kind === 'ladder')!;
    const actor = createActor();
    expect(canTraverse(ladder, actor)).toBe(true);
    actor.load = 0.9;
    expect(canTraverse(ladder, actor)).toBe(false);
  });
});
