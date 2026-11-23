import { describe, it, expect } from 'vitest';
import { roomSummary } from '../src/sim/spatial/fields';
import {
  createBuildingScenario,
  createZoneScenario,
  stepScenario,
  type ScenarioDefinition,
} from '../src/sim/spatial/scene';
import { layoutById } from '../src/content/layouts';
import { createActor, type ActorState } from '../src/sim/spatial/actor';
import { createResident } from '../src/sim/agents/resident';
import { createCrowd, stepCrowd, type CrowdState } from '../src/sim/agents/crowd';
import {
  createHousehold,
  stepHousehold,
  type HouseholdState,
} from '../src/sim/agents/household';
import {
  createDirector,
  stepDirector,
  type DirectorState,
} from '../src/sim/events/director';
import { FIXED_DT } from '../src/sim/spatial/spread';
import { stepLinkSmoke } from '../src/sim/spatial/ventilation';
import { createToolLoadout } from '../src/sim/interaction/tools';
import {
  SAVE_VERSION,
  createSave,
  deserializeSave,
  saveHash,
  serializeSave,
} from '../src/app/save';

const TARGET = 'room-202-F1';

interface Fixture {
  def: ScenarioDefinition;
  actor: ActorState;
  crowd: CrowdState;
  director: DirectorState;
  currentRoom: string;
}

/** 固定顺序推进场、居民与导演；actor 只随存档保存，不在此移动。 */
function advance(
  def: ScenarioDefinition,
  crowd: CrowdState,
  director: DirectorState,
  seconds: number
): void {
  const steps = Math.round(seconds / FIXED_DT);
  for (let i = 0; i < steps; i++) {
    stepScenario(def, FIXED_DT);
    stepCrowd(crowd, def.building.rooms[crowd.roomId].room, FIXED_DT);
    stepDirector(director, def.building, FIXED_DT);
  }
}

/** 构造完整状态：满配演员 + 三名居民 + 导演，并推进 5 秒让场有非零值。 */
function buildState(seed = 7): Fixture {
  const def = createBuildingScenario();

  const actor = createActor();
  actor.masked = true;
  actor.exposure = { smoke: 0.12, heat: 0.05 };
  actor.stamina = 0.82;

  const residents = [
    createResident(TARGET, -1.125, -0.375, 'R1'),
    createResident(TARGET, 0.375, 0.375, 'R2'),
    createResident(TARGET, 1.125, -0.375, 'R3'),
  ];
  const crowd = createCrowd(TARGET, residents, seed);
  const director = createDirector(seed);

  advance(def, crowd, director, 5);

  return { def, actor, crowd, director, currentRoom: TARGET };
}

interface MultiFixture {
  def: ScenarioDefinition;
  actor: ActorState;
  households: HouseholdState;
  director: DirectorState;
  currentRoom: string;
}

/** 多区域状态：classic 三区，推进 5 秒让串烟与人群都有非零值。 */
function buildMultiState(seed = 7): MultiFixture {
  const layout = layoutById('classic')!;
  const def = createZoneScenario(
    layout.build(),
    layout.entrance,
    layout.zones,
    'z-classic',
    seed
  );

  const actor = createActor();
  actor.masked = true;
  const households = createHousehold(layout.zones, seed);
  const director = createDirector(seed);

  const steps = Math.round(5 / FIXED_DT);
  for (let i = 0; i < steps; i++) {
    stepScenario(def, FIXED_DT);
    stepLinkSmoke(def.building, FIXED_DT, director.wind);
    stepHousehold(households, def.building, FIXED_DT);
    stepDirector(director, def.building, FIXED_DT);
  }

  return { def, actor, households, director, currentRoom: def.targetRoom };
}

describe('存档与恢复', () => {
  it('序列化往返后关键字段一致', () => {
    const save = createSave(buildState());
    const restored = deserializeSave(serializeSave(save));

    expect(restored.version).toBe(save.version);
    expect(restored.simTime).toBe(save.simTime);
    expect(restored.currentRoom).toBe(save.currentRoom);
    expect(restored.actor).toEqual(save.actor);

    expect(restored.crowd!.rescued).toBe(save.crowd!.rescued);
    expect(restored.crowd!.lost).toBe(save.crowd!.lost);
    expect(restored.crowd!.residents).toEqual(save.crowd!.residents);

    expect(restored.director.collapsed).toEqual(save.director.collapsed);
    expect(restored.director.events).toEqual(save.director.events);

    for (const [id, node] of Object.entries(save.def.building.rooms)) {
      const other = restored.def.building.rooms[id];
      expect(other).toBeDefined();
      expect(other.room.t).toBeCloseTo(node.room.t, 10);

      const before = roomSummary(node.room);
      const after = roomSummary(other.room);
      for (const key of ['fire', 'smoke', 'heat', 'oxygen', 'structure'] as const) {
        expect(after[key]).toBeCloseTo(before[key], 10);
      }
    }
  });

  it('恢复后继续推进 10 秒仍与未恢复一致', () => {
    const live = buildState();
    const restored = deserializeSave(serializeSave(createSave(buildState())));

    advance(live.def, live.crowd, live.director, 10);
    advance(restored.def, restored.crowd!, restored.director, 10);

    for (const [id, node] of Object.entries(live.def.building.rooms)) {
      const other = restored.def.building.rooms[id];
      expect(other.room.t).toBeCloseTo(node.room.t, 6);

      const a = roomSummary(node.room);
      const b = roomSummary(other.room);
      for (const key of ['fire', 'smoke', 'heat', 'oxygen', 'structure'] as const) {
        expect(b[key]).toBeCloseTo(a[key], 6);
      }
    }

    expect(restored.actor).toEqual(live.actor);
    expect(restored.crowd!.rescued).toBe(live.crowd.rescued);
    expect(restored.crowd!.lost).toBe(live.crowd.lost);
    expect(restored.crowd!.t).toBeCloseTo(live.crowd.t, 6);
    expect(restored.director.collapsed).toEqual(live.director.collapsed);
    expect(restored.director.events).toEqual(live.director.events);

    for (let i = 0; i < live.crowd.residents.length; i++) {
      const a = live.crowd.residents[i];
      const b = restored.crowd!.residents[i];
      expect(b.id).toBe(a.id);
      expect(b.mood).toBe(a.mood);
      expect(b.health).toBeCloseTo(a.health, 6);
      expect(b.panic).toBeCloseTo(a.panic, 6);
      expect(b.injury).toBeCloseTo(a.injury, 6);
      expect(b.x).toBeCloseTo(a.x, 6);
      expect(b.z).toBeCloseTo(a.z, 6);
    }
  });

  it('v2 多区域存档往返保留全部区域与居民', () => {
    const state = buildMultiState();
    const save = createSave(state);

    expect(save.version).toBe(2);
    expect(save.crowd).toBeUndefined();
    expect(save.households?.zones).toHaveLength(5);

    const restored = deserializeSave(serializeSave(save));
    expect(restored.version).toBe(2);
    expect(restored.crowd).toBeUndefined();
    expect(restored.households?.activeRoomId).toBe(save.households?.activeRoomId);

    for (const zone of save.households!.zones) {
      const before = save.households!.crowds[zone.roomId];
      const after = restored.households!.crowds[zone.roomId];
      expect(after.residents).toEqual(before.residents);
      expect(after.rescued).toBe(before.rescued);
      expect(after.lost).toBe(before.lost);
      expect(after.t).toBeCloseTo(before.t, 10);
    }
  });

  it('v1 单区域旧档可读，不要求 households', () => {
    const save = createSave(buildState());
    const legacy = JSON.parse(serializeSave(save)) as Record<string, unknown>;
    legacy.version = 1;
    delete legacy.households;

    const restored = deserializeSave(JSON.stringify(legacy));
    expect(restored.version).toBe(1);
    expect(restored.crowd?.rescued).toBe(save.crowd?.rescued);
    expect(restored.households).toBeUndefined();
  });

  it('v2 坏版本与既无 crowd 也无 households 的存档都抛错', () => {
    const save = createSave(buildMultiState());

    const tampered = JSON.parse(serializeSave(save)) as Record<string, unknown>;
    tampered.version = 999;
    expect(() => deserializeSave(JSON.stringify(tampered))).toThrow(/版本/);

    const empty = JSON.parse(serializeSave(save)) as Record<string, unknown>;
    delete empty.households;
    expect(() => deserializeSave(JSON.stringify(empty))).toThrow(/crowd|households/);
  });

  it('版本不符、坏 JSON 与缺字段都抛错', () => {
    const save = createSave(buildState());

    const tampered = JSON.parse(serializeSave(save)) as Record<string, unknown>;
    tampered.version = 999;
    expect(() => deserializeSave(JSON.stringify(tampered))).toThrow(/版本/);

    expect(() => deserializeSave('not json')).toThrow();

    for (const key of ['def', 'actor', 'crowd', 'director']) {
      const broken = JSON.parse(serializeSave(save)) as Record<string, unknown>;
      delete broken[key];
      expect(() => deserializeSave(JSON.stringify(broken))).toThrow();
    }
  });

  it('哈希对同一存档稳定，场变化后不同', () => {
    const save = createSave(buildState());
    const copy = deserializeSave(serializeSave(save));

    expect(saveHash(save)).toBe(saveHash(save));
    expect(saveHash(copy)).toBe(saveHash(save));

    const cell = save.def.building.rooms[TARGET].room.cells[0];
    cell.fire += 0.5;
    expect(saveHash(save)).not.toBe(saveHash(copy));
  });

  it('createSave 的 simTime 取目标房间的模拟时刻', () => {
    const fixture = buildState();
    const save = createSave(fixture);

    expect(save.version).toBe(SAVE_VERSION);
    expect(save.simTime).toBe(
      fixture.def.building.rooms[fixture.def.targetRoom].room.t
    );
    expect(save.simTime).toBeGreaterThan(0);
  });

  it('带 loadout 的存档往返后余量与状态一致，旧格式仍能反序列化', () => {
    const loadout = createToolLoadout();
    loadout.hose.charge = 0.4;
    loadout.hose.condition = 'depressurized';
    loadout.extinguisher.charge = 0;
    loadout.extinguisher.condition = 'empty';

    const save = createSave({ ...buildState(), loadout });
    const restored = deserializeSave(serializeSave(save));

    expect(restored.loadout).toEqual(loadout);
    expect(restored.loadout?.hose.charge).toBeCloseTo(0.4, 10);
    expect(restored.loadout?.hose.condition).toBe('depressurized');

    // 旧格式没有 loadout 字段：反序列化不报错，该字段保持缺省。
    const legacy = JSON.parse(serializeSave(save)) as Record<string, unknown>;
    delete legacy.loadout;
    const restoredLegacy = deserializeSave(JSON.stringify(legacy));
    expect(restoredLegacy.loadout).toBeUndefined();
    expect(restoredLegacy.actor).toEqual(save.actor);
  });
});
