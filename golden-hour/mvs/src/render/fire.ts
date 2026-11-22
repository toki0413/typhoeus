import * as THREE from 'three';
import type { SimState } from '../sim/types';

function glowTexture(): THREE.DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  const center = (size - 1) / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - center) / center;
      const dy = (y - center) / center;
      const d = Math.min(1, Math.sqrt(dx * dx + dy * dy));
      const alpha = Math.pow(1 - d, 2.4);
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 168;
      data[i + 2] = 92;
      data[i + 3] = Math.round(alpha * 255);
    }
  }

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

export function createFireGlow(scene: THREE.Scene): {
  group: THREE.Group;
  light: THREE.PointLight;
  sprite: THREE.Sprite;
  update: (s: SimState) => void;
} {
  const group = new THREE.Group();
  group.position.set(0, 1.2, 0.7);
  scene.add(group);

  const light = new THREE.PointLight(0xff7a33, 0, 18, 2);
  light.position.set(0, 1.1, 0.4);
  group.add(light);

  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture(),
      color: 0xff9a55,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  sprite.scale.set(3, 2.1, 1);
  group.add(sprite);

  return {
    group,
    light,
    sprite,
    update(s: SimState) {
      const level = Math.min(1, Math.max(0, s.fire));
      const flicker =
        0.82 + Math.sin(s.t * 11.3) * 0.12 + Math.sin(s.t * 23.7 + 1.2) * 0.06;

      light.intensity = level * 3.6 * flicker;
      (sprite.material as THREE.SpriteMaterial).opacity = level * 0.5 * flicker;

      const scale = 2.4 + level * 5.2;
      sprite.scale.set(scale, scale * 0.7, 1);
    },
  };
}
