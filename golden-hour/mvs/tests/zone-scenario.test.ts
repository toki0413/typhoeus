import { describe, it, expect } from 'vitest';
import { cellAt, roomSummary } from '../src/sim/spatial/fields';
import { LAYOUTS } from '../src/content/layouts';
import { createZoneScenario, stepScenario } from '../src/sim/spatial/scene';

describe('多区域场景', () => {
  it('每个户型生成 5 个区域，起点与目标正确', () => {
    for (const layout of LAYOUTS) {
      const def = createZoneScenario(
        layout.build(),
        layout.entrance,
        layout.zones,
        'z-' + layout.id,
        1
      );

      expect(def.zones).toHaveLength(5);
      expect(def.startRoom).toBe(layout.entrance);
      expect(def.targetRoom).toBe(layout.zones[0].roomId);
    }
  });

  it('只有声明火源的区域起火，且火类匹配', () => {
    for (const layout of LAYOUTS) {
      const def = createZoneScenario(
        layout.build(),
        layout.entrance,
        layout.zones,
        'z-' + layout.id,
        1
      );

      for (const zone of layout.zones) {
        const cells = def.building.rooms[zone.roomId].room.cells;
        if (zone.fire) {
          expect(cells.some((cell) => cell.fire > 0)).toBe(true);
          for (const cell of cells.filter((item) => item.fire > 0)) {
            expect(cell.fireClass).toBe(zone.fireClass);
          }
        } else {
          expect(cells.every((cell) => cell.fire === 0)).toBe(true);
        }
      }
    }
  });

  it('非区域房间保持无燃料无火', () => {
    for (const layout of LAYOUTS) {
      const def = createZoneScenario(
        layout.build(),
        layout.entrance,
        layout.zones,
        'z-' + layout.id,
        1
      );
      const zoneRooms = new Set(layout.zones.map((zone) => zone.roomId));

      for (const [roomId, node] of Object.entries(def.building.rooms)) {
        if (zoneRooms.has(roomId)) continue;
        expect(node.room.cells.every((cell) => cell.fuel === 0 && cell.fire === 0)).toBe(true);
      }
    }
  });

  it('推进 10 秒后火不跨房间跳跃，主火区产生烟', () => {
    for (const layout of LAYOUTS) {
      const def = createZoneScenario(
        layout.build(),
        layout.entrance,
        layout.zones,
        'z-' + layout.id,
        1
      );

      stepScenario(def, 10);

      for (const zone of layout.zones) {
        if (zone.fire) continue;
        const room = def.building.rooms[zone.roomId].room;
        expect(room.cells.every((cell) => cell.fire === 0)).toBe(true);
      }

      const mainRoom = def.building.rooms[layout.zones[0].roomId].room;
      expect(roomSummary(mainRoom).smoke).toBeGreaterThan(0);
    }
  });

  it('源格强度不低于 sourceIntensity 或 intensity+0.2', () => {
    for (const layout of LAYOUTS) {
      const def = createZoneScenario(
        layout.build(),
        layout.entrance,
        layout.zones,
        'z-' + layout.id,
        1
      );
      const zone = layout.zones[0];
      const fire = zone.fire!;
      const source = fire.source!;
      const sourceCell = cellAt(def.building.rooms[zone.roomId].room, source[0], source[1]);
      const expected = fire.sourceIntensity ?? fire.intensity + 0.2;

      expect(sourceCell.fire).toBeGreaterThanOrEqual(expected);
    }
  });

  it('空区域回退为单区域场景且不抛错', () => {
    for (const layout of LAYOUTS) {
      const def = createZoneScenario(layout.build(), layout.entrance, [], 'x', 1);

      expect(def.zones).toEqual([]);
      expect(def.targetRoom).toBe(layout.entrance);
    }
  });
});
