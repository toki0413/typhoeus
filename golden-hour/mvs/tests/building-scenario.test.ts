import { describe, it, expect } from 'vitest';
import { roomSummary } from '../src/sim/spatial/fields';
import {
  createBuildingScenario,
  snapshotScenario,
  stepScenario,
} from '../src/sim/spatial/scene';
import { createActor } from '../src/sim/spatial/actor';
import { createOccupant } from '../src/sim/spatial/rescue';
import { findRoutes } from '../src/sim/nav/graph';

describe('建筑场景', () => {
  it('只有 202-F1 初始起火', () => {
    const def = createBuildingScenario();
    for (const [id, node] of Object.entries(def.building.rooms)) {
      const summary = roomSummary(node.room);
      if (id === 'room-202-F1') {
        expect(summary.fire).toBeGreaterThan(0.01);
      } else {
        expect(summary.fire).toBe(0);
      }
    }
  });

  it('推进 60 秒后只有 202-F1 有烟与热', () => {
    const def = createBuildingScenario();
    for (let i = 0; i < 600; i++) stepScenario(def, 0.1);

    for (const [id, node] of Object.entries(def.building.rooms)) {
      const summary = roomSummary(node.room);
      if (id === 'room-202-F1') {
        expect(summary.smoke).toBeGreaterThan(0.1);
        expect(summary.heat).toBeGreaterThan(0.05);
      } else {
        expect(summary.smoke).toBe(0);
        expect(summary.heat).toBeLessThanOrEqual(0.05);
      }
    }
  });

  it('同一场景推进结果确定', () => {
    const a = createBuildingScenario();
    const b = createBuildingScenario();
    for (let i = 0; i < 600; i++) {
      stepScenario(a, 0.1);
      stepScenario(b, 0.1);
    }
    const cellsA = a.building.rooms['room-202-F1'].room.cells.map((c) => c.fire);
    const cellsB = b.building.rooms['room-202-F1'].room.cells.map((c) => c.fire);
    expect(cellsA).toEqual(cellsB);
  });

  it('入口到 202 有三条耗时不同的路线', () => {
    const def = createBuildingScenario();
    const routes = findRoutes(
      def.building,
      def.startRoom,
      def.targetRoom,
      createActor(),
      3
    );
    expect(routes.length).toBe(3);
    expect(new Set(routes.map((r) => r.time)).size).toBe(3);
  });

  it('楼梯坍塌后仍有非楼梯路线', () => {
    const def = createBuildingScenario();
    for (const link of def.building.links) {
      if (link.kind === 'stair') link.blocked = true;
    }
    const routes = findRoutes(
      def.building,
      def.startRoom,
      def.targetRoom,
      createActor(),
      3
    );
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.every((r) => r.steps.every((s) => s.kind !== 'stair'))).toBe(true);
  });

  it('快照包含当前房间、目标房间与居民', () => {
    const def = createBuildingScenario();
    const actor = createActor();
    const occupant = createOccupant();
    const snap = snapshotScenario(def, 'entrance', actor, occupant);

    expect(snap.roomId).toBe('entrance');
    expect(snap.rooms['room-202-F1'].fire).toBeGreaterThan(0);
    expect(snap.rooms['entrance'].smoke).toBe(0);
    expect(snap.occupant.id).toBe('resident-202');
    expect(snap.actor).toBe(actor);
  });
});
