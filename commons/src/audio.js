// Sound layer: life state -> pentatonic, real-time sonification.
// Sound is the audible interface of the organism, not decoration.
//
// ========== 完整映射公式与数值范围 ==========
//
// 【持续低音 Drone 声部】（低频呼吸感背景）
//   音量         = 0.012 + density * 0.32
//                  density 0 → 0.012  (近静音)
//                  density 1 → 0.332  (中等强度)
//                  默认关闭: 0.0001
//
//   LFO 频率     = 0.06 + density * 0.5  Hz
//                  控制低音包络的呼吸速度
//                  很稳(0.06Hz, ~17秒一周期) → 呼吸(0.56Hz, ~1.8秒)
//
//   滤波器中心频率 = 260 + entropy * 2600 * (0.35 + brightness) + activity * 500
//                  entropy 0 → ~260Hz (温柔低音)
//                  entropy 1 → 最高到 ~4270Hz (明亮尖锐)
//                  entropy 是"温柔度"：越高越结构化，但也可能尖锐
//
// 【脉冲音符 Pulse 声部】（节拍驱动的主声部）
//   基础 BPM      = 40 + tempoSmoothed * 70 + activity * 55
//                  activity 0 → 40 BPM (非常慢)
//                  activity 1 → 165 BPM (急促)
//                  tempoSmoothed 是 mapping.tempo 的指数平滑值 (α=0.08)
//                  beat 间隔 = 60 / BPM / 2 秒 (八分音符节拍)
//
//   状态修正:
//     chaotic  → beat *= 1 + (random-0.5) * 0.35  节拍微微飘移
//     stable   → beat *= 1.25                      节拍放慢、更稳
//
//   音高（随机但在五声内）:
//     degree = (seed * 3 + floor((period||1) + entropy*5)) % 5
//     period 是生命自己的呼吸周期（代），影响音高的稳定性
//
//   音量          = 0.055 + density * 0.12
//
// 【生命周期事件音色序列 EVENT_NOTES】
//   每个事件触发后播放一串音符（相对根音的半音偏移）
//   stable     → [0, +3]           温和的小三度下行
//   periodic   → [0, +2, +4]       五声上升确认节奏
//   chaotic    → [0, +2, +4, +3, +1]  快速螺旋，表现混乱
//   endangered → [0, -2]           下沉双音，温柔预警
//   extinct    → [+4, +2, 0, -2]   持续下行，渐渐消失
//   reproduction → [0, +2, +4, +5] 庆祝式上升琶音
//   drifting   → [0, +2]           柔和双音，无方向性
//
// 【整体电平 Level】
//   level = density * 0.5 + activity * 0.35 + entropy * 0.15
//   密度占主导，活跃度其次，温柔度最弱
//   level 用于平滑衰减（×0.95/帧），避免爆音
//
// 【滤波器 chain 设计】
//   noteBus (主音符) → BPF [300-4200Hz] → 发送到 delay (0.35)
//   delay chain → LPF 1600Hz + feedback 0.26 + wet 0.22
//   主信号 → DynamicsCompressor (threshold -20dB, ratio 5)
//   全部输出 → StereoPanner (compare 模式 A=-0.62, B=+0.62)
//
// 【五声音阶约束 Strictness】
//   strictness 0.2 → 偶尔出现非五声音（装饰音/过渡音）
//   strictness 0.72 → 基本严格五声（默认）
//   strictness 1.0 → 绝对五声（任何音都被纠正到最近的五声）

import { clamp, hashString } from './rng.js';
import { SCALES } from './engines.js';
import { AUDIO_CONSTANTS } from './config.js';

/* ---- 音乐理论层（music.js）---- */
import {
  HEARTBEAT_BPM, CHORD_DENSENESS, CHORD_PROGRESSION,
  generateMelodyContour, applyVoiceLeading,
  getChordNotes, jepaToAudioParams,
} from './music.js';

/* ---- 复杂系统音乐层（music2.js）—— 4 篇 arXiv 论文洞见 ---- */
import {
  selectiveImperfectionScale,   // Buehler 2026 Hall-Petch analogy
  edgeOfChaosKnob,              // Bell & Gabora 2016
  generateRhythmPattern,        // Kolic 2022
  attractorToSonicGenre,        // Pimenta-Zanon 2021
} from './music2.js';

function midiToFreq(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

const EVENT_NOTES = {
  stable: [0, 3],
  periodic: [0, 2, 4],
  chaotic: [0, 2, 4, 3, 1],
  endangered: [0, -2],
  extinct: [4, 2, 0, -2],
  reproduction: [0, 2, 4, 5],
  bloom: [0, 4, 2],
  drifting: [0, 2],
};

export class AudioEngine {
  constructor(ctx, destination, opts = {}) {
    this.ctx = ctx;
    this.destination = destination || ctx.destination;
    this.pan = opts.pan ?? 0;
    this.enabled = false;
    this.mapping = null;
    this.metrics = null;
    this.birthQueue = [];
    this.nextNote = 0;
    this.noteCounter = 0;
    this.level = 0;
    this.voices = 0;
    this.eventCooldown = 0;
    this.built = false;
    this.lastMetricsUpdate = 0;
    this.tempoSmoothed = 0.5;
    /* ---- 🌌 全链 audioChain: env → sim.metrics → Pet mood → music2 → audio ---- */
    this._audioChain = null;
    this._build();

    /* ---- 音乐性增强（v3）状态 ---- */
    this._heartbeatNext = 0;       // Layer 1: 心跳
    /* Attention 统一聚合：heartbeatBPM 由 tick() 统一写
       updateMetrics() 写 _baseHeartbeatBPM（metrics 基准）
       setAudioChain()  写 _tempoMultiplier（Pet × 星球）
       tick()           聚合：_heartbeatBPM = _baseHeartbeatBPM × _tempoMultiplier */
    this._heartbeatBPM = AUDIO_CONSTANTS.heartbeat.defaultBPM;
    this._baseHeartbeatBPM = AUDIO_CONSTANTS.heartbeat.defaultBPM;
    this._tempoMultiplier = 1.0;   // 默认没有 Pet/env 修饰
    /* Attention 统一聚合：strictness 由 tick() 统一写
       updateMetrics() 写 _baseChaosTemp（Lyapunov 基准）
       setAudioChain()  写 _petTensionOffset（Pet tension 叠加）
       tick()           聚合：严格度 = clamp(1 - (_baseChaosTemp + _petTensionOffset) × coef, min, max) */
    this._baseChaosTemp = 0.2;
    this._petTensionOffset = 0;
    /* Attention 统一聚合：delayWet/Fb 由 tick() 统一 setTargetAtTime
       updateMetrics() 写 _metricsWet/_metricsFb（metrics 基准）
       setAudioChain()  写 _targetWet/_targetFb（Pet reverb 目标）
       tick()           加权 */
    this._metricsWet = AUDIO_CONSTANTS.delay.wet;
    this._metricsFb  = AUDIO_CONSTANTS.delay.feedback;
    this._targetWet  = AUDIO_CONSTANTS.delay.wet;
    this._targetFb   = AUDIO_CONSTANTS.delay.feedback;
    /* Chord 用拍数，不是秒 —— 让和弦和心跳同频 */
    this._chordNext = 0;
    this._chordRootDegree = 0;
    this._chordDensity = 'triads';
    this._chordProgIdx = 0;
    this._chordBeatCount = 8;       // 默认 8 拍切换一次（约 6.67 秒 @ 72BPM）
    this._melodyContour = null;    // Layer 3: 主旋律
    this._melodyIdx = 0;
    this._sparkleNext = 0;         // Layer 4: 水晶闪烁
  }

  _build() {
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -20;
    this.compressor.knee.value = 24;
    this.compressor.ratio.value = 5;
    this.compressor.attack.value = 0.004;
    this.compressor.release.value = 0.25;
    this.panner = ctx.createStereoPanner();
    this.panner.pan.value = this.pan;

    this.master.connect(this.compressor);
    this.compressor.connect(this.panner);
    this.panner.connect(this.destination);

    // ambient feedback delay
    this.delay = ctx.createDelay(1.5);
    this.delay.delayTime.value = AUDIO_CONSTANTS.delay.defaultTime;
    this.delayFb = ctx.createGain();
    this.delayFb.gain.value = AUDIO_CONSTANTS.delay.feedback;
    this.delayFilter = ctx.createBiquadFilter();
    this.delayFilter.type = 'lowpass';
    this.delayFilter.frequency.value = AUDIO_CONSTANTS.delay.filterCutoff;
    this.delayWet = ctx.createGain();
    this.delayWet.gain.value = AUDIO_CONSTANTS.delay.wet;
    this.delay.connect(this.delayFilter);
    this.delayFilter.connect(this.delayFb);
    this.delayFb.connect(this.delay);
    this.delayFilter.connect(this.delayWet);
    this.delayWet.connect(this.master);

    // note bus with a little send
    this.noteBus = ctx.createGain();
    this.noteBus.gain.value = 0.9;
    this.noteBus.connect(this.master);
    this.noteSend = ctx.createGain();
    this.noteSend.gain.value = 0.35;
    this.noteBus.connect(this.noteSend);
    this.noteSend.connect(this.delay);

    // drone
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0.0001;
    this.droneFilter = ctx.createBiquadFilter();
    this.droneFilter.type = 'lowpass';
    this.droneFilter.frequency.value = 900;
    this.droneFilter.Q.value = 0.7;
    this.droneGain.connect(this.droneFilter);
    this.droneFilter.connect(this.master);

    this.drones = [
      { osc: null, ratio: 1, gain: 0.55 },
      { osc: null, ratio: 1.5, gain: 0.32 },
      { osc: null, ratio: 2, gain: 0.2 },
      { osc: null, ratio: 0.5, gain: 0.22 },
    ];
    for (const d of this.drones) {
      const osc = ctx.createOscillator();
      osc.type = d.ratio === 2 ? 'triangle' : 'sine';
      osc.frequency.value = 110 * d.ratio;
      const g = ctx.createGain();
      g.gain.value = d.gain;
      osc.connect(g);
      g.connect(this.droneGain);
      osc.start();
      d.osc = osc;
      d.node = g;
    }

    this.lfo = ctx.createOscillator();
    this.lfo.type = 'sine';
    this.lfo.frequency.value = 0.11;
    this.lfoGain = ctx.createGain();
    this.lfoGain.gain.value = 0.02;
    this.lfo.connect(this.lfoGain);
    this.lfoGain.connect(this.droneGain.gain);
    this.lfo.start();

    this.built = true;
  }

  setGenome(genome) {
    this.mapping = genome.mapping;
    if (!this.built) return;
    this._tuneDrone();
  }

  _rootMidi() {
    const m = this.mapping || { root: 0, octave: 3 };
    return 12 * (m.octave + 1) + m.root;
  }

  _tuneDrone() {
    const now = this.ctx.currentTime;
    const rootHz = midiToFreq(this._rootMidi());
    for (const d of this.drones) {
      d.osc.frequency.setTargetAtTime(rootHz * d.ratio, now, 0.4);
    }
  }

  setPan(v) {
    this.pan = v;
    if (this.built) this.panner.pan.setTargetAtTime(v, this.ctx.currentTime, 0.2);
  }

  /* ================================================================
   * setAudioChain: env → sim → Pet → music2 → audio 的全链入口
   *                                                                *
   * 由 app.js refreshMainMetrics() 每 5 步调用一次。                *
   * 接收 computeAudioChain() 返回的完整结果：                       *
   *   finalTempo    — Pet mood × 极端环境 tempo modifier            *
   *   finalTension  — Pet mood tension (sick 0.75 → content 0.05)   *
   *   finalReverb   — Pet mood reverb                               *
   *   finalScaleDegrees — Buehler selectiveImperfectionScale 音阶   *
   *   finalWave     — Pet mood 波形                                 *
   *   finalMelody   — Pet mood 旋律轮廓                            *
   * ================================================================ */
  setAudioChain(chain) {
    this._audioChain = chain;
    if (!chain) return;
    if (!this.built) return;
    const AC = AUDIO_CONSTANTS;

    /* Attention 统一聚合：只写缓存变量，不再直接写最终状态 */

    // 1. finalTempo → 写 _tempoMultiplier（tick() 里 × _baseHeartbeatBPM）
    if (chain.finalTempo !== undefined) {
      this._tempoMultiplier = chain.finalTempo;
    }

    // 2. finalWave → 写入 mapping.wave（tick() 主旋律/心跳音/新生命音全用这个）
    if (chain.finalWave) {
      if (!this.mapping) this.mapping = {};
      this.mapping.wave = chain.finalWave;
    }

    // 3. finalScaleDegrees → 覆盖 Buehler scale（tick() 里 _degreeFreq 用 mapping.scale）
    if (chain.finalScaleDegrees) {
      this._activeScaleDegrees = chain.finalScaleDegrees;
    }

    // 4. finalReverb → 写 _targetWet/_targetFb（tick() 加权 × metrics 基准）
    if (chain.finalReverb !== undefined) {
      const wetR = AC.reverbAndTension.wetRange;
      const fbR  = AC.reverbAndTension.fbRange;
      this._targetWet = wetR.min + chain.finalReverb * (wetR.max - wetR.min);
      this._targetFb  = fbR.min  + chain.finalReverb  * (fbR.max  - fbR.min);
    }

    // 5. finalTension → 写 _petTensionOffset（tick() 叠加到 _baseChaosTemp）
    if (chain.finalTension !== undefined) {
      this._petTensionOffset = Math.min(1.0, chain.finalTension * AC.reverbAndTension.tensionChaosCoef);
    }

    // 6. 极端环境日志（仅状态变化时打印，避免刷屏）
    if (chain.tempoModifier && Math.abs(chain.tempoModifier - 1.0) > 0.15) {
      if (this._lastExoticTempo !== chain.tempoModifier) {
        this._lastExoticTempo = chain.tempoModifier;
        console.log(`♪ Audio chain → exotic tempo ×${chain.tempoModifier.toFixed(2)} | mood=${chain.petMood} | wave=${chain.finalWave}`);
      }
    }
  }

  setEnabled(on) {
    if (!this.built) return;
    this.enabled = on;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    if (on) {
      this.master.gain.setTargetAtTime(0.72, now, 0.35);
      this.nextNote = now + 0.15;
      this._tuneDrone();
    } else {
      this.master.gain.setTargetAtTime(0.0001, now, 0.18);
    }
  }

  /* ============================================================== */
  /* updateMetrics: 把结构指标 + 科学指标映射到声音参数               */
  /*                                                                */
  /* 原有映射（拓扑/视觉指标）：                                     */
  /*   density  → drone 音量 + LFO 速度                              */
  /*   entropy  → 滤波中心（音色亮度）                                */
  /*   activity → 滤波中心微调                                        */
  /*                                                                */
  /* 新增映射（真正的科学指标，来自 Reaction-DiffusionEngine）：      */
  /*   lyapunov → beat 不规则度 + 音高抖动                           */
  /*     λ > 0.1 混沌 → beat 抖动 ±25ms                              */
  /*     λ ≈ 0   周期 → beat 稳如钟表                                */
  /*     λ < -0.05 稳定 → beat 稍慢、柔和                            */
  /*                                                                */
  /*   fractal → 和弦密度 + bright scale 比例                        */
  /*     D > 1.7 高度复杂 → 五声音阶 × bright 装饰音                 */
  /*     D ≈ 1.2 简单 → 单音 + drone                                 */
  /*                                                                */
  /*   energy → reverb 深度 + 低音 drone 频率                         */
  /*     E < 0.5 松弛吸引子 → drone 低频（200Hz）+ 深 reverb        */
  /*     E > 3.0 活跃吸引子 → drone 偏高（340Hz）+ 浅 reverb        */
  /* ============================================================== */
  updateMetrics(m) {
    this.metrics = m;
    if (!this.built || !this.enabled) return;
    const now = this.ctx.currentTime;
    const mapping = this.mapping || {};
    const density = clamp(m.density, 0, 1);
    const entropy = clamp(m.entropy, 0, 1);
    const activity = clamp(m.activity, 0, 1);
    const attractorType = m.type || 'stable';

    /* ---- 科学指标 ---- */
    const lyapunov = m.lyapunov !== undefined ? clamp(m.lyapunov, -0.3, 0.3) : 0;
    const fractal = m.fractal !== undefined ? clamp(m.fractal, 0.5, 2.0) : 1.0;
    const energyTotal = m.energy?.total ?? 1.0;
    const energyNorm = clamp(Math.log10(energyTotal + 0.01) / 1.0, 0, 1);

    /* ================================================================ */
    /*  4 篇 arXiv 论文洞见接入                                          */
    /*  [4] Buehler 2026  → 分形维数 → 音阶选择（Hall-Petch analogy）    */
    /*  [3] Bell & Gabora → Lyapunov → Edge of Chaos 创造力 knob       */
    /*  [1] Kolic 2022    → activity+lyapunov → 节奏 pattern 生成       */
    /*  [2] Pimenta-Zanon → attractor → Sonic Genre 流派识别             */
    /* ================================================================ */
    /* [4] Buehler 2026: Hall-Petch analogy — fractal → 音阶 */
    const buehlerScale = selectiveImperfectionScale(fractal);
    // 音阶动态切换：不是硬五声，而是 fractal 决定 defect density
    this._activeScaleDegrees = buehlerScale.degrees;

    /* [3] Bell & Gabora 2016: Edge of Chaos creativity knob */
    const chaosKnob = edgeOfChaosKnob(lyapunov);
    /* Attention 统一聚合：只写 _baseChaosTemp，不再直接写 mapping.strictness */
    this._baseChaosTemp = chaosKnob.temperatureK;
    this._chaosTemperature = chaosKnob.temperatureK;  // 保留给日志
    this._chaosLevel = chaosKnob.chaosLevel;
    /* voice leading maxJump 可以直接写（不冲突）*/
    this._currentMaxJump = chaosKnob.temperatureK < 0.25 ? 2 : chaosKnob.temperatureK < 0.5 ? 7 : 12;

    /* [1] Kolic 2022: 节奏 pattern + complexity feedback */
    this._rhythmPattern = generateRhythmPattern(attractorType, lyapunov, activity);
    // 计算 rhythm complexity 3 指标，反馈到层（syncopation 高 → off-beat notes 更频繁）
    const { permEntropy, syncopation } = (() => {
      let permEnt = 0, sync = 0;
      const windowSize = 3;
      const counts = {};
      const rp = this._rhythmPattern;
      for (let i = 0; i <= rp.length - windowSize; i++) {
        const p = rp.slice(i, i + windowSize).join('');
        counts[p] = (counts[p] || 0) + 1;
      }
      const total = rp.length - windowSize + 1;
      for (const c of Object.values(counts)) {
        const pp = c / total;
        if (pp > 0) permEnt -= pp * Math.log2(pp);
      }
      permEnt = permEnt / 3;
      let on = 0, off = 0;
      for (let i = 0; i < rp.length; i++) if (rp[i]) i % 4 === 0 ? on++ : off++;
      sync = on + off > 0 ? off / (on + off) : 0;
      return { permEntropy: permEnt, syncopation: sync };
    })();
    this._permEntropy = permEntropy;
    this._syncopation = syncopation;

    /* [2] Pimenta-Zanon 2021: attractor → Sonic Genre */
    const genre = attractorToSonicGenre(attractorType, lyapunov, fractal);
    // 只在 attractor 第一次变化时打印（避免刷屏）
    if (!this._lastGenre || this._lastGenre.genreId !== genre.genreId) {
      this._lastGenre = genre;
      console.log('[SONIC GENRE]', genre.genreLabel, '|', genre.description.split('（')[0]);
      if (genre.suggestion) console.log('  ↳', genre.suggestion);
    }

    /* ---- Layer 1: Heartbeat BPM（物理心率映射）---- */
    // attractor type → 物理心率范围
    const targetBPM = HEARTBEAT_BPM[attractorType] ?? 72;
    // 加 activity 微调（运动 → 心率稍微上去）
    /* Attention 统一聚合：只写 _baseHeartbeatBPM，不再直接写 _heartbeatBPM */
    this._baseHeartbeatBPM = targetBPM + activity * 25;

    /* ---- Layer 2: Chord Pad ---- */
    const newDensity = CHORD_DENSENESS[attractorType] ?? 'triads';
    if (newDensity !== this._chordDensity) {
      this._chordDensity = newDensity;
    }
    /* Attention 统一聚合：用拍数不是秒 —— 让和弦和心跳同频
       8 拍 @ 72BPM = 6.67秒；8 拍 @ 40BPM = 12秒。不同心跳下和弦速率自适应 */
    this._chordBeatCount = Math.round(clamp(8 - density * 6, 2, 8));

    /* ---- Layer 3: Melody Contour ---- */
    // 每 16 拍（~8 秒）重新生成一段新的旋律轮廓
    if (!this._melodyContour || this._melodyIdx >= this._melodyContour.length) {
      const seed = (hashString(String(attractorType) + String(lyapunov.toFixed(2))) >>> 0) % 1000000;
      const scale = SCALES[mapping.scale || 'major'];
      const raw = generateMelodyContour(attractorType, scale.degrees, seed);
      // Voice leading 修正（稳定态严格，混沌态宽松）
      const maxJump = attractorType === 'stable' ? 2 : attractorType === 'chaotic' ? 12 : 7;
      this._melodyContour = applyVoiceLeading(raw, maxJump);
      this._melodyIdx = 0;
    }

    /* ---- drone 层（保留原有，但 BPM 改为 heartbeat 驱动）---- */
    const droneLevel = 0.012 + density * 0.32;
    const energyShift = (0.5 - energyNorm) * 140;
    this.droneGain.gain.setTargetAtTime(mapping.drone === false ? 0.0001 : droneLevel, now, 0.5);
    this.droneFilter.frequency.setTargetAtTime(
      (260 + entropy * 2600 * (0.35 + (mapping.brightness ?? 0.55)) + activity * 500)
      + energyShift,
      now, 0.4,
    );
    // LFO 呼吸节奏也用 heartbeat BPM 同步（让呼吸和心跳同频）
    this.lfo.frequency.setTargetAtTime(this._heartbeatBPM / 60 / 4, now, 0.6);  // heartbeat BPM / 4 = LFO Hz

    /* ---- 延迟/合唱层（metrics 基准，不再直接 setTargetAtTime）---- */
    /* Attention 统一聚合：只写 _metricsWet/_metricsFb，tick() 加权 Pet reverb */
    const lyaNorm = (lyapunov + 0.3) / 0.6;
    this._metricsWet = 0.1 + clamp(m.diameterNorm ?? 0.5, 0, 1) * 0.35;
    this._metricsFb  = 0.16 + clamp(1 - (m.stability ?? 0.5), 0, 1) * 0.28 + lyaNorm * 0.1;

    /* ---- tick() 需要的中间变量 ---- */
    this._beatJitterSec = Math.abs(lyapunov) * 0.15;
    this._chordality = clamp((fractal - 0.5) / 1.5, 0, 1);
    this._energyNorm = energyNorm;

    this.level = clamp(density * 0.5 + activity * 0.35 + entropy * 0.15 + this._chordality * 0.15, 0, 1);
  }

  pushBirths(births, w, h) {
    if (!births || !births.length) return;
    for (const b of births) {
      if (this.birthQueue.length > 96) break;
      this.birthQueue.push({ x: b.x / w, y: b.y / h });
    }
  }

  tick(now) {
    if (!this.built || !this.enabled) return;
    const m = this.metrics;
    const mapping = this.mapping;
    if (!m || !mapping) return;
    if (mapping.pulse === false && mapping.drone !== false) return;

    const activity = clamp(m.activity, 0, 1);
    const attractorType = m.type || 'stable';
    const scale = SCALES[mapping.scale || 'major'];
    const rootMidi = this._rootMidi();
    const AC = AUDIO_CONSTANTS;

    /* ================================================================ */
    /*  Attention 统一聚合（心智模型 1：动态上下文聚合的正确做法）         */
    /*                                                                  */
    /*  所有上游信号在此处聚合为最终状态变量                              */
    /*  updateMetrics() 和 setAudioChain() 只写各自的缓存变量             */
    /*  tick() 是唯一的最终写入点 —— 没有两套独立计算来源的覆盖冲突         */
    /* ================================================================ */

    /* 1. heartbeatBPM = metrics 基准 × Pet+星球 tempo modifier          */
    const rawBPM = this._baseHeartbeatBPM * this._tempoMultiplier;
    /* 平滑过渡（α=0.4 新值，α=0.6 旧值 —— 让心跳不要跳变但响应够快）*/
    this._heartbeatBPM = this._heartbeatBPM * AC.heartbeat.smoothRatioOld + rawBPM * AC.heartbeat.smoothRatioNew;

    /* 2. strictness = clamp(1 - (baseChaos + petTensionOffset) × coef, min, max) */
    const effectiveTemp = Math.min(1.0, this._baseChaosTemp + this._petTensionOffset);
    mapping.strictness = clamp(1 - effectiveTemp * AC.strictness.chaosCoef, AC.strictness.min, AC.strictness.max);

    /* 3. delayWet/delayFb = 0.4 × metrics基准 + 0.6 × Pet reverb目标（加权混合）*/
    const nowS = now;
    const finalWet = 0.4 * this._metricsWet + 0.6 * this._targetWet;
    const finalFb  = 0.4 * this._metricsFb  + 0.6 * this._targetFb;
    this.delayWet.gain.setTargetAtTime(finalWet, nowS, 0.5);
    this.delayFb.gain.setTargetAtTime(finalFb, nowS, 0.5);

    /* ================================================================ */
    /*  Layer 1: Heartbeat Bass 心跳节拍                                */
    /*  用统一聚合后的 heartbeatBPM（已 × Pet+星球 modifier）            */
    /* ================================================================ */
    const beat = 60 / this._heartbeatBPM;  // seconds per heartbeat
    if (this._heartbeatNext === 0) this._heartbeatNext = now + beat * 0.3;

    // attractor 决定心跳的"是否有第二心音"（stable 更稳，只有一个；chaotic 有两个间隔很近）
    const hasSplitHeartbeat = attractorType === 'chaotic' || attractorType === 'drifting';

    if (this._heartbeatNext < now + 0.15) {
      // 心跳音：根音 1 octave 下的 sine + 极短 attack
      const hz = midiToFreq(rootMidi - 12);  // 低八度
      this._heartbeatTone(hz, this._heartbeatNext);
      if (hasSplitHeartbeat) {
        // 第二心音（轻微）：delay 80ms，音量小
        this._heartbeatTone(hz * 1.06, this._heartbeatNext + beat * 0.18, 0.25);
      }
      this._heartbeatNext += beat;
      this._heartbeatNext = this._heartbeatNext > now + 5 ? this._heartbeatNext : now + beat;  // 防止漂移
    }

    /* ================================================================ */
    /*  Layer 2: Chord Pad  和弦支撑（真正的和声转换）                    */
    /*  chord 替换间隔由 _chordBeatCount 拍 × beat 秒/拍 = 秒            */
    /*  Attention 修复：用拍不是秒 —— 让和弦和心跳同频                   */
    /* ================================================================ */
    const chordSec = this._chordBeatCount * beat;
    if (this._chordNext === 0) this._chordNext = now + 0.5;
    if (this._chordNext < now + 0.25) {
      // 推进 progression
      this._chordProgIdx = (this._chordProgIdx + 1) % CHORD_PROGRESSION.length;
      this._chordRootDegree = CHORD_PROGRESSION[this._chordProgIdx][0];

      // 构建和弦
      const chordMidi = getChordNotes(
        this._chordDensity,
        this._chordRootDegree,
        scale.degrees,
        mapping.octave ?? 3,
        rootMidi - 12,   // chord pad 在低八度，听起来是支撑
      );
      // 每个和弦音是一个长音（attack 1.5 秒 slow rise）
      for (const midi of chordMidi) {
        const freq = midiToFreq(midi);
        this._chordTone(freq, this._chordNext, chordSec * 0.9);
      }
      this._chordNext += chordSec;
    }

    /* ================================================================ */
    /*  Layer 3: Lead Pulse  主旋律（有旋律轮廓 + voice leading）          */
    /*  每 half-beat（heartbeat / 2）触发一个旋律音                      */
    /*  用 _melodyContour 数组逐拍推进                                   */
    /* ================================================================ */
    const melBeat = beat / 2;  // half-beat 旋律节奏（比心跳快一倍）
    if (this.nextNote === 0 || now > this.nextNote - melBeat) this.nextNote = now + melBeat * 0.3;

    const strict = mapping.strictness ?? 0.7;
    if (this.nextNote < now + 0.12) {
      // 心跳 attractor → 旋律音的音高（从 contour 数组选）
      if (this._melodyContour && this._melodyIdx < this._melodyContour.length) {
        const degree = this._melodyContour[this._melodyIdx];
        this._melodyIdx++;
        const freq = this._degreeFreq(degree, 0);
        // dur 根据 attractor 类型：stable 长 1.5s，chaotic 短 0.25s
        const dur = attractorType === 'stable' ? 1.5 : attractorType === 'chaotic' ? 0.28 : 0.7;
        const amp = 0.055 + m.density * 0.12;
        this._tone(freq, this.nextNote, dur, amp, mapping.wave || 'triangle', 0.5);
      }
      // 保留原有 cell 触发音（新生儿）
      const cell = this.birthQueue.shift();
      if (cell) {
        const degree = Math.floor(cell.x * 5) % 5;
        const octaveShift = Math.floor((1 - cell.y) * (1 + strict * 2));
        const freq = this._degreeFreq(degree, octaveShift + 1);  // 高八度：新生儿更亮
        const amp = 0.1 + Math.random() * 0.05;
        this._tone(freq, this.nextNote, attractorType === 'stable' ? 1.2 : 0.32, amp, 'triangle', 0.5);

        // Layer 4: Sparkle Crystal — 新生儿水晶闪烁（3 harmonic 谐波）
        this._emitSparkle(this.nextNote, cell.x, cell.y);
      }
      // Lyapunov → beat 抖动（科学指标介入）
      const jitter = (Math.random() - 0.5) * this._beatJitterSec;
      this.nextNote += melBeat + jitter;
    }
    // background tab 保护
    if (this.nextNote < now - 0.4) this.nextNote = now + melBeat * 0.5;

    this.level = clamp(this.level * 0.95 + (activity * 0.4 + m.density * 0.2) * 0.05, 0, 1);
  }

  /* ---- Layer 1: Heartbeat tone ---- */
  _heartbeatTone(freq, when, peak = 0.35) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, when);
    // 心跳包络：attack 极短（10ms）→ 峰值 → 缓慢 decay（250ms）
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(peak, when + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.35);
    osc.connect(gain);
    gain.connect(this.noteBus);  // 走主通道，有 delay reverb
    osc.start(when);
    osc.stop(when + 0.42);
  }

  /* ---- Layer 2: Chord pad tone（长 attack，slow rise）---- */
  _chordTone(freq, when, dur) {
    if (this.voices > 24) return;  // chord 占 voice budget
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900;   // 柔和的 chord pad 不刺耳
    filter.Q.value = 0.7;
    osc.type = 'triangle';          // triangle 波最适合 chord pad
    osc.frequency.setValueAtTime(freq, when);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(0.14, when + 1.2);  // 1.2 秒 slow rise
    g.gain.linearRampToValueAtTime(0.0001, when + dur);

    osc.connect(filter);
    filter.connect(g);
    g.connect(this.master);  // chord 直接到 master，不走 delay（太脏）
    this.voices++;
    osc.start(when);
    osc.stop(when + dur + 0.1);
    osc.onended = () => { this.voices = Math.max(0, this.voices - 1); try { g.disconnect(); } catch {} };
  }

  /* ---- Layer 4: Sparkle Crystal（3 harmonic 谐波闪烁）---- */
  _emitSparkle(when, x, y) {
    if (this.voices > 22) return;
    const rootMidi = this._rootMidi();
    const baseHz = midiToFreq(rootMidi + 12);  // 高八度基频
    const pan = (x - 0.5) * 1.2;               // stereo: -0.6 ~ +0.6 随机分布
    const amps = [0.12, 0.08, 0.05];            // f, 2f, 3f 能量递减
    const decays = [0.5, 0.38, 0.28];           // exp decay 时间

    for (let h = 0; h < 3; h++) {
      const ctx = this.ctx;
      const osc = ctx.createOscillator();
      const panNode = ctx.createStereoPanner();
      panNode.pan.value = pan + (Math.random() - 0.5) * 0.2;
      osc.type = h === 0 ? 'sine' : 'triangle';   // 基音 sine 最纯，高次 harmonic 用 triangle 更亮
      osc.frequency.setValueAtTime(baseHz * (h + 1), when);

      const g = ctx.createGain();
      const a = amps[h];
      const d = decays[h];
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(a, when + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, when + d);

      osc.connect(panNode);
      panNode.connect(g);
      g.connect(this.noteBus);
      this.voices++;
      osc.start(when);
      osc.stop(when + d + 0.05);
      osc.onended = () => { this.voices = Math.max(0, this.voices - 1); try { g.disconnect(); } catch {} };
    }
  }

  /* ---- Layer 5: JEPA prediction feedback（外部调用）---- */
  emitJepaFeedback(feedback) {
    const params = jepaToAudioParams(feedback, SCALES[this.mapping.scale || 'major'].degrees, this._rootMidi());
    if (!params) return;
    const now = this.ctx.currentTime + 0.02;
    for (const midi of params.midiNotes) {
      const freq = midiToFreq(midi);
      const wave = params.predictionCorrect ? 'sine' : 'square';  // 正确→纯，错误→粗 square
      this._tone(freq, now, 0.6, params.loudness, wave, 0.5);
    }
  }

  _degreeFreq(degree, octaveShift = 0) {
    const mapping = this.mapping || { scale: 'major', root: 0, octave: 3, register: 0.5 };
    const scale = SCALES[mapping.scale] || SCALES.major;
    const idx = ((degree % 5) + 5) % 5;
    const oct = Math.floor(degree / 5) + octaveShift + Math.round(mapping.register * 2);
    const midi = this._rootMidi() + scale.degrees[idx] + oct * 12;
    return midiToFreq(midi);
  }

  _tone(freq, when, dur, peak, wave, send = 0.5, detune = 0) {
    const ctx = this.ctx;
    if (this.voices > 26) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = wave;
    osc.frequency.setValueAtTime(freq, when);
    if (detune) osc.detune.setValueAtTime(detune, when);
    const attack = Math.min(0.03, dur * 0.2);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), when + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    osc.connect(gain);
    gain.connect(this.noteBus);
    if (send > 0) {
      const s = ctx.createGain();
      s.gain.value = send;
      gain.connect(s);
      s.connect(this.delay);
    }
    this.voices++;
    osc.start(when);
    osc.stop(when + dur + 0.06);
    osc.onended = () => {
      this.voices = Math.max(0, this.voices - 1);
      try {
        gain.disconnect();
      } catch (e) {
        /* noop */
      }
    };
  }

  triggerEvent(type, strength = 1) {
    if (!this.built || !this.enabled) return;
    const mapping = this.mapping;
    if (!mapping || mapping.events === false) return;
    const now = this.ctx.currentTime + 0.02;
    if (now < this.eventCooldown) return;
    this.eventCooldown = now + 0.8;
    const seq = EVENT_NOTES[type] || EVENT_NOTES.drifting;
    const wave = mapping.wave === 'sine' ? 'triangle' : mapping.wave;
    const spacing = type === 'chaotic' ? 0.085 : type === 'periodic' ? 0.16 : 0.28;
    const baseOct = type === 'endangered' || type === 'extinct' ? -1 : 0;
    seq.forEach((deg, i) => {
      const freq = this._degreeFreq(deg, baseOct);
      const dur =
        type === 'endangered' ? 2.6 : type === 'stable' ? 2.0 : type === 'chaotic' ? 0.22 : 0.55;
      const peak = (type === 'extinct' ? 0.08 : 0.13) * (typeof strength === 'number' ? strength : 1);
      this._tone(freq, now + i * spacing, dur, clamp(peak, 0.02, 0.2), wave, 0.9, (i % 2 ? 6 : -5));
    });
    if (type === 'reproduction') {
      const ctx = this.ctx;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      const f0 = this._degreeFreq(0, 0);
      osc.frequency.setValueAtTime(f0, now);
      osc.frequency.exponentialRampToValueAtTime(f0 * 2, now + 0.8);
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.06, now + 0.08);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 1.1);
      osc.connect(g);
      g.connect(this.noteBus);
      osc.start(now);
      osc.stop(now + 1.2);
    }
  }

  dispose() {
    try {
      for (const d of this.drones) d.osc.stop();
      this.lfo.stop();
      this.master.disconnect();
    } catch (e) {
      /* noop */
    }
  }
}

export function createAudioContext() {
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  return new Ctor({ latencyHint: 'interactive' });
}
