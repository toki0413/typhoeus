import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { FLOOR_H } from './constants';
import {
  cardboardTexture,
  concreteTexture,
  metalTexture,
  woodTexture,
} from './textures';

function box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(w, h, d);
  geometry.translate(x, y, z);
  return geometry;
}

function textPlane(
  text: string,
  width: number,
  height: number,
  background: string,
  color: string
): THREE.Mesh | null {
  if (typeof document === 'undefined') return null;

  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = background;
  ctx.fillRect(0, 0, 256, 128);
  ctx.fillStyle = color;
  ctx.font = 'bold 44px "Noto Sans CJK SC", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 66);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true })
  );
}

function drawingPlane(): THREE.Mesh | null {
  if (typeof document === 'undefined') return null;

  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#f4f1e8';
  ctx.fillRect(0, 0, 256, 256);
  ctx.strokeStyle = '#d24b3f';
  ctx.lineWidth = 8;
  ctx.strokeRect(12, 12, 232, 232);

  ctx.fillStyle = '#e0a33a';
  ctx.beginPath();
  ctx.arc(64, 64, 24, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = '#4a6fa5';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(128, 196);
  ctx.lineTo(128, 124);
  ctx.moveTo(128, 152);
  ctx.lineTo(88, 112);
  ctx.moveTo(128, 152);
  ctx.lineTo(168, 112);
  ctx.stroke();

  ctx.fillStyle = '#e0a33a';
  ctx.beginPath();
  ctx.arc(128, 98, 22, 0, Math.PI * 2);
  ctx.fill();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Mesh(
    new THREE.PlaneGeometry(0.6, 0.6),
    new THREE.MeshBasicMaterial({ map: texture })
  );
}

function merged(group: THREE.Group, parts: THREE.BufferGeometry[], material: THREE.Material): void {
  if (!parts.length) return;
  const geometry = mergeGeometries(parts, false);
  if (!geometry) return;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
}

export function createCorridorDetails(scene: THREE.Scene): { group: THREE.Group } {
  const group = new THREE.Group();
  const concreteParts: THREE.BufferGeometry[] = [];
  const woodParts: THREE.BufferGeometry[] = [];
  const metalParts: THREE.BufferGeometry[] = [];
  const cardboardParts: THREE.BufferGeometry[] = [];
  const redParts: THREE.BufferGeometry[] = [];
  const lightParts: THREE.BufferGeometry[] = [];
  const trimParts: THREE.BufferGeometry[] = [];
  const matParts: THREE.BufferGeometry[] = [];

  for (let f = 0; f < 2; f++) {
    const base = f * FLOOR_H;

    // 剖面：只保留门洞上方的过梁，下面打开，能直接看见室内。
    const segments = [
      { x: -10.8, w: 4.4 },
      { x: -3.7, w: 6.2 },
      { x: 3.7, w: 6.2 },
      { x: 10.8, w: 4.4 },
    ];
    for (const s of segments) {
      concreteParts.push(box(s.w, 0.62, 0.15, s.x, base + FLOOR_H - 0.31, 1.2));
    }

    // 202 的门由交互门模型负责，不再重复画一扇装饰门。
    const doorXs = f === 1 ? [-8, 8] : [-8, 0, 8];
    for (const x of doorXs) {
      woodParts.push(box(1.2, 2.1, 0.1, x, base + 1.05, 1.26));
    }

    // 门牌
    const labels = f === 0 ? ['101', '102', '103'] : ['201', '202', '203'];
    labels.forEach((label, i) => {
      const sign = textPlane(label, 0.5, 0.24, '#e8e6e1', '#2a2f35');
      if (sign) {
        const x = [-8, 0, 8][i];
        sign.position.set(x, base + 2.55, 1.32);
        group.add(sign);
      }
    });

    // 消防通道告示
    const notice = textPlane('消防通道 禁止占用', 2.2, 0.66, '#b23a30', '#ffffff');
    if (notice) {
      notice.position.set(-11, base + 2.6, 1.3);
      group.add(notice);
    }

    // 楼道堆物：纸箱
    const pile = [
      { x: -11.2, z: 0.2, w: 0.8, h: 0.6, d: 0.7 },
      { x: -11.1, z: 0.3, w: 0.7, h: 0.5, d: 0.6 },
      { x: -10.4, z: 0.5, w: 0.9, h: 0.5, d: 0.8 },
      { x: -10.5, z: 0.4, w: 0.6, h: 0.45, d: 0.6 },
      { x: -9.8, z: 0.7, w: 0.8, h: 0.4, d: 0.7 },
    ];
    for (const p of pile) {
      cardboardParts.push(box(p.w, p.h, p.d, p.x, base + p.h / 2, p.z));
    }

    // 自行车：两个轮子加车架
    for (const x of [-6.7, -5.5]) {
      const wheel = new THREE.TorusGeometry(0.32, 0.035, 6, 14);
      wheel.translate(x, base + 0.34, 0.5);
      metalParts.push(wheel);
    }
    metalParts.push(box(1.1, 0.05, 0.05, -6.1, base + 0.55, 0.5));
    metalParts.push(box(0.05, 0.5, 0.05, -6.0, base + 0.62, 0.5));
    metalParts.push(box(0.5, 0.05, 0.05, -5.9, base + 0.86, 0.5));

    // 婴儿车
    cardboardParts.push(box(0.6, 0.6, 0.85, 3.4, base + 0.5, 0.4));
    for (const dx of [-0.25, 0.25]) {
      for (const dz of [-0.3, 0.3]) {
        const wheel = new THREE.TorusGeometry(0.12, 0.025, 5, 10);
        wheel.translate(3.4 + dx, base + 0.14, 0.4 + dz);
        metalParts.push(wheel);
      }
    }

    // 私搭隔断
    concreteParts.push(box(0.12, 2.7, 2.4, 2.4, base + 1.35, 0));

    // 楼梯与扶手
    for (let i = 0; i < 6; i++) {
      concreteParts.push(
        box(1.2, 0.25, 0.42, -11.6, base + 0.13 + i * 0.25, -1.8 + i * 0.35)
      );
    }
    metalParts.push(box(0.06, 1.0, 2.4, -10.98, base + 1.0, -0.8));

    // 电表箱与明线
    metalParts.push(box(0.5, 0.7, 0.2, 6, base + 1.5, -6.82));
    const wirePoints = [
      new THREE.Vector3(6, base + 1.15, -6.72),
      new THREE.Vector3(6, base + 0.7, -6.72),
      new THREE.Vector3(5.6, base + 0.2, -6.72),
    ];
    const wire = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(wirePoints),
      new THREE.LineBasicMaterial({ color: 0x14181d })
    );
    group.add(wire);

    // 灭火器箱
    redParts.push(box(0.55, 0.8, 0.24, -4, base + 1.4, 1.28));

    // 楼道顶灯：给剖面一点真实光源的暗示
    for (const x of [-8, 0, 8]) {
      lightParts.push(box(1.3, 0.06, 0.26, x, base + FLOOR_H - 0.1, -1.2));
    }

    // 踢脚线与门垫，给大块墙面一个落地收口。
    trimParts.push(box(25.6, 0.13, 0.05, 0, base + 0.065, 1.33));
    trimParts.push(box(25.6, 0.13, 0.05, 0, base + 0.065, -6.83));
    trimParts.push(box(0.05, 0.13, 13.6, -12.84, base + 0.065, 0));
    trimParts.push(box(0.05, 0.13, 13.6, 12.84, base + 0.065, 0));
    for (const x of doorXs) {
      matParts.push(box(1.25, 0.03, 0.52, x, base + 0.02, 0.88));
    }

    // 杂物：鞋架、拖把桶与后墙管道。
    for (const y of [0.12, 0.36]) {
      woodParts.push(box(1.05, 0.05, 0.34, 9.3, base + y, 0.3));
    }
    woodParts.push(box(0.05, 0.72, 0.34, 8.8, base + 0.36, 0.3));
    woodParts.push(box(0.05, 0.72, 0.34, 9.8, base + 0.36, 0.3));

    const bucket = new THREE.CylinderGeometry(0.22, 0.19, 0.42, 12);
    bucket.translate(-10.4, base + 0.21, 0.4);
    redParts.push(bucket);

    const mop = new THREE.CylinderGeometry(0.025, 0.025, 0.95, 6);
    mop.rotateZ(0.16);
    mop.translate(-10.36, base + 0.68, 0.45);
    metalParts.push(mop);

    const pipe = new THREE.CylinderGeometry(0.05, 0.05, 25, 8);
    pipe.rotateZ(Math.PI / 2);
    pipe.translate(0, base + 2.6, -6.78);
    metalParts.push(pipe);
  }

  // 逃生门上的儿童画与出租告示
  const drawing = drawingPlane();
  if (drawing) {
    drawing.position.set(-8, FLOOR_H + 1.2, 1.34);
    group.add(drawing);
  }

  const rent = textPlane('出租', 0.45, 0.3, '#f4f1e8', '#b23a30');
  if (rent) {
    rent.position.set(0, 1.9, 1.34);
    group.add(rent);
  }

  const exit = textPlane('安全出口', 0.9, 0.36, '#2f7a4f', '#ffffff');
  if (exit) {
    exit.position.set(8, FLOOR_H + 2.55, 1.04);
    group.add(exit);
  }

  const wallMap = concreteTexture();
  const woodMap = woodTexture();
  const metalMap = metalTexture();
  const cardboardMap = cardboardTexture();

  merged(
    group,
    concreteParts,
    new THREE.MeshStandardMaterial({
      color: wallMap ? 0xffffff : 0x424a54,
      map: wallMap ?? undefined,
      roughness: 1,
    })
  );
  merged(
    group,
    woodParts,
    new THREE.MeshStandardMaterial({
      color: woodMap ? 0xffffff : 0x6b4a2c,
      map: woodMap ?? undefined,
      roughness: 0.85,
    })
  );
  merged(
    group,
    metalParts,
    new THREE.MeshStandardMaterial({
      color: metalMap ? 0xffffff : 0x2f353c,
      map: metalMap ?? undefined,
      roughness: 0.6,
      metalness: 0.3,
    })
  );
  merged(
    group,
    cardboardParts,
    new THREE.MeshStandardMaterial({
      color: cardboardMap ? 0xffffff : 0x8f6f4a,
      map: cardboardMap ?? undefined,
      roughness: 0.95,
    })
  );
  merged(group, redParts, new THREE.MeshStandardMaterial({ color: 0xa8342b, roughness: 0.8 }));
  merged(group, trimParts, new THREE.MeshStandardMaterial({ color: 0x24292f, roughness: 0.8 }));
  merged(
    group,
    matParts,
    new THREE.MeshStandardMaterial({ color: 0x3a4234, roughness: 1 })
  );
  merged(
    group,
    lightParts,
    new THREE.MeshStandardMaterial({
      color: 0x2a2620,
      emissive: 0xffcf94,
      emissiveIntensity: 1.3,
      roughness: 0.6,
    })
  );

  // 楼道顶灯的真实照明：让剖面内部可读，同时不参与阴影计算。
  for (let f = 0; f < 2; f++) {
    for (const x of [-8, 0, 8]) {
      const light = new THREE.PointLight(0xffc48a, 16, 11, 2);
      light.position.set(x, f * FLOOR_H + 2.5, 1.9);
      group.add(light);
    }
  }

  scene.add(group);
  return { group };
}
