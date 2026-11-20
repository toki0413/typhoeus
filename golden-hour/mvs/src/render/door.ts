import * as THREE from 'three';
import type { SimState } from '../sim/types';

export function createDoor(scene: THREE.Scene): {
  group: THREE.Group;
  mesh: THREE.Mesh;
  getAngle: () => number;
  update: (s: SimState) => void;
} {
  const group = new THREE.Group();
  group.position.set(3.7, 4.05, 6.9);
  scene.add(group);

  const material = new THREE.MeshStandardMaterial({
    color: 0x6b4a2c,
    roughness: 0.7,
    emissive: 0x341c08,
    emissiveIntensity: 0.6,
  });

  // 门板挂在铰链上：本地 x 偏移半个门宽
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.4, 2.1, 0.16), material);
  mesh.position.set(0.7, 0, 0);
  group.add(mesh);

  let angle = 0;

  return {
    group,
    mesh,
    getAngle: () => angle,
    update(s: SimState) {
      const target = s.door.opened ? Math.PI / 2 : 0;
      angle += (target - angle) * 0.18;
      group.rotation.y = angle;

      const active = s.crew.atDoor && !s.door.opened;
      material.emissiveIntensity = active ? 0.9 + Math.sin(s.t * 6) * 0.35 : 0.35;
    },
  };
}
