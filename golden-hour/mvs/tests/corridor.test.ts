import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createCorridorDetails } from '../src/render/corridor';

describe('楼道细节', () => {
  it('加入场景并合并成少量网格', () => {
    const scene = new THREE.Scene();
    const details = createCorridorDetails(scene);
    expect(scene.children).toContain(details.group);
    expect(details.group.children.length).toBeGreaterThanOrEqual(5);
  });

  it('包含明线这样的线对象', () => {
    const scene = new THREE.Scene();
    const details = createCorridorDetails(scene);
    const lines = details.group.children.filter((child) => (child as THREE.Line).isLine);
    expect(lines.length).toBeGreaterThanOrEqual(1);
  });
});
