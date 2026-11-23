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

  it('普通门不消耗体力', () => {
    const graph = createBuilding();
    const door = graph.links.find((l) => l.kind === 'door')!;
    const actor = createActor();
    const before = actor.stamina;
    expect(takeLink(actor, door)).toBe(true);
    expect(actor.stamina).toBe(before);
  });

  it('被拒绝时体力不变', () => {
    const graph = createBuilding();
    const link = graph.links[0];
    link.blocked = true;
    const actor = createActor();
    const before = actor.stamina;
    expect(takeLink(actor, link)).toBe(false);
    expect(actor.stamina).toBe(before);
  });

  it('负重过高时翻窗被拒绝', () => {
    const graph = createBuilding();
    const window = graph.links.find((l) => l.kind === 'window')!;
    const actor = createActor();
    actor.load = 0.7;
    expect(takeLink(actor, window)).toBe(false);
  });

  it('楼梯消耗按公式精确计算', () => {
    const graph = createBuilding();
    const stair = graph.links.find((l) => l.kind === 'stair')!;
    const actor = createActor();
    actor.stamina = 1;
    actor.load = 0;
    takeLink(actor, stair);
    expect(actor.stamina).toBeCloseTo(1 - stair.time * 0.012, 10);
  });

  it('倒地后不能通过连接', () => {
    const graph = createBuilding();
    const stair = graph.links.find((l) => l.kind === 'stair')!;
    const actor = createActor();
    actor.downed = true;
    expect(takeLink(actor, stair)).toBe(false);
  });

  it('非法时间不会改变体力', () => {
    const graph = createBuilding();
    const stair = graph.links.find((l) => l.kind === 'stair')!;
    const actor = createActor();
    const before = actor.stamina;
    stair.time = -1;
    expect(takeLink(actor, stair)).toBe(false);
    expect(actor.stamina).toBe(before);
  });
});
