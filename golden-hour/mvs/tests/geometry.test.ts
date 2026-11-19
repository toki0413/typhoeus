import { describe, it, expect } from 'vitest';
import { buildStaticGeometry } from '../src/render/scene';

describe('静态几何', () => {
  it('所有建筑构件被合并成一个几何体', () => {
    const g = buildStaticGeometry();
    expect(g.attributes.position.count).toBeGreaterThan(400);
  });

  it('两层楼板都在几何体内', () => {
    const g = buildStaticGeometry();
    g.computeBoundingBox();
    const box = g.boundingBox!;
    expect(box.min.y).toBeLessThanOrEqual(-0.1);
    expect(box.max.y).toBeGreaterThanOrEqual(6);
  });
});
