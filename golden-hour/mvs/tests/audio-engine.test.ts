// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createWorld } from '../src/sim/world';
import { stepSim } from '../src/sim/step';
import { createAudio } from '../src/audio/engine';

class FakeParam {
  value = 0;

  setValueAtTime(): this {
    return this;
  }

  linearRampToValueAtTime(): this {
    return this;
  }

  exponentialRampToValueAtTime(): this {
    return this;
  }

  setTargetAtTime(): this {
    return this;
  }

  cancelScheduledValues(): this {
    return this;
  }
}

class FakeNode {
  connect<T>(target: T): T {
    return target;
  }

  disconnect(): void {}
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakeFilter extends FakeNode {
  type: BiquadFilterType = 'lowpass';
  frequency = new FakeParam();
  Q = new FakeParam();
}

class FakePanner extends FakeNode {
  pan = new FakeParam();
}

class FakeCompressor extends FakeNode {
  threshold = new FakeParam();
  knee = new FakeParam();
  ratio = new FakeParam();
  attack = new FakeParam();
  release = new FakeParam();
}

class FakeOscillator extends FakeNode {
  type: OscillatorType = 'sine';
  frequency = new FakeParam();
  start(): void {}
  stop(): void {}
}

class FakeBufferSource extends FakeNode {
  buffer: AudioBuffer | null = null;
  loop = false;
  start(): void {}
  stop(): void {}
}

class FakeConvolver extends FakeNode {
  buffer: AudioBuffer | null = null;
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];

  currentTime = 0;
  sampleRate = 8000;
  state: AudioContextState = 'running';
  destination = new FakeNode();
  oscillators = 0;

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createGain(): FakeGain {
    return new FakeGain();
  }

  createBiquadFilter(): FakeFilter {
    return new FakeFilter();
  }

  createStereoPanner(): FakePanner {
    return new FakePanner();
  }

  createDynamicsCompressor(): FakeCompressor {
    return new FakeCompressor();
  }

  createConvolver(): FakeConvolver {
    return new FakeConvolver();
  }

  createOscillator(): FakeOscillator {
    this.oscillators += 1;
    return new FakeOscillator();
  }

  createBufferSource(): FakeBufferSource {
    return new FakeBufferSource();
  }

  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer {
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      getChannelData: () => new Float32Array(length),
    } as unknown as AudioBuffer;
  }

  resume(): Promise<void> {
    return Promise.resolve();
  }

  suspend(): Promise<void> {
    return Promise.resolve();
  }
}

beforeEach(() => {
  FakeAudioContext.instances = [];
  Object.defineProperty(window, 'AudioContext', {
    value: FakeAudioContext,
    configurable: true,
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, 'AudioContext');
});

describe('音频引擎', () => {
  it('解锁后建立声场，推进模拟不抛错', () => {
    const audio = createAudio();
    audio.unlock(false);
    audio.setVolume(0.6);
    audio.setActive(true);

    expect(FakeAudioContext.instances).toHaveLength(1);
    const ctx = FakeAudioContext.instances[0];

    const s = createWorld('x');
    s.phase = 'execute';
    s.crew.order = { kind: 'search', floor: 1 };

    for (let i = 0; i < 160; i += 1) {
      stepSim(s, 0.05);
      ctx.currentTime += 0.05;
      audio.update(s);
    }

    expect(ctx.oscillators).toBeGreaterThan(0);
    expect(s.t).toBeGreaterThan(5);
  });

  it('接受 Three.js 传来的声像并播放门轴运动声', () => {
    const audio = createAudio();
    audio.unlock(false);
    audio.setActive(true);

    const s = createWorld('x');
    s.phase = 'execute';
    s.door.opened = true;

    expect(() => {
      audio.update(s, { firePan: 0.15, doorPan: -0.2, stairsPan: -0.6, crewPan: -0.3 });
      audio.setDoorMotion(9);
      audio.setDoorMotion(0);
    }).not.toThrow();
  });

  it('静音、调音量与暂停切换不影响后续推进', () => {
    const audio = createAudio();
    audio.unlock(true);
    audio.setVolume(0.2);
    audio.setMuted(false);
    audio.setActive(false);
    audio.setActive(true);

    const s = createWorld('x');
    s.phase = 'execute';
    s.t = 14;
    s.smoke[0] = 0.8;
    audio.update(s);
    expect(() => audio.update(s)).not.toThrow();
  });

  it('没有 Web Audio 时安全降级', () => {
    Reflect.deleteProperty(window, 'AudioContext');
    const audio = createAudio();
    expect(() => {
      audio.unlock(false);
      audio.update(createWorld('x'));
      audio.setActive(false);
    }).not.toThrow();
  });
});
