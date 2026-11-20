import type { SimState } from '../sim/types';
import { deriveAudioCues, EMPTY_SNAPSHOT, type AudioSnapshot } from './cues';

export interface AudioEngine {
  unlock(muted: boolean): void;
  setMuted(muted: boolean): void;
  setActive(active: boolean): void;
  update(s: SimState): void;
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

export function createAudio(): AudioEngine {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let rumbleGain: GainNode | null = null;
  let muted = false;
  let active = false;
  let snapshot: AudioSnapshot = { ...EMPTY_SNAPSHOT };
  let nextBeatAt = 0;

  function noiseBuffer(seconds: number): AudioBuffer {
    const c = ctx!;
    const frames = Math.max(1, Math.floor(c.sampleRate * seconds));
    const buffer = c.createBuffer(1, frames, c.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < frames; i += 1) {
      last = (last + Math.random() * 0.08 - 0.04) * 0.995;
      data[i] = last;
    }
    return buffer;
  }

  function startRumble(): void {
    const c = ctx!;
    const out = master!;

    rumbleGain = c.createGain();
    rumbleGain.gain.value = 0;
    rumbleGain.connect(out);

    const noise = c.createBufferSource();
    noise.buffer = noiseBuffer(3);
    noise.loop = true;

    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 150;

    noise.connect(filter).connect(rumbleGain);
    noise.start();

    const hum = c.createOscillator();
    hum.type = 'sine';
    hum.frequency.value = 44;
    const humGain = c.createGain();
    humGain.gain.value = 0.3;
    hum.connect(humGain).connect(rumbleGain);
    hum.start();
  }

  function playRadio(gain: number): void {
    const c = ctx!;
    const now = c.currentTime;
    const source = c.createBufferSource();
    source.buffer = noiseBuffer(0.25);

    const band = c.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 1300;
    band.Q.value = 0.8;

    const envelope = c.createGain();
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(0.12 * gain, now + 0.02);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);

    source.connect(band).connect(envelope).connect(master!);
    source.start(now);
    source.stop(now + 0.2);
  }

  function playDoor(gain: number): void {
    const c = ctx!;
    const now = c.currentTime;
    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(110, now);
    osc.frequency.exponentialRampToValueAtTime(38, now + 0.35);

    const envelope = c.createGain();
    envelope.gain.setValueAtTime(0.32 * gain, now);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);

    osc.connect(envelope).connect(master!);
    osc.start(now);
    osc.stop(now + 0.52);
  }

  function playHeartbeat(gain: number): void {
    const c = ctx!;
    const now = c.currentTime;

    const thump = (at: number, level: number) => {
      const osc = c.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(62, at);
      const envelope = c.createGain();
      envelope.gain.setValueAtTime(0.0001, at);
      envelope.gain.exponentialRampToValueAtTime(0.3 * level, at + 0.015);
      envelope.gain.exponentialRampToValueAtTime(0.0001, at + 0.14);
      osc.connect(envelope).connect(master!);
      osc.start(at);
      osc.stop(at + 0.16);
    };

    thump(now, gain);
    thump(now + 0.17, gain * 0.7);
  }

  function ensure(): boolean {
    if (ctx) return true;
    const Ctor = audioContextCtor();
    if (!Ctor) return false;

    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.8;
    master.connect(ctx.destination);
    startRumble();
    void ctx.resume().catch(() => undefined);
    return true;
  }

  return {
    unlock(nextMuted: boolean) {
      muted = nextMuted;
      active = true;
      if (ensure()) {
        master?.gain.setTargetAtTime(muted ? 0 : 0.8, ctx!.currentTime, 0.05);
        rumbleGain?.gain.setTargetAtTime(0.05, ctx!.currentTime, 0.3);
      }
    },

    setMuted(nextMuted: boolean) {
      muted = nextMuted;
      if (ctx && master) {
        master.gain.setTargetAtTime(muted ? 0 : 0.8, ctx.currentTime, 0.05);
      }
    },

    setActive(nextActive: boolean) {
      active = nextActive;
      if (ctx && rumbleGain) {
        rumbleGain.gain.setTargetAtTime(active ? 0.05 : 0, ctx.currentTime, 0.25);
      }
    },

    update(s: SimState) {
      if (!ctx || !master) return;
      if (s.phase !== 'execute') {
        snapshot = { ...EMPTY_SNAPSHOT };
        return;
      }

      const { cues, snapshot: next } = deriveAudioCues(snapshot, s);
      snapshot = next;
      if (muted) return;

      for (const cue of cues) {
        if (cue.kind === 'radio') playRadio(cue.gain);
        else if (cue.kind === 'door') playDoor(cue.gain);
        else playHeartbeat(cue.gain);
      }

      if (next.heartbeatOn && ctx.currentTime >= nextBeatAt) {
        playHeartbeat(0.8);
        nextBeatAt = ctx.currentTime + 1.1;
      }
    },
  };
}
