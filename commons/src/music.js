/* ================================================================ */
/*  Commons Music Theory · 纯理论层（零外部依赖）                      */
/*                                                                  */
/*  导出：                                                           */
/*  - HEARTBEAT_BPM     attractor → 物理心率映射                       */
/*  - CHORD_DENSENESS   attractor → 和弦复杂度                        */
/*  - chordProgressionFor(lyapunov, attrType) → 动态和声进度           */
/*  - dynamics(petState) → { global, voice, heartbeat, chordPad }   */
/*  - voiceCount(lyapunov, activity) → 声部数（巴赫复调）             */
/*  - octaveShift(petState) → register 漂移                           */
/*  - layerWaves(moodWave, tension) → 分声部 wave 配置               */
/*  - generateMelodyContour(attractor, seed) → scale degree 序列      */
/*  - applyVoiceLeading(contour, maxJump) → 修正后的序列               */
/*  - getChordNotes(density, rootDegree, scale, octave, rootMidi)     */
/*  - jepaToAudioParams(feedback, scale, rootMidi)                    */
/* ================================================================ */

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/* ---- Attractor type → Heartbeat BPM 物理心率映射 ---- */
export const HEARTBEAT_BPM = {
  stable:      60,
  periodic:    72,
  chaotic:    130,
  drifting:    90,
  endangered:  52,
  extinct:     30,
};

/* ---- Attractor type → 和弦 denseness ---- */
export const CHORD_DENSENESS = {
  stable:     'triads',
  periodic:   'sevenths',
  chaotic:    'ninths',
  drifting:   'sevenths',
  endangered: 'power',
  extinct:    'root',
};

/* ---- 五声 I-V-vi-IV 和声转换（宫=I, 徵=V, 羽=vi, 商=IV）---- */
/* Attention 音乐性增强 v5：不再固定 4 轮循环 —— 由 Lyapunov 动态生成 */
/* 基础 progressions（每一个 entry = [scale degree, interval from root]）*/
const PROGRESSIONS = {
  stable:    [[0, 4, 7], [4, 7, 11], [7, 11, 2], [2, 5, 9]],        /* I-IV-V-I 经典循环 */
  periodic:  [[0, 4, 7], [9, 0, 4], [7, 11, 2], [5, 9, 0]],        /* I-vi-IV-V 柔和 pop */
  drifting:  [[0, 3, 7], [7, 10, 2], [2, 5, 9], [9, 12, 3]],       /* I-bIII-bVII-IV 蓝调漂移 */
  chaotic:   [[1, 4, 6], [5, 8, 10], [7, 10, 12], [0, 3, 6]],      /* bII-IV-bVII-I half-dim 不稳定桥 */
  endangered:[[0, 3, 7], [4, 7, 11], [0, 4, 7]],                    /* I-IV-I 最短循环（濒危时只剩基础支撑）*/
  extinct:   [[0, 3, 7]],                                            /* I only（灭绝时只剩根音）*/
};

/**
 * Lyapunov 驱动的和声进度选择
 * Attention 修复：Lyapunov 越高 → progression 越不稳定
 *   λ < -0.15 → stable
 *   -0.15 < λ < 0.15 → periodic
 *   λ > 0.15 → chaotic
 */
export function chordProgressionFor(lyapunov, attrType) {
  if (lyapunov === undefined) return PROGRESSIONS[attrType] ?? PROGRESSIONS.stable;
  if (attrType === 'endangered' || attrType === 'extinct') {
    return PROGRESSIONS[attrType];
  }
  if (lyapunov > 0.15)      return PROGRESSIONS.chaotic;
  if (lyapunov < -0.15)     return PROGRESSIONS.stable;
  // 边界态：在 stable 和 periodic 之间插值
  return PROGRESSIONS.periodic;
}

/* ---- 动态范围 dynamics：Pet mood → pp ↔ ff ---- */
/**
 * Beethoven symphony 的 pp ↔ ff 差 40dB。
 * 我们用 Pet energy + Pet mood 映射到 [0.15, 1.2] 的系数范围
 *   happy + energy满 → ff（1.2）
 *   sad + energy低  → pp（0.15）
 * 这样 Pet 状态直接决定整体音量 envelope
 */
export function dynamics(petState) {
  if (!petState) {
    /* 无 Pet 时也要给全字段——缺 chordPad/counter/sparkle 会让 amp 变成 NaN */
    return { global: 0.5, voice: 0.12, heartbeat: 0.18, chordPad: 0.07, counter: 0.35, sparkle: 0.05 };
  }
  const mood = petState.mood ?? 'content';
  const energy = petState.energy ?? 0.5;
  const moodFactor = {
    happy:    1.2,   /* 贝多芬 ff */
    content:  1.0,   /* mf */
    waiting:  0.75,  /* mp */
    sad:      0.45,  /* p */
    sick:     0.25,  /* pp */
  }[mood] ?? 0.7;
  const energyFactor = 0.5 + energy;  /* 0.5 ~ 1.5 */
  const global = clamp((moodFactor * energyFactor) / 1.3, 0.15, 1.2);
  return {
    global,
    voice:     0.055 * global * 2.2,    /* melody amp 基准 × dynamics */
    heartbeat: 0.35 * global,            /* heartbeat peak 基准 × dynamics */
    chordPad:  0.14 * global,            /* chord pad peak 基准 × dynamics */
    counter:   0.7 * global,             /* counter-melody 比主声部稍弱 */
    sparkle:   0.1 * global,             /* 新生儿 sparkle */
  };
}

/* ---- 织体密度 counterpoint：Lyapunov + activity → 声部数 ---- */
/**
 * 巴赫复调的核心：有序系统 → 单声部（monophony）
 * Edge of Chaos → 多声部对位（2-3 声部同时独立旋律线）
 * Chaos → 所有声部自由但被 strictness 约束在五声内
 */
export function voiceCount(lyapunov, activity) {
  if (lyapunov === undefined) return 1;
  const base = lyapunov > 0.15 ? 3 : lyapunov < -0.15 ? 1 : 2;
  const boost = activity > 0.7 ? 1 : 0;  /* activity 高 +1 声部 */
  return Math.min(4, base + boost);       /* 最多 4 声部对位 */
}

/* ---- 八度 register 漂移：Pet activity + mood → octave shift ---- */
/**
 * 情绪心理学：紧张/兴奋 → register 升高一个八度（更亮、更紧张）
 * 低落/虚弱 → register 降低一个八度（更低沉、更沉重）
 */
export function octaveShift(petState) {
  if (!petState) return 0;
  const mood = petState.mood ?? 'content';
  const activity = petState.activity ?? 0.5;
  const moodShift = {
    happy:    1,     /* 高八度：明亮 */
    content:  0,
    waiting:  0,
    sad:     -1,     /* 低八度：沉重 */
    sick:    -1,     /* 低八度：虚弱 */
  }[mood] ?? 0;
  const activityShift = activity > 0.75 ? 1 : 0;
  return moodShift + activityShift;
}

/* ---- 分声部 wave：每个声部有自己的 timbre 函数 ---- */
/**
 * 全局 wave 是偷懒 —— 每个声部应该有自己的音色函数
 *   heartbeat → 固定 sine（心跳必须稳定）
 *   chord pad → 固定 triangle（和弦必须柔和）
 *   melody → Pet mood wave（情绪驱动）
 *   counter-melody → triangle（对位声部稍柔和）
 *   cell/sparkle → Pet tension × sawtooth（紧张时刺耳）
 */
export function layerWaves(moodWave, petTension) {
  const isTense = petTension > 0.5;
  return {
    heartbeat: 'sine',
    chordPad:  'triangle',
    melody:    moodWave || 'triangle',
    counter:   isTense ? 'sawtooth' : 'triangle',
    cell:      isTense ? 'sawtooth' : 'sine',
    sparkle:   'sine',
  };
}

/* ---- 旋律轮廓生成器 ---- */
export function generateMelodyContour(attractorType, scaleDegrees, seed) {
  const len = 8;
  const rand = (i) => Math.abs(Math.sin(seed * 9.31 + i * 2.17)) * 0.999;

  switch (attractorType) {
    case 'stable': {
      const out = [];
      let cur = 4;
      for (let i = 0; i < len; i++) {
        out.push(cur);
        if (rand(i + 7) > 0.35 && cur > 0) cur -= 1;
      }
      return out;
    }
    case 'periodic': {
      const pattern = [0, 1, 2, 3, 4, 3, 2, 1];
      const out = [];
      for (let i = 0; i < len; i++) {
        let v = pattern[i];
        if (rand(i * 3) > 0.8) v = Math.max(0, Math.min(4, v + (rand(i * 5) > 0.5 ? 1 : -1)));
        out.push(v);
      }
      return out;
    }
    case 'chaotic': {
      const out = [];
      let cur = 0;
      for (let i = 0; i < len; i++) {
        out.push(cur);
        cur = Math.max(0, Math.min(4, cur + Math.floor(rand(i * 7) * 5) - 2));
      }
      return out;
    }
    case 'endangered': {
      const center = 2;
      const out = [];
      for (let i = 0; i < len; i++) {
        out.push(center + (rand(i * 3) > 0.75 ? (rand(i * 11) > 0.5 ? 1 : -1) : 0));
      }
      return out;
    }
    default: {
      const out = [];
      let cur = 2;
      for (let i = 0; i < len; i++) {
        out.push(cur);
        cur = Math.max(0, Math.min(4, cur + (rand(i * 3) > 0.5 ? 1 : -1)));
      }
      return out;
    }
  }
}

/* ---- Voice leading 修正 ---- */
export function applyVoiceLeading(contour, maxJump = 7) {
  const out = [...contour];
  const semi = [0, 2, 4, 7, 9];
  for (let i = 1; i < out.length; i++) {
    const prev = semi[out[i-1]];
    let cur = semi[out[i]];
    let jump = cur - prev;
    if (Math.abs(jump) > maxJump) {
      const dir = jump > 0 ? -1 : +1;
      const scaleIndex = out[i] + dir;
      if (scaleIndex >= 0 && scaleIndex < 5) out[i] = scaleIndex;
    }
  }
  return out;
}

/* ---- 和弦池 ---- */
export function getChordNotes(densityType, chordRootDegree, scaleDegrees, octave, rootMidi) {
  /* PROGRESSIONS 里的值有两套语义：
     - 0..scaleDegrees.length-1 → 音阶索引（如 4 = 徵）
     - 更大的值（5/7/9/11/12）→ 半音数（V、vi、maj7 等）
     之前统一按索引取，越界得到 undefined → midi NaN → setValueAtTime 抛错，
     整条 tick 音频链被中断。 */
  const semis = (i) => (Number.isInteger(i) && i >= 0 && i < scaleDegrees.length ? scaleDegrees[i] : i);
  const chordRootMidi = rootMidi + semis(chordRootDegree);
  const notes = [chordRootMidi];
  if (densityType === 'root') return notes;
  if (densityType === 'power') {
    return [chordRootMidi, chordRootMidi + semis((chordRootDegree + 2) % 5) - semis(chordRootDegree)];
  }
  const stepInterval = [0, 2, 4, 7, 9];
  for (const add of [2, 4]) notes.push(chordRootMidi + stepInterval[add]);
  if (densityType === 'sevenths') notes.push(chordRootMidi + stepInterval[3]);
  if (densityType === 'ninths') {
    notes.push(chordRootMidi + stepInterval[3]);
    notes.push(chordRootMidi + stepInterval[1] + 12);
  }
  return notes.map(m => {
    const octOffset = Math.floor((m - rootMidi) / 12) * 12;
    const within = (m - rootMidi) % 12;
    let nearest = 0, best = 99;
    for (const sd of scaleDegrees) {
      const d = Math.min(Math.abs(within - sd), 12 - Math.abs(within - sd));
      if (d < best) { best = d; nearest = sd; }
    }
    return rootMidi + nearest + octOffset;
  });
}

/* ---- JEPA → 音乐反馈 ---- */
export function jepaToAudioParams(feedback, scaleDegrees, rootMidi) {
  if (!feedback) return null;
  const { correct, tension, directionTags, shiftMagnitude, meaningful } = feedback;
  if (!meaningful) return null;
  let chord, reverbMs, loudness;
  if (correct === true) {
    chord = [0, 2, 4]; reverbMs = 1200; loudness = 0.45;
  } else if (correct === false) {
    chord = [0, 1, 3]; reverbMs = 120; loudness = 0.25;
  } else {
    chord = [0, 2]; reverbMs = 400; loudness = 0.15 + tension * 0.25;
  }
  const octave = directionTags.λ_up ? 5 : directionTags.λ_down ? 3 : 4;
  const midiNotes = chord.map(d => rootMidi + scaleDegrees[d % scaleDegrees.length] + (octave - 3) * 12);
  return { midiNotes, reverbMs, loudness, predictionCorrect: correct };
}
