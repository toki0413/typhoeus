import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createAgents } from '../src/render/agents';
import { createDoor } from '../src/render/door';
import { createSmoke } from '../src/render/smoke';
import { createWorld } from '../src/sim/world';

describe('渲染对象', () => {
  it('创建两个班组实例且更新不产生 NaN', () => {
    const scene = new THREE.Scene();
    const a = createAgents(scene);
    expect(a.mesh.count).toBe(2);
    a.update(createWorld('x'));
    const m = new THREE.Matrix4();
    a.mesh.getMatrixAt(0, m);
    expect(m.elements.every(Number.isFinite)).toBe(true);
    const m1 = new THREE.Matrix4();
    a.mesh.getMatrixAt(1, m1);
    expect(m1.elements.every(Number.isFinite)).toBe(true);
  });

  it('烟层有两条且随 smoke 改变高度', () => {
    const scene = new THREE.Scene();
    const sm = createSmoke(scene);
    expect(sm.group.children).toHaveLength(2);
    const s = createWorld('x');
    s.smoke[0] = 0.5;
    sm.update(s);
    expect((sm.group.children[0] as THREE.Mesh).scale.y).toBeCloseTo(0.5 * 2.6, 5);
  });

  it('开门后门扇旋转', () => {
    const scene = new THREE.Scene();
    const d = createDoor(scene);
    const s = createWorld('x');

    d.update(s);
    expect(d.mesh.rotation.y).toBe(0);

    s.door.opened = true;
    d.update(s);
    expect(d.mesh.rotation.y).toBeLessThan(0);
  });

  it('被困者救出后实例被缩到不可见', () => {
    const scene = new THREE.Scene();
    const a = createAgents(scene);
    const s = createWorld('x');
    s.victim.rescued = true;
    a.update(s);

    const m = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    a.mesh.getMatrixAt(1, m);
    m.decompose(pos, quat, scale);

    expect(scale.x).toBeLessThan(0.01);
    expect(scale.y).toBeLessThan(0.01);
  });
});
