import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export interface CrewModelNodes {
  root: THREE.Object3D;
  torso: THREE.Object3D;
  head: THREE.Object3D;
  leftHip: THREE.Object3D;
  rightHip: THREE.Object3D;
  leftKnee: THREE.Object3D;
  rightKnee: THREE.Object3D;
  leftShoulder: THREE.Object3D;
  rightShoulder: THREE.Object3D;
  leftElbow: THREE.Object3D;
  rightElbow: THREE.Object3D;
}

export async function loadCrewModel(url: string): Promise<CrewModelNodes | null> {
  const gltf = await new GLTFLoader().loadAsync(url);
  const root = gltf.scene.getObjectByName('Firefighter') ?? gltf.scene;

  const named = (name: string): THREE.Object3D | null =>
    gltf.scene.getObjectByName(name) ?? null;

  const torso = named('Torso');
  const head = named('Head');
  const leftHip = named('Leg_L');
  const rightHip = named('Leg_R');
  const leftKnee = named('Shin_L');
  const rightKnee = named('Shin_R');
  const leftShoulder = named('Arm_L');
  const rightShoulder = named('Arm_R');
  const leftElbow = named('Forearm_L');
  const rightElbow = named('Forearm_R');

  if (
    !torso ||
    !head ||
    !leftHip ||
    !rightHip ||
    !leftKnee ||
    !rightKnee ||
    !leftShoulder ||
    !rightShoulder ||
    !leftElbow ||
    !rightElbow
  ) {
    return null;
  }

  root.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });

  return {
    root,
    torso,
    head,
    leftHip,
    rightHip,
    leftKnee,
    rightKnee,
    leftShoulder,
    rightShoulder,
    leftElbow,
    rightElbow,
  };
}
