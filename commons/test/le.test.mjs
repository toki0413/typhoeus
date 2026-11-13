/**
 * Lengyel–Epstein（CIMA）引擎测试：
 *   - 能长出非均匀 Turing 斑图，而不是回到均匀稳态
 *   - 指标与快照在非 [0,1] 场下仍然有意义
 *   - 相同初值可复现
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../src/engines.js';

function makeSim(overrides = {}) {
  return createEngine(
    {
      engine: 'scientific',
      scientific: {
        preset: 'le_stripes',
        engineType: 'lengyelEpstein',
        a: 8,
        b: 6,
        sigma: 0.6,
        D_u: 1,
        D_v: 10,
        dt: 0.02,
        ...overrides,
      },
    },
    { pattern: 'ring', boundary: 'torus' },
    42,
  );
}

test('LE 引擎：长出非均匀斑图', () => {
  const sim = makeSim();
  for (let i = 0; i < 3000; i++) sim.step();
  const v = sim._rd.vField;
  let min = Infinity;
  let max = -Infinity;
  for (const x of v) { if (x < min) min = x; if (x > max) max = x; }
  assert.ok(max - min > 0.02, `LE 场应非均匀，span=${(max - min).toFixed(4)}`);
  const m = sim.metrics();
  assert.ok(m.density > 0 && m.density < 1, `密度应归一化，收到 ${m.density}`);
  assert.ok(Number.isFinite(m.lyapunov), 'Lyapunov 应为有限值');
});

test('LE 引擎：快照覆盖完整灰度范围', () => {
  const sim = makeSim();
  for (let i = 0; i < 2000; i++) sim.step();
  const snap = sim.snapshot(2);
  const arr = snap.data || snap;
  let min = 255;
  let max = 0;
  for (const x of arr) { if (x < min) min = x; if (x > max) max = x; }
  assert.equal(min, 0, `快照最小值 ${min}`);
  assert.equal(max, 255, `快照最大值 ${max}`);
});

test('LE 引擎：相同初值可复现', () => {
  const a = makeSim();
  const b = makeSim();
  for (let i = 0; i < 800; i++) { a.step(); b.step(); }
  const va = a._rd.vField;
  const vb = b._rd.vField;
  for (let i = 0; i < va.length; i += 97) {
    assert.ok(Math.abs(va[i] - vb[i]) < 1e-9, `第 ${i} 格不一致`);
  }
});
