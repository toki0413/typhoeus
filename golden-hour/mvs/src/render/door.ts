import * as THREE from 'three';
import type { SimState } from '../sim/types';

export function createDoor(scene: THREE.Scene): {
  mesh: THREE.Mesh;
  update: (s: SimState) => void;
} {
  const material = new THREE.MeshStandardMaterial({
    color: 0x6b4a2c,
    roughness: 0.7,
    emissive: 0x341c08,
    emissiveIntensity: 0.6,
  });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.4, 2.1, 0.16), material);
  mesh.position.set(4.4, 4.05, 6.9);
  scene.add(mesh);

  return {
    mesh,
    update(s: SimState) {
      const near = 1 - Math.min(1, Math.abs(s.t - 40) / 12);
      material.emissiveIntensity = 0.5 + near * 1.2;
      mesh.rotation.y = s.door.opened ? -Math.PI / 2 : 0;
    },
  };
}
