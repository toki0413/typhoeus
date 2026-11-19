import { describe, it, expect } from 'vitest';
import { stepSmoke } from '../src/sim/smoke';
import { createWorld } from '../src/sim/world';
import { stepSim } from '../src/sim/step';

const advance = (s: ReturnType<typeof createWorld>, sec: number) => {
  for (let i = 0; i < sec * 20; i++) stepSim(s, 1 / 20);
};

describe('stepSmoke', () => {
  it('有火时一层烟气上升且不超过 1', () => {
    const smoke = [0, 0];
    for (let i = 0; i < 20 * 30; i++) stepSmoke(smoke, 0.8, 1 / 20);
    expect(smoke[0]).toBeGreaterThan(0.5);
    expect(smoke[1]).toBeGreaterThan(0);
    expect(smoke.every((v) => v <= 1)).toBe(true);
  });

  it('烟气会向上层传递', () => {
    const smoke = [0.9, 0];
    stepSmoke(smoke, 0, 1 / 20);
    expect(smoke[1]).toBeGreaterThan(0);
  });

  it('无火时烟气会衰减', () => {
    const smoke = [0.8, 0.8];
    stepSmoke(smoke, 0, 1 / 20);
    expect(smoke[0]).toBeLessThan(0.8);
    expect(smoke[1]).toBeLessThan(0.8);
  });
});

describe('stepSim', () => {
  it('暴露值随停留时间上升且不超过 1', () => {
    const s = createWorld('x');
    advance(s, 60);
    expect(s.exposure.smoke).toBeGreaterThan(0);
    expect(s.exposure.smoke).toBeLessThanOrEqual(1);
    expect(s.t).toBeCloseTo(60, 1);
  });

  it('40 秒前火势不会封顶，之后加速', () => {
    const s = createWorld('x');
    advance(s, 40);
    expect(s.fire).toBeLessThan(0.95);
    const at40 = s.fire;
    advance(s, 5);
    expect(s.fire - at40).toBeGreaterThan(0.05);
  });

  it('班组到达一层门时 atDoor 为真', () => {
    const s = createWorld('x');
    s.crew.order = { kind: 'search', floor: 1 };
    advance(s, 10);
    expect(s.crew.floor).toBe(1);
    expect(s.crew.atDoor).toBe(true);
  });

  it('楼层越界不会产生 NaN 暴露值', () => {
    const s = createWorld('x');
    s.crew.order = { kind: 'search', floor: 5 };
    advance(s, 30);
    expect(s.crew.floor).toBeLessThanOrEqual(1);
    expect(Number.isFinite(s.exposure.smoke)).toBe(true);
  });

  it('门等待到期只写入一次证据', () => {
    const s = createWorld('x');
    s.door.checked = true;
    s.door.temp = 'hot';
    s.door.waitUntil = s.t + 1;
    advance(s, 2);
    s.door.waitUntil = s.t + 1;
    advance(s, 2);
    const count = s.events.filter((e) => e.anchorId === 'K-BACKDRAFT-WAIT').length;
    expect(count).toBe(1);
  });
});
