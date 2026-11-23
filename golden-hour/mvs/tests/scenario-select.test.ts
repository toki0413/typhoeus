import { describe, it, expect } from 'vitest';
import { SCENARIOS, resolveScenario } from '../src/app/scenarioSelect';

describe('场景选择', () => {
  it('默认回退教学关', () => {
    expect(resolveScenario('')).toBe('tutorial');
    expect(resolveScenario('?foo=bar')).toBe('tutorial');
  });

  it('识别单房间与建筑沙盒', () => {
    expect(resolveScenario('?scenario=room')).toBe('room');
    expect(resolveScenario('?scenario=building')).toBe('building');
  });

  it('未知参数回退教学关', () => {
    expect(resolveScenario('?scenario=nope')).toBe('tutorial');
  });

  it('入口表包含三个场景且路径存在', () => {
    expect(SCENARIOS.map((entry) => entry.id)).toEqual([
      'tutorial',
      'room',
      'building',
    ]);
    const hrefs = SCENARIOS.map((entry) => entry.href);
    expect(hrefs).toContain('/');
    expect(hrefs).toContain('/room.html');
    expect(hrefs).toContain('/building.html');
  });
});
