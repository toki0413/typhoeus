import { describe, it, expect } from 'vitest';
import { createWorld } from '../src/sim/world';
import { beginRun, advance, restart } from '../src/app/session';
import { openDoor } from '../src/sim/door';

describe('session', () => {
  it('beginRun 进入执行并下达搜索', () => {
    const s = createWorld('x');
    beginRun(s);
    expect(s.phase).toBe('execute');
    expect(s.crew.order).toEqual({ kind: 'search', floor: 1 });
  });

  it('advance 只在执行阶段推进', () => {
    const s = createWorld('x');
    expect(advance(s, 0.05).enteredDebrief).toBe(false);
    expect(s.t).toBe(0);

    s.phase = 'execute';
    advance(s, 0.05);
    expect(s.t).toBeCloseTo(0.05);
  });

  it('开门后 advance 返回 enteredDebrief 并切到 debrief', () => {
    const s = createWorld('x');
    s.phase = 'execute';
    openDoor(s);
    const r = advance(s, 0.05);
    expect(r.enteredDebrief).toBe(true);
    expect(s.phase).toBe('debrief');
  });

  it('restart 默认用同一种子重置世界', () => {
    const s = createWorld('GH-FIRE-MVS');
    s.t = 50;
    s.phase = 'debrief';
    s.resources.extinguisher = 0;

    restart(s);
    expect(s.seed).toBe('GH-FIRE-MVS');
    expect(s.t).toBe(0);
    expect(s.phase).toBe('plan');
    expect(s.resources.extinguisher).toBe(2);
  });

  it('restart 可以切换到指定场景种子', () => {
    const s = createWorld('GH-FIRE-MVS');
    s.t = 40;
    s.phase = 'debrief';

    restart(s, 'GH-FIRE-05');
    expect(s.seed).toBe('GH-FIRE-05');
    expect(s.t).toBe(0);
    expect(s.scenario).toEqual(createWorld('GH-FIRE-05').scenario);
  });
});
