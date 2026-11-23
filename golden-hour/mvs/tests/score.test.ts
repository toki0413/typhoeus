import { describe, it, expect } from 'vitest';
import { compareRuns, scoreRun, type RunResult } from '../src/eval/score';

/** 以完美局为底，按需覆盖单项，保证各用例只差一个变量。 */
function run(overrides: Partial<RunResult> = {}): RunResult {
  return {
    rescued: 3,
    lost: 0,
    total: 3,
    seconds: 40,
    peakExposure: 0.2,
    wrongAgent: 0,
    airLeft: 0.6,
    ...overrides,
  };
}

describe('单局评分', () => {
  it('完美局拿 3 星且不低于 80 分', () => {
    const breakdown = scoreRun(run());
    expect(breakdown.stars).toBe(3);
    expect(breakdown.score).toBeGreaterThanOrEqual(80);
    expect(Number.isInteger(breakdown.score)).toBe(true);
    expect(breakdown.reasons[0]).toBe('救出 3/3');
    expect(breakdown.reasons).toContain('干净利落');
  });

  it('糟糕局只有 1 星且低于 30 分', () => {
    const breakdown = scoreRun(
      run({ rescued: 0, lost: 3, seconds: 150, peakExposure: 1, wrongAgent: 3 })
    );
    expect(breakdown.stars).toBe(1);
    expect(breakdown.score).toBeLessThan(30);
    expect(breakdown.reasons).toContain('失去 3 人');
    expect(breakdown.reasons).toContain('错误灭火剂 3 次');
    expect(breakdown.reasons).toContain('暴露偏高');
    expect(breakdown.reasons).toContain('用时过长');
    expect(breakdown.reasons).not.toContain('干净利落');
  });

  it('其他条件相同时多救一人分数更高', () => {
    expect(scoreRun(run({ rescued: 2 })).score).toBeGreaterThan(
      scoreRun(run({ rescued: 1 })).score
    );
  });

  it('错误灭火剂会降低分数', () => {
    expect(scoreRun(run({ wrongAgent: 2 })).score).toBeLessThan(scoreRun(run()).score);
  });

  it('compareRuns 给出 better 与四个差值', () => {
    const current = run();
    const best = run({
      rescued: 1,
      lost: 2,
      seconds: 100,
      peakExposure: 0.8,
      wrongAgent: 1,
    });

    const comparison = compareRuns(current, best);
    expect(comparison.better).toBe(true);
    expect(comparison.scoreDelta).toBe(scoreRun(current).score - scoreRun(best).score);
    expect(comparison.rescuedDelta).toBe(2);
    expect(comparison.timeDelta).toBe(-60);
    expect(comparison.exposureDelta).toBeCloseTo(-0.6, 10);
  });

  it('分数更低时 better 为 false', () => {
    expect(compareRuns(run({ rescued: 1 }), run()).better).toBe(false);
  });

  it('极端值被夹在 0..100', () => {
    // 救援率远超 100%、时间极短、零惩罚：上限 100。
    const high = scoreRun(run({ rescued: 10, total: 1, seconds: 0, peakExposure: 0 }));
    expect(high.score).toBe(100);

    // 负救援、超长用时、满暴露、多次用错：下限 0。
    const low = scoreRun(
      run({ rescued: -2, seconds: 1000, peakExposure: 5, wrongAgent: 20 })
    );
    expect(low.score).toBe(0);
  });
});
