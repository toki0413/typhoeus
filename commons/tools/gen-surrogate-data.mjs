/**
 * 生成神经代理训练集：参数 → 结构签名 + 16×16 场
 *
 * 用与服务端复核完全相同的 evaluateTarget（固定噪声/校准种子、同一步数），
 * 保证训练数据与线上评分同源。采样用固定种子的拉丁超立方，便于复现。
 *
 * 用法：
 *   node tools/gen-surrogate-data.mjs --gs 700 --le 160
 *   node tools/gen-surrogate-data.mjs --le 20 --le-steps 2000   # 冒烟
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateTarget } from '../server/research/score.mjs';
import { mulberry32, hashString } from '../src/rng.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const GS_N = Number(args.gs ?? 700);
const LE_N = Number(args.le ?? 160);
const LE_STEPS = Number(args['le-steps'] ?? 12000);
const W = Number(args.w ?? 64);
const H = Number(args.h ?? 64);
const OUT = path.resolve(ROOT, args.out ?? 'tools/surrogate-dataset.json');

const TARGETS = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'research', 'targets.json'), 'utf8')).targets;
const GS_TARGET = TARGETS.find((t) => t.id === 'gs-spots-lit') || TARGETS.find((t) => t.verify?.model !== 'lengyelEpstein');
const LE_TARGET = TARGETS.find((t) => t.verify?.model === 'lengyelEpstein');
if (!GS_TARGET) throw new Error('缺少 Gray–Scott 目标');
if (LE_N > 0 && !LE_TARGET) throw new Error('缺少 Lengyel–Epstein 目标');

const RANGES = {
  grayScott: { f: [0.01, 0.06], k: [0.04, 0.073] },
  lengyelEpstein: { a: [5, 14], b: [1, 8], sigma: [0.3, 2.0] },
};

/* 拉丁超立方：每维分层后独立打乱，比纯随机覆盖更均匀 */
function latinHypercube(n, lows, highs, seedStr) {
  const rand = mulberry32(hashString(seedStr));
  const dims = lows.length;
  const cols = [];
  for (let d = 0; d < dims; d++) {
    const col = new Array(n);
    for (let i = 0; i < n; i++) col[i] = (i + rand()) / n;
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [col[i], col[j]] = [col[j], col[i]];
    }
    cols.push(col.map((t) => lows[d] + t * (highs[d] - lows[d])));
  }
  return Array.from({ length: n }, (_, i) => cols.map((c) => c[i]));
}

function downsample(field, w, h, size = 16) {
  const out = new Array(size * size).fill(0);
  const bw = w / size;
  const bh = h / size;
  for (let by = 0; by < size; by++) {
    for (let bx = 0; bx < size; bx++) {
      let sum = 0;
      let count = 0;
      const x0 = Math.floor(bx * bw);
      const x1 = Math.floor((bx + 1) * bw);
      const y0 = Math.floor(by * bh);
      const y1 = Math.floor((by + 1) * bh);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          sum += field[y * w + x];
          count++;
        }
      }
      out[by * size + bx] = Math.round((sum / Math.max(1, count)) * 10000) / 10000;
    }
  }
  return out;
}

function round(v, d = 6) {
  return Math.round(v * 10 ** d) / 10 ** d;
}

function makeSamples(kind, n, seedStr, makeParams, target, steps) {
  const names = Object.keys(RANGES[kind]);
  const lows = names.map((k) => RANGES[kind][k][0]);
  const highs = names.map((k) => RANGES[kind][k][1]);
  const matrix = latinHypercube(n, lows, highs, seedStr);
  const samples = [];
  const started = Date.now();
  matrix.forEach((row, i) => {
    const params = makeParams(row);
    const res = evaluateTarget(target, { ...params, dt: kind === 'grayScott' ? 1 : 0.001 }, {
      w: W, h: H, includeField: true,
    });
    samples.push({
      params: row.map((v) => round(v)),
      features: {
        density: round(res.features.density, 6),
        anisotropy: round(res.features.anisotropy, 6),
        period: round(res.features.period, 6),
        components: round(res.features.components, 6),
        perimeter: round(res.features.perimeter, 6),
      },
      field: downsample(res.field, W, H, 16),
    });
    if ((i + 1) % 25 === 0 || i === n - 1) {
      const sec = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`[surrogate] ${kind} ${i + 1}/${n}  ${sec}s`);
    }
  });
  return {
    kind,
    params: names,
    ranges: RANGES[kind],
    steps,
    samples,
  };
}

const out = {
  version: 1,
  generatedAt: new Date().toISOString(),
  w: W,
  h: H,
  fieldSize: 16,
  kinds: {},
};

const gs = makeSamples('grayScott', GS_N, 'surrogate-gs-v1', (row) => ({
  f: row[0], k: row[1], D_u: 0.16, D_v: 0.08,
}), GS_TARGET, 480);
out.kinds.grayScott = gs;

if (LE_N > 0) {
  const le = makeSamples('lengyelEpstein', LE_N, 'surrogate-le-v1', (row) => ({
    a: row[0], b: row[1], sigma: row[2], D_v: 80,
  }), LE_TARGET, LE_STEPS);
  le.steps = LE_STEPS;
  out.kinds.lengyelEpstein = le;
}

fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`[surrogate] 写入 ${OUT}  ${(fs.statSync(OUT).size / 1024 / 1024).toFixed(2)} MB`);
