import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export interface CrewModel {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions: Map<string, THREE.AnimationAction>;
  clipNames: string[];
}

interface Tuning {
  env: number;
  roughness?: number;
  metalness?: number;
  normal?: number;
}

// Authored material names come straight from the Blender asset.
const TUNING: Record<string, Tuning> = {
  coat: { env: 0.42, normal: 1.15 },
  coat_dark: { env: 0.42, normal: 1.15 },
  trousers: { env: 0.42, normal: 1.2 },
  trousers_dark: { env: 0.42, normal: 1.2 },
  webbing: { env: 0.55, normal: 1.1 },
  nomex: { env: 0.4 },
  rubber: { env: 0.5, normal: 1.1 },
  boot: { env: 0.85, normal: 1.1 },
  glove: { env: 0.72, normal: 1.1 },
  leather: { env: 0.8, normal: 1.15 },
  helmet: { env: 0.95 },
  helmet_dark: { env: 0.8 },
  reflective: { env: 1.45, roughness: 0.3, metalness: 0.45 },
  fluoro: { env: 0.9 },
  steel: { env: 1.3, roughness: 0.3 },
  brass: { env: 1.3, roughness: 0.3 },
  lens: { env: 1.7, roughness: 0.1, metalness: 0.45 },
  accent: { env: 0.8 },
  sole: { env: 0.45 },
};

function refineMaterial(material: THREE.Material): void {
  if (!(material instanceof THREE.MeshStandardMaterial)) return;
  const tune = TUNING[material.name];
  if (!tune) return;

  material.envMapIntensity = tune.env;
  if (tune.roughness !== undefined) material.roughness = tune.roughness;
  if (tune.metalness !== undefined) material.metalness = tune.metalness;
  if (tune.normal && material.normalMap) {
    material.normalScale.set(tune.normal, tune.normal);
  }
  material.dithering = true;
  material.needsUpdate = true;
}

export async function loadCrewModel(url: string): Promise<CrewModel | null> {
  const gltf = await new GLTFLoader().loadAsync(url);
  const root = gltf.scene;

  root.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.castShadow = true;
      object.receiveShadow = true;
      // Skinned bounds follow the bind pose; animated reaches can fall
      // outside of it and get culled at the edge of the frame.
      object.frustumCulled = false;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach(refineMaterial);
    }
  });

  const clipNames = gltf.animations.map((clip) => clip.name);
  if (clipNames.length === 0) return null;

  const mixer = new THREE.AnimationMixer(root);
  const actions = new Map<string, THREE.AnimationAction>();
  for (const clip of gltf.animations) {
    actions.set(clip.name, mixer.clipAction(clip));
  }

  return { root, mixer, actions, clipNames };
}
