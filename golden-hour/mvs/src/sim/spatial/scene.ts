import { SOFA_CELLS, cellAt, roomSummary, type Cell } from './fields';
import type { BuildingGraph } from './rooms';
import { createBuilding } from './rooms';
import { FIXED_DT, stepRoom } from './spread';
import type { ActorState } from './actor';
import { createOccupant, type OccupantState } from './rescue';

export interface ScenarioDefinition {
  id: string;
  seed: number;
  building: BuildingGraph;
  startRoom: string;
  targetRoom: string;
  objectives: string[];
}

export interface RoomSnapshot {
  fire: number;
  smoke: number;
  heat: number;
  oxygen: number;
}

export interface ScenarioSnapshot {
  t: number;
  roomId: string;
  actor: ActorState;
  occupant: OccupantState;
  rooms: Record<string, RoomSnapshot>;
  objectivesDone: string[];
}

function quietRoom(cells: Cell[]): void {
  for (const cell of cells) {
    cell.fuel = 0;
    cell.fire = 0;
    cell.heat = 0.05;
    cell.smoke = 0;
    cell.steam = 0;
    cell.oxygen = 0.95;
    cell.water = 0;
    cell.structure = 1;
    cell.combustibility = 0;
    cell.smokeYield = 0;
    cell.fireClass = 'A';
  }
}

/** Phase 1 场景：入口出发，目标 202-F1；只有 202 的沙发起火。 */
export function createBuildingScenario(): ScenarioDefinition {
  const building = createBuilding();

  for (const node of Object.values(building.rooms)) {
    quietRoom(node.room.cells);
  }

  const room = building.rooms['room-202-F1'].room;
  for (const [x, y] of SOFA_CELLS) {
    const cell = cellAt(room, x, y);
    cell.fuel = 1;
    cell.combustibility = 0.8;
    cell.smokeYield = 1.4;
    // 整张沙发已进入初期燃烧，而非单点起火。
    cell.fire = 0.2;
  }

  const source = cellAt(room, 5, 4);
  source.fire = 0.45;
  source.heat = 0.2;

  return {
    id: 'building-202',
    seed: 1,
    building,
    startRoom: 'entrance',
    targetRoom: 'room-202-F1',
    objectives: ['进入 202', '救出居民'],
  };
}

/** 推进整栋楼；目前只有 202 有火，其它房间保持安静。 */
export function stepScenario(def: ScenarioDefinition, dt = FIXED_DT): void {
  for (const node of Object.values(def.building.rooms)) {
    stepRoom(node.room, dt);
  }
}

export function snapshotScenario(
  def: ScenarioDefinition,
  roomId: string,
  actor: ActorState,
  occupant: OccupantState = createOccupant(0, 0, 'none')
): ScenarioSnapshot {
  const rooms: Record<string, RoomSnapshot> = {};
  const t = def.building.rooms[def.startRoom].room.t;

  for (const [id, node] of Object.entries(def.building.rooms)) {
    const summary = roomSummary(node.room);
    rooms[id] = {
      fire: summary.fire,
      smoke: summary.smoke,
      heat: summary.heat,
      oxygen: summary.oxygen,
    };
  }

  const objectivesDone: string[] = [];
  if (roomId === def.targetRoom || occupant.rescued) objectivesDone.push('进入 202');
  if (occupant.rescued) objectivesDone.push('救出居民');

  return {
    t,
    roomId,
    actor: { ...actor, exposure: { ...actor.exposure } },
    occupant: { ...occupant },
    rooms,
    objectivesDone,
  };
}
