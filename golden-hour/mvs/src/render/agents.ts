import * as THREE from 'three';
import type { SimState } from '../sim/types';
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

function shadowMesh(radius: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 24),
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.34,
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

export function createAgents(scene: THREE.Scene): {
  group: THREE.Group;
  crew: THREE.Object3D;
  victim: THREE.Object3D;
  useCrewModel: (model: CrewModel) => void;
  usingGLB: () => boolean;
  clipNames: () => string[];
  update: (s: SimState) => void;
} {
  const group = new THREE.Group();
  scene.add(group);

  const crew = buildFirefighter();
  const victim = buildCivilian();
  crew.group.position.set(-8.8, 0, 1.65);
  victim.group.position.set(0.9, FLOOR_H, 0.1);
  victim.group.rotation.y = -0.3;
  group.add(crew.group, victim.group);

  const rig: Rig = crew;
  let model: CrewModel | null = null;
  let modelShadow: THREE.Mesh | null = null;
  let currentClip = '';
  let lastT = 0;

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
    next.fadeIn(0.18).play();
    currentClip = name;
  }

  function useCrewModel(loaded: CrewModel): void {
    if (model) return;

    crew.group.visible = false;
    modelShadow = shadowMesh(0.4);
    loaded.root.add(modelShadow);
    loaded.root.position.set(-8.8, 0, 1.65);
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
    update(s: SimState) {
      const target = s.crew.order
        ? Math.min(s.crew.order.floor, s.smoke.length - 1)
        : s.crew.floor;
      const moving =
        Boolean(s.crew.order) && s.t >= s.crew.busyUntil && s.crew.floor < target;
      const reach = s.crew.atDoor && !s.door.opened;
      const base = s.crew.floor * FLOOR_H + s.crew.progress * FLOOR_H;
      const phase = s.t * 8.5;
      const actorRoot = model ? model.root : rig.group;
      const shadow = modelShadow ?? rig.shadow;

      if (model) {
        if (s.t < lastT) lastT = s.t;
        const dt = lastT === 0 ? 0 : Math.min(0.1, Math.max(0, s.t - lastT));
        lastT = s.t;
        playClip(reach ? 'Reach' : moving ? 'Walk' : 'Idle');
        model.mixer.update(dt);

        actorRoot.position.set(
          damp(actorRoot.position.x, reach ? 0 : -8.8, 0.22),
          base,
          1.65
        );
        actorRoot.rotation.y = damp(actorRoot.rotation.y, reach ? Math.PI : 0, 0.12);
        shadow.position.y = 0.015;
      } else {
        const stride = moving ? Math.sin(phase) * 0.55 : 0;
        rig.leftHip.rotation.x = damp(rig.leftHip.rotation.x, stride, 0.25);
        rig.rightHip.rotation.x = damp(rig.rightHip.rotation.x, -stride, 0.25);
        rig.leftKnee.rotation.x = damp(
          rig.leftKnee.rotation.x,
          moving ? Math.max(0, -Math.sin(phase)) * 0.8 : 0,
          0.25
        );
        rig.rightKnee.rotation.x = damp(
          rig.rightKnee.rotation.x,
          moving ? Math.max(0, Math.sin(phase)) * 0.8 : 0,
          0.25
        );

        const armSwing = moving ? -stride * 0.7 : 0;
        rig.leftShoulder.rotation.x = damp(rig.leftShoulder.rotation.x, armSwing, 0.2);
        rig.rightShoulder.rotation.x = damp(
          rig.rightShoulder.rotation.x,
          reach ? -1.15 : -armSwing,
          0.2
        );
        rig.rightElbow.rotation.x = damp(rig.rightElbow.rotation.x, reach ? -0.2 : 0.08, 0.2);

        const bob = moving ? Math.abs(Math.sin(phase)) * 0.035 : 0;
        rig.group.position.set(
          damp(rig.group.position.x, reach ? 0 : -8.8, 0.22),
          base + bob,
          1.65
        );
        rig.group.rotation.y = damp(
          rig.group.rotation.y,
          reach ? Math.PI : 0,
          0.12
        );
        rig.shadow.position.y = -bob + 0.015;

        rig.torso.rotation.x = damp(rig.torso.rotation.x, moving ? 0.09 : 0.02, 0.15);
        rig.torso.scale.y = 1 + Math.sin(s.t * 2.1) * 0.006;
        rig.head.rotation.y = Math.sin(s.t * 0.7) * 0.12;
      }

      const victimVisible = s.victim.alive && !s.victim.rescued;
      victim.group.visible = victimVisible;
      if (victimVisible) {
        victim.group.position.y = FLOOR_H + Math.sin(s.t * 1.8) * 0.008;
        victim.torso.rotation.z = Math.sin(s.t * 0.9) * 0.025;
        victim.head.rotation.x = 0.18 + Math.sin(s.t * 0.8) * 0.03;
      }
    },
  };
}
