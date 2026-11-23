import { describe, it, expect } from 'vitest';
import { LAYOUTS } from '../src/content/layouts';
import { createZoneScenario } from '../src/sim/spatial/scene';
import { createActor } from '../src/sim/spatial/actor';
import { findRoutes } from '../src/sim/nav/graph';
import {
  createHousehold,
  householdSummary,
  stepHousehold,
} from '../src/sim/agents/household';

describe('撤离阶段前提', () => {
  it('每个区域的房间都能走回入口，提供撤离路线', () => {
    for (const layout of LAYOUTS) {
      const graph = layout.build();
      const actor = createActor();

      for (const zone of layout.zones) {
        const routes = findRoutes(graph, zone.roomId, layout.entrance, actor, 1);
        expect(routes.length).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('全部区域完成后 activeRoomId 归空，为撤离阶段提供前提', () => {
    for (const layout of LAYOUTS) {
      const def = createZoneScenario(
        layout.build(),
        layout.entrance,
        layout.zones,
        'evac-' + layout.id,
        1
      );
      const household = createHousehold(layout.zones, 1);

      for (const zone of household.zones) {
        const crowd = household.crowds[zone.roomId];
        for (const resident of crowd.residents) resident.rescued = true;
        crowd.rescued = crowd.residents.length;
      }

      stepHousehold(household, def.building, 0.1);

      expect(household.activeRoomId).toBeNull();
      expect(householdSummary(household).done).toBe(household.zones.length);
    }
  });
});
