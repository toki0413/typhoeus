import { describe, it, expect } from 'vitest';
import { DRILLS } from '../src/content/drills';
import {
  coolDoor,
  createDrillSession,
  evaluateSession,
  measureDoor,
  openDoor,
  setLowStance,
  tickSession,
} from '../src/app/drillSession';

const DT = 0.1;

describe('演练会话入口', () => {
  it('未知 id 回退到第一条演练', () => {
    expect(createDrillSession('不存在').drill.id).toBe(DRILLS[0].id);
  });
});

describe('贴门测温', () => {
  it('测温后通过', () => {
    const session = createDrillSession('measure-door');
    measureDoor(session);
    expect(evaluateSession(session)).toEqual({ ok: true, reason: '完成' });
    expect(session.result).toEqual({ ok: true, reason: '完成' });
  });

  it('不测温时失败且不写入 result', () => {
    const session = createDrillSession('measure-door');
    const result = evaluateSession(session);
    expect(result.ok).toBe(false);
    expect(session.result).toBeNull();
  });
});

describe('回燃判断', () => {
  it('未冷却直接开门会回燃并判失败', () => {
    const session = createDrillSession('backdraft-watch');
    expect(session.room.backdraftAt).toBeNull();
    expect(openDoor(session)).toBe(true);
    expect(session.room.backdraftAt).not.toBeNull();
    const result = evaluateSession(session);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('回燃');
    expect(session.result).toBeNull();
  });

  it('冷却后开门不回燃且演练通过', () => {
    const session = createDrillSession('backdraft-watch');
    coolDoor(session);
    expect(session.progress.cooledDoor).toBe(true);
    expect(session.room.openings.door.wet).toBeGreaterThanOrEqual(0.4);
    expect(evaluateSession(session)).toEqual({ ok: true, reason: '完成' });
    expect(openDoor(session)).toBe(false);
  });
});

describe('低姿穿越', () => {
  it('低姿 2.9 秒失败，再 0.1 秒通过', () => {
    const session = createDrillSession('low-stance');
    setLowStance(session, true);
    for (let i = 0; i < 29; i++) tickSession(session, DT);
    expect(session.progress.lowStanceSeconds).toBeCloseTo(2.9, 5);
    expect(evaluateSession(session).ok).toBe(false);
    tickSession(session, DT);
    expect(session.progress.lowStanceSeconds).toBeCloseTo(3, 5);
    expect(evaluateSession(session)).toEqual({ ok: true, reason: '完成' });
  });

  it('未按低姿时不累加', () => {
    const session = createDrillSession('low-stance');
    setLowStance(session, false);
    tickSession(session, DT);
    expect(session.progress.lowStanceSeconds).toBe(0);
    expect(session.elapsed).toBeCloseTo(DT, 5);
  });

  it('非法 dt 不改变任何计时', () => {
    const session = createDrillSession('low-stance');
    setLowStance(session, true);
    tickSession(session, Number.NaN);
    tickSession(session, -1);
    expect(session.progress.lowStanceSeconds).toBe(0);
    expect(session.elapsed).toBe(0);
  });
});

describe('结束后状态冻结', () => {
  it('result 写入后动作不再改变状态', () => {
    const session = createDrillSession('measure-door');
    measureDoor(session);
    evaluateSession(session);
    expect(session.result).not.toBeNull();

    const before = JSON.stringify(session);
    measureDoor(session);
    coolDoor(session);
    expect(openDoor(session)).toBe(false);
    setLowStance(session, true);
    tickSession(session, DT);
    expect(JSON.stringify(session)).toBe(before);
  });
});
