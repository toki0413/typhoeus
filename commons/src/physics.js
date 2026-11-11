/* ================================================================
 * Commons · 极端环境物理层（physics.js）
 *
 * 所有极端环境预设不是改 slider 数值，而是**真实改变反应-扩散系统的
 * 物理参数**。把这层从 app.js → engines.js 完全解耦出来：
 *
 *   EXOTIC_ENVIRONMENTS[id]
 *     ↓ 物理变换（physics.js）
 *   { D_u, D_v, f, k, dt, noiseField, constraintField, perturbation }
 *     ↓ 注入 ScientificEngine.step()
 *   真实演化
 *
 * 物理基础：
 *   金星高压 → 流体高压下扩散系数 ∝ 1/ρ × D₀（ρ↑ → D↓ ×0.5）
 *   木卫二热梯度 → 扩散系数不均匀（上热下冷 → D_u 上半部 ×1.2）
 *   火星低重力 → 低重力下分子运动更自由 → D×1.5，约束弱
 *   土星环碎片场 → 周期性粒子撞击（每 3 步注入 0.4 强度扰动）
 *   黑洞潮汐 → 潮汐拉伸 → 边界条件变成"指向中心的衰减"
 *   原始地球 → 高扰动 + 弱约束 = Turing 不稳定性起点
 * ================================================================ */

/**
 * 根据 env + 极端环境 id 返回物理重参数化对象
 * engine 自动识别 grayScott / brusselator / fitzHughNagumo 再给对的参数
 */
export function applyExoticPhysics(env, engineType, w, h) {
  const id = env._exoticId;
  if (!id) return null;  // 非极端环境 → 不改物理，用默认
  const preset = EXOTIC_PHYSICS[id];
  if (!preset) return null;
  return preset.transform(env, engineType, w, h);
}

/* ---- 物理参数重参数化表 ---- */
const EXOTIC_PHYSICS = {

  /* ============================================================
   * 🌍 原始地球（38 亿年）
   * 物理基础：高扰动 + 低约束 + 适中时间尺度
   * → Turing 不稳定性最容易发生的条件
   * → Buehler mid-defect corridor 最容易命中
   * ============================================================ */
  'exo-primitive': {
    label: '原始地球',
    desc: '高扰动 · 弱约束 → Turing 不稳定性起点',
    transform(env, eng, w, h) {
      return {
        // 适度提高噪声 + 稍微放宽扩散（让模式更容易长出来）
        noiseField: makeUniformNoise(w, h, env.noise || 0.15),
        constraintField: makeUniformConstraint(w, h, env.constraint || 0.1),
        // 反应-扩散：稍微增大 f（创造更高活性）
        reactionBoost: eng === 'grayScott' ? { fMult: 1.25, kMult: 1.0 } : null,
        dtMult: 1.1,  // 稍微加速
        perturbation: null,
      };
    }
  },

  /* ============================================================
   * 🔥 金星高压（92 atm, 460°C）
   * 物理基础：流体高压下扩散系数 D ∝ 1/ρ × D₀
   * → D_u/D_v × 0.5，时间慢（env.timeScale 已做了，这里再加物理效应）
   * → 高压让碰撞概率高 → 反应速率 f × 1.3
   * ============================================================ */
  'exo-venus': {
    label: '金星高压',
    desc: '高压下扩散慢 + 反应速率高',
    transform(env, eng, w, h) {
      return {
        // 高压：扩散减半，反应加快
        diffusionMult: 0.5,
        reactionBoost: eng === 'grayScott' ? { fMult: 1.3, kMult: 0.85 }
                    : eng === 'brusselator' ? { A_Mult: 1.2, B_Mult: 1.15 }
                    : eng === 'fitzHughNagumo' ? { aMult: 0.85, bMult: 1.0 }
                    : null,
        dtMult: 0.95,  // 高压下演化略慢
        noiseField: makeUniformNoise(w, h, 0.0),  // 高压 → 无随机扰动
        constraintField: makeUniformConstraint(w, h, 0.95),  // 严格约束
        perturbation: null,
        // 金星效应：额外的全局衰减（像"重力压"）
        globalDecay: 0.002,
      };
    }
  },

  /* ============================================================
   * 🧊 木卫二冰下海洋（~100km 冰层, 冰下液态水）
   * 物理基础：热梯度导致扩散系数不均匀（上热下冷）
   * → D_u 上半部 × 1.2（热），下半部 × 0.8（冷）
   * → 这种不均匀会自然产生螺旋波（Brusselator/FHN 的经典现象）
   * ============================================================ */
  'exo-europa': {
    label: '木卫二冰下',
    desc: '热梯度 → 不均匀扩散 → 螺旋波涌现',
    transform(env, eng, w, h) {
      // 构造垂直热梯度：顶部 y=0 热 (D×1.2)，底部 y=h 冷 (D×0.8)
      const D_u_field = new Float32Array(w * h);
      const D_v_field = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        const t = y / h;  // 0 (top, 热) → 1 (bottom, 冷)
        const grad = 1.2 - 0.4 * t;  // 1.2 → 0.8
        const gradV = 1.1 - 0.3 * t;
        for (let x = 0; x < w; x++) {
          const idx = y * w + x;
          D_u_field[idx] = grad;
          D_v_field[idx] = gradV;
        }
      }
      return {
        diffusionMult: 1.0,
        diffusionField_u: D_u_field,
        diffusionField_v: D_v_field,
        noiseField: makeUniformNoise(w, h, env.noise || 0.05),  // 微热扰动
        constraintField: makeUniformConstraint(w, h, env.constraint || 0.2),
        dtMult: 1.0,
        perturbation: null,
      };
    }
  },

  /* ============================================================
   * 🪐 火星（低重力 0.38g, 稀薄大气）
   * 物理基础：低重力 → 分子自由程长 → 扩散快，边界约束弱
   * → D×1.5，constraint 低
   * ============================================================ */
  'exo-mars': {
    label: '火星殖民',
    desc: '低重力 → 扩散快 + 约束弱',
    transform(env, eng, w, h) {
      return {
        diffusionMult: 1.5,
        noiseField: makeUniformNoise(w, h, env.noise || 0.25),
        constraintField: makeUniformConstraint(w, h, env.constraint || 0.05),
        dtMult: 1.2,
        perturbation: null,
      };
    }
  },

  /* ============================================================
   * 💍 土星环碎片场（碎片撞击 → 周期性扰动）
   * 物理基础：土星环里的碎片持续撞击 → 周期性粒子扰动
   * → 每 P 步注入 intensity 的 Perlin 扰动
   * ============================================================ */
  'exo-saturn': {
    label: '土星环碎片场',
    desc: '周期性碎片撞击 → 混沌吸引子主导',
    transform(env, eng, w, h) {
      return {
        diffusionMult: 1.1,
        noiseField: makeUniformNoise(w, h, env.noise || 0.6),
        constraintField: makeUniformConstraint(w, h, env.constraint || 0.4),
        dtMult: 1.3,
        // 关键：周期性碎片撞击扰动
        perturbation: { rate: 3, intensity: 0.45, shape: 'perlin' },
      };
    }
  },

  /* ============================================================
   * 🕳️ 黑洞潮汐力（潮汐拉伸 → 指向中心的梯度 + 极慢演化）
   * 物理基础：潮汐力 ∝ 1/r³ → 离中心越远，v 场被"拉向中心"
   * → 边界条件：v = v × 衰减，中心保持 1.0
   * → 极慢演化，严格边界约束
   * ============================================================ */
  'exo-blackhole': {
    label: '黑洞潮汐',
    desc: '极慢 + 潮汐力 → 冻结晶体',
    transform(env, eng, w, h) {
      const cx = w / 2, cy = h / 2;
      const tidalField = new Float32Array(w * h);
      const maxR = Math.min(w, h) / 2;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const r = Math.hypot(x - cx, y - cy);
          // 潮汐衰减：离中心越远，v 场衰减越大
          const decay = Math.max(0.6, 1 - Math.pow(r / maxR, 3) * 0.4);
          tidalField[y * w + x] = decay;
        }
      }
      return {
        diffusionMult: 0.8,
        dtMult: 0.4,
        noiseField: makeUniformNoise(w, h, 0.0),
        constraintField: makeUniformConstraint(w, h, 1.0),
        perturbation: null,
        tidalField,
        globalDecay: 0.0005,  // 极小的全局衰减，维持冻结态
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
  const petAudio = music2.petMoodToAudio(petState.mood, null);
  chain.petMood = petState.mood;
  chain.petAudio = petAudio;

  // 5. 极端环境 → tempo modifier（金星慢 ×0.6，土星快 ×1.3 等）
  chain.tempoModifier = exoticEnv ? EXOTIC_TEMPO[exoticEnv] ?? 1.0 : 1.0;

  // 6. 综合最终：audio.js.tick() 要用的最终参数
  chain.finalTempo = (petAudio.tempo ?? 1.0) * chain.tempoModifier * (chain.chaosKnob.temperatureK > 0.3 ? 1.15 : 1.0);
  chain.finalTension = petAudio.tension ?? 0.2;
  chain.finalReverb = petAudio.reverb ?? 0.3;
  chain.finalScaleDegrees = chain.buehlerScale.degrees;
  chain.finalWave = petAudio.wave;
  chain.finalMelody = petAudio.melody;

  return chain;
}

/* 极端环境对 audio tempo 的自然影响（模拟不同星球的"心跳"）*/
const EXOTIC_TEMPO = {
  'exo-primitive': 1.15,  // 原始地球 → 生命刚出来，心跳稍快
  'exo-venus':     0.55,  // 金星高压 → 心跳极慢（几乎是 drone）
  'exo-europa':    1.25,  // 木卫二 → 冰下活跃，心跳快一点
  'exo-mars':      1.30,  // 火星低重力 → 心跳快
  'exo-saturn':    1.40,  // 土星环碎片撞击 → 心跳最快（chaos）
  'exo-blackhole': 0.35,  // 黑洞潮汐 → 几乎停跳
};

/* ---- 快速自检 ---- */
export const _EXOTIC_PHYSICS_KEYS = Object.keys(EXOTIC_PHYSICS);
