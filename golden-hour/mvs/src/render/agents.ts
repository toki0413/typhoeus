import * as THREE from 'three';
import type { SimState } from '../sim/types';
import { completeExtraction, setCrewFloor, withdraw } from '../sim/crew';
import { FLOOR_H } from './constants';
import type { CrewModel } from './glbCrew';

interface Rig {
  group: THREE.Object3D;
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
  shadow: THREE.Mesh;
}

function mat(
  color: number,
  options: { roughness?: number; metalness?: number; emissive?: number } = {}
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: options.roughness ?? 0.82,
    metalness: options.metalness ?? 0.05,
    emissive: options.emissive ?? 0x000000,
    emissiveIntensity: options.emissive ? 0.6 : 0,
  });
}

function box(
  w: number,
  h: number,
  d: number,
  material: THREE.Material,
  x: number,
  y: number,
  z: number
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  return mesh;
}

let shadowTexture: THREE.DataTexture | null = null;

function softShadowTexture(): THREE.DataTexture {
  if (shadowTexture) return shadowTexture;
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = ((x + 0.5) / size) * 2 - 1;
      const dy = ((y + 0.5) / size) * 2 - 1;
      const r = Math.min(1, Math.hypot(dx, dy));
      const alpha = Math.pow(1 - r, 1.7);
      const i = (y * size + x) * 4;
      data[i + 3] = Math.round(210 * alpha);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.needsUpdate = true;
  shadowTexture = tex;
  return tex;
}

function shadowMesh(radius: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(radius * 2.6, radius * 2.6),
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      map: softShadowTexture(),
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    })
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.015;
  return mesh;
}

function buildLeg(
  side: -1 | 1,
  hipY: number,
  trousers: THREE.Material,
  boot: THREE.Material
): { hip: THREE.Group; knee: THREE.Group } {
  const hip = new THREE.Group();
  hip.position.set(side * 0.13, hipY, 0);
  hip.add(box(0.18, 0.42, 0.2, trousers, 0, -0.21, 0));

  const knee = new THREE.Group();
  knee.position.y = -0.42;
  knee.add(box(0.16, 0.38, 0.18, trousers, 0, -0.19, 0));
  knee.add(box(0.19, 0.15, 0.34, boot, 0, -0.4, 0.07));
  hip.add(knee);

  return { hip, knee };
}

function buildArm(
  side: -1 | 1,
  shoulderY: number,
  sleeve: THREE.Material,
  glove: THREE.Material
): { shoulder: THREE.Group; elbow: THREE.Group } {
  const shoulder = new THREE.Group();
  shoulder.position.set(side * 0.34, shoulderY, 0);
  shoulder.add(box(0.14, 0.3, 0.16, sleeve, 0, -0.15, 0));

  const elbow = new THREE.Group();
  elbow.position.y = -0.3;
  elbow.add(box(0.13, 0.28, 0.15, sleeve, 0, -0.14, 0));
  elbow.add(box(0.15, 0.13, 0.17, glove, 0, -0.31, 0.01));
  shoulder.add(elbow);

  return { shoulder, elbow };
}

function buildFirefighter(): Rig {
  const group = new THREE.Group();
  const jacket = mat(0x3f6f5c, { roughness: 0.78 });
  const trousers = mat(0x263039, { roughness: 0.9 });
  const boot = mat(0x171b1f, { roughness: 0.7 });
  const glove = mat(0x2c3339, { roughness: 0.75 });
  const helmet = mat(0xd6ab45, { roughness: 0.42, emissive: 0x2c1f06 });
  const silver = mat(0xd8dde2, { roughness: 0.3, emissive: 0x4a4d50 });
  const rubber = mat(0x14181c, { roughness: 0.95 });
  const steel = mat(0x6b747d, { metalness: 0.6, roughness: 0.35 });
  const lens = mat(0x1a222b, { metalness: 0.4, roughness: 0.2 });

  const shadow = shadowMesh(0.4);
  group.add(shadow);

  const hips = new THREE.Group();
  hips.position.y = 0.9;
  group.add(hips);

  const leftLeg = buildLeg(-1, 0, trousers, boot);
  const rightLeg = buildLeg(1, 0, trousers, boot);
  hips.add(leftLeg.hip, rightLeg.hip);

  const torso = new THREE.Group();
  torso.position.y = 0.9;
  group.add(torso);

  const coat = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.33, 0.58, 12), jacket);
  coat.position.y = 0.29;
  coat.scale.z = 0.8;
  torso.add(coat);

  torso.add(new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.06, 12), jacket));
  torso.children[torso.children.length - 1].position.y = 0.03;

  const belt = new THREE.Mesh(new THREE.CylinderGeometry(0.325, 0.325, 0.07, 12), rubber);
  belt.position.y = 0.06;
  belt.scale.z = 0.82;
  torso.add(belt);

  const band = box(0.56, 0.06, 0.3, silver, 0, 0.4, 0.03);
  torso.add(band);
  torso.add(box(0.56, 0.05, 0.3, silver, 0, 0.22, 0.03));

  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.24, 0.12, 12), jacket);
  collar.position.y = 0.58;
  torso.add(collar);

  const head = new THREE.Group();
  head.position.y = 0.66;
  torso.add(head);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.145, 16, 12), rubber);
  skull.position.y = 0.04;
  head.add(skull);

  const helmetDome = new THREE.Mesh(new THREE.SphereGeometry(0.215, 18, 12), helmet);
  helmetDome.scale.set(1, 0.82, 1.04);
  helmetDome.position.y = 0.11;
  head.add(helmetDome);

  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.245, 0.245, 0.028, 20), helmet);
  brim.position.set(0, 0.045, -0.01);
  brim.scale.z = 1.1;
  head.add(brim);

  const mask = box(0.22, 0.14, 0.09, rubber, 0, 0.0, 0.15);
  head.add(mask);
  const leftLens = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.03, 12), lens);
  leftLens.rotation.x = Math.PI / 2;
  leftLens.position.set(-0.06, 0.01, 0.2);
  head.add(leftLens);
  const rightLens = leftLens.clone();
  rightLens.position.x = 0.06;
  head.add(rightLens);

  const regulator = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.08, 10), steel);
  regulator.rotation.x = Math.PI / 2;
  regulator.position.set(0, -0.06, 0.2);
  head.add(regulator);

  const shoulderY = 0.5;
  const leftArm = buildArm(-1, shoulderY, jacket, glove);
  const rightArm = buildArm(1, shoulderY, jacket, glove);
  torso.add(leftArm.shoulder, rightArm.shoulder);

  const shoulderCapL = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), jacket);
  shoulderCapL.position.set(-0.32, shoulderY, 0);
  torso.add(shoulderCapL);
  const shoulderCapR = shoulderCapL.clone();
  shoulderCapR.position.x = 0.32;
  torso.add(shoulderCapR);

  const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.115, 0.48, 12), steel);
  tank.position.set(0, 0.3, -0.24);
  torso.add(tank);
  const valve = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.1, 8), rubber);
  valve.position.set(0, 0.56, -0.24);
  torso.add(valve);

  const hose = new THREE.Mesh(
    new THREE.TubeGeometry(
      new THREE.CatmullRomCurve3([
        new THREE.Vector3(0, 0.55, -0.24),
        new THREE.Vector3(0.18, 0.5, -0.16),
        new THREE.Vector3(0.2, 0.62, 0.05),
        new THREE.Vector3(0.08, 0.64, 0.18),
      ]),
      14,
      0.018,
      6,
      false
    ),
    rubber
  );
  torso.add(hose);

  const radio = box(0.07, 0.12, 0.04, rubber, 0.19, 0.34, 0.17);
  torso.add(radio);
  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.16, 6), rubber);
  antenna.position.set(0.21, 0.48, 0.17);
  torso.add(antenna);

  group.traverse((object) => {
    if (object instanceof THREE.Mesh && object !== shadow) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });
  return {
    group,
    torso,
    head,
    leftHip: leftLeg.hip,
    rightHip: rightLeg.hip,
    leftKnee: leftLeg.knee,
    rightKnee: rightLeg.knee,
    leftShoulder: leftArm.shoulder,
    rightShoulder: rightArm.shoulder,
    leftElbow: leftArm.elbow,
    rightElbow: rightArm.elbow,
    shadow,
  };
}

function buildCivilian(): Rig {
  const group = new THREE.Group();
  const shirt = mat(0x9c6b58, { roughness: 0.95 });
  const trousers = mat(0x39424c, { roughness: 0.95 });
  const shoe = mat(0x1a1e22, { roughness: 0.9 });
  const skin = mat(0xc39a7f, { roughness: 0.9 });
  const hair = mat(0x2a2422, { roughness: 0.95 });

  const shadow = shadowMesh(0.34);
  group.add(shadow);

  const hips = new THREE.Group();
  hips.position.y = 0.62;
  group.add(hips);

  const leftLeg = buildLeg(-1, 0, trousers, shoe);
  const rightLeg = buildLeg(1, 0, trousers, shoe);
  hips.add(leftLeg.hip, rightLeg.hip);

  // 跪坐：大腿前折、小腿后折
  for (const leg of [leftLeg, rightLeg]) {
    leg.hip.rotation.x = -1.25;
    leg.knee.rotation.x = 1.55;
  }

  const torso = new THREE.Group();
  torso.position.y = 0.62;
  torso.rotation.x = 0.12;
  group.add(torso);

  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.5, 12), shirt);
  body.position.y = 0.26;
  body.scale.z = 0.82;
  torso.add(body);

  const head = new THREE.Group();
  head.position.y = 0.6;
  torso.add(head);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 12), skin);
  skull.position.y = 0.05;
  head.add(skull);
  const hairCap = new THREE.Mesh(new THREE.SphereGeometry(0.155, 16, 10), hair);
  hairCap.scale.set(1.02, 0.75, 1.02);
  hairCap.position.set(0, 0.1, -0.02);
  head.add(hairCap);

  const leftArm = buildArm(-1, 0.44, shirt, skin);
  const rightArm = buildArm(1, 0.44, shirt, skin);
  leftArm.shoulder.rotation.x = -0.8;
  rightArm.shoulder.rotation.x = -0.75;
  leftArm.elbow.rotation.x = -0.7;
  rightArm.elbow.rotation.x = -0.65;
  torso.add(leftArm.shoulder, rightArm.shoulder);

  group.traverse((object) => {
    if (object instanceof THREE.Mesh && object !== shadow) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });

  return {
    group,
    torso,
    head,
    leftHip: leftLeg.hip,
    rightHip: rightLeg.hip,
    leftKnee: leftLeg.knee,
    rightKnee: rightLeg.knee,
    leftShoulder: leftArm.shoulder,
    rightShoulder: rightArm.shoulder,
    leftElbow: leftArm.elbow,
    rightElbow: rightArm.elbow,
    shadow,
  };
}

const damp = (current: number, target: number, rate: number): number =>
  current + (target - current) * rate;

const clamp = (value: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, value));

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

const turnToward = (current: number, target: number, rate: number): number => {
  const TAU = Math.PI * 2;
  const delta = (((target - current + Math.PI) % TAU) + TAU) % TAU - Math.PI;
  return current + delta * Math.min(1, rate);
};

export function createAgents(scene: THREE.Scene): {
  group: THREE.Group;
  crew: THREE.Object3D;
  victim: THREE.Object3D;
  useCrewModel: (model: CrewModel) => void;
  usingGLB: () => boolean;
  clipNames: () => string[];
  crewFocus: () => THREE.Vector3;
  move: (x: number, z: number) => void;
  nearDoor: () => boolean;
  mobile: () => boolean;
  crewX: () => number;
  crewZ: () => number;
  speed: () => number;
  floor: () => number;
  carrying: () => boolean;
  insideRoom: () => boolean;
  action: () => { kind: string; label: string } | null;
  performAction: (s: SimState) => void;
  snap: (s: SimState, x: number, z: number, floor: number) => void;
  reset: () => void;
  update: (s: SimState, dt?: number) => void;
} {
  const group = new THREE.Group();
  scene.add(group);
  const focusPoint = new THREE.Vector3();

  const crew = buildFirefighter();
  const victim = buildCivilian();
  crew.group.position.set(6.5, 0, 1.65);
  victim.group.position.set(0.9, FLOOR_H, 0.1);
  victim.group.rotation.y = -0.3;
  group.add(crew.group, victim.group);

  const rig: Rig = crew;
  let model: CrewModel | null = null;
  let modelShadow: THREE.Mesh | null = null;
  let currentClip = '';
  let lastT = 0;
  const START = { x: 6.5, z: 1.65 };
  const WALK_SPEED = 3.4;
  const CARRY_SPEED = 2.05;
  const CLIMB_TIME = 1.2;
  const VICTIM_X = 0.9;
  const VICTIM_Z = 0.1;
  const STAIRS_MAIN = -11.0;
  const FIRE_ESCAPE = 10.5;
  const EXIT_X = 9.4;

  let px = START.x;
  let pz = START.z;
  let vx = 0;
  let vz = 0;
  let inputX = 0;
  let inputZ = 0;
  let floor = 0;
  let mode: 'free' | 'climb' = 'free';
  let climbT = 0;
  let climbFrom = 0;
  let climbTo = 0;
  let carrying = false;
  let victimAttached = false;
  let nearDoor = false;
  let mobile = false;
  let currentAction: { kind: string; label: string } | null = null;
  let gait = 0;

  function actorRoot(): THREE.Object3D {
    return model ? model.root : rig.group;
  }

  function attachVictim(): void {
    if (victimAttached) return;
    actorRoot().add(victim.group);
    victim.group.position.set(0, 1.02, 0.02);
    victim.group.rotation.set(Math.PI / 2, 0, 0.18);
    victimAttached = true;
  }

  function detachVictim(): void {
    if (!victimAttached) return;
    group.add(victim.group);
    victim.group.position.set(VICTIM_X, FLOOR_H, VICTIM_Z);
    victim.group.rotation.set(0, -0.3, 0);
    victimAttached = false;
  }

  function startClimb(to: number): void {
    if (mode === 'climb') return;
    mode = 'climb';
    climbFrom = floor;
    climbTo = to;
    climbT = 0;
    vx = 0;
    vz = 0;
  }

  function playClip(name: string): void {
    if (!model || currentClip === name) return;
    const next = model.actions.get(name);
    if (!next) return;

    const previous = currentClip ? model.actions.get(currentClip) : null;
    if (previous) previous.fadeOut(0.18);

    next.reset();
    next.setEffectiveWeight(1);
    next.setLoop(name === 'Reach' ? THREE.LoopOnce : THREE.LoopRepeat, name === 'Reach' ? 1 : Infinity);
    next.clampWhenFinished = name === 'Reach';
    next.timeScale = name === 'Walk' ? 1.25 : 1;
    next.fadeIn(0.18).play();
    currentClip = name;
  }

  function useCrewModel(loaded: CrewModel): void {
    if (model) return;

    crew.group.visible = false;
    modelShadow = shadowMesh(0.4);
    loaded.root.add(modelShadow);
    loaded.root.position.set(6.5, 0, 1.65);
    group.add(loaded.root);
    model = loaded;
    lastT = 0;
    playClip('Idle');
  }


  return {
    group,
    crew: crew.group,
    victim: victim.group,
    useCrewModel,
    usingGLB: () => Boolean(model),
    clipNames: () => model?.clipNames ?? [],
    crewFocus: () => {
      const root = actorRoot();
      return focusPoint.set(root.position.x, root.position.y + 1.0, root.position.z);
    },
    move(x: number, z: number) {
      inputX = Math.abs(x) > 0.2 ? Math.sign(x) : 0;
      inputZ = Math.abs(z) > 0.2 ? Math.sign(z) : 0;
    },
    nearDoor: () => nearDoor,
    mobile: () => mobile,
    crewX: () => px,
    crewZ: () => pz,
    speed: () => Math.hypot(vx, vz),
    floor: () => floor,
    carrying: () => carrying,
    insideRoom: () => floor === 1 && pz < 1.16,
    action: () => currentAction,
    performAction(s: SimState) {
      const a = currentAction;
      if (!a || mode !== 'free') return;
      if (a.kind === 'up' && floor === 0) startClimb(1);
      else if (a.kind === 'down' && floor === 1) startClimb(0);
      else if (a.kind === 'carry') {
        if (s.victim.alive && !carrying) {
          carrying = true;
          attachVictim();
        }
      } else if (a.kind === 'exit') {
        if (carrying && s.victim.alive) completeExtraction(s);
        else withdraw(s);
        currentAction = null;
      }
    },
    snap(s: SimState, x: number, z: number, nextFloor: number) {
      floor = nextFloor;
      px = x;
      pz = z;
      vx = 0;
      vz = 0;
      mode = 'free';
      setCrewFloor(s, floor);
      const root = actorRoot();
      root.position.set(px, floor * FLOOR_H, pz);
      currentAction = null;
    },
    reset() {
      detachVictim();
      carrying = false;
      floor = 0;
      px = START.x;
      pz = START.z;
      vx = 0;
      vz = 0;
      inputX = 0;
      inputZ = 0;
      mode = 'free';
      currentAction = null;
      const root = actorRoot();
      root.position.set(px, 0, pz);
      root.rotation.y = 0;
    },
    update(s: SimState, dtIn?: number) {
      const dt =
        dtIn === undefined
          ? lastT === 0
            ? 0
            : Math.min(0.25, Math.max(0, s.t - lastT))
          : Math.max(0, Math.min(0.25, dtIn));
      lastT = s.t;

      let walking = false;
      const root = actorRoot();
      let facing = root.rotation.y;
      let y = floor * FLOOR_H;

      if (mode === 'climb') {
        mobile = false;
        climbT += dt;
        const k = clamp(climbT / CLIMB_TIME, 0, 1);
        const e = k * k * (3 - 2 * k);
        y = lerp(climbFrom * FLOOR_H, climbTo * FLOOR_H, e);
        walking = true;
        facing = 0;
        if (k >= 1) {
          floor = climbTo;
          mode = 'free';
          y = floor * FLOOR_H;
          setCrewFloor(s, floor);
        }
      } else {
        mobile = s.phase === 'execute';
        const busy = s.t < s.crew.busyUntil;
        const smoke = s.smoke[Math.min(floor, s.smoke.length - 1)] ?? 0;
        const speed = (carrying ? CARRY_SPEED : WALK_SPEED) * (1 - 0.35 * smoke);
        const ix = busy ? 0 : inputX;
        const iz = busy ? 0 : inputZ;
        const length = Math.hypot(ix, iz) || 1;
        vx += ((ix / length) * speed - vx) * Math.min(1, dt * 12);
        vz += ((iz / length) * speed - vz) * Math.min(1, dt * 12);
        px += vx * dt;
        pz += vz * dt;

        const canEnter = s.door.opened && Math.abs(px) < 1.12;
        pz = clamp(pz, canEnter ? -2.0 : 1.28, 2.05);
        if (pz < 1.26) px = clamp(px, -1.12, 1.12);
        px = clamp(px, -12.0, 12.0);

        const speedNow = Math.hypot(vx, vz);
        walking = speedNow > 0.12;
        if (walking) facing = Math.atan2(vx, vz);
        else if (floor === 1 && Math.abs(px) < 1.55 && pz > 1.2) facing = Math.PI;
        y = floor * FLOOR_H;
      }

      nearDoor = mode === 'free' && floor === 1 && Math.abs(px) < 1.45 && pz > 1.1;
      const reach = nearDoor && !s.door.opened && Math.hypot(vx, vz) < 0.12;

      let next: { kind: string; label: string } | null = null;
      if (mode === 'free') {
        const atMain = Math.abs(px - STAIRS_MAIN) < 1.15 && pz > 1.18;
        const atFire = Math.abs(px - FIRE_ESCAPE) < 1.05 && pz > 1.18;
        const nearVictim =
          floor === 1 &&
          s.victim.alive &&
          !carrying &&
          Math.hypot(px - VICTIM_X, pz - VICTIM_Z) < 0.95;

        if (carrying && floor === 0 && px > EXIT_X && pz > 1.18) {
          next = { kind: 'exit', label: '将被困者撤出火场' };
        } else if (nearVictim) {
          next = { kind: 'carry', label: '背起被困者' };
        } else if (floor === 0 && atMain) {
          next = s.stairs.collapsed
            ? { kind: 'blocked', label: '主楼梯坍塌，走消防梯' }
            : { kind: 'up', label: '沿主楼梯上二层' };
        } else if (floor === 0 && atFire) {
          next = { kind: 'up', label: '沿消防梯上二层' };
        } else if (floor === 1 && atMain) {
          next = s.stairs.collapsed
            ? { kind: 'blocked', label: '主楼梯坍塌，走消防梯' }
            : { kind: 'down', label: '沿主楼梯下一层' };
        } else if (floor === 1 && atFire) {
          next = { kind: 'down', label: '沿消防梯下一层' };
        } else if (floor === 0 && px > EXIT_X && pz > 1.18 && s.door.opened) {
          next = { kind: 'exit', label: '撤出火场' };
        }
      }
      currentAction = next;

      playClip(reach ? 'Reach' : walking ? 'Walk' : 'Idle');
      if (model) model.mixer.update(dt);
      root.position.set(px, y, pz);
      root.rotation.y = turnToward(root.rotation.y, facing, dt * 10);

      if (model) {
        if (modelShadow) modelShadow.position.y = 0.015;
      } else {
        gait += dt * (walking ? 9 : 0);
        const stride = walking ? Math.sin(gait) * 0.55 : 0;
        const bob = walking ? Math.abs(Math.sin(gait)) * 0.03 : 0;
        rig.leftHip.rotation.x = damp(rig.leftHip.rotation.x, stride, 0.25);
        rig.rightHip.rotation.x = damp(rig.rightHip.rotation.x, -stride, 0.25);
        rig.leftKnee.rotation.x = damp(
          rig.leftKnee.rotation.x,
          walking ? Math.max(0, -Math.sin(gait)) * 0.8 : 0,
          0.25
        );
        rig.rightKnee.rotation.x = damp(
          rig.rightKnee.rotation.x,
          walking ? Math.max(0, Math.sin(gait)) * 0.8 : 0,
          0.25
        );

        const armSwing = walking ? -stride * 0.7 : 0;
        rig.leftShoulder.rotation.x = damp(rig.leftShoulder.rotation.x, armSwing, 0.2);
        rig.rightShoulder.rotation.x = damp(
          rig.rightShoulder.rotation.x,
          reach ? -1.15 : -armSwing,
          0.2
        );
        rig.rightElbow.rotation.x = damp(rig.rightElbow.rotation.x, reach ? -0.2 : 0.08, 0.2);

        rig.group.position.set(px, y + bob, pz);
        rig.group.rotation.y = turnToward(rig.group.rotation.y, facing, dt * 10);
        rig.shadow.position.y = -bob + 0.015;

        rig.torso.rotation.x = damp(rig.torso.rotation.x, walking ? 0.09 : 0.02, 0.15);
        rig.torso.scale.y = 1 + Math.sin(s.t * 2.1) * 0.006;
        rig.head.rotation.y = Math.sin(s.t * 0.7) * 0.12;
      }

      if (!s.victim.alive) {
        victim.group.visible = false;
      } else if (!victimAttached) {
        victim.group.visible = true;
        victim.group.position.y = FLOOR_H + Math.sin(s.t * 1.8) * 0.008;
        victim.torso.rotation.z = Math.sin(s.t * 0.9) * 0.025;
        victim.head.rotation.x =
          0.18 + Math.sin(s.t * 0.8) * 0.03 + Math.sin(s.t * 5.3) * 0.02;
      }
    },
  };
}
