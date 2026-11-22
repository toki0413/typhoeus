import * as THREE from 'three';
import type { AudioSpatial } from '../audio/mix';

export interface SpatialAnchors {
  fire: THREE.Vector3;
  door: THREE.Vector3;
  stairs: THREE.Vector3;
  crew: THREE.Vector3;
}

// 与场景布局保持一致：火源在楼体中部，门在前侧，楼梯与班组在左侧。
export const DEFAULT_ANCHORS: SpatialAnchors = {
  fire: new THREE.Vector3(-2.4, 0.8, 5.4),
  door: new THREE.Vector3(3.7, 4.05, 6.9),
  stairs: new THREE.Vector3(-11.4, 0.5, 4.2),
  crew: new THREE.Vector3(-9.5, 0.6, 2.4),
};

const PAN_SCALE = 1.6;

export interface SpatialAudio {
  read: () => AudioSpatial;
  panOf: (point: THREE.Vector3) => number;
}

export function createSpatialAudio(
  camera: THREE.Camera,
  anchors: SpatialAnchors = DEFAULT_ANCHORS
): SpatialAudio {
  const right = new THREE.Vector3();
  const offset = new THREE.Vector3();
  let halfWidth = 16;

  function prepare(): void {
    camera.updateMatrixWorld();
    right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    halfWidth =
      camera instanceof THREE.OrthographicCamera && camera.right > 0.001
        ? camera.right
        : 16;
  }

  function panWith(point: THREE.Vector3): number {
    offset.copy(point).sub(camera.position);
    const ndc = offset.dot(right) / halfWidth;
    return Math.min(1, Math.max(-1, ndc * PAN_SCALE));
  }

  function panOf(point: THREE.Vector3): number {
    prepare();
    return panWith(point);
  }

  return {
    panOf,
    read() {
      prepare();
      return {
        firePan: panWith(anchors.fire),
        doorPan: panWith(anchors.door),
        stairsPan: panWith(anchors.stairs),
        crewPan: panWith(anchors.crew),
      };
    },
  };
}
