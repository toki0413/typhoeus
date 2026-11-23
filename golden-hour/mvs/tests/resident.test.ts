import { describe, it, expect } from 'vitest';
import { cellAt, createRoom } from '../src/sim/spatial/fields';
import { worldToGrid } from '../src/sim/spatial/coords';
import { createActor } from '../src/sim/spatial/actor';
import { createResident, findResident, stepResident } from '../src/sim/agents/resident';

describe('居民避险行为', () => {
  it('恐慌居民会朝烟更小的一侧移动', () => {
    const room = createRoom();
    // 造一个沿 x 方向递增的烟场，左清右浊；热统一清零，避免干扰判断
    for (let y = 0; y < room.config.rows; y++) {
      for (let x = 0; x < room.config.cols; x++) {
        const cell = cellAt(room, x, y);
        cell.smoke = (x / (room.config.cols - 1)) * 0.9;
        cell.heat = 0;
      }
    }

    const resident = createResident('r1', 2, 0);
    resident.panic = 0.6;

    const startGrid = worldToGrid(resident.x, resident.z);
    const startSmoke = cellAt(room, startGrid.x, startGrid.y).smoke;

    for (let i = 0; i < 100; i++) stepResident(resident, room, 0.1);

    const endGrid = worldToGrid(resident.x, resident.z);
    const endSmoke = cellAt(room, endGrid.x, endGrid.y).smoke;

    expect(resident.x).toBeLessThan(1);
    expect(endSmoke).toBeLessThan(startSmoke);
    expect(resident.mood).not.toBe('unconscious');
  });

  it('躲藏居民只在搜索半径内被发现', () => {
    const resident = createResident('r1', 0, 0);
    resident.hidden = true;

    const actor = createActor(3, 0);
    expect(findResident(resident, actor)).toBe(false);

    actor.x = 1;
    expect(findResident(resident, actor)).toBe(true);

    const visible = createResident('r2', 2.5, 0);
    expect(findResident(visible, createActor(0, 0))).toBe(true);
  });

  it('浓烟中失去意识后不再移动', () => {
    const room = createRoom();
    for (const cell of room.cells) {
      cell.smoke = 1;
      cell.heat = 0;
    }

    const resident = createResident('r1', 0, 0);
    for (let i = 0; i < 500 && resident.health > 0; i++) {
      stepResident(resident, room, 0.1);
    }

    expect(resident.health).toBe(0);
    expect(resident.mood).toBe('unconscious');

    const x = resident.x;
    const z = resident.z;
    for (let i = 0; i < 100; i++) stepResident(resident, room, 0.1);
    expect(resident.x).toBe(x);
    expect(resident.z).toBe(z);
  });

  it('躲藏居民失去意识后暴露状态解除', () => {
    const room = createRoom();
    for (const cell of room.cells) {
      cell.smoke = 1;
      cell.heat = 0;
    }

    const resident = createResident('r1', 0, 0);
    resident.hidden = true;
    for (let i = 0; i < 500 && resident.health > 0; i++) {
      stepResident(resident, room, 0.1);
    }

    expect(resident.health).toBe(0);
    expect(resident.mood).toBe('unconscious');
    expect(resident.hidden).toBe(false);
  });

  it('躲藏居民在原地保持 hidden 心情', () => {
    const room = createRoom();
    for (const cell of room.cells) {
      cell.smoke = 0;
      cell.heat = 0;
    }

    const resident = createResident('r1', 0.5, -0.5);
    resident.hidden = true;

    for (let i = 0; i < 50; i++) stepResident(resident, room, 0.1);

    expect(resident.x).toBe(0.5);
    expect(resident.z).toBe(-0.5);
    expect(resident.mood).toBe('hidden');
  });

  it('安全房间里恐慌回落后恢复镇定', () => {
    const room = createRoom();
    for (const cell of room.cells) {
      cell.smoke = 0;
      cell.heat = 0;
    }

    const resident = createResident('r1', 0, 0);
    resident.panic = 0.6;

    for (let i = 0; i < 100; i++) stepResident(resident, room, 0.1);

    expect(resident.panic).toBeLessThanOrEqual(0.4);
    expect(resident.mood).toBe('calm');
  });

  it('被背起的居民在浓烟中不再掉健康', () => {
    const room = createRoom();
    for (const cell of room.cells) {
      cell.smoke = 1;
      cell.heat = 0;
    }

    const resident = createResident('r1', 0, 0);
    resident.carried = true;

    stepResident(resident, room, 10);

    expect(resident.health).toBe(1);
    expect(resident.injury).toBe(0);
  });

  it('烟热暴露下伤情持续恶化', () => {
    const room = createRoom();
    for (const cell of room.cells) {
      cell.smoke = 0.6;
      cell.heat = 0.2;
    }

    const resident = createResident('r1', 0, 0);
    let lastHealth = resident.health;
    let lastInjury = resident.injury;

    for (let i = 0; i < 50; i++) {
      stepResident(resident, room, 0.1);
      expect(resident.health).toBeLessThan(lastHealth);
      expect(resident.injury).toBeGreaterThan(lastInjury);
      lastHealth = resident.health;
      lastInjury = resident.injury;
    }

    expect(resident.health).toBeLessThan(1);
    expect(resident.injury).toBeGreaterThan(0);
  });

  it('NaN dt 不改变居民状态', () => {
    const room = createRoom();
    const resident = createResident('r1', 0.5, -0.5);
    const before = { ...resident };

    stepResident(resident, room, Number.NaN);

    expect(resident).toEqual(before);
  });

  it('被救出的居民不再掉健康', () => {
    const room = createRoom();
    for (const cell of room.cells) cell.smoke = 1;

    const resident = createResident('r1', 0, 0);
    resident.rescued = true;

    stepResident(resident, room, 10);

    expect(resident.health).toBe(1);
    expect(resident.injury).toBe(0);
  });
});
