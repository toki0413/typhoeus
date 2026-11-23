import { describe, it, expect } from 'vitest';
import { createRoom } from '../src/sim/spatial/fields';
import { FIXED_DT, stepRoom } from '../src/sim/spatial/spread';

describe('火场步进性能', () => {
  it('单房间平均单步低于 1ms', () => {
    const room = createRoom();

    // 先预热，避免首次分配与 JIT 影响计时。
    for (let i = 0; i < 100; i++) stepRoom(room, FIXED_DT);

    const t0 = room.t;
    const start = performance.now();
    for (let i = 0; i < 1000; i++) stepRoom(room, FIXED_DT);
    const perStep = (performance.now() - start) / 1000;

    // 只断言上限，不依赖具体机器的墙钟绝对值。
    expect(perStep).toBeLessThan(1);
    expect(room.t - t0).toBeCloseTo(1000 * FIXED_DT, 5);
  });
});
