import { describe, it, expect } from 'vitest';
import { createRoom, type RoomState } from '../src/sim/spatial/fields';
import { gridToWorld } from '../src/sim/spatial/coords';
import { createActor } from '../src/sim/spatial/actor';
import { createResident, stepResident } from '../src/sim/agents/resident';
import {
  createCrowd,
  rescueResident,
  stepCrowd,
  survivorCandidates,
} from '../src/sim/agents/crowd';

/** 清空全房烟热与火源，用例再逐格设定，避免依赖 createRoom 的初始火源。 */
function clearRoom(): RoomState {
  const room = createRoom();
  for (const cell of room.cells) {
    cell.smoke = 0;
    cell.heat = 0;
    cell.fire = 0;
    cell.steam = 0;
  }
  return room;
}

describe('多人救援', () => {
  it('先救谁改变结果：优先背濒死者才能全员获救', () => {
    // 全屋匀质 smoke=1：恐慌也没有更干净的相邻格可逃，三人都会持续掉血
    const build = () => {
      const room = clearRoom();
      for (const cell of room.cells) cell.smoke = 1;
      const actor = createActor(0, 0);

      const a = createResident('r202', gridToWorld(3, 4).x, gridToWorld(3, 4).z, 'A');
      const b = createResident('r202', gridToWorld(4, 2).x, gridToWorld(4, 2).z, 'B');
      b.health = 0.24;
      const c = createResident('r202', gridToWorld(5, 4).x, gridToWorld(5, 4).z, 'C');

      return { room, actor, a, b, c };
    };

    // 顺序一：先救健康的人，B 在两次背出（10s）期间耗尽宽限期
    const first = build();
    const crowdLazy = createCrowd('r202', [first.a, first.b, first.c], 7);
    expect(rescueResident(crowdLazy, 'A', first.actor, first.room, 'carry').ok).toBe(true);
    expect(rescueResident(crowdLazy, 'C', first.actor, first.room, 'carry').ok).toBe(true);
    expect(first.b.dead).toBe(true);

    // 顺序二：先背 B，再救 A/C，三人全部获救
    const second = build();
    const crowdSmart = createCrowd('r202', [second.a, second.b, second.c], 7);
    expect(rescueResident(crowdSmart, 'B', second.actor, second.room, 'carry').ok).toBe(true);
    expect(rescueResident(crowdSmart, 'A', second.actor, second.room, 'carry').ok).toBe(true);
    expect(rescueResident(crowdSmart, 'C', second.actor, second.room, 'carry').ok).toBe(true);

    expect(crowdLazy.rescued).toBe(2);
    expect(crowdLazy.lost).toBe(1);
    expect(crowdSmart.rescued).toBe(3);
    expect(crowdSmart.lost).toBe(0);
    expect(crowdLazy.rescued).not.toBe(crowdSmart.rescued);
    expect(second.b.rescued).toBe(true);
  });

  it('失去意识只能背，牵行会被拒绝', () => {
    const room = clearRoom();
    for (const cell of room.cells) cell.smoke = 1;

    const resident = createResident('r202', 0, 0, 'R');
    resident.health = 0;
    stepResident(resident, room, 0.1);
    expect(resident.mood).toBe('unconscious');

    const actor = createActor(0, 0);
    const crowd = createCrowd('r202', [resident], 3);

    const lead = rescueResident(crowd, 'R', actor, room, 'lead');
    expect(lead).toEqual({ ok: false, reason: 'unconscious-needs-carry', residentId: 'R' });
    expect(crowd.t).toBe(0);

    const carry = rescueResident(crowd, 'R', actor, room, 'carry');
    expect(carry.ok).toBe(true);
    expect(resident.rescued).toBe(true);
    expect(crowd.rescued).toBe(1);
  });

  it('健康归零但尚未 step 的居民也只能背', () => {
    const room = clearRoom();
    const resident = createResident('r202', 0, 0, 'R');
    resident.health = 0;
    resident.mood = 'calm';

    const actor = createActor(0, 0);
    const crowd = createCrowd('r202', [resident], 3);

    const lead = rescueResident(crowd, 'R', actor, room, 'lead');
    expect(lead).toEqual({ ok: false, reason: 'unconscious-needs-carry', residentId: 'R' });
    expect(crowd.t).toBe(0);

    const carry = rescueResident(crowd, 'R', actor, room, 'carry');
    expect(carry.ok).toBe(true);
    expect(resident.rescued).toBe(true);
  });

  it('无人救援时失败由系统产生：全部失去且记为 lost 事件', () => {
    const room = clearRoom();
    for (const cell of room.cells) cell.smoke = 1;

    const residents = [
      createResident('r202', -1.125, -0.375, 'R1'),
      createResident('r202', 0.375, 0.375, 'R2'),
      createResident('r202', 1.875, -0.375, 'R3'),
    ];
    const crowd = createCrowd('r202', residents, 5);

    // 满健康在 smoke=1 下约 20s 归零，再加 3s 宽限期；推进 30s 足够让所有人失去
    for (let i = 0; i < 60; i++) stepCrowd(crowd, room, 0.5);

    expect(crowd.lost).toBe(3);
    expect(crowd.rescued).toBe(0);
    expect(crowd.events.filter((event) => event.kind === 'lost')).toHaveLength(3);
  });

  it('玩家失去行动能力时任何救援都被拒绝', () => {
    const room = clearRoom();
    const resident = createResident('r202', 0, 0, 'R');
    const crowd = createCrowd('r202', [resident], 1);
    const actor = createActor(0, 0);
    actor.downed = true;

    expect(rescueResident(crowd, 'R', actor, room, 'carry')).toEqual({
      ok: false,
      reason: 'actor-downed',
      residentId: 'R',
    });
    expect(crowd.t).toBe(0);
  });

  it('候选优先级：健康差、距离近、id 小者优先，未发现的躲藏者不在列表', () => {
    const room = clearRoom();
    const actor = createActor(0, 0);

    const nearSick = createResident('r202', 0.1, 0, 'n-sick');
    nearSick.health = 0.3;
    const nearHealthy = createResident('r202', 0.15, 0, 'n-ok');
    nearHealthy.health = 0.9;
    const farHealthy = createResident('r202', 2, 0, 'f-ok');
    farHealthy.health = 0.9;
    const tieA = createResident('r202', 0.5, 0, 'a');
    tieA.health = 0.6;
    const tieB = createResident('r202', 0.5, 0, 'b');
    tieB.health = 0.6;
    const hiddenFar = createResident('r202', 2.5, 2.5, 'hidden-far');
    hiddenFar.hidden = true;
    const deadOne = createResident('r202', 0.2, 0, 'dead');
    deadOne.health = 0.1;
    deadOne.dead = true;
    const rescuedOne = createResident('r202', 0.2, 0.2, 'rescued');
    rescuedOne.rescued = true;

    const crowd = createCrowd(
      'r202',
      [farHealthy, nearHealthy, nearSick, tieB, tieA, hiddenFar, deadOne, rescuedOne],
      9
    );

    expect(survivorCandidates(crowd, actor).map((resident) => resident.id)).toEqual([
      'n-sick',
      'a',
      'b',
      'n-ok',
      'f-ok',
    ]);
  });

  it('同种子同输入得到完全一致的结果', () => {
    const run = (seed: number) => {
      const room = clearRoom();
      for (const cell of room.cells) cell.smoke = 0.2;

      const residents = [
        createResident('r202', -0.375, 0.375, 'A'),
        createResident('r202', 0.375, -0.375, 'B'),
        createResident('r202', 1.125, 0.375, 'C'),
      ];
      const crowd = createCrowd('r202', residents, seed);
      const actor = createActor(0, 0);

      rescueResident(crowd, 'A', actor, room, 'carry');
      for (let i = 0; i < 20; i++) stepCrowd(crowd, room, 0.5);

      return {
        panic: crowd.residents.map((resident) => resident.panic),
        health: crowd.residents.map((resident) => resident.health),
        rescued: crowd.rescued,
        lost: crowd.lost,
      };
    };

    expect(run(42)).toEqual(run(42));
    expect(run(42).panic).not.toEqual(run(7).panic);
  });

  it('未发现的躲藏者返回 not-found，可见但距离过远返回 too-far', () => {
    const room = clearRoom();
    const actor = createActor(-2.5, 0);

    const hiddenFar = createResident('r202', 2.5, 0, 'H');
    hiddenFar.hidden = true;
    const visibleFar = createResident('r202', 2.5, 0.1, 'V');

    const crowd = createCrowd('r202', [hiddenFar, visibleFar], 1);

    expect(rescueResident(crowd, 'H', actor, room, 'carry').reason).toBe('not-found');
    expect(rescueResident(crowd, 'V', actor, room, 'carry').reason).toBe('too-far');
    expect(crowd.t).toBe(0);
  });

  it('stepResident 宽限期：不足 3 秒未死，超过即死亡', () => {
    const room = clearRoom();
    for (const cell of room.cells) cell.smoke = 1;

    const resident = createResident('r202', 0, 0, 'R');
    resident.health = 0;

    for (let i = 0; i < 5; i++) stepResident(resident, room, 0.5);
    expect(resident.downedFor).toBeCloseTo(2.5, 6);
    expect(resident.dead).toBe(false);

    stepResident(resident, room, 0.5);
    expect(resident.dead).toBe(true);
    expect(resident.mood).toBe('unconscious');
  });
});
