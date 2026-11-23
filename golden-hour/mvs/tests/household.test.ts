import { describe, it, expect } from 'vitest';
import { layoutById } from '../src/content/layouts';
import { gridToWorld } from '../src/sim/spatial/coords';
import {
  createHousehold,
  householdSummary,
  stepHousehold,
  type HouseholdState,
} from '../src/sim/agents/household';

const layout = layoutById('classic')!;

/** 户型的三个区域；用例只读使用。 */
function classicZones() {
  return layout.zones;
}

/** 清空全楼烟热与火，再按用例逐格设定。 */
function clearBuilding() {
  const graph = layout.build();
  for (const node of Object.values(graph.rooms)) {
    for (const cell of node.room.cells) {
      cell.smoke = 0;
      cell.heat = 0;
      cell.fire = 0;
      cell.fuel = 0;
      cell.steam = 0;
    }
  }
  return graph;
}

/** 把某区域全部居民标记为已获救，并同步 crowd 计数。 */
function rescueZone(household: HouseholdState, roomId: string): void {
  const crowd = household.crowds[roomId];
  for (const resident of crowd.residents) resident.rescued = true;
  crowd.rescued = crowd.residents.length;
}

describe('多区域人群', () => {
  it('按区域创建人群：每区 2 人、躲藏与坐标来自内容', () => {
    const zones = classicZones();
    const household = createHousehold(zones, 5);

    expect(Object.keys(household.crowds)).toHaveLength(3);
    expect(household.activeRoomId).toBe(zones[0].roomId);
    expect(household.events).toEqual([]);

    for (const zone of zones) {
      const crowd = household.crowds[zone.roomId];
      expect(crowd.roomId).toBe(zone.roomId);
      expect(crowd.residents).toHaveLength(2);

      for (let i = 0; i < zone.residents.length; i++) {
        const spec = zone.residents[i];
        const resident = crowd.residents[i];
        const world = gridToWorld(spec.x, spec.y);
        expect(resident.id).toBe(spec.id);
        expect(resident.roomId).toBe(zone.roomId);
        expect(resident.x).toBe(world.x);
        expect(resident.z).toBe(world.z);
        expect(resident.hidden).toBe(spec.hidden);
      }
    }
  });

  it('每支人群只推进自己房间：烟只影响对应区域居民', () => {
    const household = createHousehold(classicZones(), 3);
    const graph = clearBuilding();
    const [first, second] = household.zones;

    for (const cell of graph.rooms[first.roomId].room.cells) cell.smoke = 0.8;

    for (let i = 0; i < 10; i++) stepHousehold(household, graph, 0.5);

    for (let i = 0; i < first.residents.length; i++) {
      const exposed = household.crowds[first.roomId].residents[i];
      const safe = household.crowds[second.roomId].residents[i];
      expect(exposed.health).toBeLessThan(safe.health - 0.1);
    }
  });

  it('区域完成：写 zone-done 事件并切到下一区', () => {
    const household = createHousehold(classicZones(), 7);
    const graph = clearBuilding();
    const [first, second] = household.zones;

    rescueZone(household, first.roomId);
    stepHousehold(household, graph, 0.5);

    const done = household.events.filter(
      (event) => event.kind === 'zone-done' && event.roomId === first.roomId
    );
    expect(done).toHaveLength(1);
    expect(done[0].detail).toBe(`${first.label} 已处理完`);
    expect(household.activeRoomId).toBe(second.roomId);
    expect(householdSummary(household).done).toBe(1);
  });

  it('全部完成：active 归空，统计 6 人全获救', () => {
    const household = createHousehold(classicZones(), 9);
    const graph = clearBuilding();

    for (const zone of household.zones) rescueZone(household, zone.roomId);
    stepHousehold(household, graph, 0.5);

    expect(household.activeRoomId).toBeNull();
    expect(householdSummary(household)).toEqual({ rescued: 6, lost: 0, total: 6, done: 3 });
  });

  it('同种子同推进序列得到完全一致的健康值', () => {
    const run = () => {
      const household = createHousehold(classicZones(), 11);
      const graph = clearBuilding();
      for (const cell of graph.rooms[household.zones[0].roomId].room.cells) cell.smoke = 0.6;
      for (let i = 0; i < 10; i++) stepHousehold(household, graph, 0.5);
      return household.zones.map((zone) =>
        household.crowds[zone.roomId].residents.map((resident) => resident.health)
      );
    };

    expect(run()).toEqual(run());
  });

  it('NaN dt 不推进时间也不产生事件', () => {
    const household = createHousehold(classicZones(), 2);
    const graph = clearBuilding();
    const before = household.zones.map((zone) => household.crowds[zone.roomId].t);

    stepHousehold(household, graph, Number.NaN);

    expect(household.zones.map((zone) => household.crowds[zone.roomId].t)).toEqual(before);
    expect(household.events).toHaveLength(0);
  });
});
