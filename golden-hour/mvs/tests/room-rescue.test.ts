import { describe, it, expect } from 'vitest';
import { createRoom } from '../src/sim/spatial/fields';
import { createActor } from '../src/sim/spatial/actor';
import {
  attachOccupant,
  createOccupant,
  extractOccupant,
  stepOccupant,
  syncCarriedOccupant,
} from '../src/sim/spatial/rescue';

describe('被困者与撤离', () => {
  it('离得太远不能背起', () => {
    const actor = createActor(-2.3, 0);
    const occupant = createOccupant(2.2, 2);
    expect(attachOccupant(actor, occupant)).toBe(false);
    expect(occupant.carried).toBe(false);
  });

  it('靠近后可以背起，负重上升', () => {
    const actor = createActor(1.9, 2);
    const occupant = createOccupant(2.2, 2);
    expect(attachOccupant(actor, occupant)).toBe(true);
    expect(occupant.carried).toBe(true);
    expect(actor.load).toBeGreaterThan(0.5);
  });

  it('背到打开的门边才算获救，关门时失败', () => {
    const room = createRoom();
    const actor = createActor(-2.4, 0);
    const occupant = createOccupant(-2.2, 0);
    attachOccupant(actor, occupant);

    expect(extractOccupant(occupant, actor, room, 'door')).toBe(false);

    room.openings.door.open = true;
    expect(extractOccupant(occupant, actor, room, 'door')).toBe(true);
    expect(occupant.rescued).toBe(true);
    expect(actor.load).toBe(0);
  });

  it('浓烟中健康下降，归零后失去意识', () => {
    const room = createRoom();
    for (const c of room.cells) c.smoke = 0.9;
    const occupant = createOccupant(0, 0);
    for (let i = 0; i < 300; i++) stepOccupant(occupant, room, 0.1);
    expect(occupant.health).toBe(0);
    expect(occupant.mood).toBe('unconscious');
  });

  it('背起后暴露伤害降低', () => {
    const room = createRoom();
    for (const c of room.cells) c.smoke = 0.9;
    const carried = createOccupant(0, 0);
    const walked = createOccupant(0, 0);
    const actor = createActor(0, 0);
    attachOccupant(actor, carried);

    for (let i = 0; i < 100; i++) {
      stepOccupant(carried, room, 0.1);
      stepOccupant(walked, room, 0.1);
    }

    expect(carried.health).toBeGreaterThan(walked.health);
  });

  it('背起后居民跟随玩家位置', () => {
    const actor = createActor(0, 0);
    const occupant = createOccupant(0, 0);
    attachOccupant(actor, occupant);
    actor.x = 1.5;
    actor.z = -1;
    syncCarriedOccupant(occupant, actor);
    expect(occupant.x).toBe(1.5);
    expect(occupant.z).toBe(-1);
  });

  it('获救后不再衰减，也不能再次背起', () => {
    const room = createRoom();
    room.openings.door.open = true;
    const actor = createActor(-2.4, 0);
    const occupant = createOccupant(-2.2, 0);
    attachOccupant(actor, occupant);
    expect(extractOccupant(occupant, actor, room, 'door')).toBe(true);

    const health = occupant.health;
    for (const c of room.cells) c.smoke = 1;
    stepOccupant(occupant, room, 10);
    expect(occupant.health).toBe(health);
    expect(attachOccupant(actor, occupant)).toBe(false);
  });

  it('引导撤离不改变负重', () => {
    const room = createRoom();
    room.openings.door.open = true;
    const actor = createActor(-2.4, 0);
    const occupant = createOccupant(-2.2, 0);
    const before = actor.load;
    expect(extractOccupant(occupant, actor, room, 'door')).toBe(true);
    expect(actor.load).toBe(before);
  });

  it('NaN dt 不改变居民状态', () => {
    const room = createRoom();
    const occupant = createOccupant(0, 0);
    const before = occupant.health;
    stepOccupant(occupant, room, Number.NaN);
    expect(occupant.health).toBe(before);
  });
});
