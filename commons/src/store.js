// Commons layer: seeds, environments, fingerprints, kinship, hybridisation,
// lineage and share encoding. Everything a recipe needs to be reproduced.

import {
  ENGINE_VERSION,
  cloneEnv,
  cloneGenome,
  createEngine,
  computeMetrics,
  defaultEnv,
  defaultGenome,
  structuralFingerprint,
} from './engines.js';
import { hashString, hashInts, proceduralName, uid, clamp, toHex, mulberry32 } from './rng.js';

const STORE_KEY = 'commons.library.v1';
const TELEMETRY_LIMIT = 500;

/* ------------------------------------------------------------------ */
/* Curated commons                                                    */
/* ------------------------------------------------------------------ */

function curated(name, latin, genome, env, rngSeed, note) {
  return {
    id: `curated_${hashString(name + rngSeed).toString(36)}`,
    seed: {
      id: `seed_${hashString(name + 'seed').toString(36)}`,
      name,
      latin,
      genome,
      lineage: { parents: [], generation: 0 },
    },
    env,
    rngSeed,
    note,
    curated: true,
    createdAt: 0,
    metrics: null,
    snapshot: null,
    fingerprint: null,
  };
}

function lifeSeed(preset, envOverrides = {}, mapping = {}) {
  const g = defaultGenome('life', preset);
  Object.assign(g.mapping, mapping);
  return { genome: g, env: defaultEnv(envOverrides) };
}

function leniaSeed(preset, envOverrides = {}, mapping = {}) {
  const g = defaultGenome('lenia', preset);
  Object.assign(g.mapping, mapping);
  return { genome: g, env: defaultEnv(envOverrides) };
}

const c1 = lifeSeed('conway', { pattern: 'soup' }, { root: 0, scale: 'major', tempo: 0.4 });
const c2 = lifeSeed('highlife', { pattern: 'soup', noise: 0.03 }, { root: 7, scale: 'minor', tempo: 0.55 });
const c3 = lifeSeed('daynight', { pattern: 'soup', boundary: 'torus', resource: { rate: 0.12, period: 84 } }, { root: 2, scale: 'lydian', tempo: 0.6 });
const c4 = leniaSeed('bloom', { pattern: 'blob', noise: 0.01 }, { root: 5, scale: 'major', tempo: 0.35, brightness: 0.6 });
const c5 = lifeSeed('seeds', { pattern: 'sparse' }, { root: 9, scale: 'minor', tempo: 0.75 });
const c6 = lifeSeed('maze', { pattern: 'oscillator', boundary: 'wall', constraint: 0.6 }, { root: 4, scale: 'major', tempo: 0.3, brightness: 0.4 });
const c7 = lifeSeed('coral', { pattern: 'soup', boundary: 'wall', noise: 0.1 }, { root: 10, scale: 'minor', tempo: 0.45 });
const c8 = leniaSeed('coral', { pattern: 'ring', noise: 0.02 }, { root: 3, scale: 'lydian', tempo: 0.4, brightness: 0.7 });

export const CURATED = [
  curated('苔歌·03', 'Virella cantus III', c1.genome, c1.env, 20260114, '公地原生种。经典康威规则在环面上的第一声呼吸。'),
  curated('荧环·11', 'Lumithrix halos XI', c2.genome, c2.env, 44821, '高生命在随机汤里自我复制，群落此起彼伏。'),
  curated('潮汐·07', 'Threnora aestus VII', c3.genome, c3.env, 9917, '昼夜规则在营养脉冲中涨落，像一场缓慢的潮汐。'),
  curated('孢雾·02', 'Mycena nebula II', c4.genome, c4.env, 3307, '简化 Lenia 的软体团块，缓慢呼吸与融合。'),
  curated('砂吟·19', 'Arenella susurra XIX', c5.genome, c5.env, 5150, '种子规则，一次爆发式扩散，来得快去得也快。'),
  curated('环礁·05', 'Corallith atoll V', c6.genome, c6.env, 8123, '迷宫规则沿硬壁长成格室，稳定而低语。'),
  curated('烬涡·22', 'Cineris vortex XXII', c7.genome, c7.env, 6621, '珊瑚规则 + 高扰动，边界处最活跃。'),
  curated('深歌·08', 'Abyssoma canticum VIII', c8.genome, c8.env, 9090, '高阈值 Lenia 在环带上结晶出低频结构。'),
];

/* ------------------------------------------------------------------ */
/* Storage                                                            */
/* ------------------------------------------------------------------ */

function emptyLibrary() {
  return {
    version: 1,
    recipes: [],
    consent: false,
    seenIntro: false,
    telemetry: [],
    updatedAt: Date.now(),
  };
}

export function loadLibrary() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return emptyLibrary();
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.recipes)) return emptyLibrary();
    return { ...emptyLibrary(), ...parsed };
  } catch (e) {
    return emptyLibrary();
  }
}

export function saveLibrary(lib) {
  lib.updatedAt = Date.now();
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(lib));
    return true;
  } catch (e) {
    // quota — drop oldest non-curated recipes and retry once
    try {
      lib.recipes = lib.recipes.slice(-40);
      localStorage.setItem(STORE_KEY, JSON.stringify(lib));
      return true;
    } catch (e2) {
      return false;
    }
  }
}

export function allCommons(lib) {
  const ids = new Set(lib.recipes.map((r) => r.id));
  return [...CURATED.filter((c) => !ids.has(c.id)), ...lib.recipes];
}

/* ------------------------------------------------------------------ */
/* Fingerprints / snapshots                                           */
/* ------------------------------------------------------------------ */

export function encodeSnapshot(snap) {
  if (!snap) return null;
  let binary = '';
  const bytes = snap.data;
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return {
    w: snap.w,
    h: snap.h,
    b: btoa(binary),
  };
}

export function decodeSnapshot(obj) {
  if (!obj || !obj.b) return null;
  try {
    const binary = atob(obj.b);
    const data = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
    return { data, w: obj.w, h: obj.h };
  } catch (e) {
    return null;
  }
}

export function recipeFingerprint(seed, env, rngSeed, metrics) {
  const structure = metrics ? structuralFingerprint(metrics) : 0;
  const gene = hashString(
    JSON.stringify({ g: seed.genome, e: env, r: rngSeed, v: ENGINE_VERSION }),
  );
  return toHex(hashInts([gene, structure]), 8);
}

export function makeRecipe(seed, env, rngSeed, metrics, snapshot, extra = {}) {
  return {
    id: extra.id || uid('r'),
    seed: {
      id: seed.id || uid('s'),
      name: seed.name,
      latin: seed.latin || '',
      genome: cloneGenome(seed.genome),
      lineage: seed.lineage || { parents: [], generation: 0 },
    },
    env: cloneEnv(env),
    rngSeed,
    metrics: metrics ? { ...metrics } : null,
    snapshot: snapshot ? encodeSnapshot(snapshot) : null,
    fingerprint: recipeFingerprint(seed, env, rngSeed, metrics),
    note: extra.note || '',
    curated: false,
    createdAt: Date.now(),
    auto: !!extra.auto,
  };
}

export function profileRecipe(recipe, steps) {
  if (recipe.metrics && recipe.snapshot) return recipe;
  const sim = createEngine(recipe.seed.genome, recipe.env, recipe.rngSeed);
  const n = steps ?? (sim.kind === 'lenia' ? 110 : 150);
  for (let i = 0; i < n; i++) sim.step();
  recipe.metrics = computeMetrics(sim);
  recipe.snapshot = encodeSnapshot(sim.snapshot(2));
  recipe.fingerprint = recipeFingerprint(recipe.seed, recipe.env, recipe.rngSeed, recipe.metrics);
  return recipe;
}

export function snapshotOf(sim) {
  return sim.snapshot(2);
}

/* ------------------------------------------------------------------ */
/* Kinship                                                            */
/* ------------------------------------------------------------------ */

function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 1 : inter / union;
}

export function geneDistance(ga, gb) {
  if (!ga || !gb) return 1;
  let rule = 0;
  let mapping = 0;
  if (ga.engine !== gb.engine) {
    rule = 0.92;
  } else if (ga.engine === 'life') {
    rule =
      (1 - jaccard(ga.life.birth, gb.life.birth)) * 0.42 +
      (1 - jaccard(ga.life.survive, gb.life.survive)) * 0.42 +
      (ga.life.neighborhood === gb.life.neighborhood ? 0 : 0.16);
  } else {
    const dl = (a, b, span) => Math.min(1, Math.abs(a - b) / span);
    rule =
      dl(ga.lenia.mu, gb.lenia.mu, 0.3) * 0.34 +
      dl(ga.lenia.sigma, gb.lenia.sigma, 0.045) * 0.28 +
      dl(ga.lenia.radius, gb.lenia.radius, 5) * 0.2 +
      dl(ga.lenia.dt, gb.lenia.dt, 0.15) * 0.18;
  }
  const ma = ga.mapping || {};
  const mb = gb.mapping || {};
  const delta = (a, b, span) => Math.min(1, Math.abs((a ?? 0) - (b ?? 0)) / span);
  mapping =
    delta(ma.root, mb.root, 12) * 0.22 +
    (ma.scale === mb.scale ? 0 : 1) * 0.18 +
    (ma.wave === mb.wave ? 0 : 1) * 0.12 +
    delta(ma.register, mb.register, 1) * 0.14 +
    delta(ma.brightness, mb.brightness, 1) * 0.12 +
    delta(ma.tempo, mb.tempo, 1) * 0.12 +
    delta(ma.strictness, mb.strictness, 1) * 0.1;
  return clamp(rule * 0.64 + mapping * 0.36, 0, 1);
}

function phenoVector(m) {
  return [
    clamp(m.density / 0.3, 0, 1),
    clamp(m.entropy, 0, 1),
    clamp(Math.min(16, m.period) / 16, 0, 1),
    clamp(m.diameterNorm, 0, 1),
    clamp(m.activity, 0, 1),
    clamp(m.stability, 0, 1),
  ];
}

export function phenotypeDistance(a, b) {
  if (!a || !b) return 1;
  const va = phenoVector(a);
  const vb = phenoVector(b);
  let sum = 0;
  for (let i = 0; i < va.length; i++) sum += (va[i] - vb[i]) ** 2;
  return Math.sqrt(sum / va.length);
}

export function kinship(recA, recB) {
  if (!recA || !recB) return null;
  if (recA.id === recB.id) {
    return { gene: 0, pheno: 0, label: '同一生命', detail: '相同的种子与环境配方', tone: 'self' };
  }
  const gene = geneDistance(recA.seed.genome, recB.seed.genome);
  const pheno = phenotypeDistance(recA.metrics, recB.metrics);
  const geneKin = gene < 0.2;
  const phenoKin = pheno < 0.16;
  let label = '远缘';
  let detail = '基因与表型都相距较远';
  let tone = 'far';
  if (geneKin && phenoKin) {
    label = '双亲近邻';
    detail = '规则相近，且在当前环境下呈现相似结构';
    tone = 'both';
  } else if (geneKin) {
    label = '基因亲缘';
    detail = '共享规则或声音映射，但表型已分化';
    tone = 'gene';
  } else if (phenoKin) {
    label = '表型近邻';
    detail = '规则不同，却收敛到相似的结构与听感';
    tone = 'pheno';
  }
  return {
    gene,
    pheno,
    geneKin,
    phenoKin,
    label,
    detail,
    tone,
  };
}

/* ------------------------------------------------------------------ */
/* Hybridisation                                                      */
/* ------------------------------------------------------------------ */

function mixNumber(a, b, rand, jitter = 0.04) {
  const base = rand() < 0.5 ? a : b;
  const span = Math.abs(a - b) + Math.abs(a) * jitter + 1e-9;
  return base + (rand() - 0.5) * span * 0.35;
}

function crossoverSet(a, b, rand, mutation = 0.06) {
  const out = [];
  for (let n = 0; n <= 8; n++) {
    const inA = a.includes(n);
    const inB = b.includes(n);
    let take = rand() < 0.5 ? inA : inB;
    if (rand() < mutation) take = !take;
    if (take) out.push(n);
  }
  if (!out.length) out.push(3);
  return out;
}

export function hybridize(recA, recB, opts = {}) {
  const rand = mulberry32(opts.rngSeed || Math.floor(Math.random() * 1e9));
  const ga = recA.seed.genome;
  const gb = recB.seed.genome;
  const engineRand = rand();
  const engine = engineRand < 0.5 ? ga.engine : gb.engine;
  const genome = cloneGenome(engine === ga.engine ? ga : gb);
  genome.engine = engine;

  if (engine === 'life') {
    const la = ga.engine === 'life' ? ga.life : defaultGenome('life').life;
    const lb = gb.engine === 'life' ? gb.life : defaultGenome('life').life;
    genome.life = {
      birth: crossoverSet(la.birth, lb.birth, rand),
      survive: crossoverSet(la.survive, lb.survive, rand),
      neighborhood: rand() < 0.8 ? la.neighborhood : lb.neighborhood,
      preset: 'hybrid',
    };
  } else {
    const la = ga.engine === 'lenia' ? ga.lenia : defaultGenome('lenia').lenia;
    const lb = gb.engine === 'lenia' ? gb.lenia : defaultGenome('lenia').lenia;
    genome.lenia = {
      mu: clamp(mixNumber(la.mu, lb.mu, rand), 0.05, 0.45),
      sigma: clamp(mixNumber(la.sigma, lb.sigma, rand), 0.006, 0.06),
      radius: Math.round(clamp(mixNumber(la.radius, lb.radius, rand), 2, 6)),
      dt: clamp(mixNumber(la.dt, lb.dt, rand), 0.03, 0.2),
      preset: 'hybrid',
    };
  }

  const ma = ga.mapping || {};
  const mb = gb.mapping || {};
  const pickVal = (key, fallback) => (rand() < 0.5 ? ma[key] ?? fallback : mb[key] ?? fallback);
  genome.mapping = {
    ...ma,
    root: Math.round(clamp(mixNumber(ma.root ?? 0, mb.root ?? 0, rand), 0, 11)),
    scale: pickVal('scale', 'major'),
    wave: pickVal('wave', 'triangle'),
    octave: Math.round(clamp(mixNumber(ma.octave ?? 3, mb.octave ?? 3, rand), 2, 4)),
    register: clamp(mixNumber(ma.register ?? 0.5, mb.register ?? 0.5, rand), 0, 1),
    brightness: clamp(mixNumber(ma.brightness ?? 0.5, mb.brightness ?? 0.5, rand), 0.1, 1),
    tempo: clamp(mixNumber(ma.tempo ?? 0.5, mb.tempo ?? 0.5, rand), 0.1, 1),
    strictness: clamp(mixNumber(ma.strictness ?? 0.7, mb.strictness ?? 0.7, rand), 0.2, 1),
    drone: rand() < 0.85,
    pulse: rand() < 0.85,
    events: rand() < 0.9,
  };
  genome.engine = engine;

  const env = defaultEnv({});
  const ea = recA.env;
  const eb = recB.env;
  const pickEnv = (key) => (rand() < 0.5 ? ea[key] : eb[key]);
  env.pattern = pickEnv('pattern');
  env.boundary = pickEnv('boundary');
  env.noise = clamp(mixNumber(ea.noise, eb.noise, rand, 0.1), 0, 0.6);
  env.timeScale = clamp(mixNumber(ea.timeScale, eb.timeScale, rand), 0.35, 2);
  env.constraint = clamp(mixNumber(ea.constraint, eb.constraint, rand), 0, 1);
  env.resource = {
    rate: clamp(mixNumber(ea.resource.rate, eb.resource.rate, rand), 0, 0.6),
    period: Math.round(clamp(mixNumber(ea.resource.period, eb.resource.period, rand, 0.05), 20, 200)),
  };
  if (engine === 'lenia' && (env.pattern === 'glider' || env.pattern === 'oscillator')) {
    env.pattern = 'blob';
  }

  const lineage = {
    parents: [recA.id, recB.id],
    parentNames: [recA.seed.name, recB.seed.name],
    generation: Math.max(recA.seed.lineage?.generation || 0, recB.seed.lineage?.generation || 0) + 1,
  };
  const hash = hashString(JSON.stringify(genome) + (opts.rngSeed || '') + Date.now());
  const name = proceduralName(hash);
  const child = {
    id: uid('r'),
    seed: {
      id: uid('s'),
      name: name.zh,
      latin: name.latin,
      genome,
      lineage,
    },
    env,
    rngSeed: hash,
    metrics: null,
    snapshot: null,
    fingerprint: null,
    note: `杂交自「${recA.seed.name}」×「${recB.seed.name}」`,
    createdAt: Date.now(),
    auto: true,
  };
  child.fingerprint = recipeFingerprint(child.seed, child.env, child.rngSeed, null);
  return child;
}

/* ------------------------------------------------------------------ */
/* Share codec                                                        */
/* ------------------------------------------------------------------ */

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const pad = str.length % 4 ? '='.repeat(4 - (str.length % 4)) : '';
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function encodeRecipe(recipe) {
  const payload = {
    v: 1,
    e: ENGINE_VERSION,
    n: recipe.seed.name,
    l: recipe.seed.latin || '',
    g: recipe.seed.genome,
    env: recipe.env,
    r: recipe.rngSeed,
    lin: recipe.seed.lineage || { parents: [], generation: 0 },
    fp: recipe.fingerprint || null,
  };
  return b64urlEncode(JSON.stringify(payload));
}

export function decodeRecipe(code) {
  try {
    const payload = JSON.parse(b64urlDecode(code));
    if (!payload || !payload.g || !payload.env) return null;
    const name = proceduralName(hashString(JSON.stringify(payload.g) + payload.r));
    return {
      id: uid('r'),
      seed: {
        id: uid('s'),
        name: payload.n || name.zh,
        latin: payload.l || name.latin,
        genome: payload.g,
        lineage: payload.lin || { parents: [], generation: 0 },
      },
      env: { ...defaultEnv(), ...payload.env },
      rngSeed: payload.r >>> 0,
      metrics: null,
      snapshot: null,
      fingerprint: payload.fp || null,
      note: '通过分享链接领养',
      createdAt: Date.now(),
      shared: true,
    };
  } catch (e) {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Anonymous, optional research log                                   */
/* ------------------------------------------------------------------ */

export function telemetryEvent(lib, kind, payload = {}) {
  if (!lib.consent) return;
  const entry = {
    t: Date.now(),
    kind,
    engine: payload.engine,
    type: payload.type,
    gen: payload.gen,
    d: payload.density,
    e: payload.entropy,
    p: payload.period,
  };
  lib.telemetry.push(entry);
  if (lib.telemetry.length > TELEMETRY_LIMIT) lib.telemetry.shift();
}

export function telemetrySummary(lib) {
  const n = lib.telemetry.length;
  const byKind = {};
  for (const e of lib.telemetry) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  return { n, byKind };
}
