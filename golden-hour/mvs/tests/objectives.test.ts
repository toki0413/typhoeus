import { describe, it, expect } from 'vitest';
import { createWorld } from '../src/sim/world';
import { stepSim } from '../src/sim/step';
import { checkDoor, openDoor, waitDoor } from '../src/sim/door';
import { resolveIncident } from '../src/sim/incidents';
import { buildObjectives } from '../src/eval/objectives';

const objective = (s: ReturnType<typeof createWorld>, id: string) =>
  buildObjectives(s).find((item) => item.id === id)!;

describe('训练目标证据', () => {
  it('没有行动时只陈述事实，不给出对错', () => {
    const s = createWorld('x');
    const evidence = buildObjectives(s);

    expect(objective(s, 'door').observed).toContain('还没有试门把温度');
    expect(objective(s, 'door').practiced).toBe(false);
    expect(objective(s, 'wait').observed).toContain('没有在门外等待');
    expect(objective(s, 'priority').observed).toContain('没有处理并发事件');

    const text = JSON.stringify(evidence);
    expect(text).not.toContain('正确');
    expect(text).not.toContain('错误');
  });

  it('试温、等待并安全开门时，证据记录行为与结果', () => {
    const s = createWorld('x');
    checkDoor(s);
    waitDoor(s);
    s.door.waitUntil = s.t - 1;
    stepSim(s, 1 / 20);
    openDoor(s);

    const door = objective(s, 'door');
    expect(door.observed).toContain('试了门把温度');
    expect(door.outcome).toContain('已救出');
    expect(door.practiced).toBe(true);

    const wait = objective(s, 'wait');
    expect(wait.observed).toContain('选择了在门外等待');
    expect(wait.outcome).toContain('没有回燃');
    expect(wait.practiced).toBe(true);
  });

  it('未试温开门时，证据记录回燃后果', () => {
    const s = createWorld('x');
    openDoor(s);

    expect(objective(s, 'door').observed).toContain('没有试门把温度就开门');
    expect(objective(s, 'door').outcome).toContain('回燃');
    expect(objective(s, 'wait').outcome).toContain('回燃');
  });

  it('并发事件按实际处理顺序记录，而不是固定顺序', () => {
    const s = createWorld('x');
    s.phase = 'execute';
    s.incidents[0].activatedAt = 1;
    s.incidents[1].activatedAt = 2;
    resolveIncident(s, 'stairs', 'ignore');
    resolveIncident(s, 'neighbor', 'coach');

    s.stairs.collapsed = true;
    s.crew.injured = true;
    s.neighbor.saved = true;

    const priority = objective(s, 'priority');
    expect(priority.observed.indexOf('楼梯间异响')).toBeLessThan(
      priority.observed.indexOf('102 有人呼救')
    );
    expect(priority.outcome).toContain('102 获救');
    expect(priority.outcome).toContain('楼梯坍塌');
    expect(priority.practiced).toBe(true);
  });
});
