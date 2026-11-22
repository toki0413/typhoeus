import * as THREE from 'three';
import { mulberry32 } from '../sim/rng';

type Draw = (ctx: CanvasRenderingContext2D, size: number, rnd: () => number) => void;

function canvasTexture(seed: number, draw: Draw): THREE.Texture | null {
  if (typeof document === 'undefined') return null;

  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  draw(ctx, size, mulberry32(seed));

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}

let concrete: THREE.Texture | null | undefined;
let wood: THREE.Texture | null | undefined;
let metal: THREE.Texture | null | undefined;
let cardboard: THREE.Texture | null | undefined;

export function concreteTexture(): THREE.Texture | null {
  if (concrete !== undefined) return concrete;
  concrete = canvasTexture(4101, (ctx, size, rnd) => {
    ctx.fillStyle = '#5f666f';
    ctx.fillRect(0, 0, size, size);

    for (let i = 0; i < 26000; i += 1) {
      const shade = Math.floor(54 + rnd() * 66);
      ctx.fillStyle = `rgba(${shade},${shade + 3},${shade + 7},${0.04 + rnd() * 0.09})`;
      ctx.fillRect(rnd() * size, rnd() * size, 1 + rnd() * 2, 1 + rnd() * 2);
    }

    // 大块斑驳，而不是垂直条纹，避免看起来像木饰面。
    for (let i = 0; i < 18; i += 1) {
      const x = rnd() * size;
      const y = rnd() * size;
      const radius = 18 + rnd() * 54;
      const tint = rnd() > 0.5 ? 22 : 210;
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
      gradient.addColorStop(0, `rgba(${tint},${tint + 3},${tint + 6},${0.025 + rnd() * 0.035})`);
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }

    // 模板缝：横向细线，让墙面读起来像浇筑混凝土。
    ctx.strokeStyle = 'rgba(36,39,44,0.22)';
    ctx.lineWidth = 1;
    for (const y of [64, 128, 192]) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(size, y);
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(24,26,30,0.28)';
    for (let i = 0; i < 3; i += 1) {
      ctx.beginPath();
      let x = rnd() * size;
      let y = rnd() * size;
      ctx.moveTo(x, y);
      for (let step = 0; step < 5; step += 1) {
        x += (rnd() - 0.5) * 30;
        y += 8 + rnd() * 22;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  });
  concrete?.repeat.set(3, 2);
  return concrete;
}

export function woodTexture(): THREE.Texture | null {
  if (wood !== undefined) return wood;
  wood = canvasTexture(4313, (ctx, size, rnd) => {
    ctx.fillStyle = '#6f4b2c';
    ctx.fillRect(0, 0, size, size);

    for (let x = 0; x < size; x += 3) {
      const alpha = 0.03 + rnd() * 0.12;
      ctx.fillStyle = `rgba(38,22,10,${alpha})`;
      ctx.fillRect(x + rnd() * 2, 0, 1 + rnd() * 2, size);
    }

    for (let i = 0; i < 8; i += 1) {
      ctx.strokeStyle = `rgba(40,24,12,${0.15 + rnd() * 0.2})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const x = rnd() * size;
      ctx.moveTo(x, 0);
      ctx.bezierCurveTo(x + 10, size * 0.3, x - 8, size * 0.7, x + 4, size);
      ctx.stroke();
    }

    for (let i = 0; i < 4; i += 1) {
      const x = rnd() * size;
      const y = rnd() * size;
      ctx.strokeStyle = 'rgba(32,18,8,0.45)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(x, y, 4 + rnd() * 5, 8 + rnd() * 8, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(26,16,8,0.4)';
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, size - 6, size - 6);
  });
  wood?.repeat.set(1, 1);
  return wood;
}

export function metalTexture(): THREE.Texture | null {
  if (metal !== undefined) return metal;
  metal = canvasTexture(4409, (ctx, size, rnd) => {
    ctx.fillStyle = '#5e666f';
    ctx.fillRect(0, 0, size, size);
    for (let y = 0; y < size; y += 2) {
      ctx.fillStyle = `rgba(255,255,255,${rnd() * 0.035})`;
      ctx.fillRect(0, y, size, 1);
    }
    for (let i = 0; i < 900; i += 1) {
      ctx.fillStyle = `rgba(30,34,38,${rnd() * 0.12})`;
      ctx.fillRect(rnd() * size, rnd() * size, 2 + rnd() * 6, 1);
    }
  });
  metal?.repeat.set(2, 2);
  return metal;
}

export function cardboardTexture(): THREE.Texture | null {
  if (cardboard !== undefined) return cardboard;
  cardboard = canvasTexture(4517, (ctx, size, rnd) => {
    ctx.fillStyle = '#9c7b52';
    ctx.fillRect(0, 0, size, size);
    for (let y = 0; y < size; y += 6) {
      ctx.fillStyle = `rgba(70,48,26,${0.1 + rnd() * 0.12})`;
      ctx.fillRect(0, y, size, 2);
    }
    ctx.fillStyle = 'rgba(240,230,210,0.35)';
    ctx.fillRect(size * 0.18, size * 0.36, size * 0.64, size * 0.1);
    ctx.fillStyle = 'rgba(70,48,26,0.5)';
    ctx.fillRect(size * 0.18, size * 0.36, size * 0.64, 1.5);
  });
  cardboard?.repeat.set(1, 1);
  return cardboard;
}
