import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { FLOOR_H } from './constants';

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

  for (let f = 0; f < 2; f++) {
    const base = f * FLOOR_H;

    // 走廊墙：把楼层剖面前缘封成一条走道，留出三个住户门洞
    const segments = [
      { x: -10.8, w: 4.4 },
      { x: -3.7, w: 6.2 },
      { x: 3.7, w: 6.2 },
      { x: 10.8, w: 4.4 },
    ];
    for (const s of segments) {
      concreteParts.push(box(s.w, FLOOR_H, 0.15, s.x, base + FLOOR_H / 2, 1.2));
    }

    const doorXs = [-8, 0, 8];
    for (const x of doorXs) {
      woodParts.push(box(1.2, 2.1, 0.1, x, base + 1.05, 1.26));
    }

    // 门牌
    const labels = f === 0 ? ['101', '102', '103'] : ['201', '202', '203'];
    labels.forEach((label, i) => {
      const sign = textPlane(label, 0.5, 0.24, '#e8e6e1', '#2a2f35');
      if (sign) {
        sign.position.set(doorXs[i], base + 2.28, 1.33);
        group.add(sign);
      }
    });

    // 消防通道告示
    const notice = textPlane('消防通道 禁止占用', 2.2, 0.66, '#b23a30', '#ffffff');
    if (notice) {
      notice.position.set(-11, base + 2.5, 1.28);
      group.add(notice);
    }

    // 楼道堆物：纸箱
    const pile = [
      { x: -11.2, z: 4.6, w: 0.8, h: 0.6, d: 0.7 },
      { x: -11.1, z: 4.7, w: 0.7, h: 0.5, d: 0.6 },
      { x: -10.4, z: 4.9, w: 0.9, h: 0.5, d: 0.8 },
      { x: -10.5, z: 4.8, w: 0.6, h: 0.45, d: 0.6 },
      { x: -9.8, z: 5.1, w: 0.8, h: 0.4, d: 0.7 },
    ];
    for (const p of pile) {
      cardboardParts.push(box(p.w, p.h, p.d, p.x, base + p.h / 2, p.z));
    }

    // 自行车：两个轮子加车架
    for (const x of [-6.7, -5.5]) {
      const wheel = new THREE.TorusGeometry(0.32, 0.035, 6, 14);
      wheel.translate(x, base + 0.34, 5.1);
      metalParts.push(wheel);
    }
    metalParts.push(box(1.1, 0.05, 0.05, -6.1, base + 0.55, 5.1));
    metalParts.push(box(0.05, 0.5, 0.05, -6.0, base + 0.62, 5.1));
    metalParts.push(box(0.5, 0.05, 0.05, -5.9, base + 0.86, 5.1));

    // 婴儿车
    cardboardParts.push(box(0.6, 0.6, 0.85, 3.4, base + 0.5, 5.0));
    for (const dx of [-0.25, 0.25]) {
      for (const dz of [-0.3, 0.3]) {
        const wheel = new THREE.TorusGeometry(0.12, 0.025, 5, 10);
        wheel.translate(3.4 + dx, base + 0.14, 5.0 + dz);
        metalParts.push(wheel);
      }
    }

    // 私搭隔断
    concreteParts.push(box(0.12, 2.7, 2.4, 2.4, base + 1.35, 4.2));

    // 楼梯与扶手
    for (let i = 0; i < 6; i++) {
      concreteParts.push(box(1.2, 0.25, 0.42, -11.6, base + 0.13 + i * 0.25, 3.2 + i * 0.4));
    }
    metalParts.push(box(0.06, 1.0, 2.4, -10.98, base + 1.0, 4.2));

    // 电表箱与明线
    metalParts.push(box(0.5, 0.7, 0.2, 6, base + 1.5, 6.82));
    const wirePoints = [
      new THREE.Vector3(6, base + 1.15, 6.72),
      new THREE.Vector3(6, base + 0.7, 6.72),
      new THREE.Vector3(5.6, base + 0.2, 6.72),
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
    exit.position.set(4.4, FLOOR_H + 2.45, 6.94);
    group.add(exit);
  }

  merged(group, concreteParts, new THREE.MeshStandardMaterial({ color: 0x424a54, roughness: 1 }));
  merged(group, woodParts, new THREE.MeshStandardMaterial({ color: 0x6b4a2c, roughness: 0.85 }));
  merged(group, metalParts, new THREE.MeshStandardMaterial({ color: 0x2f353c, roughness: 0.6, metalness: 0.3 }));
  merged(group, cardboardParts, new THREE.MeshStandardMaterial({ color: 0x8f6f4a, roughness: 0.95 }));
  merged(group, redParts, new THREE.MeshStandardMaterial({ color: 0xa8342b, roughness: 0.8 }));
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

  scene.add(group);
  return { group };
}
