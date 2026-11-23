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

  it('佩戴空呼后烟热暴露累积更慢', () => {
    const room = createRoom();
    for (const c of room.cells) {
      c.smoke = 0.8;
      c.heat = 0.5;
      c.steam = 0;
    }
    const bare = createActor(0, 0);
    const masked = createActor(0, 0);
    masked.masked = true;

    for (let i = 0; i < 50; i++) {
      stepActor(bare, room, 0.1, false);
      stepActor(masked, room, 0.1, false);
    }

    expect(masked.exposure.smoke).toBeLessThan(bare.exposure.smoke);
    expect(masked.exposure.heat).toBeLessThan(bare.exposure.heat);
    expect(masked.downed).toBe(false);
  });

  it('佩戴空呼移动时余量下降更快', () => {
    const room = createRoom();
    for (const c of room.cells) {
      c.smoke = 0;
      c.heat = 0;
      c.steam = 0;
    }
    const moving = createActor(0, 0);
    const still = createActor(0, 0);
    moving.masked = true;
    still.masked = true;

    for (let i = 0; i < 100; i++) {
      stepActor(moving, room, 0.1, true);
      stepActor(still, room, 0.1, false);
    }

    expect(moving.air).toBeLessThan(still.air);
    expect(still.air).toBeLessThan(1);
  });

  it('空呼耗尽后防护失效', () => {
    const room = createRoom();
    for (const c of room.cells) {
      c.smoke = 0;
      c.heat = 0;
      c.steam = 0;
    }
    const actor = createActor(0, 0);
    actor.masked = true;

    for (let i = 0; i < 200; i++) stepActor(actor, room, 1, true);

    expect(actor.air).toBe(0);
    expect(actor.masked).toBe(false);
  });

  it('未佩戴空呼时余量保持满瓶', () => {
    const room = createRoom();
    for (const c of room.cells) {
      c.smoke = 0;
      c.heat = 0;
      c.steam = 0;
    }
    const actor = createActor(0, 0);

    for (let i = 0; i < 200; i++) stepActor(actor, room, 1, true);

    expect(actor.air).toBe(1);
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

  it('爬行比低姿吸入更少', () => {
    const room = createRoom();
    for (const c of room.cells) {
      c.smoke = 0.8;
      c.steam = 0;
      c.heat = 0;
    }
    const low = createActor(0, 0);
    low.stance = 'low';
    const crawl = createActor(0, 0);
    crawl.stance = 'crawl';

    for (let i = 0; i < 20; i++) {
      stepActor(low, room, 0.1, false);
      stepActor(crawl, room, 0.1, false);
    }

    expect(crawl.exposure.smoke).toBeLessThan(low.exposure.smoke);
  });

  it('移动消耗体力，静止恢复', () => {
    const room = createRoom();
    const actor = createActor(0, 0);
    stepActor(actor, room, 1, true);
    const afterMove = actor.stamina;
    expect(afterMove).toBeLessThan(1);

    stepActor(actor, room, 1, false);
    expect(actor.stamina).toBeGreaterThan(afterMove);
  });

  it('蒸汽会计入吸入暴露', () => {
    const room = createRoom();
    for (const c of room.cells) {
      c.smoke = 0;
      c.steam = 0.5;
      c.heat = 0;
    }
    const actor = createActor(0, 0);
    stepActor(actor, room, 0.1, false);
    expect(actor.exposure.smoke).toBeGreaterThan(0);
  });

  it('倒地后不能移动', () => {
    const actor = createActor(0, 0);
    actor.downed = true;
    moveActor(actor, 1, 0, 1);
    expect(actor.x).toBe(0);
  });
});
