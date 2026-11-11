/* ================================================================ */
/*  参数空间扫描 & 能量景观可视化                                     */
/*                                                                  */
/*  玩家选参数 → 自动跑 N×M 网格搜索 → 返回 2D 能量景观矩阵            */
/*                                                                  */
/*  数学原理：                                                      */
/*    对反应-扩散方程 f(u,v; p1, p2, ...) = 0，固定 p3,p4,...        */
/*    令 p1 在 [p1_min, p1_max] 均匀采样 N 个点                     */
/*    令 p2 在 [p2_min, p2_max] 均匀采样 M 个点                     */
/*    对每个网格点 (i,j)：                                          */
/*      固定随机种子 → 跑 K 步 → 记录指标向量 M(i,j)                 */
/*                                                                  */
/*    指标向量 = {                                                  */
/*      energy  : Landau 自由能密度,                                */
/*      fractal : 分形维数 D (0.5~2.0),                             */
/*      lyapunov: 最大 Lyapunov 指数 λ,                             */
/*      density : v 场覆盖率,                                       */
/*      period  : 空间周期 (格数),                                  */
/*      type    : attractor 类型 stable/chaotic/periodic/extinct    */
/*    }                                                             */
/*                                                                  */
/*  能量景观热图：                                                  */
/*    颜色 = f(metric)，默认用 energy.total，                     */
/*    可选切换为 fractal / lyapunov（"复杂度景观"/"混沌景观"）       */
/* ================================================================ */

import { simulateRD } from './cpm.js';

export const SCAN_METRICS = [
  { key: 'energy',  label: '自由能 E',       desc: 'Landau 自由能密度（越小越接近吸引子）' },
  { key: 'fractal', label: '分形维数 D',     desc: 'Box-counting 分形维数（1.0=简单, 1.9=高度复杂）' },
  { key: 'lyapunov', label: 'Lyapunov λ',   desc: '最大 Lyapunov 指数（>0 混沌, <0 稳定, ≈0 周期）' },
  { key: 'density', label: '密度',           desc: 'v 场非零格点占比' },
  { key: 'period',  label: '空间周期',       desc: '自相关峰间隔（格数）' },
  { key: 'complexity', label: '综合复杂度',  desc: 'w₁·fractal + w₂·|lyapunov| + w₃·log(E) 的加权和' },
];

/**
 * 为三种引擎预设默认扫描的"物理"参数（不是 Conway/B3/S23 那种规则）
 */
export const DEFAULT_SCAN_AXES = {
  grayScott: [
    { key: 'f',    label: '饲养速率 f',     min: 0.015, max: 0.060, defaultN: 16 },
    { key: 'k',    label: '杀伤速率 k',     min: 0.045, max: 0.085, defaultN: 16 },
    { key: 'D_u',  label: '激活扩散 D_u',   min: 0.5,   max: 2.0,   defaultN: 8 },
  ],
  fitzHughNagumo: [
    { key: 'c',    label: '耦合强度 c',     min: 4.0,   max: 18.0,  defaultN: 12 },
    { key: 'a',    label: '阈值 a',         min: 0.4,   max: 1.0,   defaultN: 12 },
    { key: 'b',    label: '恢复速率 b',     min: 0.5,   max: 1.1,   defaultN: 8 },
  ],
  brusselator: [
    { key: 'A',    label: '反应物 A',       min: 1.0,   max: 3.5,   defaultN: 12 },
    { key: 'B',    label: '反应物 B',       min: 2.5,   max: 6.0,   defaultN: 12 },
    { key: 'D_v',  label: '抑制扩散 D_v',   min: 0.1,   max: 0.6,   defaultN: 8 },
  ],
};

/**
 * 运行参数网格扫描（同步版本，直接返回结果，不流式）
 *
 * @param {object} baseParams  基础引擎参数（preset 或完整 params 对象）
 * @param {object} axes         { xAxis: {key, min, max, N}, yAxis: {key, min, max, N} }
 * @param {object} opts         { w, h, steps, rngSeed, progressCb }
 *
 * @returns {ScanResult}
 *   axes      — { xAxis, yAxis }（用户选的）
 *   points    — Float64Array(Nx × Ny)，energy 景观值（已归一化到 0~1）
 *   raw       — 同结构，各 metric 原始值
 *   gridX     — Float64Array，x 轴坐标值
 *   gridY     — Float64Array，y 轴坐标值
 *   bestPoint — { ix, iy, energy, params }（能量最低的点）
 *   worstPoint — 同上（能量最高的点）
 */
export async function runParameterScan(baseParams, axes, opts = {}) {
  const w = opts.w || 60;
  const h = opts.h || 40;
  const steps = opts.steps || 300;
  const rngBase = opts.rngSeed || 12345;
  const progressCb = opts.progressCb || null;

  const { xAxis, yAxis } = axes;
  const Nx = xAxis.N || 12;
  const Ny = yAxis.N || 12;

  // 构造网格坐标
  const gridX = new Float64Array(Nx);
  const gridY = new Float64Array(Ny);
  for (let i = 0; i < Nx; i++) gridX[i] = xAxis.min + (i / (Nx - 1)) * (xAxis.max - xAxis.min);
  for (let j = 0; j < Ny; j++) gridY[j] = yAxis.min + (j / (Ny - 1)) * (yAxis.max - yAxis.min);

  // 存储所有 metric 的原始值
  const raw = {
    energy:  new Float64Array(Nx * Ny),
    fractal: new Float64Array(Nx * Ny),
    lyapunov: new Float64Array(Nx * Ny),
    density: new Float64Array(Nx * Ny),
    period:  new Float64Array(Nx * Ny),
    type:    new Uint8Array(Nx * Ny), // 0=stable, 1=periodic, 2=chaotic, 3=drifting, 4=extinct
  };

  let bestEnergy = Infinity, worstEnergy = -Infinity;
  let bestIX = 0, bestIY = 0, worstIX = 0, worstIY = 0;

  const total = Nx * Ny;
  let done = 0;

  for (let iy = 0; iy < Ny; iy++) {
    for (let ix = 0; ix < Nx; ix++) {
      // 合并参数：base → 覆盖 xAxis / yAxis
      const params = { ...baseParams, [xAxis.key]: gridX[ix], [yAxis.key]: gridY[iy] };
      // 用确定性 RNG seed（每个网格点不同但可复现）
      const seed = rngBase + iy * Nx + ix;
      try {
        const res = await simulateRD(params, w, h, steps, seed);
        const m = res.metrics;
        const idx = iy * Nx + ix;
        raw.energy[idx]   = m.energy?.total ?? NaN;
        raw.fractal[idx]  = m.fractal ?? NaN;
        raw.lyapunov[idx] = m.lyapunov ?? NaN;
        raw.density[idx]  = m.density ?? NaN;
        raw.period[idx]   = m.spatialPeriod ?? NaN;
        // attractor type → 枚举
        const t = m.attrType;
        raw.type[idx] = t === 'stable' ? 0 : t === 'periodic' ? 1 : t === 'chaotic' ? 2 : t === 'drifting' ? 3 : t === 'extinct' ? 4 : 0;

        if (m.energy?.total < bestEnergy) { bestEnergy = m.energy.total; bestIX = ix; bestIY = iy; }
        if (m.energy?.total > worstEnergy) { worstEnergy = m.energy.total; worstIX = ix; worstIY = iy; }
      } catch (err) {
        const idx = iy * Nx + ix;
        raw.energy[idx] = NaN; raw.fractal[idx] = NaN;
      }

      done++;
      if (progressCb) progressCb(done / total);
    }
  }

  // 归一化 energy 到 0~1（低→0, 高→1；但用户看"能量越低越好"所以 heatmap 深色=好）
  const Emin = raw.energy.reduce((a, b) => Math.min(a, isNaN(b) ? a : b), Infinity);
  const Emax = raw.energy.reduce((a, b) => Math.max(a, isNaN(b) ? a : b), -Infinity);
  const Enorm = raw.energy.map(v => isNaN(v) ? 0.5 : (v - Emin) / (Emax - Emin || 1));

  return {
    axes,
    gridX, gridY,
    Nx, Ny,
    raw,
    energyNormalized: Enorm,
    bestPoint: { ix: bestIX, iy: bestIY, energy: bestEnergy,
      params: { ...baseParams, [xAxis.key]: gridX[bestIX], [yAxis.key]: gridY[bestIY] } },
    worstPoint: { ix: worstIX, iy: worstIY, energy: worstEnergy,
      params: { ...baseParams, [xAxis.key]: gridX[worstIX], [yAxis.key]: gridY[worstIY] } },
    meta: { w, h, steps, rngBase, total },
  };
}

/**
 * 把 ScanResult 渲染到一个 canvas 上（32~128 像素的 heatmap cell）
 * 返回实际绘制的像素尺寸
 *
 * palette: 'viridis' | 'magma' | 'plasma' | 'coolwarm' | 'inferno'
 */
export function renderHeatmap(canvas, result, metricKey = 'energy', palette = 'viridis') {
  const { Nx, Ny, gridX, gridY } = result;
  const cell = Math.max(6, Math.floor(Math.min(canvas.width / Nx, canvas.height / Ny)));
  canvas.width = Nx * cell;
  canvas.height = Ny * cell;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1a1320';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const palettes = getPalette(palette);

  const raw = result.raw;
  let values;
  if (metricKey === 'energy') values = raw.energy;
  else if (metricKey === 'fractal') values = raw.fractal;
  else if (metricKey === 'lyapunov') values = raw.lyapunov;
  else if (metricKey === 'density') values = raw.density;
  else if (metricKey === 'period')  values = raw.period;
  else values = raw.energy;

  // 归一化到 0~1
  let vmin = Infinity, vmax = -Infinity;
  for (const v of values) if (!isNaN(v)) { if (v < vmin) vmin = v; if (v > vmax) vmax = v; }
  if (!isFinite(vmin)) return { cell, vmin: 0, vmax: 1 };

  for (let iy = 0; iy < Ny; iy++) {
    for (let ix = 0; ix < Nx; ix++) {
      const idx = iy * Nx + ix;
      const v = values[idx];
      let t = isNaN(v) ? 0.5 : (v - vmin) / (vmax - vmin || 1);
      const [r, g, b] = palettes[Math.min(255, Math.floor(t * 255))];
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(ix * cell, iy * cell, cell, cell);
    }
  }

  // 画最佳点和最差点标记
  const bp = result.bestPoint;
  const wp = result.worstPoint;
  ctx.strokeStyle = '#00ffaa'; ctx.lineWidth = 2;
  ctx.strokeRect(bp.ix * cell, bp.iy * cell, cell, cell);
  ctx.strokeStyle = '#ff6688';
  ctx.strokeRect(wp.ix * cell, wp.iy * cell, cell, cell);

  return { cell, vmin, vmax };
}

function getPalette(name) {
  // 简化版 matplotlib colormaps：256 色，固定查表
  const tables = {
    viridis: makeLinearPalette([
      [68, 1, 84], [72, 36, 117], [65, 69, 135], [54, 98, 141],
      [42, 120, 142], [33, 145, 140], [34, 168, 132], [68, 191, 112],
      [122, 209, 81], [189, 223, 38], [252, 244, 14],
    ]),
    magma: makeLinearPalette([
      [0, 0, 4], [31, 12, 72], [85, 15, 109], [136, 34, 106],
      [186, 54, 85], [227, 89, 51], [249, 140, 10], [247, 200, 43],
      [252, 244, 14],
    ]),
    plasma: makeLinearPalette([
      [13, 8, 135], [70, 3, 159], [114, 2, 168], [157, 27, 156],
      [197, 54, 129], [219, 78, 103], [236, 105, 78], [247, 134, 55],
      [253, 165, 36], [255, 198, 25],
    ]),
    coolwarm: makeLinearPalette([
      [59, 76, 192], [96, 121, 223], [141, 162, 237], [179, 194, 239],
      [214, 219, 220], [244, 174, 150], [244, 124, 103], [229, 80, 71],
      [180, 40, 38],
    ]),
    inferno: makeLinearPalette([
      [0, 0, 4], [31, 12, 72], [85, 15, 109], [136, 34, 106],
      [186, 54, 85], [227, 89, 51], [249, 140, 10], [247, 200, 43],
      [252, 244, 14],
    ]),
  };
  return tables[name] || tables.viridis;
}

function makeLinearPalette(stops) {
  const out = new Array(256);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const segIdx = Math.min(stops.length - 2, Math.floor(t * (stops.length - 1)));
    const segT = (t * (stops.length - 1)) - segIdx;
    const a = stops[segIdx], b = stops[segIdx + 1];
    out[i] = [
      Math.round(a[0] + (b[0] - a[0]) * segT),
      Math.round(a[1] + (b[1] - a[1]) * segT),
      Math.round(a[2] + (b[2] - a[2]) * segT),
    ];
  }
  return out;
}
