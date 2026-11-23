import { describe, it, expect } from 'vitest';
import {
  BRIEFING,
  RADIO_LINES,
  linesBetween,
  linesUpTo,
  type NarrativeLine,
} from '../src/content/narrative';

describe('叙事无线电', () => {
  it('开局简报说明 202 有人', () => {
    expect(BRIEFING.length).toBeGreaterThan(0);
    for (const line of BRIEFING) {
      expect(line.at).toBe(0);
    }

    const roles = new Set(BRIEFING.map((line) => line.role));
    expect(roles.has('dispatch')).toBe(true);
    expect(roles.has('neighbor') || roles.has('warden')).toBe(true);

    const text = BRIEFING.map((line) => line.text).join('');
    expect(text).toContain('202');
    expect(text).toContain('人');
  });

  it('无线电按时间升序，字段完整且角色多样', () => {
    expect(RADIO_LINES.length).toBeGreaterThan(0);
    for (let i = 0; i < RADIO_LINES.length; i++) {
      const line = RADIO_LINES[i];
      expect(line.at).toBeGreaterThan(0);
      expect(line.speaker.length).toBeGreaterThan(0);
      expect(line.text.length).toBeGreaterThan(0);
      if (i > 0) expect(line.at).toBeGreaterThan(RADIO_LINES[i - 1].at);
    }

    const roles = new Set(RADIO_LINES.map((line) => line.role));
    expect(roles.size).toBeGreaterThanOrEqual(2);
  });

  it('按时间取用到点提示，区间只含新触发', () => {
    const upTo8 = linesUpTo(RADIO_LINES, 8);
    expect(upTo8.some((line) => line.at === 8)).toBe(true);
    expect(upTo8.some((line) => line.at === 20)).toBe(false);

    const between = linesBetween(RADIO_LINES, 8, 20);
    expect(between).toHaveLength(1);
    expect(between[0].at).toBe(20);
  });

  it('辅助函数不修改原数组', () => {
    const snapshot = RADIO_LINES.map((line) => ({ ...line }));
    const length = RADIO_LINES.length;
    const first = RADIO_LINES[0];

    linesUpTo(RADIO_LINES, 20);
    linesBetween(RADIO_LINES, 8, 35);

    expect(RADIO_LINES).toHaveLength(length);
    expect(RADIO_LINES[0]).toBe(first);
    expect(RADIO_LINES).toEqual(snapshot);
  });
});
