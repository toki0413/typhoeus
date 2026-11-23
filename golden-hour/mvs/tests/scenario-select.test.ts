import { describe, it, expect } from 'vitest';
import { SCENARIO_ENTRIES, resolveScenario } from '../src/app/scenarioSelect';

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

  it('入口表包含三个场景且映射固定', () => {
    expect(SCENARIO_ENTRIES).toEqual([
      { id: 'tutorial', label: '教学关', href: './' },
      { id: 'room', label: '单房间原型', href: './room.html' },
      { id: 'building', label: '建筑沙盒（实验）', href: './building.html' },
    ]);
  });

  it('大小写与多参数按原样处理', () => {
    expect(resolveScenario('?scenario=ROOM')).toBe('tutorial');
    expect(resolveScenario('?scenario=room&x=1')).toBe('room');
  });

  it('编码与空值安全回退', () => {
    expect(resolveScenario('?scenario=%20room')).toBe('tutorial');
    expect(resolveScenario('?scenario=')).toBe('tutorial');
    expect(resolveScenario('?scenario=%52OOM')).toBe('tutorial');
  });
});
