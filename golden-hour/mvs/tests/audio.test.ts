import { describe, it, expect } from 'vitest';
import { createWorld } from '../src/sim/world';
import { openDoor } from '../src/sim/door';
import { deriveAudioCues, EMPTY_SNAPSHOT, type AudioSnapshot } from '../src/audio/cues';

const has = (cues: Array<{ kind: string }>, kind: string): boolean =>
  cues.some((cue) => cue.kind === kind);

describe('声音提示映射', () => {
  it('开场无线电消息触发提示音', () => {
    const s = createWorld('x');
    const result = deriveAudioCues(EMPTY_SNAPSHOT, s);
    expect(has(result.cues, 'radio')).toBe(true);
    expect(result.snapshot.radioCount).toBe(1);
  });

  it('同一条无线电消息不会重复触发', () => {
    const s = createWorld('x');
    const first = deriveAudioCues(EMPTY_SNAPSHOT, s);
    s.t = 2;
    expect(has(deriveAudioCues(first.snapshot, s).cues, 'radio')).toBe(false);

    s.t = 4;
    const second = deriveAudioCues(first.snapshot, s);
    expect(has(second.cues, 'radio')).toBe(true);

    s.t = 5;
    expect(has(deriveAudioCues(second.snapshot, s).cues, 'radio')).toBe(false);
  });

  it('开门只触发一次闷响', () => {
    const s = createWorld('x');
    s.phase = 'execute';
    openDoor(s);
    const result = deriveAudioCues(EMPTY_SNAPSHOT, s);
    expect(has(result.cues, 'door')).toBe(true);

    const again = deriveAudioCues(
      { ...EMPTY_SNAPSHOT, radioCount: result.snapshot.radioCount, doorOpened: true } as AudioSnapshot,
      s
    );
    expect(has(again.cues, 'door')).toBe(false);
  });

  it('所在楼层烟气过半后触发心跳', () => {
    const s = createWorld('x');
    s.phase = 'execute';
    s.smoke[0] = 0.62;
    const result = deriveAudioCues(EMPTY_SNAPSHOT, s);
    expect(has(result.cues, 'heartbeat')).toBe(true);
    expect(result.snapshot.heartbeatOn).toBe(true);
  });

  it('规划阶段不触发心跳', () => {
    const s = createWorld('x');
    s.smoke[0] = 0.9;
    const result = deriveAudioCues(EMPTY_SNAPSHOT, s);
    expect(result.snapshot.heartbeatOn).toBe(false);
  });
});
