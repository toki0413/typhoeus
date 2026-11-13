/**
 * 研究关闭环测试：
 *   - 结构签名能区分条纹与斑点
 *   - 距离是零/对称的
 *   - 确定性种子与评分可复现
 *   - 目标包带来源、许可与校准信息
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { structuralSignature, signatureDistance } from '../server/research/signature.mjs';
import { deterministicMask, evaluateTarget } from '../server/research/score.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGETS = JSON.parse(
  readFileSync(path.join(HERE, '..', 'server', 'research', 'targets.json'), 'utf8'),
).targets;
const SURFACE = JSON.parse(
  readFileSync(path.join(HERE, '..', 'server', 'research', 'surface.json'), 'utf8'),
);

const W = 64;
const H = 64;

function stripesField() {
  const f = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) f[y * W + x] = (x % 12) < 5 ? 1 : 0;
  }
  return f;
}

function spotsField() {
  const f = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x % 10 - 5;
      const dy = y % 10 - 5;
      f[y * W + x] = dx * dx + dy * dy <= 6 ? 1 : 0;
    }
  }
  return f;
}

test('结构签名：条纹各向异性高，斑点各向异性低', () => {
  const stripes = structuralSignature(stripesField(), W, H);
  const spots = structuralSignature(spotsField(), W, H);
  assert.ok(stripes.anisotropy > 0.8, `条纹 A=${stripes.anisotropy}`);
  assert.ok(spots.anisotropy < 0.2, `斑点 A=${spots.anisotropy}`);
  assert.ok(stripes.period > 0);
});

test('结构距离：自距离为零、对称', () => {
  const a = structuralSignature(stripesField(), W, H);
  const b = structuralSignature(spotsField(), W, H);
  assert.equal(signatureDistance(a, a), 0);
  assert.ok(Math.abs(signatureDistance(a, b) - signatureDistance(b, a)) < 1e-12);
  assert.ok(signatureDistance(a, b) > 0.5);
});

test('确定性种子：同 id 同结果，不同 id 不同结果', () => {
  const a = deterministicMask('role-a');
  const b = deterministicMask('role-a');
  const c = deterministicMask('role-b');
  assert.deepEqual(Array.from(a), Array.from(b));
  assert.notDeepEqual(Array.from(a), Array.from(c));
});

test('服务端评分可复现', () => {
  const target = TARGETS.find((t) => t.id === 'gs-spots-lit');
  assert.ok(target, '缺少校准目标');
  const mask = deterministicMask('calibration-seed');
  const params = { f: 0.035, k: 0.062, D_u: 0.16, D_v: 0.08, dt: 1, mask, maskW: W, maskH: H };
  const first = evaluateTarget(target, params);
  const second = evaluateTarget(target, params);
  assert.equal(first.score, second.score);
  assert.deepEqual(first.features, second.features);
});

test('校准目标在同一确定性种子下可达高分', () => {
  const target = TARGETS.find((t) => t.id === 'gs-spots-lit');
  const mask = deterministicMask('calibration-seed');
  const result = evaluateTarget(target, {
    f: 0.035, k: 0.062, D_u: 0.16, D_v: 0.08, dt: 1, mask, maskW: W, maskH: H,
  });
  assert.ok(result.score > 95, `校准目标得分 ${result.score}`);
});

test('目标包完整：来源、许可、特征、校准', () => {
  assert.ok(TARGETS.length >= 2);
  for (const t of TARGETS) {
    assert.ok(t.id && t.label, '目标缺少 id/label');
    assert.ok(t.field.length === t.w * t.h, `${t.id} 场尺寸不符`);
    for (const key of ['density', 'anisotropy', 'period', 'components', 'perimeter']) {
      assert.ok(Number.isFinite(t.features[key]), `${t.id} 缺特征 ${key}`);
    }
    assert.ok(t.source?.license, `${t.id} 缺许可`);
    assert.ok(Number.isFinite(t.calibration?.bestScore), `${t.id} 缺校准`);
  }
  const real = TARGETS.filter((t) => t.kind === 'real');
  assert.ok(real.length >= 2, '至少保留两个真实实验目标');
  const stripes = real.find((t) => t.pattern.includes('条纹'));
  assert.ok(stripes.features.anisotropy > 0.5, '真实条纹目标应具高各向异性');
});

test('响应面完整：网格点有限，且能给出高分候选', () => {
  assert.ok(SURFACE.points.length >= 100, `响应面点数 ${SURFACE.points.length}`);
  for (const p of SURFACE.points) {
    assert.ok(Number.isFinite(p.f) && Number.isFinite(p.k));
    for (const key of ['density', 'anisotropy', 'period', 'components', 'perimeter']) {
      assert.ok(Number.isFinite(p.features[key]), `响应面缺特征 ${key}`);
    }
  }
  const target = TARGETS.find((t) => t.id === 'gs-spots-lit');
  const best = SURFACE.points
    .map((p) => 100 / (1 + signatureDistance(target.features, p.features)))
    .reduce((a, b) => Math.max(a, b), 0);
  assert.ok(best > 80, `校准目标响应面最高预测 ${best.toFixed(1)}`);
});

test('固定种子校准目标不受提交种子影响', () => {
  const target = TARGETS.find((t) => t.id === 'gs-maze-lit');
  const a = evaluateTarget(target, { f: 0.026, k: 0.058, D_u: 0.16, D_v: 0.08, dt: 1, mask: [255], maskW: 1, maskH: 1 });
  const b = evaluateTarget(target, { f: 0.026, k: 0.058, D_u: 0.16, D_v: 0.08, dt: 1 });
  assert.equal(a.score, b.score);
  assert.ok(a.usedFixedSeed);
});
