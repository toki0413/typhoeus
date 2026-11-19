import { describe, it, expect } from 'vitest';
import { mulberry32, hashSeed } from '../src/sim/rng';

describe('mulberry32', () => {
  it('同一种子产生同一序列', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('结果落在 [0, 1)', () => {
    const r = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('种子 42 的前 5 个值与快照一致', () => {
    const r = mulberry32(42);
    expect([r(), r(), r(), r(), r()]).toEqual([
      0.6011037519201636,
      0.44829055899754167,
      0.8524657934904099,
      0.6697340414393693,
      0.17481389874592423,
    ]);
  });
});

describe('hashSeed', () => {
  it('同一字符串返回同一值', () => {
    expect(hashSeed('golden-hour')).toBe(hashSeed('golden-hour'));
  });

  it('返回值在 0 到 4294967295 之间', () => {
    for (const s of ['', 'golden-hour', 'MVS', '种子']) {
      const h = hashSeed(s);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(4294967295);
    }
  });
});
