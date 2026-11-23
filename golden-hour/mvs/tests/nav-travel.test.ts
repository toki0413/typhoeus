import { describe, it, expect } from 'vitest';
import { createBuilding } from '../src/sim/spatial/rooms';
import { createActor } from '../src/sim/spatial/actor';
import { createBuildingScenario, stepScenario } from '../src/sim/spatial/scene';
import { findRoutes } from '../src/sim/nav/graph';
import { travelRoute } from '../src/sim/nav/travel';

describe('路线结算', () => {
  it('成功走完路线并到达目标房间', () => {
    const graph = createBuilding();
    const actor = createActor();
    const routes = findRoutes(graph, 'entrance', 'room-202-F1', actor, 3);
    const result = travelRoute(graph, routes[0], actor, 'entrance');
    expect(result.ok).toBe(true);
    expect(result.roomId).toBe('room-202-F1');
    expect(result.time).toBe(routes[0].time);
    expect(actor.stamina).toBeLessThan(1);
  });

  it('路线后段不可通过时预检失败且不扣体力', () => {
    const graph = createBuilding();
    const actor = createActor();
    const routes = findRoutes(graph, 'entrance', 'room-202-F1', actor, 3);
    const ladderRoute = routes.find((r) => r.steps.some((s) => s.kind === 'ladder'))!;
    actor.load = 0.9;
    const before = actor.stamina;
    const result = travelRoute(graph, ladderRoute, actor, 'entrance');
    expect(result.ok).toBe(false);
    expect(actor.stamina).toBe(before);
  });

  it('经过有烟的房间会累积暴露', () => {
    const def = createBuildingScenario();
    for (let i = 0; i < 300; i++) stepScenario(def, 0.1);
    const actor = createActor();
    const routes = findRoutes(def.building, 'entrance', 'room-202-F1', actor, 3);
    const result = travelRoute(def.building, routes[0], actor, 'entrance');
    expect(result.ok).toBe(true);
    expect(actor.exposure.smoke).toBeGreaterThan(0);
  });
});
