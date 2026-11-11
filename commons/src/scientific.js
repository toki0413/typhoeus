/* ========================================================================== */
/* Scientific Kernel — Turing 反应-扩散 + 科学指标库                          */
/* ========================================================================== */

import { PHYSICS_DEFAULTS, SCIENCE_THRESHOLDS } from './config.js';

// clamp（自包含，避免跨模块依赖 rng.js 是否 export）
const clampSafe = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

export const SCIENCE_VERSION = '2.0.0';

/* ============================================================== */
/* 反应-扩散引擎 · Reaction-Diffusion Engine                      */
/*                                                                */
/* 通式（两个耦合场 u, v）：                                       */
/*   ∂u/∂t = D_u · ∇²u + F_u(u, v)                               */
/*   ∂v/∂t = D_v · ∇²v + F_v(u, v)                               */
/*                                                                */
/* 其中 ∇² 是九邻域拉普拉斯算子：                                  */
/*   ∇²f(x,y) = (1/6) * [                                         */
/*     -1·f(x,y) + 0.25·Σ_neighbors                               */
/*   ]                                                            */
/*                                                                */
/* 离散化（Forward Euler，dt 必须足够小以保证数值稳定）：          */
/*   u_new = u + dt · (D_u * lapU + F_u(u, v))                    */
/*   v_new = v + dt · (D_v * lapV + F_v(u, v))                    */
/* ============================================================== */

/* -------------------------------------------------------------- */
/* 1. Gray-Scott 模型（经典反应-扩散）                              */
/*    ∂u/∂t = D_u ∇²u - u·v² + f·(1 - u)                           */
/*    ∂v/∂t = D_v ∇²v + u·v² - (f + k)·v                           */
/*                                                                */
/*    D_u, D_v: 扩散系数（单位：格²/步，越大扩散越快）              */
/*    f: 饲养速率 feed rate（0.01~0.1，控制物种 u 的生成速度）     */
/*    k: 杀伤速率 kill rate（0.03~0.07，控制物种 v 的消亡速度）    */
/*                                                                */
/*    f=0.035, k=0.065 → 斑点  spots                              */
/*    f=0.012, k=0.050 → 条纹  stripes                            */
/*    f=0.022, k=0.051 → 迷宫  maze                               */
/*    f=0.040, k=0.060 → 六边形  hexagons                         */
/*    f=0.010, k=0.047 → 游走点  wandering dots                    */
/* -------------------------------------------------------------- */

/* -------------------------------------------------------------- */
/* 2. FitzHugh-Nagumo 模型（可兴奋介质）                            */
/*    ∂u/∂t = ∇²u + c·(u - u³/3 + v)                              */
/*    ∂v/∂t = ∇²v - (u - a + b·v) / c                              */
/*                                                                */
/*    神经冲动、心脏电活动、神经元集体放电的数学基础。               */
/*    u: 激活变量（膜电位/激活动度）                               */
/*    v: 抑制变量（恢复）                                         */
/*    c: 耦合强度（决定传播速度）                                  */
/*    a, b: 控制阈值和恢复速率                                     */
/* -------------------------------------------------------------- */

/* -------------------------------------------------------------- */
/* 3. Brusselator 模型（化学振荡）                                  */
/*    ∂u/∂t = D_u ∇²u + A + u²·v - (B + 1)·u                      */
/*    ∂v/∂t = D_v ∇²v + B·u - u²·v                                */
/*                                                                */
/*    A, B: 反应物浓度参数                                         */
/*    B > 1 + A² → Turing 不稳定，出现化学振荡                       */
/*    别洛索夫-扎博京斯基反应的简化模型。                            */
/* -------------------------------------------------------------- */

export const REACTION_DIFFUSION_PRESETS = {
  /* ---- Gray-Scott ---- */
  gs_spots:   { label: '斑点', engine: 'grayScott', D_u: 1.0, D_v: 0.5,
                f: 0.035, k: 0.065, dt: 1.0,
                note: 'Gray-Scott · 经典斑点，像瓢虫身上的花纹' },
  gs_stripes: { label: '条纹', engine: 'grayScott', D_u: 1.0, D_v: 0.5,
                f: 0.012, k: 0.050, dt: 1.0,
                note: 'Gray-Scott · 斑马条纹，最经典的 Turing 模式' },
  gs_maze:    { label: '迷宫', engine: 'grayScott', D_u: 1.0, D_v: 0.5,
                f: 0.022, k: 0.051, dt: 1.0,
                note: 'Gray-Scott · 蜿蜒迷宫，像大脑皮层' },
  gs_hex:     { label: '六边形', engine: 'grayScott', D_u: 1.0, D_v: 0.5,
                f: 0.040, k: 0.060, dt: 1.0,
                note: 'Gray-Scott · 完美六边形蜂窝' },
  gs_wander:  { label: '游走点', engine: 'grayScott', D_u: 1.0, D_v: 0.5,
                f: 0.010, k: 0.047, dt: 1.0,
                note: 'Gray-Scott · 小点点自己会跑' },
  gs_coral:   { label: '珊瑚', engine: 'grayScott', D_u: 1.0, D_v: 0.5,
                f: 0.030, k: 0.062, dt: 1.0,
                note: 'Gray-Scott · 珊瑚状分枝' },

  /* ---- FitzHugh-Nagumo ---- */
  fhn_pulse:  { label: '神经脉冲', engine: 'fitzHughNagumo', D_u: 1.0, D_v: 1.0,
                a: 0.7, b: 0.8, c: 10.0, dt: 0.5,
                note: 'FitzHugh-Nagumo · 自发脉冲，像神经放电' },
  fhn_spiral: { label: '心脏螺旋', engine: 'fitzHughNagumo', D_u: 1.0, D_v: 1.0,
                a: 0.7, b: 0.8, c: 15.0, dt: 0.5,
                note: 'FitzHugh-Nagumo · 螺旋波，心脏纤颤的数学模拟' },
  fhn_target: { label: '靶波', engine: 'fitzHughNagumo', D_u: 1.0, D_v: 1.0,
                a: 0.7, b: 0.8, c: 8.0,  dt: 0.5,
                note: 'FitzHugh-Nagumo · 同心圆向外传播' },

  /* ---- Brusselator ---- */
  brs_osc:    { label: '化学振荡', engine: 'brusselator', D_u: 1.0, D_v: 0.2,
                A: 2.0, B: 4.5, dt: 0.1,
                note: 'Brusselator · 图灵不稳定出现化学波' },
  brs_labyrinth: { label: '化学迷宫', engine: 'brusselator', D_u: 1.0, D_v: 0.1,
                A: 1.5, B: 3.0, dt: 0.1,
                note: 'Brusselator · 复杂的化学迷宫' },
};

/* ============================================================== */
/* 九邻域拉普拉斯算子（Nine-point Laplacian）                      */
/* 在 (i,j) 处的离散拉普拉斯：                                     */
/*   lap[i,j] = (1/6) * (-center + 0.25*4邻域 + 0.125*4对角)      */
/* 边界条件：torus（环面）或 wall（硬壁）                         */
/* ============================================================== */
function laplacian(grid, w, h, x, y, boundary) {
  let sum = 0;
  let center = grid[y * w + x];
  const dirs = [
    [-1, -1], [0, -1], [1, -1],
    [-1,  0],          [1,  0],
    [-1,  1], [0,  1], [1,  1],
  ];
  const weights = [0.125, 0.25, 0.125, 0.25, 0.25, 0.125, 0.25, 0.125];
  for (let k = 0; k < 8; k++) {
    let nx = x + dirs[k][0];
    let ny = y + dirs[k][1];
    if (boundary === 'torus') {
      nx = (nx + w) % w;
      ny = (ny + h) % h;
    } else {
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
    }
    sum += grid[ny * w + nx] * weights[k];
  }
  return (sum - center);
}

/* ============================================================== */
/* ReactionDiffusionEngine                                        */
/* ============================================================== */
export class ReactionDiffusionEngine {
  constructor(w, h, opts = {}) {
    this.w = w;
    this.h = h;
    this.kind = 'reaction-diffusion';
    // 先取 preset defaults，再用用户传的 opts 覆盖（包括 engine 类型！）
    this.preset = opts.preset || opts.engine || 'gs_spots';
    const defaults = REACTION_DIFFUSION_PRESETS[this.preset] || {};
    this.params = { ...defaults, ...opts };  // 用户参数优先
    this.engineType = this.params.engine || this.preset;
    this.boundary = opts.boundary || 'torus';
    this.dt = this.params.dt || 1.0;
    this.u = new Float32Array(w * h);
    this.v = new Float32Array(w * h);
    this.t = 0;
    this._initField(opts.pattern || 'ring');
  }

  setPreset(key) {
    const p = REACTION_DIFFUSION_PRESETS[key];
    if (!p) return;
    this.preset = key;
    this.params = { ...p };
    this.dt = p.dt;
  }

  /* ---- 播种：中间一个圆环（经典 Gray-Scott 初始条件）---- */
  _initField(pattern) {
    const { w, h } = this;
    this.u.fill(1);        // 均匀 u = 1
    this.v.fill(0);        // 均匀 v = 0
    const cx = w / 2, cy = h / 2;
    if (pattern === 'ring') {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const d = Math.hypot(x - cx, y - cy);
          if (d < Math.min(w, h) * 0.15) this.v[y * w + x] = 1;  // 中间一个 v 圆斑
        }
      }
    } else if (pattern === 'dot') {
      for (let k = 0; k < 20; k++) {
        const dx = Math.floor(Math.random() * w);
        const dy = Math.floor(Math.random() * h);
        this.v[dy * w + dx] = 1;
      }
    } else if (pattern === 'soup') {
      for (let i = 0; i < w * h; i++) {
        if (Math.random() < 0.05) this.v[i] = 1;
      }
    }
  }

  reset(pattern) {
    this.t = 0;
    this._initField(pattern || 'ring');
  }

  /** 注入极端环境物理参数（physics.js 调用）*/
  setPhysics(physicsObj) {
    this._physics = physicsObj;
  }
  clearPhysics() { this._physics = null; }

  /* ---- 一步 Euler 积分 ---- */
  step() {
    const { w, h } = this;
    const physics = this._physics;
    const diffMult = physics?.diffusionMult ?? PHYSICS_DEFAULTS.multipliers.diffusion;
    const dtMult = physics?.dtMult ?? PHYSICS_DEFAULTS.multipliers.dt;
    const globalDecay = physics?.globalDecay ?? 0;
    const gDecayU = physics?.globalDecayU ?? PHYSICS_DEFAULTS.multipliers.globalDecayU;
    const gDecayV = physics?.globalDecayV ?? PHYSICS_DEFAULTS.multipliers.globalDecayV;
    const boost = physics?.reactionBoost ?? null;
    const fMult = boost?.fMult ?? 1.0;
    const kMult = boost?.kMult ?? 1.0;
    const aMult = boost?.aMult ?? 1.0;
    const bMult = boost?.bMult ?? 1.0;
    const A_Mult = boost?.A_Mult ?? 1.0;
    const B_Mult = boost?.B_Mult ?? 1.0;

    // 土星环碎片：每 perturbation.rate 步注入扰动
    if (physics?.perturbation && this.t % physics.perturbation.rate === 0) {
      const { intensity = 0.4 } = physics.perturbation;
      const fld = physics.noiseField;
      if (fld) {
        for (let i = 0; i < w * h; i++) {
          this.v[i] = clampSafe(this.v[i] + intensity * (Math.random() - 0.5) * 2 * fld[i], 0, 1);
        }
      } else {
        for (let i = 0; i < w * h; i++) {
          this.v[i] = clampSafe(this.v[i] + intensity * (Math.random() - 0.5) * 2, 0, 1);
        }
      }
    }

    const { D_u, D_v, engine } = this.params;
    const { boundary, dt, u, v } = this;
    const u_new = new Float32Array(w * h);
    const v_new = new Float32Array(w * h);

    if (engine === 'grayScott') {
      const f = this.params.f * fMult;
      const k = this.params.k * kMult;
      const baseD_u = D_u * diffMult;
      const baseD_v = D_v * diffMult;
      const fU = physics?.diffusionField_u, fV = physics?.diffusionField_v;

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = y * w + x;
          const lapU = laplacian(u, w, h, x, y, boundary);
          const lapV = laplacian(v, w, h, x, y, boundary);
          const uu = u[idx];
          const vv = v[idx];
          const uv2 = uu * vv * vv;
          // 逐格扩散系数（木卫二热梯度用）：标量 × field[idx]
          const Du = fU ? baseD_u * fU[idx] : baseD_u;
          const Dv = fV ? baseD_v * fV[idx] : baseD_v;
          u_new[idx] = clampSafe(uu + dt * dtMult * (Du * lapU - uv2 + f * (1 - uu)), 0, 1);
          v_new[idx] = clampSafe(vv + dt * dtMult * (Dv * lapV + uv2 - (f + k) * vv), 0, 1);

          // 黑洞潮汐：tidalField 让 v 场随"离中心距离"衰减
          if (physics?.tidalField) {
            v_new[idx] *= physics.tidalField[idx];
          }
          if (globalDecay > 0) {
            u_new[idx] *= (1 - globalDecay * gDecayU);
            v_new[idx] *= (1 - globalDecay * gDecayV);
          }
        }
      }
    } else if (engine === 'fitzHughNagumo') {
      const a = this.params.a * aMult;
      const b = this.params.b * bMult;
      const c = this.params.c;
      // FHN 默认 D_u=D_v=1.0，但 physics 可以乘 diffMult + 逐格 field
      const baseD_u = (this.params.D_u ?? 1.0) * diffMult;
      const baseD_v = (this.params.D_v ?? 1.0) * diffMult;
      const fU = physics?.diffusionField_u, fV = physics?.diffusionField_v;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = y * w + x;
          const lapU = laplacian(u, w, h, x, y, boundary);
          const lapV = laplacian(v, w, h, x, y, boundary);
          const uu = u[idx];
          const vv = v[idx];
          const Du = fU ? baseD_u * fU[idx] : baseD_u;
          const Dv = fV ? baseD_v * fV[idx] : baseD_v;
          u_new[idx] = clampSafe(uu + dt * dtMult * (Du * lapU + c * (uu - uu * uu * uu / 3 + vv)), -2, 2);
          v_new[idx] = clampSafe(vv + dt * dtMult * (Dv * lapV - (uu - a + b * vv) / c), -2, 2);
          if (physics?.tidalField) v_new[idx] *= physics.tidalField[idx];
          if (globalDecay > 0) {
            u_new[idx] *= (1 - globalDecay * gDecayU);
            v_new[idx] *= (1 - globalDecay * gDecayV);
          }
        }
      }
    } else if (engine === 'brusselator') {
      const A = this.params.A * (boost?.A_Mult ?? 1.0);
      const B = this.params.B * (boost?.B_Mult ?? 1.0);
      const baseD_u = this.params.D_u * diffMult;
      const baseD_v = this.params.D_v * diffMult;
      const fU = physics?.diffusionField_u, fV = physics?.diffusionField_v;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = y * w + x;
          const lapU = laplacian(u, w, h, x, y, boundary);
          const lapV = laplacian(v, w, h, x, y, boundary);
          const uu = u[idx];
          const vv = v[idx];
          const u2v = uu * uu * vv;
          const Du = fU ? baseD_u * fU[idx] : baseD_u;
          const Dv = fV ? baseD_v * fV[idx] : baseD_v;
          u_new[idx] = clampSafe(uu + dt * dtMult * (Du * lapU + A + u2v - (B + 1) * uu), 0, 10);
          v_new[idx] = clampSafe(vv + dt * dtMult * (Dv * lapV + B * uu - u2v), 0, 10);
          if (physics?.tidalField) v_new[idx] *= physics.tidalField[idx];
          if (globalDecay > 0) {
            u_new[idx] *= (1 - globalDecay * gDecayU);
            v_new[idx] *= (1 - globalDecay * gDecayV);
          }
        }
      }
    }

    this.u = u_new;
    this.v = v_new;
    this.t += dt;
  }

  /* ---- 快照：把 v 场映射为 0-255 Uint8Array ---- */
  snapshot() {
    const n = this.w * this.h;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = clampSafe(Math.floor(this.v[i] * 255), 0, 255);
    }
    return out;
  }

  /* ---- 拓扑指标（来自 v 场） ---- */
  get vField() { return this.v; }
  get uField() { return this.u; }
  get totalTime() { return this.t; }
}

/* ============================================================== */
/* 科学指标库（真正的，不是拓扑指标）                               */
/* ============================================================== */

/* -------------------------------------------------------------- */
/* Lyapunov 指数 λ                                                */
/* 衡量系统对初始条件的敏感程度：                                  */
/*   λ > 0 → 混沌（蝴蝶效应）                                     */
/*   λ = 0 → 周期性                                               */
/*   λ < 0 → 稳定吸引子（不动点）                                 */
/*                                                                */
/* 简化算法：对网格上的每个点，计算其拉普拉斯响应的对数平均         */
/* （完整算法需要时间序列差分，这里给的是空间谱估计）               */
/* -------------------------------------------------------------- */
export function computeLyapunov(v, w, h) {
  /*
   * 空间谱版 Lyapunov 估计（不是时间差分完整算法）。
   * 核心思路：拉普拉斯响应的相对变化率 → 反映"边界张力"。
   *   λ ≈ 1/N · Σ log₁₀(|∇²v| / |v| + ε)
   *
   * 解释（直观对应）：
   *   λ > 0.05  → 混沌吸引子（边界快速移动、结构不断重组）
   *   |λ| < 0.02 → 周期吸引子（边界稳定但整体在运动）
   *   λ < -0.05 → 稳定吸引子（边界几乎不动）
   */
  let sum = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      const center = Math.abs(v[idx]);
      // 跳过几乎为零的点（对数会爆）
      if (center < 0.015) continue;
      const neighbors = (v[idx - 1] + v[idx + 1] + v[idx - w] + v[idx + w]) / 4;
      const lap = Math.abs(neighbors - v[idx]);
      // ratio ≈ |∇²v|/|v| 的相对变化率
      const ratio = lap / Math.max(center, 0.015);
      // log10(ratio + 1) 范围安全：ratio=0 → 0；ratio=10 → 1.04
      sum += Math.log10(ratio + 0.001);
      n++;
    }
  }
  if (!n) return 0;
  return sum / n;
}

/* -------------------------------------------------------------- */
/* Box-counting 分形维数 D                                        */
/* 量化自相似复杂度。                                             */
/* D = lim_{ε→0} log(N(ε)) / log(1/ε)                            */
/* 对边长 ε 的格子数 N(ε) 拟合直线斜率就是 D。                   */
/* D ≈ 1.2~1.5 → 真正的生物模式（血管、肺、珊瑚）                */
/* D ≈ 2.0 → 填满整张画布                                        */
/* -------------------------------------------------------------- */
export function computeFractalDimension(v, w, h, threshold = 0.5) {
  const sizes = [32, 16, 8, 4, 2];  // 网格边长
  const logs = [];
  for (const s of sizes) {
    let count = 0;
    for (let y = 0; y < h; y += s) {
      for (let x = 0; x < w; x += s) {
        let hit = false;
        for (let dy = 0; dy < s && !hit; dy++) {
          for (let dx = 0; dx < s && !hit; dx++) {
            const idx = (y + dy) * w + (x + dx);
            if (idx < v.length && v[idx] > threshold) hit = true;
          }
        }
        if (hit) count++;
      }
    }
    if (count > 0) logs.push([Math.log(1 / s), Math.log(count)]);
  }
  if (logs.length < 2) return 1.0;
  // 线性回归斜率
  const n = logs.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const [lx, ly] of logs) {
    sx += lx; sy += ly; sxx += lx * lx; sxy += lx * ly;
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-10) return 1.0;
  const slope = (n * sxy - sx * sy) / denom;
  return clampSafe(slope, 0.5, 2.0);
}

/* -------------------------------------------------------------- */
/* 场自由能 F                                                     */
/* 真实的能量计算（反应-扩散体系的 Landau 自由能密度）：           */
/*   F = (1/2)·|∇u|² + (1/2)·|∇v|² - 势函数积分                   */
/*                                                                */
/* 我们近似：能量 = 梯度平方的空间平均 + 非线性项                  */
/* 数值越小 → 系统越"松弛"、越接近吸引子                          */
/* -------------------------------------------------------------- */
export function computeFieldEnergy(u, v, w, h) {
  let gradSum = 0;
  let nonlinSum = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      const gx_u = (u[idx + 1] - u[idx - 1]) / 2;
      const gy_u = (u[idx + w] - u[idx - w]) / 2;
      const gx_v = (v[idx + 1] - v[idx - 1]) / 2;
      const gy_v = (v[idx + w] - v[idx - w]) / 2;
      gradSum += gx_u * gx_u + gy_u * gy_u + gx_v * gx_v + gy_v * gy_v;
      const uu = u[idx], vv = v[idx];
      nonlinSum += uu * vv * vv;  // Gray-Scott 型非线性项
      n++;
    }
  }
  if (!n) return { gradEnergy: 0, interactionEnergy: 0, total: 0 };
  return {
    gradEnergy: gradSum / n,
    interactionEnergy: nonlinSum / n,
    total: (gradSum + nonlinSum) / n,
  };
}

/* -------------------------------------------------------------- */
/* 自相关周期（autocorrelation）                                  */
/* 空间周期性估计：对 v 场做 2D 自相关，找第一个峰值对应的位移。   */
/* 返回估计的"典型结构周期"（单位：格）。                          */
/* -------------------------------------------------------------- */
export function computeSpatialPeriod(v, w, h) {
  const thresh = 0.01;
  let maxOffset = 1;
  let maxCorr = 0;
  const maxSearch = Math.min(w, h) / 4;
  for (let d = 2; d < maxSearch; d++) {
    let corr = 0;
    let norm = 0;
    for (let y = 0; y < h - d; y++) {
      for (let x = 0; x < w - d; x++) {
        corr += v[y * w + x] * v[y * w + x + d];
        norm += 1;
      }
    }
    corr /= norm || 1;
    if (corr > maxCorr) { maxCorr = corr; maxOffset = d; }
  }
  return maxOffset;
}

/* -------------------------------------------------------------- */
/* 科学模式 metrics 汇总（替换拓扑指标）                            */
/* -------------------------------------------------------------- */
export function computeScientificMetrics(v, u, w, h, engineType) {
  // uField 才有真实 pattern（vField 在 Gray-Scott 等引擎里会饱和到 1.0）
  // 所以用 uField 算 Lyapunov、分形维数、空间周期
  const lyapunov = computeLyapunov(u, w, h);
  const fractal = computeFractalDimension(u, w, h, 0.3);
  const energy = computeFieldEnergy(u, v, w, h);
  const spatialPeriod = computeSpatialPeriod(u, w, h);

  // 从 Lyapunov 指数判定吸引子类型（比拓扑指标科学）
  const LT = SCIENCE_THRESHOLDS.lyapunov;
  let attrType;
  if (lyapunov > LT.chaotic) attrType = 'chaotic';
  else if (lyapunov > LT.periodic) attrType = 'periodic';
  else if (lyapunov > LT.stable) attrType = 'stable';
  else attrType = 'stable';

  // 分形维数判定"复杂度"
  const FT = SCIENCE_THRESHOLDS.fractal;
  let complexity;
  if (fractal > FT.veryHigh) complexity = '高度复杂';
  else if (fractal > FT.medium) complexity = '中等复杂';
  else if (fractal > FT.low) complexity = '低复杂度';
  else complexity = '简单';

  return {
    engine: engineType,
    lyapunov,               // Lyapunov 指数：量化混沌
    fractal,                // 分形维数：量化复杂度
    energy,                 // 自由能密度
    spatialPeriod,          // 空间周期（格）
    attrType,               // 吸引子类型
    complexity,             // 复杂度描述
    typeLabel: {
      chaotic: '混沌吸引子',
      periodic: '周期吸引子',
      stable: '稳定吸引子',
    }[attrType] || '未知',
  };
}

/* ============================================================== */
/* 细胞 Potts 模型 CPM（骨架注释，暂不完整实现）                    */
/* -------------------------------------------------------------- */
/* 真正的多细胞生长模拟引擎（Glazier & Graner 1992）。             */
/*                                                                 */
/* 能量函数（与 Rosetta 原理相同：最小化自由能）：                  */
/*   H = Σ_{adjacent cells (σ,σ')} J(σ,σ'; type,type')            */
/*       + λ_area · Σ_cells (area_c - area₀)²                      */
/*       + λ_perim · Σ_cells (perim_c - perim₀)²                   */
/*                                                                 */
/*   J: 细胞间黏附能矩阵（越小越黏）                               */
/*   area₀: 每个细胞的目标面积                                     */
/*   λ: 软约束系数                                                 */
/*                                                                 */
/* 算法：                                                          */
/*   1. 随机选取一个边界格点                                        */
/*   2. 尝试把它变成邻居的类型（一次 Monte Carlo 步）               */
/*   3. 计算 ΔH = H_new - H_old                                    */
/*   4. ΔH ≤ 0 → 接受；ΔH > 0 → 以概率 exp(-ΔH/kT) 接受          */
/*                                                                 */
/* 玩家角色：调节黏附能矩阵 J → 观察集体形态变化                   */
/* 这和 Foldit 的"玩家操作 Rosetta 评分函数"完全对等。              */
/*                                                                 */
/* 本模块：骨架 + 参数表。完整实现需要 ~3000 行。                   */
/* ============================================================== */
export const CPM_PARAMS = {
  /* 细胞类型默认黏附能矩阵（Glazier 1992 经典值） */
  adhesionMatrix: {
    // [自我黏附, 与 type A, 与 type B, 与培养基]
    default: [
      [1.0, 0.5, 0.5, 0.1],   // type A 与自身/其他/培养基
      [0.5, 1.0, 0.3, 0.1],   // type B（更黏）
      [0.1, 0.1, 0.1, 0.0],   // 培养基（无黏附）
    ],
  },
  temperature: 0.05,     // kT，越大越随机；越小越刚性
  targetArea: 25,        // 每个细胞目标面积（格）
  targetPerimeter: 16,   // 每个细胞目标周长
  lambdaArea: 0.5,       // 面积约束强度
  lambdaPerim: 0.2,      // 周长约束强度
};
