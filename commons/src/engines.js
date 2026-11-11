// Life layer: Conway / rule variants / simplified Lenia.
// Deterministic given (genome, environment, rngSeed). Includes structural metrics.

import { clamp, hashInts, mulberry32 } from './rng.js';

export const ENGINE_VERSION = '1.0.0';
export const GRID_W = 160;
export const GRID_H = 90;

export const LIFE_PRESETS = {
  conway: { label: '康威', birth: [3], survive: [2, 3], note: 'B3/S23 · 经典生命' },
  highlife: { label: '高生命', birth: [3, 6], survive: [2, 3], note: 'B36/S23 · 会自我复制' },
  daynight: { label: '昼夜', birth: [3, 6, 7, 8], survive: [3, 4, 6, 7, 8], note: 'B3678/S34678 · 对称与湍流' },
  seeds: { label: '种子', birth: [2], survive: [], note: 'B2/S · 爆炸式扩散' },
  maze: { label: '迷宫', birth: [3], survive: [1, 2, 3, 4, 5], note: 'B3/S12345 · 长走廊' },
  coral: { label: '珊瑚', birth: [3], survive: [4, 5, 6, 7, 8], note: 'B3/S45678 · 缓慢生长' },
  replicator: { label: '复制者', birth: [1, 3, 5, 7], survive: [1, 3, 5, 7], note: 'B1357/S1357 · 自我复制' },
};

export const LENIA_PRESETS = {
  bloom: { label: '绽放', mu: 0.16, sigma: 0.025, radius: 4, dt: 0.1, note: '稀疏群落 · 呼吸' },
  tide: { label: '潮汐', mu: 0.12, sigma: 0.02, radius: 6, dt: 0.08, note: '宽核 · 缓慢涌动' },
  coral: { label: '珊瑚', mu: 0.18, sigma: 0.03, radius: 5, dt: 0.08, note: '高阈值 · 结晶' },
  vortex: { label: '涡旋', mu: 0.12, sigma: 0.02, radius: 5, dt: 0.1, note: '软核 · 流动' },
};

export const PATTERNS = {
  soup: '随机汤',
  sparse: '稀疏孢子',
  glider: '滑翔群',
  oscillator: '振荡阵列',
  blob: '原生团块',
  ring: '环带',
  cross: '十字脉',
};

export const BOUNDARIES = { torus: '环面', wall: '硬壁' };

export const SCALES = {
  major: { label: '大调五声', degrees: [0, 2, 4, 7, 9], note: '宫商角徵羽' },
  minor: { label: '小调五声', degrees: [0, 3, 5, 7, 10], note: '羽宫商角徵' },
  lydian: { label: '利底亚五声', degrees: [0, 2, 6, 7, 9], note: '明亮悬浮' },
};

export const ROOT_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

export function defaultGenome(engine = 'life', preset = 'conway') {
  const genome = {
    engine,
    life: { birth: [3], survive: [2, 3], neighborhood: 8, preset: 'conway' },
    lenia: { mu: 0.16, sigma: 0.025, radius: 4, dt: 0.1, preset: 'bloom' },
    mapping: {
      root: 0,
      octave: 3,
      scale: 'major',
      wave: 'triangle',
      register: 0.5,
      brightness: 0.55,
      tempo: 0.45,
      strictness: 0.72,
      drone: true,
      pulse: true,
      events: true,
    },
  };
  if (engine === 'life') applyLifePreset(genome, preset);
  else applyLeniaPreset(genome, preset);
  return genome;
}

export function applyLifePreset(genome, key) {
  const p = LIFE_PRESETS[key];
  if (!p) return;
  genome.engine = 'life';
  genome.life.birth = p.birth.slice();
  genome.life.survive = p.survive.slice();
  genome.life.preset = key;
}

export function applyLeniaPreset(genome, key) {
  const p = LENIA_PRESETS[key];
  if (!p) return;
  genome.engine = 'lenia';
  genome.lenia.mu = p.mu;
  genome.lenia.sigma = p.sigma;
  genome.lenia.radius = p.radius;
  genome.lenia.dt = p.dt;
  genome.lenia.preset = key;
}

export function defaultEnv(overrides = {}) {
  return {
    pattern: 'soup',
    boundary: 'torus',
    noise: 0,
    resource: { rate: 0, period: 90 },
    timeScale: 1,
    constraint: 0.35,
    ...overrides,
  };
}

export function cloneGenome(g) {
  return JSON.parse(JSON.stringify(g));
}

export function cloneEnv(e) {
  return JSON.parse(JSON.stringify(e));
}

/* ------------------------------------------------------------------ */
/* Signature helpers                                                   */
/* ------------------------------------------------------------------ */

function translationInvariantSignature(isAlive, w, h) {
  const bins = new Uint32Array(512);
  let samples = 0;
  for (let y = 0; y < h; y += 3) {
    for (let x = 0; x < w; x += 3) {
      let code = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = (y + dy + h) % h;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = (x + dx + w) % w;
          code = (code << 1) | (isAlive(ny * w + nx) ? 1 : 0);
        }
      }
      bins[code]++;
      samples++;
    }
  }
  const ints = new Array(513);
  for (let i = 0; i < 512; i++) ints[i] = bins[i];
  ints[512] = samples;
  return hashInts(ints);
}

export function detectPeriod(history) {
  const n = history.length;
  if (n < 6) return 0;
  for (let p = 1; p <= 24; p++) {
    if (n < p * 2 + 2) break;
    let ok = true;
    const span = Math.min(p * 2, n - p - 1);
    for (let k = 0; k < span; k++) {
      if (history[n - 1 - k] !== history[n - 1 - k - p]) {
        ok = false;
        break;
      }
    }
    if (ok) return p;
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* Conway & friends                                                    */
/* ------------------------------------------------------------------ */

export class LifeEngine {
  constructor(genome, env, rngSeed, w = GRID_W, h = GRID_H) {
    this.kind = 'life';
    this.w = w;
    this.h = h;
    this.rngSeed = rngSeed >>> 0;
    this.rng = mulberry32(this.rngSeed ^ 0x9e3779b9);
    this.grid = new Uint8Array(w * h);
    this.next = new Uint8Array(w * h);
    this.age = new Uint8Array(w * h);
    this.nextAge = new Uint8Array(w * h);
    this.neighborHist = new Uint32Array(9);
    this.sigHistory = [];
    this.densityHistory = [];
    this.activity = 0;
    this.aliveCount = 0;
    this.gen = 0;
    this.lastBirths = [];
    this.lastDeaths = 0;
    this.genome = cloneGenome(genome);
    this.env = cloneEnv(env);
    this.applyGenome(genome);
    this.reset();
  }

  applyGenome(genome) {
    this.genome = cloneGenome(genome);
    const birth = new Uint8Array(9);
    const survive = new Uint8Array(9);
    for (const n of genome.life.birth) birth[n] = 1;
    for (const n of genome.life.survive) survive[n] = 1;
    this.birthLUT = birth;
    this.surviveLUT = survive;
    this.moore = genome.life.neighborhood !== 4;
  }

  setEnv(env) {
    this.env = cloneEnv(env);
  }

  reset() {
    const { w, h, grid, age } = this;
    const rand = this.rng;
    grid.fill(0);
    age.fill(0);
    const pattern = this.env.pattern;

    const put = (x, y) => {
      x = ((x % w) + w) % w;
      y = ((y % h) + h) % h;
      grid[y * w + x] = 1;
    };
    const glider = (ox, oy) => {
      put(ox + 1, oy);
      put(ox + 2, oy + 1);
      put(ox, oy + 2);
      put(ox + 1, oy + 2);
      put(ox + 2, oy + 2);
    };

    if (pattern === 'soup' || pattern === 'dunes') {
      for (let i = 0; i < grid.length; i++) grid[i] = rand() < 0.29 ? 1 : 0;
    } else if (pattern === 'sparse') {
      for (let i = 0; i < grid.length; i++) grid[i] = rand() < 0.055 ? 1 : 0;
    } else if (pattern === 'glider') {
      for (let i = 0; i < 7; i++) {
        glider(Math.floor(rand() * w), Math.floor(rand() * h));
      }
      for (let i = 0; i < 2; i++) {
        put(Math.floor(rand() * w), Math.floor(rand() * h));
      }
    } else if (pattern === 'oscillator') {
      const step = 14;
      for (let y = 6; y < h - 3; y += step) {
        for (let x = 6; x < w - 3; x += step) {
          if (rand() < 0.55) {
            put(x, y + 1);
            put(x + 1, y + 1);
            put(x + 2, y + 1);
          } else {
            put(x + 1, y);
            put(x + 1, y + 1);
            put(x + 1, y + 2);
          }
        }
      }
    } else if (pattern === 'blob') {
      for (let b = 0; b < 5; b++) {
        const cx = Math.floor(rand() * w);
        const cy = Math.floor(rand() * h);
        const r = 6 + rand() * 10;
        for (let y = -r; y <= r; y++) {
          for (let x = -r; x <= r; x++) {
            if (x * x + y * y < r * r && rand() < 0.62) put(cx + x, cy + y);
          }
        }
      }
    } else if (pattern === 'ring') {
      const cx = w / 2;
      const cy = h / 2;
      const rr = Math.min(w, h) * 0.31;
      const thick = 3.4;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const d = Math.hypot(x - cx, (y - cy) * 1.0);
          if (Math.abs(d - rr) < thick && rand() < 0.8) put(x, y);
        }
      }
    } else if (pattern === 'cross') {
      const cx = Math.floor(w / 2);
      const cy = Math.floor(h / 2);
      for (let x = 0; x < w; x++) if (rand() < 0.55) put(x, cy);
      for (let y = 0; y < h; y++) if (rand() < 0.55) put(cx, y);
      for (let i = 0; i < 3; i++) glider(cx + 8 + i * 6, cy + 10);
    }

    this.nextAge.fill(0);
    this.aliveCount = 0;
    for (let i = 0; i < grid.length; i++) this.aliveCount += grid[i];
    this.gen = 0;
    this.activity = 0;
    this.sigHistory = [this.computeSignature()];
    this.densityHistory = [this.aliveCount / grid.length];
  }

  computeSignature() {
    const { w, h, grid } = this;
    return translationInvariantSignature((i) => grid[i] === 1, w, h);
  }

  neighbors(x, y, grid) {
    const { w, h } = this;
    const wrap = this.env.boundary === 'torus';
    let n = 0;
    if (this.moore) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          let nx = x + dx;
          let ny = y + dy;
          if (wrap) {
            if (nx < 0) nx += w;
            else if (nx >= w) nx -= w;
            if (ny < 0) ny += h;
            else if (ny >= h) ny -= h;
          } else if (nx < 0 || nx >= w || ny < 0 || ny >= h) {
            continue;
          }
          n += grid[ny * w + nx];
        }
      }
    } else {
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (const [dx, dy] of dirs) {
        let nx = x + dx;
        let ny = y + dy;
        if (wrap) {
          if (nx < 0) nx += w;
          else if (nx >= w) nx -= w;
          if (ny < 0) ny += h;
          else if (ny >= h) ny -= h;
        } else if (nx < 0 || nx >= w || ny < 0 || ny >= h) {
          continue;
        }
        n += grid[ny * w + nx];
      }
    }
    return n;
  }

  step() {
    const { w, h, grid, next, nextAge, age, birthLUT, surviveLUT, neighborHist } = this;
    const prevAlive = this.aliveCount;
    neighborHist.fill(0);
    let births = 0;
    let deaths = 0;
    let alive = 0;
    const birthSamples = [];

    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        const n = this.neighbors(x, y, grid);
        neighborHist[n]++;
        const a = grid[i];
        const nb = a ? surviveLUT[n] : birthLUT[n];
        next[i] = nb;
        if (nb) {
          alive++;
          nextAge[i] = a ? (age[i] < 254 ? age[i] + 1 : 255) : 0;
          if (!a) {
            births++;
            if (birthSamples.length < 32) birthSamples.push(i);
            else if (this.rng() < 32 / births) {
              birthSamples[Math.floor(this.rng() * 32)] = i;
            }
          }
        } else {
          nextAge[i] = 0;
          if (a) deaths++;
        }
      }
    }

    // stochastic perturbation — reproducible through the engine rng
    const effNoise = this.env.noise * (1 - 0.85 * this.env.constraint);
    const flips = Math.round(effNoise * 55);
    for (let k = 0; k < flips; k++) {
      const i = Math.floor(this.rng() * next.length);
      if (next[i]) {
        next[i] = 0;
        nextAge[i] = 0;
        alive--;
        deaths++;
      } else {
        next[i] = 1;
        nextAge[i] = 0;
        alive++;
        births++;
        if (birthSamples.length < 32) birthSamples.push(i);
      }
    }

    // resource rhythm: pulsed nutrient injection
    const res = this.env.resource;
    if (res && res.rate > 0) {
      const phase = Math.sin((this.gen / Math.max(4, res.period)) * Math.PI * 2);
      if (phase > 0.25) {
        const drops = Math.round(res.rate * phase * 16);
        for (let k = 0; k < drops; k++) {
          const i = Math.floor(this.rng() * next.length);
          if (!next[i]) {
            next[i] = 1;
            nextAge[i] = 0;
            alive++;
            births++;
            if (birthSamples.length < 32) birthSamples.push(i);
          }
        }
      }
    }

    this.grid = next;
    this.next = grid;
    this.age = nextAge;
    this.nextAge = age;
    this.aliveCount = alive;
    this.gen++;

    const turnover = (births + deaths) / Math.max(6, prevAlive);
    this.activity = clamp(this.activity * 0.72 + turnover * 0.28, 0, 2);
    this.lastDeaths = deaths;
    this.lastBirths = birthSamples.map((i) => ({ x: i % w, y: Math.floor(i / w) }));

    this.sigHistory.push(this.computeSignature());
    if (this.sigHistory.length > 70) this.sigHistory.shift();
    this.densityHistory.push(alive / (w * h));
    if (this.densityHistory.length > 120) this.densityHistory.shift();

    return { births, deaths, alive };
  }

  isAlive(i) {
    return this.grid[i] === 1;
  }

  snapshot(scale = 2) {
    const { w, h, grid } = this;
    const ow = Math.floor(w / scale);
    const oh = Math.floor(h / scale);
    const out = new Uint8Array(ow * oh);
    for (let y = 0; y < oh; y++) {
      for (let x = 0; x < ow; x++) {
        let v = 0;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            v |= grid[(y * scale + sy) * w + (x * scale + sx)];
          }
        }
        out[y * ow + x] = v ? 1 : 0;
      }
    }
    return { data: out, w: ow, h: oh };
  }
}

/* ------------------------------------------------------------------ */
/* Simplified Lenia                                                    */
/* ------------------------------------------------------------------ */

function buildKernel(radius) {
  const R = Math.max(2, Math.min(6, radius));
  const cx = R * 0.55;
  const width = Math.max(0.85, R * 0.19);
  const weights = [];
  let sum = 0;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const r = Math.hypot(dx, dy);
      if (r > R + 1e-6) continue;
      const wgt = Math.exp(-((r - cx) ** 2) / (2 * width * width));
      if (wgt < 0.002) continue;
      weights.push({ dx, dy, w: wgt });
      sum += wgt;
    }
  }
  for (const k of weights) k.w /= sum;
  return weights;
}

export class LeniaEngine {
  constructor(genome, env, rngSeed, w = GRID_W, h = GRID_H) {
    this.kind = 'lenia';
    this.w = w;
    this.h = h;
    this.rngSeed = rngSeed >>> 0;
    this.rng = mulberry32(this.rngSeed ^ 0x51ed270b);
    this.field = new Float32Array(w * h);
    this.next = new Float32Array(w * h);
    this.sigHistory = [];
    this.densityHistory = [];
    this.activity = 0;
    this.aliveCount = 0;
    this.gen = 0;
    this.lastBirths = [];
    this.lastDeaths = 0;
    this.genome = cloneGenome(genome);
    this.env = cloneEnv(env);
    this.applyGenome(genome);
    this.reset();
  }

  applyGenome(genome) {
    this.genome = cloneGenome(genome);
    this.kernel = buildKernel(genome.lenia.radius);
    this.mu = genome.lenia.mu;
    this.sigma = genome.lenia.sigma;
    this.dt = genome.lenia.dt;
  }

  setEnv(env) {
    this.env = cloneEnv(env);
  }

  reset() {
    const { w, h, field } = this;
    const rand = this.rng;
    field.fill(0);
    const pattern = this.env.pattern;

    const blob = (cx, cy, rx, ry, peak = 1) => {
      for (let y = Math.floor(cy - ry * 2); y <= cy + ry * 2; y++) {
        for (let x = Math.floor(cx - rx * 2); x <= cx + rx * 2; x++) {
          const dx = (x - cx) / rx;
          const dy = (y - cy) / ry;
          const d2 = dx * dx + dy * dy;
          if (d2 > 4) continue;
          const v = peak * Math.exp(-d2 * 1.7);
          const nx = ((x % w) + w) % w;
          const ny = ((y % h) + h) % h;
          field[ny * w + nx] = Math.min(1, field[ny * w + nx] + v);
        }
      }
    };

    if (pattern === 'soup') {
      for (let i = 0; i < field.length; i++) field[i] = rand() * 0.32;
    } else if (pattern === 'sparse') {
      for (let b = 0; b < 9; b++) {
        blob(rand() * w, rand() * h, 2 + rand() * 4, 2 + rand() * 4, 0.38);
      }
    } else if (pattern === 'glider') {
      for (let b = 0; b < 4; b++) {
        blob(rand() * w, rand() * h, 5 + rand() * 3, 5 + rand() * 3, 0.42);
      }
    } else if (pattern === 'oscillator') {
      blob(w * 0.32, h * 0.5, 8, 8, 0.4);
      blob(w * 0.68, h * 0.5, 8, 8, 0.4);
    } else if (pattern === 'blob') {
      for (let b = 0; b < 5; b++) {
        blob(rand() * w, rand() * h, 4 + rand() * 7, 4 + rand() * 7, 0.4);
      }
    } else if (pattern === 'ring') {
      const cx = w / 2;
      const cy = h / 2;
      const rr = Math.min(w, h) * 0.3;
      for (let i = 0; i < 900; i++) {
        const a = rand() * Math.PI * 2;
        const r = rr + (rand() - 0.5) * 1.2;
        const x = Math.round(cx + Math.cos(a) * r);
        const y = Math.round(cy + Math.sin(a) * r);
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        field[y * w + x] = Math.min(1, field[y * w + x] + 0.34);
      }
    } else if (pattern === 'cross') {
      for (let x = 0; x < w; x++) field[Math.floor(h / 2) * w + x] = 0.4;
      for (let y = 0; y < h; y++) field[y * w + Math.floor(w / 2)] = 0.4;
    }

    this.activity = 0;
    this.aliveCount = this.countAlive();
    this.gen = 0;
    this.sigHistory = [this.computeSignature()];
    this.densityHistory = [this.aliveCount / (w * h)];
  }

  countAlive() {
    const f = this.field;
    let n = 0;
    for (let i = 0; i < f.length; i++) if (f[i] > 0.35) n++;
    return n;
  }

  computeSignature() {
    const { w, h, field } = this;
    return translationInvariantSignature((i) => field[i] > 0.35, w, h);
  }

  step() {
    const { w, h, field, next, kernel } = this;
    const wrap = this.env.boundary === 'torus';
    const nk = kernel.length;
    const mu = this.mu;
    const sigma = this.sigma;
    const dt = this.dt;
    const inv2s2 = 1 / (2 * sigma * sigma);
    let deltaSum = 0;
    const prevAlive = this.aliveCount;
    const births = [];
    let birthTotal = 0;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let k = 0; k < nk; k++) {
          const o = kernel[k];
          let nx = x + o.dx;
          let ny = y + o.dy;
          if (wrap) {
            if (nx < 0) nx += w;
            else if (nx >= w) nx -= w;
            if (ny < 0) ny += h;
            else if (ny >= h) ny -= h;
          } else if (nx < 0 || nx >= w || ny < 0 || ny >= h) {
            continue;
          }
          sum += field[ny * w + nx] * o.w;
        }
        const g = 2 * Math.exp(-((sum - mu) ** 2) * inv2s2) - 1;
        let v = field[y * w + x] + dt * g;
        if (v < 0) v = 0;
        else if (v > 1) v = 1;
        const i = y * w + x;
        deltaSum += Math.abs(v - field[i]);
        next[i] = v;
        if (v > 0.35 && field[i] <= 0.35) {
          birthTotal++;
          if (births.length < 24) births.push({ x, y });
          else {
            const j = Math.floor(this.rng() * birthTotal);
            if (j < 24) births[j] = { x, y };
          }
        }
      }
    }

    const effNoise = this.env.noise * (1 - 0.85 * this.env.constraint) * 0.06;
    if (effNoise > 0) {
      for (let i = 0; i < next.length; i++) {
        if (this.rng() < 0.06) {
          next[i] = clamp(next[i] + (this.rng() - 0.5) * effNoise, 0, 1);
        }
      }
    }

    const res = this.env.resource;
    if (res && res.rate > 0) {
      const phase = Math.sin((this.gen / Math.max(4, res.period)) * Math.PI * 2);
      if (phase > 0.2) {
        const drops = Math.round(res.rate * phase * 10);
        for (let k = 0; k < drops; k++) {
          const i = Math.floor(this.rng() * next.length);
          next[i] = clamp(next[i] + 0.35 * res.rate, 0, 1);
        }
      }
    }

    this.field = next;
    this.next = field;
    this.gen++;
    const alive = this.countAlive();
    const turnover = Math.abs(alive - prevAlive) / Math.max(20, prevAlive) + deltaSum / field.length;
    this.activity = clamp(this.activity * 0.8 + turnover * 0.9, 0, 2);
    this.aliveCount = alive;
    this.lastBirths = births;
    this.lastDeaths = Math.max(0, prevAlive - alive);

    this.sigHistory.push(this.computeSignature());
    if (this.sigHistory.length > 70) this.sigHistory.shift();
    this.densityHistory.push(alive / (w * h));
    if (this.densityHistory.length > 120) this.densityHistory.shift();
    return { births: births.length, deaths: this.lastDeaths, alive };
  }

  isAlive(i) {
    return this.field[i] > 0.35;
  }

  snapshot(scale = 2) {
    const { w, h, field } = this;
    const ow = Math.floor(w / scale);
    const oh = Math.floor(h / scale);
    const out = new Uint8Array(ow * oh);
    for (let y = 0; y < oh; y++) {
      for (let x = 0; x < ow; x++) {
        let v = 0;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            v = Math.max(v, field[(y * scale + sy) * w + (x * scale + sx)]);
          }
        }
        out[y * ow + x] = v > 0.35 ? 1 : 0;
      }
    }
    return { data: out, w: ow, h: oh };
  }
}

export function createEngine(genome, env, rngSeed, w = GRID_W, h = GRID_H) {
  return genome.engine === 'lenia'
    ? new LeniaEngine(genome, env, rngSeed, w, h)
    : new LifeEngine(genome, env, rngSeed, w, h);
}

/* ------------------------------------------------------------------ */
/* Structural metrics                                                  */
/* ------------------------------------------------------------------ */

function bfsComponent(start, isAlive, w, h, visited, queue) {
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  visited[start] = 1;
  const cells = [];
  while (head < tail) {
    const i = queue[head++];
    cells.push(i);
    const x = i % w;
    const y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (!visited[j] && isAlive(j)) {
          visited[j] = 1;
          queue[tail++] = j;
        }
      }
    }
  }
  return cells;
}

function componentDiameter(cells, isAlive, w, h) {
  if (cells.length <= 1) return 0;
  const dist = new Int32Array(w * h).fill(-1);
  const queue = new Int32Array(w * h);
  const sweep = (start) => {
    dist.fill(-1);
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    dist[start] = 0;
    let far = start;
    let maxd = 0;
    while (head < tail) {
      const i = queue[head++];
      const d = dist[i];
      if (d > maxd) {
        maxd = d;
        far = i;
      }
      const x = i % w;
      const y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (dist[j] === -1 && isAlive(j)) {
            dist[j] = d + 1;
            queue[tail++] = j;
          }
        }
      }
    }
    return { far, maxd };
  };
  const a = sweep(cells[0]);
  const b = sweep(a.far);
  return b.maxd;
}

export function computeMetrics(sim) {
  const w = sim.w;
  const h = sim.h;
  const isLenia = sim.kind === 'lenia';
  const isAlive = isLenia ? (i) => sim.field[i] > 0.35 : (i) => sim.grid[i] === 1;
  const total = w * h;

  // density
  let alive = 0;
  for (let i = 0; i < total; i++) if (isAlive(i)) alive++;
  const density = alive / total;

  // block occupancy entropy
  const bs = 6;
  let blockSum = 0;
  let blocks = 0;
  for (let by = 0; by < h; by += bs) {
    for (let bx = 0; bx < w; bx += bs) {
      let c = 0;
      let n = 0;
      for (let y = by; y < Math.min(by + bs, h); y++) {
        for (let x = bx; x < Math.min(bx + bs, w); x++) {
          n++;
          if (isAlive(y * w + x)) c++;
        }
      }
      const p = c / Math.max(1, n);
      if (p > 0 && p < 1) {
        blockSum += -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
      }
      blocks++;
    }
  }
  const blockEntropy = blockSum / Math.max(1, blocks);

  // 3x3 pattern entropy (stride 2)
  const bins = new Uint32Array(512);
  let samples = 0;
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      let code = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = (y + dy + h) % h;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = (x + dx + w) % w;
          code = (code << 1) | (isAlive(ny * w + nx) ? 1 : 0);
        }
      }
      bins[code]++;
      samples++;
    }
  }
  let patternH = 0;
  for (let i = 0; i < 512; i++) {
    if (!bins[i]) continue;
    const p = bins[i] / samples;
    patternH -= p * Math.log2(p);
  }
  const patternEntropy = clamp(patternH / 9, 0, 1);
  const entropy = clamp(patternEntropy * 0.58 + blockEntropy * 0.42, 0, 1);

  // connected components + adjacency diameter
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  let components = 0;
  let largest = [];
  for (let i = 0; i < total; i++) {
    if (isAlive(i) && !visited[i]) {
      const cells = bfsComponent(i, isAlive, w, h, visited, queue);
      components++;
      if (cells.length > largest.length) largest = cells;
    }
  }
  const diameter = largest.length > 1 ? componentDiameter(largest, isAlive, w, h) : 0;
  const diameterNorm = clamp(diameter / Math.min(w, h), 0, 1);

  // period from translation-invariant signatures
  const period = detectPeriod(sim.sigHistory);

  // trend over recent density history
  const dh = sim.densityHistory;
  const trendWindow = dh.slice(-32);
  let trend = 0;
  if (trendWindow.length > 4) {
    const n = trendWindow.length;
    const meanX = (n - 1) / 2;
    const meanY = trendWindow.reduce((a, b) => a + b, 0) / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      num += (i - meanX) * (trendWindow[i] - meanY);
      den += (i - meanX) ** 2;
    }
    trend = num / Math.max(1, den);
  }

  // fluctuation
  let fluctuation = 0;
  if (trendWindow.length > 2) {
    const m = trendWindow.reduce((a, b) => a + b, 0) / trendWindow.length;
    fluctuation = Math.sqrt(
      trendWindow.reduce((a, b) => a + (b - m) ** 2, 0) / trendWindow.length,
    );
  }

  const activity = clamp(sim.activity, 0, 1.5);
  const metrics = {
    gen: sim.gen,
    alive,
    density,
    entropy,
    patternEntropy,
    blockEntropy,
    period,
    components,
    diameter,
    diameterNorm,
    activity,
    fluctuation,
    trend,
    stability: 0,
    type: 'drifting',
    typeLabel: '漂移',
    typeTone: 'drift',
  };

  let type = 'drifting';
  if (alive === 0) type = 'extinct';
  else if (period === 1) type = 'stable';
  else if (period >= 2 && period <= 16) type = 'periodic';
  else if (density < 0.012 && (trend < -0.00004 || activity < 0.035)) type = 'endangered';
  else if (activity > 0.17 || entropy > 0.6 || (period === 0 && activity > 0.08 && entropy > 0.2)) {
    type = 'chaotic';
  }

  const meta = {
    stable: ['安睡', 'stable'],
    periodic: ['呼吸', 'cyclic'],
    chaotic: ['灵动', 'chaotic'],
    endangered: ['需要关爱', 'endangered'],
    extinct: ['安静休眠', 'extinct'],
    drifting: ['漫步', 'drifting'],
  };
  metrics.type = type;
  metrics.typeLabel = meta[type][0];
  metrics.typeTone = meta[type][1];

  let stability = 0;
  if (type === 'stable') stability = 1;
  else if (type === 'periodic') stability = clamp(0.92 - period * 0.035, 0.2, 0.9);
  else if (type === 'drifting') stability = 0.36;
  else if (type === 'chaotic') stability = clamp(0.3 - activity * 0.3, 0.02, 0.3);
  else if (type === 'endangered') stability = 0.12;
  else stability = 0;
  metrics.stability = stability;

  return metrics;
}

export function structuralFingerprint(m) {
  const ints = [
    Math.round(m.density * 100000),
    Math.round(m.entropy * 1000),
    m.period,
    Math.round(m.diameterNorm * 1000),
    Math.round(m.activity * 10000),
    m.components,
    Math.round(m.stability * 1000),
  ];
  return hashInts(ints);
}

export const ATTRACTOR_GLYPH = {
  stable: '●',
  periodic: '◐',
  chaotic: '✦',
  endangered: '○',
  extinct: '·',
  drifting: '→',
};
