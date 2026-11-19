import { describe, it, expect } from 'vitest';
import { createWorld } from '../src/sim/world';
import { stepSim } from '../src/sim/step';
import { checkDoor, waitDoor, openDoor } from '../src/sim/door';

const advance = (s: ReturnType<typeof createWorld>, seconds: number) => {
  for (let i = 0; i < seconds * 20; i++) stepSim(s, 1 / 20);
};

describe('回燃门', () => {
  it('试温并等待后开门，救出被困者', () => {
    const s = createWorld('x');
    checkDoor(s);
    waitDoor(s);
    advance(s, 31);
    openDoor(s);
    expect(s.door.safe).toBe(true);
    expect(s.victim.rescued).toBe(true);
    expect(s.victim.alive).toBe(true);
  });

  it('未试温直接开门，回燃且记录遗漏', () => {
    const s = createWorld('x');
    openDoor(s);
    expect(s.victim.alive).toBe(false);
    expect(s.victim.rescued).toBe(false);
    expect(s.events.some((e) => e.type === 'omission' && e.anchorId === 'O-DOOR-TEMP')).toBe(true);
  });

  it('试温后直接开门，仍会回燃并记录失败证据', () => {
    const s = createWorld('x');
    checkDoor(s);
    openDoor(s);
    expect(s.victim.alive).toBe(false);
    expect(s.events.some((e) => e.anchorId === 'K-BACKDRAFT-FAIL')).toBe(true);
  });

  it('试温本身写入证据 K-DOOR-TEMP', () => {
    const s = createWorld('x');
    checkDoor(s);
    expect(s.door.temp).toBe('hot');
    expect(s.events.some((e) => e.anchorId === 'K-DOOR-TEMP')).toBe(true);
  });

  it('重复试温与重复等待都是 no-op', () => {
    const s = createWorld('x');
    checkDoor(s);
    checkDoor(s);
    expect(s.events.filter((e) => e.anchorId === 'K-DOOR-TEMP')).toHaveLength(1);

    waitDoor(s);
    const first = s.door.waitUntil;
    waitDoor(s);
    expect(s.door.waitUntil).toBe(first);
  });

  it('成功救援写入 K-RESCUE', () => {
    const s = createWorld('x');
    checkDoor(s);
    waitDoor(s);
    advance(s, 31);
    openDoor(s);
    expect(s.events.some((e) => e.anchorId === 'K-RESCUE')).toBe(true);
  });

  it('回燃会增加热暴露并写入失败证据', () => {
    const s = createWorld('x');
    const before = s.exposure.heat;
    openDoor(s);
    expect(s.exposure.heat).toBeCloseTo(before + 0.5, 5);
    expect(s.events.some((e) => e.anchorId === 'K-BACKDRAFT-FAIL')).toBe(true);
  });

  it('等待期间提前开门，计时器不会事后把门标记为安全', () => {
    const s = createWorld('x');
    checkDoor(s);
    waitDoor(s);
    advance(s, 10);
    openDoor(s);
    advance(s, 25);
    expect(s.door.safe).toBe(false);
    expect(s.events.some((e) => e.anchorId === 'K-BACKDRAFT-WAIT')).toBe(false);
  });

  it('回燃会记录班组受伤', () => {
    const s = createWorld('x');
    openDoor(s);
    expect(s.crew.injured).toBe(true);
    expect(s.events.some((e) => e.type === 'injury')).toBe(true);
  });
});
