import { describe, it, expect } from 'vitest';
import {
  CARRY_CONDITION_FACTOR,
  MAX_CARRY_WEIGHT,
  canCarry,
  consumeTool,
  createToolLoadout,
  equipTool,
  gearLoad,
  toolAvailable,
  toolWeight,
  unequipTool,
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
    expect(CARRY_CONDITION_FACTOR.expired).toBeLessThan(CARRY_CONDITION_FACTOR.ok);
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

  it('可以装上绳索与梯子，卸下后归零', () => {
    const loadout = createToolLoadout();
    expect(equipTool(loadout, 'rope')).toBe(true);
    expect(loadout.rope.charge).toBe(1);
    expect(equipTool(loadout, 'ladder')).toBe(false);

    unequipTool(loadout, 'rope');
    expect(loadout.rope.charge).toBe(0);
    expect(loadout.rope.condition).toBe('empty');

    unequipTool(loadout, 'thermal');
    expect(loadout.thermal.charge).toBe(0);
    expect(equipTool(loadout, 'ladder')).toBe(true);
    expect(loadout.ladder.charge).toBe(1);
  });

  it('恰好到负重上限可以装备', () => {
    const loadout = createToolLoadout();
    unequipTool(loadout, 'thermal');
    expect(equipTool(loadout, 'ladder')).toBe(true);
    expect(toolWeight(loadout)).toBeCloseTo(MAX_CARRY_WEIGHT, 10);
  });

  it('超量消耗被拒绝', () => {
    const loadout = createToolLoadout();
    expect(consumeTool(loadout, 'hose', 0.5)).toBe(true);
    expect(consumeTool(loadout, 'hose', 0.6)).toBe(false);
    expect(loadout.hose.charge).toBe(0.5);
  });

  it('装备负重归一化到 0..1', () => {
    const loadout = createToolLoadout();
    expect(gearLoad(loadout)).toBeGreaterThan(0);
    expect(gearLoad(loadout)).toBeLessThanOrEqual(1);
    unequipTool(loadout, 'hose');
    expect(gearLoad(loadout)).toBeLessThan(1);
  });

  it('减压状态的器材效率下降但可用', () => {
    const loadout = createToolLoadout();
    loadout.extinguisher.condition = 'depressurized';
    expect(toolAvailable(loadout, 'extinguisher')).toBe(true);
    expect(CARRY_CONDITION_FACTOR.depressurized).toBeLessThan(1);
  });
});
