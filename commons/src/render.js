// Visual layer: one visual grammar, procedurally rendered from life state.
// Colour / form / opacity / boundary / event signatures are defined once and reused.
//
// ========== 芳文社风格画风说明 ==========
// 参考：《K-ON!》《点兔》《樱Trick》《请问您今天要来点兔子吗》
// 特征：清透粉彩色、圆润柔和、柔光光晕、萌系呼吸感。
//
// 【颜色板】TINTS
//   tint a 樱花粉主题：bg [250,232,242] → hue 340 (粉) / hue2 290 (紫)
//   tint b 薰衣草紫主题：bg [238,226,252] → hue 280 (紫) / hue2 200 (蓝)
//
// 【细胞年龄颜色 AGE_BUCKETS】
//   出生 → 幼 → 青年 → 成熟 → 老年
//   整体亮度 ≥ 50（最老也是柔和的淡色，不进入暗区）
//   s 饱和度 70-92（清新不扎眼）
//
// 【Lenia 连续场渐变色 LENIA_RAMP】
//   ramp A 樱花·薄荷：从深紫 → 粉 → 薄荷 → 奶油白
//   ramp B 薰衣草·蜜桃：从深紫 → 洋红 → 蜜桃 → 暖白
//
// 【trail fade（残影残留）】
//   从黑色背景淡出 → 改为从 TINT 背景色淡出
//   life fade = 0.30（较明显的残影，可爱）
//   lenia fade = 0.16（连续场需要更干净）
//
// 【glow（光晕）】
//   叠加模式 'lighter'：新生儿有明显外发光（粉紫色）
//   老细胞也有，但更淡、更弥散

import { clamp } from './rng.js';

/* ------------------------------------------------------------------ */
/* 状态颜色映射规范：attractor type × 三维度签名                         */
/* ------------------------------------------------------------------ */
// 每一种生命状态有一组可预测的颜色签名，让听者/观者能"一眼看出"状态。
// 规范同时适用于主舞台（StageRenderer）和缩略图（drawSnapshot）。
//
// ┌──────────┬─────────────────────────────────────────────────┐
// │ 状态     │ 颜色签名                                         │
// ├──────────┼─────────────────────────────────────────────────┤
// │ stable   │ 主色 hue·不变；saturation 温和 70-80；亮度 55-65 │
// │ (安睡)   │ 光晕小 α=0.12；边缘软化 Gaussian blur 0.8px       │
// ├──────────┼─────────────────────────────────────────────────┤
// │ periodic │ 主色 hue ±3° 呼吸式偏移（慢，~2.5s 周期）        │
// │ (轻轻呼吸)│ saturation 85-92；光晕 α=0.20；中等软化 0.5px    │
// ├──────────┼─────────────────────────────────────────────────┤
// │ chaotic  │ 主色 hue ±22° 快速色变；saturation 92-98 尖扎     │
// │ (灵动)   │ 每个细胞微色相偏移 ±18°；光晕强 α=0.28；软化 0px │
// ├──────────┼─────────────────────────────────────────────────┤
// │ drifting │ 主色整体 hue +50° 方向感偏移                      │
// │ (漂游)   │ saturation 80；alpha 波动 ±10%（呼吸感漂游）       │
// ├──────────┼─────────────────────────────────────────────────┤
// │ endangered│ 主色 hue -10° 偏冷；saturation ×0.55（变灰变淡）  │
// │ (需要关爱)│ 光晕 α=0.05；整体 alpha ×0.75（淡出感）            │
// ├──────────┼─────────────────────────────────────────────────┤
// │ extinct  │ 几乎只剩中心小点；alpha ×0.25；保留一颗安静种子    │
// │ (休眠)   │ hue 保持当前，极小光晕 α=0.03                     │
// └──────────┴─────────────────────────────────────────────────┘
//
// 三维度动态调节（随 metrics 实时变化）：
//   density (0-1) → 主色调亮度：density×8+50（越高越亮）
//   entropy (0-1) → 饱和度偏移：entropy×-12（越混沌饱和度越低）
//   activity (0-1)→ 颜色微抖动强度：activity×8° hue ± activity×6% sat

export const ATTRACTOR_COLOR = {
  /* period=呼吸周期(s) | amp=半径幅度(±%) | noise=噪声混合(0-1, 0=纯正弦, 1=完全不规则) */
  stable:     { hueOff: 0,   satMul: 0.92, halo: 0.12, blur: 0.8, period: 2.5, amp: 0.06, noise: 0.0, haloPeriod: 3.2 },
  periodic:   { hueOff: 0,   satMul: 1.00, halo: 0.20, blur: 0.5, period: 1.8, amp: 0.12, noise: 0.0, haloPeriod: 2.2 },
  chaotic:    { hueOff: 0,   satMul: 1.05, halo: 0.28, blur: 0.0, period: 0.6, amp: 0.18, noise: 0.6, haloPeriod: 1.0 },
  drifting:   { hueOff: 50,  satMul: 0.95, halo: 0.18, blur: 0.3, period: 3.0, amp: 0.14, noise: 0.3, haloPeriod: 3.6 },
  endangered: { hueOff: -10, satMul: 0.55, halo: 0.05, blur: 0.0, period: 4.0, amp: 0.02, noise: 0.0, haloPeriod: 5.0 },
  extinct:    { hueOff: 0,   satMul: 0.50, halo: 0.03, blur: 0.0, period: 10,  amp: 0.00, noise: 0.0, haloPeriod: 99 },
};

/* 伪随机函数：确定性噪声（每个细胞固定相位偏移，且可混 breath） */
function hashNoise(a, b) {
  // fast tiny deterministic pseudo-noise
  const t = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return t - Math.floor(t);  // 0..1
}

/* ============================================================== */
/* 动效全局开关（无障碍）                                          */
/*                                                                */
/* 默认 true。app.js 会根据：                                      */
/*   1. prefers-reduced-motion 媒体查询（系统级）                  */
/*   2. 用户手动覆盖（localStorage）                                */
/* 来调用 setMotionEnabled() 覆盖。                                */
/*                                                                */
/* 当 motion 关闭时：                                              */
/*   - computeBreath() 直接返回 0（所有半径都是 baseRadius）       */
/*   - 主舞台无呼吸动效                                            */
/*   - Gallery 缩略图 rAF 循环会被取消                              */
/*   - 零性能开销                                                  */
/* ============================================================== */
let _MOTION_ENABLED = true;

export function setMotionEnabled(enabled) { _MOTION_ENABLED = !!enabled; }
export function isMotionEnabled() { return _MOTION_ENABLED; }

/* 呼吸计算：time(ms) + cellHash + attractor 签名 → ±radius %    */
/* 无障碍短路：motion 关闭时直接返回 0，零开销                      */
function computeBreath(time, cellHash, aSig, ageFactor = 1) {
  if (!_MOTION_ENABLED) return 0;
  if (aSig.amp <= 0) return 0;
  const periodMs = aSig.period * 1000;
  const phase = (time / periodMs + cellHash) * Math.PI * 2;
  let breath = Math.sin(phase) * aSig.amp;
  if (aSig.noise > 0) {
    // 噪声混合：让 chaotic 不规则
    const n1 = hashNoise(Math.floor(time / 100), cellHash * 73);
    const n2 = hashNoise(Math.floor(time / 50) + 1, cellHash * 19);
    const noise = (n1 - 0.5) + (n2 - 0.5);  // -1..1
    breath = breath * (1 - aSig.noise) + noise * aSig.noise * aSig.amp;
  }
  return breath * ageFactor;  // 年龄因子：新生儿=1，老细胞<1
}

/* ------------------------------------------------------------------ */
/* 水彩增强工具                                                        */
/* ------------------------------------------------------------------ */

/** 扩散晕染：给 snapshot 数据做 3x3 邻域加权重叠 */
function watercolorDiffuse(data, w, h, strength = 0.6) {
  const out = new Uint8Array(data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          sum += data[ny * w + nx];
          count++;
        }
      }
      const center = data[y * w + x];
      const avg = sum / count;
      // 水彩感：混合中心值和邻域平均，让边缘松散
      out[y * w + x] = Math.round(center * (1 - strength) + avg * strength);
    }
  }
  return out;
}

/** 高斯模糊（对 offscreen canvas） */
function blurCanvas(ctx, w, h, sigma = 0.6) {
  // 用 CSS filter 做高效模糊，sigma 控制强度
  ctx.filter = `blur(${sigma}px)`;
  // 需要重新 drawImage 自己到 filter canvas
  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  const octx = off.getContext('2d');
  // 这个函数需要外部传入 source canvas，占位留给调用处
  return octx;
}

/* ------------------------------------------------------------------ */
/* 芳文社配色板：两个主题                                              */
/* ------------------------------------------------------------------ */
// bg: 画布底色（RGB）；hue: 细胞色相；body/accent: 高光色

const TINTS = {
  // 主题 A：纸白 × 朱红 × 黑（构成主义）
  a: {
    bg: [242, 239, 230],        // 纸白
    hue: 4,                      // 主细胞色相：朱红
    hue2: 0,
    accent: '#d7261e',           // 朱红
    accent2: '#121212',          // 黑
    body: [215, 38, 30],
  },
  // 主题 B：黑底 × 朱红 × 铬黄
  b: {
    bg: [18, 18, 18],            // 墨黑
    hue: 4,
    hue2: 44,                    // 铬黄
    accent: '#d7261e',
    accent2: '#d9a400',
    body: [240, 235, 220],
  },
};

/* ------------------------------------------------------------------ */
/* Lenia 连续场渐变色（5 节点）                                          */
/* ------------------------------------------------------------------ */
// ramp A：纸白 → 朱红 → 墨黑（构成主义）
const LENIA_RAMP_A = [
  [242, 239, 230],   // 纸白 (0)
  [215, 38, 30],     // 朱红 (0.35)
  [150, 22, 18],     // 暗红 (0.7)
  [18, 18, 18],      // 墨黑 (1)
];
// ramp B：墨黑 → 朱红 → 铬黄 → 纸白
const LENIA_RAMP_B = [
  [18, 18, 18],      // 墨黑 (0)
  [215, 38, 30],     // 朱红 (0.35)
  [217, 164, 0],     // 铬黄 (0.7)
  [250, 246, 236],   // 纸白 (1)
];

function rampColor(ramp, t) {
  const x = clamp(t, 0, 1) * (ramp.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = ramp[Math.min(i, ramp.length - 1)];
  const b = ramp[Math.min(i + 1, ramp.length - 1)];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

/* ------------------------------------------------------------------ */
/* 细胞年龄颜色 HSL（芳文社明亮调）                                      */
/* ------------------------------------------------------------------ */
// 所有阶段亮度 ≥ 50，最老也是柔和的淡色（不进入暗黑色区）
// l: 亮度  s: 饱和度  a: 透明度

const AGE_BUCKETS = [
  { max: 0,   l: 72, s: 96, a: 1.0 },    // 新生儿：朱红
  { max: 1,   l: 58, s: 98, a: 0.98 },   // 幼崽
  { max: 2,   l: 46, s: 100, a: 0.94 },  // 青年：纯朱红
  { max: 4,   l: 34, s: 100, a: 0.92 },  // 成熟：暗红
  { max: 9,   l: 24, s: 88, a: 0.86 },   // 中年：酒红
  { max: 19,  l: 16, s: 60, a: 0.74 },   // 老年：近黑
  { max: Infinity, l: 10, s: 30, a: 0.62 }, // 最老：墨黑
];

function ageBucket(age, activity) {
  let idx = 0;
  for (let i = 0; i < AGE_BUCKETS.length; i++) {
    if (age <= AGE_BUCKETS[i].max) {
      idx = i;
      break;
    }
  }
  const b = AGE_BUCKETS[idx];
  return {
    // activity 高 3% 亮度，让活跃的细胞更亮
    l: clamp(b.l + (activity > 0.5 ? 4 : 0), 20, 98),
    // 年龄越大饱和度降得越多，显得"疲惫"但不阴暗
    s: clamp(b.s - Math.min(20, age * 0.3), 30, 100),
    a: b.a,
  };
}

export class StageRenderer {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.tintKey = opts.tint || 'a';
    this.sim = null;
    this.metrics = null;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.lastW = 0;
    this.lastH = 0;
    this.offscreen = document.createElement('canvas');
    this.offctx = this.offscreen.getContext('2d');
    this.imgData = null;
    this.pulse = null;
    this.flash = 0;
    this.scan = 0;
    this.compact = !!opts.compact;
    this._bound = false;
  }

  get tint() {
    return TINTS[this.tintKey] || TINTS.a;
  }

  setTint(key) {
    this.tintKey = key;
  }

  attach(sim) {
    this.sim = sim;
    this.imgData = null;
    this.offscreen.width = sim.w;
    this.offscreen.height = sim.h;
    this.imgData = this.offctx.createImageData(sim.w, sim.h);
    this.clear();
  }

  setMetrics(m) {
    this.metrics = m;
  }

  triggerPulse(type, strength = 1) {
    this.pulse = { type, t0: performance.now(), strength };
    this.flash = Math.min(1, this.flash + 0.6 * strength);
  }

  clear() {
    const { ctx, canvas } = this;
    const t = this.tint;
    ctx.fillStyle = `rgb(${t.bg[0]},${t.bg[1]},${t.bg[2]})`;
    ctx.fillRect(0, 0, canvas.width || 1, canvas.height || 1);
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * this.dpr));
    const h = Math.max(1, Math.round(rect.height * this.dpr));
    if (w !== this.canvas.width || h !== this.canvas.height) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.clear();
    }
    this.cssW = rect.width;
    this.cssH = rect.height;
  }

  draw(now) {
    if (!this.sim) return;
    this.resize();
    const { ctx, canvas, sim } = this;
    const t = this.tint;
    const W = canvas.width;
    const H = canvas.height;
    const m = this.metrics;
    const activity = m ? clamp(m.activity, 0, 1) : 0.2;

    /* ====== 芳文社核心：径向渐变背景（不是纯色） ======
       空气感来源——中心亮粉白，边缘稍暗粉紫 */
    const cx = W / 2;
    const cy = H / 2;
    const grad = ctx.createRadialGradient(
      cx, cy, Math.min(W, H) * 0.1,
      cx, cy, Math.max(W, H) * 0.8
    );
    grad.addColorStop(0, `rgb(${t.bg[0] + 12},${t.bg[1] + 12},${t.bg[2] + 8})`);   // 中心最亮
    grad.addColorStop(0.6, `rgb(${t.bg[0]},${t.bg[1]},${t.bg[2]})`);              // 中间
    grad.addColorStop(1, `rgb(${Math.max(0, t.bg[0] - 28)},${Math.max(0, t.bg[1] - 22)},${Math.max(0, t.bg[2] - 18)})`); // 边缘稍暗
    ctx.fillStyle = grad;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillRect(0, 0, W, H);

    /* ====== trail fade：用 TINT 背景色，让残留是柔和的粉紫残影 ====== */
    const fade = sim.kind === 'lenia' ? 0.16 : 0.30;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgba(${t.bg[0]},${t.bg[1]},${t.bg[2]},${fade})`;
    ctx.fillRect(0, 0, W, H);

    const scale = Math.min(W / sim.w, H / sim.h);
    const ox = (W - sim.w * scale) / 2;
    const oy = (H - sim.h * scale) / 2;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const aSig = ATTRACTOR_COLOR[(m && m.type) || 'stable'];
    if (sim.kind === 'lenia') this._drawLenia(scale, ox, oy, activity);
    else this._drawLife(scale, ox, oy, activity, now, aSig);

    /* ====== 芳文社：极淡的虚线网格（几乎看不见） ====== */
    if (!this.compact) this._drawGrid(scale, ox, oy, W, H);

    /* ====== 事件脉冲签名 ====== */
    this._drawPulse(now, W, H);
    if (!this.compact) this._drawScan(now, W, H);
    this.flash *= 0.9;
  }

  /* ============================================================== */
  /* 芳文社 _drawLife：圆点细胞 + 三层水彩晕染 + 高光 + 呼吸动效      */
  /* ============================================================== */
  _drawLife(scale, ox, oy, activity, now, aSig) {
    const { ctx, sim } = this;
    const t = this.tint;
    const w = sim.w;
    const h = sim.h;
    const { grid, age } = sim;
    const cell = scale;
    const time = now || performance.now();

    // 按年龄桶收集坐标（算法层不动）
    const buckets = AGE_BUCKETS.map(() => [[], []]);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!grid[i]) continue;
        let b = 0;
        for (let k = 0; k < AGE_BUCKETS.length; k++) {
          if (age[i] <= AGE_BUCKETS[k].max) { b = k; break; }
        }
        buckets[b][(x + y) & 1].push(x, y);
      }
    }

    /* ====================================================== */
    /* Layer 1: 超大柔和光晕（lighter 叠加，淡色）           */
    /* 每个细胞独立呼吸，按 ageFactor 减弱                    */
    /* ====================================================== */
    ctx.globalCompositeOperation = 'source-over';
    for (let b = 0; b < Math.min(buckets.length, 5); b++) {
      const fakeAge = b === 0 ? 0 : b === 1 ? 1 : b === 2 ? 2 : b < 5 ? 4 : 20;
      const info = ageBucket(fakeAge, activity);
      // 年龄因子：新生儿=1 青年=0.7 中年=0.4 老年=0.2
      const ageFactor = b === 0 ? 1.0 : b === 1 ? 0.75 : b === 2 ? 0.55 : b < 5 ? 0.35 : 0.2;
      // 光晕半径基础值（随年龄缩小）
      const baseRadius = cell * (b === 0 ? 2.8 : b === 1 ? 2.2 : b === 2 ? 1.8 : 1.5);
      // 光晕的呼吸周期稍慢于实体（更柔和）
      const haloSig = { ...aSig, period: aSig.haloPeriod || aSig.period, amp: aSig.amp * 0.55 };
      const baseAlpha = b === 0 ? 0.24 : b === 1 ? 0.14 : b === 2 ? 0.08 : 0.04;
      for (let p = 0; p < 2; p++) {
        const arr = buckets[b][p];
        if (!arr.length) continue;
        const hue = t.hue + b * 3 + (p ? -5 : 5);
        const haloAlphaSig = aSig.halo;
        ctx.beginPath();
        for (let k = 0; k < arr.length; k += 2) {
          const px = ox + arr[k] * cell + cell / 2;
          const py = oy + arr[k + 1] * cell + cell / 2;
          // 每个细胞自己的呼吸相位（用坐标 hash）
          const cellHash = (arr[k] * 7 + arr[k + 1] * 13) / 100;
          const breath = computeBreath(time, cellHash, haloSig, ageFactor);
          const r = baseRadius + breath * baseRadius;
          // 呼吸同时微调 alpha：expansion 时更亮，收缩时更暗
          const alpha = baseAlpha * haloAlphaSig * (1 + breath * 1.2);
          ctx.fillStyle = `hsla(${hue}, ${info.s}%, ${Math.min(85, info.l + 10)}%, ${Math.max(0.01, alpha)})`;
          ctx.moveTo(px + r, py);
          ctx.arc(px, py, r, 0, Math.PI * 2);
        }
        ctx.fill();
      }
    }

    /* ====================================================== */
    /* Layer 2: 中层半透明实体圆（lighter 叠加）              */
    /* 所有年龄都呼吸，但新生儿幅度最大                        */
    /* ====================================================== */
    const hueShift = activity * 6;
    for (let b = 0; b < buckets.length; b++) {
      const fakeAge = b === 0 ? 0 : b === 1 ? 1 : b === 2 ? 2 : b < 5 ? 4 : b < 6 ? 9 : 20;
      const info = ageBucket(fakeAge, activity);
      const bodyRadius = cell * (b === 0 ? 0.55 : b === 1 ? 0.48 : b === 2 ? 0.44 : b < 5 ? 0.38 : 0.30);
      const ageFactor = b === 0 ? 1.0 : b === 1 ? 0.7 : b === 2 ? 0.5 : b < 5 ? 0.35 : 0.15;
      for (let p = 0; p < 2; p++) {
        const arr = buckets[b][p];
        if (!arr.length) continue;
        const hue = t.hue + b * 3 + hueShift + (p ? 4 : -4);
        ctx.beginPath();
        for (let k = 0; k < arr.length; k += 2) {
          const px = ox + arr[k] * cell + cell / 2;
          const py = oy + arr[k + 1] * cell + cell / 2;
          const cellHash = (arr[k] * 11 + arr[k + 1] * 5) / 100;
          const breath = computeBreath(time, cellHash, aSig, ageFactor);
          const r = bodyRadius + breath * bodyRadius;
          ctx.fillStyle = `hsla(${hue}, ${info.s}%, ${info.l}%, ${info.a})`;
          ctx.moveTo(px + r, py);
          ctx.arc(px, py, r, 0, Math.PI * 2);
        }
        ctx.fill();
      }
    }

    /* ====================================================== */
    /* Layer 3: 小高光点（source-over，白色/淡粉白色）        */
    /* 只给新生儿和青年细胞，老细胞没有高光                   */
    /* 位置在圆的左上 30% 处（像日系插画的眼神光）            */
    /* ====================================================== */
    ctx.globalCompositeOperation = 'source-over';
    for (let b = 0; b < Math.min(buckets.length, 3); b++) {
      const bodyRadius = cell * (b === 0 ? 0.55 : b === 1 ? 0.48 : 0.44);
      const hlRadius = bodyRadius * 0.32;            // 高光点大小 = 实体圆的 32%
      const hlOffset = bodyRadius * 0.35;            // 高光点偏移：左上 35%
      const hlAlpha = b === 0 ? 0.85 : b === 1 ? 0.65 : 0.45;
      for (let p = 0; p < 2; p++) {
        const arr = buckets[b][p];
        if (!arr.length) continue;
        ctx.fillStyle = `rgba(255, 248, 251, ${hlAlpha})`;
        for (let k = 0; k < arr.length; k += 2) {
          const px = ox + arr[k] * cell + cell / 2 - hlOffset;    // 左上
          const py = oy + arr[k + 1] * cell + cell / 2 - hlOffset;
          ctx.beginPath();
          ctx.arc(px, py, hlRadius, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    ctx.globalCompositeOperation = 'source-over';
  }

  _drawLenia(scale, ox, oy, activity) {
    const { ctx, sim, offscreen, offctx } = this;
    const t = this.tint;
    const w = sim.w;
    const h = sim.h;
    if (!this.imgData || this.imgData.width !== w) {
      this.imgData = offctx.createImageData(w, h);
    }
    const data = this.imgData.data;
    const ramp = this.tintKey === 'b' ? LENIA_RAMP_B : LENIA_RAMP_A;
    const boost = 0.82 + activity * 0.3;
    // 芳文社：边缘增强用粉紫色系 (edgeR=e*100, edgeG=e*50, edgeB=e*110)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const v = sim.field[i];
        const left = sim.field[y * w + ((x - 1 + w) % w)];
        const up = sim.field[((y - 1 + h) % h) * w + x];
        const edge = clamp(Math.abs(v - left) + Math.abs(v - up), 0, 1);
        const c = rampColor(ramp, Math.pow(clamp(v * boost, 0, 1), 0.84));
        const e = edge * 0.42;
        const p = i * 4;
        data[p] = Math.min(255, c[0] + e * 100);
        data[p + 1] = Math.min(255, c[1] + e * 50);
        data[p + 2] = Math.min(255, c[2] + e * 110);
        data[p + 3] = v < 0.035 ? 0 : Math.min(255, 36 + v * 250 + edge * 90);
      }
    }
    offctx.putImageData(this.imgData, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(offscreen, ox, oy, w * scale, h * scale);
    ctx.globalCompositeOperation = 'source-over';
    // faint crisp pass keeps structure legible
    ctx.globalAlpha = 0.35;
    ctx.drawImage(offscreen, ox, oy, w * scale, h * scale);
    ctx.globalAlpha = 1;
    void t;
  }

  _drawGrid(scale, ox, oy, W, H) {
    const { ctx, sim } = this;
    // 芳文社：极淡的粉紫色虚线网格（几乎看不见，只留空气感）
    ctx.strokeStyle = 'rgba(255, 142, 181, 0.09)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);          // 虚线：2px 线 + 4px 空隙
    ctx.beginPath();
    const step = Math.max(8, Math.round(sim.w / 15) * scale);
    for (let x = ox; x <= ox + sim.w * scale; x += step) {
      ctx.moveTo(x, oy);
      ctx.lineTo(x, oy + sim.h * scale);
    }
    for (let y = oy; y <= oy + sim.h * scale; y += step) {
      ctx.moveTo(ox, y);
      ctx.lineTo(ox + sim.w * scale, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);              // 恢复
    void W;
    void H;
  }

  _drawPulse(now, W, H) {
    if (!this.pulse) return;
    const p = this.pulse;
    /* rAF 时间戳可能早于触发脉冲时的 performance.now()（首帧/后台节流），
       elapsed 为负会让下面的取模变负 → arc 收到负半径抛 IndexSizeError。 */
    const elapsed = Math.max(0, (now - p.t0) / 1000);
    if (elapsed > 2.4) {
      this.pulse = null;
      return;
    }
    const t = this.tint;
    const cx = W / 2;
    const cy = H / 2;
    const base = Math.min(W, H);
    const ctx = this.ctx;
    ctx.save();
    if (p.type === 'chaotic') {
      const n = 9;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + now * 0.001;
        const r = Math.max(0, base * (0.18 + ((elapsed * 0.8 + i * 0.09) % 1) * 0.3));
        ctx.strokeStyle = `hsla(${t.hue2 + i * 6}, 90%, 68%, ${0.22 * (1 - elapsed / 2.4)})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx, cy, r, a, a + 0.9);
        ctx.stroke();
      }
    } else if (p.type === 'endangered' || p.type === 'extinct') {
      const alpha = 0.4 * (1 - elapsed / 2.4);
      ctx.fillStyle = `hsla(20, 82%, 55%, ${alpha * 0.1})`;
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = `hsla(20, 82%, 62%, ${alpha})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, base * (0.22 + Math.sin(elapsed * 3) * 0.01), 0, Math.PI * 2);
      ctx.stroke();
    } else if (p.type === 'reproduction') {
      for (let i = 0; i < 2; i++) {
        const r = Math.max(0, base * (0.1 + ((elapsed + i * 0.35) % 1) * 0.42));
        ctx.strokeStyle = `hsla(${t.hue}, 92%, 68%, ${0.5 * (1 - ((elapsed + i * 0.35) % 1))})`;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
      }
    } else {
      const r = base * (0.1 + Math.min(1, elapsed / 1.8) * 0.45);
      const alpha = Math.max(0, 0.5 * (1 - elapsed / 2.2));
      ctx.strokeStyle = `hsla(${t.hue}, 92%, 70%, ${alpha})`;
      ctx.lineWidth = p.type === 'stable' ? 1.4 : 2.2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      if (p.type === 'periodic') {
        ctx.strokeStyle = `hsla(${t.hue2}, 90%, 70%, ${alpha * 0.6})`;
        ctx.beginPath();
        ctx.arc(cx, cy, r * 0.72, Math.PI * 0.1, Math.PI * 1.1);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  _drawScan(now, W, H) {
    const ctx = this.ctx;
    const y = ((now * 0.02) % (H + 120)) - 60;
    const grad = ctx.createLinearGradient(0, y - 40, 0, y + 40);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.5, `rgba(255,255,255,${0.022 + this.flash * 0.04})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, y - 40, W, 80);
  }
}

/* ------------------------------------------------------------------ */
/* Shared procedural assets                                            */
/* ------------------------------------------------------------------ */

export function drawSnapshot(canvas, snapshot, tintKey = 'a', opts = {}) {
  /* ============================================================== */
  /* 芳文社水彩圆点快照（三层晕染 + 高光 + 水彩扩散 + 呼吸动效）       */
  /*                                                                */
  /* opts.now: performance.now() 毫秒 — 传入则启用持续呼吸；         */
  /*           不传则画静态缩略图（gallery 首次渲染用）               */
  /* opts.attrType: attractor type 字符串 — 直接指定签名             */
  /* opts.metrics: 带 type 的 metrics 对象 — 自动选签名              */
  /* ============================================================== */
  if (!canvas || !snapshot) return;
  const now = opts.now || performance.now();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const W = Math.max(1, Math.round((rect.width || opts.w || 240) * dpr));
  const H = Math.max(1, Math.round((rect.height || opts.h || 135) * dpr));
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const t = TINTS[tintKey] || TINTS.a;
  const type = opts.attrType || (opts.metrics && opts.metrics.type) || 'stable';
  const aSig = ATTRACTOR_COLOR[type] || ATTRACTOR_COLOR.stable;
  const activity = opts.metrics ? clamp(opts.metrics.activity, 0, 1) : 0.3;
  const entropy  = opts.metrics ? clamp(opts.metrics.entropy, 0, 1) : 0.3;
  const density  = opts.metrics ? clamp(opts.metrics.density, 0, 1) : 0.4;

  /* ====== 径向渐变背景 ====== */
  const cx = W / 2, cy = H / 2;
  const bgGrad = ctx.createRadialGradient(
    cx, cy, Math.min(W, H) * 0.05,
    cx, cy, Math.max(W, H) * 0.9
  );
  bgGrad.addColorStop(0, `rgb(${t.bg[0] + 14},${t.bg[1] + 14},${t.bg[2] + 8})`);
  bgGrad.addColorStop(0.7, `rgb(${t.bg[0]},${t.bg[1]},${t.bg[2]})`);
  bgGrad.addColorStop(1, `rgb(${Math.max(0, t.bg[0] - 26)},${Math.max(0, t.bg[1] - 20)},${Math.max(0, t.bg[2] - 16)})`);
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  /* ====== 准备数据 + 水彩扩散 ====== */
  const { w, h } = snapshot;
  // 先找 bounding box，稀疏种子也能被居中放大
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!snapshot.data[y * w + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0) {
    /* ====== 休眠/绝灭种子：一颗安静的小圆点 + 光环 ====== */
    const c = Math.min(W, H) * 0.22;
    ctx.globalCompositeOperation = 'source-over';
    // 外围柔和光环
    ctx.fillStyle = `hsla(${t.hue}, 70%, 70%, 0.08)`;
    ctx.beginPath();
    ctx.arc(cx, cy, c * 1.8, 0, Math.PI * 2);
    ctx.fill();
    // 内环
    ctx.strokeStyle = `hsla(${t.hue}, 75%, 60%, 0.30)`;
    ctx.lineWidth = Math.max(1, dpr);
    ctx.beginPath();
    ctx.arc(cx, cy, c, 0, Math.PI * 2);
    ctx.stroke();
    // 安静小种子
    ctx.fillStyle = `hsla(${t.hue}, 85%, 62%, 0.7)`;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(2, c * 0.22), 0, Math.PI * 2);
    ctx.fill();
    // 淡粉角标（不是黑色）
    const vign = ctx.createRadialGradient(cx, cy, Math.min(W, H) * 0.3, cx, cy, Math.max(W, H) * 0.85);
    vign.addColorStop(0, 'rgba(255,255,255,0)');
    vign.addColorStop(1, `rgba(${Math.max(0, t.bg[0] - 30)},${Math.max(0, t.bg[1] - 25)},${Math.max(0, t.bg[2] - 22)},0.35)`);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = vign;
    ctx.fillRect(0, 0, W, H);
    return;
  }

  /* ====== 水彩扩散：让边缘松散自然 ====== */
  const diffused = watercolorDiffuse(snapshot.data, w, h, 0.55);

  /* ====== 裁剪 + 居中 ====== */
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const scale = Math.min((W * 0.85) / bw, (H * 0.85) / bh);
  const ox = (W - bw * scale) / 2 - minX * scale;
  const oy = (H - bh * scale) / 2 - minY * scale;
  const cell = Math.max(1, scale);

  /* ====== 颜色签名（结合 attractor 状态 + 三维度动态调节） ====== */
  const densityLum = 50 + density * 10;            // density→亮度
  const entropySatMul = 1 - entropy * 0.12;         // entropy→饱和度降低
  const jitterHue = activity * 8;                    // activity→色相抖动
  const satMul = aSig.satMul * entropySatMul;
  const haloAlpha = aSig.halo * (opts._haloMul || 1);

  /* ====================================================== */
  /* Layer 1: 大柔光圆（lighter）—— 水彩晕染扩散层 + 呼吸    */
  /* ====================================================== */
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = `blur(${aSig.blur.toFixed(1)}px)`;
  const haloSig = { ...aSig, period: aSig.haloPeriod || aSig.period, amp: aSig.amp * 0.55 };
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const v = diffused[y * w + x];
      if (!v) continue;
      const norm = clamp(v / 255, 0.05, 1);
      const px = ox + x * cell + cell / 2;
      const py = oy + y * cell + cell / 2;
      const baseRadius = cell * (1.8 + norm * 1.8);
      const cellHash = (x * 7 + y * 13) / 100;
      const breath = computeBreath(now, cellHash, haloSig, norm);
      const radius = baseRadius + breath * baseRadius;
      const baseAlpha = haloAlpha * (0.2 + norm * 0.6);
      const alpha = baseAlpha * (1 + breath * 1.2);
      const hue = (t.hue + aSig.hueOff + (x * 7 + y * 13) % 18 - 9 + jitterHue * norm + 360) % 360;
      const sat = 75 * satMul + (norm > 0.7 ? 8 : 0);
      const lum = densityLum + norm * 10;
      ctx.fillStyle = `hsla(${hue}, ${sat}%, ${lum}%, ${Math.max(0.01, alpha)})`;
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.filter = 'none';

  /* ====================================================== */
  /* Layer 2: 实体圆（lighter）—— 细胞主体层 + 呼吸          */
  /* ====================================================== */
  ctx.globalCompositeOperation = 'source-over';
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const v = snapshot.data[y * w + x];
      if (!v) continue;
      const norm = clamp(v / 255, 0.1, 1);
      const px = ox + x * cell + cell / 2;
      const py = oy + y * cell + cell / 2;
      const baseRadius = cell * (0.18 + norm * 0.38);
      const cellHash = (x * 11 + y * 5) / 100;
      const breath = computeBreath(now, cellHash, aSig, norm);
      const radius = baseRadius + breath * baseRadius;
      const alpha = 0.55 + norm * 0.35;
      const hue = (t.hue + aSig.hueOff + (x * 5 + y * 9) % 14 - 7 + jitterHue * norm + 360) % 360;
      const sat = 88 * satMul;
      const lum = densityLum + norm * 15;
      ctx.fillStyle = `hsla(${hue}, ${sat}%, ${lum}%, ${alpha})`;
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /* ====================================================== */
  /* Layer 3: 左上高光点（source-over）—— 眼神光层             */
  /* 只给值大的点（年轻/强场）；值小的点没高光                    */
  /* ====================================================== */
  ctx.globalCompositeOperation = 'source-over';
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const v = snapshot.data[y * w + x];
      if (!v) continue;
      const norm = v / 255;
      if (norm < 0.35) continue;   // 值小的点没高光
      const px = ox + x * cell + cell / 2 - cell * 0.15;   // 左上微偏移
      const py = oy + y * cell + cell / 2 - cell * 0.15;
      const radius = cell * (0.08 + norm * 0.10);          // 高光点 0.08~0.18 cell
      const alpha = 0.35 + norm * 0.4;
      ctx.fillStyle = `rgba(255, 248, 252, ${alpha})`;
      ctx.beginPath();
      ctx.arc(px, py, Math.max(1, radius), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /* ====== 淡粉色 vignette（不是黑色）—— 角落更柔和 ====== */
  ctx.globalCompositeOperation = 'source-over';
  const vg = ctx.createRadialGradient(cx, cy, Math.min(W, H) * 0.25, cx, cy, Math.max(W, H) * 0.9);
  vg.addColorStop(0, 'rgba(255,255,255,0)');
  vg.addColorStop(1, `rgba(${Math.max(0, t.bg[0] - 26)},${Math.max(0, t.bg[1] - 20)},${Math.max(0, t.bg[2] - 16)},0.40)`);
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);
}

export function drawFingerprintGlyph(canvas, metrics, tintKey = 'a') {
  if (!canvas || !metrics) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const size = Math.max(40, Math.round((rect.width || 88) * dpr));
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const t = TINTS[tintKey] || TINTS.a;
  ctx.clearRect(0, 0, size, size);
  const c = size / 2;
  const accent = t.accent;
  ctx.save();
  ctx.translate(c, c);
  const rings = 3 + (metrics.period % 4);
  const arcCount = 4 + (metrics.components % 7);
  for (let r = 0; r < rings; r++) {
    const radius = size * (0.16 + r * 0.1);
    ctx.strokeStyle = accent;
    ctx.globalAlpha = 0.16 + (r / rings) * 0.3;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.stroke();
    const segs = arcCount;
    for (let s = 0; s < segs; s++) {
      if ((s + r + metrics.components) % 3 === 0) continue;
      const a0 = (s / segs) * Math.PI * 2 + metrics.entropy * 2 + r * 0.4;
      const span = (Math.PI * 2) / segs * (0.2 + metrics.stability * 0.5);
      ctx.globalAlpha = 0.25 + metrics.density * 0.5;
      ctx.beginPath();
      ctx.arc(0, 0, radius, a0, a0 + span);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = accent;
  const dots = 3 + Math.round(metrics.density * 8);
  for (let i = 0; i < dots; i++) {
    const a = (i / dots) * Math.PI * 2 + metrics.entropy * 6;
    const rr = size * (0.08 + ((i * 7 + metrics.period) % 5) * 0.012);
    ctx.beginPath();
    ctx.arc(Math.cos(a) * rr, Math.sin(a) * rr, Math.max(1, size * 0.008), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export function drawSparkline(canvas, values, tintKey = 'a', opts = {}) {
  if (!canvas) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const W = Math.max(1, Math.round((rect.width || 120) * dpr));
  const H = Math.max(1, Math.round((rect.height || 34) * dpr));
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  const t = TINTS[tintKey] || TINTS.a;
  if (!values.length) return;
  const min = opts.min ?? Math.min(...values);
  const max = opts.max ?? Math.max(...values);
  const span = max - min || 1;
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = (i / Math.max(1, values.length - 1)) * W;
    const y = H - 2 - ((v - min) / span) * (H - 4);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = t.accent;
  ctx.globalAlpha = 0.85;
  ctx.lineWidth = Math.max(1, dpr);
  ctx.stroke();
  const last = values[values.length - 1];
  const lx = W;
  const ly = H - 2 - ((last - min) / span) * (H - 4);
  ctx.globalAlpha = 1;
  ctx.fillStyle = t.accent;
  ctx.beginPath();
  ctx.arc(Math.min(W - 2, lx), ly, 2 * dpr, 0, Math.PI * 2);
  ctx.fill();
}

export function paletteFor(key) {
  return TINTS[key] || TINTS.a;
}
