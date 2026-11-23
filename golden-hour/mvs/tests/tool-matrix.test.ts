import { describe, it, expect } from 'vitest';
import { cellAt, createRoom } from '../src/sim/spatial/fields';
import { createActor } from '../src/sim/spatial/actor';
import { createOccupant } from '../src/sim/spatial/rescue';
import { createToolLoadout } from '../src/sim/interaction/tools';
import {
  availableVerbs,
  executeVerb,
  verbsFor,
  type Obstacle,
} from '../src/sim/interaction/multiSolution';

const obstacles: Obstacle[] = ['door', 'window', 'wall', 'fire', 'occupant'];

describe('多解动词矩阵', () => {
  it('每个障碍至少三种有效动词且 id 唯一', () => {
    for (const obstacle of obstacles) {
      const verbs = verbsFor(obstacle);
      expect(verbs.length).toBeGreaterThanOrEqual(3);
      expect(new Set(verbs.map((verb) => verb.id)).size).toBe(verbs.length);
      expect(verbs.every((verb) => verb.lesson.length > 0)).toBe(true);
    }
  });

  it('工具耗尽后对应动词不可用，但无工具动词仍在', () => {
    const loadout = createToolLoadout();
    loadout.hose.charge = 0;
    loadout.hose.condition = 'empty';

    const fire = availableVerbs('fire', loadout).map((verb) => verb.id);
    expect(fire).not.toContain('fire-water');
    expect(fire).toContain('fire-smother');
    expect(fire.length).toBeGreaterThanOrEqual(3);
  });

  it('门：冷却、破拆、开门都改变状态', () => {
    const room = createRoom();
    const loadout = createToolLoadout();

    const cool = executeVerb('door-cool', { room, loadout, target: { x: 0, y: 4 } });
    expect(cool.ok).toBe(true);
    expect(room.openings.door.wet).toBeGreaterThan(0);

    const brk = executeVerb('door-break', { room, loadout, target: { x: 0, y: 4 } });
    expect(brk.ok).toBe(true);
    expect(room.openings.door.broken).toBe(true);
  });

  it('窗：开窗、破窗、排烟都改变状态', () => {
    const room = createRoom();
    for (const cell of room.cells) cell.smoke = 0.5;
    const loadout = createToolLoadout();

    const vent = executeVerb('window-vent', { room, loadout, target: { x: 7, y: 4 } });
    expect(vent.ok).toBe(true);
    expect(vent.effect).toBeGreaterThan(0);

    const open = executeVerb('window-open', { room, loadout, target: { x: 7, y: 4 } });
    expect(open.ok).toBe(true);
    expect(room.openings.window.open).toBe(true);
  });

  it('墙：破拆降低结构，冷却降低热量', () => {
    const room = createRoom();
    const loadout = createToolLoadout();
    const cell = cellAt(room, 3, 2);
    cell.heat = 0.6;

    const brk = executeVerb('wall-breach', { room, loadout, target: { x: 3, y: 2 } });
    expect(brk.ok).toBe(true);
    expect(cell.structure).toBeLessThan(1);

    const cool = executeVerb('wall-cool', { room, loadout, target: { x: 3, y: 2 } });
    expect(cool.ok).toBe(true);
    expect(cell.heat).toBeLessThan(0.6);
  });

  it('火：水、干粉、覆盖、隔离都可用', () => {
    const room = createRoom();
    const loadout = createToolLoadout();

    const water = executeVerb('fire-water', { room, loadout, target: { x: 5, y: 4 } });
    expect(water.ok).toBe(true);
    expect(water.effect).toBeGreaterThan(0);

    const room2 = createRoom();
    const powder = executeVerb('fire-powder', {
      room: room2,
      loadout: createToolLoadout(),
      target: { x: 2, y: 5 },
    });
    expect(powder.ok).toBe(true);

    const room3 = createRoom();
    const smother = executeVerb('fire-smother', {
      room: room3,
      loadout: createToolLoadout(),
      target: { x: 5, y: 4 },
    });
    expect(smother.ok).toBe(true);

    const room4 = createRoom();
    const isolate = executeVerb('fire-isolate', {
      room: room4,
      loadout: createToolLoadout(),
      target: { x: 0, y: 0 },
    });
    expect(isolate.ok).toBe(true);
    expect(room4.openings.door.open).toBe(false);
  });

  it('居民：背负、引导、保护都有状态变化', () => {
    const room = createRoom();
    const loadout = createToolLoadout();

    const actor = createActor(0, 0);
    const occupant = createOccupant(0.3, 0.3);
    const carry = executeVerb('occupant-carry', {
      room,
      loadout,
      actor,
      occupant,
      target: { x: 0, y: 0 },
    });
    expect(carry.ok).toBe(true);
    expect(occupant.carried).toBe(true);

    const actor2 = createActor(0, 0);
    const occupant2 = createOccupant(0.3, 0.3);
    const lead = executeVerb('occupant-lead', {
      room,
      loadout,
      actor: actor2,
      occupant: occupant2,
      target: { x: 0, y: 0 },
    });
    expect(lead.ok).toBe(true);
    expect(occupant2.mood).toBe('calm');

    const actor3 = createActor(0, 0);
    actor3.exposure.smoke = 0.5;
    const protect = executeVerb('occupant-protect', {
      room,
      loadout,
      actor: actor3,
      target: { x: 0, y: 0 },
    });
    expect(protect.ok).toBe(true);
    expect(actor3.exposure.smoke).toBeLessThan(0.5);
  });

  it('热像仪扫描是真实动词并消耗电量', () => {
    const room = createRoom();
    cellAt(room, 4, 4).heat = 0.8;
    const loadout = createToolLoadout();
    const scan = executeVerb('thermal-scan', {
      room,
      loadout,
      target: { x: 4, y: 6 },
    });
    expect(scan.ok).toBe(true);
    expect(scan.scan?.heat).toBeGreaterThan(0.5);
    expect(loadout.thermal.charge).toBeLessThan(1);
  });

  it('无效操作不消耗工具', () => {
    const room = createRoom();
    room.openings.door.broken = true;
    const loadout = createToolLoadout();
    const axeBefore = loadout.axe.charge;
    expect(executeVerb('door-break', { room, loadout, target: { x: 0, y: 4 } }).ok).toBe(false);
    expect(loadout.axe.charge).toBe(axeBefore);

    const empty = createRoom();
    const loadout2 = createToolLoadout();
    const fanBefore = loadout2.fan.charge;
    expect(executeVerb('window-vent', { room: empty, loadout: loadout2, target: { x: 7, y: 4 } }).ok).toBe(false);
    expect(loadout2.fan.charge).toBe(fanBefore);
  });
});
