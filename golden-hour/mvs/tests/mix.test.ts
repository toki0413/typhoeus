import { describe, it, expect } from 'vitest';
import { createWorld } from '../src/sim/world';
import { mixFromState } from '../src/audio/mix';

describe('声景混音映射', () => {
  it('火势越大，爆裂声越密、越响', () => {
    const s = createWorld('x');
    s.fire = 0.15;
    const low = mixFromState(s);
    s.fire = 0.9;
    const high = mixFromState(s);

    expect(high.crackleRate).toBeGreaterThan(low.crackleRate);
    expect(high.crackleGain).toBeGreaterThan(low.crackleGain);
  });

  it('烟气与受伤让声音更闷', () => {
    const s = createWorld('x');
    const clear = mixFromState(s);

    s.smoke[0] = 0.7;
    const smoky = mixFromState(s);
    expect(smoky.muffleHz).toBeLessThan(clear.muffleHz);

    s.crew.injured = true;
    const hurt = mixFromState(s);
    expect(hurt.muffleHz).toBeLessThanOrEqual(smoky.muffleHz);
    expect(hurt.heartbeatBpm).toBeGreaterThan(clear.heartbeatBpm);
  });

  it('体力消耗提高呼吸与心跳频率', () => {
    const s = createWorld('x');
    const calm = mixFromState(s);
    s.exposure.strain = 0.9;
    const spent = mixFromState(s);

    expect(spent.heartbeatBpm).toBeGreaterThan(calm.heartbeatBpm);
    expect(spent.breathInterval).toBeLessThan(calm.breathInterval);
    expect(spent.stepInterval).toBeLessThan(calm.stepInterval);
  });

  it('只有真正在楼层间移动时才产生脚步', () => {
    const s = createWorld('x');
    expect(mixFromState(s).moving).toBe(false);

    s.phase = 'execute';
    s.crew.order = { kind: 'search', floor: 1 };
    s.crew.busyUntil = 0;
    expect(mixFromState(s).moving).toBe(true);

    s.crew.busyUntil = 20;
    expect(mixFromState(s).moving).toBe(false);

    s.crew.busyUntil = 0;
    s.crew.floor = 1;
    expect(mixFromState(s).moving).toBe(false);
  });

  it('摸到烫手门把时心跳加快', () => {
    const s = createWorld('x');
    s.phase = 'execute';
    s.crew.atDoor = true;
    s.door.checked = true;
    s.door.temp = 'hot';

    const stressed = mixFromState(s);
    s.door.checked = false;
    s.door.temp = 'unknown';
    const calm = mixFromState(s);

    expect(stressed.heartbeatBpm).toBeGreaterThan(calm.heartbeatBpm);
  });

  it('专业队临近时远处警笛逐渐出现', () => {
    const s = createWorld('x');
    s.t = 5;
    expect(mixFromState(s).siren).toBe(0);

    s.t = 45;
    expect(mixFromState(s).siren).toBeGreaterThan(0.2);
  });

  it('事件临近截止时进入紧急状态', () => {
    const s = createWorld('x');
    s.t = 8;
    s.incidents[0].activatedAt = 8;
    expect(mixFromState(s).urgent).toBe(false);

    s.t = 16;
    expect(mixFromState(s).urgent).toBe(true);
  });
});
