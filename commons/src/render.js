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
/* 芳文社配色板：两个主题                                              */
/* ------------------------------------------------------------------ */
// bg: 画布底色（RGB）；hue: 细胞色相；body/accent: 高光色

const TINTS = {
  // 主题 A：樱花粉 × 薰衣草紫（默认）
  a: {
    bg: [250, 232, 242],        // 淡樱花粉底
    hue: 340,                    // 主细胞色相：粉红
    hue2: 285,                   // 次色相：薰衣草紫
    accent: '#ff8eb5',           // 少女粉
    accent2: '#c59df2',          // 薰衣草紫
    body: [255, 170, 200],       // 粉白身体色
  },
  // 主题 B：晴空蓝 × 蜜桃橙
  b: {
    bg: [236, 238, 250],        // 淡薰衣草粉底
    hue: 280,                    // 主细胞色相：薰衣草
    hue2: 40,                    // 次色相：蜜桃
    accent: '#a8d8ea',           // 晴空蓝
    accent2: '#ffb89e',          // 蜜糖橙
    body: [180, 160, 230],       // 淡紫身体色
  },
};

/* ------------------------------------------------------------------ */
/* Lenia 连续场渐变色（5 节点）                                          */
/* ------------------------------------------------------------------ */
// ramp A：樱花 × 薄荷 × 奶油（治愈）
const LENIA_RAMP_A = [
  [240, 220, 248],   // 淡薰衣草 (0)
  [220, 180, 230],   // 薰衣草紫 (0.25)
  [255, 170, 200],   // 樱花粉 (0.5)
  [240, 210, 200],   // 蜜桃奶 (0.75)
  [255, 248, 250],   // 奶油白 (1)
];
// ramp B：薰衣草 × 蜜桃 × 暖白
const LENIA_RAMP_B = [
  [225, 210, 245],   // 淡紫 (0)
  [200, 170, 230],   // 薰衣草 (0.25)
  [255, 185, 200],   // 粉橘 (0.5)
  [255, 220, 185],   // 蜜桃 (0.75)
  [255, 248, 245],   // 暖白 (1)
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
  { max: 0,   l: 92, s: 88, a: 1.0 },    // 新生儿：最亮的粉白色
  { max: 1,   l: 82, s: 90, a: 0.98 },   // 幼崽：粉彩色
  { max: 2,   l: 72, s: 92, a: 0.94 },   // 青年：最鲜明的粉紫
  { max: 4,   l: 64, s: 88, a: 0.88 },   // 成熟
  { max: 9,   l: 56, s: 82, a: 0.80 },   // 中年
  { max: 19,  l: 50, s: 74, a: 0.68 },   // 老年
  { max: Infinity, l: 48, s: 66, a: 0.55 }, // 最老：柔和灰紫
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

    if (sim.kind === 'lenia') this._drawLenia(scale, ox, oy, activity);
    else this._drawLife(scale, ox, oy, activity, now);

    /* ====== 芳文社：极淡的虚线网格（几乎看不见） ====== */
    if (!this.compact) this._drawGrid(scale, ox, oy, W, H);

    /* ====== 事件脉冲签名 ====== */
    this._drawPulse(now, W, H);
    if (!this.compact) this._drawScan(now, W, H);
    this.flash *= 0.9;
  }

  /* ============================================================== */
  /* 芳文社 _drawLife：圆点细胞 + 三层水彩晕染 + 高光 + 呼吸感      */
  /* ============================================================== */
  _drawLife(scale, ox, oy, activity, now) {
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
    /* 新生儿 = cell * 2.8 半径 · 最亮                       */
    /* 老年 = cell * 1.4 半径 · 几乎消失                     */
    /* ====================================================== */
    ctx.globalCompositeOperation = 'lighter';
    for (let b = 0; b < Math.min(buckets.length, 5); b++) {
      const fakeAge = b === 0 ? 0 : b === 1 ? 1 : b === 2 ? 2 : b < 5 ? 4 : 20;
      const info = ageBucket(fakeAge, activity);
      // 光晕半径随年龄缩小：新生儿最大光晕 → 老细胞光晕消失
      const glowRadius = cell * (b === 0 ? 2.8 : b === 1 ? 2.2 : b === 2 ? 1.8 : 1.5);
      const glowAlpha = b === 0 ? 0.35 : b === 1 ? 0.18 : b === 2 ? 0.10 : 0.05;
      for (let p = 0; p < 2; p++) {
        const arr = buckets[b][p];
        if (!arr.length) continue;
        // 光晕色相偏暖一点（新生儿偏粉，老细胞偏紫）
        const hue = t.hue + b * 3 + (p ? -5 : 5);
        ctx.fillStyle = `hsla(${hue}, ${info.s}%, ${Math.min(85, info.l + 10)}%, ${glowAlpha})`;
        // 画一团：把每段 bucket 的坐标先连起来画一团大圆，比逐个画更像水彩晕染
        // 但为了确定性，还是逐个画 —— 不过加一点点随机抖动让边缘更松散
        ctx.beginPath();
        for (let k = 0; k < arr.length; k += 2) {
          const px = ox + arr[k] * cell + cell / 2;
          const py = oy + arr[k + 1] * cell + cell / 2;
          // 新生儿：呼吸抖动 ±cell*0.12（让它们"在呼吸"）
          const breath = b === 0
            ? Math.sin(time * 0.004 + (arr[k] * 13 + arr[k + 1] * 7) % 100 / 10) * cell * 0.08
            : 0;
          const r = glowRadius + breath;
          ctx.moveTo(px + r, py);
          ctx.arc(px, py, r, 0, Math.PI * 2);
        }
        ctx.fill();
      }
    }

    /* ====================================================== */
    /* Layer 2: 中层半透明实体圆（lighter 叠加）              */
    /* 年龄影响半径：新生儿 cell*0.55 → 老年 cell*0.30      */
    /* ====================================================== */
    const hueShift = activity * 6;
    for (let b = 0; b < buckets.length; b++) {
      const fakeAge = b === 0 ? 0 : b === 1 ? 1 : b === 2 ? 2 : b < 5 ? 4 : b < 6 ? 9 : 20;
      const info = ageBucket(fakeAge, activity);
      // 实体半径：新生儿最大 → 老年缩小
      const bodyRadius = cell * (b === 0 ? 0.55 : b === 1 ? 0.48 : b === 2 ? 0.44 : b < 5 ? 0.38 : 0.30);
      const alpha = info.a;
      for (let p = 0; p < 2; p++) {
        const arr = buckets[b][p];
        if (!arr.length) continue;
        const hue = t.hue + b * 3 + hueShift + (p ? 4 : -4);
        ctx.fillStyle = `hsla(${hue}, ${info.s}%, ${info.l}%, ${alpha})`;
        ctx.beginPath();
        for (let k = 0; k < arr.length; k += 2) {
          const px = ox + arr[k] * cell + cell / 2;
          const py = oy + arr[k + 1] * cell + cell / 2;
          const breath = b === 0
            ? Math.sin(time * 0.004 + (arr[k] * 13 + arr[k + 1] * 7) % 100 / 10) * cell * 0.04
            : 0;
          ctx.moveTo(px + bodyRadius + breath, py);
          ctx.arc(px, py, bodyRadius + breath, 0, Math.PI * 2);
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
    ctx.globalCompositeOperation = 'lighter';
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
    const elapsed = (now - p.t0) / 1000;
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
        const r = base * (0.18 + ((elapsed * 0.8 + i * 0.09) % 1) * 0.3);
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
        const r = base * (0.1 + ((elapsed + i * 0.35) % 1) * 0.42);
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
  if (!canvas || !snapshot) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const W = Math.max(1, Math.round((rect.width || opts.w || 240) * dpr));
  const H = Math.max(1, Math.round((rect.height || opts.h || 135) * dpr));
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const t = TINTS[tintKey] || TINTS.a;
  ctx.fillStyle = `rgb(${t.bg[0]},${t.bg[1]},${t.bg[2]})`;
  ctx.fillRect(0, 0, W, H);

  const { data, w, h } = snapshot;
  // crop to the organism's bounding box so sparse seeds still read as alive
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!data[y * w + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) {
    // extinct / dormant seed: keep a quiet specimen mark instead of an empty card
    const c = Math.min(W, H) * 0.22;
    ctx.strokeStyle = `hsla(${t.hue}, 70%, 55%, 0.35)`;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, c, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = `hsla(${t.hue}, 80%, 60%, 0.5)`;
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, Math.max(2, c * 0.1), 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const scale = Math.min((W * 0.9) / bw, (H * 0.9) / bh);
  const ox = (W - bw * scale) / 2 - minX * scale;
  const oy = (H - bh * scale) / 2 - minY * scale;
  const cell = Math.max(1, scale);
  // faint structural field
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = `hsla(${t.hue}, 82%, 58%, 0.14)`;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (!data[y * w + x]) continue;
      ctx.fillRect(ox + x * cell - cell, oy + y * cell - cell, cell * 3.2, cell * 3.2);
    }
  }
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (!data[y * w + x]) continue;
      const jitter = ((x * 13 + y * 7) % 5) / 40;
      ctx.fillStyle = `hsla(${t.hue + jitter * 40}, 88%, ${58 + jitter * 28}%, 0.92)`;
      ctx.fillRect(ox + x * cell, oy + y * cell, Math.max(1, cell * 0.9), Math.max(1, cell * 0.9));
    }
  }
  ctx.globalCompositeOperation = 'source-over';
  const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.14, W / 2, H / 2, H * 0.95);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.42)');
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
