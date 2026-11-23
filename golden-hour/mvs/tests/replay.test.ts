import { describe, it, expect } from 'vitest';
import {
  hashFrames,
  replayScenario,
  type ReplayFrame,
  type ReplayInput,
} from '../src/sim/replay';
import { createBuildingScenario } from '../src/sim/spatial/scene';

const TARGET = 'room-202-F1';

/** 只抽取场序列，避免把时间戳等元数据混进差异比较。 */
function fields(frames: ReplayFrame[]): number[][] {
  return frames.map((f) => [f.fire, f.smoke, f.heat, f.oxygen]);
}

describe('种子回放', () => {
  it('同种子同输入回放完全一致', () => {
    const inputs: ReplayInput[] = [
      { at: 2, roomId: TARGET, kind: 'open-window' },
      { at: 5, roomId: TARGET, kind: 'open-door' },
    ];
    const a = replayScenario(createBuildingScenario(), inputs, 10, 0.5);
    const b = replayScenario(createBuildingScenario(), inputs, 10, 0.5);

    expect(a).toEqual(b);
    expect(hashFrames(a)).toBe(hashFrames(b));
  });

  it('同种子不同输入产生不同演化', () => {
    const opened = replayScenario(
      createBuildingScenario(),
      [{ at: 2, roomId: TARGET, kind: 'open-window' }],
      10,
      0.5
    );
    const idle = replayScenario(
      createBuildingScenario(),
      [{ at: 2, roomId: TARGET, kind: 'noop' }],
      10,
      0.5
    );

    expect(opened.length).toBe(idle.length);
    expect(hashFrames(opened)).not.toBe(hashFrames(idle));
    expect(fields(opened)).not.toEqual(fields(idle));
  });

  it('输入在指定时刻才生效', () => {
    const withBreak = replayScenario(
      createBuildingScenario(),
      [{ at: 4, roomId: TARGET, kind: 'break-window' }],
      8,
      0.5
    );
    const baseline = replayScenario(createBuildingScenario(), [], 8, 0.5);

    const before = withBreak.filter((f) => f.t < 4 - 1e-9);
    const beforeBase = baseline.filter((f) => f.t < 4 - 1e-9);
    expect(before.length).toBeGreaterThan(0);
    expect(before).toEqual(beforeBase);

    const after = withBreak.filter((f) => f.t > 4 + 1e-9);
    const afterBase = baseline.filter((f) => f.t > 4 + 1e-9);
    expect(after.length).toBeGreaterThan(0);
    expect(hashFrames(after)).not.toBe(hashFrames(afterBase));
  });

  it('采样节奏符合给定间隔', () => {
    const frames = replayScenario(createBuildingScenario(), [], 10, 1);

    expect(frames.length).toBeGreaterThanOrEqual(9);
    expect(frames.length).toBeLessThanOrEqual(11);
    expect(frames[0].t).toBeCloseTo(1, 5);
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i].t).toBeGreaterThanOrEqual(frames[i - 1].t);
    }
  });

  it('两次独立运行完全确定', () => {
    const inputs: ReplayInput[] = [
      { at: 1, roomId: TARGET, kind: 'open-door' },
      { at: 3, roomId: TARGET, kind: 'break-window' },
      { at: 6, roomId: TARGET, kind: 'open-window' },
    ];
    const a = replayScenario(createBuildingScenario(), inputs, 12, 0.25);
    const b = replayScenario(createBuildingScenario(), inputs, 12, 0.25);

    expect(a).toEqual(b);
    expect(hashFrames(a)).toBe(hashFrames(b));
    expect(fields(a)).toEqual(fields(b));
  });

  it('不存在的房间输入被安全跳过', () => {
    const skipped = replayScenario(
      createBuildingScenario(),
      [{ at: 2, roomId: 'room-missing', kind: 'open-door' }],
      6,
      0.5
    );
    const baseline = replayScenario(createBuildingScenario(), [], 6, 0.5);

    expect(skipped).toEqual(baseline);
  });
});
