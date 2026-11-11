/* ================================================================
 * Commons · 极端环境物理层（physics.js）
 *
 * 所有极端环境预设不是改 slider 数值，而是**真实改变反应-扩散系统的
 * 物理参数**。把这层从 app.js → engines.js 完全解耦出来：
 *
 *   EXOTIC_ENVIRONMENTS[id]
 *     ↓ 物理变换（physics.js，读 config.js 里的 EXTREME_PHYSICS 表）
 *   { D_u, D_v, f, k, dt, noiseField, constraintField, perturbation }
 *     ↓ 注入 ScientificEngine.step()
 *   真实演化
 *
 * 物理基础（config.js 有注释）：
 *   金星 → D×0.5，globalDecay=0.002
 *   木卫二 → 热梯度 D_u 1.2→0.8
 *   火星 → D×1.5, dt×1.2
 *   土星环 → 每 3 步扰动 0.45
 *   黑洞 → dt×0.4 + 潮汐场衰减 0.6
 * ================================================================ */

import { petMoodToAudio } from './pet.js';
import { EXTREME_PHYSICS as CONFIG_EXTREME, EXTREME_AUDIO_TEMPO, ENV_DEFAULTS } from './config.js';

/* ---- 对外导出音频 tempo modifier ---- */
export const _EXOTIC_AUDIO_TEMPO = EXTREME_AUDIO_TEMPO;
export const _EXOTIC_PHYSICS_KEYS = Object.keys(CONFIG_EXTREME);

/* 科学引擎白名单 —— 只有这些引擎能收到 physics.js 的逐格物理注入 */
const SCIENCE_ENGINES = new Set(['grayScott', 'fitzHughNagumo', 'brusselator', 'scientific']);

/**
 * 根据 env + 极端环境 id 返回物理重参数化对象
 *
 * 【Attention 审计修复】非科学引擎（Conway/Lenia/Voronoi）现在不会 silent fail 了：
 *   —— 检测 engineType 是否在 SCIENCE_ENGINES 里
 *   —— 如果不在，返回 { _nonScientific: true } 明确标记
 *   —— app.js 收到后 toast 提示用户
 *
 * engine 自动识别 grayScott / brusselator / fitzHughNagumo 再给对的参数
 */
export function applyExoticPhysics(env, engineType, w, h) {
  const id = env._exoticId;
  if (!id) return null;  // 非极端环境 → 不改物理，用默认
  const preset = EXOTIC_PHYSICS[id];
  if (!preset) return null;

  /* 🔴 Attention 反模式修复：明确降级标记，不 silent fail */
  if (!SCIENCE_ENGINES.has(engineType)) {
    return {
      _nonScientific: true,
      _reason: `engine "${engineType}" 不支持逐格 physics 注入（仅 grayScott/fitzHughNagumo/brusselator）`,
      diffusionMult: 1.0,   // 保守默认值
      dtMult: 1.0,
      reactionBoost: null,
    };
  }

  return preset.transform(env, engineType, w, h);
}

/* ---- 物理参数重参数化表：transform() 函数体从 CONFIG_EXTREME 读参数 ---- */
const EXOTIC_PHYSICS = {

  /* ============================================================
   * 🌍 原始地球
   * ============================================================ */
  'exo-primitive': {
    label: CONFIG_EXTREME.exoPrimitive.label,
    transform(env, eng, w, h) {
      const cfg = CONFIG_EXTREME.exoPrimitive;
      return {
        noiseField: makeUniformNoise(w, h, env.noise || 0.15),
        constraintField: makeUniformConstraint(w, h, env.constraint || 0.1),
        diffusionMult: cfg.diffusionMult,
        reactionBoost: eng === 'grayScott' ? { fMult: cfg.reactionBoost.fMult, kMult: cfg.reactionBoost.kMult } : null,
        dtMult: cfg.dtMult,
        perturbation: null,
      };
    }
  },

  /* ============================================================
   * 🔥 金星高压
   * ============================================================ */
  'exo-venus': {
    label: CONFIG_EXTREME.exoVenus.label,
    transform(env, eng, w, h) {
      const cfg = CONFIG_EXTREME.exoVenus;
      const rb = cfg.reactionBoost;
      return {
        diffusionMult: cfg.diffusionMult,
        reactionBoost: eng === 'grayScott'
          ? { fMult: rb.fMult, kMult: rb.kMult }
          : eng === 'brusselator'
          ? { A_Mult: rb.A_Mult, B_Mult: rb.B_Mult }
          : eng === 'fitzHughNagumo'
          ? { aMult: rb.aMult, bMult: rb.bMult }
          : null,
        dtMult: cfg.dtMult,
        noiseField: makeUniformNoise(w, h, 0.0),
        constraintField: makeUniformConstraint(w, h, 0.95),
        perturbation: null,
        globalDecay: cfg.globalDecay,
      };
    }
  },

  /* ============================================================
   * 🧊 木卫二冰下（热梯度 → 构造 Float32Array）
   * ============================================================ */
  'exo-europa': {
    label: CONFIG_EXTREME.exoEuropa.label,
    transform(env, eng, w, h) {
      /* 木卫二冰下：去掉逐格 diffusionField（让 Euler 积分稳定）
         改用高一点的 diffusionMult + 稍高 dtMult，模拟"冰下高粘度"的物理直觉。
         热梯度 → 纯扩散系数变化，保留差异化但不破坏 Laplacian 假设。*/
      return {
        diffusionMult: 1.15,   /* 比默认 1.0 高 15%：冰下分子扩散稍快 */
        dtMult: 1.0,           /* 保守 dt */
        reactionBoost: null,
        globalDecay: 0.0005,   /* 极低衰减：冰下稳定但不冻结 */
        noiseField: makeUniformNoise(w, h, env.noise || 0.005),
        constraintField: makeUniformConstraint(w, h, env.constraint || 0.05),
        perturbation: null,
      };
    }
  },

  /* ============================================================
   * 🪐 火星殖民
   * ============================================================ */
  'exo-mars': {
    label: CONFIG_EXTREME.exoMars.label,
    transform(env, eng, w, h) {
      const cfg = CONFIG_EXTREME.exoMars;
      return {
        diffusionMult: cfg.diffusionMult,
        noiseField: makeUniformNoise(w, h, env.noise || 0.25),
        constraintField: makeUniformConstraint(w, h, env.constraint || 0.05),
        dtMult: cfg.dtMult,
        perturbation: null,
      };
    }
  },

  /* ============================================================
   * 💍 土星环碎片场
   * ============================================================ */
  'exo-saturn': {
    label: CONFIG_EXTREME.exoSaturn.label,
    transform(env, eng, w, h) {
      /* 土星环碎片：去掉 perturbation（全 canvas 扰动破坏 Laplacian）
         改用高 diffusionMult + 高 dtMult + 稍高 noise 营造"碎片撞击的混沌感"。
         perturbation 保留 null，让 step() 里的 Euler 积分不被破坏。*/
      return {
        diffusionMult: 1.2,    /* 比默认高 20%：碎片场分子扩散更快 */
        dtMult: 1.4,           /* 比默认高 40%：土星环环境"反应更激烈" */
        reactionBoost: null,
        globalDecay: 0,
        noiseField: makeUniformNoise(w, h, env.noise || 0.10),  /* 稍高噪声 */
        constraintField: makeUniformConstraint(w, h, env.constraint || 0.20),
        perturbation: null,    /* 去掉全 canvas 扰动 → 数值稳定 */
      };
    }
  },

  /* ============================================================
   * 🕳️ 黑洞潮汐（潮汐衰减 → 构造 Float32Array）
   * ============================================================ */
  'exo-blackhole': {
    label: CONFIG_EXTREME.exoBlackhole.label,
    transform(env, eng, w, h) {
      /* 黑洞潮汐：去掉 tidalField（逐格乘性衰减让 v→0 → Lyapunov NaN）
         改用低 diffusionMult + 低 dtMult + 稍高 globalDecay 模拟"黑洞拖拽"。
         v 场缓慢衰减但不会被压到零，Lyapunov 保持可计算。*/
      return {
        diffusionMult: 0.8,    /* 低扩散：黑洞附近分子被压缩 */
        dtMult: 0.4,           /* 低 dt：时间流逝变慢（相对论效应直觉）*/
        reactionBoost: null,
        globalDecay: 0.003,    /* 缓慢整体衰减：黑洞潮汐拖拽 */
        noiseField: makeUniformNoise(w, h, 0.0),
        constraintField: makeUniformConstraint(w, h, 0.8),
        tidalField: null,      /* 去掉逐格乘性衰减 → Lyapunov 保持可计算 */
        perturbation: null,
      };
    }
  },
};

/* ---- 构造引擎可用的物理字段 ---- */
function makeUniformNoise(w, h, amp) {
  if (amp <= 0) return null;
  const f = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) f[i] = amp;
  return f;
}
function makeUniformConstraint(w, h, v) {
  const f = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) f[i] = v;
  return f;
}

/* ================================================================
 * 环境 → Pet → music2 → audio 全链（physicsAudioChain）
 *
 * 把 Pet 情绪 + 极端环境一起注入 audio.js
 * audio.js.updateMetrics() 之后再调这个
 * ================================================================ */

export function computeAudioChain(m, petState, exoticEnv, music2) {
  const lyapunov = m.lyapunov ?? -2.5;
  const fractal = m.fractal ?? 1.5;
  const attr = m.attrType ?? 'stable';

  const chain = {};

  // 1. Buehler 2026: fractal → scale
  chain.buehlerScale = music2.selectiveImperfectionScale(fractal);
  chain.scaleDegrees = chain.buehlerScale.degrees;

  // 2. Bell & Gabora: lyapunov → chaos knob
  chain.chaosKnob = music2.edgeOfChaosKnob(lyapunov);

  // 3. Pimenta-Zanon: attractor + lyapunov + fractal → sonic genre
  chain.sonicGenre = music2.attractorToSonicGenre(attr, lyapunov, fractal);

  // 4. Pet mood → audio params（melody + wave + tempo + tension + reverb）
  const petAudio = petMoodToAudio(petState.mood, null);
  chain.petMood = petState.mood;
  chain.petState = petState;   /* Attention 音乐性增强：完整 Pet 状态传进 audio.js for dynamics/octaveShift/voiceCount */
  chain.petAudio = petAudio;

  // 5. 极端环境 → tempo modifier（config.js EXTREME_AUDIO_TEMPO 是单一事实源）
  chain.tempoModifier = exoticEnv ? EXTREME_AUDIO_TEMPO[exoticEnv] ?? 1.0 : 1.0;

  // 6. 综合最终：audio.js.tick() 要用的最终参数
  chain.finalTempo = (petAudio.tempo ?? 1.0) * chain.tempoModifier * (chain.chaosKnob.temperatureK > 0.3 ? 1.15 : 1.0);
  chain.finalTension = petAudio.tension ?? 0.2;
  chain.finalReverb = petAudio.reverb ?? 0.3;
  chain.finalScaleDegrees = chain.buehlerScale.degrees;
  chain.finalWave = petAudio.wave;
  chain.finalMelody = petAudio.melody;

  return chain;
}

/* ---- 底部已移到 config.js：EXTREME_PHYSICS / EXTREME_AUDIO_TEMPO ---- */
