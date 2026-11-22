import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createSpatialAudio, DEFAULT_ANCHORS } from '../src/render/spatial';

function makeCamera(): THREE.OrthographicCamera {
  const frustum = 16;
  const aspect = 16 / 9;
  const camera = new THREE.OrthographicCamera(
    -frustum * aspect,
    frustum * aspect,
    frustum,
    -frustum,
    0.1,
    300
  );
  camera.position.set(28, 24, 28);
  camera.lookAt(0, 3, 0);
  camera.updateProjectionMatrix();
  return camera;
}

describe('Three.js 空间音频适配', () => {
  it('声像来自场景世界坐标：火源在左前，楼梯与班组更靠左', () => {
    const spatial = createSpatialAudio(makeCamera());
    const pans = spatial.read();

    expect(pans.firePan).toBeLessThan(-0.18);
    expect(pans.firePan).toBeGreaterThan(-0.5);
    expect(pans.stairsPan).toBeLessThan(-0.4);
    expect(pans.stairsPan).toBeLessThan(pans.firePan);
    expect(pans.crewPan).toBeLessThan(-0.2);
    expect(pans.crewPan).toBeGreaterThan(pans.stairsPan);
    expect(pans.doorPan).toBeGreaterThan(-0.3);
    expect(pans.doorPan).toBeLessThan(0.15);
  });

  it('所有声像都被限制在 -1 到 1', () => {
    const spatial = createSpatialAudio(makeCamera());
    const far = spatial.panOf(new THREE.Vector3(-120, 0, 120));
    expect(far).toBe(-1);

    const near = spatial.panOf(new THREE.Vector3(120, 0, -120));
    expect(near).toBe(1);
  });

  it('换锚点会改变声像，便于以后场景调整', () => {
    const camera = makeCamera();
    const spatial = createSpatialAudio(camera, {
      ...DEFAULT_ANCHORS,
      door: new THREE.Vector3(-13, 4, 0),
    });
    expect(spatial.read().doorPan).toBeLessThan(-0.4);
  });

  it('视口变窄时声像幅度变大', () => {
    const camera = makeCamera();
    const spatial = createSpatialAudio(camera);
    const wide = Math.abs(spatial.read().stairsPan);

    camera.left = -8;
    camera.right = 8;
    camera.updateProjectionMatrix();
    const narrow = Math.abs(spatial.read().stairsPan);

    expect(narrow).toBeGreaterThan(wide);
  });
});
