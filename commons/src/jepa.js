/* ================================================================ */
/*  Commons-JEPA：在形态嵌入空间里做预测                               */
/*                                                                  */
/*  借鉴 JEPA（LeCun 2022；Cell-JEPA 2026）的核心思想：             */
/*    不用 encoder 从像素学习表征，                                    */
/*    我们已经有物理原生的形态坐标——这就是 embedding！                  */
/*                                                                  */
/*  形态嵌入空间 M（4 维）：                                          */
/*    M = [λ, D, log₁₀E, P]                                         */
/*    λ = Lyapunov 指数（混沌度 / 蝴蝶效应强度）                       */
/*    D = 分形维数（结构复杂度）                                       */
/*    E = Landau 自由能密度（系统活跃度）                               */
/*    P = 空间周期（结构尺度）                                         */
/*                                                                  */
/*  两个 predictor（JEPA 的核心：预测而不是生成）：                     */
/*                                                                  */
/*  A) 物理近似 predictor（零训练，O(1) 推理）：                        */
/*     对每对参数 (f, k) → 用局部参数敏感度近似预测 E_{t+K}            */
/*     适合给玩家实时反馈（<10ms）                                     */
/*                                                                  */
/*  B) 玩家直觉训练 predictor（最小历史回归，Lazy）：                    */
/*     记录玩家每次调参 (Δparams) + 实际观测 (Δembedding)              */
/*     用 3-最近邻回归预测下一个形态变化                                */
/*     玩家玩得越多越准 —— Foldit 没这东西                             */
/*                                                                  */
/*  距离度量（morpho distance）：                                     */
/*    d(M₁, M₂) = √( w₁·Δλ² + w₂·ΔD² + w₃·Δlog₁₀E² + w₄·ΔP² )       */
/*    w = [0.35, 0.25, 0.25, 0.15]（Lyapunov 最重要）                 */
/*                                                                  */
/*  直觉训练机制（JEPA 闭环）：                                       */
/*    玩家调参数 → 直觉预测 M 会往哪个方向变 → 实际跑出 M'              */
/*    如果方向一致 → α 五声音阶的主音 + 柔和 reverb ✓                   */
/*    如果方向反了 → 半音冲突 + 干声（训练直觉）✗                      */
/*    这是 Foldit 没有的：**科学直觉训练**                             */
/* ================================================================ */

export const MORPHO_WEIGHTS = {
  lyapunov: 0.35,    // λ 最能决定"系统性格"
  fractal:  0.25,    // D 决定"系统复杂度"
  energy:   0.25,    // E 决定"活跃度"
  period:   0.15,    // P 决定"结构尺度"
};

/**
 * 把 metrics 对象转换成 4 维形态嵌入向量
 * 输出：Float32Array [λ, D, log₁₀(E), P]
 */
export function toMorphoEmbedding(metrics) {
  const λ = metrics.lyapunov ?? -2.5;
  const D = metrics.fractal ?? 1.5;
  const E = metrics.energy?.total ?? 1.0;
  const P = metrics.spatialPeriod ?? 12;
  return new Float32Array([
    clampEmb(λ, -0.3, -3.0),     // λ 范围 ~ -3.0 ~ +0.1
    clampEmb(D, 0.5, 2.0),       // D 范围 ~ 1.0 ~ 2.0
    clampEmb(Math.log10(E + 0.01), -2.5, 1.0),
    clampEmb(P, 0, 60),
  ]);
}
function clampEmb(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * 形态距离：d(M₁, M₂) — 4 维加权欧氏距离，归一化到 0~1
 */
export function morphoDistance(embA, embB) {
  const w = MORPHO_WEIGHTS;
  // 每维按物理量范围归一化（避免某个维度因量纲大而支配）
  const dλ = (embA[0] - embB[0]) / 2.0;      // Δλ ~ ±2.0
  const dD = (embA[1] - embB[1]) / 0.7;      // ΔD ~ ±0.7
  const dE = (embA[2] - embB[2]) / 1.5;      // ΔlogE ~ ±1.5
  const dP = (embA[3] - embB[3]) / 30;       // ΔP ~ ±30
  return Math.sqrt(
    w.lyapunov * dλ * dλ +
    w.fractal  * dD * dD +
    w.energy   * dE * dE +
    w.period   * dP * dP
  );
}

/**
 * 判断玩家直觉方向是否正确
 * @param {Float32Array} embNow   当前形态
 * @param {Float32Array} embFuture 参数变化后形态
 * @param {object} intendedDirection 玩家隐式想让哪个方向变（可选；不传就看"变化幅度是否大到有意义"）
 * @returns {object} { directionCorrect, dMag, directionTags }
 *
 * directionTags: 玩家"希望"形态怎么变 vs 实际怎么变
 *   chaos  : 希望/实际更混沌（λ ↑ 或 D ↑）
 *   stable : 希望/实际更稳定（λ ↓）
 *   complex: 希望/实际更复杂（D ↑ / E ↑）
 *   simpler: 希望/实际更简单（D ↓ / E ↓）
 */
export function analyzeShift(embNow, embFuture, intendedDirection = null) {
  const d = morphoDistance(embNow, embFuture);
  const directionTags = {
    λ_up:    embFuture[0] - embNow[0] > 0.02,
    λ_down:  embFuture[0] - embNow[0] < -0.02,
    D_up:    embFuture[1] - embNow[1] > 0.04,
    D_down:  embFuture[1] - embNow[1] < -0.04,
    E_up:    embFuture[2] - embNow[2] > 0.06,
    E_down:  embFuture[2] - embNow[2] < -0.06,
    P_up:    embFuture[3] - embNow[3] > 2,
    P_down:  embFuture[3] - embNow[3] < -2,
  };

  // 是否有"显著"变化（距离 > 阈值）
  const meaningfulShift = d > 0.04;

  // 如果玩家指定了 intendedDirection，就看方向是否一致
  let directionCorrect = null;
  if (intendedDirection) {
    directionCorrect = matchIntention(directionTags, intendedDirection);
  }

  return { dMag: d, meaningfulShift, directionCorrect, directionTags };
}

function matchIntention(actual, intended) {
  // intended = { chaos: true } → 期望 λ↑ 或 D↑
  // 实际有 λ_up=true 或 D_up=true → 方向一致
  if (intended.chaos)   return actual.λ_up || actual.D_up;
  if (intended.stable)  return actual.λ_down;
  if (intended.complex) return actual.D_up || actual.E_up;
  if (intended.simpler) return actual.D_down || actual.E_down;
  if (intended.biggerScale)  return actual.P_up;
  if (intended.smallerScale) return actual.P_down;
  return null;
}

/* ================================================================ */
/*  Predictor B: 玩家历史 + 3-NN 回归（JEPA 的 target predictor）     */
/* ================================================================ */

/**
 * 记录玩家的"调参 → 形态变化"历史
 * 每一条：{ paramsHash, dParams, embBefore, embAfter, time }
 *
 * paramsHash 用来把相同参数变化聚合
 */
export class PlayerPredictor {
  constructor() {
    this.history = [];
    this.maxHistory = 200;  // 最多记 200 条
  }

  record({ dParams, embBefore, embAfter, time = Date.now() }) {
    if (!dParams || !embBefore || !embAfter) return;
    this.history.push({ dParams: { ...dParams }, embBefore: [...embBefore], embAfter: [...embAfter], time });
    if (this.history.length > this.maxHistory) this.history.shift();
  }

  /**
   * 3-NN 回归：给定 dParams，找历史上最相似的 3 条，平均它们的 embAfter - embBefore
   * 返回：预测的 dEmbedding（4 维）
   */
  predict(dParams, embNow) {
    if (this.history.length < 3) return null;  // 数据不够

    const candidates = this.history.map(h => {
      const dist = paramDistance(dParams, h.dParams);
      return { h, dist };
    }).sort((a, b) => a.dist - b.dist).slice(0, 3);

    // 3 条历史里，每条的 (embAfter - embBefore) 就是"该参数变化导致的形态变化"
    let dEmb = new Float32Array(4);
    for (const { h } of candidates) {
      for (let i = 0; i < 4; i++) dEmb[i] += h.embAfter[i] - h.embBefore[i];
    }
    for (let i = 0; i < 4; i++) dEmb[i] /= 3;

    // 应用到当前形态
    const predicted = new Float32Array(4);
    for (let i = 0; i < 4; i++) predicted[i] = embNow[i] + dEmb[i];

    return predicted;
  }

  get size() { return this.history.length; }
}

/**
 * 两个 dParams 之间的距离（简化：只关心变化了哪些参数）
 */
function paramDistance(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  let d = 0;
  for (const k of keys) {
    const va = a?.[k] ?? 0;
    const vb = b?.[k] ?? 0;
    // 用参数典型范围归一化（硬编码常见物理参数）
    const range = (k === 'f' || k === 'k') ? 0.05 : (k === 'D_u' || k === 'D_v') ? 2.0 : (k === 'A' || k === 'B') ? 5.0 : 1.0;
    d += ((va - vb) / range) ** 2;
  }
  return Math.sqrt(d);
}

/* ================================================================ */
/*  直觉训练音效（接入 audio.js）                                     */
/*                                                                  */
/*  JEPA 的 predictor 误差 → 声音反馈：                              */
/*                                                                  */
/*  预测正确 → 五声音阶主音 + 柔和 reverb                             */
/*  预测错误 → 半音冲突 + 干声（训练直觉）                            */
/*                                                                  */
/*  参数变化幅度 → 音高移动（频率高八度 / 频率低八度）                  */
/*  方向标签 → 和弦类型（chaos→三全音 tension, stable→小三度）         */
/* ================================================================ */

/**
 * 返回 [baseFreq, tension, reverbMix] 三元组给 audio.js
 */
export function jepaSoundFeedback(embNow, embFuture, intendedDir = null) {
  const shift = analyzeShift(embNow, embFuture, intendedDir);
  const correct = shift.directionCorrect;
  const meaningful = shift.meaningfulShift;

  // 基准频率（C4 = 261.63 Hz）
  const base = 261.63;

  // tension（0~1）：0=完全和谐，1=最紧张
  let tension;
  if (intendedDir === null) {
    // 没有"意图"，只看变化幅度
    tension = Math.min(1, shift.dMag * 2);
  } else {
    tension = correct === null ? 0.3 : correct ? 0.15 : 0.85;
  }

  // direction → 频率偏移（chaos → 上移，stable → 下移）
  let semitoneOffset = 0;
  if (shift.directionTags.λ_up)   semitoneOffset += 4;   // +4 半音
  if (shift.directionTags.λ_down) semitoneOffset -= 4;
  if (shift.directionTags.D_up)   semitoneOffset += 3;
  if (shift.directionTags.D_down) semitoneOffset -= 3;
  if (shift.directionTags.E_up)   semitoneOffset += 2;
  if (shift.directionTags.E_down) semitoneOffset -= 2;

  const freq = base * Math.pow(2, semitoneOffset / 12);

  // reverb：正确 → 深 reverb（声音飘得远），错误 → 干声
  const reverbMix = correct === null ? 0.2 : correct ? 0.6 : 0.05;

  // 变化大 → 音量 + beat 加速
  const loudness = clampEmb(0.3 + shift.dMag * 1.5, 0.3, 0.85);

  return {
    freq, tension, reverbMix, loudness,
    correct, meaningful,
    directionTags: shift.directionTags,
    shiftMagnitude: shift.dMag,
  };
}
