import * as THREE from 'three';

export interface HeroCam {
  /** World-space offset added to the camera position, recentring the frame. */
  readonly offset: THREE.Vector3;
  /** Multiplier on the base orthographic zoom. */
  readonly zoom: number;
  /** Eased 0..1 weight, useful for fading hero-only lights. */
  readonly strength: number;
  trigger: (focus: THREE.Vector3) => void;
  release: () => void;
  cancel: () => void;
  update: (dt: number) => void;
  active: () => boolean;
}

const IN = 0.62;
const HOLD = 1.65;
const OUT = 0.78;

const easeInOut = (t: number): number =>
  t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

/**
 * Orthographic dolly-in used for the door beat. It keeps the isometric
 * direction fixed and only recentres / scales the frame, so the cutaway
 * staging never swings around.
 */
export function createHeroCam(options: {
  viewCenter?: THREE.Vector3;
  reducedMotion?: boolean | (() => boolean);
  zoomAmount?: number;
} = {}): HeroCam {
  const viewCenter = options.viewCenter ?? new THREE.Vector3(0, 3, 0);
  const zoomAmount = options.zoomAmount ?? 3.2;
  const offset = new THREE.Vector3();
  const anchor = new THREE.Vector3();
  const prefersReduced = (): boolean =>
    typeof options.reducedMotion === 'function'
      ? options.reducedMotion()
      : Boolean(options.reducedMotion);

  let phase: 'idle' | 'in' | 'hold' | 'out' = 'idle';
  let t = 0;
  let from = 1;
  let zoom = 1;
  let strength = 0;

  const api: HeroCam = {
    offset,
    get zoom() {
      return zoom;
    },
    get strength() {
      return strength;
    },
    trigger(focus: THREE.Vector3) {
      if (prefersReduced()) return;
      anchor.copy(focus).sub(viewCenter);
      phase = 'in';
      t = 0;
    },
    release() {
      if (phase === 'idle' || phase === 'out') return;
      from = phase === 'in' ? easeInOut(Math.min(1, t / IN)) : 1;
      phase = 'out';
      t = 0;
    },
    cancel() {
      phase = 'idle';
      t = 0;
      offset.set(0, 0, 0);
      zoom = 1;
      strength = 0;
    },
    update(dt: number) {
      if (phase === 'idle') {
        offset.set(0, 0, 0);
        zoom = 1;
        strength = 0;
        return;
      }

      t += Math.max(0, dt);
      let k = 0;

      if (phase === 'in') {
        k = easeInOut(Math.min(1, t / IN));
        if (t >= IN) {
          phase = 'hold';
          t = 0;
        }
      } else if (phase === 'hold') {
        k = 1;
        if (t >= HOLD) {
          phase = 'out';
          from = 1;
          t = 0;
        }
      } else {
        k = from * (1 - easeInOut(Math.min(1, t / OUT)));
        if (t >= OUT) {
          phase = 'idle';
          k = 0;
        }
      }

      offset.copy(anchor).multiplyScalar(k);
      strength = k;
      zoom = 1 + zoomAmount * k;
    },
    active() {
      return phase !== 'idle';
    },
  };

  return api;
}
