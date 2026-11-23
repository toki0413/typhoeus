import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createRoomCam } from '../src/render/roomCam';
import { smokeLayerHeight, smokeVisibility } from '../src/render/smokeLayer';

describe('房间切镜', () => {
  it('进入新区域时硬切，区域内缓慢跟随', () => {
    const cam = createRoomCam();
    const first = { id: 'f1', target: new THREE.Vector3(0, 2, 1), zoom: 1.2 };
    cam.update(0.016, first);
    expect(cam.zone()).toBe('f1');
    expect(cam.cuts()).toBe(1);
    expect(cam.zoom).toBeCloseTo(1.2, 3);

    const same = { id: 'f1', target: new THREE.Vector3(2, 2, 1), zoom: 1.2 };
    cam.update(0.016, same);
    expect(cam.cuts()).toBe(1);
    // 目标只移动了一小段，说明是跟随而不是硬切
    expect(cam.offset.x).toBeGreaterThan(0);
    expect(cam.offset.x).toBeLessThan(2);

    const room = { id: 'room202', target: new THREE.Vector3(0.8, 4.25, -0.15), zoom: 1.8 };
    cam.update(0.016, room);
    expect(cam.zone()).toBe('room202');
    expect(cam.cuts()).toBe(2);
    expect(cam.zoom).toBeCloseTo(1.8, 3);
  });

  it('离开执行阶段回到全景', () => {
    const cam = createRoomCam();
    cam.update(0.016, { id: 'f2', target: new THREE.Vector3(0, 4.6, 1), zoom: 1.28 });
    cam.update(0.016, null);
    expect(cam.zone()).toBe('wide');
    expect(cam.zoom).toBe(1);
    expect(cam.offset.length()).toBe(0);
  });
});

describe('烟层遮挡', () => {
  it('烟越浓，烟层越低', () => {
    expect(smokeLayerHeight(0)).toBeGreaterThan(smokeLayerHeight(0.5));
    expect(smokeLayerHeight(0.5)).toBeGreaterThan(smokeLayerHeight(1));
  });

  it('低烟不遮挡，高烟产生明显压迫', () => {
    expect(smokeVisibility(0)).toBe(0);
    expect(smokeVisibility(0.3)).toBe(0);
    expect(smokeVisibility(1)).toBeGreaterThan(0.6);
  });
});
