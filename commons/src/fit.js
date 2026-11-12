/* 实验斑图参数拟合
 *
 * 目标：把一张实验/显微斑图转成归一化标量场，提取结构统计特征，
 * 在 Gray-Scott 参数网格上搜索最接近这些特征的参数组合。
 *
 * 诚实边界：
 *   - 拟合的是结构统计（密度 / Shannon 熵 / 相关长度 / 盒计数维数），
 *     不是像素级相位匹配；RD 斑图的相位对初始条件极敏感。
 *   - 输出是“结构最接近”的参数，不宣称唯一解或实验真值。
 */

import { ReactionDiffusionEngine, computeFieldEntropy, computeSpatialPeriod, computeFractalDimension } from './scientific.js';

/* 特征归一化尺度：把不同量纲的特征变成可比较的无量纲距离。
 * density/entropy ∈ [0,1]；period 单位格；fractal ∈ [0.5,2]。 */
export const FEATURE_SCALES = { density: 0.2, entropy: 0.2, period: 12, fractal: 0.35 };
export const FEATURE_WEIGHTS = { density: 1.0, entropy: 0.8, period: 1.0, fractal: 0.8 };

/* 拟合分辨率与演化步数：
 * - 64×64：相关长度搜索上限为 32 格，能测到 16~24 格的真实斑图波长；
 *   48×48 时上限 24 格，稍长的波长会被截断为 0。
 * - 480 步：Gray-Scott 斑点在该时间尺度已完成初始线性增长并进入非线性斑图，
 *   再增加步数特征基本不变（实测 480/540/600 步特征一致）。 */
export const DEFAULT_FIT_SIZE = 64;
export const DEFAULT_FIT_STEPS = 480;

export const DEFAULT_FIT_GRID = {
  f: [0.02, 0.03, 0.04],
  k: [0.055, 0.060, 0.065],
  Du: [0.14, 0.16, 0.18],
};

/* RGBA ImageData → 归一化灰度场（双线性缩放） */
export function imageToField(imageData, w, h, { invert = false } = {}) {
  const { data, width, height } = imageData;
  if (!data || !width || !height) throw new Error('imageToField: 无效 ImageData');
  const gray = new Float32Array(width * height);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    let val = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    if (invert) val = 1 - val;
    gray[i] = val;
    if (val < min) min = val;
    if (val > max) max = val;
  }
  const span = max - min || 1;
  const out = new Float32Array(w * h);
  const sample = (fx, fy) => {
    const x0 = Math.max(0, Math.min(width - 1, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(height - 1, Math.floor(fy)));
    const x1 = Math.min(width - 1, x0 + 1);
    const y1 = Math.min(height - 1, y0 + 1);
    const tx = Math.max(0, Math.min(1, fx - x0));
    const ty = Math.max(0, Math.min(1, fy - y0));
    const a = gray[y0 * width + x0] * (1 - tx) + gray[y0 * width + x1] * tx;
    const b = gray[y1 * width + x0] * (1 - tx) + gray[y1 * width + x1] * tx;
    return a * (1 - ty) + b * ty;
  };
  for (let y = 0; y < h; y++) {
    const fy = ((y + 0.5) * height) / h - 0.5;
    for (let x = 0; x < w; x++) {
      const fx = ((x + 0.5) * width) / w - 0.5;
      out[y * w + x] = (sample(fx, fy) - min) / span;
    }
  }
  return out;
}

/* 把任意场拉伸到 [0,1]（只用于特征提取/显示，不改变动力学） */
export function normalizeField(field) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < field.length; i++) {
    if (field[i] < min) min = field[i];
    if (field[i] > max) max = field[i];
  }
  const span = max - min || 1;
  const out = new Float32Array(field.length);
  for (let i = 0; i < field.length; i++) out[i] = (field[i] - min) / span;
  return out;
}

/* 结构统计特征（与科学引擎 metrics 使用同一组定义） */
export function extractPatternFeatures(field, w, h, threshold = 0.5) {
  let occupied = 0;
  for (let i = 0; i < field.length; i++) if (field[i] > threshold) occupied++;
  const density = occupied / Math.max(1, field.length);
  const entropy = computeFieldEntropy(field);
  const period = computeSpatialPeriod(field, w, h);
  const fractal = computeFractalDimension(field, w, h, threshold);
  return { density, entropy, period, fractal };
}

/* 无量纲结构距离 */
export function featureDistance(target, candidate) {
  let sum = 0;
  for (const key of ['density', 'entropy', 'period', 'fractal']) {
    const a = Number.isFinite(target[key]) ? target[key] : 0;
    const b = Number.isFinite(candidate[key]) ? candidate[key] : 0;
    let diff;
    if (key === 'period') {
      /* 两边都测不到相关长度时，不计入距离；只有一边测不到才算差异 */
      if (!a && !b) diff = 0;
      else if (!a || !b) diff = 1;
      else diff = (a - b) / FEATURE_SCALES[key];
    } else diff = (a - b) / FEATURE_SCALES[key];
    sum += FEATURE_WEIGHTS[key] * diff * diff;
  }
  return Math.sqrt(sum);
}

/* 用已知参数生成参考斑图（用于验证拟合流程，不是实验数据） */
export function makeReferencePattern({
  w = DEFAULT_FIT_SIZE, h = DEFAULT_FIT_SIZE,
  f = 0.03, k = 0.06, Du = 0.16, Dv = 0.08, dt = 1.0, steps = DEFAULT_FIT_STEPS,
} = {}) {
  const rd = new ReactionDiffusionEngine(w, h, {
    preset: 'gs_spots', engine: 'grayScott', f, k, D_u: Du, D_v: Dv, dt, boundary: 'torus',
  });
  for (let i = 0; i < steps; i++) rd.step();
  return {
    field: normalizeField(rd.vField),
    params: { f, k, D_u: Du, D_v: Dv, dt },
    steps,
    w,
    h,
  };
}

/**
 * 参数网格搜索。
 * @param {object} target 目标结构特征
 * @param {object} opts { w,h,steps,grid,onProgress }
 * @returns {Promise<{best, top, target, evaluated}>}
 */
export async function fitPattern(target, {
  w = DEFAULT_FIT_SIZE, h = DEFAULT_FIT_SIZE, steps = DEFAULT_FIT_STEPS,
  grid = DEFAULT_FIT_GRID, onProgress = null,
} = {}) {
  const candidates = [];
  const fs = grid.f;
  const ks = grid.k;
  const dus = grid.Du;
  const total = fs.length * ks.length * dus.length;
  let evaluated = 0;

  for (const f of fs) {
    for (const k of ks) {
      for (const Du of dus) {
        const rd = new ReactionDiffusionEngine(w, h, {
          preset: 'gs_spots', engine: 'grayScott', f, k, D_u: Du, D_v: 0.08, dt: 1.0, boundary: 'torus',
        });
        for (let i = 0; i < steps; i++) rd.step();
        /* 拟合可见斑图场 v（归一化），与实验图的归一化灰度场可比 */
        const features = extractPatternFeatures(normalizeField(rd.vField), w, h);
        const distance = featureDistance(target, features);
        candidates.push({
          params: { f, k, D_u: Du, D_v: 0.08, dt: 1.0 },
          features,
          distance,
          score: 100 / (1 + distance),
        });
        evaluated++;
        if (onProgress) onProgress(evaluated, total, candidates[candidates.length - 1]);
        /* 让出主线程，避免长循环卡住 UI */
        if (evaluated % 4 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
  }

  candidates.sort((a, b) => a.distance - b.distance);
  return { best: candidates[0] || null, top: candidates.slice(0, 5), target, evaluated };
}
