import { describe, it, expect } from 'vitest';
import {
  COLLAPSE_SECONDS,
  createDirector,
  setWind,
  stepDirector,
  WINDOW_FAIL_TEMP,
} from '../src/sim/events/director';
import { roomSummary, type RoomState } from '../src/sim/spatial/fields';
import type { BuildingGraph } from '../src/sim/spatial/rooms';
import { createBuildingScenario } from '../src/sim/spatial/scene';

const DT = 0.1;

/** 把整栋楼的烟清零，用例再逐格设定，避免依赖场景默认状态。 */
function clearSmoke(graph: BuildingGraph): void {
  for (const node of Object.values(graph.rooms)) {
    for (const cell of node.room.cells) cell.smoke = 0;
  }
}

function smokeOf(room: RoomState): number {
  return roomSummary(room).smoke;
}

function fillRoom(room: RoomState, heat: number, structure: number): void {
  for (const cell of room.cells) {
    cell.heat = heat;
    cell.structure = structure;
    cell.fire = 0;
  }
}

function run(director: ReturnType<typeof createDirector>, graph: BuildingGraph, seconds: number) {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) stepDirector(director, graph, DT);
}

describe('事件导演', () => {
  it('坍塌需高温与低结构同时满足并持续足够时长', () => {
    const graph = createBuildingScenario().building;
    const target = graph.rooms['room-202-F1'];
    fillRoom(target.room, 0.7, 0.3);

    const touching = graph.links.filter(
      (link) => link.a === 'room-202-F1' || link.b === 'room-202-F1'
    );
    expect(touching.length).toBeGreaterThan(0);

    const director = createDirector(1);

    // 5 秒：还没到持续时间门槛，不坍塌。
    run(director, graph, COLLAPSE_SECONDS - 1);
    expect(director.collapsed).not.toContain('room-202-F1');
    expect(touching.every((link) => !link.blocked)).toBe(true);
    expect(director.events.filter((event) => event.kind === 'collapse')).toHaveLength(0);

    // 再 2 秒：跨过门槛，房间坍塌且所有相邻连接被封。
    run(director, graph, 2);
    expect(director.collapsed).toContain('room-202-F1');
    expect(touching.every((link) => link.blocked)).toBe(true);

    const collapseEvents = director.events.filter((event) => event.kind === 'collapse');
    expect(collapseEvents.some((event) => event.roomId === 'room-202-F1')).toBe(true);
    expect(collapseEvents.every((event) => event.at > 0)).toBe(true);

    // 继续推进不应重复记录同一房间的坍塌。
    run(director, graph, 3);
    const selfEvents = collapseEvents.filter(
      (event) => event.roomId === 'room-202-F1' && !event.linkId
    );
    expect(selfEvents).toHaveLength(1);
  });

  it('只满足高温或只满足低结构都不会坍塌', () => {
    // 低结构但温度不足：heat 0.4 < 0.6。
    const coolGraph = createBuildingScenario().building;
    fillRoom(coolGraph.rooms['room-202-F1'].room, 0.4, 0.3);
    const coolDirector = createDirector(2);
    run(coolDirector, coolGraph, 20);
    expect(coolDirector.collapsed).toHaveLength(0);
    expect(coolGraph.links.every((link) => !link.blocked)).toBe(true);

    // 高温但结构足够：structure 0.6 > 0.35。
    const solidGraph = createBuildingScenario().building;
    fillRoom(solidGraph.rooms['room-202-F1'].room, 0.7, 0.6);
    const solidDirector = createDirector(3);
    run(solidDirector, solidGraph, 20);
    expect(solidDirector.collapsed).toHaveLength(0);
  });

  it('风向决定烟往哪个房间扩散', () => {
    const forward = createBuildingScenario().building;
    clearSmoke(forward);
    const upwindRoom = forward.rooms.entrance.room;
    const downwindRoom = forward.rooms['lobby-F0'].room;
    for (const cell of upwindRoom.cells) cell.smoke = 0.8;

    const forwardDirector = createDirector(1);
    setWind(forwardDirector, 1, 0, 1); // entrance → lobby（向东）
    run(forwardDirector, forward, 3);

    const forwardGain = smokeOf(downwindRoom);
    expect(smokeOf(upwindRoom)).toBeLessThan(0.8);
    expect(forwardGain).toBeGreaterThan(0.2);

    // 反向风：下风变成原来的上风房间（本身已浓烟），不会继续升高。
    const reverse = createBuildingScenario().building;
    clearSmoke(reverse);
    const reverseEntrance = reverse.rooms.entrance.room;
    const reverseLobby = reverse.rooms['lobby-F0'].room;
    for (const cell of reverseEntrance.cells) cell.smoke = 0.8;

    const reverseDirector = createDirector(1);
    setWind(reverseDirector, -1, 0, 1); // lobby → entrance（向西）
    run(reverseDirector, reverse, 3);

    const reverseEntranceGain = smokeOf(reverseEntrance) - 0.8;
    expect(reverseEntranceGain).toBeLessThanOrEqual(0);
    expect(smokeOf(reverseLobby)).toBe(0);
    expect(forwardGain).toBeGreaterThan(0);
  });

  it('窗户高温失效只记录一次', () => {
    const graph = createBuildingScenario().building;
    const node = graph.rooms['room-201-F1'];
    node.room.openings.window.temp = WINDOW_FAIL_TEMP + 0.15;

    const director = createDirector(1);
    stepDirector(director, graph, DT);

    expect(node.room.openings.window.broken).toBe(true);
    const windowEvents = director.events.filter((event) => event.kind === 'window');
    expect(windowEvents).toHaveLength(1);
    expect(windowEvents[0].roomId).toBe('room-201-F1');

    // 再推进若干步，温度仍然偏高也不重复记录。
    run(director, graph, 2);
    expect(director.events.filter((event) => event.kind === 'window')).toHaveLength(1);
  });

  it('相同初始条件与输入得到完全一致的结果', () => {
    const build = () => {
      const graph = createBuildingScenario().building;
      clearSmoke(graph);
      fillRoom(graph.rooms['room-202-F1'].room, 0.7, 0.3);
      graph.rooms['room-201-F1'].room.openings.window.temp = 0.8;
      for (const cell of graph.rooms.entrance.room.cells) cell.smoke = 0.8;

      const director = createDirector(9);
      setWind(director, 1, 0, 0.8);
      run(director, graph, 8);

      const smoke: Record<string, number> = {};
      for (const [id, node] of Object.entries(graph.rooms)) {
        smoke[id] = smokeOf(node.room);
      }
      return {
        collapsed: [...director.collapsed],
        events: director.events.map((event) => ({ ...event })),
        smoke,
      };
    };

    const a = build();
    const b = build();
    expect(a.collapsed).toEqual(b.collapsed);
    expect(a.events).toEqual(b.events);
    expect(a.smoke).toEqual(b.smoke);
    expect(a.collapsed).toContain('room-202-F1');
  });

  it('NaN 与非法步长不改变导演状态', () => {
    const graph = createBuildingScenario().building;
    const director = createDirector(1);
    setWind(director, 0, 1, 0.5);

    const before = JSON.stringify(director);
    for (const dt of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      stepDirector(director, graph, dt);
    }
    expect(JSON.stringify(director)).toBe(before);
  });
});
