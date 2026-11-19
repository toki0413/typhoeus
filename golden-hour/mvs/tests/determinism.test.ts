import { describe, it, expect } from 'vitest';
import { createWorld } from '../src/sim/world';
import { stepSim } from '../src/sim/step';
import { checkDoor, waitDoor, openDoor } from '../src/sim/door';

function run(seed: string) {
  const s = createWorld(seed);
  for (let i = 0; i < 20 * 20; i++) stepSim(s, 1 / 20);
  checkDoor(s);
  waitDoor(s);
  for (let i = 0; i < 20 * 31; i++) stepSim(s, 1 / 20);
  openDoor(s);
  for (let i = 0; i < 20 * 5; i++) stepSim(s, 1 / 20);
  return JSON.stringify(s);
}

describe('确定性', () => {
  it('同种子同操作序列得到完全相同的状态', () => {
    expect(run('GH-FIRE-MVS')).toBe(run('GH-FIRE-MVS'));
  });

  it('状态可序列化并可解析', () => {
    const s = JSON.parse(run('A'));
    expect(Array.isArray(s.events)).toBe(true);
    expect(Number.isFinite(s.t)).toBe(true);
  });
});
