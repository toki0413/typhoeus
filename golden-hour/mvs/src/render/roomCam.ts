import * as THREE from 'three';

export interface RoomShot {
  id: string;
  target: THREE.Vector3;
  zoom: number;
}

export interface RoomCam {
  readonly offset: THREE.Vector3;
  readonly zoom: number;
  zone: () => string;
  cuts: () => number;
  update: (dt: number, shot: RoomShot | null) => void;
}

/**
 * Keeps the isometric direction fixed and cuts between authored framings.
 * A zone change is a hard cut (MGS-style room cut); movement inside a zone
 * is a slow follow so the frame still breathes.
 */
export function createRoomCam(viewCenter = new THREE.Vector3(0, 3, 0)): RoomCam {
  const offset = new THREE.Vector3();
  const current = viewCenter.clone();
  let zoom = 1;
  let zone = 'wide';
  let cuts = 0;

  return {
    offset,
    get zoom() {
      return zoom;
    },
    zone: () => zone,
    cuts: () => cuts,
    update(dt: number, shot: RoomShot | null) {
      const target = shot ? shot.target : viewCenter;
      const nextZoom = shot ? shot.zoom : 1;
      const id = shot ? shot.id : 'wide';

      if (id !== zone) {
        zone = id;
        cuts += 1;
        current.copy(target);
        zoom = nextZoom;
      } else {
        const rate = Math.min(1, dt * 3.0);
        current.lerp(target, rate);
        zoom += (nextZoom - zoom) * rate;
      }

      offset.copy(current).sub(viewCenter);
    },
  };
}
