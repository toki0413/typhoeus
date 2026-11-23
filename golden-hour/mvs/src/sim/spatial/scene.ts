import { SOFA_CELLS, cellAt, roomSummary, type Cell, type FireClass } from './fields';
import type { BuildingGraph } from './rooms';
import { createBuilding } from './rooms';
import { FIXED_DT, stepRoom } from './spread';
import type { ActorState } from './actor';
import { createOccupant, type OccupantState } from './rescue';
import type { ZoneSpec } from '../../content/zones';

export interface ScenarioDefinition {
  id: string;
  seed: number;
  building: BuildingGraph;
  startRoom: string;
  targetRoom: string;
  objectives: string[];
}

/** 多区域场景：在单区域场景之上附带区域声明。 */
export interface ZoneScenario extends ScenarioDefinition {
  zones: ZoneSpec[];
}

/** 目标房间的火场剖面：火类与燃料属性由内容层按户型给出。 */
export interface TargetFireProfile {
  fireClass: FireClass;
  combustibility: number;
  smokeYield: number;
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

/** 用给定建筑图创建场景：其它房间清空火源，只在 targetRoom 点燃沙发与火源。 */
export function createScenarioForBuilding(
  building: BuildingGraph,
  startRoom: string,
  targetRoom: string,
  id = 'building-202',
  seed = 1,
  fire: TargetFireProfile = { fireClass: 'A', combustibility: 0.8, smokeYield: 1.4 }
): ScenarioDefinition {
  for (const node of Object.values(building.rooms)) {
    quietRoom(node.room.cells);
  }

  const room = building.rooms[targetRoom].room;
  for (const [x, y] of SOFA_CELLS) {
    const cell = cellAt(room, x, y);
    cell.fuel = 1;
    cell.combustibility = fire.combustibility;
    cell.smokeYield = fire.smokeYield;
    cell.fireClass = fire.fireClass;
    // 整张沙发已进入初期燃烧，而非单点起火。
    cell.fire = 0.2;
  }

  const source = cellAt(room, 5, 4);
  source.fire = 0.45;
  source.heat = 0.2;
  source.combustibility = fire.combustibility;
  source.smokeYield = fire.smokeYield;
  source.fireClass = fire.fireClass;

  return {
    id,
    seed,
    building,
    startRoom,
    targetRoom,
    objectives: [`进入 ${targetRoom}`, '救出居民'],
  };
}

/**
 * 多区域场景：整栋楼先清空，只对声明了火源的区域写入燃料与火。
 * 无火区域保持安静，等待后续跨房间烟流；目标房间沿用 zones[0]。
 */
export function createZoneScenario(
  building: BuildingGraph,
  startRoom: string,
  zones: ZoneSpec[],
  id: string,
  seed: number
): ZoneScenario {
  if (zones.length === 0) {
    // 空区域回退到现有单区域逻辑，目标房间取起点，保证可玩。
    return {
      ...createScenarioForBuilding(building, startRoom, startRoom, id, seed),
      zones: [],
    };
  }

  for (const node of Object.values(building.rooms)) {
    quietRoom(node.room.cells);
  }

  for (const zone of zones) {
    const fire = zone.fire;
    if (!fire) continue;

    const room = building.rooms[zone.roomId].room;
    for (const [x, y] of fire.cells) {
      const cell = cellAt(room, x, y);
      cell.fuel = 1;
      cell.combustibility = fire.combustibility ?? 0.8;
      cell.smokeYield = fire.smokeYield ?? 1.4;
      cell.fireClass = zone.fireClass;
      cell.fire = fire.intensity;
    }

    if (fire.source) {
      const [x, y] = fire.source;
      const sourceCell = cellAt(room, x, y);
      sourceCell.fire = Math.max(sourceCell.fire, fire.sourceIntensity ?? fire.intensity + 0.2);
      sourceCell.heat = 0.2;
    }
  }

  return {
    id,
    seed,
    building,
    startRoom,
    targetRoom: zones[0].roomId,
    objectives: [...zones.map((zone) => '搜救 ' + zone.label), '救出居民'],
    zones,
  };
}

/** Phase 1 场景：入口出发，目标 202-F1；只有 202 的沙发起火。 */
export function createBuildingScenario(): ScenarioDefinition {
  return createScenarioForBuilding(
    createBuilding(),
    'entrance',
    'room-202-F1',
    'building-202',
    1
  );
}

/** 推进整栋楼；只有目标房间有火，其它房间保持安静。 */
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
