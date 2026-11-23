import { describe, it, expect } from 'vitest';
import { cellAt, createRoom } from '../src/sim/spatial/fields';
import {
  FIRE_CLASSES,
  MATERIALS,
  applyMaterial,
  coverageByClass,
  materialsByClass,
  type Material,
} from '../src/content/materials';

describe('Phase 5 · P5.1 材料表', () => {
  it('恰好 6 个火类，且每类至少有一种材料', () => {
    expect(FIRE_CLASSES).toHaveLength(6);
    expect(new Set(FIRE_CLASSES).size).toBe(6);
    const coverage = coverageByClass();
    for (const fireClass of FIRE_CLASSES) {
      expect(coverage[fireClass]).toBeGreaterThanOrEqual(1);
    }
  });

  it('材料数量、id、数值 range 与 label 都符合约定', () => {
    expect(MATERIALS.length).toBeGreaterThanOrEqual(8);
    expect(new Set(MATERIALS.map((material) => material.id)).size).toBe(MATERIALS.length);
    for (const material of MATERIALS) {
      expect(material.label.trim().length).toBeGreaterThan(0);
      for (const value of [
        material.combustibility,
        material.smokeYield,
        material.strength,
      ]) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it('materialsByClass 只返回对应火类，F 类至少一条', () => {
    const oils = materialsByClass('F');
    expect(oils.length).toBeGreaterThanOrEqual(1);
    expect(oils.every((material) => material.fireClass === 'F')).toBe(true);
  });

  it('applyMaterial 只写三项属性，不动运行期场量', () => {
    const room = createRoom();
    const cell = cellAt(room, 0, 0);
    cell.fuel = 0.42;
    cell.fire = 0.33;
    cell.heat = 0.27;
    cell.smoke = 0.19;
    cell.oxygen = 0.61;

    const material: Material = MATERIALS.find((item) => item.id === 'gasoline')!;
    applyMaterial(cell, material);

    expect(cell.combustibility).toBe(material.combustibility);
    expect(cell.smokeYield).toBe(material.smokeYield);
    expect(cell.fireClass).toBe('B');
    expect(cell.fuel).toBe(0.42);
    expect(cell.fire).toBe(0.33);
    expect(cell.heat).toBe(0.27);
    expect(cell.smoke).toBe(0.19);
    expect(cell.oxygen).toBe(0.61);
  });

  it('每个火类都能在材料表里找到', () => {
    expect(
      FIRE_CLASSES.every((fireClass) =>
        MATERIALS.some((material) => material.fireClass === fireClass)
      )
    ).toBe(true);
  });
});
