import { describe, it, expect } from 'vitest';
import { createWorld } from '../src/sim/world';
import { suppressFire } from '../src/sim/actions';

describe('suppressFire', () => {
  it('执行阶段消耗一具灭火器并降低火势', () => {
    const s = createWorld('x');
    s.phase = 'execute';
    const before = s.fire;

    expect(suppressFire(s)).toBe(true);
    expect(s.resources.extinguisher).toBe(1);
    expect(s.fire).toBeLessThan(before);
    expect(s.events.some((e) => e.anchorId === 'K-EXTINGUISH')).toBe(true);
  });

  it('规划阶段不生效', () => {
    const s = createWorld('x');
    expect(suppressFire(s)).toBe(false);
    expect(s.resources.extinguisher).toBe(2);
  });

  it('没有灭火器时不生效', () => {
    const s = createWorld('x');
    s.phase = 'execute';
    s.resources.extinguisher = 0;
    expect(suppressFire(s)).toBe(false);
  });
});
