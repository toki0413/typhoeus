import { describe, it, expect } from 'vitest';
import { createWorld } from '../src/sim/world';
import { checkDoor, openDoor, waitDoor } from '../src/sim/door';
import { suppressFire } from '../src/sim/actions';
import { resolveIncident } from '../src/sim/incidents';
import {
  deriveAudioCues,
  EMPTY_SNAPSHOT,
  type AudioSnapshot,
} from '../src/audio/cues';

const has = (cues: Array<{ kind: string }>, kind: string): boolean =>
  cues.some((cue) => cue.kind === kind);

const snapshot = (overrides: Partial<AudioSnapshot>): AudioSnapshot => ({
  ...EMPTY_SNAPSHOT,
  ...overrides,
});

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

  it('到达门口时给出停步提示', () => {
    const s = createWorld('x');
    s.phase = 'execute';
    s.crew.atDoor = true;
    const result = deriveAudioCues(snapshot({ radioCount: 1 }), s);
    expect(has(result.cues, 'arrive')).toBe(true);

    const again = deriveAudioCues(result.snapshot, s);
    expect(has(again.cues, 'arrive')).toBe(false);
  });

  it('触门把会给出灼热提示', () => {
    const s = createWorld('x');
    checkDoor(s);
    const result = deriveAudioCues(snapshot({ radioCount: 1, events: 1 }), s);
    expect(has(result.cues, 'door-check')).toBe(true);
  });

  it('等待结束区分成功与失败', () => {
    const safe = createWorld('x');
    safe.door.checked = true;
    safe.door.safe = true;
    const safeResult = deriveAudioCues(
      snapshot({ radioCount: 1, doorChecked: true, doorWaiting: true }),
      safe
    );
    expect(has(safeResult.cues, 'door-wait-safe')).toBe(true);
    expect(has(safeResult.cues, 'door-wait-fail')).toBe(false);

    const failed = createWorld('x');
    const failResult = deriveAudioCues(
      snapshot({ radioCount: 1, doorWaiting: true }),
      failed
    );
    expect(has(failResult.cues, 'door-wait-fail')).toBe(true);
  });

  it('开门与灭火器压制各触发一次', () => {
    const s = createWorld('x');
    s.phase = 'execute';
    openDoor(s);
    const openResult = deriveAudioCues(snapshot({ radioCount: 1 }), s);
    expect(has(openResult.cues, 'door-open')).toBe(true);

    const extinguishing = createWorld('x');
    extinguishing.phase = 'execute';
    suppressFire(extinguishing);
    const suppressResult = deriveAudioCues(
      snapshot({ radioCount: 1, extinguishers: 2 }),
      extinguishing
    );
    expect(has(suppressResult.cues, 'suppress')).toBe(true);
  });

  it('回燃会同时触发受伤与失去被困者', () => {
    const s = createWorld('x');
    s.phase = 'execute';
    openDoor(s);
    const result = deriveAudioCues(snapshot({ radioCount: 1 }), s);
    expect(has(result.cues, 'injury')).toBe(true);
    expect(has(result.cues, 'loss')).toBe(true);
  });

  it('正确开门会触发救援提示', () => {
    const s = createWorld('x');
    s.phase = 'execute';
    checkDoor(s);
    s.door.safe = true;
    openDoor(s);
    const result = deriveAudioCues(snapshot({ radioCount: 1, events: 1 }), s);
    expect(has(result.cues, 'rescue')).toBe(true);
    expect(has(result.cues, 'injury')).toBe(false);
  });

  it('事件出现、处理与截止前警报各有提示', () => {
    const s = createWorld('x');
    s.t = 8;
    s.incidents[0].activatedAt = 8;

    const appear = deriveAudioCues(snapshot({ radioCount: 1 }), s);
    expect(has(appear.cues, 'incident')).toBe(true);

    resolveIncident(s, 'neighbor', 'coach');
    const resolved = deriveAudioCues(
      snapshot({ radioCount: 1, time: 8, activeIncident: 'neighbor' }),
      s
    );
    expect(has(resolved.cues, 'resolve')).toBe(true);

    const urgent = createWorld('x');
    urgent.t = 15;
    urgent.incidents[0].activatedAt = 8;
    const alarm = deriveAudioCues(
      snapshot({ radioCount: 1, time: 8, activeIncident: 'neighbor' }),
      urgent
    );
    expect(has(alarm.cues, 'alarm')).toBe(true);
  });

  it('忽略事件会用不同于确认的提示音', () => {
    const s = createWorld('x');
    s.t = 20;
    s.incidents[0].activatedAt = 8;
    resolveIncident(s, 'neighbor', 'ignore');

    const result = deriveAudioCues(
      snapshot({ radioCount: 1, time: 8, activeIncident: 'neighbor' }),
      s
    );
    expect(has(result.cues, 'ignore')).toBe(true);
    expect(has(result.cues, 'resolve')).toBe(false);
  });

  it('同种子重打会重置快照并重新播报开场无线电', () => {
    const s = createWorld('x');
    s.t = 0;
    const result = deriveAudioCues(
      snapshot({ time: 40, radioCount: 6, doorOpened: true, doorChecked: true }),
      s
    );
    expect(has(result.cues, 'radio')).toBe(true);
    expect(result.snapshot.radioCount).toBe(1);
    expect(result.snapshot.doorOpened).toBe(false);
  });

  it('所在楼层烟气过半后触发心跳', () => {
    const s = createWorld('x');
    s.phase = 'execute';
    s.smoke[0] = 0.62;
    const result = deriveAudioCues(snapshot({ radioCount: 1 }), s);
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

describe('等待动作', () => {
  it('waitDoor 会记录等待状态，供声音层判断', () => {
    const s = createWorld('x');
    waitDoor(s);
    expect(s.door.waitUntil).not.toBeNull();
  });
});
