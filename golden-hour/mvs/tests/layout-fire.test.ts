import { describe, it, expect } from 'vitest';
import {
  LAYOUTS,
  layoutById,
  layoutFireProfile,
} from '../src/content/layouts';
import { materialsByClass } from '../src/content/materials';
import { roomSummary } from '../src/sim/spatial/fields';
import { createScenarioForBuilding } from '../src/sim/spatial/scene';

describe('户型目标火类', () => {
  it('classic/narrow/courtyard/duplex 分别对应 A/F/B/E', () => {
    expect(layoutById('classic')?.targetFireClass).toBe('A');
    expect(layoutById('narrow')?.targetFireClass).toBe('F');
    expect(layoutById('courtyard')?.targetFireClass).toBe('B');
    expect(layoutById('duplex')?.targetFireClass).toBe('E');
  });

  it('火场剖面取该火类中产烟最高的材料', () => {
    for (const layout of LAYOUTS) {
      const material = materialsByClass(layout.targetFireClass).reduce((best, item) =>
        item.smokeYield > best.smokeYield ? item : best
      );
      const profile = layoutFireProfile(layout);

      expect(profile.fireClass).toBe(layout.targetFireClass);
      expect(profile.combustibility).toBe(material.combustibility);
      expect(profile.smokeYield).toBe(material.smokeYield);
    }
  });

  it('目标房间燃烧格使用户型火类，非目标房间无火', () => {
    for (const layout of LAYOUTS) {
      const def = createScenarioForBuilding(
        layout.build(),
        layout.entrance,
        layout.target,
        'layout-' + layout.id,
        1,
        layoutFireProfile(layout)
      );

      const burning = Object.values(def.building.rooms[layout.target].room.cells).filter(
        (cell) => cell.fire > 0
      );
      expect(burning.length).toBeGreaterThan(0);
      for (const cell of burning) {
        expect(cell.fireClass).toBe(layout.targetFireClass);
      }

      for (const [id, node] of Object.entries(def.building.rooms)) {
        if (id === layout.target) continue;
        expect(roomSummary(node.room).fire).toBe(0);
      }
    }
  });

  it('不传剖面时仍按 A 类默认点燃', () => {
    const layout = layoutById('narrow')!;
    const def = createScenarioForBuilding(
      layout.build(),
      layout.entrance,
      layout.target
    );
    const burning = Object.values(def.building.rooms[layout.target].room.cells).filter(
      (cell) => cell.fire > 0
    );

    expect(burning.length).toBeGreaterThan(0);
    for (const cell of burning) expect(cell.fireClass).toBe('A');
  });
});
