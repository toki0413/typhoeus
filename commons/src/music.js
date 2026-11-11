/* ================================================================ */
/*  Commons Music Theory · 纯理论层（零外部依赖）                      */
/*                                                                  */
/*  导出：                                                           */
/*  - HEARTBEAT_BPM     attractor → 物理心率映射                       */
/*  - CHORD_DENSENESS   attractor → 和弦复杂度                        */
/*  - CHORD_PROGRESSION 五声 I-V-vi-IV 和声圈                         */
/*  - generateMelodyContour(attractor, seed) → scale degree 序列      */
/*  - applyVoiceLeading(contour, maxJump) → 修正后的序列               */
/*  - getChordNotes(density, rootDegree, scale, octave, rootMidi)     */
/*  - jepaToAudioParams(feedback, scale, rootMidi)                    */
/* ================================================================ */

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
export const CHORD_PROGRESSION = [
  [0, 4, 7],
  [7, 11, 2],
  [9, 0, 4],
  [2, 5, 9],
];

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
  const chordRootMidi = rootMidi + scaleDegrees[chordRootDegree];
  const notes = [chordRootMidi];
  if (densityType === 'root') return notes;
  if (densityType === 'power') {
    return [chordRootMidi, chordRootMidi + scaleDegrees[(chordRootDegree + 2) % 5] - scaleDegrees[chordRootDegree]];
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
