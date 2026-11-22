import type { SimState } from '../sim/types';
import { deriveAudioCues, EMPTY_SNAPSHOT, type AudioSnapshot } from './cues';
import { DEFAULT_SPATIAL, mixFromState, type AudioSpatial } from './mix';

export interface AudioEngine {
  unlock(muted: boolean): void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  setActive(active: boolean): void;
  setDoorMotion(rate: number): void;
  update(s: SimState, spatial?: AudioSpatial): void;
  record: () => MediaStream | null;
  level: () => number;
}

type AudioContextCtor = new () => AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const rand = (min: number, max: number): number => min + Math.random() * (max - min);

interface BurstOptions {
  duration: number;
  gain: number;
  filter: BiquadFilterType;
  freq: number;
  endFreq?: number;
  q?: number;
  pan?: number;
  comms?: boolean;
}

interface ToneOptions {
  type: OscillatorType;
  from: number;
  to: number;
  duration: number;
  gain: number;
  pan?: number;
  filterHz?: number;
  comms?: boolean;
}

export function createAudio(): AudioEngine {
  let ctx: AudioContext | null = null;
  let bus: GainNode | null = null;
  let duck: GainNode | null = null;
  let comms: GainNode | null = null;
  let muffle: BiquadFilterNode | null = null;
  let master: GainNode | null = null;
  let output: AudioNode | null = null;
  let analyser: AnalyserNode | null = null;
  let levelData: Float32Array<ArrayBuffer> | null = null;
  let fireGain: GainNode | null = null;
  let fireFilter: BiquadFilterNode | null = null;
  let firePanner: StereoPannerNode | null = null;
  let subGain: GainNode | null = null;
  let airGain: GainNode | null = null;
  let airFilter: BiquadFilterNode | null = null;
  let spatial: AudioSpatial = { ...DEFAULT_SPATIAL };

  let whiteBuffer: AudioBuffer | null = null;
  let brownBuffer: AudioBuffer | null = null;
  let pinkBuffer: AudioBuffer | null = null;

  let muted = false;
  let volume = 0.75;
  let active = false;
  let snapshot: AudioSnapshot = { ...EMPTY_SNAPSHOT };
  let muffleUntil = 0;

  let lastMixAt = -1;
  let nextCrackleAt = 0;
  let nextCreakAt = 0;
  let nextBeatAt = 0;
  let nextBreathAt = 0;
  let nextStepAt = 0;
  let nextSirenAt = 0;
  let nextAlarmAt = 0;
  let nextHingeAt = 0;
  let stepParity = 0;
  let breathParity = 0;

  function buildNoise(color: 'white' | 'brown' | 'pink'): AudioBuffer {
    const c = ctx!;
    const frames = Math.floor(c.sampleRate * 2.5);
    const buffer = c.createBuffer(1, frames, c.sampleRate);
    const data = buffer.getChannelData(0);

    if (color === 'white') {
      for (let i = 0; i < frames; i += 1) data[i] = Math.random() * 2 - 1;
      return buffer;
    }

    if (color === 'brown') {
      let last = 0;
      for (let i = 0; i < frames; i += 1) {
        last = (last + Math.random() * 0.08 - 0.04) * 0.995;
        data[i] = last;
      }
      return buffer;
    }

    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;
    let b4 = 0;
    let b5 = 0;
    let b6 = 0;
    for (let i = 0; i < frames; i += 1) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.969 * b2 + white * 0.153852;
      b3 = 0.8665 * b3 + white * 0.3104856;
      b4 = 0.55 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.016898;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
    }
    return buffer;
  }

  function buildImpulse(seconds: number, decay: number): AudioBuffer {
    const c = ctx!;
    const frames = Math.floor(c.sampleRate * seconds);
    const buffer = c.createBuffer(2, frames, c.sampleRate);
    for (let channel = 0; channel < 2; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < frames; i += 1) {
        const tail = Math.pow(1 - i / frames, decay);
        data[i] = (Math.random() * 2 - 1) * tail;
      }
    }
    return buffer;
  }

  function createPanner(value: number): StereoPannerNode | null {
    const c = ctx;
    if (!c || typeof c.createStereoPanner !== 'function') return null;
    const panner = c.createStereoPanner();
    panner.pan.value = clamp(value, -1, 1);
    return panner;
  }

  function route(node: AudioNode, pan = 0, toComms = false): void {
    const c = ctx;
    const target = toComms ? comms ?? bus : bus;
    if (!c || !target) return;
    if (pan !== 0 && typeof c.createStereoPanner === 'function') {
      const panner = c.createStereoPanner();
      panner.pan.value = clamp(pan, -1, 1);
      node.connect(panner);
      panner.connect(target);
      return;
    }
    node.connect(target);
  }

  function startBeds(): void {
    const c = ctx!;

    whiteBuffer ??= buildNoise('white');
    brownBuffer ??= buildNoise('brown');
    pinkBuffer ??= buildNoise('pink');

    const fire = c.createBufferSource();
    fire.buffer = brownBuffer;
    fire.loop = true;
    fireFilter = c.createBiquadFilter();
    fireFilter.type = 'lowpass';
    fireFilter.frequency.value = 320;
    fireFilter.Q.value = 0.7;
    fireGain = c.createGain();
    fireGain.gain.value = 0;
    fire.connect(fireFilter).connect(fireGain);
    firePanner = createPanner(spatial.firePan);
    if (firePanner) {
      fireGain.connect(firePanner);
      firePanner.connect(bus!);
    } else {
      fireGain.connect(bus!);
    }
    fire.start();

    const sub = c.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = 41;
    subGain = c.createGain();
    subGain.gain.value = 0;
    sub.connect(subGain);
    route(subGain, -0.18);
    sub.start();

    const air = c.createBufferSource();
    air.buffer = pinkBuffer;
    air.loop = true;
    airFilter = c.createBiquadFilter();
    airFilter.type = 'bandpass';
    airFilter.frequency.value = 520;
    airFilter.Q.value = 0.5;
    airGain = c.createGain();
    airGain.gain.value = 0;
    air.connect(airFilter).connect(airGain);
    route(airGain, 0.2);
    air.start();
  }

  function ensure(): boolean {
    if (ctx) return true;
    const Ctor = audioContextCtor();
    if (!Ctor) return false;

    let c: AudioContext;
    try {
      c = new Ctor();
    } catch {
      return false;
    }
    ctx = c;

    bus = c.createGain();
    bus.gain.value = 0;

    muffle = c.createBiquadFilter();
    muffle.type = 'lowpass';
    muffle.frequency.value = 16000;
    muffle.Q.value = 0.4;

    master = c.createGain();
    master.gain.value = muted ? 0 : volume * 1.8;

    const compressor = c.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 24;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.25;

    // 现场声先经过 duck，再进混响与低通；无线电走独立总线，烟再大也清楚。
    duck = c.createGain();
    duck.gain.value = 1;
    bus.connect(duck);
    duck.connect(muffle);

    comms = c.createGain();
    comms.gain.value = 1;
    comms.connect(master);

    muffle.connect(master);
    master.connect(compressor);
    compressor.connect(c.destination);

    output = compressor;
    analyser = c.createAnalyser();
    analyser.fftSize = 1024;
    compressor.connect(analyser);

    if (typeof c.createConvolver === 'function') {
      const convolver = c.createConvolver();
      convolver.buffer = buildImpulse(1.9, 2.4);
      const wet = c.createGain();
      wet.gain.value = 0.2;
      duck.connect(convolver);
      convolver.connect(wet);
      wet.connect(muffle);
    }

    startBeds();
    void c.resume().catch(() => undefined);
    return true;
  }

  function setParam(param: AudioParam | null | undefined, value: number, timeConstant = 0.2): void {
    if (!param || !ctx || !Number.isFinite(value)) return;
    param.setTargetAtTime(value, ctx.currentTime, timeConstant);
  }

  function burst(options: BurstOptions): void {
    const c = ctx;
    if (!c || !whiteBuffer) return;
    const now = c.currentTime + 0.001;
    const source = c.createBufferSource();
    source.buffer = whiteBuffer;

    const filter = c.createBiquadFilter();
    filter.type = options.filter;
    filter.frequency.setValueAtTime(Math.max(20, options.freq), now);
    if (options.endFreq) {
      filter.frequency.exponentialRampToValueAtTime(
        Math.max(20, options.endFreq),
        now + options.duration
      );
    }
    filter.Q.value = options.q ?? 0.7;

    const envelope = c.createGain();
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(Math.max(0.0002, options.gain), now + 0.006);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + options.duration);

    source.connect(filter).connect(envelope);
    route(envelope, options.pan ?? 0, options.comms ?? false);
    source.start(now, Math.random() * 1.2);
    source.stop(now + options.duration + 0.02);
  }

  function tone(options: ToneOptions): void {
    const c = ctx;
    if (!c) return;
    const now = c.currentTime + 0.001;
    const osc = c.createOscillator();
    osc.type = options.type;
    osc.frequency.setValueAtTime(Math.max(20, options.from), now);
    osc.frequency.exponentialRampToValueAtTime(
      Math.max(20, options.to),
      now + options.duration * 0.9
    );

    const envelope = c.createGain();
    const peak = now + Math.min(0.02, options.duration * 0.2);
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(Math.max(0.0002, options.gain), peak);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + options.duration);

    let tail: AudioNode = envelope;
    if (options.filterHz) {
      const filter = c.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = options.filterHz;
      envelope.connect(filter);
      tail = filter;
    }

    osc.connect(envelope);
    route(tail, options.pan ?? 0, options.comms ?? false);
    osc.start(now);
    osc.stop(now + options.duration + 0.02);
  }

  function playRadio(gain: number): void {
    burst({
      duration: 0.2,
      gain: 0.16 * gain,
      filter: 'bandpass',
      freq: 1350,
      q: 0.9,
      comms: true,
    });
    tone({
      type: 'square',
      from: 1900,
      to: 1500,
      duration: 0.05,
      gain: 0.025,
      filterHz: 3000,
      comms: true,
    });
  }

  function playArrive(): void {
    burst({
      duration: 0.24,
      gain: 0.05,
      filter: 'lowpass',
      freq: 260,
      endFreq: 120,
      pan: spatial.crewPan,
    });
    burst({
      duration: 0.55,
      gain: 0.02,
      filter: 'bandpass',
      freq: 610,
      endFreq: 460,
      q: 0.6,
      pan: spatial.crewPan,
    });
  }

  function duckAmbient(): void {
    if (!duck || !ctx) return;
    const now = ctx.currentTime;
    duck.gain.cancelScheduledValues(now);
    duck.gain.setTargetAtTime(0.62, now, 0.15);
    duck.gain.setTargetAtTime(1, now + 1.5, 0.5);
  }

  function playHinge(rate: number): void {
    if (!ctx || muted || !active || volume <= 0.001) return;
    const now = ctx.currentTime;
    if (now < nextHingeAt) return;
    nextHingeAt = now + rand(0.07, 0.13);

    const level = Math.min(0.02, 0.005 + rate * 0.05);
    tone({
      type: 'sawtooth',
      from: rand(150, 205),
      to: rand(92, 124),
      duration: rand(0.12, 0.2),
      gain: level,
      filterHz: 900,
      pan: spatial.doorPan,
    });
    if (Math.random() < 0.32) {
      burst({
        duration: 0.03,
        gain: Math.min(0.024, level * 1.2),
        filter: 'bandpass',
        freq: rand(1400, 2400),
        q: 1.6,
        pan: spatial.doorPan,
      });
    }
  }

  function playDoorCheck(): void {
    burst({
      duration: 0.2,
      gain: 0.05,
      filter: 'highpass',
      freq: 2600,
      pan: spatial.doorPan,
    });
    tone({
      type: 'sine',
      from: 190,
      to: 92,
      duration: 0.18,
      gain: 0.09,
      pan: spatial.doorPan,
    });
  }

  function playDoorWaitSafe(): void {
    tone({
      type: 'sine',
      from: 102,
      to: 68,
      duration: 0.65,
      gain: 0.035,
      filterHz: 480,
      pan: spatial.doorPan,
    });
    burst({ duration: 0.5, gain: 0.02, filter: 'lowpass', freq: 380, pan: spatial.doorPan });
  }

  function playDoorWaitFail(): void {
    tone({
      type: 'sine',
      from: 78,
      to: 40,
      duration: 0.5,
      gain: 0.2,
      pan: spatial.doorPan,
    });
    burst({ duration: 0.35, gain: 0.11, filter: 'lowpass', freq: 240, pan: spatial.doorPan });
  }

  function playDoorOpen(): void {
    tone({
      type: 'sawtooth',
      from: 195,
      to: 78,
      duration: 0.85,
      gain: 0.028,
      filterHz: 700,
      pan: spatial.doorPan,
    });
    const c = ctx;
    if (!c || !whiteBuffer) return;
    const now = c.currentTime + 0.001;
    const source = c.createBufferSource();
    source.buffer = whiteBuffer;
    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(260, now);
    filter.frequency.exponentialRampToValueAtTime(1700, now + 0.45);
    filter.frequency.exponentialRampToValueAtTime(420, now + 1.15);
    const envelope = c.createGain();
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(0.1, now + 0.12);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + 1.2);
    source.connect(filter).connect(envelope);
    route(envelope, spatial.doorPan);
    source.start(now, 0.2);
    source.stop(now + 1.25);
  }

  function playSuppress(): void {
    const c = ctx;
    if (!c || !whiteBuffer) return;
    const now = c.currentTime + 0.001;
    const source = c.createBufferSource();
    source.buffer = whiteBuffer;
    const filter = c.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1500;
    filter.Q.value = 0.6;
    const envelope = c.createGain();
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(0.17, now + 0.06);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + 1.3);

    const flutter = c.createOscillator();
    flutter.type = 'square';
    flutter.frequency.value = 16;
    const flutterGain = c.createGain();
    flutterGain.gain.value = 0.05;
    flutter.connect(flutterGain);
    flutterGain.connect(envelope.gain);
    flutter.start(now);
    flutter.stop(now + 1.3);

    source.connect(filter).connect(envelope);
    route(envelope, spatial.crewPan + 0.15);
    source.start(now, 0.4);
    source.stop(now + 1.32);

    burst({
      duration: 0.9,
      gain: 0.03,
      filter: 'highpass',
      freq: 4200,
      pan: spatial.crewPan + 0.15,
    });
  }

  function playIncident(): void {
    tone({
      type: 'triangle',
      from: 430,
      to: 430,
      duration: 0.1,
      gain: 0.045,
      filterHz: 1400,
      comms: true,
    });
    tone({
      type: 'triangle',
      from: 330,
      to: 330,
      duration: 0.12,
      gain: 0.04,
      filterHz: 1200,
      comms: true,
    });
  }

  function playResolve(): void {
    tone({ type: 'sine', from: 900, to: 880, duration: 0.06, gain: 0.03, comms: true });
    tone({ type: 'sine', from: 1250, to: 1200, duration: 0.07, gain: 0.025, comms: true });
  }

  function playIgnore(): void {
    tone({ type: 'sine', from: 240, to: 176, duration: 0.35, gain: 0.045, comms: true });
    burst({ duration: 0.12, gain: 0.04, filter: 'bandpass', freq: 900, q: 1.1, comms: true });
  }

  function playInjury(): void {
    tone({
      type: 'sine',
      from: 72,
      to: 26,
      duration: 0.8,
      gain: 0.42,
      pan: spatial.doorPan,
    });
    burst({
      duration: 0.55,
      gain: 0.26,
      filter: 'lowpass',
      freq: 420,
      endFreq: 110,
      pan: spatial.doorPan,
    });
    tone({ type: 'sine', from: 2860, to: 2740, duration: 2.4, gain: 0.028 });
    if (muffle && ctx) {
      muffleUntil = ctx.currentTime + 2.2;
      muffle.frequency.cancelScheduledValues(ctx.currentTime);
      muffle.frequency.setTargetAtTime(680, ctx.currentTime, 0.04);
    }
  }

  function playRescue(): void {
    tone({ type: 'triangle', from: 523, to: 523, duration: 0.18, gain: 0.035, comms: true });
    tone({ type: 'triangle', from: 659, to: 659, duration: 0.22, gain: 0.03, comms: true });
    burst({
      duration: 0.16,
      gain: 0.05,
      filter: 'bandpass',
      freq: 1400,
      q: 0.8,
      comms: true,
    });
  }

  function playLoss(): void {
    tone({ type: 'sine', from: 58, to: 26, duration: 1.5, gain: 0.14 });
    burst({ duration: 0.9, gain: 0.04, filter: 'lowpass', freq: 220 });
  }

  function playAlarm(): void {
    tone({ type: 'square', from: 880, to: 860, duration: 0.07, gain: 0.03, filterHz: 2200 });
    tone({ type: 'square', from: 880, to: 860, duration: 0.07, gain: 0.02, filterHz: 2200 });
  }

  function playHeartbeat(gain: number): void {
    const thump = (delay: number, level: number) => {
      const c = ctx;
      if (!c) return;
      const at = c.currentTime + delay;
      const osc = c.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(60, at);
      osc.frequency.exponentialRampToValueAtTime(38, at + 0.14);
      const envelope = c.createGain();
      envelope.gain.setValueAtTime(0.0001, at);
      envelope.gain.exponentialRampToValueAtTime(level, at + 0.015);
      envelope.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
      osc.connect(envelope);
      route(envelope, 0);
      osc.start(at);
      osc.stop(at + 0.18);
    };
    thump(0.001, 0.3 * gain);
    thump(0.18, 0.19 * gain);
  }

  function playCrackle(gain: number): void {
    const freq = rand(900, 2400);
    burst({
      duration: rand(0.035, 0.09),
      gain: gain * rand(0.03, 0.1),
      filter: 'highpass',
      freq,
      pan: spatial.firePan + rand(-0.45, 0.45),
    });
  }

  function playCreak(): void {
    tone({
      type: 'sine',
      from: rand(88, 132),
      to: rand(52, 74),
      duration: rand(0.7, 1.2),
      gain: 0.03,
      filterHz: 480,
      pan: rand(-0.4, 0.4),
    });
  }

  function playStep(): void {
    stepParity = 1 - stepParity;
    burst({
      duration: rand(0.12, 0.16),
      gain: 0.11,
      filter: 'lowpass',
      freq: stepParity ? 380 : 310,
      endFreq: 140,
      pan: spatial.crewPan + (stepParity ? 0.12 : -0.12),
    });
  }

  function playBreath(): void {
    breathParity = 1 - breathParity;
    burst({
      duration: 0.5,
      gain: 0.026,
      filter: 'bandpass',
      freq: breathParity ? 640 : 470,
      endFreq: breathParity ? 520 : 380,
      q: 0.6,
    });
  }

  function playSiren(): void {
    const c = ctx;
    if (!c) return;
    const now = c.currentTime + 0.001;
    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(660, now);
    osc.frequency.linearRampToValueAtTime(840, now + 1.2);
    osc.frequency.linearRampToValueAtTime(660, now + 2.4);

    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1200;

    const envelope = c.createGain();
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.linearRampToValueAtTime(0.024, now + 0.7);
    envelope.gain.setValueAtTime(0.024, now + 1.9);
    envelope.gain.linearRampToValueAtTime(0.0001, now + 3);

    osc.connect(filter).connect(envelope);
    route(envelope, -0.7);
    osc.start(now);
    osc.stop(now + 3.05);
  }

  function applyOutputGain(): void {
    if (!ctx || !master) return;
    master.gain.setTargetAtTime(muted ? 0 : volume * 1.8, ctx.currentTime, 0.08);
  }

  return {
    unlock(nextMuted: boolean) {
      muted = nextMuted;
      active = true;
      if (!ensure()) return;
      applyOutputGain();
      setParam(bus?.gain, 1, 0.3);

      const now = ctx!.currentTime;
      nextCrackleAt = now + 0.2;
      nextCreakAt = now + rand(3, 6);
      nextBeatAt = now + 0.6;
      nextBreathAt = now + 1;
      nextStepAt = now + 0.4;
      nextSirenAt = now + 4;
      nextAlarmAt = now;
      nextHingeAt = now;
    },

    setVolume(nextVolume: number) {
      volume = clamp(nextVolume, 0, 1);
      applyOutputGain();
    },

    setMuted(nextMuted: boolean) {
      muted = nextMuted;
      applyOutputGain();
    },

    setActive(nextActive: boolean) {
      active = nextActive;
      if (!ctx || !bus) return;
      bus.gain.setTargetAtTime(active ? 1 : 0, ctx.currentTime, 0.3);
    },

    setDoorMotion(rate: number) {
      playHinge(rate);
    },

    record() {
      if (!ctx || !output || typeof ctx.createMediaStreamDestination !== 'function') {
        return null;
      }
      const destination = ctx.createMediaStreamDestination();
      output.connect(destination);
      return destination.stream;
    },

    level() {
      if (!ctx || !analyser) return 0;
      levelData ??= new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(levelData);
      let sum = 0;
      for (const sample of levelData) sum += sample * sample;
      return Math.sqrt(sum / levelData.length);
    },

    update(s: SimState, nextSpatial?: AudioSpatial) {
      if (nextSpatial) spatial = nextSpatial;
      if (!ctx || !master) return;
      if (s.phase !== 'execute') {
        snapshot = { ...EMPTY_SNAPSHOT };
        return;
      }

      const now = ctx.currentTime;
      const mix = mixFromState(s);

      if (now - lastMixAt >= 0.1) {
        lastMixAt = now;
        setParam(fireGain?.gain, 0.065 + mix.fire * 0.18, 0.3);
        setParam(fireFilter?.frequency, 250 + mix.fire * 900, 0.3);
        setParam(firePanner?.pan ?? null, spatial.firePan, 0.6);
        setParam(subGain?.gain, 0.018 + mix.fire * 0.07, 0.35);
        setParam(airGain?.gain, 0.02 + mix.airGain * 0.045, 0.4);
        setParam(airFilter?.frequency, 400 + mix.airGain * 520, 0.4);
        // 受伤后短暂耳鸣：高频被压住，再慢慢恢复。
        const targetMuffle = now < muffleUntil ? Math.min(mix.muffleHz, 900) : mix.muffleHz;
        setParam(muffle?.frequency, targetMuffle, 0.25);
      }

      const { cues, snapshot: next } = deriveAudioCues(snapshot, s);
      snapshot = next;

      const audible = !muted && active && volume > 0.001;
      if (!audible) return;

      for (const cue of cues) {
        switch (cue.kind) {
          case 'radio':
            playRadio(cue.gain);
            duckAmbient();
            break;
          case 'arrive':
            playArrive();
            break;
          case 'door-check':
            playDoorCheck();
            break;
          case 'door-wait-safe':
            playDoorWaitSafe();
            break;
          case 'door-wait-fail':
            playDoorWaitFail();
            break;
          case 'door-open':
            playDoorOpen();
            break;
          case 'suppress':
            playSuppress();
            break;
          case 'incident':
            playIncident();
            break;
          case 'resolve':
            playResolve();
            break;
          case 'ignore':
            playIgnore();
            break;
          case 'injury':
            playInjury();
            break;
          case 'rescue':
            playRescue();
            break;
          case 'loss':
            playLoss();
            break;
          case 'heartbeat':
            playHeartbeat(cue.gain);
            nextBeatAt = now + 60 / mix.heartbeatBpm;
            break;
          case 'alarm':
            playAlarm();
            nextAlarmAt = now + 1;
            break;
        }
      }

      if (now >= nextCrackleAt) {
        playCrackle(mix.crackleGain);
        nextCrackleAt = now + rand(0.35, 1.4) / mix.crackleRate;
      }

      if (mix.fire > 0.18 && now >= nextCreakAt) {
        playCreak();
        nextCreakAt = now + rand(4.5, 9.5);
      }

      if (mix.severity >= 0.45 && now >= nextBeatAt) {
        playHeartbeat(0.55 + mix.severity * 0.45);
        nextBeatAt = now + 60 / mix.heartbeatBpm;
      }

      if (mix.severity > 0.06 && now >= nextBreathAt) {
        playBreath();
        nextBreathAt = now + mix.breathInterval * rand(0.9, 1.1);
      }

      if (mix.moving && now >= nextStepAt) {
        playStep();
        nextStepAt = now + mix.stepInterval * rand(0.9, 1.1);
      }

      if (mix.siren > 0.02 && now >= nextSirenAt) {
        playSiren();
        nextSirenAt = now + rand(10, 15);
      }

      if (mix.urgent && now >= nextAlarmAt) {
        playAlarm();
        nextAlarmAt = now + 1;
      }
    },
  };
}
