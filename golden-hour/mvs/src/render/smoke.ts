import * as THREE from 'three';
import type { SimState } from '../sim/types';
import { FLOOR_H } from './constants';
import { mulberry32 } from '../sim/rng';

const PUFFS_PER_FLOOR = 10;

function makeSmokeTexture(): THREE.DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  const center = (size - 1) / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - center) / center;
      const dy = (y - center) / center;
      const d = Math.min(1, Math.sqrt(dx * dx + dy * dy));
      const falloff = 1 - d;
      const i = (y * size + x) * 4;
      data[i] = 220;
      data[i + 1] = 225;
      data[i + 2] = 232;
      data[i + 3] = Math.round(falloff * falloff * 255);
    }
  }

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

interface Puff {
  sprite: THREE.Sprite;
  floor: number;
  x: number;
  z: number;
  phase: number;
  speed: number;
  baseScale: number;
}

export function createSmoke(scene: THREE.Scene): {
  update: (s: SimState) => void;
  group: THREE.Group;
  floors: THREE.Group[];
} {
  const group = new THREE.Group();
  scene.add(group);

  const texture = makeSmokeTexture();
  const floors: THREE.Group[] = [];
  const puffs: Puff[] = [];

  for (let f = 0; f < 2; f++) {
    const floorGroup = new THREE.Group();
    group.add(floorGroup);
    floors.push(floorGroup);

    const rnd = mulberry32(1000 + f * 97);
    for (let i = 0; i < PUFFS_PER_FLOOR; i++) {
      const material = new THREE.SpriteMaterial({
        map: texture,
        color: 0xbcc3cb,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(material);
      const baseScale = 1.8 + rnd() * 1.6;
      sprite.scale.set(baseScale, baseScale, 1);
      floorGroup.add(sprite);
      puffs.push({
        sprite,
        floor: f,
        x: -10 + rnd() * 20,
        z: -5 + rnd() * 10,
        phase: rnd(),
        speed: 0.25 + rnd() * 0.35,
        baseScale,
      });
    }
  }

  return {
    group,
    floors,
    update(s: SimState) {
      for (const p of puffs) {
        const v = s.smoke[p.floor];
        const visible = v > 0.02;
        p.sprite.visible = visible;
        if (!visible) continue;

        const height = Math.max(0.05, v * (FLOOR_H - 0.4));
        const base = p.floor * FLOOR_H + 0.2;
        const local = (p.phase + s.t * p.speed) % 1;
        const drift = s.t + p.phase * 10;

        p.sprite.position.set(
          p.x + Math.sin(drift * 0.8) * 0.3,
          base + local * height,
          p.z + Math.cos(drift * 0.7) * 0.3
        );

        const fade = Math.sin(Math.PI * local);
        const scale = p.baseScale * (0.85 + local * 0.5);
        p.sprite.scale.set(scale, scale, 1);
        (p.sprite.material as THREE.SpriteMaterial).opacity = v * 0.65 * fade;
      }
    },
  };
}
