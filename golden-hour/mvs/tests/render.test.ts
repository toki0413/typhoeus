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

  it('烟层有两条且烟团随 smoke 出现', () => {
    const scene = new THREE.Scene();
    const sm = createSmoke(scene);
    expect(sm.group.children).toHaveLength(2);
    expect(sm.floors[0].children.length).toBeGreaterThan(0);

    const s = createWorld('x');
    s.smoke[0] = 0.5;
    sm.update(s);

    const sprite = sm.floors[0].children[0] as THREE.Sprite;
    expect(sprite.visible).toBe(true);
    expect((sprite.material as THREE.SpriteMaterial).opacity).toBeGreaterThan(0);
    expect(sprite.position.y).toBeGreaterThanOrEqual(0.2);
    expect(sprite.position.y).toBeLessThanOrEqual(3);
  });

  it('无烟时烟团隐藏', () => {
    const scene = new THREE.Scene();
    const sm = createSmoke(scene);
    const s = createWorld('x');
    sm.update(s);
    expect((sm.floors[0].children[0] as THREE.Sprite).visible).toBe(false);
  });

  it('开门后门扇绕铰链渐进旋转', () => {
    const scene = new THREE.Scene();
    const d = createDoor(scene);
    const s = createWorld('x');

    d.update(s);
    expect(d.group.rotation.y).toBeCloseTo(0, 5);

    s.door.opened = true;
    for (let i = 0; i < 40; i++) d.update(s);
    expect(d.group.rotation.y).toBeGreaterThan(1.2);
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
