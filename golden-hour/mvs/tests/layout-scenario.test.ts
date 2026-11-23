import { describe, it, expect } from 'vitest';
import { roomSummary } from '../src/sim/spatial/fields';
import { LAYOUTS } from '../src/content/layouts';
import {
  createBuildingScenario,
  createScenarioForBuilding,
  stepScenario,
} from '../src/sim/spatial/scene';
import type { ScenarioDefinition } from '../src/sim/spatial/scene';

/** 统计除目标房间外所有房间的总火强度。 */
function fireOutsideTarget(def: ScenarioDefinition): number {
  let total = 0;
  for (const [id, node] of Object.entries(def.building.rooms)) {
    if (id === def.targetRoom) continue;
    total += roomSummary(node.room).fire;
  }
  return total;
}

describe('户型场景接入', () => {
  it('每个户型都以入口出发、只点燃目标房间', () => {
    for (const layout of LAYOUTS) {
      const def = createScenarioForBuilding(
        layout.build(),
        layout.entrance,
        layout.target
      );

      expect(def.startRoom).toBe(layout.entrance);
      expect(def.targetRoom).toBe(layout.target);

      for (const [id, node] of Object.entries(def.building.rooms)) {
        const summary = roomSummary(node.room);
        if (id === layout.target) {
          expect(summary.fire).toBeGreaterThan(0);
        } else {
          expect(summary.fire).toBe(0);
        }
      }
    }
  });

  it('推进 5 步后火仍不跨房间跳跃', () => {
    for (const layout of LAYOUTS) {
      const def = createScenarioForBuilding(
        layout.build(),
        layout.entrance,
        layout.target
      );

      stepScenario(def, 5);

      expect(roomSummary(def.building.rooms[layout.target].room).fire).toBeGreaterThan(0);
      expect(fireOutsideTarget(def)).toBe(0);
    }
  });

  it('默认场景仍从 entrance 前往 room-202-F1', () => {
    const def = createBuildingScenario();

    expect(def.startRoom).toBe('entrance');
    expect(def.targetRoom).toBe('room-202-F1');
  });
});
