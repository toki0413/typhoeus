/* 科学引擎基准测试（node:test）
 *
 * 目标不是“让数好看”，而是给关键计算建立可复现的基准：
 *   - 相关长度 L_c 对已知周期条纹的响应
 *   - 盒计数维数 D_box 对填充/线状场的排序
 *   - Shannon 场熵 H_v 的边界
 *   - 场能量 E_field 对均匀/梯度场的排序
 *   - 反应-扩散求解器的有界性、可复现性、纯扩散守恒
 *   - 有限时间 Lyapunov 切空间重归一化
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeSpatialPeriod,
  computeFractalDimension,
  computeFieldEntropy,
  computeFieldEnergy,
  laplacian,
} from '../src/scientific.js';
import { createEngine, defaultGenome, defaultEnv } from '../src/engines.js';

const W = 64;
const H = 64;

function makeField(fn, w = W, h = H) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) out[y * w + x] = fn(x, y);
  }
  return out;
}

function scientificEngine(w = W, h = H, seed = 42) {
  const genome = defaultGenome('life', 'conway');
  genome.engine = 'scientific';
  genome.scientific = { preset: 'gs_spots' };
  return createEngine(genome, defaultEnv(), seed, w, h);
}

test('基准: 周期 16 的条纹 → L_c ≈ 16（64 与 128 网格一致）', () => {
  for (const size of [64, 128]) {
    const field = makeField((x) => 0.5 + 0.4 * Math.sin((2 * Math.PI * x) / 16), size, size);
    const period = computeSpatialPeriod(field, size, size);
    assert.ok(period >= 15 && period <= 17, `size=${size} 得到 L_c=${period}`);
  }
});

test('基准: 盒计数维数 D_box 对填充场 > 线状场', () => {
  const filled = makeField(() => 1);
  const line = makeField((x, y) => (y === 32 ? 1 : 0));
  const dFilled = computeFractalDimension(filled, W, H, 0.3);
  const dLine = computeFractalDimension(line, W, H, 0.3);
  assert.ok(dFilled > 1.8, `填充场 D=${dFilled}`);
  assert.ok(dLine < 1.3, `线状场 D=${dLine}`);
});

test('基准: Shannon 场熵 H_v 的范围与排序', () => {
  const uniform = makeField(() => 0.5);
  const twoLevel = makeField((x) => (x < W / 2 ? 0 : 1));
  // 确定性伪随机：不用 Math.random，保证可复现
  const random = makeField((x, y) => {
    const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    return n - Math.floor(n);
  });
  const hUniform = computeFieldEntropy(uniform);
  const hTwo = computeFieldEntropy(twoLevel);
  const hRandom = computeFieldEntropy(random);
  assert.equal(hUniform, 0);
  assert.ok(hTwo > 0.1 && hTwo < 0.35, `两值场 H=${hTwo}`);
  assert.ok(hRandom > 0.8, `随机场 H=${hRandom}`);
  assert.ok(hUniform <= hTwo && hTwo <= hRandom);
});

test('基准: E_field 对零场/均匀场/梯度场的排序', () => {
  const zero = makeField(() => 0);
  const uniform = makeField(() => 0.5);
  const gradient = makeField((x) => x / W);
  const eZero = computeFieldEnergy(zero, zero, W, H).total;
  const eUniform = computeFieldEnergy(uniform, uniform, W, H).total;
  const eGradient = computeFieldEnergy(gradient, gradient, W, H).total;
  assert.equal(eZero, 0);
  assert.ok(eUniform > 0);
  assert.ok(eGradient > eUniform);
});

test('求解器: 200 步有界、有限、指标可读', () => {
  const sim = scientificEngine();
  for (let i = 0; i < 200; i++) sim.step();
  const v = sim._rd.vField;
  const u = sim._rd.uField;
  for (let i = 0; i < v.length; i++) {
    assert.ok(Number.isFinite(u[i]) && Number.isFinite(v[i]), `非有限值 @${i}`);
    assert.ok(u[i] >= 0 && u[i] <= 1, `u 越界 @${i}=${u[i]}`);
    assert.ok(v[i] >= 0 && v[i] <= 1, `v 越界 @${i}=${v[i]}`);
  }
  const m = sim.metrics();
  for (const key of ['density', 'entropy', 'period', 'activity', 'lyapunov', 'fractal']) {
    assert.ok(Number.isFinite(m[key]), `${key} 非有限: ${m[key]}`);
  }
  assert.ok(Number.isFinite(sim.lyapunovExponent));
  assert.ok(sim._lyaStepCount > 0);
});

test('求解器: 相同种子 → 可复现指标', () => {
  const a = scientificEngine();
  const b = scientificEngine();
  for (let i = 0; i < 60; i++) { a.step(); b.step(); }
  const ma = a.metrics();
  const mb = b.metrics();
  assert.equal(ma.density, mb.density);
  assert.equal(ma.entropy, mb.entropy);
  assert.equal(ma.lyapunov, mb.lyapunov);
});

test('求解器: 纯扩散（v=0, f=k=0）总质量守恒', () => {
  const sim = scientificEngine();
  const rd = sim._rd;
  rd.params.f = 0;
  rd.params.k = 0;
  rd.dt = 0.05;
  /* v=0 时反应项 u·v² = 0，只剩 u 的扩散；这才是不含反应的纯扩散检验 */
  rd.u.fill(1);
  rd.v.fill(0);
  for (let y = 28; y < 36; y++) {
    for (let x = 28; x < 36; x++) rd.u[y * W + x] = 0.2;
  }
  const massBefore = sumField(rd.u) + sumField(rd.v);
  for (let i = 0; i < 50; i++) sim.step();
  const massAfter = sumField(rd.u) + sumField(rd.v);
  const rel = Math.abs(massAfter - massBefore) / Math.max(1e-12, massBefore);
  assert.ok(rel < 1e-6, `总质量相对漂移 ${rel}`);
});

test('求解器: 五点 Laplacian 对常数场为 0、对二次场为 4', () => {
  const w = 16;
  const h = 16;
  const constant = new Float32Array(w * h).fill(0.7);
  assert.equal(laplacian(constant, w, h, 8, 8, 'torus'), 0);

  const quadratic = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) quadratic[y * w + x] = x * x + y * y;
  }
  const lap = laplacian(quadratic, w, h, 8, 8, 'torus');
  assert.ok(Math.abs(lap - 4) < 1e-9, `laplacian(x²+y²)=${lap}`);
});

test('求解器: 预设 D·dt 超出 CFL 时自动子步且保持有界', () => {
  const sim = scientificEngine();
  const rd = sim._rd;
  rd.params.f = 0;
  rd.params.k = 0;
  rd.dt = 2.0;               // D=0.16 → D·dt=0.32 > 1/4，必须子步
  rd.u.fill(1);
  rd.v.fill(0);
  rd.u[32 * W + 32] = 0;
  for (let i = 0; i < 20; i++) sim.step();
  for (let i = 0; i < rd.u.length; i++) {
    assert.ok(Number.isFinite(rd.u[i]) && rd.u[i] >= 0 && rd.u[i] <= 1, `u[${i}]=${rd.u[i]}`);
  }
});

test('切空间: 重归一化后切向量范数有界且有限', () => {
  const sim = scientificEngine();
  for (let i = 0; i < 40; i++) sim.step();
  const du = sim._tangentU;
  const dv = sim._tangentV;
  let sumSq = 0;
  for (let i = 0; i < du.length; i++) {
    assert.ok(Number.isFinite(du[i]) && Number.isFinite(dv[i]));
    sumSq += du[i] * du[i] + dv[i] * dv[i];
  }
  const rms = Math.sqrt(sumSq / du.length);
  assert.ok(rms > 0.2 && rms < 5, `切向量 RMS=${rms}`);
});

function sumField(field) {
  let sum = 0;
  for (let i = 0; i < field.length; i++) sum += field[i];
  return sum;
}
