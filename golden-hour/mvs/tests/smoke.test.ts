import { describe, it, expect } from 'vitest';
import { stepSmoke } from '../src/sim/smoke';
import { createWorld } from '../src/sim/world';
import { stepSim } from '../src/sim/step';

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
});

describe('stepSim', () => {
  it('暴露值随停留时间上升且不超过 1', () => {
    const s = createWorld('x');
    for (let i = 0; i < 20 * 60; i++) stepSim(s, 1 / 20);
    expect(s.exposure.smoke).toBeGreaterThan(0);
    expect(s.exposure.smoke).toBeLessThanOrEqual(1);
    expect(s.t).toBeCloseTo(60, 1);
  });
});
