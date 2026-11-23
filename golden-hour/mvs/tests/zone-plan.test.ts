import { describe, it, expect } from 'vitest';
import { layoutById } from '../src/content/layouts';
import { createHousehold, stepHousehold, type HouseholdState } from '../src/sim/agents/household';
import { nextZoneId, runPhase, zoneLabel, zoneStatuses } from '../src/app/zonePlan';

const layout = layoutById('classic')!;

function setup(): HouseholdState {
  return createHousehold(layout.zones, 4);
}

/** 把某区域居民与计数一起标记为已获救。 */
function rescueZone(household: HouseholdState, roomId: string): void {
  const crowd = household.crowds[roomId];
  for (const resident of crowd.residents) resident.rescued = true;
  crowd.rescued = crowd.residents.length;
}

describe('区域目标规划', () => {
  it('初始：首个区域进行中，其余待处理', () => {
    const household = setup();
    const [first] = household.zones;

    expect(household.zones).toHaveLength(5);
    expect(zoneStatuses(household)).toEqual(
      Object.fromEntries(
        household.zones.map((zone, index) => [zone.roomId, index === 0 ? 'active' : 'pending'])
      )
    );
    expect(nextZoneId(household)).toBe(first.roomId);
  });

  it('完成首区后切换到第二区，状态同步更新', () => {
    const household = setup();
    const graph = layout.build();
    const [first, second] = household.zones;

    rescueZone(household, first.roomId);
    stepHousehold(household, graph, 0.5);

    expect(zoneStatuses(household)).toEqual(
      Object.fromEntries(
        household.zones.map((zone, index) => [zone.roomId, index <= 0 ? 'done' : index === 1 ? 'active' : 'pending'])
      )
    );
    expect(nextZoneId(household)).toBe(second.roomId);
  });

  it('全部完成后没有下一区域，状态全为 done', () => {
    const household = setup();
    const graph = layout.build();

    for (const zone of household.zones) rescueZone(household, zone.roomId);
    stepHousehold(household, graph, 0.5);

    expect(nextZoneId(household)).toBeNull();
    for (const status of Object.values(zoneStatuses(household))) {
      expect(status).toBe('done');
    }
  });

  it('zoneLabel 命中区域名，未知房间回退 roomId', () => {
    const household = setup();
    const first = household.zones[0];

    expect(zoneLabel(household, first.roomId)).toBe(first.label);
    expect(zoneLabel(household, 'room-not-exist')).toBe('room-not-exist');
  });

  it('runPhase：未完成始终搜救；完成后按是否到出口区分', () => {
    expect(runPhase(false, false)).toBe('rescue');
    expect(runPhase(true, false)).toBe('evacuate');
    expect(runPhase(true, true)).toBe('done');
  });
});
