import { describe, it, expect } from 'vitest';
import { createActor } from '../src/sim/spatial/actor';
import { createBuilding } from '../src/sim/spatial/rooms';
import { canTraverse } from '../src/sim/nav/graph';
import { takeLink } from '../src/sim/nav/movement';

describe('上下楼与连接', () => {
  it('走楼梯消耗体力但不失败', () => {
    const graph = createBuilding();
    const stair = graph.links.find((l) => l.kind === 'stair')!;
    const actor = createActor();
    const before = actor.stamina;
    expect(takeLink(actor, stair)).toBe(true);
    expect(actor.stamina).toBeLessThan(before);
  });

  it('负重过高时梯子拒绝通过', () => {
    const graph = createBuilding();
    const ladder = graph.links.find((l) => l.kind === 'ladder')!;
    const actor = createActor();
    actor.load = 0.9;
    expect(canTraverse(ladder, actor)).toBe(false);
    expect(takeLink(actor, ladder)).toBe(false);
  });

  it('坍塌的连接不能通过', () => {
    const graph = createBuilding();
    const link = graph.links[0];
    link.blocked = true;
    const actor = createActor();
    expect(takeLink(actor, link)).toBe(false);
  });

  it('体力不会降到 0 以下', () => {
    const graph = createBuilding();
    const stair = graph.links.find((l) => l.kind === 'stair')!;
    const actor = createActor();
    actor.stamina = 0.01;
    takeLink(actor, stair);
    expect(actor.stamina).toBeGreaterThanOrEqual(0);
  });

  it('破拆与翻窗也消耗体力', () => {
    const graph = createBuilding();
    const breach = graph.links.find((l) => l.kind === 'breach')!;
    const window = graph.links.find((l) => l.kind === 'window')!;
    const actor = createActor();

    const before = actor.stamina;
    expect(takeLink(actor, breach)).toBe(true);
    const afterBreach = actor.stamina;
    expect(afterBreach).toBeLessThan(before);

    expect(takeLink(actor, window)).toBe(true);
    expect(actor.stamina).toBeLessThan(afterBreach);
  });
});
