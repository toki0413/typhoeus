/**
 * 服务端复核的核心纯函数：确定性种子 + 前向模拟 + 结构签名评分。
 * 抽出来是为了能被测试直接调用，避免评分逻辑藏在 HTTP 入口里。
 */

import { ReactionDiffusionEngine, normalizeField } from '../../src/scientific.js';
import { structuralSignature, signatureDistance } from './signature.mjs';
import { hashString, mulberry32 } from '../../src/rng.js';

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/* 没带种子时，用配方 id 派生一个确定性的 4 核种子，保证服务端复核可复现 */
export function deterministicMask(seedStr, w = 64, h = 64) {
  const mask = new Uint8Array(w * h);
  const rand = mulberry32(hashString(seedStr || 'commons'));
  for (let d = 0; d < 4; d++) {
    const cx = 8 + Math.floor(rand() * (w - 16));
    const cy = 8 + Math.floor(rand() * (h - 16));
    const r = 4 + Math.floor(rand() * 3);
    for (let y = Math.max(0, cy - r); y <= Math.min(h - 1, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(w - 1, cx + r); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) mask[y * w + x] = 255;
      }
    }
  }
  return mask;
}

export function normalizeMask(input, maskW, maskH) {
  if ((!Array.isArray(input) && !ArrayBuffer.isView(input)) || !input.length) return null;
  const mw = Math.round(clamp(maskW, 8, 96, 64));
  const mh = Math.round(clamp(maskH, 8, 96, 64));
  const need = mw * mh;
  if (input.length < need) return null;
  const out = new Uint8Array(need);
  for (let i = 0; i < need; i++) {
    out[i] = Math.round(clamp(input[i], 0, 255, 0));
  }
  return { mask: out, maskW: mw, maskH: mh };
}

export function evaluateTarget(target, params, { w = 64, h = 64 } = {}) {
  const fixed = target.verify?.fixedMask;
  const maskInfo = fixed
    ? {
        mask: deterministicMask(target.verify?.fixedMaskSeed || 'calibration-seed', w, h),
        maskW: w,
        maskH: h,
      }
    : normalizeMask(params.mask, params.maskW, params.maskH);
  const seed = maskInfo ? maskInfo.mask : deterministicMask(params.recipeId || params.name, w, h);
  const rd = new ReactionDiffusionEngine(w, h, {
    preset: 'gs_spots',
    engine: 'grayScott',
    f: clamp(params.f, 0.005, 0.09, 0.035),
    k: clamp(params.k, 0.005, 0.09, 0.062),
    D_u: clamp(params.D_u, 0.02, 0.3, 0.16),
    D_v: clamp(params.D_v, 0.02, 0.2, 0.08),
    dt: clamp(params.dt, 0.2, 1.0, 1.0),
    boundary: 'torus',
    pattern: 'ring',
    mask: seed,
    maskW: maskInfo ? maskInfo.maskW : w,
    maskH: maskInfo ? maskInfo.maskH : h,
  });
  const steps = Math.round(clamp(target.verify?.steps, 120, 1200, 480));
  for (let i = 0; i < steps; i++) rd.step();
  const field = normalizeField(rd.vField);
  const features = structuralSignature(field, w, h);
  const distance = signatureDistance(target.features, features);
  const score = Math.round((100 / (1 + distance)) * 10) / 10;
  return { score, distance: Math.round(distance * 1000) / 1000, features, steps, usedMask: !!maskInfo, usedFixedSeed: !!fixed };
}
