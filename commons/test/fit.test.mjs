/* 实验斑图拟合基准测试 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  imageToField,
  extractPatternFeatures,
  featureDistance,
  makeReferencePattern,
  fitPattern,
} from '../src/fit.js';

function makeImageData(width, height, fn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = fn(x, y);
      const i = (y * width + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
    }
  }
  return { data, width, height };
}

test('拟合: ImageData → 归一化灰度场（双线性 + 归一化）', () => {
  const img = makeImageData(4, 4, (x) => (x < 2 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
  const field = imageToField(img, 2, 2);
  assert.equal(field.length, 4);
  assert.ok(Math.abs(field[0]) < 1e-6, `左列=${field[0]}`);
  assert.ok(Math.abs(field[1] - 1) < 1e-6, `右列=${field[1]}`);
});

test('拟合: 周期条纹的结构特征（density≈0.5, L_c≈16）', () => {
  const w = 64;
  const h = 64;
  const field = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) field[y * w + x] = 0.5 + 0.4 * Math.sin((2 * Math.PI * (x + 0.5)) / 16);
  }
  const f = extractPatternFeatures(field, w, h);
  assert.ok(Math.abs(f.density - 0.5) < 0.03, `density=${f.density}`);
  assert.ok(f.period >= 15 && f.period <= 17, `L_c=${f.period}`);
  assert.ok(f.entropy > 0 && f.entropy <= 1);
  assert.ok(f.fractal >= 0.5 && f.fractal <= 2);
});

test('拟合: 结构距离对称、非负、自距离为 0', () => {
  const a = { density: 0.3, entropy: 0.6, period: 12, fractal: 1.4 };
  const b = { density: 0.4, entropy: 0.5, period: 16, fractal: 1.2 };
  const dab = featureDistance(a, b);
  const dba = featureDistance(b, a);
  assert.ok(dab >= 0);
  assert.ok(Math.abs(dab - dba) < 1e-12);
  assert.equal(featureDistance(a, a), 0);
});

test('拟合: 已知参数的参考斑图可被参数网格精确恢复', async () => {
  const truth = makeReferencePattern({
    w: 32, h: 32, f: 0.03, k: 0.06, Du: 0.16, Dv: 0.08, dt: 1.0, steps: 100,
  });
  const target = extractPatternFeatures(truth.field, 32, 32);
  const result = await fitPattern(target, {
    w: 32, h: 32, steps: 100,
    grid: { f: [0.02, 0.03, 0.04], k: [0.055, 0.06, 0.065], Du: [0.16] },
  });
  assert.ok(result.best, '应返回最佳候选');
  assert.equal(result.best.params.f, 0.03);
  assert.equal(result.best.params.k, 0.06);
  assert.equal(result.best.params.D_u, 0.16);
  assert.ok(result.best.distance < 1e-9, `精确候选距离=${result.best.distance}`);
  assert.equal(result.evaluated, 9);
});

test('拟合: 参考斑图生成可复现', () => {
  const a = makeReferencePattern({ w: 24, h: 24, steps: 40 });
  const b = makeReferencePattern({ w: 24, h: 24, steps: 40 });
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < a.field.length; i++) { sumA += a.field[i]; sumB += b.field[i]; }
  assert.equal(sumA, sumB);
});
