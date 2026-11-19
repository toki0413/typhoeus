import * as THREE from 'three';
import type { SimState } from '../sim/types';
import { FLOOR_H } from './constants';

export function createSmoke(scene: THREE.Scene): {
  update: (s: SimState) => void;
  group: THREE.Group;
} {
  const group = new THREE.Group();
  scene.add(group);

  const boxes: THREE.Mesh[] = [];
  for (let f = 0; f < 2; f++) {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(24, 1, 12),
      new THREE.MeshBasicMaterial({
        color: 0x9aa3ad,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      })
    );
    m.position.set(0, f * FLOOR_H + 0.5, 0);
    group.add(m);
    boxes.push(m);
  }

  return {
    group,
    update(s: SimState) {
      for (let f = 0; f < 2; f++) {
        const v = s.smoke[f];
        const h = Math.max(0.02, v * 2.6);
        boxes[f].scale.y = h;
        boxes[f].position.y = f * FLOOR_H + h / 2 + 0.15;
        (boxes[f].material as THREE.MeshBasicMaterial).opacity = v * 0.34;
      }
    },
  };
}
