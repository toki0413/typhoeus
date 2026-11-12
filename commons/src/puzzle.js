/* ==========================================================================
 * Foldit 式斑图解谜 — 关卡、评分、局部搜索
 *
 * 分工：
 *   人    → 画 64×64 初始种子（高维空间搜索）
 *   机器  → Wiggle（f/k 局部坐标下降）、Shake（种子随机抖动）
 *
 * 诚实边界：
 *   - 目标斑图由已知参数 + 固定种子合成，是“盲盒标定关卡”，不是实验数据。
 *   - 评分只比较结构统计与 8×8 区域布局，不宣称参数唯一。
 * ========================================================================== */

import { ReactionDiffusionEngine, normalizeField } from './scientific.js';
import { extractPatternFeatures, featureDistance } from './fit.js';
import { mulberry32, hashInts, clamp } from './rng.js';

export const PUZZLE_SIZE = 64;
export const PUZZLE_ZONE_GRID = 8;
export const PUZZLE_DU = 0.16;
export const PUZZLE_DV = 0.08;
export const PUZZLE_REPLICATES = 3;
export const INK_FREE = 0.06;
export const INK_CAP = 0.22;
export const MIN_PAINTED = 8;

/* 合成标定关卡：目标参数藏在 level.target，玩家只看到目标斑图。
 * start 故意偏离 target，让 f/k 滑杆与 Wiggle 都有事可做。 */
export const PUZZLE_LEVELS = [
  {
    id: 'spots-garden',
    name: '斑点花园',
    subtitle: '让种子长成一片分离的斑点',
    classLabel: '斑点 · Spots',
    target: { f: 0.035, k: 0.062 },
    start: { f: 0.024, k: 0.054 },
    knobs: {
      f: { min: 0.020, max: 0.040, step: 0.001 },
      k: { min: 0.052, max: 0.068, step: 0.001 },
    },
    steps: 480,
    targetSeed: 104729,
    targetBlobs: 4,
    refs: ['Gray & Scott 1984', 'Pearson 1993 斑图分类'],
    hint: '斑点之间需要留白；先把种子放在画面中央，再观察它如何分裂。',
  },
  {
    id: 'stripes-river',
    name: '条纹河流',
    subtitle: '把斑点拉成连续的条纹',
    classLabel: '条纹 · Stripes',
    target: { f: 0.014, k: 0.052 },
    start: { f: 0.022, k: 0.058 },
    knobs: {
      f: { min: 0.010, max: 0.024, step: 0.001 },
      k: { min: 0.046, max: 0.062, step: 0.001 },
    },
    steps: 480,
    targetSeed: 130363,
    targetBlobs: 4,
    refs: ['Gray & Scott 1984', 'Akaiwa et al. 2005'],
    hint: '降低 feed 速率会更容易形成连续条纹；墨量越少，分数越高。',
  },
  {
    id: 'maze-brain',
    name: '迷宫大脑',
    subtitle: '在斑点与条纹的边界上种出迷宫',
    classLabel: '迷宫 · Labyrinth',
    target: { f: 0.026, k: 0.058 },
    start: { f: 0.034, k: 0.052 },
    knobs: {
      f: { min: 0.020, max: 0.034, step: 0.001 },
      k: { min: 0.052, max: 0.064, step: 0.001 },
    },
    steps: 480,
    targetSeed: 155921,
    targetBlobs: 3,
    refs: ['Pearson 1993 混沌迷宫模式'],
    hint: '迷宫对 f/k 很敏感；先用 Wiggle 粗调，再手动微调。',
  },
  {
    id: 'coral-reef',
    name: '珊瑚礁',
    subtitle: '让分枝从少量种子向外生长',
    classLabel: '珊瑚 · Coral',
    target: { f: 0.030, k: 0.058 },
    start: { f: 0.040, k: 0.064 },
    knobs: {
      f: { min: 0.024, max: 0.042, step: 0.001 },
      k: { min: 0.052, max: 0.066, step: 0.001 },
    },
    steps: 480,
    targetSeed: 196613,
    targetBlobs: 5,
    refs: ['Kondo & Miura 2010', 'Pearson 1993'],
    hint: '珊瑚会沿种子边缘分枝；把种子放在目标最密的区域。',
  },
];

const targetCache = new Map();

export function getLevel(id) {
  return PUZZLE_LEVELS.find((l) => l.id === id) || PUZZLE_LEVELS[0];
}

/* ------------------------------------------------------------------ */
/* 种子与场                                                            */
/* ------------------------------------------------------------------ */

export function makeSoupMask(seed, size = PUZZLE_SIZE, density = 0.05) {
  const rng = mulberry32(seed >>> 0);
  const mask = new Float32Array(size * size);
  for (let i = 0; i < mask.length; i++) {
    if (rng() < density) mask[i] = 1;
  }
  return mask;
}

/* 关卡目标种子：少量“核”而不是随机尘埃。
 * 修正后的 Gray-Scott 需要半径 ≥3 的连通核才能成核；
 * 4 个半径 4–6 的核在 480 步后仍保留空间布局信息。 */
export function makeLevelMask(level, size = PUZZLE_SIZE) {
  const rng = mulberry32(level.targetSeed >>> 0);
  const mask = new Float32Array(size * size);
  const blobCount = level.targetBlobs || 4;
  const margin = 10;
  for (let n = 0; n < blobCount; n++) {
    const cx = margin + rng() * (size - margin * 2);
    const cy = margin + rng() * (size - margin * 2);
    const radius = 4 + rng() * 2;
    stampMask(mask, cx, cy, { brush: radius, size });
  }
  return mask;
}

export function makeStarterMask(size = PUZZLE_SIZE) {
  const mask = new Float32Array(size * size);
  const c = size / 2;
  const radius = 3;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (Math.hypot(x - c, y - c) < radius) mask[y * size + x] = 1;
    }
  }
  return mask;
}

export function countPainted(mask, threshold = 0.5) {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] > threshold) n++;
  return n;
}

/* 从种子场跑一次确定性 Gray-Scott，返回归一化 v 场 */
export function runField(mask, f, k, steps, size = PUZZLE_SIZE) {
  const rd = new ReactionDiffusionEngine(size, size, {
    engine: 'grayScott', D_u: PUZZLE_DU, D_v: PUZZLE_DV, dt: 1.0,
    f, k, boundary: 'torus',
  });
  rd.u.fill(1);
  rd.v.fill(0);
  for (let i = 0; i < mask.length; i++) {
    const m = mask[i];
    if (m <= 0) continue;
    rd.u[i] = 1 - 0.5 * m;
    rd.v[i] = 0.25 * m;
  }
  for (let s = 0; s < steps; s++) rd.step();
  return normalizeField(rd.v);
}

export function zoneDensity(field, size = PUZZLE_SIZE, grid = PUZZLE_ZONE_GRID) {
  const zones = new Float32Array(grid * grid);
  const counts = new Float32Array(grid * grid);
  for (let y = 0; y < size; y++) {
    const gy = Math.min(grid - 1, Math.floor((y * grid) / size));
    for (let x = 0; x < size; x++) {
      const gx = Math.min(grid - 1, Math.floor((x * grid) / size));
      const zi = gy * grid + gx;
      counts[zi]++;
      if (field[y * size + x] > 0.5) zones[zi]++;
    }
  }
  for (let i = 0; i < zones.length; i++) zones[i] /= Math.max(1, counts[i]);
  return zones;
}

export function getTarget(id) {
  const level = getLevel(id);
  if (targetCache.has(level.id)) return targetCache.get(level.id);
  const mask = makeLevelMask(level);
  const field = runField(mask, level.target.f, level.target.k, level.steps);
  const target = {
    level,
    mask,
    field,
    features: extractPatternFeatures(field, PUZZLE_SIZE, PUZZLE_SIZE),
    zones: zoneDensity(field),
    params: { ...level.target },
  };
  targetCache.set(level.id, target);
  return target;
}

/* ------------------------------------------------------------------ */
/* 画笔                                                                */
/* ------------------------------------------------------------------ */

export function stampMask(mask, cx, cy, { brush = 4, erase = false, size = PUZZLE_SIZE } = {}) {
  const r = Math.max(1, brush);
  const r2 = r * r;
  let changed = 0;
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(size - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(size - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      if (d2 > r2) continue;
      const falloff = 1 - d2 / r2;
      const idx = y * size + x;
      const before = mask[idx];
      if (erase) mask[idx] = Math.max(0, before - falloff);
      else mask[idx] = Math.min(1, Math.max(before, falloff));
      if (mask[idx] !== before) changed++;
    }
  }
  return changed;
}

export function stampLine(mask, x0, y0, x1, y1, opts = {}) {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(dist * 1.5));
  let changed = 0;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    changed += stampMask(mask, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, opts);
  }
  return changed;
}

export function clearMask(size = PUZZLE_SIZE) {
  return new Float32Array(size * size);
}

/* ------------------------------------------------------------------ */
/* Shake：保持墨量大致不变，随机挪动 10 格                              */
/* ------------------------------------------------------------------ */

export function shakeMask(mask, seed, size = PUZZLE_SIZE) {
  const next = Float32Array.from(mask);
  const rng = mulberry32(seed >>> 0);
  const painted = [];
  const empty = [];
  for (let i = 0; i < next.length; i++) {
    if (next[i] > 0.5) painted.push(i);
    else if (next[i] < 0.01) empty.push(i);
  }
  const removeCount = Math.min(10, Math.max(0, painted.length - MIN_PAINTED));
  for (let n = 0; n < removeCount; n++) {
    const k = Math.floor(rng() * painted.length);
    next[painted[k]] = 0;
    painted.splice(k, 1);
  }
  const addCount = Math.min(10, empty.length);
  for (let n = 0; n < addCount; n++) {
    const k = Math.floor(rng() * empty.length);
    next[empty[k]] = 1;
    empty.splice(k, 1);
  }
  return next;
}

export function shakeSession(session) {
  session.shakes += 1;
  const seed = hashInts([session.level.targetSeed, session.shakes, 0x9E37]);
  session.mask = shakeMask(session.mask, seed);
  return session.mask;
}

/* ------------------------------------------------------------------ */
/* 会话与评分                                                          */
/* ------------------------------------------------------------------ */

function snapToRange(value, range) {
  if (!Number.isFinite(value)) return null;
  const clamped = Math.max(range.min, Math.min(range.max, value));
  const step = range.step || 0.001;
  return Math.round((Math.round(clamped / step) * step) * 1e6) / 1e6;
}

/**
 * 创建关卡会话。
 * opts.f / opts.k：从当前生命继承的参数；会按关卡允许范围裁剪。
 * opts.inherited：继承来源元数据，只用于 UI 展示。
 */
export function createSession(levelId, { f, k, inherited = null } = {}) {
  const level = getLevel(levelId);
  const fv = snapToRange(f, level.knobs.f);
  const kv = snapToRange(k, level.knobs.k);
  const clamped = (fv !== null && Math.abs(fv - f) > 1e-9)
    || (kv !== null && Math.abs(kv - k) > 1e-9);
  return {
    levelId: level.id,
    level,
    mask: makeStarterMask(),
    f: fv ?? level.start.f,
    k: kv ?? level.start.k,
    inherited: inherited
      ? { ...inherited, clamped, requestedF: f, requestedK: k }
      : null,
    shakes: 0,
    token: 0,
  };
}

function meanFeatures(list) {
  const keys = ['density', 'entropy', 'period', 'fractal'];
  const out = {};
  for (const key of keys) {
    const vals = list.map((f) => f[key]).filter((v) => Number.isFinite(v));
    if (key === 'period') {
      const nz = vals.filter((v) => v > 0);
      out[key] = nz.length ? nz.reduce((a, b) => a + b, 0) / nz.length : 0;
    } else {
      out[key] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    }
  }
  return out;
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na * nb);
  return denom > 1e-12 ? clamp(dot / denom, 0, 1) : 0;
}

function perturbMask(mask, seed, size = PUZZLE_SIZE) {
  const next = Float32Array.from(mask);
  const rng = mulberry32(seed >>> 0);
  const flipCount = Math.max(2, Math.round(next.length * 0.01));
  for (let n = 0; n < flipCount; n++) {
    const i = Math.floor(rng() * next.length);
    next[i] = next[i] > 0.5 ? 0 : 1;
  }
  /* 保证扰动后仍有可演化的种子 */
  let painted = countPainted(next);
  while (painted < MIN_PAINTED) {
    const i = Math.floor(rng() * next.length);
    if (next[i] <= 0.5) { next[i] = 1; painted++; }
  }
  return next;
}

export function scoreAttempt(target, fields, mask) {
  const features = fields.map((field) => extractPatternFeatures(field, PUZZLE_SIZE, PUZZLE_SIZE));
  const mean = meanFeatures(features);
  const distance = featureDistance(target.features, mean);
  const sStruct = 100 * Math.exp(-distance * distance);

  const zones = zoneDensity(fields[0]);
  const layout = cosine(target.zones, zones);
  const sLayout = 100 * layout * Math.min(1, sStruct / 60);

  let sigma = 0;
  let pairs = 0;
  for (let i = 0; i < features.length; i++) {
    for (let j = i + 1; j < features.length; j++) {
      sigma += featureDistance(features[i], features[j]);
      pairs++;
    }
  }
  sigma = pairs ? sigma / pairs : 0;
  const sRobust = 100 * Math.exp(-sigma * sigma) * Math.min(1, sStruct / 50);

  const painted = countPainted(mask);
  const ink = painted / (PUZZLE_SIZE * PUZZLE_SIZE);
  const sInk = painted < MIN_PAINTED
    ? 0
    : 100 * clamp((INK_CAP - ink) / (INK_CAP - INK_FREE), 0, 1);

  const valid = painted >= MIN_PAINTED;
  const total = valid
    ? clamp(0.50 * sStruct + 0.25 * sLayout + 0.15 * sRobust + 0.10 * sInk, 0, 100)
    : 0;

  return {
    total,
    sStruct,
    sLayout,
    sRobust,
    sInk,
    distance,
    sigma,
    ink,
    painted,
    valid,
    features,
    mean,
    zones,
    targetZones: target.zones,
  };
}

export function evaluate(session) {
  const target = getTarget(session.levelId);
  const painted = countPainted(session.mask);
  if (painted < MIN_PAINTED) {
    return {
      ...scoreAttempt(target, [new Float32Array(PUZZLE_SIZE * PUZZLE_SIZE)], session.mask),
      total: 0,
      valid: false,
      field: new Float32Array(PUZZLE_SIZE * PUZZLE_SIZE),
      fields: [],
      target,
    };
  }
  const masks = [session.mask];
  for (let i = 1; i < PUZZLE_REPLICATES; i++) {
    const seed = hashInts([target.level.targetSeed, 0x5EED, i]);
    masks.push(perturbMask(session.mask, seed));
  }
  const fields = masks.map((m) => runField(m, session.f, session.k, session.level.steps));
  const score = scoreAttempt(target, fields, session.mask);
  return { ...score, field: fields[0], fields, masks, target };
}

/* ------------------------------------------------------------------ */
/* Wiggle：只调 f/k，固定评估预算                                      */
/* ------------------------------------------------------------------ */

function quickObjective(target, mask, f, k, steps) {
  const field = runField(mask, f, k, steps);
  const features = extractPatternFeatures(field, PUZZLE_SIZE, PUZZLE_SIZE);
  const distance = featureDistance(target.features, features);
  const sStruct = 100 * Math.exp(-distance * distance);
  const sLayout = 100 * cosine(target.zones, zoneDensity(field));
  return sStruct + 0.5 * sLayout;
}

export async function wiggle(session, {
  budget = 24,
  onProgress = null,
  isCancelled = null,
} = {}) {
  const level = session.level;
  const target = getTarget(level.id);
  const cache = new Map();
  let evals = 0;

  const evaluateCandidate = (f, k) => {
    const key = `${f.toFixed(3)}|${k.toFixed(3)}`;
    if (cache.has(key)) return cache.get(key);
    const score = quickObjective(target, session.mask, f, k, level.steps);
    cache.set(key, score);
    evals++;
    return score;
  };

  const startF = session.f;
  const startK = session.k;
  const initialScore = evaluateCandidate(startF, startK);
  let best = { f: startF, k: startK, score: initialScore };
  if (onProgress) onProgress(evals, budget, { ...best });

  const steps = [0.004, 0.002, 0.001, 0.0005];
  for (const step of steps) {
    for (const key of ['f', 'k']) {
      if (evals >= budget) break;
      for (const sign of [-1, 1]) {
        if (evals >= budget) break;
        if (isCancelled && isCancelled()) {
          return { ...best, evals, gain: best.score, cancelled: true };
        }
        const range = level.knobs[key];
        const raw = best[key] + sign * step;
        const value = Math.round(clamp(raw, range.min, range.max) / 0.001) * 0.001;
        if (value === best[key]) continue;
        const score = evaluateCandidate(value, key === 'f' ? best.k : best.f);
        if (score > best.score + 1e-9) {
          best = { f: key === 'f' ? value : best.f, k: key === 'k' ? value : best.k, score };
        }
        if (onProgress) onProgress(evals, budget, { ...best });
        /* 让出主线程，避免 4 秒的搜索冻结 UI */
        if (evals % 4 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
  }

  return {
    ...best,
    evals,
    gain: best.score - initialScore,
    cancelled: false,
  };
}

/* ------------------------------------------------------------------ */
/* 本地进度                                                            */
/* ------------------------------------------------------------------ */

const PROGRESS_KEY = 'commons.puzzle.v1';
let _memFallback = null;

function safeStorage() {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
  } catch (_) { /* 隐私模式 / Node 环境 */ }
  if (!_memFallback) _memFallback = new Map();
  return {
    getItem: (k) => (_memFallback.has(k) ? _memFallback.get(k) : null),
    setItem: (k, v) => { _memFallback.set(k, String(v)); },
    removeItem: (k) => { _memFallback.delete(k); },
  };
}

export function loadPuzzleProgress() {
  try {
    const raw = safeStorage().getItem(PROGRESS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

export function savePuzzleProgress(levelId, record) {
  const all = loadPuzzleProgress();
  const prev = all[levelId] || {};
  const best = Math.max(Number(prev.best) || 0, Number(record.best) || 0);
  all[levelId] = {
    ...prev,
    ...record,
    best,
    stars: starsFor(best),
    updatedAt: Date.now(),
  };
  try {
    safeStorage().setItem(PROGRESS_KEY, JSON.stringify(all));
  } catch (_) { /* 静默失败，不影响游戏 */ }
  return all;
}

export function starsFor(score) {
  if (score >= 85) return 3;
  if (score >= 70) return 2;
  if (score >= 50) return 1;
  return 0;
}

export function isLevelUnlocked(index, progress = loadPuzzleProgress()) {
  if (index <= 0) return true;
  const prev = PUZZLE_LEVELS[index - 1];
  return (Number(progress[prev.id]?.best) || 0) >= 60;
}
