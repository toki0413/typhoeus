import { describe, it, expect } from 'vitest';
import { createWorld } from '../src/sim/world';

describe('createWorld', () => {
  it('初始状态满足基本不变量', () => {
    const s = createWorld('GH-FIRE-MVS');
    expect(s.seed).toBe('GH-FIRE-MVS');
    expect(s.smoke).toHaveLength(2);
    expect(s.smoke.every((v) => v >= 0 && v <= 1)).toBe(true);
    expect(s.victim.alive).toBe(true);
    expect(s.door.checked).toBe(false);
    expect(s.phase).toBe('plan');
  });
});
