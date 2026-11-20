import { describe, it, expect } from 'vitest';
import { SCENARIOS, nextScenario, scenarioFor } from '../src/content/scenarios';
import { deriveScenario } from '../src/sim/scenario';

describe('固定训练场景', () => {
  it('提供三个不同种子的场景', () => {
    expect(SCENARIOS).toHaveLength(3);
    expect(new Set(SCENARIOS.map((scenario) => scenario.seed)).size).toBe(3);
    expect(new Set(SCENARIOS.map((scenario) => scenario.name)).size).toBe(3);
  });

  it('每个场景都能按种子找回，并确实改变局势参数', () => {
    for (const scenario of SCENARIOS) {
      expect(scenarioFor(scenario.seed)).toEqual(scenario);
    }

    const shifted = SCENARIOS.map((scenario) => deriveScenario(scenario.seed).incidentShift);
    expect(new Set(shifted.map((value) => Math.round(value))).size).toBeGreaterThan(1);
  });

  it('优先选择玩得最少的另一个场景', () => {
    const next = nextScenario('GH-FIRE-MVS', {});
    expect(next.seed).not.toBe('GH-FIRE-MVS');

    const afterStandard = nextScenario('GH-FIRE-MVS', {
      'GH-FIRE-MVS': 3,
      'GH-FIRE-05': 1,
      'GH-FIRE-02': 0,
    });
    expect(afterStandard.seed).toBe('GH-FIRE-02');
  });

  it('不推荐当前场景，即使它玩得最少', () => {
    const next = nextScenario('GH-FIRE-05', {
      'GH-FIRE-MVS': 4,
      'GH-FIRE-05': 0,
      'GH-FIRE-02': 4,
    });
    expect(next.seed).not.toBe('GH-FIRE-05');
  });

  it('未知种子也能给出一个场景', () => {
    const next = nextScenario('unknown-seed', {});
    expect(SCENARIOS.some((scenario) => scenario.seed === next.seed)).toBe(true);
  });
});
