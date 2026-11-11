/* ================================================================
 * Commons · 虚拟生命养成层（借鉴 QQ 宠物 2005 年核心机制）
 *
 * QQ 宠物核心设计（已验证的黄金范式）：
 *   1. 时间驱动的状态衰减（hunger/cleanliness 每分钟 -2）
 *   2. 边际递减（开心时点一下只 +5，郁闷时 +70）
 *   3. 阈值触发情绪/疾病（hunger < 30 → 肚子叫）
 *   4. 部位差异化反馈（点嘴/肚子/头 → 不同心情增量）
 *   5. 情绪 → 行为脚本（开心时跳，难过时低头）
 *
 * 关键洞察：Commons 有真实科学指标（Lyapunov λ / fractal D / energy E / density ρ），
 * 所以"QQ 宠物状态系统"应该嫁接在这些真实指标上，不是发明抽象数值。
 *
 * 映射表（QQ 抽象 ↔ Commons 物理）：
 *   QQ 心情值 ↔ Commons 平衡度 balance = 1 - |D - 1.5| × 2          [0~1]
 *   QQ 清洁值 ↔ Commons 均匀度 uniform = 1 - var(u,v) × 3            [0~1]
 *   QQ 饱食度 ↔ Commons 能量状态 energy_state = 1 - |log₁₀E + 1|      [0~1]
 *   QQ 健康值 ↔ Commons 活跃度 activity = max(0, min(1, |λ| / 0.3))   [0~1]
 *
 * 状态衰减时间尺度：
 *   env.timeScale = 1 → 每仿真步衰减 0.001 × timeScale
 *   玩家可以调 timeScale 控制"饥饿速度"（类比 QQ 宠物的每分钟 -2 点）
 * ================================================================ */

/* ---- 宠物情绪（5 档，像 QQ 宠物的心情条）---- */
export const PET_MOOD = {
  HAPPY:      'happy',       // 平衡 + 活跃 + 能量充足
  CONTENT:    'content',     // 平衡 + 稳定但能量一般
  WAITING:    'waiting',     // 某一项偏低 → 在等玩家
  SAD:        'sad',         // 两项以上偏低
  SICK:       'sick',        // 三项以上偏低 → 需要干预
};

export const PET_MOOD_LABEL = {
  happy:   '♡ 好开心呀',
  content: '♡ 今天很安稳',
  waiting: '… 好像差点什么',
  sad:     '♡ 有点沮丧',
  sick:    '♡ 需要照顾一下',
};

export const PET_MOOD_EMOJI = {
  happy:   '(≧∇≦)',
  content: '( •ᴗ• )',
  waiting: '( ´･_･` )',
  sad:     '(╥﹏╥)',
  sick:    '(×_×)',
};

/* ================================================================
 * 宠物状态：四个 0~1 的"物理状态"（不是抽象数值）
 * ================================================================ */

export class PetState {
  constructor(initial = {}) {
    // 四状态初始化（所有指标默认 0.65 → "content" 起始）
    this.balance  = initial.balance  ?? 0.65;  // QQ 心情值
    this.uniform  = initial.uniform  ?? 0.65;  // QQ 清洁值
    this.energy   = initial.energy   ?? 0.65;  // QQ 饱食度
    this.activity = initial.activity ?? 0.65;  // QQ 健康值
    this.mood = PET_MOOD.CONTENT;

    // 衰减速度（可调，类比 QQ 宠物的每分钟 -2）
    this.decayRate = initial.decayRate ?? 0.0006;  // 每仿真步

    // 边际递减系数（QQ 宠物的"开心时点一下 +5"→ 好状态时衰减更慢）
    this.marginalFactor = initial.marginalFactor ?? 1.0;

    // 内部计数器：触发情绪变化的"连续偏低"步数
    this._lowCount = { balance: 0, uniform: 0, energy: 0, activity: 0 };
    this._step = 0;
  }

  /**
   * 真实引擎 metrics → 物理状态（QQ 宠物的状态"计算"）
   * 每次仿真 step 后调用
   */
  updateFromMetrics(metrics, envTimeScale = 1.0) {
    const { lyapunov, fractal, energy, density, attrType } = metrics;

    // ① balance：fractal D 偏离 1.5（Hall-Petch 最优）越远越不平衡
    const d = fractal ?? 1.5;
    const targetD = 1.5;
    const rawBalance = clamp01(1 - Math.abs(d - targetD) * 3.0);

    // ② uniform：场的方差（用 density 的稳定度近似）
    // density 越接近 0.5（半满）+ activity 稳定 = 越均匀
    const densDeviation = Math.abs((density ?? 0.5) - 0.5) * 2;  // 0~1
    const rawUniform = clamp01(1 - densDeviation * 1.5);

    // ③ energy：自由能（高能量 = 活跃，低能量 = 饥饿）
    const E = energy?.total ?? 1.0;
    const logE = Math.log10(E + 0.01);
    const rawEnergy = clamp01(1 - Math.abs(logE + 0.5) * 1.5);  // target log₁₀E ≈ -0.5

    // ④ activity：|Lyapunov|（越混沌越活跃，越稳定越沉睡）
    const lam = lyapunov ?? -2.5;
    const rawActivity = clamp01(Math.min(1, Math.abs(lam) / 0.3));

    // 时间衰减（envTimeScale 控制衰减速度）
    const decay = this.decayRate * envTimeScale;
    // 边际递减：状态好时衰减慢，状态差时衰减快（QQ 宠物的"开心时点一下只 +5"的对偶）
    const marginal = this.marginalFactor;

    this.balance  = decayMarginal(this.balance,  rawBalance,  decay * 1.2, marginal);
    this.uniform  = decayMarginal(this.uniform,  rawUniform,  decay * 0.9, marginal);
    this.energy   = decayMarginal(this.energy,   rawEnergy,   decay * 1.5, marginal);  // 饱食衰减最快
    this.activity = decayMarginal(this.activity, rawActivity, decay * 0.7, marginal);

    // 连续偏低计数
    const LOW = 0.35;
    if (this.balance  < LOW) this._lowCount.balance++;  else this._lowCount.balance  = Math.max(0, this._lowCount.balance - 1);
    if (this.uniform  < LOW) this._lowCount.uniform++;  else this._lowCount.uniform  = Math.max(0, this._lowCount.uniform - 1);
    if (this.energy   < LOW) this._lowCount.energy++;   else this._lowCount.energy   = Math.max(0, this._lowCount.energy - 1);
    if (this.activity < LOW) this._lowCount.activity++; else this._lowCount.activity = Math.max(0, this._lowCount.activity - 1);

    this._step++;

    // 情绪计算（QQ 宠物的情绪状态机）
    this._computeMood();
    return this.mood;
  }

  /**
   * 玩家互动（类比 QQ 宠物的"点嘴/肚子/头"）
   * QQ 宠物：点嘴 +饱食，点肚子 +清洁，点头 +心情
   * Commons：paint/noise/nucleate/push → 映射到四状态
   */
  interact(action,部位) {
    // 边际递减：状态好时奖励少，状态差时奖励多（QQ 宠物的核心设计！）
    const baseBonus = 0.25;
    const conditionFactor = (current) => {
      // 状态 < 0.3 → 奖励 ×2.0（快饿死了）
      // 状态 > 0.7 → 奖励 ×0.4（开心的时候点一下只 +5）
      if (current < 0.3) return 2.0;
      if (current > 0.7) return 0.4;
      return 1.0;
    };

    let feedback = { action,部位, bonuses: {} };

    switch (action) {
      case 'paint':     // 喂（注入激活物质 → 能量 +，如果没能量）
        feedback.bonuses.energy  = baseBonus * conditionFactor(this.energy);
        feedback.bonuses.uniform = 0.05;
        break;
      case 'noise':     // 清洁（扰动让场变均匀 → 均匀度 +）
        feedback.bonuses.uniform = baseBonus * conditionFactor(this.uniform);
        feedback.bonuses.balance = 0.08;
        break;
      case 'nucleate':  // 鼓励（结晶 = 正向反馈 → 心情 +）
        feedback.bonuses.balance = baseBonus * conditionFactor(this.balance);
        feedback.bonuses.energy  = 0.06;
        break;
      case 'field_push': // 唤醒（场力推动 → 活跃 +）
        feedback.bonuses.activity = baseBonus * conditionFactor(this.activity);
        break;
    }

    // 应用奖励
    for (const [k, v] of Object.entries(feedback.bonuses)) {
      if (typeof this[k] === 'number') this[k] = clamp01(this[k] + v);
    }

    this._computeMood();
    return feedback;
  }

  _computeMood() {
    const { balance, uniform, energy, activity } = this;
    const LOW = 0.35;
    const count = [balance < LOW, uniform < LOW, energy < LOW, activity < LOW].filter(Boolean).length;

    if (count >= 3)         this.mood = PET_MOOD.SICK;
    else if (count === 2)   this.mood = PET_MOOD.SAD;
    else if (count === 1)   this.mood = PET_MOOD.WAITING;
    else if (balance > 0.75 && activity > 0.6) this.mood = PET_MOOD.HAPPY;
    else                    this.mood = PET_MOOD.CONTENT;
  }

  snapshot() {
    return {
      balance: this.balance.toFixed(3),
      uniform: this.uniform.toFixed(3),
      energy: this.energy.toFixed(3),
      activity: this.activity.toFixed(3),
      mood: this.mood,
      step: this._step,
    };
  }
}

/* ================================================================
 * QQ 宠物式的"情绪 → 声音"映射（Pet Mood → Audio）
 * QQ 宠物的"开心时叮咚，难过时呜呜" → Commons 的五声音阶版本
 * ================================================================ */

export function petMoodToAudio(mood, prevMood) {
  // C major pentatonic C=60 D=62 E=64 G=67 A=69
  // HAPPY → 上行大三度（开心的"叮咚"）
  // SAD → 下行小三度（难过的"呜呜"）
  // SICK → 停在半音（微弱 "咳"）
  const mappings = {
    happy:   { melody: [60, 64, 67], wave: 'triangle', tempo: 1.2, tension: 0.05, reverb: 0.4 },
    content: { melody: [60, 62],     wave: 'sine',     tempo: 1.0, tension: 0.12, reverb: 0.3 },
    waiting: { melody: [60, 69],     wave: 'sine',     tempo: 0.9, tension: 0.35, reverb: 0.25 },
    sad:     { melody: [69, 67, 60], wave: 'square',    tempo: 0.7, tension: 0.55, reverb: 0.15 },
    sick:    { melody: [59],         wave: 'sawtooth', tempo: 0.5, tension: 0.75, reverb: 0.05 },
  };

  return mappings[mood] || mappings.content;
}

/* ================================================================
 * QQ 宠物式的"情绪 → 视觉表情"（Emoji + 舞台 overlay）
 * ================================================================ */

export function petMoodToOverlay(mood, stageW, stageH) {
  const centerX = stageW / 2;
  const centerY = stageH / 2;
  const overlay = {
    happy:   { emoji: '♡', x: centerX, y: centerY - 40, size: 28, hue: 340, alpha: 0.55 },
    content: { emoji: '·', x: centerX, y: centerY + 60, size: 14, hue: 260, alpha: 0.30 },
    waiting: { emoji: '…', x: centerX, y: centerY + 60, size: 20, hue: 200, alpha: 0.40 },
    sad:     { emoji: '╥', x: centerX - 30, y: centerY + 40, size: 32, hue: 280, alpha: 0.50 },
    sick:    { emoji: '×', x: centerX, y: centerY - 10, size: 36, hue: 0,   alpha: 0.60 },
  };
  return overlay[mood] || null;
}

/* ================================================================
 * 时间衰减核心函数（QQ 宠物的"每分钟 -2"的连续版本）
 * ================================================================ */

function decayMarginal(current, target, rate, marginalFactor) {
  // 向 target 靠近 rate × marginalFactor
  // marginalFactor = 1.0 正常
  // marginalFactor = 0.4 状态好时（开心时衰减慢）
  // marginalFactor = 2.0 状态差时（饿极了衰减快）
  const sign = Math.sign(target - current);
  const dist = Math.abs(target - current);
  const step = rate * marginalFactor * Math.max(0.1, dist);  // 距离越远动越快
  return clamp01(current + sign * step);
}

function clamp01(x) { return Math.max(0, Math.min(1, x)); }
