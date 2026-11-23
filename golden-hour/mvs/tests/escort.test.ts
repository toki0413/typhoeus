import { describe, it, expect } from 'vitest';
import { createRoom, type RoomState } from '../src/sim/spatial/fields';
import { createActor } from '../src/sim/spatial/actor';
import { createResident } from '../src/sim/agents/resident';
import {
  CONFIRM_RADIUS,
  ZONE_EXIT,
  confirmResident,
  createCrowd,
  escortResident,
  rescueResident,
} from '../src/sim/agents/crowd';

/** 清空全房烟热与火源，避免默认火源干扰带离/确认的状态断言。 */
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

/** 居民站在原点、玩家也在原点：先满足牵/背的距离条件。 */
function setup() {
  const room = clearRoom();
  const resident = createResident('r202', 0, 0, 'R');
  const crowd = createCrowd('r202', [resident], 1);
  const actor = createActor(0, 0);
  return { room, resident, crowd, actor };
}

describe('逐名确认护送', () => {
  it('带离成功：只标记 escorted，不计入获救并清除躲藏', () => {
    const { room, resident, crowd, actor } = setup();
    resident.hidden = true;

    const result = escortResident(crowd, 'R', actor, room, 'lead');

    expect(result).toEqual({ ok: true, reason: 'ok', residentId: 'R' });
    expect(resident.escorted).toBe(true);
    expect(resident.rescued).toBe(false);
    expect(resident.carried).toBe(false);
    expect(resident.hidden).toBe(false);
    expect(crowd.rescued).toBe(0);
  });

  it('已带离的居民再次带离返回 already-escorted', () => {
    const { room, resident, crowd, actor } = setup();
    resident.escorted = true;

    expect(escortResident(crowd, 'R', actor, room, 'carry')).toEqual({
      ok: false,
      reason: 'already-escorted',
      residentId: 'R',
    });
  });

  it('未带离直接确认返回 not-escorted', () => {
    const { resident, crowd, actor } = setup();
    expect(resident.escorted).toBe(false);
    actor.x = ZONE_EXIT.x;
    actor.z = ZONE_EXIT.z;

    expect(confirmResident(crowd, 'R', actor)).toEqual({
      ok: false,
      reason: 'not-escorted',
      residentId: 'R',
    });
  });

  it('带离后玩家远离出口确认返回 too-far', () => {
    const { room, crowd, actor } = setup();
    expect(escortResident(crowd, 'R', actor, room, 'carry').ok).toBe(true);

    // 仍在房间里，距出口超过确认半径
    expect(Math.hypot(actor.x - ZONE_EXIT.x, actor.z - ZONE_EXIT.z)).toBeGreaterThan(
      CONFIRM_RADIUS
    );
    expect(confirmResident(crowd, 'R', actor).reason).toBe('too-far');
  });

  it('走到出口附近确认：转为已救出并累计 crowd.rescued', () => {
    const { room, resident, crowd, actor } = setup();
    expect(escortResident(crowd, 'R', actor, room, 'carry').ok).toBe(true);

    actor.x = ZONE_EXIT.x;
    actor.z = ZONE_EXIT.z;
    const result = confirmResident(crowd, 'R', actor);

    expect(result).toEqual({ ok: true, reason: 'ok', residentId: 'R' });
    expect(resident.rescued).toBe(true);
    expect(resident.escorted).toBe(false);
    expect(crowd.rescued).toBe(1);
  });

  it('已死亡的居民带离与确认都返回 lost', () => {
    const { room, resident, crowd, actor } = setup();
    resident.dead = true;

    expect(escortResident(crowd, 'R', actor, room, 'carry').reason).toBe('lost');
    actor.x = ZONE_EXIT.x;
    actor.z = ZONE_EXIT.z;
    expect(confirmResident(crowd, 'R', actor).reason).toBe('lost');
  });

  it('原有 rescueResident 仍一次计入获救', () => {
    const { room, resident, crowd, actor } = setup();

    const result = rescueResident(crowd, 'R', actor, room, 'carry');

    expect(result.ok).toBe(true);
    expect(resident.rescued).toBe(true);
    expect(resident.escorted).toBe(false);
    expect(crowd.rescued).toBe(1);
  });
});
