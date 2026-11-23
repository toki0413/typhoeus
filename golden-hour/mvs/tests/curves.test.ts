import { describe, it, expect } from 'vitest';
import { buildCurvePaths, type CurveSample } from '../src/eval/curves';

/** 从路径里抽出所有点的 x、y 坐标。 */
function points(path: string): { x: number; y: number }[] {
  return [...path.matchAll(/[ML] (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map(
    (match) => ({ x: Number(match[1]), y: Number(match[2]) })
  );
}

describe('暴露曲线路径', () => {
  it('空数据没有曲线', () => {
    const set = buildCurvePaths([]);

    expect(set.hasData).toBe(false);
    expect(set.minT).toBe(0);
    expect(set.maxT).toBe(0);
    expect(set.smoke).toBe('');
    expect(set.heat).toBe('');
    expect(set.fire).toBe('');
  });

  it('两点从左侧走到右侧，纵向落在内边距内', () => {
    const set = buildCurvePaths([
      { t: 0, smoke: 0, heat: 0 },
      { t: 10, smoke: 1, heat: 1 },
    ]);
    const pts = points(set.smoke);

    expect(set.hasData).toBe(true);
    expect(set.smoke.startsWith('M ')).toBe(true);
    expect(pts).toHaveLength(2);
    expect(pts[0].x).toBe(set.padding);
    expect(pts[1].x).toBe(set.width - set.padding);
    for (const pt of pts) {
      expect(pt.y).toBeGreaterThanOrEqual(set.padding);
      expect(pt.y).toBeLessThanOrEqual(set.height - set.padding);
    }
    // 数值越大越靠上。
    expect(pts[1].y).toBeLessThan(pts[0].y);
  });

  it('超出 0–1 的数值被夹在边界内', () => {
    const set = buildCurvePaths([
      { t: 0, smoke: -1, heat: 2 },
      { t: 5, smoke: 2, heat: -1 },
    ]);

    for (const path of [set.smoke, set.heat]) {
      for (const pt of points(path)) {
        expect(pt.y).toBeGreaterThanOrEqual(set.padding);
        expect(pt.y).toBeLessThanOrEqual(set.height - set.padding);
      }
    }
  });

  it('乱序时间被排序，横坐标单调不减', () => {
    const set = buildCurvePaths([
      { t: 30, smoke: 0.3, heat: 0.2 },
      { t: 10, smoke: 0.1, heat: 0.1 },
      { t: 20, smoke: 0.2, heat: 0.15 },
    ]);
    const xs = points(set.smoke).map((pt) => pt.x);

    expect(set.minT).toBe(10);
    expect(set.maxT).toBe(30);
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1]);
    }
  });

  it('烟与热数值不同时路径也不同', () => {
    const set = buildCurvePaths([
      { t: 0, smoke: 0, heat: 0.6 },
      { t: 10, smoke: 1, heat: 0.2 },
    ]);

    expect(set.smoke).not.toBe(set.heat);
  });

  it('单点也有非空曲线，时间上下界相等', () => {
    const set = buildCurvePaths([{ t: 12, smoke: 0.5, heat: 0.4 }]);

    expect(set.hasData).toBe(true);
    expect(set.minT).toBe(12);
    expect(set.maxT).toBe(12);
    expect(set.smoke).not.toBe('');
    for (const pt of points(set.smoke)) {
      expect(pt.x).toBe(set.padding);
    }
  });
});
