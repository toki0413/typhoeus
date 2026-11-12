/**
 * 研究关的结构签名
 *
 * 实验图像与仿真场来自不同域：图像带纹理、仿真场平滑，
 * 直接比较密度/熵/分形会被纹理干扰。这里先把两者二值化，
 * 只比较形态本身：面积占比、各向异性、相关长度、连通斑块数、边界密度。
 *
 * 诚实边界：它仍然是结构统计，不比较相位，也不宣称恢复实验参数。
 */

import { computeSpatialPeriod } from '../../src/scientific.js';

export const SIGNATURE_KEYS = ['density', 'anisotropy', 'period', 'components', 'perimeter'];
export const SIGNATURE_SCALES = { density: 0.2, anisotropy: 0.3, period: 10, components: 0.01, perimeter: 0.6 };
export const SIGNATURE_WEIGHTS = { density: 1.0, anisotropy: 1.2, period: 1.0, components: 1.0, perimeter: 0.8 };

export function structuralSignature(field, w, h, threshold = 0.5) {
  const n = w * h;
  const bin = new Uint8Array(n);
  let occupied = 0;
  for (let i = 0; i < n; i++) {
    if (field[i] > threshold) {
      bin[i] = 1;
      occupied++;
    }
  }
  const density = occupied / Math.max(1, n);

  /* 结构张量在各向异性上的投影：条纹接近 1，斑点接近 0 */
  let jxx = 0;
  let jyy = 0;
  let jxy = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = (bin[i + 1] - bin[i - 1]) * 0.5;
      const gy = (bin[i + w] - bin[i - w]) * 0.5;
      jxx += gx * gx;
      jyy += gy * gy;
      jxy += gx * gy;
    }
  }
  const trace = jxx + jyy;
  const anisotropy = trace < 1e-12 ? 0 : Math.min(1, Math.sqrt((jxx - jyy) ** 2 + 4 * jxy * jxy) / trace);

  /* 相关长度：复用科学引擎的自相关定义，输入换成二值场 */
  const floats = new Float32Array(n);
  for (let i = 0; i < n; i++) floats[i] = bin[i];
  const period = computeSpatialPeriod(floats, w, h);

  /* 连通斑块数（4 邻接）：斑点多而条纹少 */
  const visited = new Uint8Array(n);
  let components = 0;
  const stack = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (!bin[start] || visited[start]) continue;
    components++;
    let sp = 0;
    stack[sp++] = start;
    visited[start] = 1;
    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % w;
      const y = (idx - x) / w;
      if (x > 0 && bin[idx - 1] && !visited[idx - 1]) { visited[idx - 1] = 1; stack[sp++] = idx - 1; }
      if (x < w - 1 && bin[idx + 1] && !visited[idx + 1]) { visited[idx + 1] = 1; stack[sp++] = idx + 1; }
      if (y > 0 && bin[idx - w] && !visited[idx - w]) { visited[idx - w] = 1; stack[sp++] = idx - w; }
      if (y < h - 1 && bin[idx + w] && !visited[idx + w]) { visited[idx + w] = 1; stack[sp++] = idx + w; }
    }
  }

  /* 边界密度：相邻格 0/1 翻转的边数 / 面积 */
  let edges = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x < w - 1 && bin[i] !== bin[i + 1]) edges++;
      if (y < h - 1 && bin[i] !== bin[i + w]) edges++;
    }
  }

  return {
    density,
    anisotropy,
    period,
    components: components / Math.max(1, n),
    perimeter: edges / Math.max(1, n),
  };
}

export function signatureDistance(target, candidate) {
  let sum = 0;
  for (const key of SIGNATURE_KEYS) {
    const a = Number.isFinite(target?.[key]) ? target[key] : 0;
    const b = Number.isFinite(candidate?.[key]) ? candidate[key] : 0;
    let diff;
    if (key === 'period') {
      if (!a && !b) diff = 0;
      else if (!a || !b) diff = 1;
      else diff = (a - b) / SIGNATURE_SCALES[key];
    } else {
      diff = (a - b) / SIGNATURE_SCALES[key];
    }
    sum += SIGNATURE_WEIGHTS[key] * diff * diff;
  }
  return Math.sqrt(sum);
}
