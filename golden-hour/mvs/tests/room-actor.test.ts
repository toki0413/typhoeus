import { describe, it, expect } from 'vitest';
import { createRoom } from '../src/sim/spatial/fields';
import {
  createActor,
  moveActor,
  stepActor,
} from '../src/sim/spatial/actor';

describe('玩家状态', () => {
  it('低姿比站立吸入更慢', () => {
    const room = createRoom();
    for (const c of room.cells) {
      c.smoke = 0.8;
      c.steam = 0;
      c.heat = 0;
    }
    const upright = createActor(0, 0);
    const low = createActor(0, 0);
    low.stance = 'low';

    for (let i = 0; i < 20; i++) {
      stepActor(upright, room, 0.1, false);
      stepActor(low, room, 0.1, false);
    }

    expect(low.exposure.smoke).toBeLessThan(upright.exposure.smoke);
  });

  it('持续高热暴露会让玩家倒地', () => {
    const room = createRoom();
    for (const c of room.cells) {
      c.heat = 1;
      c.smoke = 0;
      c.steam = 0;
    }
    const actor = createActor(0, 0);
    for (let i = 0; i < 100; i++) stepActor(actor, room, 0.1, false);
    expect(actor.downed).toBe(true);
  });

  it('负重越高移动越慢', () => {
    const light = createActor(0, 0);
    const loaded = createActor(0, 0);
    loaded.load = 0.8;

    moveActor(light, 1, 0, 1);
    moveActor(loaded, 1, 0, 1);

    expect(loaded.x).toBeLessThan(light.x);
  });

  it('移动被夹在房间边界内', () => {
    const actor = createActor(0, 0);
    moveActor(actor, 1, 0, 10);
    expect(actor.x).toBe(2.75);
  });
});
