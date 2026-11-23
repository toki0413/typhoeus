import { describe, it, expect } from 'vitest';
import { cellAt, createRoom } from '../src/sim/spatial/fields';
import { breachCell, thermalScan, ventSmoke } from '../src/sim/interaction/special';

describe('特殊工具', () => {
  it('热像仪能读到隔墙后的热区', () => {
    const room = createRoom();
    const hot = cellAt(room, 4, 4);
    hot.heat = 0.8;
    hot.fuel = 0.5;

    const scan = thermalScan(room, 4, 6, 0, -1);
    expect(scan.heat).toBeGreaterThan(0.5);
    expect(scan.throughWall).toBe(true);
    expect(scan.fuel).toBeGreaterThan(0);
  });

  it('排烟机把烟推向相邻格', () => {
    const room = createRoom();
    const source = cellAt(room, 4, 4);
    const target = cellAt(room, 4, 3);
    source.smoke = 0.8;
    target.smoke = 0;

    const moved = ventSmoke(room, 4, 4, 0, -1, 0.5);
    expect(moved).toBeGreaterThan(0);
    expect(source.smoke).toBeLessThan(0.8);
    expect(target.smoke).toBeGreaterThan(0);
  });

  it('破拆到阈值后可打通', () => {
    const room = createRoom();
    const cell = cellAt(room, 3, 2);
    cell.structure = 0.4;

    const result = breachCell(room, 3, 2, 0.15);
    expect(result.ready).toBe(true);
    expect(cell.structure).toBeCloseTo(0.25, 10);
  });

  it('空房间扫描不误报隔墙热点', () => {
    const room = createRoom();
    const scan = thermalScan(room, 4, 6, 0, -1);
    expect(scan.throughWall).toBe(false);
    expect(scan.heat).toBeLessThanOrEqual(0.05);
  });
});
