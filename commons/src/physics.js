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

  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new Error(`applyExoticPhysics: 需要有效的网格宽高，收到 ${w}×${h}`);
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

/* ================================================================
 * 🧬 Life Operator Self-Evolution Bridges
 *    参考: arXiv 2609.00068 "Life Operators: a self-evolving framework
 *          for multiscale life modelling" (Fudan + HKUST, 2026)
 *
 * Commons 实现了论文的三个核心 Bridge Operator：
 *
 *   B1: Auto-Tuning Bridge
 *       Lyapunov 偏离 edge-of-chaos → 微调 diffusionMult / dtMult
 *       让系统永远活跃（不冻结、不爆炸）
 *
 *   B2: Pet → Physics Back-Influence Bridge
 *       Pet mood 反向注入物理
 *       Pet sick  → 微增 globalDecay（更"沉重"）
 *       Pet happy → 微增 noise（更多生机）
 *
 *   B3: Crowd Feedback Bridge
 *       top-N 发现的参数组合反哺 defaultEnv
 *       玩家贡献的数据 → 系统默认物理直觉
 * ================================================================ */

/* ---- B1: Auto-Tuning Bridge ----
 * Lyapunov 偏离 edge-of-chaos（≈0 附近）时，微调 diffusionMult 和 dtMult。
 * 论文 Evidence-Gated Self-Evolution 的直接实现：
 *   "operators can revise their own parameters when observations contradict
 *    their predictions"
 *
 * 目标：让系统永远活跃。极端环境默认参数可能过强（冻结）或过弱（爆炸），
 * Auto-Tuning 会自动把它拉回 edge-of-chaos 邻域。
 *
 * 返回：{ diffusionMult, dtMult } delta — 调用者加到现有 physics 上
 */
export function autoTunePhysics(metrics, currentPhysics) {
  const lyap = metrics?.lyapunov;
  if (!Number.isFinite(lyap)) return { diffusionMult: 0, dtMult: 0 };

  // Edge-of-chaos 邻域：Lyapunov 在 [-0.3, +0.15] 之间最活跃
  const EDGE_LO = -0.30;
  const EDGE_HI =  0.15;
  const EDGE_CENTER = (EDGE_LO + EDGE_HI) / 2;  // ≈ -0.075

  const diffMult = currentPhysics?.diffusionMult ?? 1.0;
  const dtMult   = currentPhysics?.dtMult ?? 1.0;

  let dDiff = 0, dDt = 0;

  if (lyap < EDGE_LO) {
    /* 冻结态：Lyapunov 太负 → 需要更多扩散打破冻结
       论文 P→E Bridge: "evolution operators may be revised when
       observed dynamics are too stable" */
    const severity = Math.min(1.0, (EDGE_LO - lyap) / 3.0);  // 严重度 0~1
    dDiff = +0.02 * severity;   // 每次只微调 2%（平滑收敛）
    dDt   = +0.01 * severity;

  } else if (lyap > EDGE_HI) {
    /* 爆炸态：Lyapunov 太正 → 需要少一点扩散抑制爆炸
       论文 P→E Bridge: "operators reduce activity when observations
       indicate instability" */
    const severity = Math.min(1.0, (lyap - EDGE_HI) / 1.5);
    dDiff = -0.02 * severity;
    dDt   = -0.01 * severity;

  } else {
    /* 活跃区：微调 dtMult 让 Lyapunov 向 CENTER 靠拢 */
    const drift = (EDGE_CENTER - lyap) / (EDGE_HI - EDGE_LO);  // -1~1
    dDt = 0.005 * drift;  // 很小的漂移力
  }

  // 硬边界保护（不让物理调到完全不合理）
  const newDiff = Math.max(0.1, Math.min(5.0, diffMult + dDiff));
  const newDt   = Math.max(0.1, Math.min(3.0, dtMult + dDt));

  return { diffusionMult: newDiff, dtMult: newDt };
}

/* ---- B2: Pet → Physics Back-Influence Bridge ----
 * 论文的 "bidirectional bridges between evolution and perception"
 * — Pet 作为 Perception Operator 的状态，反向注入 Evolution Operator。
 *
 * 这让 Commons 不再是"观察者看一个被动的系统"，
 * 而是"观察者的情绪会改变被观察对象的物理"。
 *
 * 返回：physics patch 对象（调用者 Object.assign 到现有 physics）
 *
 * 注意：三个字段始终返回（中性时为 0），这样反复 Object.assign 是幂等的——
 * 心情从 happy 回到 waiting 时旧值会被 0 覆盖，不会残留。
 */
export function petToPhysicsBridge(petState) {
  const mood = petState?.mood ?? null;

  const patch = {
    _petDecay: 0,        // 叠加到环境 globalDecay 上的额外衰减（不覆盖环境值）
    _petDtBoost: 0,      // dtMult 乘性增量：dtMult × (1 + boost)
    _petNoiseBoost: 0,   // 每 N 步注入到 v 的噪声强度（0~1 尺度）
    _petInfluence: 'neutral',
  };

  switch (mood) {
    case 'sick':
      /* Pet 病了 → 物理更"沉重"（衰减 + 节奏放慢）
         直觉：生病时连物理演化都变慢了 */
      patch._petDecay = 0.0015;   // 轻微衰减（不影响稳定性）
      patch._petDtBoost = -0.03;
      patch._petInfluence = 'sick: decay+, dt-';
      break;

    case 'sad':
      /* Pet 伤心 → 物理稍"沉重" */
      patch._petDecay = 0.0008;
      patch._petDtBoost = -0.015;
      patch._petInfluence = 'sad: decay+, dt-';
      break;

    case 'waiting':
      /* Pet 等待 → 不影响物理（中性）*/
      patch._petInfluence = 'waiting: neutral';
      break;

    case 'content':
      /* Pet 满足 → 稍增噪声（更多生机感）*/
      patch._petNoiseBoost = 0.02;
      patch._petInfluence = 'content: noise+';
      break;

    case 'happy':
      /* Pet 开心 → 物理最活跃（噪声 + 节奏加快）
         直觉：好心情让演化节奏变快 */
      patch._petNoiseBoost = 0.04;
      patch._petDtBoost = 0.05;
      patch._petInfluence = 'happy: noise+, dt+';
      break;

    default:
      break;
  }

  return patch;
}

/* ---- B3: Crowd Feedback Bridge ----
 * 论文的 "self-evolving: operators learn from evidence"
 * — top-N 发现的参数组合自动存到 localStorage，
 * 下次启动时自动合并进 defaultEnv 的默认值。
 *
 * 这是 Foldit 式众包科学的轻量实现：
 *   玩家发现 → 贡献 → 系统下次默认更接近"好种子"
 *
 * 返回：promise<{ updated: boolean, seedCount: number }>
 */
const CROWD_KEY = 'commons.crowdFeedback.v1';
const CROWD_TOP_N = 5;  // 只取 top 5 发现的参数
const CROWD_LEARN_RATE = 0.1;  // 新发现权重 10%，旧默认保留 90%

/* localStorage 安全包装：Node / 隐私模式 / 禁用存储时降级为进程内 Map。
   （此前这里写的是 `typeof safeStorage !== 'undefined'`，但 safeStorage
   从未在本模块定义，那个分支永远不可达，实际一直走裸 localStorage。） */
let _memStore = null;
function storage() {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
  } catch (_) { /* 某些环境访问 localStorage 本身也会 throw */ }
  if (!_memStore) _memStore = new Map();
  return {
    getItem: (k) => _memStore.get(k) ?? null,
    setItem: (k, v) => { _memStore.set(k, String(v)); },
  };
}

export function crowdFeedbackBridge(newDiscovery) {
  try {
    if (!newDiscovery) return { updated: false, seedCount: 0 };
    const lb = JSON.parse(storage().getItem('commons.leaderboard.v1') || '[]');

    if (lb.length === 0) return { updated: false, seedCount: 0 };

    // 取 top-N（按 similarity 排序）
    const ranked = [...lb].sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
    const topN = ranked.slice(0, CROWD_TOP_N);

    // 检查有没有新发现进了 top-N
    const isNewTop = topN.some(d => d.fingerprint === newDiscovery.fingerprint);
    if (!isNewTop) return { updated: false, seedCount: topN.length };

    // 众包平均：所有 top-N 发现的 env 参数取加权平均
    // 权重 = similarity^2（越相似权重越高）
    let totalW = 0;
    const envSum = { noise: 0, constraint: 0, timeScale: 0 };
    for (const d of topN) {
      const w = Math.pow((d.similarity ?? 50) / 100, 2);
      totalW += w;
      const e = d.environment ?? d.recipe?.env ?? {};
      envSum.noise     += (Number.isFinite(e.noise)      ? e.noise      : 0.02) * w;
      envSum.constraint += (Number.isFinite(e.constraint) ? e.constraint : 0.15) * w;
      envSum.timeScale += (Number.isFinite(e.timeScale)  ? e.timeScale  : 1.0) * w;
    }
    if (totalW === 0) return { updated: false, seedCount: topN.length };

    const crowdEnv = {
      noise:      envSum.noise / totalW,
      constraint: envSum.constraint / totalW,
      timeScale:  envSum.timeScale / totalW,
    };

    // 平滑学习：新参数 = 90% 旧默认 + 10% 众包均值
    const prev = JSON.parse(storage().getItem(CROWD_KEY) || 'null');

    const oldDefault = prev ?? { noise: 0.02, constraint: 0.15, timeScale: 1.0 };
    const learned = {
      noise:      oldDefault.noise      * (1 - CROWD_LEARN_RATE) + crowdEnv.noise      * CROWD_LEARN_RATE,
      constraint: oldDefault.constraint * (1 - CROWD_LEARN_RATE) + crowdEnv.constraint * CROWD_LEARN_RATE,
      timeScale:  oldDefault.timeScale  * (1 - CROWD_LEARN_RATE) + crowdEnv.timeScale  * CROWD_LEARN_RATE,
      updatedAt:  Date.now(),
      sourceSeedCount: topN.length,
    };

    // 存回本地存储
    storage().setItem(CROWD_KEY, JSON.stringify(learned));

    return { updated: true, seedCount: topN.length, learned };
  } catch (e) {
    return { updated: false, seedCount: 0, error: e.message };
  }
}

/* ---- 读众包默认值（engines.js defaultEnv 会调这个）----
 * 这是外部输入（localStorage 可能被手改、旧版本残留），所以只放行
 * 有限数值并夹到物理合理区间；非法字段返回 undefined，由调用方回落默认值。
 */
export function getCrowdDefaultEnv() {
  try {
    const raw = JSON.parse(storage().getItem(CROWD_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return null;
    const pick = (v, lo, hi) =>
      Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined;
    return {
      noise:      pick(raw.noise, 0, 1),
      constraint: pick(raw.constraint, 0, 1),
      timeScale:  pick(raw.timeScale, 0.05, 5),
    };
  } catch { return null; }
}
