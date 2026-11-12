/* Foldit 式斑图解谜 — 核心逻辑测试 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PUZZLE_LEVELS, PUZZLE_SIZE, getTarget, createSession, evaluate,
  scoreAttempt, wiggle, shakeMask, makeStarterMask, countPainted,
  loadPuzzleProgress, savePuzzleProgress, starsFor, isLevelUnlocked,
} from '../src/puzzle.js';
import { laplacian } from '../src/scientific.js';

function fieldHash(field) {
  let h = 0x811c9dc5;
  for (let i = 0; i < field.length; i++) {
    h ^= Math.round(field[i] * 1e6) & 0xffffffff;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

test('求解器: 五点 Laplacian 常数场为 0、二次场为 4', () => {
  const w = 16;
  const h = 16;
  assert.equal(laplacian(new Float32Array(w * h).fill(0.3), w, h, 8, 8, 'torus'), 0);
  const quad = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) quad[y * w + x] = x * x + y * y;
  assert.ok(Math.abs(laplacian(quad, w, h, 8, 8, 'torus') - 4) < 1e-9);
});

test('关卡: 目标生成确定性 + 缓存命中', () => {
  const a = getTarget(PUZZLE_LEVELS[0].id);
  const b = getTarget(PUZZLE_LEVELS[0].id);
  assert.equal(a, b, '第二次应命中同一缓存对象');
  assert.equal(fieldHash(a.field), fieldHash(b.field));
  assert.ok(a.features.density > 0.02, `目标密度 ${a.features.density}`);
  assert.ok(a.zones.some((z) => z > 0), '目标应有空间布局');
});

test('评分: 隐藏种子 + 隐藏参数 → 接近满分', () => {
  for (const level of PUZZLE_LEVELS) {
    const target = getTarget(level.id);
    const session = createSession(level.id);
    const perfect = evaluate({
      ...session, mask: target.mask, f: level.target.f, k: level.target.k,
    });
    assert.ok(perfect.total >= 95, `${level.id} 精确复现总分 ${perfect.total}`);
    assert.ok(perfect.sStruct >= 95, `${level.id} 结构分 ${perfect.sStruct}`);
    assert.ok(perfect.sLayout >= 95, `${level.id} 布局分 ${perfect.sLayout}`);
  }
});

test('评分: 错类目标 → 结构分低', () => {
  const spots = getTarget('spots-garden');
  const stripes = getTarget('stripes-river');
  const wrong = scoreAttempt(spots, [stripes.field], stripes.mask);
  assert.ok(wrong.sStruct < 35, `错类结构分 ${wrong.sStruct}`);
  assert.ok(wrong.total < 55, `错类总分 ${wrong.total}`);
});

test('评分: 空白种子无效且分项有界', () => {
  const spots = getTarget('spots-garden');
  const empty = new Float32Array(PUZZLE_SIZE * PUZZLE_SIZE);
  const r = scoreAttempt(spots, [empty], empty);
  assert.equal(r.valid, false);
  assert.equal(r.total, 0);
  for (const key of ['sStruct', 'sLayout', 'sRobust', 'sInk']) {
    assert.ok(Number.isFinite(r[key]) && r[key] >= 0 && r[key] <= 100, `${key}=${r[key]}`);
  }
});

test('Wiggle: 同输入可复现、预算受限、mask 不变', async () => {
  const session = createSession('spots-garden');
  const before = fieldHash(session.mask);
  const a = await wiggle(session, { budget: 8 });
  const b = await wiggle(session, { budget: 8 });
  assert.equal(a.f, b.f);
  assert.equal(a.k, b.k);
  assert.equal(a.evals, b.evals);
  assert.ok(a.evals <= 8, `评估数 ${a.evals}`);
  assert.ok(a.f >= session.level.knobs.f.min && a.f <= session.level.knobs.f.max);
  assert.ok(a.k >= session.level.knobs.k.min && a.k <= session.level.knobs.k.max);
  assert.equal(fieldHash(session.mask), before, 'Wiggle 不应修改玩家的种子');
});

test('继承: 当前生命参数被写入会话并按关卡范围裁剪', () => {
  const inherited = createSession('spots-garden', {
    f: 0.033, k: 0.058, inherited: { from: 'current-life' },
  });
  assert.equal(inherited.f, 0.033);
  assert.equal(inherited.k, 0.058);
  assert.equal(inherited.inherited.from, 'current-life');
  assert.equal(inherited.inherited.clamped, false);

  const clamped = createSession('spots-garden', { f: 0.2, k: 0.001 });
  assert.equal(clamped.f, 0.040, 'f 应被裁剪到关卡上限');
  assert.equal(clamped.k, 0.052, 'k 应被裁剪到关卡下限');

  const fallback = createSession('spots-garden');
  assert.equal(fallback.f, fallback.level.start.f);
  assert.equal(fallback.inherited, null);
});

test('Shake: 同 index 字节相等，墨量变化不超过 20 格', () => {
  const base = makeStarterMask();
  const a = shakeMask(base, 12345);
  const b = shakeMask(base, 12345);
  assert.equal(fieldHash(a), fieldHash(b));
  assert.ok(Math.abs(countPainted(a) - countPainted(base)) <= 20);
});

test('进度: 存取往返、星级与解锁', () => {
  savePuzzleProgress('spots-garden', { best: 72, params: { f: 0.03, k: 0.06 } });
  const p = loadPuzzleProgress();
  assert.equal(p['spots-garden'].best, 72);
  assert.equal(p['spots-garden'].stars, 2);
  assert.equal(starsFor(85), 3);
  assert.equal(starsFor(69), 1);
  assert.equal(isLevelUnlocked(0, {}), true);
  assert.equal(isLevelUnlocked(1, { 'spots-garden': { best: 59 } }), false);
  assert.equal(isLevelUnlocked(1, { 'spots-garden': { best: 60 } }), true);
});

test('进度: 损坏 JSON 不抛错', () => {
  const prev = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: () => '{not-json',
    setItem: () => {},
    removeItem: () => {},
  };
  try {
    const p = loadPuzzleProgress();
    assert.deepEqual(p, {});
  } finally {
    if (prev === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prev;
  }
});
