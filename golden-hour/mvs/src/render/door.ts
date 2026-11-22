import * as THREE from 'three';
import type { SimState } from '../sim/types';
import { metalTexture, woodTexture } from './textures';

export function createDoor(scene: THREE.Scene): {
  group: THREE.Group;
  mesh: THREE.Mesh;
  getAngle: () => number;
  update: (s: SimState) => void;
} {
  const group = new THREE.Group();
  group.position.set(-0.7, 4.05, 1.05);
  scene.add(group);

  const frameGroup = new THREE.Group();
  frameGroup.position.copy(group.position);
  scene.add(frameGroup);

  const metalMap = metalTexture();
  const woodMap = woodTexture();
  const frameMaterial = new THREE.MeshStandardMaterial({
    color: metalMap ? 0xffffff : 0x3c444d,
    map: metalMap ?? undefined,
    roughness: 0.55,
    metalness: 0.35,
  });
  const jamb = new THREE.BoxGeometry(0.12, 2.24, 0.34);
  const leftJamb = new THREE.Mesh(jamb, frameMaterial);
  leftJamb.position.set(-0.06, 0.02, 0);
  const rightJamb = new THREE.Mesh(jamb, frameMaterial);
  rightJamb.position.set(1.46, 0.02, 0);
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(1.64, 0.14, 0.34), frameMaterial);
  lintel.position.set(0.7, 1.12, 0);
  frameGroup.add(leftJamb, rightJamb, lintel);

  const material = new THREE.MeshStandardMaterial({
    color: woodMap ? 0xffffff : 0x6b4a2c,
    map: woodMap ?? undefined,
    roughness: 0.7,
    emissive: 0x4a2508,
    emissiveIntensity: 0.5,
  });

  // 门板挂在铰链上：本地 x 偏移半个门宽
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.4, 2.1, 0.16), material);
  mesh.position.set(0.7, 0, 0);
  group.add(mesh);

  const inset = new THREE.Mesh(
    new THREE.BoxGeometry(1.04, 1.5, 0.02),
    new THREE.MeshStandardMaterial({
      color: woodMap ? 0x9a7a5c : 0x5b3d22,
      map: woodMap ?? undefined,
      roughness: 0.8,
    })
  );
  inset.position.set(0.7, 0.05, 0.09);
  group.add(inset);

  const kick = new THREE.Mesh(
    new THREE.BoxGeometry(1.24, 0.18, 0.03),
    new THREE.MeshStandardMaterial({
      color: metalMap ? 0xffffff : 0x8d9196,
      map: metalMap ?? undefined,
      roughness: 0.4,
      metalness: 0.5,
    })
  );
  kick.position.set(0.7, -0.88, 0.09);
  group.add(kick);

  const handle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.035, 0.18, 10),
    new THREE.MeshStandardMaterial({ color: 0xb08a4a, roughness: 0.3, metalness: 0.7 })
  );
  handle.rotation.x = Math.PI / 2;
  handle.position.set(1.2, -0.02, 0.16);
  group.add(handle);

  const plate = new THREE.Mesh(
    new THREE.BoxGeometry(0.1, 0.22, 0.02),
    new THREE.MeshStandardMaterial({ color: 0x7a5c32, roughness: 0.45, metalness: 0.5 })
  );
  plate.position.set(1.2, -0.02, 0.09);
  group.add(plate);

  group.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });
  frameGroup.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });

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
