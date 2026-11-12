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
import { AUDIO_CONSTANTS, INSTRUMENT_PARTS, DEFAULT_MIXER, normalizeMixer } from './config.js';

/* 声部默认音色（玩家未选择时使用） */
const PART_DEFAULT = Object.fromEntries(INSTRUMENT_PARTS.map((p) => [p.key, p.def]));

/* ---- 音乐理论层（music.js）---- */
import {
  HEARTBEAT_BPM, CHORD_DENSENESS,
  chordProgressionFor, dynamics, voiceCount, octaveShift, layerWaves,
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
    /* ---- 专业混音台：默认中性，不改动原有听感 ---- */
    this.mixer = normalizeMixer(DEFAULT_MIXER);
    this._userTempo = 1;
    this._reverbScale = 1;
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
    this._melodyEpoch = 0;         // 每次重生成 +1 → 旋律不会原样循环
    this._sparkleNext = 0;         // Layer 4: 水晶闪烁
    /* 生命涌现：种群趋势 → bloom/thinning 姿态 */
    this._lastDensity = null;
    this._lastDensityAt = 0;
    this._gateUntil = 0;           // thinning 后的留白窗口
    this._padCutoff = 2200;        // 由生命密度驱动（1100–3900Hz）
    this._vitality = 0.5;          // activity*0.65 + density*0.35
    this._intensity = 0.5;         // 编曲强度（快起慢落）→ 层次进出
    this._type = null;             // 上一次的结构态
    this._registerShift = 0;       // 结构态 → 八度位移（chaotic +1 / stable -1）
    this._scaleDegrees = null;     // 当前音阶（科学引擎用 Buehler，生命引擎用五声）
    this._structCd = {};           // 结构动机冷却（按类型）
    this._shimmerNext = 0;         // 高频微光（稀疏八度泛音）
    this._arpNext = 0;             // 五声琶音
    this._arpIdx = 0;
    this._chordTones = null;       // 当前和弦音，供琶音层使用
    this._bellNext = 0;            // 钟琴/铃音层
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

    /* 空气感：高频搁架 +3dB，让五声旋律的泛音不至于被低音吃掉 */
    this.air = ctx.createBiquadFilter();
    this.air.type = 'highshelf';
    this.air.frequency.value = 2800;
    this.air.gain.value = 3;

    /* ---- 主控推子（混音台 master）---- */
    this.masterTrim = ctx.createGain();
    this.masterTrim.gain.value = 1;

    this.master.connect(this.air);
    this.air.connect(this.masterTrim);
    this.masterTrim.connect(this.compressor);
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
    this.noteSend.gain.value = 0.5;
    this.noteBus.connect(this.noteSend);
    this.noteSend.connect(this.delay);

    /* ================================================================
     * 混音台通道条：每个声部独立 输入 → 增益 → 声像 → 主控
     *                                        └→ 发送 → 全局延迟/混响
     * 乐器的内部声像保留，通道声像再叠加一层，形成"轨道 + 总线"结构。
     * ================================================================ */
    this.partBuses = {};
    for (const p of INSTRUMENT_PARTS) {
      const input = ctx.createGain();
      const gain = ctx.createGain();
      const busPan = ctx.createStereoPanner();
      const send = ctx.createGain();
      input.connect(gain);
      gain.connect(busPan);
      busPan.connect(this.master);
      gain.connect(send);
      send.connect(this.delay);
      this.partBuses[p.key] = { input, gain, panner: busPan, send };
    }

    // drone
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0.0001;
    this.droneFilter = ctx.createBiquadFilter();
    this.droneFilter.type = 'lowpass';
    this.droneFilter.frequency.value = 900;
    this.droneFilter.Q.value = 0.7;
    /* 低音床的通道声像（混音台控制），在 drone 总线层面统一偏移 */
    this.dronePan = ctx.createStereoPanner();
    this.droneGain.connect(this.dronePan);
    this.dronePan.connect(this.droneFilter);
    this.droneFilter.connect(this.master);

    this.drones = [
      { osc: null, ratio: 1, gain: 0.55 },
      { osc: null, ratio: 1.5, gain: 0.32 },
      { osc: null, ratio: 2, gain: 0.2 },
      { osc: null, ratio: 0.5, gain: 0.22 },
    ];
    /* 每个 drone 单独声像 + 微失谐：单声道 drone 是"单薄"的主要来源之一 */
    const dronePans = [-0.7, 0.62, -0.45, 0.78];
    const droneDetune = [-4, 5, -7, 8];
    this.drones.forEach((d, i) => {
      const osc = ctx.createOscillator();
      osc.type = d.ratio === 2 ? 'triangle' : 'sine';
      osc.frequency.value = 110 * d.ratio;
      osc.detune.value = droneDetune[i] ?? 0;
      const g = ctx.createGain();
      g.gain.value = d.gain;
      const p = ctx.createStereoPanner();
      p.pan.value = dronePans[i] ?? 0;
      osc.connect(g);
      g.connect(p);
      p.connect(this.droneGain);
      osc.start();
      d.osc = osc;
      d.node = g;
      d.panner = p;
    });

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
    if (genome.mapping?.mixer) this.setMixer(genome.mapping.mixer);
  }

  /* ---- 混音台 ---- */
  _mix(part) {
    const d = DEFAULT_MIXER.parts[part]
      || { gain: 1, pan: 0, oct: 0, send: 0, mute: false, solo: false };
    return this.mixer?.parts?.[part] || d;
  }

  /* 任意声部处于 solo 时，其余声部自动静音 */
  _anySolo() {
    return INSTRUMENT_PARTS.some((p) => this._mix(p.key).solo);
  }

  _audible(part) {
    const m = this._mix(part);
    if (m.mute) return false;
    return !this._anySolo() || !!m.solo;
  }

  /* 声部通道输入：乐器发声节点统一接到这里 */
  _bus(part) {
    return this.partBuses?.[part]?.input || this.noteBus;
  }

  /* 混音台的八度移调（每个声部独立） */
  _applyOct(freq, part) {
    if (!part) return freq;
    return freq * Math.pow(2, this._mix(part).oct || 0);
  }

  /* 混音台参数应用：增益 / 声像 / 发送 / 独奏静音 / 主控 / 混响 / 速度 */
  setMixer(mixer) {
    this.mixer = normalizeMixer(mixer);
    if (!this.built) return;
    const now = this.ctx.currentTime;
    for (const p of INSTRUMENT_PARTS) {
      const bus = this.partBuses[p.key];
      if (!bus) continue;
      const c = this._mix(p.key);
      const on = this._audible(p.key);
      bus.gain.gain.setTargetAtTime(on ? c.gain : 0, now, 0.02);
      bus.panner.pan.setTargetAtTime(clamp(c.pan, -1, 1), now, 0.02);
      bus.send.gain.setTargetAtTime(clamp(c.send, 0, 1), now, 0.05);
    }
    this.masterTrim.gain.setTargetAtTime(clamp(this.mixer.master, 0, 1.5), now, 0.04);
    this._userTempo = this.mixer.tempo;
    /* reverb 0 → 0.4×，0.5 → 1.0×（原状），1 → 1.6× */
    this._reverbScale = 0.4 + this.mixer.reverb * 1.2;
    this._tuneDrone();
    this._applyDroneMix();
  }

  /* 低音床也吃混音台增益 / 声像 / 静音 */
  _applyDroneMix() {
    if (!this.built) return;
    const now = this.ctx.currentTime;
    const c = this._mix('drone');
    const density = clamp(this.metrics?.density ?? 0, 0, 1);
    const on = this.mapping?.drone !== false
      && this._voice('drone') !== 'off'
      && this._audible('drone');
    const level = (0.012 + density * 0.32) * clamp(c.gain, 0, 1.5);
    this.droneGain.gain.setTargetAtTime(on ? level : 0.0001, now, 0.25);
    this.dronePan.pan.setTargetAtTime(clamp(c.pan, -1, 1), now, 0.05);
  }

  _rootMidi() {
    const m = this.mapping || { root: 0, octave: 3 };
    return 12 * (m.octave + 1) + m.root;
  }

  /* 玩家自选音色：返回声部当前音色 id（off = 关闭） */
  _voice(part) {
    const v = this.mapping?.instruments?.[part];
    if (v === false) return 'off';
    if (typeof v === 'string' && v) return v;
    return PART_DEFAULT[part] || 'off';
  }

  /* 统一发声入口：把音色 id 分发到具体合成器（part 决定走哪条通道条） */
  _play(part, voice, freq, when, { dur = 0.4, amp = 0.05, pan = 0, oct = 0, wave = null } = {}) {
    if (voice === 'off' || !Number.isFinite(freq) || freq <= 0) return;
    if (!this._audible(part)) return;
    const f = this._applyOct(freq, part) * Math.pow(2, oct);
    switch (voice) {
      case 'sine': case 'triangle': case 'sawtooth': case 'square':
        this._tone(f, when, dur, amp, voice, 0.5, 0, pan, part); break;
      case 'lead':
        this._tone(f, when, dur, amp, wave || this.mapping?.wave || 'triangle', 0.5, 0, pan, part); break;
      case 'pluck': this._pluck(f, when, amp, pan, part); break;
      case 'strings': this._stringPad(f, when, dur, amp, pan, part); break;
      case 'choir': this._choir(f, when, dur, amp, pan, part); break;
      case 'flute': this._flute(f, when, dur, amp, pan, part); break;
      case 'marimba': this._marimba(f, when, amp, pan, part); break;
      case 'epiano': this._epiano(f, when, dur, amp, pan, part); break;
      case 'bell': this._bell(f, when, amp, pan, part); break;
      case 'reed': this._reed(f, when, dur, amp, pan, part); break;
      case 'shimmer': this._tone(f, when, 1.6, amp, 'sine', 0.85, 0, pan, part); break;
      case 'sub': this._sub(f, when, dur, amp, pan, part); break;
      case 'organ': this._organ(f, when, dur, amp, pan, part); break;
      case 'brass': this._brass(f, when, dur, amp, pan, part); break;
      case 'vibes': this._vibes(f, when, amp, pan, part); break;
      case 'glass': this._glass(f, when, amp, pan, part); break;
      case 'clav': this._clav(f, when, amp, pan, part); break;
      case 'musicbox': this._musicbox(f, when, amp, pan, part); break;
      case 'pad': this._chordTone(f, when, dur, amp, this.mapping?.wave || 'triangle', pan, part); break;
      case 'heart': this._heartbeatTone(f, when, amp, part); break;
      case 'drone': this._tone(f, when, dur, amp, 'sine', 0.3, 0, pan, part); break;
      default: this._tone(f, when, dur, amp, 'triangle', 0.5, 0, pan, part); break;
    }
  }

  _tuneDrone() {
    const now = this.ctx.currentTime;
    const oct = this._mix('drone').oct || 0;
    const rootHz = midiToFreq(this._rootMidi()) * Math.pow(2, oct);
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

    // 6. 极端环境状态跟踪（仅状态变化时更新，供调试/后续 UI 使用）
    if (chain.tempoModifier && Math.abs(chain.tempoModifier - 1.0) > 0.15) {
      if (this._lastExoticTempo !== chain.tempoModifier) {
        this._lastExoticTempo = chain.tempoModifier;
      }
    }
  }

  setEnabled(on) {
    if (!this.built) return;
    this.enabled = on;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    if (on) {
      this.master.gain.setTargetAtTime(0.88, now, 0.35);
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
    /* 科学引擎（有 fractal）用 Buehler 音阶；生命引擎保持用户选择的五声，
       避免 fractal 缺省值 1.0 把五声变成全音音阶 */
    this._scaleDegrees = m.fractal !== undefined
      ? buehlerScale.degrees
      : (SCALES[mapping.scale || 'major'] || SCALES.major).degrees;

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
    // 只在 attractor 第一次变化时记录当前 genre（供状态查询）
    if (!this._lastGenre || this._lastGenre.genreId !== genre.genreId) {
      this._lastGenre = genre;
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
    // 每次轮廓耗尽都重新生成，并把「当前生命状态 + epoch」写进种子：
    // 不再是同一段旋律无限循环，而是随密度/熵/活跃度持续演化。
    if (!this._melodyContour || this._melodyIdx >= this._melodyContour.length) {
      this._melodyEpoch = (this._melodyEpoch || 0) + 1;
      const seed = (hashString(JSON.stringify({
        t: attractorType,
        l: +lyapunov.toFixed(2),
        d: +density.toFixed(2),
        e: +entropy.toFixed(2),
        a: +activity.toFixed(2),
        n: this._melodyEpoch,
      })) >>> 0) % 1000000;
      const scale = SCALES[mapping.scale || 'major'];
      const raw = generateMelodyContour(attractorType, scale.degrees, seed);
      // Voice leading 修正（稳定态严格，混沌态宽松）
      const maxJump = attractorType === 'stable' ? 2 : attractorType === 'chaotic' ? 12 : 7;
      /* 乐句长度随活跃度变化：活跃 → 长句；安静 → 短句 + 留白 */
      const len = 6 + Math.round(clamp(activity, 0, 1) * 14);
      this._melodyContour = applyVoiceLeading(raw, maxJump).slice(0, len);
      this._melodyIdx = 0;
    }

    /* ---- drone 层（保留原有，但 BPM 改为 heartbeat 驱动）---- */
    const droneLevel = 0.012 + density * 0.32;
    const energyShift = (0.5 - energyNorm) * 140;
    const droneVoice = this._voice('drone');
    const droneMix = this._mix('drone');
    const droneOn = mapping.drone !== false && droneVoice !== 'off' && this._audible('drone');
    if (droneVoice !== 'off') {
      const isWave = ['sine', 'triangle', 'sawtooth', 'square'].includes(droneVoice);
      for (const dr of this.drones) {
        const w = isWave ? droneVoice : (dr.ratio === 2 ? 'triangle' : 'sine');
        if (dr.osc.type !== w) dr.osc.type = w;
      }
    }
    this.droneGain.gain.setTargetAtTime(
      droneOn ? droneLevel * clamp(droneMix.gain, 0, 1.5) : 0.0001, now, 0.5,
    );
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
    /* 🧬 生命涌现：把「种群变化」变成可听见的姿态                      */
    /*   - 繁盛度 → pad 亮度 / 和弦音数                                  */
    /*   - 种群上升 → 上行琶音（bloom）                                   */
    /*   - 种群骤降 → 低频闷响 + 短暂留白（thinning）                     */
    /* ================================================================ */
    const lifeDensity = clamp(m.density, 0, 1);
    this._vitality = clamp(activity * 0.65 + lifeDensity * 0.35, 0, 1);
    /* 编曲强度：快起慢落 —— 生命活跃时层次迅速进入，安静时缓慢退场 */
    const rate = this._vitality > this._intensity ? 0.22 : 0.05;
    this._intensity += (this._vitality - this._intensity) * rate;
    this._padCutoff = 1100 + lifeDensity * 2800;

    /* 生命力跨过阈值 → 八度位移（滞回，避免抖动）：
       繁盛时旋律抬高一个八度，衰退时降低一个八度 —— 生命"换一种活法"时音区跟着换 */
    if (this._intensity > 0.52) this._registerShift = 1;
    else if (this._intensity < 0.40) this._registerShift = -1;
    else this._registerShift = 0;

    if (this._lastDensity == null) {
      this._lastDensity = lifeDensity;
      this._lastDensityAt = now;
    } else if (now - this._lastDensityAt > 1.0) {
      const delta = lifeDensity - this._lastDensity;
      this._lastDensity = lifeDensity;
      this._lastDensityAt = now;
      /* 手势之间有冷却，避免密集抖动；阈值取 0.8%，常规演化也能触发 */
      if (now >= (this._gestureCooldown || 0)) {
        if (delta > 0.008) { this._bloom(now); this._gestureCooldown = now + 2.5; }
        else if (delta < -0.008) { this._thin(now); this._gestureCooldown = now + 2.5; }
      }
    }

    /* ================================================================ */
    /*  Attention 统一聚合 v5：8 项聚合（音乐性 44% → 75%）              */
    /*                                                                  */
    /*  [1] heartbeatBPM       — metrics 基准 × Pet+星球 tempo modifier  */
    /*  [2] strictness         — (baseChaos + petTensionOffset) × coef  */
    /*  [3] delayWet/delayFb   — metrics 基准 × Pet reverb 目标        */
    /*  [4] dynamics           — Pet mood × Pet energy → pp ↔ ff       */
    /*  [5] voiceCount         — Lyapunov × activity → 巴赫复调声部数    */
    /*  [6] octaveShift        — Pet mood × activity → register 漂移   */
    /*  [7] layerWaves         — Pet mood wave + tension → 分声部 timbre */
    /*  [8] chordProgression   — Lyapunov → 动态和声进度                 */
    /* ================================================================ */

    const rawBPM = this._baseHeartbeatBPM * this._tempoMultiplier * (this._userTempo || 1);
    this._heartbeatBPM = this._heartbeatBPM * AC.heartbeat.smoothRatioOld + rawBPM * AC.heartbeat.smoothRatioNew;

    const effectiveTemp = Math.min(1.0, this._baseChaosTemp + this._petTensionOffset);
    mapping.strictness = clamp(1 - effectiveTemp * AC.strictness.chaosCoef, AC.strictness.min, AC.strictness.max);

    const finalWet = (0.4 * this._metricsWet + 0.6 * this._targetWet) * (this._reverbScale ?? 1);
    const finalFb  = clamp((0.4 * this._metricsFb + 0.6 * this._targetFb) * (this._reverbScale ?? 1), 0, 0.8);
    this.delayWet.gain.setTargetAtTime(clamp(finalWet, 0, 0.85), now, 0.5);
    this.delayFb.gain.setTargetAtTime(finalFb, now, 0.5);

    /* ---- 音乐性增强：5 个新维度 ---- */
    const lyapunov = m.lyapunov ?? 0;
    const fractal  = m.fractal  ?? 1.5;
    const petState = this._audioChain?.petState ?? null;
    const petTension = this._petTensionOffset ?? 0;
    const moodWave = mapping.wave || 'triangle';

    /* [4] dynamics: Beethoven pp ↔ ff */
    const dyn = dynamics(petState);

    /* [5] voiceCount: 巴赫复调声部数 */
    const nVoices = voiceCount(lyapunov, activity);

    /* [6] octaveShift: 情绪 register 漂移 */
    const octShift = octaveShift(petState);

    /* [7] layerWaves: 分声部 timbre */
    const waves = layerWaves(moodWave, petTension);

    /* [8] chordProgression: Lyapunov 驱动 */
    const chordProg = chordProgressionFor(lyapunov, attractorType);
    /* 存到实例变量，Layer 2 chord pad 用它 */
    this._chordProg = chordProg;

    /* ================================================================ */
    /*  Layer 1: Heartbeat Bass 心跳节拍                                */
    /*  用统一聚合后的 heartbeatBPM（已 × Pet+星球 modifier）            */
    /* ================================================================ */
    const beat = 60 / this._heartbeatBPM;  // seconds per heartbeat
    if (this._heartbeatNext === 0) this._heartbeatNext = now + beat * 0.3;

    // attractor 决定心跳的"是否有第二心音"（stable 更稳，只有一个；chaotic 有两个间隔很近）
    const hasSplitHeartbeat = attractorType === 'chaotic' || attractorType === 'drifting';

    const heartVoice = this._voice('heart');
    if (heartVoice !== 'off' && this._heartbeatNext < now + 0.15) {
      // 心跳音：根音 1 octave 下的 sine + 极短 attack
      // Attention 音乐性增强：音量 × dyn.heartbeat（Pet mood → pp ↔ ff）
      const hzRaw = midiToFreq(rootMidi - 12);        // 低八度
      const hz = this._applyOct(hzRaw, 'heart');       // 混音台八度
      if (heartVoice === 'heart') {
        this._heartbeatTone(hz, this._heartbeatNext, dyn.heartbeat, 'heart');
        if (hasSplitHeartbeat) {
          this._heartbeatTone(hz * 1.06, this._heartbeatNext + beat * 0.18, dyn.heartbeat * 0.25, 'heart');
        }
      } else {
        this._play('heart', heartVoice, hzRaw, this._heartbeatNext, { dur: 0.42, amp: dyn.heartbeat });
        if (hasSplitHeartbeat) {
          this._play('heart', heartVoice, hzRaw * 1.06, this._heartbeatNext + beat * 0.18, { dur: 0.3, amp: dyn.heartbeat * 0.25 });
        }
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
      /* Attention 音乐性增强：chordProgressionFor(lyapunov, attrType) 动态和声进度
         Lyapunov 越高 → progression 越不稳定（stable → periodic → chaotic）*/
      const prog = this._chordProg ?? chordProg;
      this._chordProgIdx = (this._chordProgIdx + 1) % prog.length;
      this._chordRootDegree = prog[this._chordProgIdx][0];

      // 构建和弦
      const chordMidi = getChordNotes(
        this._chordDensity,
        this._chordRootDegree,
        this._scaleDegrees || scale.degrees,
        mapping.octave ?? 3,
        rootMidi - 12,   // chord pad 在低八度，听起来是支撑
      );
      /* Attention 音乐性增强：音量 × dyn.chordPad（Pet mood → pp ↔ ff）
         pad 音符交替左右声像，避免整个和弦挤在正中；
         和弦音数随生命密度增加 —— 繁盛时和声更厚 */
      const noteCount = Math.max(3, Math.min(chordMidi.length, 3 + Math.round(lifeDensity * 8)));
      const padAmp = (dyn.chordPad ?? 0.07) * (0.65 + this._intensity * 0.7);
      const padVoice = this._voice('pad');
      chordMidi.slice(0, noteCount).forEach((midi, ci) => {
        if (padVoice === 'off') return;
        const pan = (ci % 2 === 0 ? -1 : 1) * (0.18 + 0.1 * (ci % 3));
        this._play('pad', padVoice, midiToFreq(midi), this._chordNext, { dur: chordSec * 0.9, amp: padAmp, pan });
      });
      this._chordTones = chordMidi;
      /* 低音根音：给和声一个地基（与 pad 同八度，避免掉到 30Hz 以下听不见） */
      this._tone(this._applyOct(midiToFreq(chordMidi[0]), 'pad'), this._chordNext + 0.02, chordSec * 1.05, 0.055, 'sine', 0.3, 0, 0, 'pad');
      /* 弦乐铺底：根音 + 五音，慢起慢落，给和弦加身体 */
      const stringsVoice = this._voice('strings');
      if (stringsVoice !== 'off' && this._intensity > 0.3) {
        this._play('strings', stringsVoice, midiToFreq(chordMidi[0]), this._chordNext, { dur: chordSec * 1.15, amp: 0.03, pan: -0.35 });
        this._play('strings', stringsVoice, midiToFreq(chordMidi[Math.min(2, chordMidi.length - 1)]), this._chordNext, { dur: chordSec * 1.15, amp: 0.022, pan: 0.35 });
      }
      /* 人声 Pad：更繁盛时加入，像远处合唱 */
      const choirVoice = this._voice('choir');
      if (choirVoice !== 'off' && this._intensity > 0.42) {
        this._play('choir', choirVoice, midiToFreq(chordMidi[0] + 12), this._chordNext, { dur: chordSec * 1.1, amp: 0.018, pan: -0.5 });
        this._play('choir', choirVoice, midiToFreq(chordMidi[Math.min(2, chordMidi.length - 1)] + 12), this._chordNext, { dur: chordSec * 1.1, amp: 0.014, pan: 0.5 });
      }
      /* 高八度叠层：繁盛时让和弦更"满" */
      if (padVoice !== 'off' && this._intensity > 0.35) {
        this._play('pad', padVoice, midiToFreq(chordMidi[0] + 12), this._chordNext, { dur: chordSec * 0.9, amp: padAmp * 0.45, pan: 0.3 });
      }
      this._chordNext += chordSec;
    }

    /* Layer 2b: 五声琶音 —— 用当前和弦音做温和流动，偶尔跳高两个八度增加亮色 */
    const arpVoice = this._voice('arp');
    if (arpVoice !== 'off' && this._chordTones && this._intensity > 0.35 && now >= (this._arpNext || 0)) {
      this._arpNext = now + Math.max(0.16, beat / 2);
      const pool = this._chordTones;
      const midi = pool[this._arpIdx % pool.length] + (this._arpIdx % 5 === 4 ? 24 : 12);
      this._arpIdx++;
      this._play('arp', arpVoice, midiToFreq(midi), now + 0.01, { dur: 0.42, amp: 0.045, pan: this._arpIdx % 2 ? 0.32 : -0.32 });
    }

    /* Layer 2c: 高频微光 —— 稀疏的高八度纯音（不是噪声） */
    const shimmerVoice = this._voice('shimmer');
    if (shimmerVoice !== 'off' && now >= (this._shimmerNext || 0)) {
      this._shimmerNext = now + 1.2 + Math.random() * 1.2;
      if (this._intensity > 0.35) {
        const degs = this._scaleDegrees || scale.degrees;
        const deg = Math.floor(Math.random() * degs.length);
        const oct = Math.random() < 0.5 ? 2 : 3;
        this._play('shimmer', shimmerVoice, this._degreeFreq(deg, oct), now + 0.04, { dur: 1.6, amp: 0.05, pan: Math.random() * 1.4 - 0.7 });
      }
    }

    /* Layer 2d: 钟琴/铃音 —— 每 4–8 秒一个高音动机，偶尔两音"叮—咚" */
    const bellVoice = this._voice('bell');
    if (bellVoice !== 'off' && now >= (this._bellNext || 0)) {
      this._bellNext = now + 4 + Math.random() * 4;
      if (this._intensity > 0.3) {
        const degs = this._scaleDegrees || scale.degrees;
        const deg = Math.floor(Math.random() * degs.length);
        const pan = Math.random() * 1.2 - 0.6;
        this._play('bell', bellVoice, this._degreeFreq(deg, 2), now + 0.05, { dur: 2.0, amp: 0.05, pan });
        if (Math.random() < 0.4) {
          this._play('bell', bellVoice, this._degreeFreq((deg + 2) % degs.length, 2), now + 0.38, { dur: 1.6, amp: 0.035, pan: -pan * 0.7 });
        }
      }
    }

    /* ================================================================ */
    /*  Layer 3: Lead Pulse + Counterpoint（巴赫复调）                    */
    /*  音乐性增强：分声部 wave + dynamics × register 漂移 × counter-melody */
    /* ================================================================ */
    /* 旋律速率随生命力变化：沉寂时拉长（留白），繁盛时更密 */
    const melBeat = (beat / 2) * (1.55 - this._intensity * 0.75);
    if (this.nextNote === 0 || now > this.nextNote - melBeat) this.nextNote = now + melBeat * 0.3;

    const strict = mapping.strictness ?? 0.7;
    if (this.nextNote < now + 0.12 && now >= (this._gateUntil || 0)) {
      if (this._melodyContour && this._melodyIdx < this._melodyContour.length) {
        /* 主旋律：register = 0（基础）+ octShift（Pet mood 漂移）*/
        const degree = this._melodyContour[this._melodyIdx];
        this._melodyIdx++;
        const freq = this._degreeFreq(degree, octShift);
        const dur = attractorType === 'stable' ? 1.5 : attractorType === 'chaotic' ? 0.28 : 0.7;
        const amp = dyn.voice;
        /* Attention 音乐性增强：wave 来自 waves.melody（Pet mood wave）；
           主旋律走独立通道，混音台可单独推子 / 静音 / 换音色 */
        const leadVoice = this._voice('lead');
        if (leadVoice !== 'off') {
          this._play('lead', leadVoice, freq, this.nextNote, { dur, amp, wave: waves.melody });
        }

        /* Counter-melody：生命繁盛 + 混沌度高时 +1 声部（巴赫复调）*/
        if (nVoices >= 2 && this._intensity > 0.38 && attractorType !== 'endangered' && attractorType !== 'extinct') {
          /* counter-melody 从主 contour 高 2-3 度（五声里），register 差一个八度 */
          const counterDegree = (degree + 2) % 5;
          const counterOct   = octShift + 1;  /* 高八度对位 */
          const counterFreq = this._degreeFreq(counterDegree, counterOct);
          const counterAmp = dyn.counter;
          const counterDur = dur * 0.8;
          const fluteVoice = this._voice('flute');
          if (fluteVoice !== 'off') {
            this._play('flute', fluteVoice, counterFreq, this.nextNote, { dur: counterDur, amp: counterAmp * 0.7, pan: 0.42 });
          }
        }
      }
      // 保留原有 cell 触发音（新生儿）
      const cell = this.birthQueue.shift();
      if (cell) {
        const degree = Math.floor(cell.x * 5) % 5;
        const cellOctaveShift = Math.floor((1 - cell.y) * (1 + strict * 2));
        const freq = this._degreeFreq(degree, cellOctaveShift + 1);  // 高八度：新生儿更亮
        /* Attention 音乐性增强：amp × dyn.sparkle，wave 来自 waves.cell */
        const amp = dyn.sparkle + Math.random() * 0.02;
        const marimbaVoice = this._voice('marimba');
        if (marimbaVoice !== 'off') {
          this._play('marimba', marimbaVoice, freq, this.nextNote, { dur: 0.32, amp: amp * 1.1, pan: (cell.x - 0.5) * 1.2 });
        }

        // Layer 4: Sparkle Crystal — 新生儿水晶闪烁
        this._emitSparkle(this.nextNote, cell.x, cell.y, 'lead');
      }
      // Lyapunov → beat 抖动
      const jitter = (Math.random() - 0.5) * this._beatJitterSec;
      this.nextNote += melBeat + jitter;
    }
    if (this.nextNote < now - 0.4) this.nextNote = now + melBeat * 0.5;

    this.level = clamp(this.level * 0.95 + (activity * 0.4 + m.density * 0.2) * 0.05, 0, 1);
  }

  /* ---- Layer 1: Heartbeat tone ---- */
  _heartbeatTone(freq, when, peak = 0.35, part = 'heart') {
    if (!this._audible(part)) return;
    const ctx = this.ctx;
    if (!Number.isFinite(freq) || freq <= 0) return;   // 防御：非法频率直接跳过
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, when);
    // 心跳包络：attack 极短（10ms）→ 峰值 → 缓慢 decay（250ms）
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(peak, when + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.35);
    osc.connect(gain);
    gain.connect(this._bus(part));  // 走声部通道（有 delay send）
    osc.start(when);
    osc.stop(when + 0.42);
  }

  /* ---- 生命涌现：种群增长 → 上行琶音（bloom）---- */
  _bloom(now, part = 'arp') {
    if (!this.built || !this.enabled) return;
    if (!this._audible(part)) return;
    const degrees = [0, 2, 4, 3];
    degrees.forEach((deg, i) => {
      const f = this._applyOct(this._degreeFreq(deg, 1), part);
      this._tone(f, now + 0.02 + i * 0.13, 0.24, 0.075, 'triangle', 0.7, 0, i % 2 ? 0.45 : -0.45, part);
    });
  }

  /* ---- 生命涌现：种群骤降 → 低频闷响 + 留白（thinning）---- */
  _thin(now) {
    if (!this.built || !this.enabled) return;
    this._gateUntil = now + 1.2;
    this._heartbeatTone(this._applyOct(midiToFreq(this._rootMidi() - 12), 'heart'), now + 0.02, 0.2, 'heart');
  }

  /* ================================================================
   * 🧬 结构动机：把识别出来的具体形态变成可辨认的音乐主题
   *   still      静止块 → 柔和双音（长音、居中）
   *   oscillator 振荡器 → 两音交替脉冲
   *   glider     移动体 → 上行三音 + 声像扫动
   *   merge      合并   → 同时发声的三音簇
   *   split      分裂   → 快速下行三音
   *   birthSurge 出生潮 → 上行琶音（复用 bloom）
   *   deathSurge 死亡潮 → 低频闷响 + 留白（复用 thin）
   * ================================================================ */
  triggerStructure(evt, at) {
    if (!this.built || !this.enabled || !evt) return;
    /* at 用于离线渲染（OfflineAudioContext 的 currentTime 恒为 0） */
    const now = (Number.isFinite(at) ? at : this.ctx.currentTime) + 0.03;
    const cd = this._structCd;
    if (now < (cd[evt.type] || 0)) return;
    cd[evt.type] = now + 1.6;

    switch (evt.type) {
      case 'glider': {
        const v = this._voice('marimba');
        if (v !== 'off') [0, 2, 4].forEach((deg, i) => {
          this._play('marimba', v, this._degreeFreq(deg, 1), now + i * 0.11, { dur: 0.3, amp: 0.07, pan: -0.55 + i * 0.55 });
        });
        break;
      }
      case 'oscillator': {
        const v = this._voice('flute');
        if (v !== 'off') [1, 3, 1, 3].forEach((deg, i) => {
          this._play('flute', v, this._degreeFreq(deg, 1), now + i * 0.16, { dur: 0.16, amp: 0.05, pan: i % 2 ? 0.22 : -0.22 });
        });
        break;
      }
      case 'still': {
        const v = this._voice('bell');
        if (v !== 'off') {
          this._play('bell', v, this._degreeFreq(0, 0), now, { dur: 1.9, amp: 0.05 });
          this._play('bell', v, this._degreeFreq(2, 0), now + 0.06, { dur: 1.7, amp: 0.038 });
        }
        break;
      }
      case 'merge': {
        const v = this._voice('choir');
        if (v !== 'off') [0, 2, 4].forEach((deg, i) => {
          this._play('choir', v, this._degreeFreq(deg, 1), now + 0.02, { dur: 1.2, amp: 0.016, pan: (i - 1) * 0.5 });
        });
        break;
      }
      case 'split': {
        const v = this._voice('arp');
        if (v !== 'off') [4, 2, 0].forEach((deg, i) => {
          this._play('arp', v, this._degreeFreq(deg, 1), now + i * 0.1, { dur: 0.25, amp: 0.06, pan: 0.35 * (1 - i) });
        });
        break;
      }
      case 'birthSurge':
        this._bloom(now);
        break;
      case 'deathSurge':
        this._thin(now);
        break;
      default:
        break;
    }
  }

  /* ---- Layer 2: Chord pad tone（长 attack，slow rise）---- */
  _chordTone(freq, when, dur, amp = 0.14, wave = 'triangle', pan = 0, part = null) {
    if (this.voices > 24) return;
    if (part && !this._audible(part)) return;
    if (!Number.isFinite(freq) || freq <= 0) return;   // 防御：非法频率不能中断 tick 循环
    if (!Number.isFinite(amp)) amp = 0.1;              // 防御：NaN 振幅不能进 AudioParam
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    /* 900Hz 会把 pad 的泛音全部滤掉 → 听感闷、单薄；
       现在的截止频率由生命密度驱动（1100–3900Hz），繁盛时更亮 */
    const padCut = this._padCutoff ?? 2200;
    filter.frequency.value = padCut;
    filter.Q.value = 0.9;
    osc.type = wave === 'sine' ? 'triangle' : wave;   /* pad 不用纯 sine，留一点泛音 */
    osc.frequency.setValueAtTime(freq, when);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(amp, when + 1.2);  /* Attention 音乐性增强：amp 可配置 */
    g.gain.linearRampToValueAtTime(0.0001, when + dur);

    /* pad 左右铺开：让和弦音符分布在不同声像，制造宽度 */
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-0.8, Math.min(0.8, pan));

    osc.connect(filter);
    filter.connect(g);
    g.connect(p);
    p.connect(this._bus(part));  // chord 走声部通道（可独立推子 / 静音）
    this.voices++;
    osc.start(when);
    osc.stop(when + dur + 0.1);
    osc.onended = () => {
      this.voices = Math.max(0, this.voices - 1);
      try { g.disconnect(); p.disconnect(); } catch (_) { /* noop */ }
    };
  }

  /* ---- Layer 4: Sparkle Crystal（3 harmonic 谐波闪烁）---- */
  _emitSparkle(when, x, y, part = 'lead') {
    if (this.voices > 22) return;
    if (part && !this._audible(part)) return;
    const rootMidi = this._rootMidi();
    const baseHz = this._applyOct(midiToFreq(rootMidi + 12), part);  // 高八度基频
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
      g.connect(this._bus(part));
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
      const freq = this._applyOct(midiToFreq(midi), 'lead');
      const wave = params.predictionCorrect ? 'sine' : 'square';  // 正确→纯，错误→粗 square
      this._tone(freq, now, 0.6, params.loudness, wave, 0.5, 0, 0, 'lead');
    }
  }

  _degreeFreq(degree, octaveShift = 0) {
    const mapping = this.mapping || { scale: 'major', root: 0, octave: 3, register: 0.5 };
    const degrees = this._scaleDegrees || (SCALES[mapping.scale] || SCALES.major).degrees;
    const len = degrees.length || 5;
    const idx = ((degree % len) + len) % len;
    /* 结构态带来的八度位移：chaotic 抬高、stable 降低 → 生命"换一种活法"时听得见 */
    const oct = Math.floor(degree / len) + octaveShift + (this._registerShift || 0)
      + Math.round((mapping.register ?? 0.5) * 2);
    const midi = this._rootMidi() + degrees[idx] + oct * 12;
    return midiToFreq(midi);
  }

  _tone(freq, when, dur, peak, wave, send = 0.5, detune = 0, pan = 0, part = null) {
    const ctx = this.ctx;
    if (this.voices > 26) return;
    if (part && !this._audible(part)) return;
    if (!Number.isFinite(freq) || freq <= 0) return;   // 防御：非法频率直接跳过
    if (!Number.isFinite(peak)) peak = 0.08;            // 防御：NaN 振幅不能进 AudioParam
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

    /* 微失谐叠层（chorus-lite）：+7 cents 的第二振荡器，给单薄的主旋律加厚 */
    const osc2 = ctx.createOscillator();
    osc2.type = wave;
    osc2.frequency.setValueAtTime(freq, when);
    osc2.detune.setValueAtTime((detune || 0) + 7, when);
    const g2 = ctx.createGain();
    g2.gain.value = 0.55;
    osc2.connect(g2);
    g2.connect(gain);
    osc2.start(when);
    osc2.stop(when + dur + 0.06);

    /* 声像：旋律默认居中，counter-melody/新生儿由调用方给左右位置 */
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-0.8, Math.min(0.8, pan));
    gain.connect(p);
    p.connect(this._bus(part));
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
        p.disconnect();
      } catch (e) {
        /* noop */
      }
    };
  }

  /* ---- 钟琴/铃音：非谐泛音（1 / 2.01 / 2.76 / 5.4）+ 长衰减，高频但不刺耳 ---- */
  _bell(freq, when, amp = 0.05, pan = 0, part = null) {
    if (!this.built || !this.enabled) return;
    if (part && !this._audible(part)) return;
    if (!Number.isFinite(freq) || freq <= 0) return;
    if (!Number.isFinite(amp)) amp = 0.04;
    const ctx = this.ctx;
    const out = ctx.createGain();
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-0.8, Math.min(0.8, pan));
    out.connect(p);
    p.connect(this._bus(part));
    const send = ctx.createGain();
    send.gain.value = 0.8;
    p.connect(send);
    send.connect(this.delay);

    const partials = [
      { r: 1,    a: 1.0,  d: 2.4 },
      { r: 2.01, a: 0.42, d: 1.6 },
      { r: 2.76, a: 0.26, d: 1.1 },
      { r: 5.40, a: 0.12, d: 0.7 },
    ];
    for (const q of partials) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq * q.r, when);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, amp * q.a), when + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, when + q.d);
      osc.connect(g);
      g.connect(out);
      osc.start(when);
      osc.stop(when + q.d + 0.1);
    }
  }

  /* ---- 竖琴/拨弦：锯齿波 + 快速下扫低通，短促有颗粒感 ---- */
  _pluck(freq, when, amp = 0.045, pan = 0, part = null) {
    if (!this.built || !this.enabled) return;
    if (part && !this._audible(part)) return;
    if (!Number.isFinite(freq) || freq <= 0) return;
    if (!Number.isFinite(amp)) amp = 0.04;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, when);
    const flt = ctx.createBiquadFilter();
    flt.type = 'lowpass';
    flt.frequency.setValueAtTime(Math.min(9000, freq * 7), when);
    flt.frequency.exponentialRampToValueAtTime(Math.max(260, freq * 1.3), when + 0.2);
    flt.Q.value = 1.1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, amp), when + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.34);
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-0.8, Math.min(0.8, pan));
    osc.connect(flt); flt.connect(g); g.connect(p); p.connect(this._bus(part));
    const s = ctx.createGain(); s.gain.value = 0.45; p.connect(s); s.connect(this.delay);
    osc.start(when); osc.stop(when + 0.38);
  }

  /* ---- 弦乐铺底：两个微失谐锯齿 + 慢起慢落，给和弦加厚度 ---- */
  _stringPad(freq, when, dur, amp = 0.028, pan = 0, part = null) {
    if (!this.built || !this.enabled) return;
    if (part && !this._audible(part)) return;
    if (!Number.isFinite(freq) || freq <= 0) return;
    if (!Number.isFinite(amp)) amp = 0.025;
    const ctx = this.ctx;
    const out = ctx.createGain();
    const flt = ctx.createBiquadFilter();
    flt.type = 'lowpass';
    flt.frequency.value = Math.max(500, Math.min(3200, freq * 5));
    flt.Q.value = 0.6;
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-0.8, Math.min(0.8, pan));
    out.connect(flt); flt.connect(p); p.connect(this._bus(part));
    out.gain.setValueAtTime(0.0001, when);
    out.gain.linearRampToValueAtTime(amp, when + Math.min(1.0, dur * 0.35));
    out.gain.linearRampToValueAtTime(0.0001, when + dur);
    for (const det of [-6, 6]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq, when);
      osc.detune.setValueAtTime(det, when);
      osc.connect(out);
      osc.start(when); osc.stop(when + dur + 0.1);
    }
  }

  /* ---- 长笛/木管：基音 + 少量二次谐波，柔起柔落 ---- */
  _flute(freq, when, dur, amp = 0.05, pan = 0, part = null) {
    if (!this.built || !this.enabled) return;
    if (part && !this._audible(part)) return;
    if (!Number.isFinite(freq) || freq <= 0) return;
    if (!Number.isFinite(amp)) amp = 0.045;
    const ctx = this.ctx;
    const g = ctx.createGain();
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-0.8, Math.min(0.8, pan));
    g.connect(p); p.connect(this._bus(part));
    const attack = Math.min(0.09, dur * 0.3);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(amp, when + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    for (const [r, a] of [[1, 1], [2, 0.16]]) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq * r, when);
      const gg = ctx.createGain();
      gg.gain.value = a;
      osc.connect(gg); gg.connect(g);
      osc.start(when); osc.stop(when + dur + 0.05);
    }
  }

  /* ---- 电钢琴（2-op FM）：正弦载波 + 衰减调制，暖而有金属感 ---- */
  _epiano(freq, when, dur, amp = 0.045, pan = 0, part = null) {
    if (!this.built || !this.enabled) return;
    if (part && !this._audible(part)) return;
    if (!Number.isFinite(freq) || freq <= 0) return;
    if (!Number.isFinite(amp)) amp = 0.04;
    const ctx = this.ctx;
    const carrier = ctx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.setValueAtTime(freq, when);
    const mod = ctx.createOscillator();
    mod.type = 'sine';
    mod.frequency.setValueAtTime(freq * 2, when);
    const modGain = ctx.createGain();
    modGain.gain.setValueAtTime(freq * 1.6, when);
    modGain.gain.exponentialRampToValueAtTime(Math.max(0.01, freq * 0.12), when + 0.35);
    mod.connect(modGain);
    modGain.connect(carrier.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, amp), when + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-0.8, Math.min(0.8, pan));
    carrier.connect(g); g.connect(p); p.connect(this._bus(part));
    const s = ctx.createGain(); s.gain.value = 0.5; p.connect(s); s.connect(this.delay);
    carrier.start(when); carrier.stop(when + dur + 0.05);
    mod.start(when); mod.stop(when + dur + 0.05);
  }

  /* ---- 马林巴/木琴：基音 + 四次谐波，短促木质 ---- */
  _marimba(freq, when, amp = 0.05, pan = 0, part = null) {
    if (!this.built || !this.enabled) return;
    if (part && !this._audible(part)) return;
    if (!Number.isFinite(freq) || freq <= 0) return;
    if (!Number.isFinite(amp)) amp = 0.045;
    const ctx = this.ctx;
    const out = ctx.createGain();
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-0.8, Math.min(0.8, pan));
    out.connect(p); p.connect(this._bus(part));
    const s = ctx.createGain(); s.gain.value = 0.45; p.connect(s); s.connect(this.delay);
    const parts = [[1, 1.0, 0.55], [4, 0.22, 0.14]];
    for (const [r, a, d] of parts) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq * r, when);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, amp * a), when + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, when + d);
      osc.connect(g); g.connect(out);
      osc.start(when); osc.stop(when + d + 0.05);
    }
  }

  /* ---- 人声 Pad：锯齿 + 900Hz 共振峰，慢起慢落 ---- */
  _choir(freq, when, dur, amp = 0.02, pan = 0, part = null) {
    if (!this.built || !this.enabled) return;
    if (part && !this._audible(part)) return;
    if (!Number.isFinite(freq) || freq <= 0) return;
    if (!Number.isFinite(amp)) amp = 0.018;
    const ctx = this.ctx;
    const out = ctx.createGain();
    const formant = ctx.createBiquadFilter();
    formant.type = 'bandpass';
    formant.frequency.value = 900;
    formant.Q.value = 1.8;
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-0.8, Math.min(0.8, pan));
    out.connect(formant); formant.connect(p); p.connect(this._bus(part));
    out.gain.setValueAtTime(0.0001, when);
    out.gain.linearRampToValueAtTime(amp, when + Math.min(0.8, dur * 0.4));
    out.gain.linearRampToValueAtTime(0.0001, when + dur);
    for (const det of [-9, 9]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq, when);
      osc.detune.setValueAtTime(det, when);
      osc.connect(out);
      osc.start(when); osc.stop(when + dur + 0.1);
    }
  }

  /* ---- 簧片/口琴：方波 + 1200Hz 带通，短促有鼻音 ---- */
  _reed(freq, when, dur, amp = 0.04, pan = 0, part = null) {
    if (!this.built || !this.enabled) return;
    if (part && !this._audible(part)) return;
    if (!Number.isFinite(freq) || freq <= 0) return;
    if (!Number.isFinite(amp)) amp = 0.035;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(freq, when);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1200;
    bp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(amp, when + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-0.8, Math.min(0.8, pan));
    osc.connect(bp); bp.connect(g); g.connect(p); p.connect(this._bus(part));
    const s = ctx.createGain(); s.gain.value = 0.5; p.connect(s); s.connect(this.delay);
    osc.start(when); osc.stop(when + dur + 0.05);
  }

  /* ---- 低音 Sub：正弦基音 + 低八度 + 少量二次谐波，厚而不糊 ---- */
  _sub(freq, when, dur, amp = 0.06, pan = 0, part = null) {
    if (!this.built || !this.enabled) return;
    if (part && !this._audible(part)) return;
    if (!Number.isFinite(freq) || freq <= 0) return;
    if (!Number.isFinite(amp)) amp = 0.05;
    const ctx = this.ctx;
    const out = ctx.createGain();
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-0.8, Math.min(0.8, pan));
    out.connect(p); p.connect(this._bus(part));
    out.gain.setValueAtTime(0.0001, when);
    out.gain.linearRampToValueAtTime(amp, when + 0.02);
    out.gain.setValueAtTime(amp, when + Math.max(0.04, dur * 0.72));
    out.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    const ranks = [[1, 1, 'sine'], [2, 0.08, 'triangle']];
    if (freq * 0.5 >= 25) ranks.push([0.5, 0.5, 'sine']);
    for (const [r, a, type] of ranks) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(freq * r, when);
      const g = ctx.createGain();
      g.gain.value = a;
      osc.connect(g); g.connect(out);
      osc.start(when); osc.stop(when + dur + 0.06);
    }
  }

  /* ---- 管风琴：加法合成（1/2/3/4/6 次），稳定持续，适合铺底 ---- */
  _organ(freq, when, dur, amp = 0.045, pan = 0, part = null) {
    if (!this.built || !this.enabled) return;
    if (part && !this._audible(part)) return;
    if (!Number.isFinite(freq) || freq <= 0) return;
    if (!Number.isFinite(amp)) amp = 0.04;
    const ctx = this.ctx;
    const out = ctx.createGain();
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-0.8, Math.min(0.8, pan));
    out.connect(p); p.connect(this._bus(part));
    const attack = Math.min(0.09, dur * 0.25);
    out.gain.setValueAtTime(0.0001, when);
    out.gain.linearRampToValueAtTime(amp, when + attack);
    out.gain.setValueAtTime(amp, when + Math.max(attack, dur * 0.82));
    out.gain.linearRampToValueAtTime(0.0001, when + dur);
    const bars = [[1, 1], [2, 0.5], [3, 0.3], [4, 0.16], [6, 0.08]];
    for (const [r, a] of bars) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq * r, when);
      const g = ctx.createGain();
      g.gain.value = a;
      osc.connect(g); g.connect(out);
      osc.start(when); osc.stop(when + dur + 0.06);
    }
  }

  /* ---- 铜管：双锯齿 + 低通包络（开→收），有冲击力 ---- */
  _brass(freq, when, dur, amp = 0.04, pan = 0, part = null) {
    if (!this.built || !this.enabled) return;
    if (part && !this._audible(part)) return;
    if (!Number.isFinite(freq) || freq <= 0) return;
    if (!Number.isFinite(amp)) amp = 0.035;
    const ctx = this.ctx;
    const out = ctx.createGain();
    const flt = ctx.createBiquadFilter();
    flt.type = 'lowpass';
    flt.frequency.setValueAtTime(Math.min(8000, freq * 1.4), when);
    flt.frequency.exponentialRampToValueAtTime(Math.min(9000, freq * 7), when + 0.07);
    flt.frequency.exponentialRampToValueAtTime(Math.max(400, freq * 2.4), when + dur);
    flt.Q.value = 1.4;
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-0.8, Math.min(0.8, pan));
    out.connect(flt); flt.connect(p); p.connect(this._bus(part));
    out.gain.setValueAtTime(0.0001, when);
    out.gain.linearRampToValueAtTime(amp, when + 0.035);
    out.gain.setValueAtTime(amp, when + Math.max(0.05, dur * 0.7));
    out.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    for (const det of [-7, 7]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq, when);
      osc.detune.setValueAtTime(det, when);
      const g = ctx.createGain();
      g.gain.value = 0.5;
      osc.connect(g); g.connect(out);
      osc.start(when); osc.stop(when + dur + 0.06);
    }
  }

  /* ---- 颤音琴：基音 + 四次泛音，5Hz 振幅颤音 ---- */
  _vibes(freq, when, amp = 0.05, pan = 0, part = null) {
    if (!this.built || !this.enabled) return;
    if (part && !this._audible(part)) return;
    if (!Number.isFinite(freq) || freq <= 0) return;
    if (!Number.isFinite(amp)) amp = 0.045;
    const ctx = this.ctx;
    const out = ctx.createGain();
    const trem = ctx.createGain();
    trem.gain.value = 0.72;
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-0.8, Math.min(0.8, pan));
    out.connect(trem); trem.connect(p); p.connect(this._bus(part));

    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 5;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.26;
    lfo.connect(lfoGain); lfoGain.connect(trem.gain);
    lfo.start(when); lfo.stop(when + 1.8);

    const partials = [[1, 1, 1.5], [4, 0.28, 0.75], [10, 0.07, 0.35]];
    for (const [r, a, d] of partials) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq * r, when);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, amp * a), when + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, when + d);
      osc.connect(g); g.connect(out);
      osc.start(when); osc.stop(when + d + 0.05);
    }
  }

  /* ---- 玻璃琴：非谐泛音 + 长衰减，空灵透明 ---- */
  _glass(freq, when, amp = 0.035, pan = 0, part = null) {
    if (!this.built || !this.enabled) return;
    if (part && !this._audible(part)) return;
    if (!Number.isFinite(freq) || freq <= 0) return;
    if (!Number.isFinite(amp)) amp = 0.03;
    const ctx = this.ctx;
    const out = ctx.createGain();
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-0.8, Math.min(0.8, pan));
    out.connect(p); p.connect(this._bus(part));
    const partials = [[1, 1, 2.6], [2.7, 0.42, 1.8], [5.2, 0.18, 1.1], [8.3, 0.07, 0.6]];
    for (const [r, a, d] of partials) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq * r, when);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, amp * a), when + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, when + d);
      osc.connect(g); g.connect(out);
      osc.start(when); osc.stop(when + d + 0.05);
    }
  }

  /* ---- 击弦琴（Clav）：方波 + 快速低通下扫，短促明亮 ---- */
  _clav(freq, when, amp = 0.04, pan = 0, part = null) {
    if (!this.built || !this.enabled) return;
    if (part && !this._audible(part)) return;
    if (!Number.isFinite(freq) || freq <= 0) return;
    if (!Number.isFinite(amp)) amp = 0.035;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(freq, when);
    const flt = ctx.createBiquadFilter();
    flt.type = 'lowpass';
    flt.frequency.setValueAtTime(Math.min(10000, freq * 10), when);
    flt.frequency.exponentialRampToValueAtTime(Math.max(400, freq * 1.8), when + 0.12);
    flt.Q.value = 2.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, amp), when + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.26);
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-0.8, Math.min(0.8, pan));
    osc.connect(flt); flt.connect(g); g.connect(p); p.connect(this._bus(part));
    const s = ctx.createGain(); s.gain.value = 0.4; p.connect(s); s.connect(this.delay);
    osc.start(when); osc.stop(when + 0.3);
  }

  /* ---- 八音盒：高次泛音 + 快速衰减，清脆带金属感 ---- */
  _musicbox(freq, when, amp = 0.04, pan = 0, part = null) {
    if (!this.built || !this.enabled) return;
    if (part && !this._audible(part)) return;
    if (!Number.isFinite(freq) || freq <= 0) return;
    if (!Number.isFinite(amp)) amp = 0.035;
    const ctx = this.ctx;
    const out = ctx.createGain();
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-0.8, Math.min(0.8, pan));
    out.connect(p); p.connect(this._bus(part));
    const partials = [[1, 1, 1.1], [3, 0.3, 0.55], [6, 0.12, 0.3]];
    for (const [r, a, d] of partials) {
      for (const det of [-3, 3]) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq * r, when);
        osc.detune.setValueAtTime(det, when);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, when);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0002, amp * a * 0.5), when + 0.003);
        g.gain.exponentialRampToValueAtTime(0.0001, when + d);
        osc.connect(g); g.connect(out);
        osc.start(when); osc.stop(when + d + 0.05);
      }
    }
  }

  /* ---- UI 试听：用指定声部当前音色发一个短音（混音台挑音色用）---- */
  audition(part, at = null) {
    if (!this.built) return;
    const voice = this._voice(part);
    if (voice === 'off' || !this._audible(part)) return;
    const now = (Number.isFinite(at) ? at : this.ctx.currentTime) + 0.03;
    const low = part === 'heart' || part === 'drone';
    const freq = low ? midiToFreq(this._rootMidi() - 12) : this._degreeFreq(2, 1);
    const sustained = part === 'pad' || part === 'strings' || part === 'choir' || part === 'drone';
    const dur = sustained ? 1.3 : 0.7;
    this._play(part, voice, freq, now, { dur, amp: 0.09 });
    if (part === 'heart' && voice === 'heart') {
      this._heartbeatTone(this._applyOct(freq, 'heart') * 1.06, now + 0.18, 0.18, 'heart');
    }
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
      const freq = this._applyOct(this._degreeFreq(deg, baseOct), 'lead');
      const dur =
        type === 'endangered' ? 2.6 : type === 'stable' ? 2.0 : type === 'chaotic' ? 0.22 : 0.55;
      const peak = (type === 'extinct' ? 0.08 : 0.13) * (typeof strength === 'number' ? strength : 1);
      this._tone(freq, now + i * spacing, dur, clamp(peak, 0.02, 0.2), wave, 0.9, (i % 2 ? 6 : -5), 0, 'lead');
    });
    if (type === 'reproduction') {
      const ctx = this.ctx;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      const f0 = this._applyOct(this._degreeFreq(0, 0), 'lead');
      osc.frequency.setValueAtTime(f0, now);
      osc.frequency.exponentialRampToValueAtTime(f0 * 2, now + 0.8);
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.06, now + 0.08);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 1.1);
      osc.connect(g);
      g.connect(this._bus('lead'));
      osc.start(now);
      osc.stop(now + 1.2);
    }
  }

  dispose() {
    try {
      for (const d of this.drones) d.osc.stop();
      for (const a of this.airBed || []) a.src.stop();
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
