import * as THREE from 'three';
import type { SimState } from '../sim/types';
import { FLOOR_H } from './constants';

interface Actor {
  group: THREE.Group;
  limbs: THREE.Object3D[];
  rightArm: THREE.Object3D;
}

function material(color: number, options: { metalness?: number; roughness?: number; emissive?: number } = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: options.roughness ?? 0.82,
    metalness: options.metalness ?? 0.05,
    emissive: options.emissive ?? 0x000000,
    emissiveIntensity: options.emissive ? 0.7 : 0,
  });
}

function makeFirefighter(): Actor {
  const group = new THREE.Group();
  const jacket = material(0x4f7f6a);
  const dark = material(0x27313a, { metalness: 0.25, roughness: 0.6 });
  const helmet = material(0xd9b45a, { roughness: 0.45, emissive: 0x3a2a08 });
  const stripe = material(0xe8e6e1, { roughness: 0.35, emissive: 0x6b6b66 });
  const tank = material(0x59636e, { metalness: 0.55, roughness: 0.35 });

  const legGeo = new THREE.BoxGeometry(0.17, 0.62, 0.22);
  const leftLeg = new THREE.Mesh(legGeo, dark);
  leftLeg.position.set(-0.14, 0.32, 0);
  const rightLeg = new THREE.Mesh(legGeo, dark);
  rightLeg.position.set(0.14, 0.32, 0);

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 0.5, 4, 10), jacket);
  body.position.y = 1.02;

  const band = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.07, 0.03), stripe);
  band.position.set(0, 1.08, 0.24);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 14, 10), helmet);
  head.position.y = 1.55;
  head.scale.y = 0.85;

  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.09, 0.05), dark);
  visor.position.set(0, 1.5, 0.17);

  const cylinder = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.5, 10), tank);
  cylinder.position.set(0, 1.02, -0.24);

  const armGeo = new THREE.BoxGeometry(0.13, 0.5, 0.15);
  const leftArm = new THREE.Mesh(armGeo, jacket);
  leftArm.position.set(-0.33, 1.02, 0);
  leftArm.rotation.z = 0.16;
  const rightArm = new THREE.Mesh(armGeo, jacket);
  rightArm.position.set(0.33, 1.02, 0);
  rightArm.rotation.z = -0.16;

  group.add(leftLeg, rightLeg, body, band, head, visor, cylinder, leftArm, rightArm);
  group.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });

  return { group, limbs: [leftLeg, rightLeg, leftArm, rightArm], rightArm };
}

function makeCivilian(): Actor {
  const group = new THREE.Group();
  const shirt = material(0xa87562, { roughness: 0.95 });
  const trousers = material(0x3d4650, { roughness: 0.95 });
  const skin = material(0xc9a184, { roughness: 0.9 });

  const legs = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.55, 0.2), trousers);
  legs.position.y = 0.3;

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.21, 0.42, 4, 10), shirt);
  body.position.y = 0.92;

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 10), skin);
  head.position.y = 1.33;

  const armGeo = new THREE.BoxGeometry(0.11, 0.42, 0.13);
  const leftArm = new THREE.Mesh(armGeo, shirt);
  leftArm.position.set(-0.28, 0.92, 0);
  leftArm.rotation.z = 0.2;
  const rightArm = new THREE.Mesh(armGeo, shirt);
  rightArm.position.set(0.28, 0.92, 0);
  rightArm.rotation.z = -0.2;

  group.add(legs, body, head, leftArm, rightArm);
  group.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });

  return { group, limbs: [leftArm, rightArm], rightArm };
}

export function createAgents(scene: THREE.Scene): {
  group: THREE.Group;
  crew: THREE.Group;
  victim: THREE.Group;
  update: (s: SimState) => void;
} {
  const group = new THREE.Group();
  scene.add(group);

  const crew = makeFirefighter();
  const victim = makeCivilian();
  crew.group.position.set(-9.5, 0, 2.4);
  victim.group.position.set(4.4, FLOOR_H, 2.4);
  group.add(crew.group, victim.group);

  return {
    group,
    crew: crew.group,
    victim: victim.group,
    update(s: SimState) {
      const target = s.crew.order
        ? Math.min(s.crew.order.floor, s.smoke.length - 1)
        : s.crew.floor;
      const moving =
        Boolean(s.crew.order) && s.t >= s.crew.busyUntil && s.crew.floor < target;
      const base = s.crew.floor * FLOOR_H + s.crew.progress * FLOOR_H;

      crew.group.position.set(
        -9.5,
        base + (moving ? Math.abs(Math.sin(s.t * 9)) * 0.05 : 0),
        2.4
      );

      const swing = moving ? Math.sin(s.t * 9) * 0.5 : 0;
      crew.limbs[0].rotation.x = swing;
      crew.limbs[1].rotation.x = -swing;
      crew.limbs[2].rotation.x = -swing * 0.7;
      crew.rightArm.rotation.x = s.crew.atDoor && !s.door.opened ? -1.1 : swing * 0.7;

      const victimVisible = s.victim.alive && !s.victim.rescued;
      victim.group.visible = victimVisible;
      if (victimVisible) {
        victim.group.position.y = FLOOR_H + Math.sin(s.t * 1.6) * 0.01;
      }
    },
  };
}
