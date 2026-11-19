import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export const FLOOR_H = 3;

export function buildStaticGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  const addBox = (w: number, h: number, d: number, x: number, y: number, z: number) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    parts.push(g);
  };

  for (let f = 0; f < 2; f++) {
    const base = f * FLOOR_H;
    addBox(26, 0.3, 14, 0, base, 0);
    addBox(26, FLOOR_H, 0.3, 0, base + FLOOR_H / 2, -7);
    addBox(0.3, FLOOR_H, 14, -13, base + FLOOR_H / 2, 0);
    addBox(0.3, FLOOR_H, 14, 13, base + FLOOR_H / 2, 0);
    for (let x = -13; x <= 13; x += 6.5) {
      addBox(0.28, FLOOR_H, 0.28, x, base + FLOOR_H / 2, 7);
    }
  }

  return mergeGeometries(parts, false)!;
}

export function createScene(): {
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  renderer: THREE.WebGLRenderer;
} {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.shadowMap.enabled = false;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d0f12);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 300);
  const frustum = 16;
  const aspect = window.innerWidth / window.innerHeight;
  camera.left = -frustum * aspect;
  camera.right = frustum * aspect;
  camera.top = frustum;
  camera.bottom = -frustum;
  camera.position.set(28, 24, 28);
  camera.lookAt(0, 3, 0);
  camera.updateProjectionMatrix();

  scene.add(new THREE.HemisphereLight(0x8fa3b8, 0x14181d, 1.1));
  const key = new THREE.DirectionalLight(0xffe0c0, 1.2);
  key.position.set(24, 36, 18);
  scene.add(key);

  const building = new THREE.Mesh(
    buildStaticGeometry(),
    new THREE.MeshStandardMaterial({ color: 0x4a515a, roughness: 0.95 })
  );
  scene.add(building);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.MeshStandardMaterial({ color: 0x121519, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.16;
  scene.add(ground);

  return { scene, camera, renderer };
}
