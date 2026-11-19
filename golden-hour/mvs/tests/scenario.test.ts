import { describe, it, expect } from 'vitest';
import { deriveScenario } from '../src/sim/scenario';
import { createWorld } from '../src/sim/world';
import { stepSim } from '../src/sim/step';

describe('deriveScenario', () => {
  it('同种子得到同一组参数', () => {
    expect(deriveScenario('GH-FIRE-MVS')).toEqual(deriveScenario('GH-FIRE-MVS'));
  });

  it('不同种子至少有一项参数不同', () => {
    const seeds = ['A', 'B', 'C', 'D', 'E'];
    const seen = new Set(seeds.map((s) => JSON.stringify(deriveScenario(s))));
    expect(seen.size).toBeGreaterThan(1);
  });

  it('参数落在设定范围内', () => {
    for (const seed of ['A', 'B', 'GH-FIRE-MVS', 'night-01']) {
      const p = deriveScenario(seed);
      expect(p.fireGrowthEarly).toBeGreaterThanOrEqual(0.01);
      expect(p.fireGrowthEarly).toBeLessThanOrEqual(0.014);
      expect(p.fireGrowthLate).toBeGreaterThanOrEqual(0.018);
      expect(p.fireGrowthLate).toBeLessThanOrEqual(0.024);
      expect(p.smokeSource).toBeGreaterThanOrEqual(0.27);
      expect(p.smokeSource).toBeLessThanOrEqual(0.33);
      expect(p.smokeTransfer).toBeGreaterThanOrEqual(0.1);
      expect(p.smokeTransfer).toBeLessThanOrEqual(0.14);
    }
  });
});

describe('种子影响局势', () => {
  it('两个种子在相同时刻的火势不同', () => {
    const a = createWorld('A');
    const b = createWorld('B');
    for (let i = 0; i < 20 * 30; i++) {
      stepSim(a, 1 / 20);
      stepSim(b, 1 / 20);
    }
    expect(a.fire).not.toBeCloseTo(b.fire, 6);
  });

  it('世界创建时带上派生参数', () => {
    const s = createWorld('GH-FIRE-MVS');
    expect(s.scenario).toEqual(deriveScenario('GH-FIRE-MVS'));
  });
});
