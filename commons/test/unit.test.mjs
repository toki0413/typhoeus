/**
 * Commons 单元测试 — 纯函数层
 *
 * 运行：npm run test:unit   （node --test test/unit.test.mjs）
 *
 * 覆盖：format / physics（B1/B2/B3 + 极端环境）/ music2 / cpm / patterns / rng
 * 与 e2e-test.mjs 的分工：这里只测无 DOM、无浏览器依赖的纯函数，
 * 把端到端留给 e2e（引擎 → 物理 → Pet → 音频 → 发现）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  escapeHtml, esc, formatFp, ruleLabel, sortLabel, diagnosisShort,
  ENGINE_LABEL, TYPE_COLOR, TYPE_EVENT_LABEL,
} from '../src/ui/format.js';
import {
  petToPhysicsBridge, autoTunePhysics, crowdFeedbackBridge, getCrowdDefaultEnv,
  applyExoticPhysics,
} from '../src/physics.js';
import { defaultEnv, defaultGenome } from '../src/engines.js';
import * as config from '../src/config.js';
import {
  selectiveImperfectionScale, edgeOfChaosKnob, attractorToSonicGenre, rhythmComplexity,
} from '../src/music2.js';
import { discretizeField, adhesionEnergy, simulateRD, CPM_DEFAULTS } from '../src/cpm.js';
import { matchPatternLibrary, buildDiscoveryRecord } from '../src/patterns.js';
import { getChordNotes } from '../src/music.js';
import { StructureTracker, findComponents } from '../src/structures.js';
import { mulberry32, hashString } from '../src/rng.js';

/* ================================================================
 * format.js
 * ================================================================ */
test('format: escapeHtml 转义 XSS 五字符', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc('plain'), 'plain');
});

test('format: formatFp 固定 8 位十六进制并插入分隔', () => {
  assert.equal(formatFp(0x004cf757), '004C-F757');
  assert.equal(formatFp(0), '0000-0000');
});

test('format: ruleLabel 区分 Conway / Lenia', () => {
  const life = { engine: 'life', life: { birth: [3], survive: [2, 3] } };
  assert.equal(ruleLabel(life), 'B3/S23');
  const lenia = { engine: 'lenia', lenia: { mu: 0.16, sigma: 0.025, radius: 4 } };
  assert.match(ruleLabel(lenia), /^Lenia μ0\.16 σ0\.025 R4$/);
  assert.equal(ruleLabel(null), '—');
});

test('format: 标签表覆盖 6 种结构态', () => {
  for (const key of ['stable', 'periodic', 'chaotic', 'endangered', 'extinct', 'drifting']) {
    assert.ok(TYPE_COLOR[key], key);
    assert.ok(TYPE_EVENT_LABEL[key], key);
  }
  assert.equal(ENGINE_LABEL.scientific, '反应-扩散（科学）');
  assert.equal(sortLabel('energy'), '能量最低');
  assert.equal(sortLabel('unknown'), 'unknown');
  assert.ok(diagnosisShort({ type: 'chaotic' }).length > 0);
});

test('instruments: 默认编制为 11 个声部的默认音色', () => {
  const inst = defaultGenome('life', 'conway').mapping.instruments;
  assert.equal(Object.keys(inst).length, 11);
  assert.equal(inst.arp, 'pluck');
  assert.equal(inst.lead, 'lead');
  assert.equal(inst.bell, 'bell');
  assert.ok(Object.values(inst).every((v) => typeof v === 'string' && v.length > 0));
});

test('mixer: 默认中性且旧配方可补齐', () => {
  const { DEFAULT_MIXER, normalizeMixer } = config;
  const mx = defaultGenome('life', 'conway').mapping.mixer;
  assert.equal(Object.keys(mx.parts).length, 11);
  assert.equal(mx.master, 1);
  assert.equal(mx.parts.lead.gain, 1);
  assert.equal(mx.parts.lead.send, 0);

  const fixed = normalizeMixer({ master: 9, tempo: 0.1, parts: { lead: { gain: 3, oct: 9, pan: -4 } } });
  assert.equal(fixed.master, 1.5);
  assert.equal(fixed.tempo, 0.5);
  assert.equal(fixed.parts.lead.gain, 1.5);
  assert.equal(fixed.parts.lead.oct, 2);
  assert.equal(fixed.parts.lead.pan, -1);
  assert.equal(fixed.parts.pad.gain, DEFAULT_MIXER.parts.pad.gain);
});

test('instruments: 新增音色都有标签且可被声部选择', () => {
  const all = new Set();
  for (const p of config.INSTRUMENT_PARTS) {
    for (const o of p.opts) {
      all.add(o);
      assert.ok(config.INSTRUMENT_VOICE_LABELS[o], `${p.key} 缺少标签: ${o}`);
    }
  }
  for (const voice of [
    'sub', 'organ', 'brass', 'vibes', 'glass', 'clav', 'musicbox',
    'cello', 'harp', 'steeldrum', 'sax', 'sitar', 'accordion', 'theremin',
  ]) {
    assert.ok(all.has(voice), `没有声部提供 ${voice}`);
    assert.ok(config.INSTRUMENT_VOICE_LABELS[voice]);
  }
});

/* ================================================================
 * physics.js · B2 Pet → Physics
 * ================================================================ */
test('B2: 五种情绪映射与中性兜底', () => {
  const happy = petToPhysicsBridge({ mood: 'happy' });
  assert.equal(happy._petNoiseBoost, 0.04);
  assert.equal(happy._petDtBoost, 0.05);
  assert.equal(happy._petDecay, 0);

  const sick = petToPhysicsBridge({ mood: 'sick' });
  assert.equal(sick._petDecay, 0.0015);
  assert.equal(sick._petDtBoost, -0.03);

  for (const state of [{ mood: 'waiting' }, null, undefined, {}]) {
    const p = petToPhysicsBridge(state);
    assert.equal(p._petDecay, 0);
    assert.equal(p._petDtBoost, 0);
    assert.equal(p._petNoiseBoost, 0);
    assert.match(p._petInfluence, /neutral/);
  }
});

test('B2: patch 恒返回全字段 → 反复 assign 幂等', () => {
  const physics = { globalDecay: 0.003 };
  for (let i = 0; i < 100; i++) {
    Object.assign(physics, petToPhysicsBridge({ mood: i % 2 ? 'happy' : 'sick' }));
  }
  Object.assign(physics, petToPhysicsBridge({ mood: 'happy' }));
  assert.equal(physics._petDecay, 0);          // happy 无衰减，覆盖掉 sick 的残留
  assert.equal(physics.globalDecay, 0.003);    // 环境自身衰减不被覆盖
  assert.equal(physics._petDtBoost, 0.05);
});

/* ================================================================
 * physics.js · B1 Auto-Tuning
 * ================================================================ */
test('B1: 冻结态增加扩散，爆炸态减少扩散', () => {
  const frozen = autoTunePhysics({ lyapunov: -2.0 }, { diffusionMult: 1, dtMult: 1 });
  assert.ok(frozen.diffusionMult > 1);
  assert.ok(frozen.dtMult > 1);

  const exploding = autoTunePhysics({ lyapunov: 0.8 }, { diffusionMult: 1, dtMult: 1 });
  assert.ok(exploding.diffusionMult < 1);
  assert.ok(exploding.dtMult < 1);
});

test('B1: 硬边界 [0.1,5.0] / [0.1,3.0] 与 NaN 保护', () => {
  const huge = autoTunePhysics({ lyapunov: -100 }, { diffusionMult: 4.99, dtMult: 2.99 });
  assert.ok(huge.diffusionMult <= 5.0 && huge.dtMult <= 3.0);

  const tiny = autoTunePhysics({ lyapunov: 100 }, { diffusionMult: 0.11, dtMult: 0.11 });
  assert.ok(tiny.diffusionMult >= 0.1 && tiny.dtMult >= 0.1);

  assert.deepEqual(autoTunePhysics({ lyapunov: NaN }, { diffusionMult: 1, dtMult: 1 }),
                   { diffusionMult: 0, dtMult: 0 });
});

/* ================================================================
 * physics.js · B3 Crowd Feedback（写 → 读 → defaultEnv）
 * ================================================================ */
test('B3: 众包学习数学 + defaultEnv 读回路 + 损坏回退', () => {
  const mem = new Map();
  const prevLocalStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
  };

  try {
    // 无记录 → null
    assert.equal(getCrowdDefaultEnv(), null);
    assert.equal(defaultEnv().noise, 0);

    // similarity² 权重 1 : 0.25 → noise 均值 0.26
    mem.set('commons.leaderboard.v1', JSON.stringify([
      { fingerprint: '0x0000000a', similarity: 100, environment: { noise: 0.30, constraint: 0.50, timeScale: 2.0 } },
      { fingerprint: '0x0000000b', similarity: 50,  environment: { noise: 0.10, constraint: 0.10, timeScale: 1.0 } },
    ]));
    const fb = crowdFeedbackBridge({ fingerprint: '0x0000000a' });
    assert.equal(fb.updated, true);
    assert.equal(fb.seedCount, 2);

    const learned = getCrowdDefaultEnv();
    assert.ok(Math.abs(learned.noise - 0.044) < 1e-12);
    assert.ok(Math.abs(learned.constraint - 0.177) < 1e-12);
    assert.ok(Math.abs(learned.timeScale - 1.08) < 1e-12);

    const env = defaultEnv();
    assert.ok(Math.abs(env.noise - 0.044) < 1e-12);
    assert.ok(Math.abs(env.constraint - 0.177) < 1e-12);
    assert.ok(Math.abs(env.timeScale - 1.08) < 1e-12);
    assert.equal(defaultEnv({ noise: 0.5 }).noise, 0.5);   // 显式值优先

    // 不在 top-N 的发现 → 不更新
    assert.equal(crowdFeedbackBridge({ fingerprint: '0xffffffff' }).updated, false);

    // 损坏 / 越界数据被夹紧或回退
    mem.set('commons.crowdFeedback.v1', JSON.stringify({ noise: 'oops', constraint: 9, timeScale: -3 }));
    const safe = getCrowdDefaultEnv();
    assert.equal(safe.noise, undefined);
    assert.equal(safe.constraint, 1);
    assert.equal(safe.timeScale, 0.05);
    const envBad = defaultEnv();
    assert.equal(envBad.noise, 0);
    assert.equal(envBad.constraint, 1);
    assert.equal(envBad.timeScale, 0.05);
  } finally {
    if (prevLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prevLocalStorage;
  }
});

/* ================================================================
 * physics.js · 极端环境注入
 * ================================================================ */
test('极端环境: 6 个 id 都能产出有限物理参数', () => {
  const env = { noise: 0.1, constraint: 0.2 };
  for (const id of ['exo-primitive', 'exo-venus', 'exo-europa', 'exo-mars', 'exo-saturn', 'exo-blackhole']) {
    const p = applyExoticPhysics({ ...env, _exoticId: id }, 'grayScott', 8, 6);
    assert.ok(p, id);
    for (const key of ['diffusionMult', 'dtMult']) {
      assert.ok(Number.isFinite(p[key]) && p[key] > 0, `${id}.${key}=${p[key]}`);
    }
    if (p.globalDecay !== undefined) assert.ok(Number.isFinite(p.globalDecay), `${id}.globalDecay`);
  }
});

test('极端环境: 非科学引擎显式降级而非静默失败', () => {
  const p = applyExoticPhysics({ _exoticId: 'exo-venus' }, 'life', 8, 6);
  assert.equal(p._nonScientific, true);
  assert.match(p._reason, /life/);
  assert.equal(applyExoticPhysics({}, 'grayScott', 8, 6), null);  // 非极端环境
});

/* ================================================================
 * music2.js
 * ================================================================ */
test('music2: 分形维数 → 音阶（D=1.5 命中 Hall-Petch 最优带）', () => {
  const mid = selectiveImperfectionScale(1.5);
  assert.ok(mid.degrees.includes(0));
  assert.ok(mid.targetDefect >= 0.2 && mid.targetDefect <= 0.3);
  assert.match(mid.entropyLevel, /optimum/);

  const flat = selectiveImperfectionScale(1.0);
  assert.ok(flat.targetDefect < mid.targetDefect);

  const noisy = selectiveImperfectionScale(2.0);
  assert.ok(noisy.targetDefect > mid.targetDefect);
});

test('music2: edge-of-chaos 温度单调且落在 [0,1]', () => {
  let prev = -1;
  for (const lyap of [-0.3, -0.2, -0.1, -0.02, 0.05, 0.1]) {
    const { temperatureK, chaosLevel } = edgeOfChaosKnob(lyap);
    assert.ok(Number.isFinite(temperatureK));
    assert.ok(temperatureK >= 0 && temperatureK <= 1);
    assert.ok(temperatureK >= prev);
    assert.ok(chaosLevel >= 0 && chaosLevel <= 3);
    prev = temperatureK;
  }
});

test('music2: attractor → sonic genre 有 id/label，节奏指标有限', () => {
  const g = attractorToSonicGenre('chaotic', 0.05, 1.8);
  assert.equal(typeof g.genreId, 'string');
  assert.equal(typeof g.genreLabel, 'string');
  const r = rhythmComplexity([1, 0, 1, 1, 0, 1, 0, 0]);
  assert.ok(Number.isFinite(r.permEntropy));
  assert.ok(Number.isFinite(r.syncopation));
});

/* ================================================================
 * cpm.js
 * ================================================================ */
test('cpm: 场离散化落界且保持单调', () => {
  const labels = discretizeField(new Float32Array([0, 0.25, 0.5, 0.75, 1]), 4);
  assert.equal(labels.length, 5);
  for (let i = 0; i < labels.length; i++) {
    assert.ok(labels[i] >= 0 && labels[i] <= 3);
    if (i) assert.ok(labels[i] >= labels[i - 1]);
  }
  assert.equal(discretizeField(new Float32Array([1, 1, 1]), 8).every((v) => v === 0), true);
});

test('cpm: 黏附能同型为 0、异型为正', () => {
  assert.equal(adhesionEnergy(3, 3), 0);
  assert.ok(adhesionEnergy(0, 7) > adhesionEnergy(0, 1));
  assert.ok(CPM_DEFAULTS.nTypes > 1);
});

test('cpm: simulateRD 解析 preset / engine，且结果有限可复现', async () => {
  const a = await simulateRD({ preset: 'gs_spots' }, 16, 10, 40);
  assert.equal(a.preset, 'gs_spots');
  assert.equal(a.engineType, 'grayScott');
  assert.ok(Number.isFinite(a.metrics.lyapunov));
  assert.ok(Number.isFinite(a.metrics.fractal));

  const b = await simulateRD({ preset: 'gs_spots' }, 16, 10, 40);
  assert.deepEqual(Array.from(a.vField), Array.from(b.vField));

  // 只给 engine 时按引擎挑预设（曾经的扫描 NaN 根因）
  const fhn = await simulateRD({ engine: 'fitzHughNagumo' }, 16, 10, 20);
  assert.equal(fhn.engineType, 'fitzHughNagumo');
  assert.ok(fhn.preset.startsWith('fhn_'));

  const fallback = await simulateRD({ preset: 'does_not_exist' }, 12, 8, 10);
  assert.equal(fallback.preset, 'gs_spots');
});

/* ================================================================
 * patterns.js
 * ================================================================ */
test('patterns: 模式匹配排序 + 相似度值域', async () => {
  const { metrics } = await simulateRD({ preset: 'gs_stripes' }, 24, 16, 120);
  const top = matchPatternLibrary(metrics);
  assert.ok(Array.isArray(top) && top.length >= 1);
  for (let i = 0; i < top.length; i++) {
    assert.ok(top[i].similarity >= 0 && top[i].similarity <= 100);
    if (i) assert.ok(top[i - 1].similarity >= top[i].similarity);
    assert.ok(top[i].label && top[i].refs);
  }
  assert.doesNotThrow(() => matchPatternLibrary(undefined));
});

test('patterns: 发现记录含 environment + 稳定 fingerprint', () => {
  const recipe = {
    seed: { genome: { engine: 'grayScott', preset: 'gs_spots' } },
    env: { noise: 0.12, constraint: 0.3, timeScale: 2 },
  };
  const metrics = { lyapunov: -0.05, fractal: 1.6, energy: { total: 0.5 }, density: 0.2 };
  const rec = buildDiscoveryRecord(recipe, metrics, []);
  assert.equal(rec.schema, 'commons.discovery.v1');
  assert.deepEqual(rec.environment, { noise: 0.12, constraint: 0.3, timeScale: 2 });
  assert.match(rec.fingerprint, /^0x[0-9a-f]{8}$/);
  assert.equal(buildDiscoveryRecord(recipe, metrics, []).fingerprint, rec.fingerprint);

  const bare = buildDiscoveryRecord({ seed: { genome: {} } }, metrics, []);
  assert.deepEqual(bare.environment, { noise: null, constraint: null, timeScale: null });
});

/* ================================================================
 * music.js · 和弦池
 * ================================================================ */
test('music: 所有和弦进行 × 五声音阶都产生有限 MIDI（回归：曾 NaN 中断音频）', () => {
  const degrees = [0, 2, 4, 7, 9];   // 大调五声
  const roots = [0, 4, 7, 11, 9, 12, 1, 5, 2, 3, 6, 8, 10];
  for (const root of roots) {
    for (const density of ['root', 'power', 'triads', 'sevenths', 'ninths']) {
      const notes = getChordNotes(density, root, degrees, 3, 60);
      assert.ok(notes.length >= 1, `${density}/${root}`);
      for (const n of notes) assert.ok(Number.isFinite(n), `${density}/${root} → ${n}`);
    }
  }
  // 越界音级按半音解释（7 = 纯五度）
  assert.deepEqual(getChordNotes('root', 7, degrees, 3, 60), [67]);
});

/* ================================================================
 * structures.js · 结构识别
 * ================================================================ */
const W = 20, H = 20;
const idx = (x, y) => y * W + x;
function gridOf(cells) {
  const g = new Uint8Array(W * H);
  for (const [x, y] of cells) g[idx(x, y)] = 1;
  return g;
}
function conwayStep(g) {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          n += g[((y + dy + H) % H) * W + ((x + dx + W) % W)];
        }
      }
      const alive = g[idx(x, y)];
      out[idx(x, y)] = alive ? (n === 2 || n === 3 ? 1 : 0) : (n === 3 ? 1 : 0);
    }
  }
  return out;
}

test('structures: 连通块识别（含环形边界）', () => {
  const g = gridOf([[0, 0], [1, 0], [W - 1, 0], [5, 5], [6, 5], [5, 6], [6, 6]]);
  const comps = findComponents(g, W, H);
  const areas = comps.map((c) => c.area).sort((a, b) => a - b);
  assert.deepEqual(areas, [3, 4]);
});

test('structures: 静止块被识别为 still', () => {
  const tr = new StructureTracker(W, H, { interval: 4, cooldown: 10 });
  let g = gridOf([[2, 2], [3, 2], [2, 3], [3, 3]]);
  for (let i = 0; i < 30; i++) {
    g = conwayStep(g);
    tr.update(g);
  }
  assert.ok(tr.counts.still >= 1, `counts=${JSON.stringify(tr.counts)}`);
});

test('structures: 闪烁器（period-2）被识别为 oscillator', () => {
  const tr = new StructureTracker(W, H, { interval: 4, cooldown: 10 });
  let g = gridOf([[1, 1], [2, 1], [3, 1]]);
  for (let i = 0; i < 24; i++) {
    g = conwayStep(g);
    tr.update(g);
  }
  assert.ok(tr.counts.oscillator >= 1, `counts=${JSON.stringify(tr.counts)}`);
});

test('structures: 滑翔机被识别为 mover', () => {
  const tr = new StructureTracker(W, H, { interval: 4, cooldown: 10 });
  let g = gridOf([[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]]);
  for (let i = 0; i < 32; i++) {
    g = conwayStep(g);
    tr.update(g);
  }
  assert.ok(tr.counts.mover >= 1, `counts=${JSON.stringify(tr.counts)}`);
});

test('structures: 出生潮事件 + 空 grid 不炸', () => {
  const tr = new StructureTracker(W, H);
  const empty = new Uint8Array(W * H);
  assert.equal(tr.update(null), null);
  tr.update(empty);
  const many = new Uint8Array(W * H);
  for (let i = 0; i < 40; i++) many[i] = 1;
  const r = tr.update(many);
  assert.ok(r.events.some((e) => e.type === 'birthSurge'), JSON.stringify(r.events));
});

/* ================================================================
 * rng.js
 * ================================================================ */
test('rng: mulberry32 确定性与 hashString 稳定性', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
  const seq = [mulberry32(7)(), mulberry32(7)()];
  assert.equal(seq[0], seq[1]);
  assert.equal(hashString('commons'), hashString('commons'));
  assert.notEqual(hashString('commons'), hashString('Commons'));
});
