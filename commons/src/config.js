/* ==========================================================================
 * Commons · 统一配置常量（单一事实源）
 *
 * 把所有 magic numbers 集中到这里。理由（Attention 视角的"宣言式简化"）：
 *   —— "你只需要这个文件来调整整个系统的物理/声音/宠物参数"
 *   —— 不允许在 src/*.js 里裸写 0.55 / 160 / 0.26 这类数字
 *   —— 如果一个数值需要改，你不需要 grep 全项目
 *
 * 结构（按层次从下到上）：
 *   ENGINE_GRID        — 画布分辨率（影响逐格计算量 → 硬件协同约束）
 *   PHYSICS_DEFAULTS   — Reaction-Diffusion 物理默认值（D_u/D_v/dt）
 *   EXTREME_PHYSICS    — 6 个极端环境的物理重参数化表（physics.js 读这个）
 *   EXTREME_AUDIO_TEMPO — 极端环境对 audio 心跳的自然影响（physics.js 读这个）
 *   SCIENCE_THRESHOLDS — Lyapunov/fractal 判定阈值（scientific.js 读这个）
 *   PET_CONSTANTS      — QQ 宠物状态机参数（pet.js 读这个）
 *   AUDIO_CONSTANTS    — Web Audio 默认值（audio.js 读这个）
 *   ENV_DEFAULTS       — defaultEnv() 的默认值（engines.js 读这个）
 * ========================================================================== */

/* ---- 画布尺寸（160×90 = 14400 格，在现代浏览器 30fps 无压力）---- */
export const ENGINE_GRID = {
  W: 160,
  H: 90,
};

/* ---- Reaction-Diffusion 物理默认乘子 ----
 * 引擎本身的 D_u/D_v/f/k/A/B/dt 默认值只在 REACTION_DIFFUSION_PRESETS
 * （scientific.js）里维护一份；这里只放“非极端环境”的乘子，
 * 避免同一组物理参数在两个地方各存一份、改一处忘一处。 */
export const PHYSICS_DEFAULTS = {
  multipliers: {
    diffusion: 1.0,
    dt: 1.0,
    globalDecayU: 1.0,    /* globalDecay 乘在 u_new 上的系数 */
    globalDecayV: 0.5,    /* v_new 只衰减 u 的 50%（物理直觉：v 是产物、u 是反应物）*/
  },
};

/* ================================================================
 * 🌌 6 个极端环境的物理重参数化表
 *
 * 每个 entry 是 physics.transform(env, engineType, w, h) 的返回值模板。
 * engineType 匹配 'grayScott' | 'fitzHughNagumo' | 'brusselator'，
 * 非科学引擎（life/lenia）收到 reactionBoost=null 且只改 env slider。
 * ================================================================ */
export const EXTREME_PHYSICS = {
  exoPrimitive: {
    label: '原始地球',
    diffusionMult: 1.0,
    dtMult: 1.1,
    reactionBoost: { fMult: 1.25, kMult: 1.0, aMult: 1.0, bMult: 1.0, A_Mult: 1.0, B_Mult: 1.0 },
    globalDecay: 0,
  },
  exoVenus: {
    label: '金星高压',
    diffusionMult: 0.5,
    dtMult: 0.95,
    reactionBoost: { fMult: 1.3, kMult: 0.85, aMult: 0.85, bMult: 1.0, A_Mult: 1.2, B_Mult: 1.15 },
    globalDecay: 0.002,
  },
  exoEuropa: {
    label: '木卫二冰下',
    diffusionMult: 1.0,
    dtMult: 1.0,
    reactionBoost: null,   // 热梯度由 diffusionField_u/v 生成，不需要 reaction 乘子
    globalDecay: 0,
    /* 热梯度范围（±10% 差异，物理稳定但有差异化）*/
    thermalGradient: { top: 1.1, bottom: 0.9, topV: 1.05, bottomV: 0.95 },
  },
  exoMars: {
    label: '火星殖民',
    diffusionMult: 1.5,
    dtMult: 1.2,
    reactionBoost: null,
    globalDecay: 0,
  },
  exoSaturn: {
    label: '土星环碎片场',
    diffusionMult: 1.1,
    dtMult: 1.3,
    reactionBoost: null,
    globalDecay: 0,
    /* 碎片撞击扰动（温和版本，每 3 步注入 0.05，有差异化但不炸）*/
    perturbation: { rate: 3, intensity: 0.05, shape: 'perlin' },
  },
  exoBlackhole: {
    label: '黑洞潮汐',
    diffusionMult: 0.8,
    dtMult: 0.4,
    reactionBoost: null,
    globalDecay: 0.0005,
    /* 潮汐衰减：离中心越远衰减越多，最远衰减到 0.95（温和版，让系统保持活性）*/
    tidalDecay: { min: 0.95, power: 2 },
  },
};

/* ---- 极端环境对 audio 心跳的自然影响（乘子）----
 * 模拟不同星球"心跳节奏"的物理直觉：
 *  黑洞 → 几乎停跳 ×0.35
 *  金星高压 → 心跳极慢 ×0.55
 *  火星低重力 → 心跳稍快 ×1.30
 *  土星碎片 → 最快 ×1.40（chaos）
 *
 * 注意：key 用 kebab-case，和 EXTREME_PHYSICS 以及 app.js 的 state.exoticEnvId 一致。
 * ===== */
export const EXTREME_AUDIO_TEMPO = {
  'exo-primitive': 1.15,
  'exo-venus':     0.55,
  'exo-europa':    1.25,
  'exo-mars':      1.30,
  'exo-saturn':    1.40,
  'exo-blackhole': 0.35,
};

/* ---- 科学指标判定阈值 ---- */
export const SCIENCE_THRESHOLDS = {
  /* Lyapunov → attractor 类型 */
  lyapunov: {
    chaotic:  0.15,   /* λ > 0.15 → 混沌吸引子 */
    periodic: 0.02,   /* λ > 0.02 → 周期吸引子 */
    stable:  -0.01,   /* λ 在此之下 → 稳定吸引子 */
  },
  /* fractal → 复杂度描述 */
  fractal: {
    veryHigh: 1.6,
    medium:   1.3,
    low:      1.1,
  },
  /* Hall-Petch 最优分形维数（Pet balance 在此值最高）*/
  hallPetchOptimalD: 1.5,
};

/* ---- QQ 宠物养成层参数 ---- */
export const PET_CONSTANTS = {
  /* 4 状态衰减速度（每仿真步）*/
  decayRate: {
    base: 0.0006,
    energy: 1.5,   /* 饱食衰减最快 */
    balance: 1.2,
    uniform: 0.9,
    activity: 0.7,
  },
  /* 状态偏低阈值触发 mood 下降 */
  lowThreshold: 0.35,
  /* 边际递减 —— 状态好时奖励少，状态差时奖励多 */
  marginal: {
    critical: { value: 0.3, multiplier: 2.0 },
    happy:    { value: 0.7, multiplier: 0.4 },
    default:  1.0,
  },
  /* 玩家互动的 baseBonus */
  interactBonus: 0.25,
};

/* ---- Web Audio 默认参数 ---- */
export const AUDIO_CONSTANTS = {
  heartbeat: {
    defaultBPM: 72,
    smoothRatioNew: 0.4,   /* heartbeatBPM 新值的权重 */
    smoothRatioOld: 0.6,   /* 旧值的权重 */
    /* LFO 呼吸 = heartbeat / 4（让呼吸和心跳同频）*/
    lfoDivisor: 4,
  },
  delay: {
    defaultTime: 0.34,
    feedback: 0.30,
    wet: 0.30,
    filterCutoff: 2600,
  },
  drone: {
    defaultGain: 0.0001,
    filterCutoff: 900,
  },
  reverbAndTension: {
    /* setAudioChain 从 finalReverb 映射到 delayWet 的范围 */
    wetRange: { min: 0.08, max: 0.55 },
    fbRange:  { min: 0.14, max: 0.40 },
    /* finalTension 加到 chaosTemperature 的系数（最高不超过 1.0）*/
    tensionChaosCoef: 0.3,
  },
  strictness: {
    /* chaosTemperature → strictness: clamp(1 - temp*0.55, 0.2, 1.0) */
    chaosCoef: 0.55,
    min: 0.2,
    max: 1.0,
  },
};

/* ---- 玩家可选乐器默认编制（false = 关闭该声部） ---- */
export const DEFAULT_INSTRUMENTS = {
  heart: true, drone: true, pad: true, strings: true, choir: true,
  arp: true, flute: true, marimba: true, bell: true, shimmer: true,
};

/* ---- defaultEnv() 默认值 ---- */
export const ENV_DEFAULTS = {
  pattern: 'soup',
  boundary: 'torus',
  noise: 0,
  constraint: 0.35,
  timeScale: 1,
  resource: { rate: 0, period: 90 },
  /* 噪声效率 = noise * (1 - constraintKillCoef * constraint)
     constraint=1.0 时噪声被 kill 到 (1 - 0.85) * noise = 15% */
  constraintKillCoef: 0.85,
};

/* ---- 便利导出：把所有极端环境 id 当 enum 用 ---- */
export const EXTREME_ENV_IDS = Object.keys(EXTREME_PHYSICS);
