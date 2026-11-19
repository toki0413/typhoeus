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
});
