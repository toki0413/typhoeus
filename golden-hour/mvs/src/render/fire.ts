import * as THREE from 'three';
import type { SimState } from '../sim/types';
import { FLOOR_H } from './constants';

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
  // 火在 202 室内，正好照亮门口与被困者。
  group.position.set(-4.5, FLOOR_H + 0.1, -1.5);
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
    { color: 0xff5a1f, x: 0, y: 1.2, z: 0, sx: 1.9, sy: 3.2, opacity: 0.66 },
    { color: 0xffa33e, x: 0.14, y: 0.95, z: 0.08, sx: 1.25, sy: 2.3, opacity: 0.74 },
    { color: 0xffe08a, x: -0.1, y: 0.7, z: -0.04, sx: 0.78, sy: 1.4, opacity: 0.82 },
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

  // 低多边形火舌：即使精灵被门框部分遮挡，也能读出“这里有火”。
  const cones = [
    { height: 1.75, radius: 0.42, color: 0xff6a24, x: 0, z: 0 },
    { height: 1.25, radius: 0.3, color: 0xffa33e, x: 0.12, z: 0.06 },
    { height: 0.8, radius: 0.2, color: 0xffdd82, x: -0.1, z: -0.04 },
  ].map((def) => {
    const geometry = new THREE.ConeGeometry(def.radius, def.height, 7);
    geometry.translate(0, def.height / 2, 0);
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        color: def.color,
        transparent: true,
        opacity: 0.62,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    mesh.position.set(def.x, 0, def.z);
    group.add(mesh);
    return { mesh, def };
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

      const scale = 3.8 + level * 6.5;
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

      cones.forEach((cone, index) => {
        const pulse = 0.86 + Math.sin(s.t * (8 + index * 2.1) + index) * 0.12;
        cone.mesh.scale.set(pulse, 0.7 + level * 0.6 + pulse * 0.1, pulse);
        (cone.mesh.material as THREE.MeshBasicMaterial).opacity =
          0.55 + level * 0.3;
      });
    },
  };
}
