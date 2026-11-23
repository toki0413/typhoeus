import { describe, it, expect } from 'vitest';
import { cellAt, createRoom } from '../src/sim/spatial/fields';
import { createToolLoadout } from '../src/sim/interaction/tools';
import { buildingToolActions } from '../src/app/buildingTools';

describe('建筑工具动作', () => {
  it('固定返回 5 个动作，id 与工具顺序稳定', () => {
    const actions = buildingToolActions(createRoom(), createToolLoadout());

    expect(actions.map((action) => action.verbId)).toEqual([
      'door-cool',
      'door-break',
      'window-vent',
      'fire-water',
      'fire-powder',
    ]);
    expect(actions.map((action) => action.tool)).toEqual([
      'hose',
      'axe',
      'fan',
      'hose',
      'extinguisher',
    ]);
    expect(actions.map((action) => action.label)).toEqual([
      '冷却门板',
      '破拆门',
      '排烟',
      '水枪压制',
      '干粉压制',
    ]);
  });

  it('门类动作指向门格，排烟指向房间中心', () => {
    const room = createRoom();
    const actions = buildingToolActions(room, createToolLoadout());
    const door = { x: room.openings.door.x, y: room.openings.door.y };
    const center = { x: room.config.cols / 2, y: room.config.rows / 2 };

    expect(actions[0].target).toEqual(door);
    expect(actions[1].target).toEqual(door);
    expect(actions[2].target).toEqual(center);
  });

  it('火源动作指向 fire 最大的格', () => {
    const room = createRoom();
    // 默认火源在 (5, 4)，火势 0.45，高于沙发与油桶。
    const actions = buildingToolActions(room, createToolLoadout());

    expect(cellAt(room, 5, 4).fire).toBeGreaterThan(cellAt(room, 2, 5).fire);
    expect(actions[3].target).toEqual({ x: 5, y: 4 });
    expect(actions[4].target).toEqual({ x: 5, y: 4 });
  });

  it('没有明火时火源动作退回中心并禁用', () => {
    const room = createRoom();
    for (const cell of room.cells) cell.fire = 0;

    const actions = buildingToolActions(room, createToolLoadout());
    const center = { x: room.config.cols / 2, y: room.config.rows / 2 };

    expect(actions[3].target).toEqual(center);
    expect(actions[4].target).toEqual(center);
    expect(actions[3].enabled).toBe(false);
    expect(actions[4].enabled).toBe(false);
  });

  it('余量反映 charge，用空或不足时禁用对应动作', () => {
    const loadout = createToolLoadout();
    loadout.hose.charge = 0.5;
    loadout.extinguisher.charge = 0.1;

    const actions = buildingToolActions(createRoom(), loadout);

    // 0.5 足够支付门板冷却与水枪压制。
    expect(actions[0].charge).toBe(0.5);
    expect(actions[0].enabled).toBe(true);
    expect(actions[3].charge).toBe(0.5);
    expect(actions[3].enabled).toBe(true);
    // 0.1 不足干粉压制所需的 0.12。
    expect(actions[4].charge).toBe(0.1);
    expect(actions[4].enabled).toBe(false);

    loadout.hose.charge = 0;
    loadout.hose.condition = 'empty';
    const emptyActions = buildingToolActions(createRoom(), loadout);
    expect(emptyActions[0].enabled).toBe(false);
    expect(emptyActions[3].enabled).toBe(false);
    // 未受影响的斧头仍可用。
    expect(emptyActions[1].enabled).toBe(true);
  });
});
