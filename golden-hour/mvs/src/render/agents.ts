import * as THREE from 'three';
import type { SimState } from '../sim/types';

export function createAgents(scene: THREE.Scene): {
  mesh: THREE.InstancedMesh;
  update: (s: SimState) => void;
} {
  const geo = new THREE.CapsuleGeometry(0.24, 0.72, 3, 8);
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.85 });
  const mesh = new THREE.InstancedMesh(geo, mat, 2);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.setColorAt(0, new THREE.Color(0x5fa88a));
  mesh.setColorAt(1, new THREE.Color(0xd9c27a));
  scene.add(mesh);

  const dummy = new THREE.Object3D();

  return {
    mesh,
    update(s: SimState) {
      const y = s.crew.floor * 3 + 0.55 + s.crew.progress * 3;
      dummy.position.set(-9.5, y, 2.4);
      dummy.rotation.y = 0;
      dummy.updateMatrix();
      mesh.setMatrixAt(0, dummy.matrix);

      dummy.position.set(4.4, 3 + 0.55, 2.4);
      dummy.updateMatrix();
      mesh.setMatrixAt(1, dummy.matrix);

      mesh.instanceMatrix.needsUpdate = true;
    },
  };
}
