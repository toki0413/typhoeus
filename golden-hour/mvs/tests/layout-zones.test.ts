import { describe, it, expect } from 'vitest';
import { LAYOUTS, validateLayout } from '../src/content/layouts';

describe('区域内容', () => {
  it('每个户型恰好 5 个区域、每区 2 名居民，共 10 人', () => {
    for (const layout of LAYOUTS) {
      expect(layout.zones).toHaveLength(5);
      for (const zone of layout.zones) {
        expect(zone.residents).toHaveLength(2);
      }
      expect(layout.zones.flatMap((zone) => zone.residents)).toHaveLength(10);
    }
  });

  it('第一个区域就是目标房间，且火类与 targetFireClass 一致', () => {
    for (const layout of LAYOUTS) {
      expect(layout.zones[0].roomId).toBe(layout.target);
      expect(layout.zones[0].fireClass).toBe(layout.targetFireClass);
    }
  });

  it('区域房间存在、不重复，且都能从入口走到', () => {
    for (const layout of LAYOUTS) {
      const graph = layout.build();
      const roomIds = layout.zones.map((zone) => zone.roomId);

      expect(new Set(roomIds).size).toBe(roomIds.length);
      for (const roomId of roomIds) {
        expect(graph.rooms[roomId]).toBeDefined();
      }

      expect(validateLayout(graph, layout.entrance)).toEqual([]);
    }
  });

  it('居民坐标在 0..7，id 唯一，每区恰好 1 名躲藏者', () => {
    for (const layout of LAYOUTS) {
      const ids = layout.zones.flatMap((zone) => zone.residents.map((item) => item.id));
      expect(new Set(ids).size).toBe(ids.length);

      for (const zone of layout.zones) {
        expect(zone.residents.filter((item) => item.hidden)).toHaveLength(1);
        for (const item of zone.residents) {
          expect(item.x).toBeGreaterThanOrEqual(0);
          expect(item.x).toBeLessThanOrEqual(7);
          expect(item.y).toBeGreaterThanOrEqual(0);
          expect(item.y).toBeLessThanOrEqual(7);
        }
      }
    }
  });

  it('只有第一个区域带初始火，其余区域只承受串烟', () => {
    for (const layout of LAYOUTS) {
      expect(layout.zones[0].fire).toBeDefined();
      for (const zone of layout.zones.slice(1)) {
        expect(zone.fire).toBeUndefined();
      }
    }
  });
});
