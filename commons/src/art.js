/* ================================================================
 * Commons · Algorithmic Art Interaction Layer
 *
 * 借鉴 algorithmic-art p5.js 的核心哲学：
 *   过程即美学 · 受控混沌 · 种子确定性 · 交互即是创作
 *
 * 把算法艺术的交互范式嫁接到 Commons 生命层：
 *   1. PAINT       画笔直接在场上注入激活物质（像 p5.js 的 brush）
 *   2. NOISE       注入 Perlin 扰动（打破对称性 → 涌现新模式）
 *   3. NUCLEATE    撒下 Voronoi 菌落核心（stochastic crystallization）
 *   4. FIELD_PUSH  向量场推一下（局部施加力场 → 结构重塑）
 *
 * 每个操作都会发出声音（audio.js），让交互也是听觉创作。
 * 所有操作都被 JEPA PlayerPredictor 记录（直觉训练）。
 * ================================================================ */

/* ---- 交互模式常量 ---- */
export const INTERACTION_MODES = {
  NONE:       'none',
  PAINT:      'paint',
  NOISE:      'noise',
  NUCLEATE:   'nucleate',
  FIELD_PUSH: 'field_push',
};

export const INTERACTION_LABEL = {
  none:       '观看',
  paint:      '✏️ 画笔 · 注入激活',
  noise:      '🌪️ 扰动 · Perlin 破对称',
  nucleate:   '💎 结晶 · 撒下菌落核',
  field_push: '↗️ 场力 · 推一把',
};

export const INTERACTION_DESC = {
  none:       '不直接干预，只观察和听',
  paint:      '在画布上拖——把 v 场激活（白色物质）注入反应-扩散系统；Conway 系统则直接"播种"',
  noise:      '在画布上点——往 v 场注入 Perlin 噪声，打破对称性，往往会涌现出新 pattern',
  nucleate:   '在画布上点——撒下 Voronoi 菌落核心；Conway/Lenia 也会变成 Voronoi 边界形态',
  field_push: '在画布上拖——在该区域施加一个力向量，场被推动到新平衡，偶尔产生新吸引子',
};

/* ================================================================
 * 核心交互：引擎无关 —— 自动适配三种引擎
 * ================================================================ */

/**
 * 把画布 (cx, cy) 坐标转换成引擎网格坐标
 * engine 自动识别：.v/.u (scientific) | .grid/.width/.height (Conway/Lenia)
 */
export function canvasToGrid(engine, cx, cy, canvasW, canvasH) {
  // Scientific engine: 有 w, h 属性
  if (engine.w && engine.h) {
    const gx = Math.floor((cx / canvasW) * engine.w);
    const gy = Math.floor((cy / canvasH) * engine.h);
    return { gx, gy, engine, engineKind: 'scientific' };
  }
  // Conway / Lenia: 有 width / height / grid
  if (engine.width && engine.height) {
    const gx = Math.floor((cx / canvasW) * engine.width);
    const gy = Math.floor((cy / canvasH) * engine.height);
    return { gx, gy, engine, engineKind: 'cellular' };
  }
  return null;
}

/**
 * Paint：注入激活物质
 * 对反应-扩散：v 场在半径内加高斯凸起
 * 对 Conway：该半径内概率 60% 置为活
 * 对 Lenia：该半径内场值加 0.2 高斯凸起
 */
export function applyPaint(engine, gx, gy, radius = 4, strength = 0.7) {
  const info = describeEngine(engine);
  if (!info) return 0;
  let injected = 0;

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const nx = gx + dx, ny = gy + dy;
      if (nx < 0 || nx >= info.w || ny < 0 || ny >= info.h) continue;
      const dist = Math.hypot(dx, dy);
      if (dist > radius) continue;
      const falloff = Math.exp(-(dist * dist) / (2 * radius * 0.35));  // 高斯衰减

      if (info.kind === 'reaction-diffusion') {
        // 标准 Gray-Scott 激发：把该格推到 u=0.5, v=0.25，而不是 v=1。
        // v=1 会瞬间耗尽 u，修正后的五点 Laplacian 下斑图会直接熄灭。
        const idx = ny * info.w + nx;
        const w = strength * falloff;
        engine.u[idx] = clamp(engine.u[idx] + (0.5 - engine.u[idx]) * w, 0, 1);
        engine.v[idx] = clamp(engine.v[idx] + (0.25 - engine.v[idx]) * w, 0, 1);
        injected++;
      } else if (info.kind === 'conway') {
        const idx = ny * info.w + nx;
        if (Math.random() < strength * falloff * 0.8) {
          if (!info.grid[idx]) { info.grid[idx] = 1; injected++; }
        }
      } else if (info.kind === 'lenia') {
        const idx = ny * info.w + nx;
        engine.grid[idx] = clamp(engine.grid[idx] + strength * falloff * 0.3, 0, 1);
        injected++;
      }
    }
  }
  return injected;
}

/**
 * Noise：注入 Perlin 扰动（打破对称性）
 * 比 paint 更"乱"——让系统涌现新 pattern
 */
export function applyNoise(engine, gx, gy, radius = 6, seed = Date.now()) {
  const info = describeEngine(engine);
  if (!info) return 0;
  let affected = 0;
  let s = seed * 0.001;

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const nx = gx + dx, ny = gy + dy;
      if (nx < 0 || nx >= info.w || ny < 0 || ny >= info.h) continue;
      const dist = Math.hypot(dx, dy);
      if (dist > radius) continue;
      // 伪 Perlin：用三个 sin 叠加 + 高斯窗口
      const noise = (
        Math.sin((nx + s) * 0.23) * 0.5 +
        Math.sin((ny + s * 1.7) * 0.31 + s) * 0.4 +
        Math.sin((nx + ny + s * 0.7) * 0.15) * 0.3
      );
      const window = Math.exp(-(dist * dist) / (2 * radius * 0.4));
      const perturbation = noise * 0.5 * window;

      if (info.kind === 'reaction-diffusion') {
        const idx = ny * info.w + nx;
        engine.v[idx] = clamp(engine.v[idx] + perturbation * 0.6, 0, 1);
        engine.u[idx] = clamp(engine.u[idx] - perturbation * 0.3, 0, 1);
        affected++;
      } else if (info.kind === 'conway') {
        const idx = ny * info.w + nx;
        if (noise * window > 0.25) {
          info.grid[idx] = info.grid[idx] ? 0 : 1;  // 翻转
          affected++;
        }
      } else if (info.kind === 'lenia') {
        const idx = ny * info.w + nx;
        engine.grid[idx] = clamp(engine.grid[idx] + perturbation * 0.4, 0, 1);
        affected++;
      }
    }
  }
  return affected;
}

/**
 * Nucleate：撒下 Voronoi 菌落核心
 * 只写核心点 → 系统自然会在核心周围形成模式（Voronoi 边界效应）
 */
export function applyNucleation(engine, gx, gy, radius = 2, numSeeds = 3, seed = Date.now()) {
  const info = describeEngine(engine);
  if (!info) return 0;
  let placed = 0;

  // 在半径内均匀撒 N 个核心点
  for (let i = 0; i < numSeeds; i++) {
    const ang = Math.random() * Math.PI * 2;
    const r = Math.random() * radius;
    const nx = gx + Math.floor(Math.cos(ang) * r);
    const ny = gy + Math.floor(Math.sin(ang) * r);
    if (nx < 0 || nx >= info.w || ny < 0 || ny >= info.h) continue;

    if (info.kind === 'reaction-diffusion') {
      const idx = ny * info.w + nx;
      engine.v[idx] = 1.0;   // 饱和的 v 核心
      engine.u[idx] = 0.0;
      // 核心周围 2 格的 v 场线性衰减
      for (let d2 = 1; d2 <= 2; d2++) {
        for (const [ddx, ddy] of [[d2,0],[-d2,0],[0,d2],[0,-d2]]) {
          const ax = nx + ddx, ay = ny + ddy;
          if (ax < 0 || ax >= info.w || ay < 0 || ay >= info.h) continue;
          const aidx = ay * info.w + ax;
          engine.v[aidx] = clamp(engine.v[aidx] + 0.6 / d2, 0, 1);
          engine.u[aidx] = clamp(engine.u[aidx] - 0.3 / d2, 0, 1);
        }
      }
      placed++;
    } else if (info.kind === 'conway') {
      const idx = ny * info.w + nx;
      info.grid[idx] = 1;
      placed++;
    } else if (info.kind === 'lenia') {
      const idx = ny * info.w + nx;
      engine.grid[idx] = 0.8;
      placed++;
    }
  }
  return placed;
}

/**
 * Field Push：局部向量场力
 * 在 (gx, gy) 点向 (dx, dy) 方向"推"一下
 * 实现：把该方向的导数加到场上
 */
export function applyFieldPush(engine, gx, gy, dx, dy, radius = 8, strength = 0.25) {
  const info = describeEngine(engine);
  if (!info) return 0;
  let moved = 0;
  const len = Math.hypot(dx, dy) || 1;
  const nx0 = dx / len, ny0 = dy / len;  // 单位方向

  for (let d = 0; d < radius; d++) {
    const step = 1 - d / radius;  // 越远越弱
    const ix = Math.round(gx + nx0 * d);
    const iy = Math.round(gy + ny0 * d);
    if (ix < 0 || ix >= info.w || iy < 0 || iy >= info.h) continue;

    if (info.kind === 'reaction-diffusion') {
      const idx = iy * info.w + ix;
      // 力 = 方向导数 × 强度 × 距离衰减
      const force = strength * step;
      engine.v[idx] = clamp(engine.v[idx] + force, 0, 1);
      engine.u[idx] = clamp(engine.u[idx] - force * 0.5, 0, 1);
      moved++;
    } else if (info.kind === 'lenia') {
      const idx = iy * info.w + ix;
      engine.grid[idx] = clamp(engine.grid[idx] + strength * step, 0, 1);
      moved++;
    } else {
      moved++;  // Conway 不支持连续场，返回计数但不改
    }
  }
  return moved;
}

/* ================================================================
 * Engine 内省：自动识别引擎类型 + 尺寸
 * ================================================================ */

function describeEngine(engine) {
  if (!engine) return null;

  // Reaction-Diffusion (scientific.js)
  if (engine.v && engine.u && engine.w && engine.h) {
    return { kind: 'reaction-diffusion', w: engine.w, h: engine.h, grid: null };
  }
  // Conway / LifeEngine (engines.js)
  if (engine.grid && engine.width && engine.height) {
    return { kind: 'conway', w: engine.width, h: engine.height, grid: engine.grid };
  }
  // Lenia (engines.js)
  if (engine.width && engine.height && !engine.grid && engine.kind === 'lenia') {
    return { kind: 'lenia', w: engine.width, h: engine.height, grid: engine.grid };
  }
  // Lenia 可能有 engine.grid 是 Float32Array
  if (engine.width && engine.height) {
    return { kind: 'cellular', w: engine.width, h: engine.height, grid: engine.grid };
  }
  return null;
}

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

/* ================================================================
 * 新引擎：Voronoi Colonies（随机 Voronoi 菌落）
 *
 * 受 algorithmic-art 的 stochastic crystallization 启发：
 *   在画布上撒 N 个随机种子点
 *   每个种子独占一个 Voronoi 胞腔
 *   胞腔边界是生命活动的"膜"
 *   胞腔内部按 Conway 规则演化
 *
 * 这是 **Voronoi 边界条件 + Conway 演化** 的混合引擎，
 * 填补了传统 Conway 只能用矩形边界的空白。
 * ================================================================ */

export class VoronoiColonyEngine {
  constructor(w, h, nSeeds = 8, rngSeed = 42) {
    this.width = w;
    this.height = h;
    this.kind = 'voronoi-colony';
    const rng = mulberry32(rngSeed);

    // 撒种子点
    this.seeds = [];
    for (let i = 0; i < nSeeds; i++) {
      this.seeds.push({
        x: rng() * w,
        y: rng() * h,
        area: 0,
        cells: new Set(),
      });
    }

    // 预计算每个格点属于哪个种子（Voronoi 镶嵌）
    this.grid = new Uint8Array(w * h);   // 0=死, 1=活
    this.owners = new Uint16Array(w * h); // 每个格点属于哪个种子
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let best = 0, bestD = Infinity;
        for (let s = 0; s < this.seeds.length; s++) {
          const dx = x - this.seeds[s].x;
          const dy = y - this.seeds[s].y;
          const d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; best = s; }
        }
        this.owners[y * w + x] = best;
        this.seeds[best].area++;
      }
    }

    // 每个胞腔内部随机播一点 Conway 生命（3% 密度）
    for (let i = 0; i < this.grid.length; i++) {
      if (rng() < 0.03) this.grid[i] = 1;
    }

    this.t = 0;
  }

  reset() { this.grid.fill(0); }

  step() {
    const w = this.width, h = this.height;
    const next = new Uint8Array(w * h);

    // 胞腔内 Conway 规则（在自己胞腔内数邻居，边界不越胞）
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        const owner = this.owners[idx];
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            // 关键：邻居必须和自己同胞腔（Voronoi 边界是膜）
            if (this.owners[ny * w + nx] !== owner) continue;
            n += this.grid[ny * w + nx] ? 1 : 0;
          }
        }
        const alive = this.grid[idx];
        next[idx] = alive ? (n === 2 || n === 3 ? 1 : 0) : (n === 3 ? 1 : 0);
      }
    }
    this.grid = next;
    this.t++;
  }

  snapshot() {
    return new Uint8Array(this.grid);
  }
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6D2B79F5;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/* ================================================================
 * 算法艺术色板（给 Voronoi colony 每个胞腔分配一个种子色相）
 * 灵感来自 Stochastic Crystallization 运动的"结晶染色"
 * ================================================================ */

/* ================================================================
 * 画布事件绑定（一行搞定：app.js 只需 initArtInteraction(canvas, getEngine, state)）
 * ================================================================ */

export function bindArtInteraction(stageCanvas, compareA, compareB, engineGetter, getMode) {
  if (!stageCanvas) return () => {};
  const canvases = [stageCanvas, compareA, compareB].filter(Boolean);
  const dragState = { active: false, lastX: 0, lastY: 0 };

  const pos = (ev, c) => {
    const r = c.getBoundingClientRect();
    const cx = (ev.clientX - r.left) * (c.width / r.width);
    const cy = (ev.clientY - r.top) * (c.height / r.height);
    return { cx, cy };
  };

  const pointerdown = (ev) => {
    const mode = getMode();
    if (!mode || mode === 'none') return;
    const c = ev.currentTarget;
    const e = engineGetter();
    if (!e) return;
    const { cx, cy } = pos(ev, c);
    const info = canvasToGrid(e, cx, cy, c.width, c.height);
    if (!info) return;

    let n = 0;
    if (mode === 'paint')      n = applyPaint(e, info.gx, info.gy, 5, 0.7);
    else if (mode === 'noise') n = applyNoise(e, info.gx, info.gy, 8, Date.now());
    else if (mode === 'nucleate') n = applyNucleation(e, info.gx, info.gy, 5, 4, Date.now());
    else if (mode === 'field_push') { dragState.active = true; dragState.lastX = cx; dragState.lastY = cy; return; }

    // 声音反馈：每次交互发一个 pentatonic 音
    playInteractionBlip(mode, n);
  };

  const pointermove = (ev) => {
    const mode = getMode();
    if (!mode || mode === 'none') return;
    const c = ev.currentTarget;
    const e = engineGetter();
    if (!e) return;
    const { cx, cy } = pos(ev, c);
    const info = canvasToGrid(e, cx, cy, c.width, c.height);
    if (!info) return;

    // Paint / Field_Push 支持拖拽；Noise / Nucleate 只点一次
    if (mode === 'paint') {
      if (!ev.buttons) return;  // 按住才刷
      applyPaint(e, info.gx, info.gy, 4, 0.5);
    } else if (mode === 'field_push' && dragState.active) {
      const dx = cx - dragState.lastX;
      const dy = cy - dragState.lastY;
      if (Math.hypot(dx, dy) < 3) return;
      applyFieldPush(e, info.gx, info.gy, dx, dy, 6, 0.3);
      dragState.lastX = cx; dragState.lastY = cy;
    }
  };

  const pointerup = () => { dragState.active = false; };

  canvases.forEach(c => {
    c.addEventListener('pointerdown', pointerdown);
    c.addEventListener('pointermove', pointermove);
    c.addEventListener('pointerup', pointerup);
    c.addEventListener('pointerleave', pointerup);
  });

  // 返回 unbind 函数
  return () => {
    canvases.forEach(c => {
      c.removeEventListener('pointerdown', pointerdown);
      c.removeEventListener('pointermove', pointermove);
      c.removeEventListener('pointerup', pointerup);
      c.removeEventListener('pointerleave', pointerup);
    });
  };
}

/* 交互声音反馈（五声音阶：paint→主音, noise→偏音, nucleate→高八度, push→下行滑音）*/
function playInteractionBlip(mode, intensity) {
  try {
    // 复用 audio.js 的 createAudioContext（全局已初始化）
    const globalCtor = window.__commonsAudioCtor;
    if (!globalCtor) return;
    const { createAudioContext } = globalCtor;
    const ctx = createAudioContext();
    if (!ctx) return;

    const masterMidi = [60, 62, 64, 67, 69]; // C major pentatonic C D E G A
    const pickNote = (idx) => 440 * Math.pow(2, (masterMidi[idx] - 69) / 12);

    let freq = pickNote(0);
    let duration = 0.25;
    let wave = 'sine';
    let vol = 0.08 + Math.min(0.12, intensity * 0.002);

    if (mode === 'paint')       { freq = pickNote(0); wave = 'triangle'; duration = 0.18; }
    else if (mode === 'noise')  { freq = pickNote(3); wave = 'sawtooth';  duration = 0.30; }
    else if (mode === 'nucleate'){freq = pickNote(2) * 2; wave = 'sine';     duration = 0.40; vol *= 1.4; }
    else if (mode === 'field_push'){ freq = pickNote(4) * 0.75; wave = 'square'; duration = 0.22; vol *= 0.8; }

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = wave;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(vol, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration + 0.02);
  } catch (e) { /* audio not ready — silence is fine */ }
}

export const VORONOI_PALETTES = {
  /** 樱花 · 薰衣草 · 薄荷 · 蜜桃 · 柠檬 · 天青（6 色）*/
  sakura:   [340, 280, 155, 28, 55, 200],
  /** 赤橙黄绿青蓝紫（彩虹 7 色）*/
  rainbow:  [0, 28, 55, 120, 180, 210, 270],
  /** 深空：冷紫 · 靛蓝 · 青 · 深绿 · 灰蓝 · 深夜 */
  abyss:    [260, 225, 195, 155, 230, 280],
  /** 琥珀金：金黄 · 橙 · 红 · 酒红 · 玫瑰金 · 铜 */
  amber:    [40, 18, 0, 350, 330, 12],
};
