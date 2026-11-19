import { describe, it, expect } from 'vitest';
import { createWorld } from '../src/sim/world';
import { stepSim } from '../src/sim/step';
import { beginRun } from '../src/app/session';
import { resolveIncident } from '../src/sim/incidents';
import { checkDoor, waitDoor, openDoor } from '../src/sim/door';
import { buildDebrief } from '../src/eval/debrief';

const runTo = (s: ReturnType<typeof createWorld>, sec: number) => {
  while (s.t < sec) stepSim(s, 1 / 20);
};

describe('决策密度', () => {
  it('一局密集处理后的决策密度可测量', () => {
    const s = createWorld('x');
    beginRun(s);

    runTo(s, 9);
    resolveIncident(s, 'neighbor', 'coach');
    runTo(s, 19);
    resolveIncident(s, 'stairs', 'shore');
    runTo(s, 25);
    checkDoor(s);
    waitDoor(s);
    runTo(s, 56);
    openDoor(s);
    stepSim(s, 1 / 20);

    const card = buildDebrief(s);
    console.log(
      `[density] ${card.decisions.length} 次决策 / ${Math.round(s.t)} 秒 = ${card.decisionDensity} 次/分钟`
    );
    expect(card.decisions).toHaveLength(6);
    expect(card.decisionDensity).toBeGreaterThanOrEqual(5);
    expect(card.tactical.neighborSaved).toBe(true);
  });

  it('只开门不处理并发事件时决策更少', () => {
    const s = createWorld('x');
    beginRun(s);
    runTo(s, 5);
    openDoor(s);
    stepSim(s, 1 / 20);

    const card = buildDebrief(s);
    expect(card.decisions).toHaveLength(2);
  });
});
