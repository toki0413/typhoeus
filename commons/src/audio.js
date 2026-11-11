// Sound layer: life state -> pentatonic, real-time sonification.
// Sound is the audible interface of the organism, not decoration.

import { SCALES } from './engines.js';
import { clamp } from './rng.js';

export function midiToFreq(m) {
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
    this._build();
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
    this.delay.delayTime.value = 0.34;
    this.delayFb = ctx.createGain();
    this.delayFb.gain.value = 0.26;
    this.delayFilter = ctx.createBiquadFilter();
    this.delayFilter.type = 'lowpass';
    this.delayFilter.frequency.value = 1600;
    this.delayWet = ctx.createGain();
    this.delayWet.gain.value = 0.22;
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

  updateMetrics(m) {
    this.metrics = m;
    if (!this.built || !this.enabled) return;
    const now = this.ctx.currentTime;
    const mapping = this.mapping || {};
    const density = clamp(m.density, 0, 1);
    const entropy = clamp(m.entropy, 0, 1);
    const activity = clamp(m.activity, 0, 1);
    this.tempoSmoothed = this.tempoSmoothed * 0.92 + (mapping.tempo ?? 0.5) * 0.08;

    const brightness = mapping.brightness ?? 0.55;
    const droneLevel = 0.012 + density * 0.32;
    this.droneGain.gain.setTargetAtTime(mapping.drone === false ? 0.0001 : droneLevel, now, 0.5);
    this.droneFilter.frequency.setTargetAtTime(
      260 + entropy * 2600 * (0.35 + brightness) + activity * 500,
      now,
      0.4,
    );
    this.lfo.frequency.setTargetAtTime(0.06 + density * 0.5, now, 0.6);
    this.delayWet.gain.setTargetAtTime(0.1 + clamp(m.diameterNorm, 0, 1) * 0.35, now, 0.8);
    this.delayFb.gain.setTargetAtTime(0.16 + clamp(1 - m.stability, 0, 1) * 0.28, now, 0.8);
    this.level = clamp(density * 0.5 + activity * 0.35 + entropy * 0.15, 0, 1);
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
    const bpm = 40 + this.tempoSmoothed * 70 + activity * 55;
    let beat = 60 / bpm / 2;
    if (m.type === 'chaotic') beat *= 1 + (Math.random() - 0.5) * 0.35;
    if (m.type === 'stable') beat *= 1.25;

    // after a background tab or long pause, do not replay the missed beats
    if (this.nextNote < now - 0.4) this.nextNote = now + 0.05;

    const strict = mapping.strictness ?? 0.7;
    while (this.nextNote < now + 0.12) {
      if (mapping.pulse !== false) this._scheduleNote(this.nextNote, m, strict);
      this.nextNote += beat;
    }
    this.level = clamp(this.level * 0.95 + (m.activity * 0.4 + m.density * 0.2) * 0.05, 0, 1);
  }

  _scheduleNote(when, m, strict) {
    const cell = this.birthQueue.shift();
    let degree;
    let octaveShift;
    let amp;
    if (cell) {
      degree = Math.floor(cell.x * 5) % 5;
      octaveShift = Math.floor((1 - cell.y) * (1 + strict * 2));
      amp = 0.1 + Math.random() * 0.05;
    } else {
      if (Math.random() > 0.18 + (1 - strict) * 0.4) return;
      const seed = this.noteCounter++;
      degree = (seed * 3 + Math.floor((m.period || 1) + m.entropy * 5)) % 5;
      octaveShift = (seed * 2) % 2;
      amp = 0.055 + m.density * 0.12;
    }
    const freq = this._degreeFreq(degree, octaveShift);
    const dur = m.type === 'stable' ? 1.5 : m.type === 'chaotic' ? 0.28 : 0.7;
    this._tone(freq, when, dur, amp, this.mapping.wave || 'triangle', 0.5);
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
