import { describe, it, expect } from 'vitest';
import { cellAt, createRoom, roomSummary } from '../src/sim/spatial/fields';
import { runRoom } from '../src/sim/spatial/spread';
import { spray } from '../src/sim/spatial/verbs';

describe('蒸汽反馈', () => {
  it('水打到高温表面会产生蒸汽，能见度下降', () => {
    const room = createRoom();
    const source = cellAt(room, 5, 4);
    source.heat = 0.95;
    source.fire = 0.7;

    const before = roomSummary(room);
    spray(room, 'water', 5, 4, { radius: 1, amount: 0.3 });
    runRoom(room, 1.5);
    const after = roomSummary(room);

    expect(after.steam).toBeGreaterThan(0.001);
    expect(after.visibility).toBeLessThan(before.visibility);
  });

  it('蒸汽会随时间散开，不会永久糊住能见度', () => {
    const room = createRoom();
    cellAt(room, 5, 4).heat = 0.95;
    cellAt(room, 5, 4).fire = 0.7;
    spray(room, 'water', 5, 4, { radius: 1, amount: 0.3 });
    runRoom(room, 1.5);
    const peak = roomSummary(room).steam;
    runRoom(room, 12);
    expect(roomSummary(room).steam).toBeLessThan(peak);
  });
});
