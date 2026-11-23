import { describe, it, expect } from 'vitest';
import { stepLinkSmoke } from '../src/sim/spatial/ventilation';
import { roomSummary, type RoomState } from '../src/sim/spatial/fields';
import type { BuildingGraph, RoomLink } from '../src/sim/spatial/rooms';
import { createBuildingScenario } from '../src/sim/spatial/scene';
import type { Wind } from '../src/sim/events/director';

const DT = 0.1;

/** 清空全楼的烟，用例再逐格设定，避免依赖场景默认状态。 */
function clearSmoke(graph: BuildingGraph): void {
  for (const node of Object.values(graph.rooms)) {
    for (const cell of node.room.cells) cell.smoke = 0;
  }
}

function fillSmoke(room: RoomState, value: number): void {
  for (const cell of room.cells) cell.smoke = value;
}

function smokeOf(room: RoomState): number {
  return roomSummary(room).smoke;
}

function findLink(
  graph: BuildingGraph,
  a: string,
  b: string,
  kind: RoomLink['kind']
): RoomLink {
  const found = graph.links.find(
    (link) =>
      link.kind === kind &&
      ((link.a === a && link.b === b) || (link.a === b && link.b === a))
  );
  expect(found).toBeDefined();
  return found as RoomLink;
}

/** entrance ↔ lobby-F0 的门作为观察窗；只改这道门的开关，其它连接保持默认。 */
function entranceDoorGraph(open: boolean): BuildingGraph {
  const graph = createBuildingScenario().building;
  clearSmoke(graph);
  graph.rooms.entrance.room.openings.door.open = open;
  graph.rooms['lobby-F0'].room.openings.door.open = open;
  fillSmoke(graph.rooms.entrance.room, 0.8);
  return graph;
}

function run(graph: BuildingGraph, seconds: number, wind?: Wind): void {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) stepLinkSmoke(graph, DT, wind);
}

function snapshotSmoke(graph: BuildingGraph): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [id, node] of Object.entries(graph.rooms)) {
    out[id] = node.room.cells.map((cell) => cell.smoke);
  }
  return out;
}

describe('跨房间烟流', () => {
  it('开门后烟从高烟房间串到低烟房间', () => {
    const graph = entranceDoorGraph(true);
    run(graph, 3);

    expect(smokeOf(graph.rooms['lobby-F0'].room)).toBeGreaterThan(0.2);
    expect(smokeOf(graph.rooms.entrance.room)).toBeLessThan(0.8);
  });

  it('关门只缓慢渗透，明显慢于开门', () => {
    const openGraph = entranceDoorGraph(true);
    run(openGraph, 3);
    const openGain = smokeOf(openGraph.rooms['lobby-F0'].room);

    const closedGraph = entranceDoorGraph(false);
    run(closedGraph, 3);
    const closedGain = smokeOf(closedGraph.rooms['lobby-F0'].room);

    expect(closedGain).toBeGreaterThan(0);
    expect(closedGain).toBeLessThan(openGain * 0.5);
  });

  it('破窗同样串烟', () => {
    const graph = createBuildingScenario().building;
    clearSmoke(graph);
    fillSmoke(graph.rooms['room-202-F1'].room, 0.8);
    graph.rooms['room-202-F1'].room.openings.window.broken = true;
    graph.rooms['escape-F1'].room.openings.window.broken = true;

    run(graph, 3);
    expect(smokeOf(graph.rooms['escape-F1'].room)).toBeGreaterThan(0.2);
  });

  it('坍塌阻断后烟不再流动', () => {
    const graph = entranceDoorGraph(true);
    findLink(graph, 'entrance', 'lobby-F0', 'door').blocked = true;

    run(graph, 3);
    expect(smokeOf(graph.rooms['lobby-F0'].room)).toBe(0);
    expect(smokeOf(graph.rooms.entrance.room)).toBeCloseTo(0.8, 10);
  });

  it('顺风加速低烟房间的烟增量', () => {
    const calm = entranceDoorGraph(true);
    run(calm, 3);
    const calmGain = smokeOf(calm.rooms['lobby-F0'].room);

    const windy = entranceDoorGraph(true);
    run(windy, 3, { x: 1, y: 0, speed: 1 });
    const windGain = smokeOf(windy.rooms['lobby-F0'].room);

    expect(windGain).toBeGreaterThanOrEqual(calmGain);
  });

  it('楼梯与消防梯不参与烟流', () => {
    // 竖井连接被跳过：stair-F0 的烟不会瞬移到 stair-F1。
    const stair = createBuildingScenario().building;
    clearSmoke(stair);
    fillSmoke(stair.rooms['stair-F0'].room, 0.8);
    run(stair, 3);
    expect(smokeOf(stair.rooms['stair-F1'].room)).toBe(0);

    // 消防梯同理：escape-F1 的烟不会瞬移到 escape-F2。
    const ladder = createBuildingScenario().building;
    clearSmoke(ladder);
    fillSmoke(ladder.rooms['escape-F1'].room, 0.8);
    run(ladder, 3);
    expect(smokeOf(ladder.rooms['escape-F2'].room)).toBe(0);
  });

  it('非法步长不改场，同输入两次结果一致', () => {
    const graph = entranceDoorGraph(true);
    const before = snapshotSmoke(graph);
    for (const dt of [Number.NaN, 0, -1]) stepLinkSmoke(graph, dt);
    expect(snapshotSmoke(graph)).toEqual(before);

    const build = () => {
      const fresh = entranceDoorGraph(true);
      run(fresh, 3, { x: 1, y: 0, speed: 0.8 });
      return snapshotSmoke(fresh);
    };
    expect(build()).toEqual(build());
  });
});
