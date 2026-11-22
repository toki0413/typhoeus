import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export interface CrewModel {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions: Map<string, THREE.AnimationAction>;
  clipNames: string[];
}

export async function loadCrewModel(url: string): Promise<CrewModel | null> {
  const gltf = await new GLTFLoader().loadAsync(url);
  const root = gltf.scene;

  root.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.castShadow = true;
      object.receiveShadow = true;
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
