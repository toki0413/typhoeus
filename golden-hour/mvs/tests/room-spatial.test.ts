import { describe, it, expect } from 'vitest';
import {
  cellAt,
  computeBackdraftRisk,
  createRoom,
  isFuelRich,
  roomSummary,
  type RoomState,
} from '../src/sim/spatial/fields';
import { runRoom, stepRoom } from '../src/sim/spatial/spread';
import {
  TOOL_CONDITION_FACTOR,
  inspectTool,
  isolate,
  measureOpening,
  openOpening,
  spray,
} from '../src/sim/spatial/verbs';
import {
  agentEffect,
  agentHazard,
  safeAgents,
} from '../src/sim/spatial/agents';
import { IMPROVISED, cutPower, improvisedFor, useImprovised } from '../src/sim/spatial/improvised';

function smolder(seconds = 40): RoomState {
  const room = createRoom();
  runRoom(room, seconds);
  return room;
}

describe('Phase 0 · 单房间场模型', () => {
  it('闷烧会耗尽氧气、积累烟与热，进入富燃料状态', () => {
    const room = smolder(40);
    const s = roomSummary(room);
    expect(s.oxygen).toBeLessThan(0.35);
    expect(s.smoke).toBeGreaterThan(0.6);
    expect(room.openings.door.temp).toBeGreaterThan(0.3);
    expect(isFuelRich(room)).toBe(true);
    expect(computeBackdraftRisk(room)).toBeGreaterThan(0.6);
  });

  it('闷烧后直接开门会回燃', () => {
    const room = smolder(40);
    const res = openOpening(room, 'door');
    expect(res.backdraft).toBe(true);
    runRoom(room, 2);
    expect(room.backdraftAt).not.toBeNull();
    expect(room.stats.peakHeat).toBeGreaterThan(0.9);
  });

  it('解法一：先冷却门再开门，不回燃', () => {
    const room = smolder(40);
    for (let i = 0; i < 6; i++) {
      spray(room, 'water', 0, 4, { radius: 1, amount: 0.2 });
    }
    runRoom(room, 4);
    expect(measureOpening(room, 'door').band).not.toBe('hot');
    const res = openOpening(room, 'door');
    expect(res.backdraft).toBe(false);
    runRoom(room, 3);
    expect(room.backdraftAt).toBeNull();
  });

  it('解法二：先开窗排烟再开门，不回燃', () => {
    const room = smolder(40);
    openOpening(room, 'window');
    runRoom(room, 30);
    expect(roomSummary(room).smoke).toBeLessThan(0.5);
    const res = openOpening(room, 'door');
    expect(res.backdraft).toBe(false);
  });

  it('三条路线的场演化不同，且可解释', () => {
    const direct = smolder(40);
    openOpening(direct, 'door');
    runRoom(direct, 2);

    const cooled = smolder(40);
    for (let i = 0; i < 6; i++) spray(cooled, 'water', 0, 4, { radius: 1, amount: 0.2 });
    runRoom(cooled, 4);
    openOpening(cooled, 'door');
    runRoom(cooled, 2);

    expect(direct.backdraftAt).not.toBeNull();
    expect(cooled.backdraftAt).toBeNull();
    expect(direct.stats.peakHeat).toBeGreaterThan(cooled.stats.peakHeat);
    expect(cooled.stats.waterUsed).toBeGreaterThan(0);
  });

  it('水能压灭 A 类沙发火源', () => {
    const room = createRoom();
    runRoom(room, 10);
    for (let i = 0; i < 8; i++) {
      spray(room, 'water', 5, 4, { radius: 2, amount: 0.2 });
      runRoom(room, 1);
    }
    expect(cellAt(room, 5, 4).fire).toBeLessThan(0.05);
  });

  it('水对 B 类油火会飞溅反噬，并给出危险解释', () => {
    const room = createRoom();
    runRoom(room, 10);
    const before = cellAt(room, 2, 5).fire;
    const res = spray(room, 'water', 2, 5, { radius: 1, amount: 0.3 });
    expect(res.misagent).toBe(true);
    expect(cellAt(room, 2, 5).fire).toBeGreaterThan(before);
    expect(res.lesson).toContain('危险');
  });

  it('干粉对 B 类油火有效', () => {
    const room = createRoom();
    runRoom(room, 10);
    const before = cellAt(room, 2, 5).fire;
    const res = spray(room, 'dryPowder', 2, 5, { radius: 1, amount: 0.3 });
    expect(res.misagent).toBe(false);
    expect(cellAt(room, 2, 5).fire).toBeLessThan(before);
  });
});

describe('Phase 0 · 器材状态与就地取材', () => {
  it('过期器材仍能按但效率大幅下降', () => {
    const fresh = createRoom();
    const stale = createRoom();
    stale.tools.dryPowder.condition = 'expired';

    const oil = (room: RoomState) => {
      const cell = cellAt(room, 2, 5);
      cell.fire = 0.6;
      cell.fuel = 1;
      return room;
    };
    oil(fresh);
    oil(stale);

    const a = spray(fresh, 'dryPowder', 2, 5, { radius: 1, amount: 0.3 });
    const b = spray(stale, 'dryPowder', 2, 5, { radius: 1, amount: 0.3 });

    expect(TOOL_CONDITION_FACTOR.expired).toBeLessThan(TOOL_CONDITION_FACTOR.ok);
    expect(b.effect).toBeLessThan(a.effect * 0.5);
    expect(inspectTool(stale, 'dryPowder').advice).toContain('有效期');
  });

  it('用空的器材直接拒绝，并提示换手段', () => {
    const room = createRoom();
    room.tools.water.charge = 0;
    const res = spray(room, 'water', 5, 4);
    expect(res.ok).toBe(false);
    expect(res.outOfAgent).toBe(true);
    expect(res.lesson).toContain('空');
  });

  it('湿棉被能压 A 类小火，对 B 类油火无效且助燃', () => {
    const room = createRoom();

    const solid = cellAt(room, 4, 2);
    solid.fireClass = 'A';
    solid.fire = 0.4;
    solid.fuel = 1;
    const ok = useImprovised(room, 'wetBlanket', 4, 2);
    expect(ok.ok).toBe(true);
    expect(solid.fire).toBeLessThan(0.4);

    const oil = cellAt(room, 2, 5);
    oil.fire = 0.3;
    const before = oil.fire;
    const bad = useImprovised(room, 'wetBlanket', 2, 5);
    expect(bad.ok).toBe(false);
    expect(oil.fire).toBeGreaterThan(before);
    expect(bad.lesson).toContain('无效');
  });

  it('锅盖对 F 类、食盐对 D 类有效', () => {
    const room = createRoom();

    const pan = cellAt(room, 4, 2);
    pan.fireClass = 'F';
    pan.fire = 0.4;
    pan.fuel = 1;
    useImprovised(room, 'potLid', 4, 2);
    expect(pan.fire).toBeLessThan(0.1);

    const metal = cellAt(room, 4, 6);
    metal.fireClass = 'D';
    metal.fire = 0.5;
    metal.fuel = 1;
    useImprovised(room, 'salt', 4, 6);
    expect(metal.fire).toBeLessThan(0.2);
  });

  it('E 类带电火：先断电，之后才能按 A 类处置', () => {
    const room = createRoom();
    const panel = cellAt(room, 2, 2);
    panel.fireClass = 'E';
    panel.fire = 0.3;
    panel.fuel = 0.4;
    expect(agentHazard('water', 'E')).toBeGreaterThan(0.5);

    const cut = cutPower(room);
    expect(cut).toBe(1);
    expect(panel.fireClass).toBe('A');
  });

  it('没有对应灭火剂时，能列出就地取材的替代方案', () => {
    expect(safeAgents('D')).toEqual(['sand']);
    expect(improvisedFor('D')).toContain('salt');
    expect(improvisedFor('B')).toContain('closeDoor');
    expect(agentEffect('water', 'B')).toBe(0);
    expect(IMPROVISED.closeDoor.lesson).toContain('烟');
  });

  it('关门断氧：所有开口关闭，回燃挂起被取消', () => {
    const room = smolder(40);
    openOpening(room, 'window');
    isolate(room);
    expect(room.openings.door.open).toBe(false);
    expect(room.openings.window.open).toBe(false);
    expect(room.pendingBackdraft).toBe(false);
  });
});

describe('Phase 0 · 确定性与步长', () => {
  it('同一初始状态推进同样的步数，结果完全一致', () => {
    const a = createRoom();
    const b = createRoom();
    for (let i = 0; i < 200; i++) {
      stepRoom(a, 0.1);
      stepRoom(b, 0.1);
    }
    expect(a.cells.map((c) => c.fire)).toEqual(b.cells.map((c) => c.fire));
    expect(a.cells.map((c) => c.smoke)).toEqual(b.cells.map((c) => c.smoke));
    expect(a.openings.door.temp).toBeCloseTo(b.openings.door.temp, 10);
  });

  it('不同解法产生不同的可解释结果', () => {
    const vent = smolder(40);
    openOpening(vent, 'window');
    runRoom(vent, 30);
    const vented = roomSummary(vent);

    const fight = smolder(40);
    for (let i = 0; i < 8; i++) {
      spray(fight, 'water', 5, 4, { radius: 2, amount: 0.2 });
      spray(fight, 'dryPowder', 2, 5, { radius: 1, amount: 0.2 });
      runRoom(fight, 1);
    }
    const fought = roomSummary(fight);

    // 排烟路线：烟更低；灭火路线：火更低。
    expect(vented.smoke).toBeLessThan(0.6);
    expect(fought.fire).toBeLessThan(0.03);
    expect(vented.smoke).not.toBeCloseTo(fought.smoke, 2);
  });
});
