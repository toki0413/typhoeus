/**
 * 纯 JS 神经代理推理
 *
 * 权重由 tools/train_surrogate.py 用 numpy 训练并导出为 JSON：
 *   标量参数 → 5 维结构签名 + 16 维 PCA 场系数
 *
 * 诚实边界：这是降阶代理（MLP），不是严格意义的 DeepONet/FNO，
 * 也不参与最终评分。它的输出只用于给候选排序，分数必须由 /verify 重跑确认。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signatureDistance } from './signature.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODEL_FILE = path.join(HERE, 'surrogate.json');

export const FEATURE_KEYS = ['density', 'anisotropy', 'period', 'components', 'perimeter'];

export function loadSurrogate(file = MODEL_FILE) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw?.kinds?.grayScott && !raw?.kinds?.lengyelEpstein) return null;
    return raw;
  } catch (_) {
    return null;
  }
}

function forward(kindModel, x) {
  let h = x;
  const layers = kindModel.layers;
  for (let i = 0; i < layers.length; i++) {
    const { w, b } = layers[i];
    const out = new Float64Array(b.length);
    for (let j = 0; j < b.length; j++) {
      let sum = b[j];
      for (let k = 0; k < h.length; k++) sum += h[k] * w[k][j];
      out[j] = sum;
    }
    h = i < layers.length - 1 ? Array.from(out, (v) => Math.tanh(v)) : out;
  }
  return h;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

export function predict(model, kind, params) {
  const m = model?.kinds?.[kind];
  if (!m) return null;
  const x = m.params.map((name) => Number(params[name]));
  if (x.some((v) => !Number.isFinite(v))) return null;
  const xn = x.map((v, i) => (v - m.xMean[i]) / m.xStd[i]);
  const out = forward(m, xn);

  const features = {};
  FEATURE_KEYS.forEach((key, i) => {
    features[key] = out[i] * m.sigStd[i] + m.sigMean[i];
  });
  features.density = clamp(features.density, 0, 1);
  features.anisotropy = clamp(features.anisotropy, 0, 1);
  features.period = clamp(features.period, 0, 64);
  features.components = clamp(features.components, 0, 1);
  features.perimeter = clamp(features.perimeter, 0, 4);

  const coeff = out.slice(5).map((v, i) => v * m.coeffStd[i] + m.coeffMean[i]);
  const field = new Float64Array(m.fieldMean.length);
  for (let i = 0; i < field.length; i++) {
    let sum = m.fieldMean[i];
    for (let k = 0; k < coeff.length; k++) sum += coeff[k] * m.basis[k][i];
    field[i] = clamp(sum, 0, 1);
  }

  return { features, field };
}

export function predictScore(model, kind, targetFeatures, params) {
  const result = predict(model, kind, params);
  if (!result) return null;
  const distance = signatureDistance(targetFeatures, result.features);
  return {
    ...result,
    distance: Math.round(distance * 1000) / 1000,
    predictedScore: Math.round((100 / (1 + distance)) * 10) / 10,
  };
}

function grid(values) {
  return values.map((v) => Math.round(v * 1000) / 1000);
}

function linspace(lo, hi, n) {
  return Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
}

export function rankCandidates(model, kind, targetFeatures, limit = 3) {
  const m = model?.kinds?.[kind];
  if (!m) return [];
  const candidates = [];

  /* 候选池来自训练采样点：代理只在见过的参数分布内排序，
   * 不在稀疏角落外推（LE 的外推会把 a=12,b=1,σ=2 错判成高分）。 */
  if (Array.isArray(m.pool) && m.pool.length) {
    for (const row of m.pool) {
      const params = Object.fromEntries(m.params.map((name, i) => [name, row[i]]));
      if (kind === 'grayScott') {
        params.D_u = 0.16;
        params.D_v = 0.08;
      } else {
        params.D_v = 80;
      }
      candidates.push(params);
    }
  } else if (kind === 'grayScott') {
    for (const f of grid(linspace(0.012, 0.058, 24))) {
      for (const k of grid(linspace(0.042, 0.072, 20))) {
        candidates.push({ f, k, D_u: 0.16, D_v: 0.08 });
      }
    }
  } else {
    for (const a of grid(linspace(5, 14, 12))) {
      for (const b of grid(linspace(1, 8, 8))) {
        for (const sigma of grid(linspace(0.3, 2.0, 9))) {
          candidates.push({ a, b, sigma, D_v: 80 });
        }
      }
    }
  }

  const scored = [];
  for (const params of candidates) {
    const prediction = predictScore(model, kind, targetFeatures, params);
    if (prediction) scored.push({ ...params, ...prediction });
  }
  scored.sort((a, b) => b.predictedScore - a.predictedScore);

  /* 前几名常常挤在同一个峰附近；隔开参数距离，给出真正不同的候选 */
  const picked = [];
  for (const item of scored) {
    const tooClose = picked.some((p) => {
      if (kind === 'grayScott') {
        return Math.abs(p.f - item.f) < 0.002 && Math.abs(p.k - item.k) < 0.002;
      }
      return Math.abs(p.a - item.a) < 0.4
        && Math.abs(p.b - item.b) < 0.3
        && Math.abs(p.sigma - item.sigma) < 0.08;
    });
    if (!tooClose) picked.push(item);
    if (picked.length >= limit) break;
  }
  return picked;
}

export function surrogateSummary(model) {
  if (!model) return null;
  return {
    kind: model.kind,
    components: model.components,
    createdAt: model.createdAt,
    note: model.note,
    kinds: Object.fromEntries(
      Object.entries(model.kinds).map(([kind, m]) => [kind, m.metrics?.holdout || null]),
    ),
  };
}
