/* ========================================================================== */
/* Scientific Kernel — Turing 反应-扩散 + 科学指标库                          */
/* ========================================================================== */

import { PHYSICS_DEFAULTS, SCIENCE_THRESHOLDS } from './config.js';

// clamp（自包含，避免跨模块依赖 rng.js 是否 export）
const clampSafe = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

/* 二维五点 Laplacian 显式欧拉的稳定上限：D · dt ≤ 1/4。
 * 超过该值时由 step() 自动分子步，不允许用 clamp 掩盖发散。 */
export const EXPLICIT_EULER_CFL = 0.25;
const MAX_SUBSTEPS = 8;

export const SCIENCE_VERSION = '2.0.0';

/* ============================================================== */
/* 反应-扩散引擎 · Reaction-Diffusion Engine                      */
/*                                                                */
/* 通式（两个耦合场 u, v）：                                       */
/*   ∂u/∂t = D_u · ∇²u + F_u(u, v)                               */
/*   ∂v/∂t = D_v · ∇²v + F_v(u, v)                               */
/*                                                                */
/* 其中 ∇² 是标准五点拉普拉斯算子（torus / wall 边界）：             */
/*   ∇²f(x,y) = f(x-1,y) + f(x+1,y) + f(x,y-1) + f(x,y+1) - 4f     */
/*   常数场 → 0；二次场 x²+y² → 4（离散精确）。                     */
/*                                                                */
/* 离散化（Forward Euler；D·dt > 1/4 时自动分子步，见 step()）：    */
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
  /* ---- Gray-Scott ----
   * D_u = 0.16, D_v = 0.08 是 Gray-Scott 的标准标度（网格间距 1、dt=1）。
   * 旧值 1.0/0.5 在 D·dt ≤ 1/4 的显式欧拉稳定域之外，会被 clamp 压成均匀场。 */
  gs_spots:   { label: '斑点', engine: 'grayScott', D_u: 0.16, D_v: 0.08,
                f: 0.035, k: 0.062, dt: 1.0,
                note: 'Gray-Scott · 经典斑点，像瓢虫身上的花纹' },
  gs_stripes: { label: '条纹', engine: 'grayScott', D_u: 0.16, D_v: 0.08,
                f: 0.014, k: 0.052, dt: 1.0,
                note: 'Gray-Scott · 斑马条纹，最经典的 Turing 模式' },
  gs_maze:    { label: '迷宫', engine: 'grayScott', D_u: 0.16, D_v: 0.08,
                f: 0.026, k: 0.058, dt: 1.0,
                note: 'Gray-Scott · 蜿蜒迷宫，像大脑皮层' },
  gs_hex:     { label: '六边形', engine: 'grayScott', D_u: 0.16, D_v: 0.08,
                f: 0.040, k: 0.062, dt: 1.0,
                note: 'Gray-Scott · 完美六边形蜂窝' },
  gs_wander:  { label: '游走点', engine: 'grayScott', D_u: 0.16, D_v: 0.08,
                f: 0.014, k: 0.050, dt: 1.0,
                note: 'Gray-Scott · 小点点自己会跑' },
  gs_coral:   { label: '珊瑚', engine: 'grayScott', D_u: 0.16, D_v: 0.08,
                f: 0.030, k: 0.058, dt: 1.0,
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
/* 五点拉普拉斯算子（Five-point Laplacian）                        */
/*   lap = f(x-1,y) + f(x+1,y) + f(x,y-1) + f(x,y+1) - 4·f(x,y)   */
/* 常数场结果为 0；这是显式欧拉稳定域 D·dt ≤ 1/4 对应的标准格式。 */
/* 边界条件：torus（环面）或 wall（硬壁）                         */
/* ============================================================== */
export function laplacian(grid, w, h, x, y, boundary) {
  const idx = y * w + x;
  let sum = 0;
  const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (let k = 0; k < 4; k++) {
    let nx = x + dirs[k][0];
    let ny = y + dirs[k][1];
    if (boundary === 'torus') {
      nx = (nx + w) % w;
      ny = (ny + h) % h;
    } else {
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
    }
    sum += grid[ny * w + nx];
  }
  return sum - 4 * grid[idx];
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
    /* 双缓冲：子步积分时避免每步分配新数组 */
    this._uNext = new Float32Array(w * h);
    this._vNext = new Float32Array(w * h);
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

  /* ---- 播种：中间一个圆斑（经典 Gray-Scott 初始条件）----
   * 激发格使用 u=0.5, v=0.25（标准 GS 种子），而不是 v=1。
   * v=1 会瞬间耗尽 u，修正后的五点 Laplacian 下斑图会直接熄灭。 */
  _initField(pattern) {
    const { w, h } = this;
    this.u.fill(1);        // 均匀 u = 1
    this.v.fill(0);        // 均匀 v = 0
    const cx = w / 2, cy = h / 2;
    const excite = (idx) => { this.u[idx] = 0.5; this.v[idx] = 0.25; };
    if (pattern === 'ring') {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const d = Math.hypot(x - cx, y - cy);
          if (d < Math.min(w, h) * 0.15) excite(y * w + x);
        }
      }
    } else if (pattern === 'dot') {
      for (let k = 0; k < 20; k++) {
        const dx = Math.floor(Math.random() * w);
        const dy = Math.floor(Math.random() * h);
        excite(dy * w + dx);
      }
    } else if (pattern === 'soup') {
      for (let i = 0; i < w * h; i++) {
        if (Math.random() < 0.05) excite(i);
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

  /* ---- 一步 Euler 积分（D·dt 超限时自动分子步）---- */
  step() {
    const { w, h } = this;
    const physics = this._physics;
    const diffMult = physics?.diffusionMult ?? PHYSICS_DEFAULTS.multipliers.diffusion;
    // Pet 情绪可乘性微调 dt（B2 反向 Bridge）：happy 节奏快、sick 节奏慢
    const dtMult = (physics?.dtMult ?? PHYSICS_DEFAULTS.multipliers.dt) * (1 + (physics?._petDtBoost ?? 0));
    // 环境衰减 + Pet 情绪额外衰减（B2 反向 Bridge，叠加而非覆盖）
    const globalDecay = (physics?.globalDecay ?? 0) + (physics?._petDecay ?? 0);
    const gDecayU = physics?.globalDecayU ?? PHYSICS_DEFAULTS.multipliers.globalDecayU;
    const gDecayV = physics?.globalDecayV ?? PHYSICS_DEFAULTS.multipliers.globalDecayV;

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

    // Pet 情绪噪声（B2 反向 Bridge）：开心时偶尔注入小扰动制造生机。
    // 每 10 步一次、幅度 = _petNoiseBoost，避免每步注入把 Turing 斑图冲掉。
    const petNoise = physics?._petNoiseBoost ?? 0;
    if (petNoise > 0 && this.t % 10 === 0) {
      for (let i = 0; i < w * h; i++) {
        this.v[i] = clampSafe(this.v[i] + petNoise * (Math.random() - 0.5) * 2, 0, 1);
      }
    }

    const engine = this.params.engine || this.engineType;
    const du = Number.isFinite(this.params.D_u) ? this.params.D_u : (engine === 'fitzHughNagumo' ? 1.0 : 0);
    const dv = Number.isFinite(this.params.D_v) ? this.params.D_v : (engine === 'fitzHughNagumo' ? 1.0 : 0);
    const Dmax = Math.max(du, dv) * diffMult;
    const dtEff = this.dt * dtMult;
    const rawSubsteps = Math.ceil((Dmax * dtEff) / EXPLICIT_EULER_CFL);
    if (rawSubsteps > MAX_SUBSTEPS) {
      throw new Error(
        `反应-扩散显式积分不稳定：D·dt=${(Dmax * dtEff).toFixed(4)} 需要 ${rawSubsteps} 个子步，`
        + `超过上限 ${MAX_SUBSTEPS}。请降低 dt 或扩散系数（不允许用 clamp 掩盖发散）。`
      );
    }
    const substeps = Math.max(1, rawSubsteps);
    const dtSub = dtEff / substeps;
    for (let s = 0; s < substeps; s++) this._substep(dtSub);

    /* 环境/Pet 衰减：每个外层步只作用一次，避免子步放大衰减率 */
    if (globalDecay > 0) {
      for (let i = 0; i < w * h; i++) {
        this.u[i] *= (1 - globalDecay * gDecayU);
        this.v[i] *= (1 - globalDecay * gDecayV);
      }
    }
    this.t += this.dt;
  }

  /* ---- 单个显式子步（dtSub 已含 dtMult）---- */
  _substep(dtSub) {
    const { w, h } = this;
    const physics = this._physics;
    const diffMult = physics?.diffusionMult ?? PHYSICS_DEFAULTS.multipliers.diffusion;
    const boost = physics?.reactionBoost ?? null;
    const { D_u, D_v, engine } = this.params;
    const { boundary, u, v } = this;
    const u_new = this._uNext;
    const v_new = this._vNext;
    const tidal = physics?.tidalField;
    const fU = physics?.diffusionField_u;
    const fV = physics?.diffusionField_v;

    if (engine === 'grayScott') {
      const f = this.params.f * (boost?.fMult ?? 1.0);
      const k = this.params.k * (boost?.kMult ?? 1.0);
      const baseD_u = D_u * diffMult;
      const baseD_v = D_v * diffMult;

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
          u_new[idx] = clampSafe(uu + dtSub * (Du * lapU - uv2 + f * (1 - uu)), 0, 1);
          v_new[idx] = clampSafe(vv + dtSub * (Dv * lapV + uv2 - (f + k) * vv), 0, 1);

          // 黑洞潮汐：tidalField 让 v 场随"离中心距离"衰减
          if (tidal) v_new[idx] *= tidal[idx];
        }
      }
    } else if (engine === 'fitzHughNagumo') {
      const a = this.params.a * (boost?.aMult ?? 1.0);
      const b = this.params.b * (boost?.bMult ?? 1.0);
      const c = this.params.c;
      // FHN 默认 D_u=D_v=1.0，但 physics 可以乘 diffMult + 逐格 field
      const baseD_u = (D_u ?? 1.0) * diffMult;
      const baseD_v = (D_v ?? 1.0) * diffMult;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = y * w + x;
          const lapU = laplacian(u, w, h, x, y, boundary);
          const lapV = laplacian(v, w, h, x, y, boundary);
          const uu = u[idx];
          const vv = v[idx];
          const Du = fU ? baseD_u * fU[idx] : baseD_u;
          const Dv = fV ? baseD_v * fV[idx] : baseD_v;
          u_new[idx] = clampSafe(uu + dtSub * (Du * lapU + c * (uu - uu * uu * uu / 3 + vv)), -2, 2);
          v_new[idx] = clampSafe(vv + dtSub * (Dv * lapV - (uu - a + b * vv) / c), -2, 2);
          if (tidal) v_new[idx] *= tidal[idx];
        }
      }
    } else if (engine === 'brusselator') {
      const A = this.params.A * (boost?.A_Mult ?? 1.0);
      const B = this.params.B * (boost?.B_Mult ?? 1.0);
      const baseD_u = D_u * diffMult;
      const baseD_v = D_v * diffMult;
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
          u_new[idx] = clampSafe(uu + dtSub * (Du * lapU + A + u2v - (B + 1) * uu), 0, 10);
          v_new[idx] = clampSafe(vv + dtSub * (Dv * lapV + B * uu - u2v), 0, 10);
          if (tidal) v_new[idx] *= tidal[idx];
        }
      }
    }

    /* 双缓冲交换 */
    this.u = u_new;
    this.v = v_new;
    this._uNext = u;
    this._vNext = v;
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

/* 把任意场拉伸到 [0,1]（只用于特征提取/显示，不改变动力学）。
 * 已熄灭或完全均匀的场返回零场，避免把 1e-44 的数值噪声放大成假结构。 */
export function normalizeField(field) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < field.length; i++) {
    if (field[i] < min) min = field[i];
    if (field[i] > max) max = field[i];
  }
  const out = new Float32Array(field.length);
  const span = max - min;
  if (!Number.isFinite(span) || span < 1e-9) return out;
  for (let i = 0; i < field.length; i++) out[i] = (field[i] - min) / span;
  return out;
}

/* -------------------------------------------------------------- */
/* 二维自相关相关长度 L_c（第一局部峰）                            */
/* 说明：沿 x / y 两个方向做归一化自相关，跳过零延迟主峰，          */
/* 找到第一个局部极大值；两个方向的估计取平均。                    */
/* 返回单位：格（grid cells）。                                    */
/* -------------------------------------------------------------- */
export function computeSpatialPeriod(v, w, h) {
  const maxSearch = Math.floor(Math.min(w, h) / 2);
  if (maxSearch < 4) return 0;

  const firstPeak = (dx, dy) => {
    const corr = new Float64Array(maxSearch + 1);
    for (let d = 1; d <= maxSearch; d++) {
      let sum = 0;
      let norm = 0;
      for (let y = 0; y < h; y += 2) {
        const yy = (y + d * dy + h) % h;
        for (let x = 0; x < w; x += 2) {
          const xx = (x + d * dx + w) % w;
          sum += v[y * w + x] * v[yy * w + xx];
          norm++;
        }
      }
      corr[d] = norm ? sum / norm : 0;
    }
    /* 跳过零延迟衰减段，找第一个“先降后升”的局部峰 */
    let sawMinimum = false;
    for (let d = 2; d < maxSearch; d++) {
      if (corr[d] < corr[d - 1] && corr[d] <= corr[d + 1]) sawMinimum = true;
      if (sawMinimum && corr[d] > corr[d - 1] && corr[d] >= corr[d + 1] && corr[d] > 0) {
        return d;
      }
    }
    return 0;
  };

  const px = firstPeak(1, 0);
  const py = firstPeak(0, 1);
  if (px && py) return Math.round((px + py) / 2);
  return px || py || 0;
}

/* -------------------------------------------------------------- */
/* 场熵 H_v（归一化 Shannon 熵，单位：bit / bit_max）              */
/* 对场值做 64 桶直方图，H = -Σ p log2 p，再除以 log2(bins)。      */
/* 均匀场 → 0；随机场 → 接近 1。                                   */
/* -------------------------------------------------------------- */
export function computeFieldEntropy(field, bins = 64) {
  if (!field || !field.length) return 0;
  const hist = new Uint32Array(bins);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < field.length; i++) {
    const val = field[i];
    if (val < min) min = val;
    if (val > max) max = val;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return 0;
  const scale = (bins - 1) / (max - min);
  for (let i = 0; i < field.length; i++) {
    const b = Math.min(bins - 1, Math.max(0, Math.floor((field[i] - min) * scale)));
    hist[b]++;
  }
  const total = field.length;
  let H = 0;
  for (let i = 0; i < bins; i++) {
    if (!hist[i]) continue;
    const p = hist[i] / total;
    H -= p * Math.log2(p);
  }
  return Math.max(0, Math.min(1, H / Math.log2(bins)));
}

/* -------------------------------------------------------------- */
/* 科学模式 metrics 汇总（替换拓扑指标）                            */
/* -------------------------------------------------------------- */
export function computeScientificMetrics(v, u, w, h, engineType) {
  // 修正后的求解器里 v 是浓度较低的斑图场，u 是被消耗的底物。
  // 两者都先归一化，保证不同参数标度下的结构指标可比；
  // 阈值 0.5 对应归一化后的“有斑图 / 无斑图”分割。
  const un = normalizeField(u);
  const vn = normalizeField(v);
  const lyapunov = computeLyapunov(u, w, h);
  const fractal = computeFractalDimension(vn, w, h, 0.5);
  const energy = computeFieldEnergy(un, vn, w, h);
  const spatialPeriod = computeSpatialPeriod(vn, w, h);

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
