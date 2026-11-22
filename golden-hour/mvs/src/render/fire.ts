import * as THREE from 'three';
import type { SimState } from '../sim/types';

function radialTexture(): THREE.DataTexture {
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

function flameTexture(): THREE.DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  const center = (size - 1) / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - center) / center;
      const dy = (y - center) / center;
      // 纵向拉长的泪滴形，底部宽、顶部收尖。
      const d = Math.sqrt(dx * dx * 2.1 + Math.pow(dy * 0.92 + 0.08, 2) * 1.15);
      const alpha = Math.pow(Math.max(0, 1 - d), 1.9);
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 176;
      data[i + 2] = 96;
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
  group.position.set(-2.4, 0.1, 5.4);
  scene.add(group);

  const light = new THREE.PointLight(0xff7a33, 0, 18, 2);
  light.position.set(0, 1.4, 0.4);
  group.add(light);

  const glow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: radialTexture(),
      color: 0xff9a55,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  glow.position.y = 0.9;
  glow.scale.set(3, 2.1, 1);
  group.add(glow);

  const flameMap = flameTexture();
  const flameDefs = [
    { color: 0xff5a1f, x: 0, y: 0.92, z: 0, sx: 1.2, sy: 2.1, opacity: 0.55 },
    { color: 0xffa33e, x: 0.1, y: 0.74, z: 0.08, sx: 0.8, sy: 1.45, opacity: 0.62 },
    { color: 0xffe08a, x: -0.06, y: 0.56, z: -0.04, sx: 0.5, sy: 0.9, opacity: 0.72 },
  ];
  const flames = flameDefs.map((def) => {
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: flameMap,
        color: def.color,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    sprite.position.set(def.x, def.y, def.z);
    sprite.scale.set(def.sx, def.sy, 1);
    group.add(sprite);
    return { sprite, ...def };
  });

  return {
    group,
    light,
    sprite: glow,
    update(s: SimState) {
      const level = Math.min(1, Math.max(0, s.fire));
      const flicker =
        0.82 + Math.sin(s.t * 11.3) * 0.12 + Math.sin(s.t * 23.7 + 1.2) * 0.06;

      light.intensity = level * 42 * flicker;
      (glow.material as THREE.SpriteMaterial).opacity =
        (0.12 + level * 0.62) * flicker;

      const scale = 3 + level * 5.4;
      glow.scale.set(scale, scale * 0.7, 1);

      flames.forEach((flame, index) => {
        const pulse = 0.82 + Math.sin(s.t * (9 + index * 2.3) + index * 1.7) * 0.14;
        const grow = 0.75 + level * 0.55;
        flame.sprite.scale.set(
          flame.sx * pulse * grow,
          flame.sy * pulse * grow,
          1
        );
        (flame.sprite.material as THREE.SpriteMaterial).opacity =
          flame.opacity * (0.5 + level * 0.65) * flicker;
      });
    },
  };
}
