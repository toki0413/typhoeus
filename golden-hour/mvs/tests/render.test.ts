import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createAgents } from '../src/render/agents';
import { createDoor } from '../src/render/door';
import { createSmoke } from '../src/render/smoke';
import { createFireGlow } from '../src/render/fire';
import { createWorld } from '../src/sim/world';

describe('渲染对象', () => {
  it('班组与被困者位置更新不产生 NaN', () => {
    const scene = new THREE.Scene();
    const a = createAgents(scene);
    const s = createWorld('x');
    s.phase = 'execute';
    s.crew.order = { kind: 'search', floor: 1 };

    for (let i = 0; i < 60; i++) {
      s.t += 0.05;
      s.crew.progress = (s.crew.progress + 0.01) % 1;
      a.update(s);
    }

    expect(Number.isFinite(a.crew.position.y)).toBe(true);
    expect(a.crew.position.y).toBeGreaterThan(0);
    expect(a.group.children).toHaveLength(2);
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
    expect(d.getAngle()).toBeCloseTo(d.group.rotation.y, 5);
  });

  it('火光与点光源随火势增强', () => {
    const scene = new THREE.Scene();
    const glow = createFireGlow(scene);
    const s = createWorld('x');

    s.fire = 0.05;
    glow.update(s);
    const low = glow.light.intensity;
    const lowOpacity = (glow.sprite.material as THREE.SpriteMaterial).opacity;

    s.fire = 0.9;
    glow.update(s);
    expect(glow.light.intensity).toBeGreaterThan(low);
    expect((glow.sprite.material as THREE.SpriteMaterial).opacity).toBeGreaterThan(lowOpacity);
    expect(Number.isFinite(glow.light.intensity)).toBe(true);
  });

  it('被困者救出后隐藏', () => {
    const scene = new THREE.Scene();
    const a = createAgents(scene);
    const s = createWorld('x');
    s.victim.rescued = true;
    a.update(s);
    expect(a.victim.visible).toBe(false);

    s.victim.rescued = false;
    a.update(s);
    expect(a.victim.visible).toBe(true);
  });
});
