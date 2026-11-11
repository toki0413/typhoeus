/* ==========================================================================
 * 环境预设 — 7 个常规 + 6 个极端环境
 * 从 app.js 抽出：纯数据表，依赖 engines.defaultEnv / BOUNDARIES。
 * ========================================================================== */

import { defaultEnv, BOUNDARIES } from '../engines.js';

export const ENV_PRESETS = [
  { id: 'torus-soup', label: '环面 · 随机汤', env: defaultEnv({ pattern: 'soup', boundary: 'torus', noise: 0 }) },
  { id: 'wall-sparse', label: '硬壁 · 稀疏', env: defaultEnv({ pattern: 'sparse', boundary: 'wall', noise: 0.01 }) },
  { id: 'feed', label: '环面 · 营养脉冲', env: defaultEnv({ pattern: 'soup', boundary: 'torus', resource: { rate: 0.26, period: 70 } }) },
  { id: 'noise', label: '环面 · 高扰动', env: defaultEnv({ pattern: 'sparse', boundary: 'torus', noise: 0.16, constraint: 0.12 }) },
  { id: 'blob', label: '环面 · 团块', env: defaultEnv({ pattern: 'blob', boundary: 'torus', noise: 0 }) },
  { id: 'ring', label: '硬壁 · 环带', env: defaultEnv({ pattern: 'ring', boundary: 'wall', noise: 0.02 }) },
  { id: 'low-constraint', label: '环面 · 低约束', env: defaultEnv({ pattern: 'soup', boundary: 'torus', noise: 0.08, constraint: 0.05 }) },
];

/* ---- 🌌 外星/极端环境预设（一键切换）---- */
export const EXOTIC_ENVIRONMENTS = [
  { id: 'exo-primitive',
    label: '原始地球', emoji: '🌍',
    desc: '38 亿年前，高扰动是 Turing 不稳定性的温床',
    env: defaultEnv({ pattern: 'soup', boundary: 'torus', noise: 0.15, constraint: 0.1, timeScale: 2.0 }) },
  { id: 'exo-venus',
    label: '金星高压', emoji: '🔥',
    desc: '时间慢 5×，边界严格，生命活得很慢',
    env: defaultEnv({ pattern: 'blob', boundary: 'wall', noise: 0, constraint: 0.9, timeScale: 0.2 }) },
  { id: 'exo-europa',
    label: '木卫二冰下', emoji: '🧊',
    desc: '微小热扰动 + 边界松散 → 螺旋波涌现',
    env: defaultEnv({ pattern: 'ring', boundary: 'torus', noise: 0.05, constraint: 0.2, timeScale: 2.5 }) },
  { id: 'exo-mars',
    label: '火星殖民', emoji: '🪐',
    desc: '低重力 = 边界松散，形态迅速膨胀',
    env: defaultEnv({ pattern: 'soup', boundary: 'torus', noise: 0.25, constraint: 0.05, timeScale: 2.5 }) },
  { id: 'exo-saturn',
    label: '土星环碎片场', emoji: '💍',
    desc: '极快时间 + 高扰动 → 混沌吸引子主导',
    env: defaultEnv({ pattern: 'sparse', boundary: 'torus', noise: 0.6, constraint: 0.4, timeScale: 5.0 }) },
  { id: 'exo-blackhole',
    label: '黑洞潮汐', emoji: '🕳️',
    desc: '几乎静止 + 严格边界 → 冻结晶体',
    env: defaultEnv({ pattern: 'blob', boundary: 'wall', noise: 0, constraint: 1.0, timeScale: 0.05 }) },
];

export const BOUNDARY_LABEL = { torus: BOUNDARIES.torus.label, wall: BOUNDARIES.wall.label };
