import { describe, it, expect } from 'vitest';
import { startBuildingFrame } from '../src/app/buildingFrame';

/** 假 RAF：手动推进帧回调，便于断言节流与步长。 */
function harness(now = 0) {
  const queue: ((time: number) => void)[] = [];
  const updates: number[] = [];
  const renders: number[] = [];
  const huds: number[] = [];
  const handle = startBuildingFrame(
    {
      update: (dt) => updates.push(dt),
      render: () => renders.push(1),
      hud: (t) => huds.push(t),
    },
    {
      raf: (callback) => {
        queue.push(callback);
        return queue.length;
      },
      now: () => now,
    }
  );
  return { queue, updates, renders, huds, handle };
}

describe('建筑主循环', () => {
  it('启动后立即排一帧，并按时间差传步长', () => {
    const h = harness(0);
    expect(h.queue).toHaveLength(1);
    h.queue.shift()!(16);
    expect(h.updates[0]).toBeCloseTo(0.016, 3);
    expect(h.renders).toHaveLength(1);
    expect(h.queue).toHaveLength(1);
  });

  it('超长间隔按最大步长截断', () => {
    const h = harness(0);
    h.queue.shift()!(1000);
    expect(h.updates[0]).toBe(0.05);
  });

  it('HUD 按约 10Hz 节流', () => {
    const h = harness(0);
    h.queue.shift()!(50);
    expect(h.huds).toHaveLength(0);
    h.queue.shift()!(120);
    expect(h.huds).toEqual([120]);
    h.queue.shift()!(180);
    expect(h.huds).toHaveLength(1);
    h.queue.shift()!(240);
    expect(h.huds).toEqual([120, 240]);
  });

  it('停止后不再继续排帧', () => {
    const h = harness(0);
    h.handle.stop();
    h.queue.shift()!(16);
    expect(h.updates).toHaveLength(0);
    expect(h.queue).toHaveLength(0);
  });
});
