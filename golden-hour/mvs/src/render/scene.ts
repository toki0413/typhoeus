import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { FLOOR_H } from './constants';
export { FLOOR_H };

export function buildStaticGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  const addBox = (w: number, h: number, d: number, x: number, y: number, z: number) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    parts.push(g);
  };

  for (let f = 0; f < 2; f++) {
    const base = f * FLOOR_H;
    // 楼板只保留后半段，前缘剖开，正交相机才能看到每层
    addBox(26, 0.3, 8, 0, base, -3);
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
  const lowPower =
    typeof navigator !== 'undefined' && (navigator.hardwareConcurrency ?? 8) <= 4;

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, lowPower ? 1.25 : 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = !lowPower;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0e12);
  scene.fog = new THREE.FogExp2(0x0b0e12, 0.011);

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

  scene.add(new THREE.HemisphereLight(0x8fa3b8, 0x101318, 0.55));

  const key = new THREE.DirectionalLight(0xffc894, 2.4);
  key.position.set(18, 30, 12);
  if (!lowPower) {
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -18;
    key.shadow.camera.right = 18;
    key.shadow.camera.top = 16;
    key.shadow.camera.bottom = -16;
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 80;
    key.shadow.bias = -0.0006;
  }
  scene.add(key);

  const fill = new THREE.DirectionalLight(0x6f8fb5, 0.75);
  fill.position.set(-20, 16, -10);
  scene.add(fill);

  const building = new THREE.Mesh(
    buildStaticGeometry(),
    new THREE.MeshStandardMaterial({ color: 0x3f4650, roughness: 0.92, metalness: 0.04 })
  );
  building.castShadow = true;
  building.receiveShadow = true;
  scene.add(building);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.MeshStandardMaterial({ color: 0x0f1216, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.16;
  ground.receiveShadow = true;
  scene.add(ground);

  return { scene, camera, renderer };
}
