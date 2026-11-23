import * as THREE from 'three';
import type { SimState } from '../sim/types';
import { FLOOR_H } from './constants';

/** 烟层高度：烟越浓，可呼吸的净空越低。 */
export function smokeLayerHeight(smoke: number): number {
  return Math.max(0.55, 2.9 - Math.max(0, Math.min(1, smoke)) * 2.2);
}

/** 0..1 的视野压迫强度（头部是否已经进入烟层）。 */
export function smokeVisibility(smoke: number): number {
  const over = (1.55 - smokeLayerHeight(smoke)) / 1.1;
  return Math.max(0, Math.min(1, over));
}

function smokeTexture(): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.clearRect(0, 0, size, size);
  for (let i = 0; i < 30; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 40 + Math.random() * 100;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(255,255,255,${0.12 + Math.random() * 0.16})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // 边缘淡出，避免剖面看到一张硬边平面。
  const edge = ctx.createRadialGradient(size / 2, size / 2, size * 0.18, size / 2, size / 2, size * 0.52);
  edge.addColorStop(0, 'rgba(0,0,0,0)');
  edge.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createSmokeLayer(scene: THREE.Scene): {
  update: (s: SimState, playerFloor: number, time: number) => void;
} {
  const texture = smokeTexture();
  const planes: THREE.Mesh[] = [];

  for (let f = 0; f < 2; f++) {
    for (let layer = 0; layer < 2; layer++) {
      const material = new THREE.MeshBasicMaterial({
        map: texture ?? undefined,
        color: layer === 0 ? 0xb9c0c4 : 0xa7aeb3,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(25, 13.2), material);
      mesh.rotation.x = -Math.PI / 2;
      mesh.rotation.z = layer * 1.1;
      mesh.position.set(0, f * FLOOR_H + 2.8 + layer * 0.001, -0.2);
      mesh.renderOrder = 2;
      scene.add(mesh);
      planes.push(mesh);
    }
  }

  return {
    update(s: SimState, playerFloor: number, time: number) {
      if (texture) texture.offset.set(time * 0.006, time * 0.0035);

      for (let f = 0; f < 2; f++) {
        const smoke = Math.max(0, Math.min(1, s.smoke[f] ?? 0));
        for (let layer = 0; layer < 2; layer++) {
          const mesh = planes[f * 2 + layer];
          mesh.position.y =
            f * FLOOR_H +
            smokeLayerHeight(smoke) +
            layer * 0.22 +
            Math.sin(time * 0.7 + f + layer) * 0.03;
          const material = mesh.material as THREE.MeshBasicMaterial;
          material.opacity = layer === 0 ? 0.05 + smoke * 0.5 : 0.03 + smoke * 0.34;
        }
      }

      // playerFloor 留给后续按室内/室外做局部浓度差。
      void playerFloor;
    },
  };
}
