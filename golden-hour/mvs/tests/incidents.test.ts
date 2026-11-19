import { describe, it, expect } from 'vitest';
import { createWorld } from '../src/sim/world';
import { stepSim } from '../src/sim/step';
import { activeIncident, resolveIncident } from '../src/sim/incidents';

const runTo = (s: ReturnType<typeof createWorld>, sec: number) => {
  while (s.t < sec) stepSim(s, 1 / 20);
};

describe('并发事件', () => {
  it('8 秒时激活邻居呼救', () => {
    const s = createWorld('x');
    s.phase = 'execute';
    runTo(s, 9);
    expect(activeIncident(s)?.id).toBe('neighbor');
  });

  it('截止时间前未处理会自动忽略', () => {
    const s = createWorld('x');
    s.phase = 'execute';
    runTo(s, 21);
    const incident = s.incidents.find((i) => i.id === 'neighbor')!;
    expect(incident.resolved).toBe(true);
    expect(incident.choice).toBe('ignore');
    expect(s.decisions.some((d) => d.kind === 'ignore')).toBe(true);
  });

  it('指导关门堵缝三秒后救下邻居', () => {
    const s = createWorld('x');
    s.phase = 'execute';
    runTo(s, 9);
    expect(resolveIncident(s, 'neighbor', 'coach')).toBe(true);
    runTo(s, 13);
    expect(s.neighbor.saved).toBe(true);
    expect(s.neighbor.alive).toBe(true);
  });

  it('折返救人会占用班组时间并救下邻居', () => {
    const s = createWorld('x');
    s.phase = 'execute';
    runTo(s, 9);
    resolveIncident(s, 'neighbor', 'divert');
    expect(s.crew.busyUntil).toBeGreaterThan(s.t);
    runTo(s, 18);
    expect(s.neighbor.saved).toBe(true);
  });

  it('楼梯撤出会提前结束本局', () => {
    const s = createWorld('x');
    s.phase = 'execute';
    runTo(s, 19);
    resolveIncident(s, 'stairs', 'withdraw');
    expect(s.ended).toBe(true);
  });

  it('忽略楼梯异响会坍塌并伤人', () => {
    const s = createWorld('x');
    s.phase = 'execute';
    runTo(s, 19);
    resolveIncident(s, 'stairs', 'ignore');
    runTo(s, 28);
    expect(s.stairs.collapsed).toBe(true);
    expect(s.crew.injured).toBe(true);
  });
});
