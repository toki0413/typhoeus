import { describe, it, expect } from 'vitest';
import {
  MAX_CARRY_WEIGHT,
  TOOL_CONDITION_FACTOR,
  canCarry,
  consumeTool,
  createToolLoadout,
  toolAvailable,
  toolWeight,
} from '../src/sim/interaction/tools';

describe('随身工具资源', () => {
  it('默认携带水带、灭火器、破拆斧、排烟机、热像仪', () => {
    const loadout = createToolLoadout();
    for (const id of ['hose', 'extinguisher', 'axe', 'fan', 'thermal'] as const) {
      expect(loadout[id].charge).toBe(1);
      expect(loadout[id].condition).toBe('ok');
      expect(toolAvailable(loadout, id)).toBe(true);
    }
    expect(loadout.ladder.charge).toBe(0);
    expect(loadout.rope.charge).toBe(0);
  });

  it('默认负重不超过上限', () => {
    const loadout = createToolLoadout();
    expect(toolWeight(loadout)).toBeLessThanOrEqual(MAX_CARRY_WEIGHT);
  });

  it('消耗到 0 后不可用，再消耗返回 false', () => {
    const loadout = createToolLoadout();
    expect(consumeTool(loadout, 'hose', 0.5)).toBe(true);
    expect(consumeTool(loadout, 'hose', 0.5)).toBe(true);
    expect(toolAvailable(loadout, 'hose')).toBe(false);

    expect(consumeTool(loadout, 'hose', 0.1)).toBe(false);
    expect(loadout.hose.condition).toBe('empty');
  });

  it('过期器材仍可用但效率打折', () => {
    const loadout = createToolLoadout();
    loadout.extinguisher.condition = 'expired';
    expect(toolAvailable(loadout, 'extinguisher')).toBe(true);
    expect(TOOL_CONDITION_FACTOR.expired).toBeLessThan(TOOL_CONDITION_FACTOR.ok);
  });

  it('破损器材完全不可用', () => {
    const loadout = createToolLoadout();
    loadout.fan.condition = 'broken';
    expect(toolAvailable(loadout, 'fan')).toBe(false);
    expect(consumeTool(loadout, 'fan', 0.1)).toBe(false);
  });

  it('负重已满时不能再带梯子', () => {
    const loadout = createToolLoadout();
    expect(canCarry(loadout, 'ladder')).toBe(false);
    expect(canCarry(loadout, 'rope')).toBe(true);
  });
});
