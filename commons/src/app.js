// Commons — application shell.
// Life seed × environment × rng seed, with listening as the primary interface.

import {
  ATTRACTOR_GLYPH,
  BOUNDARIES,
  ENGINE_VERSION,
  LENIA_PRESETS,
  LIFE_PRESETS,
  NEIGHBORHOODS,
  PATTERNS,
  REACTION_DIFFUSION_PRESETS,
  ROOT_NAMES,
  SCALES,
  SCIENTIFIC_PRESET_LIST,
  computeMetrics,
  createEngine,
  defaultEnv,
  defaultGenome,
  applyLifePreset,
  applyLeniaPreset,
  structuralFingerprint,
} from './engines.js';
import { AudioEngine, createAudioContext } from './audio.js';
import {
  StageRenderer,
  drawFingerprintGlyph,
  drawSnapshot,
  drawSparkline,
  setMotionEnabled,
  isMotionEnabled,
} from './render.js';
import {
  allCommons,
  decodeRecipe,
  decodeSnapshot,
  encodeRecipe,
  hybridize,
  kinship,
  loadLibrary,
  makeRecipe,
  profileRecipe,
  saveLibrary,
  telemetryEvent,
  telemetrySummary,
} from './store.js';
import { clamp, hashString, mulberry32, proceduralName, toHex, uid } from './rng.js';

/* ---- 科学工具模块（静态 import + 运行时降级） ---- */
import { runPlayerMC, discretizeField, CPM_DEFAULTS } from './cpm.js';
import { applyExoticPhysics, computeAudioChain, petToPhysicsBridge, crowdFeedbackBridge } from './physics.js';
import {
  selectiveImperfectionScale, edgeOfChaosKnob, attractorToSonicGenre
} from './music2.js';
import { runParameterScan, DEFAULT_SCAN_AXES } from './scan.js';
import { matchPatternLibrary, PATTERN_LIBRARY, buildDiscoveryRecord } from './patterns.js';
import { saveAsDiscovery, buildOpenScienceIssue, loadLeaderboard, rankDiscoveries, clearLeaderboard, exportLeaderboard, importDiscoveries } from './leaderboard.js';
/* ---- Commons-JEPA：形态嵌入空间里的预测（超越 Foldit 的核心武器）---- */
import { PlayerPredictor, toMorphoEmbedding, jepaSoundFeedback, morphoDistance } from './jepa.js';
import { PetState, PET_MOOD, PET_MOOD_EMOJI, PET_MOOD_LABEL, petMoodToOverlay, petMoodToAudio } from './pet.js';
import { StructureTracker } from './structures.js';
import { DEFAULT_INSTRUMENTS, INSTRUMENT_PARTS, INSTRUMENT_VOICE_LABELS, MIXER_PRESETS, DEFAULT_MIXER, normalizeMixer } from './config.js';
import { renderMixdownWav } from './export-wav.js';
/* ---- UI 子模块（从 app.js 拆出） ---- */
import { createSciencePanel } from './ui/science-panel.js';
import { createLineageView } from './ui/lineage.js';
import { createPuzzleView } from './ui/puzzle-view.js';
import { PUZZLE_DU, PUZZLE_DV } from './puzzle.js';
import { ENV_PRESETS, EXOTIC_ENVIRONMENTS, BOUNDARY_LABEL } from './ui/presets.js';
import {
  esc, ENGINE_LABEL, TYPE_COLOR, TYPE_EVENT_LABEL,
  formatFp, ruleLabel, diagnosisShort,
} from './ui/format.js';

/* ------------------------------------------------------------------ */
/* Constants                                                          */
/* ------------------------------------------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* 玩家可选音色：part key → 当前 voice id */
const voiceOf = (mapping, part) => {
  const v = mapping?.instruments?.[part];
  if (v === false) return 'off';
  if (typeof v === 'string' && v) return v;
  return INSTRUMENT_PARTS.find((p) => p.key === part)?.def || 'off';
};

/* ------------------------------------------------------------------ */
/* State                                                              */
/* ------------------------------------------------------------------ */

// gallery 缩略图呼吸动画循环控制（30fps，离开 commons view 时自动取消）
let _galleryBreathRafId = null;
let _galleryLastTick = 0;

// 库内未剖析种子的后台剖析队列（queueProfiles 使用）
let profileQueue = [];
let profileTimer = null;
/* 打开弹窗前后的焦点记忆，关闭时归还 */
let _modalReturnFocus = null;

/* ============================================================== */
/* 无障碍：动效开关初始化                                          */
/* 优先级：localStorage 用户覆盖 > prefers-reduced-motion 系统设置 */
/* ============================================================== */
function resolveMotionDefault() {
  try {
    const saved = localStorage.getItem('commons.motion.v1');
    if (saved === 'on') return true;
    if (saved === 'off') return false;
  } catch (_) {}
  // 无用户覆盖 → 尊重系统设置
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return false;
  }
  return true;
}

const state = {
  lib: loadLibrary(),
  view: 'cultivate',
  recipe: null,
  sim: null,
  renderer: null,
  metrics: null,
  history: { density: [], entropy: [], activity: [], period: [] },
  events: [],
  playing: true,
  speed: 1,
  audioOn: false,
  exportingWav: false,
  mixerPresetKey: null,
  blind: false,
  motion: resolveMotionDefault(),  // 呼吸/动效开关
  audioCtx: null,
  audio: null,
  lastType: null,
  lastTypeLabel: '',
  lastEventGen: {},
  lastDensity: 0,
  bannerTimer: null,
  frameAcc: 0,
  stepsSinceMetrics: 0,
  forceMetrics: false,
  lastUI: 0,
  lastMetricsAt: 0,
  lastStructUI: 0,
  /* ---- JEPA 直觉训练状态 ---- */
  jepa: {
    predictor: new PlayerPredictor(),
    embBefore: null,
    pendingDebounce: null,   // setTimeout id for debounced feedback
    paramChangePending: null,  // { dParams }
    trainingOn: true,        // 直觉训练音效开关（默认开）
  },
  compare: {
    ready: false,
    mode: 'seed',
    playing: true,
    keys: { a: 'current', b: null },
    envKeys: { a: 'torus-soup', b: 'low-constraint' },
    recipeA: null,
    recipeB: null,
    simA: null,
    simB: null,
    metricsA: null,
    metricsB: null,
    rendererA: null,
    rendererB: null,
    audioA: null,
    audioB: null,
    accA: 0,
    accB: 0,
    stepA: 0,
    stepB: 0,
  },
  /* ---- QQ 宠物式养成层：虚拟生命情绪 × 真实物理指标 ---- */
  pet: {
    state: null,   // PetState 实例，仿真启动时创建
    visible: true,
  },
  lastPetMood: null,  // 用于检测 mood 变化 → console 反馈
  exoticEnvId: null,  // 当前极端环境 id（null = 无）
  preExoticEnv: null, // 进入极端环境前的环境快照（取消时用来真正恢复）

  /* ---- 科学发现层 ---- */
  topPatterns: [],          // 最近一次 matchPatternLibrary 结果（Top-3）
  leaderboard: [],          // 本地 leaderboard（从 localStorage 读）
  lastDiscoverySavedAt: 0,  // 上次自动保存发现的时间戳（节流）
  mcLabelsVisible: false,   // CPM Potts 标签 overlay 是否显示
  scanResult: null,         // 最近一次参数扫描结果（含 heatmap）
  scanRunning: false,       // 是否正在扫描
  /* ---- 实验斑图拟合状态 ---- */
  fit: {
    field: null, w: 64, h: 64, features: null, result: null,
    running: false, progress: 0, total: 0, kind: null, imageData: null, invert: false,
  },
};

/* ------------------------------------------------------------------ */
/* UI 子模块实例化                                                    */
/* 工厂闭包共享 state，宿主能力（toast/modal/下载/领养）由组合根注入。 */
/* ------------------------------------------------------------------ */

const sciencePanel = createSciencePanel({ state, toast, openModal, downloadJSON, applyScientificParams });
const lineageView = createLineageView({ state, findRecipe, adoptRecipe });
const puzzleView = createPuzzleView({
  state,
  toast,
  getLifeParams: currentLifeScienceParams,
  applyToLife: applyScientificParams,
  makeLifeScientific: ensureScientificLife,
  saveToGarden: savePuzzleResult,
  openGarden: () => switchView('commons'),
});

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function deepClone(o) {
  return JSON.parse(JSON.stringify(o));
}

/* 滑杆填充比例：把值写进 --fill，CSS 用朱红填充到当前位置 */
function syncRangeFill(el) {
  if (!el || el.type !== 'range') return;
  const min = parseFloat(el.min || '0');
  const max = parseFloat(el.max || '100');
  const val = parseFloat(el.value || '0');
  const pct = max > min ? Math.min(100, Math.max(0, ((val - min) / (max - min)) * 100)) : 0;
  el.style.setProperty('--fill', `${pct}%`);
}

function syncRanges(root = document) {
  const scope = root && root.querySelectorAll ? root : document;
  scope.querySelectorAll('input[type="range"]').forEach(syncRangeFill);
}

/* ---- 拖滑杆：数值气泡 + 抓取反馈 ---- */
let _rangeDrag = null;

function rangeBounds(el) {
  const min = parseFloat(el.min || '0');
  const max = parseFloat(el.max || '100');
  const step = parseFloat(el.step || '1') || 1;
  return { min, max, step };
}

function rangeValueText(el) {
  const parent = el.parentElement;
  const label = parent?.querySelector('.field-head .val, .mix-val, #speedVal');
  const text = label?.textContent?.trim();
  return text || el.value;
}

function commitRangeValue(el, value) {
  const { min, max, step } = rangeBounds(el);
  const v = Math.min(max, Math.max(min, value));
  const q = Math.round(v / step) * step;
  const qq = Math.round(q * 1000) / 1000;
  if (+el.value !== qq) {
    el.value = String(qq);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return qq;
}

function moveRangeBubble(el) {
  /* 只在主参数滑杆上显示气泡；混音台/节奏有各自的常驻读数 */
  if (!el.closest('.field')) return null;
  const parent = el.parentElement;
  if (!parent) return null;
  let bubble = parent.querySelector(':scope > .range-bubble');
  if (!bubble) {
    bubble = document.createElement('span');
    bubble.className = 'range-bubble';
    bubble.setAttribute('aria-hidden', 'true');
    parent.appendChild(bubble);
  }
  bubble.textContent = rangeValueText(el);
  const pct = parseFloat(el.style.getPropertyValue('--fill'));
  const ratio = Number.isFinite(pct) ? pct / 100 : 0.5;
  const thumb = 14;
  const rawX = el.offsetLeft + ratio * Math.max(0, el.clientWidth - thumb) + thumb / 2;
  const maxX = Math.max(16, (parent.clientWidth || 0) - 16);
  bubble.style.left = `${Math.max(16, Math.min(maxX, rawX))}px`;
  bubble.style.top = `${el.offsetTop - 25}px`;
  bubble.classList.add('show');
  return bubble;
}

function beginRangeDrag(el, e) {
  const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  /* preventDefault 会抑制原生 dblclick，这里自己识别"双击复位" */
  const last = el._lastDown;
  if (last && now - last.t < 320
    && Math.abs(e.clientX - last.x) < 8 && Math.abs(e.clientY - last.y) < 8) {
    el._lastDown = null;
    e.preventDefault();
    el.dispatchEvent(new MouseEvent('dblclick', {
      bubbles: true, clientX: e.clientX, clientY: e.clientY,
    }));
    return;
  }
  el._lastDown = { t: now, x: e.clientX, y: e.clientY };

  const { min, max } = rangeBounds(el);
  const trackW = Math.max(1, el.clientWidth - 14);
  let value = parseFloat(el.value);
  /* 不按 Shift 时保留"点哪跳哪"；按 Shift 则从当前值开始微调 */
  if (!e.shiftKey) {
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left - 7) / trackW));
    value = min + ratio * (max - min);
    commitRangeValue(el, value);
  }
  _rangeDrag = {
    el,
    lastX: e.clientX,
    lastT: now,
    factor: e.shiftKey ? 0.18 : 1,
    value,
  };
  el.classList.add('dragging');
  el.parentElement?.classList.add('range-active');
  document.body.classList.add('range-dragging');
  if (typeof el.setPointerCapture === 'function' && e.pointerId !== undefined) {
    try { el.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
  }
  try { el.focus({ preventScroll: true }); } catch (_) { /* noop */ }
  moveRangeBubble(el);
  e.preventDefault();
}

/* 速度自适应：慢拖 → 低灵敏度（精细），快拖 → 1:1；Shift 固定 0.18 */
function handleRangeMove(e) {
  const d = _rangeDrag;
  if (!d) return;
  e.preventDefault();
  const dx = e.clientX - d.lastX;
  if (!dx) return;
  const el = d.el;
  const { min, max, step } = rangeBounds(el);
  const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const dt = Math.max(8, now - d.lastT);
  const speed = Math.abs(dx) / dt;
  const target = e.shiftKey
    ? 0.18
    : (speed < 0.08 ? 0.4 : speed < 0.2 ? 0.7 : 1);
  d.factor += (target - d.factor) * 0.35;

  const trackW = Math.max(1, el.clientWidth - 14);
  const perPx = (max - min) / trackW;
  d.value = Math.min(max, Math.max(min, d.value + dx * perPx * d.factor));
  const q = Math.round(d.value / step) * step;
  const qq = Math.round(q * 1000) / 1000;
  if (+el.value !== qq) {
    el.value = String(qq);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  d.lastX = e.clientX;
  d.lastT = now;
}

function endRangeDrag() {
  _rangeDrag = null;
  for (const el of $$('input[type="range"].dragging')) {
    el.classList.remove('dragging');
    el.parentElement?.classList.remove('range-active');
    const bubble = el.parentElement?.querySelector(':scope > .range-bubble');
    if (bubble) bubble.classList.remove('show');
  }
  document.body.classList.remove('range-dragging');
}

/* 统一指标入口：科学引擎优先使用其第一性原理指标，生命/Lenia 继续用结构指标 */
function metricsFor(sim) {
  const base = computeMetrics(sim);
  if (!sim || typeof sim.metrics !== 'function') return base;
  const sci = sim.metrics();
  return {
    ...base,
    ...sci,
    diameter: base.diameter,
    diameterNorm: base.diameterNorm,
    components: base.components,
    stability: base.stability,
    typeTone: sci.typeTone || base.typeTone,
  };
}

/* 把参数应用到当前科学引擎（拟合与挑战共用） */
function applyScientificParams(params) {
  if (!params) return;
  const g = state.recipe.seed.genome;
  g.engine = 'scientific';
  const base = g.scientific && Number.isFinite(g.scientific.D_u)
    ? g.scientific
    : { D_u: PUZZLE_DU, D_v: PUZZLE_DV, dt: 1.0 };
  g.scientific = {
    ...base,
    preset: 'custom',
    engineType: 'grayScott',
    ...params,
  };
  if (state.sim?.applyGenome) {
    state.sim.applyGenome(g);
    state.sim.reset();
  }
  state.metrics = metricsFor(state.sim);
  state.renderer?.setMetrics?.(state.metrics);
  markGenomeChanged();
  renderRulePanel();
  sciencePanel.render();
  toast('已把参数应用到当前科学引擎', 2000);
}

/* 把当前生命切换为反应-扩散（挑战页的“切换当前生命”按钮） */
function ensureScientificLife() {
  const g = state.recipe.seed.genome;
  g.engine = 'scientific';
  const sci = g.scientific = g.scientific || {};
  if (!sci.preset || sci.preset === 'custom' || !Number.isFinite(sci.f)) {
    const def = REACTION_DIFFUSION_PRESETS.gs_spots;
    sci.preset = 'gs_spots';
    sci.engineType = def.engine;
    sci.D_u = def.D_u;
    sci.D_v = def.D_v;
    sci.f = def.f;
    sci.k = def.k;
    sci.dt = def.dt;
  }
  rebuildSim();
  state.metrics = metricsFor(state.sim);
  state.renderer?.setMetrics?.(state.metrics);
  renderRulePanel();
  renderStructPanel();
  updateStructValues();
  toast('当前生命已切换为反应-扩散，可以继承参数了', 2400);
  return true;
}

/* 把挑战通关结果写回花园与家谱（作为当前生命的一代后代） */
function savePuzzleResult(payload) {
  if (!payload || !(payload.total >= 50)) {
    return { saved: false, reason: 'not-cleared' };
  }
  const parent = state.recipe.seed;
  const mask = payload.mask
    ? Array.from(payload.mask, (v) => Math.round(Math.max(0, Math.min(1, v)) * 255))
    : null;
  const genome = defaultGenome('life', 'conway');
  genome.engine = 'scientific';
  genome.scientific = {
    preset: 'custom',
    engineType: 'grayScott',
    D_u: PUZZLE_DU,
    D_v: PUZZLE_DV,
    dt: 1.0,
    f: payload.f,
    k: payload.k,
    mask,
    maskW: 64,
    maskH: 64,
  };
  const env = defaultEnv({ boundary: 'torus', pattern: 'soup', noise: 0 });
  const name = `${payload.levelName} · ${Math.round(payload.total)}分`;
  const rec = makeRecipe(
    {
      id: uid('s'),
      name,
      latin: 'Challengia forma',
      genome,
      lineage: {
        parents: [parent.id],
        parentNames: [parent.name],
        generation: (parent.lineage?.generation || 0) + 1,
      },
    },
    env,
    hashString(`${payload.levelId}|${payload.f}|${payload.k}|${payload.total}`),
    null,
    null,
    { note: `挑战模式「${payload.levelName}」通关解 · ${payload.stars ?? 0} 星` },
  );
  try {
    profileRecipe(rec, 480);
  } catch (_) {
    /* 即使剖析失败，也保留配方本身，花园里仍能看到这条记录 */
  }
  const duplicate = state.lib.recipes.some((r) => r.fingerprint && r.fingerprint === rec.fingerprint);
  if (duplicate) {
    return { saved: false, duplicate: true, name, generation: rec.seed.lineage.generation };
  }
  state.lib.recipes.push(rec);
  saveLibrary(state.lib);
  renderCommons();
  refreshCompareOptions();
  return {
    saved: true,
    duplicate: false,
    name,
    generation: rec.seed.lineage.generation,
    fingerprint: rec.fingerprint,
  };
}

/* 读取当前生命可继承的反应-扩散参数；不是科学引擎时返回 null */
function currentLifeScienceParams() {
  const sim = state.sim;
  if (sim?.kind === 'reaction-diffusion' && sim._rd?.params) {
    const p = sim._rd.params;
    if (Number.isFinite(p.f) && Number.isFinite(p.k)) {
      return {
        f: p.f,
        k: p.k,
        D_u: p.D_u,
        D_v: p.D_v,
        engineType: p.engine,
        preset: sim.genome?.scientific?.preset || 'custom',
      };
    }
  }
  const sci = state.recipe?.seed?.genome?.scientific;
  if (sci && Number.isFinite(sci.f) && Number.isFinite(sci.k)) return { ...sci };
  return null;
}

function normalizeRecipe(rec) {
  if (!rec) return null;
  const out = deepClone(rec);
  out.id = out.id || uid('r');
  out.seed = out.seed || {};
  out.seed.id = out.seed.id || uid('s');
  out.seed.genome = out.seed.genome || defaultGenome('life', 'conway');
  if (!out.seed.genome.mapping) out.seed.genome.mapping = defaultGenome().mapping;
  out.seed.lineage = out.seed.lineage || { parents: [], generation: 0 };
  out.env = { ...defaultEnv(), ...(out.env || {}) };
  out.env.resource = { ...defaultEnv().resource, ...((out.env || {}).resource || {}) };
  /* 旧配方没有乐器编制 → 补默认（全开） */
  if (!out.seed.genome.mapping.instruments) out.seed.genome.mapping.instruments = { ...DEFAULT_INSTRUMENTS };
  /* 旧配方没有混音台 → 补中性值；已有则夹回合法范围 */
  out.seed.genome.mapping.mixer = normalizeMixer(out.seed.genome.mapping.mixer);
  if (typeof out.rngSeed !== 'number') out.rngSeed = hashString(JSON.stringify(out.seed.genome));
  out.note = out.note || '';
  return out;
}

function currentFingerprint() {
  return structuralFingerprint(state.metrics || { density: 0, entropy: 0, period: 0, diameterNorm: 0, activity: 0, components: 0, stability: 0 });
}

function currentRecipeForCompare() {
  return {
    id: state.recipe.id,
    seed: state.recipe.seed,
    env: state.recipe.env,
    rngSeed: state.recipe.rngSeed,
    metrics: state.metrics,
  };
}

function toast(text, tone = 'ok') {
  const layer = $('#toastLayer');
  const el = document.createElement('div');
  el.className = 'toast';
  el.dataset.tone = tone;
  el.innerHTML = `<span class="t-dot"></span><span>${text}</span>`;
  layer.appendChild(el);
  setTimeout(() => el.remove(), 3900);
}

function showBanner(text, tone = 'stable') {
  const el = $('#eventBanner');
  el.textContent = text;
  el.dataset.tone = tone;
  el.classList.add('show');
  clearTimeout(state.bannerTimer);
  state.bannerTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

/* ------------------------------------------------------------------ */
/* Audio                                                              */
/* ------------------------------------------------------------------ */

function ensureAudio() {
  if (state.audioCtx) return state.audioCtx;
  const ctx = createAudioContext();
  if (!ctx) {
    toast('你的浏览器还不支持唱歌呢，好可惜 ♡', 'warn');
    return null;
  }
  state.audioCtx = ctx;
  state.audio = new AudioEngine(ctx, null, { pan: 0 });
  state.audio.setGenome(state.recipe.seed.genome);
  if (state.metrics) state.audio.updateMetrics(state.metrics);
  return ctx;
}

function ensureCompareAudio() {
  const ctx = ensureAudio();
  if (!ctx) return;
  const c = state.compare;
  if (!c.audioA) {
    c.audioA = new AudioEngine(ctx, null, { pan: -0.62 });
    c.audioB = new AudioEngine(ctx, null, { pan: 0.62 });
  }
  if (c.recipeA) c.audioA.setGenome(c.recipeA.seed.genome);
  if (c.recipeB) c.audioB.setGenome(c.recipeB.seed.genome);
}

function setAudio(on) {
  state.audioOn = on;
  document.body.classList.toggle('audio-on', on);
  $('#audioBtn').setAttribute('aria-pressed', String(on));
  $('#audioLabel').textContent = on ? '聆听中' : '聆听';
  if (on) {
    ensureAudio();
    if (state.audioCtx?.state === 'suspended') state.audioCtx.resume();
  }
  syncAudioForView();
  updateSoundLabel();
  updateCompareAudioButton();
}

function syncAudioForView() {
  if (!state.audioOn) {
    state.audio?.setEnabled(false);
    state.compare.audioA?.setEnabled(false);
    state.compare.audioB?.setEnabled(false);
    return;
  }
  if (state.view === 'compare') {
    state.audio?.setEnabled(false);
    ensureCompareAudio();
    state.compare.audioA?.setEnabled(true);
    state.compare.audioB?.setEnabled(true);
  } else {
    state.compare.audioA?.setEnabled(false);
    state.compare.audioB?.setEnabled(false);
    state.audio?.setEnabled(true);
  }
}

function updateSoundLabel() {
  const el = $('#hudSound');
  if (!el) return;
  el.textContent = state.audioOn ? '♪ 正在为你唱歌' : '还在安静等待 ♪';
}

/* ------------------------------------------------------------------ */
/* Lifecycle events                                                   */
/* ------------------------------------------------------------------ */

function addLifecycle(kind, label, metrics, opts = {}) {
  const m = metrics || state.metrics;
  const gen = m?.gen ?? state.sim?.gen ?? 0;
  const gap = opts.gap ?? 60;
  if (!opts.force) {
    const last = state.lastEventGen[kind] ?? -9999;
    if (gen - last < gap) return;
  }
  state.lastEventGen[kind] = gen;
  const tone = opts.tone || kind;
  const evt = {
    kind,
    label,
    tone,
    gen,
    detail: opts.detail || '',
    time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
  };
  state.events.unshift(evt);
  if (state.events.length > 18) state.events.pop();
  renderTimeline();
  showBanner(`${label} · G${gen}`, tone);
  state.renderer?.triggerPulse(
    ['stable', 'periodic', 'chaotic', 'endangered', 'extinct', 'reproduction'].includes(kind)
      ? kind
      : kind === 'hatch' || kind === 'hybrid' || kind === 'mutate'
        ? 'reproduction'
        : 'drifting',
  );
  if (state.audioOn && state.audio) {
    const audioKind =
      kind === 'hatch' || kind === 'hybrid' || kind === 'mutate' ? 'reproduction' : kind;
    state.audio.triggerEvent(audioKind, opts.strength || 1);
  }
  if (opts.toast !== false) toast(label, ['endangered', 'extinct'].includes(kind) ? 'warn' : 'ok');
  if (state.lib.consent) {
    telemetryEvent(state.lib, kind, {
      engine: state.recipe.seed.genome.engine,
      type: metrics?.type,
      gen,
      density: metrics?.density,
      entropy: metrics?.entropy,
      period: metrics?.period,
    });
    saveLibrary(state.lib);
  }
}

function renderTimeline() {
  const track = $('#timelineTrack');
  const count = $('#timelineCount');
  if (!track) return;
  count.textContent = `${state.events.length} 事件`;
  if (!state.events.length) {
    track.innerHTML =
      '<div class="timeline-empty">尚无事件。稳定、周期、混沌、濒危与繁殖会在此留下痕迹。</div>';
    return;
  }
  track.innerHTML = state.events
    .slice(0, 14)
    .map(
      (e) => `<div class="evt" data-tone="${e.tone}">
        <div class="e-name">${esc(e.label)}</div>
        <div class="e-meta">G${e.gen} · ${e.time}</div>
      </div>`,
    )
    .join('');
}

/* ------------------------------------------------------------------ */
/* Simulation                                                         */
/* ------------------------------------------------------------------ */

function resetHistory() {
  state.history = { density: [], entropy: [], activity: [], period: [] };
  state.lastType = null;
  state.lastTypeLabel = '';
  state.lastEventGen = {};
  state.lastDensity = 0;
  state.stepsSinceMetrics = 0;
  state.events = [];
  renderTimeline();
}

function attachRecipe(recipe, opts = {}) {
  state.recipe = normalizeRecipe(recipe);
  state.mixerPresetKey = null;
  /* 极端环境标记跟着配方走：分享/保存的极端环境配方重新载入后仍能恢复物理与徽标 */
  const exoId = state.recipe.env?._exoticId;
  state.exoticEnvId = EXOTIC_ENVIRONMENTS.some((x) => x.id === exoId) ? exoId : null;
  if (!state.exoticEnvId) delete state.recipe.env._exoticId;
  state.preExoticEnv = null;
  state.sim = createEngine(state.recipe.seed.genome, state.recipe.env, state.recipe.rngSeed);
  injectExoticPhysics();
  /* 结构识别：只对 Conway/Lenia 这类有离散 grid 的引擎启用 */
  state.structure = state.sim?.grid ? new StructureTracker(state.sim.w, state.sim.h) : null;
  state.metrics = metricsFor(state.sim);
  if (opts.keepHistory !== true) resetHistory();
  state.lastType = state.metrics.type;
  state.lastTypeLabel = state.metrics.typeLabel;
  state.lastDensity = state.metrics.density;
  state.renderer.attach(state.sim);
  state.renderer.setMetrics(state.metrics);
  state.renderer.clear();
  if (state.audio) state.audio.setGenome(state.recipe.seed.genome);
  /* ---- 初始化 QQ 宠物式养成层 ---- */
  state.pet.state = new PetState();
  state.lastPetMood = null;
  renderRulePanel();
  renderSoundPanel();
  renderEnvPanel();
  renderStructPanel();
  updateHUD(true);
  updateStructValues();
  renderPetHUD();
  if (state.audio && state.audioOn) {
    state.audio.updateMetrics(state.metrics);
  }
  if (opts.toast) toast(opts.toast);
}

function rebuildSim() {
  state.sim = createEngine(state.recipe.seed.genome, state.recipe.env, state.recipe.rngSeed);
  /* 重建引擎（换引擎/重新播种）后，新 sim 没有旧的 _physics，需要重新注入 */
  injectExoticPhysics();
  state.structure = state.sim?.grid ? new StructureTracker(state.sim.w, state.sim.h) : null;
  state.metrics = metricsFor(state.sim);
  resetHistory();
  state.lastType = state.metrics.type;
  state.lastTypeLabel = state.metrics.typeLabel;
  state.lastDensity = state.metrics.density;
  state.renderer.attach(state.sim);
  state.renderer.setMetrics(state.metrics);
  state.renderer.clear();
  updateHUD(true);
  updateStructValues();
  if (state.audio) {
    state.audio.setGenome(state.recipe.seed.genome);
    state.audio.updateMetrics(state.metrics);
  }
}

function stepMain() {
  if (!state.sim) return;
  const res = state.sim.step();
  if (state.audioOn && state.audio) {
    state.audio.pushBirths(state.sim.lastBirths, state.sim.w, state.sim.h);
  }
  /* 🧬 结构识别 → 动机：滑翔机/振荡器/静止块/合并分裂/出生死亡潮 */
  const struct = state.structure?.update(state.sim.grid, performance.now() / 1000);
  if (struct && struct.events.length && state.audioOn && state.audio) {
    for (const evt of struct.events) state.audio.triggerStructure(evt);
  }
  state.stepsSinceMetrics++;
  if (state.stepsSinceMetrics >= 5) {
    state.stepsSinceMetrics = 0;
    refreshMainMetrics();
  }
  return res;
}

function refreshMainMetrics() {
  if (!state.sim) return;
  const prevType = state.lastType;
  const m = metricsFor(state.sim);
  state.metrics = m;
  state.renderer.setMetrics(m);
  pushHistory(m);
  if (state.audio && state.audioOn) state.audio.updateMetrics(m);
  detectLifecycle(prevType, m);
  state.lastType = m.type;
  state.lastTypeLabel = m.typeLabel;
  state.lastDensity = m.density;
  state.forceMetrics = false;
  state.lastMetricsAt = performance.now();
  /* ---- QQ 宠物式养成层：用真实物理指标更新情绪 ---- */
  if (state.pet.state) {
    const newMood = state.pet.state.updateFromMetrics(m, state.recipe.env.timeScale || 1);
    if (newMood !== state.lastPetMood) {
      state.lastPetMood = newMood;
      toast(`🐾 ${PET_MOOD_LABEL[newMood]} ${PET_MOOD_EMOJI[newMood]}`, 1600);
    }
    renderPetHUD();
  }

  /* ---- 🧬 B2：Pet → Physics 反向 Bridge（论文 bidirectional bridge）
     Pet 情绪反向注入物理参数。patch 的字段恒返回（中性为 0），
     所以重复 Object.assign 是幂等的，不会累积漂移。 ---- */
  if (state.sim?._physics && state.pet.state) {
    state.sim.setPhysics(Object.assign(state.sim._physics, petToPhysicsBridge(state.pet.state)));
  }

  /* ===== 🌌 全链打通：env → sim.metrics → Pet mood → music2 (Buehler/Bell/Kolic/Pimenta) → audio ===== */
  try {
    const audioChain = computeAudioChain(
      m,
      state.pet.state || { mood: 'content' },
      state.exoticEnvId,
      { selectiveImperfectionScale, edgeOfChaosKnob, attractorToSonicGenre, petMoodToAudio }
    );
    if (state.audio) {
      // 把全链结果传给 audio.js — tempo / tension / reverb / scale 全动态
      state.audio.setAudioChain?.(audioChain);
    }
  } catch (e) { /* audio 未就绪时静默跳过 */ }

  updateHUD();
  updateStructValues();

  /* ===== 🔬 科学发现层：pattern match + 自动保存 leaderboard ===== */
  try {
    // 1. 匹配已发表 Turing 模式库（每次都算，成本极低）
    state.topPatterns = matchPatternLibrary(m);

    // 2. 自动保存发现到 leaderboard（节流：每 15 秒最多 1 次 + 指标变化够大才存）
    const now = performance.now();
    const sim = state.sim;
    if (sim?.kind === 'reaction-diffusion' && now - state.lastDiscoverySavedAt > 15000) {
      const lb = loadLeaderboard();
      // 检查是否已经存过这个指纹（同 recipe + seed 不重复存）
      const record = saveAsDiscovery(state.recipe, m, state.topPatterns);
      // saveAsDiscovery 已经 handle localStorage 去重
      state.leaderboard = loadLeaderboard();
      state.lastDiscoverySavedAt = now;

      /* ---- 🧬 B3：Crowd Feedback Bridge —— top-N 发现反哺默认环境参数 ----
         只有新发现进入 top-N 时才真正学习（函数内部判定），
         学习是 90% 旧默认 + 10% 众包均值的平滑更新。 ---- */
      const feedback = crowdFeedbackBridge(record);
      if (feedback?.updated) {
        toast(`🌍 众包默认已更新（${feedback.seedCount} 条发现）`, 1800);
      }

      // 只在科学发现 tab 打开时才刷新 UI
      const activeTab = document.querySelector('#railTabs button.active')?.dataset.tab;
      if (activeTab === 'science') sciencePanel.render();
    }
  } catch (e) { /* leaderboard 初始化可能失败（localStorage 不可用），静默跳过 */ }
}

function pushHistory(m) {
  const h = state.history;
  h.density.push(m.density);
  h.entropy.push(m.entropy);
  h.activity.push(m.activity);
  h.period.push(m.period);
  for (const k of Object.keys(h)) {
    if (h[k].length > 96) h[k].shift();
  }
}

function detectLifecycle(prevType, m) {
  if (!prevType || m.gen < 10) return;
  if (m.type !== prevType) {
    const key = m.type;
    addLifecycle(key, TYPE_EVENT_LABEL[key] || `进入${m.typeLabel}态`, m, {
      gap: key === 'drifting' ? 140 : key === 'chaotic' ? 80 : 40,
      toast: key !== 'drifting',
    });
  }
  if (m.density > 0.32 && state.lastDensity <= 0.32) {
    addLifecycle('bloom', '密度绽放 · 群落扩张', m, { gap: 120 });
  }
  if (prevType !== 'endangered' && m.density > 0 && m.density < 0.012) {
    addLifecycle('endangered', '濒危 · 密度告急', m, { gap: 80 });
  }
}

function updateHUD(force = false) {
  const m = state.metrics;
  const rec = state.recipe;
  if (!m || !rec) return;
  $('#speciesName').textContent = rec.seed.name;
  $('#speciesLatin').textContent = rec.seed.latin || '—';
  $('#speciesRule').textContent = `${ENGINE_LABEL[rec.seed.genome.engine]} · ${ruleLabel(rec.seed.genome)}`;
  $('#hudState').textContent = m.typeLabel;
  $('#hudState').style.color = TYPE_COLOR[m.type] || TYPE_COLOR.drifting;
  $('#hudGen').textContent = String(m.gen).padStart(4, '0');
  $('#hudMetrics').innerHTML = `
    <span>密度<b>${(m.density * 100).toFixed(1)}%</b></span>
    <span>熵<b>${m.entropy.toFixed(2)}</b></span>
    <span>${m.periodKind === 'correlation-length' ? 'L_c' : '周期'}<b>${m.period || '∅'}</b></span>
    <span>直径<b>${m.diameter}</b></span>`;
  const fp = currentFingerprint();
  $('#fingerprintCode').textContent = formatFp(fp);
  $('#recipeCode').textContent = toHex(
    hashString(JSON.stringify({ g: rec.seed.genome, e: rec.env, r: rec.rngSeed })),
    6,
  ).toLowerCase();
  $('#engineCode').textContent = `AL-${ENGINE_VERSION}`;

  updateBadges(m);
  updateSoundLabel();
  drawFingerprintGlyph($('#fingerprintGlyph'), m, 'a');
}

function updateBadges(m) {
  const rec = state.recipe;
  const commons = allCommons(state.lib).filter((r) => r.id !== rec.id && r.metrics);
  let kinCount = 0;
  const self = { id: rec.id, seed: rec.seed, metrics: m };
  for (const r of commons) {
    const k = kinship(self, r);
    if (k && (k.geneKin || k.phenoKin)) kinCount++;
  }
  const gen = rec.seed.lineage?.generation || 0;
  $('#stageBadges').innerHTML = `
    <span class="badge" data-tone="${m.typeTone}">${ATTRACTOR_GLYPH[m.type] || '◌'} <b>${m.typeLabel}</b></span>
    <span class="badge">引擎 <b>${ENGINE_LABEL[rec.seed.genome.engine]}</b></span>
    <span class="badge">种子世代 <b>${gen}</b></span>
    <span class="badge">亲缘 <b>${kinCount}</b></span>
    ${state.blind ? '<span class="badge" data-tone="cyclic">♪ 用心听</span>' : ''}`;
}

/* ------------------------------------------------------------------ */
/* Rule panel                                                         */
/* ------------------------------------------------------------------ */

function sliderHTML(label, value, min, max, step, dataAttr, unit = '') {
  return `<div class="field">
    <div class="field-head"><label>${label}</label><span class="val">${value}${unit}</span></div>
    <input type="range" min="${min}" max="${max}" step="${step}" value="${value}" ${dataAttr} />
  </div>`;
}

function renderRulePanel() {
  const g = state.recipe.seed.genome;
  const isLife = g.engine === 'life';
  const isLenia = g.engine === 'lenia';
  const isSci = g.engine === 'scientific';
  const presets = isLife ? LIFE_PRESETS : isLenia ? LENIA_PRESETS : REACTION_DIFFUSION_PRESETS;
  const presetHTML = Object.entries(presets)
    .map(([key, p]) => {
      const curPreset = isLife ? g.life.preset : isLenia ? g.lenia.preset : g.scientific?.preset;
      const active = curPreset === key;
      const dataAttr = isLife ? 'data-life-preset' : isLenia ? 'data-lenia-preset' : 'data-sci-preset';
      return `<button class="preset ${active ? 'active' : ''}" ${dataAttr}="${key}">
        <b>${p.label}</b><span>${p.note || ''}</span></button>`;
    })
    .join('');

  let bodyHTML = '';
  if (isLife) {
    const birthChips = Array.from({ length: 9 }, (_, n) => {
      const on = g.life.birth.includes(n);
      return `<button class="chip ${on ? 'on' : ''}" data-birth="${n}">${n}</button>`;
    }).join('');
    const surviveChips = Array.from({ length: 9 }, (_, n) => {
      const on = g.life.survive.includes(n);
      return `<button class="chip sv ${on ? 'on' : ''}" data-survive="${n}">${n}</button>`;
    }).join('');
    bodyHTML = `
      <div class="section-label">规则集</div>
      <div class="preset-grid">${presetHTML}</div>
      <div class="section-label">自定义出生 / 存活</div>
      <div class="field">
        <div class="field-head"><label>出生 B</label><span class="val">邻居数</span></div>
        <div class="chip-row">${birthChips}</div>
      </div>
      <div class="field">
        <div class="field-head"><label>存活 S</label><span class="val">邻居数</span></div>
        <div class="chip-row">${surviveChips}</div>
      </div>
      <div class="section-label">邻域类型</div>
      <div class="segmented">
        ${Object.entries(NEIGHBORHOODS).map(([n, info]) => `<button data-neighborhood="${n}" class="${g.life.neighborhood === parseInt(n) ? 'active' : ''}">${info.label.split('·')[0].trim()}</button>`).join('')}
      </div>
      <p class="hint">规则集在运行中即时生效。<b>Moore 8</b> 最经典，<b>Hex 6</b> 细腻，<b>von Neumann 4</b> 范围小但精致。</p>`;
  } else if (isSci) {
    const st = g.scientific || {};
    const sciParams = {
      grayScott: { label: 'Gray-Scott · 斑马条纹基础',
        sliders: [
          ['扩散系数 D_u（激活）',  st.D_u ?? 1.0,   0.2, 3.0, 0.05, 'D_u'],
          ['扩散系数 D_v（抑制）',  st.D_v ?? 0.5,   0.1, 2.0, 0.05, 'D_v'],
          ['饲养速率 f',           st.f   ?? 0.035, 0.005, 0.08, 0.001, 'f'],
          ['杀伤速率 k',           st.k   ?? 0.065, 0.03, 0.09, 0.001, 'k'],
          ['时间步 dt',            st.dt  ?? 1.0,   0.3, 2.0, 0.05, 'dt'],
        ]},
      fitzHughNagumo: { label: 'FitzHugh-Nagumo · 心脏神经冲动',
        sliders: [
          ['耦合强度 c',            st.c  ?? 10.0, 2.0, 20.0, 0.5, 'c'],
          ['阈值 a',                st.a  ?? 0.7,  0.3, 1.2, 0.02, 'a'],
          ['恢复速率 b',            st.b  ?? 0.8,  0.3, 1.2, 0.02, 'b'],
          ['时间步 dt',             st.dt ?? 0.5,  0.1, 1.0, 0.02, 'dt'],
        ]},
      brusselator: { label: 'Brusselator · 化学振荡',
        sliders: [
          ['反应物 A',              st.A   ?? 2.0, 0.5, 4.0, 0.05, 'A'],
          ['反应物 B',              st.B   ?? 4.5, 1.0, 8.0, 0.05, 'B'],
          ['扩散系数 D_u',          st.D_u ?? 1.0, 0.2, 2.0, 0.05, 'D_u'],
          ['扩散系数 D_v',          st.D_v ?? 0.2, 0.05, 1.0, 0.02, 'D_v'],
          ['时间步 dt',             st.dt  ?? 0.1, 0.01, 0.3, 0.01, 'dt'],
        ]},
      lengyelEpstein: { label: 'Lengyel–Epstein · CIMA 化学斑图',
        sliders: [
          ['反应物 a',              st.a     ?? 8,    5, 14, 0.1, 'a'],
          ['反应物 b',              st.b     ?? 6,    1, 8, 0.1, 'b'],
          ['时间尺度 σ',            st.sigma ?? 0.6,  0.2, 3, 0.05, 'sigma'],
          ['扩散系数 D_u',          st.D_u   ?? 1,    0.2, 3, 0.05, 'D_u'],
          ['扩散系数 D_v',          st.D_v   ?? 10,   2, 20, 0.5, 'D_v'],
          ['时间步 dt',             st.dt    ?? 0.02, 0.005, 0.05, 0.005, 'dt'],
        ]},
    };
    const curType = st.engineType || 'grayScott';
    const curSci = sciParams[curType];
    bodyHTML = `
      <div class="section-label">反应-扩散引擎（Turing 1952）</div>
      <div class="preset-grid">${presetHTML}</div>
      <div class="section-label">子类型</div>
      <div class="segmented">
        ${Object.keys(sciParams).map(k => `<button data-sci-type="${k}" class="${curType === k ? 'active' : ''}">${sciParams[k].label.split('·')[0].trim()}</button>`).join('')}
      </div>
      <p class="hint">${curSci.label.split('·')[1]?.trim() || ''} — 真实物理参数，在运行中即时生效。</p>
      <div class="section-label">物理参数</div>
      ${curSci.sliders.map(([lbl, v, mn, mx, step, key]) => sliderHTML(lbl, typeof v === 'number' ? v.toFixed(3) : v, mn, mx, step, `data-sci-param="${key}"`)).join('')}
      <p class="hint">
        <b>D_u / D_v</b> 扩散系数：越大越容易在空间传播；
        <b>f / k</b> Gray-Scott 里是"出生"和"死亡"的速率；
        <b>a / b / c</b> FHN 里是阈值和恢复，Lengyel–Epstein 里是 CIMA 的反应物浓度；
        <b>σ</b> 是 v 的反应时间尺度；
        <b>A / B</b> Brusselator 里是反应物浓度。
        所有都是真正的方程参数，不是游戏常量。
      </p>`;
  } else {
    // Lenia
    bodyHTML = `
      <div class="section-label">规则集</div>
      <div class="preset-grid">${presetHTML}</div>
      <div class="section-label">连续场参数</div>
      ${sliderHTML('生长中心 μ', g.lenia.mu.toFixed(3), 0.05, 0.4, 0.005, 'data-lenia-param="mu"')}
      ${sliderHTML('生长宽度 σ', g.lenia.sigma.toFixed(3), 0.006, 0.05, 0.001, 'data-lenia-param="sigma"')}
      ${sliderHTML('核半径 R', g.lenia.radius, 2, 6, 1, 'data-lenia-param="radius"')}
      ${sliderHTML('时间步 dt', g.lenia.dt.toFixed(2), 0.03, 0.18, 0.01, 'data-lenia-param="dt"')}
      <p class="hint">简化 Lenia：环状核 × 高斯生长。μ 控制"想成为什么密度"，σ 控制宽容度，R 控制尺度。</p>`;
  }

  // 科学引擎专属：额外工具按钮区
  let sciToolsHTML = '';
  if (isSci && runPlayerMC) {
    sciToolsHTML = `
      <div class="section-label">🔬 科学工具（玩家驱动的科研能力）</div>
      <div class="btn-row">
        <button class="ghost" data-sci-action="mc">🧬 让 CPM 帮我推一下</button>
        <button class="ghost" data-sci-action="scan">🗺️ 参数扫描能量景观</button>
        <button class="ghost" data-sci-action="match">📚 已发表模式匹配</button>
        <button class="ghost" data-sci-action="save">⭐ 保存到开放科学仓库</button>
      </div>
      <p class="hint">
        <b>CPM MC</b>：玩家触发的 Metropolis Monte Carlo 步（局部能量最小化），
        类似 Foldit 的玩家"折叠-调整"操作；
        <b>参数扫描</b>：自动跑 N×M 网格搜索 → 能量景观热图；
        <b>模式匹配</b>：和 30 篇经典 Turing 模式文献对比打分；
        <b>开放科学</b>：一键生成 GitHub issue 格式的发现记录。
      </p>`;
  }

  $('#panel-rule').innerHTML = `
    <div class="section-label">生命引擎</div>
    <div class="segmented">
      <button data-engine="life" class="${isLife ? 'active' : ''}">Conway 系</button>
      <button data-engine="lenia" class="${isLenia ? 'active' : ''}">Lenia</button>
      <button data-engine="scientific" class="${isSci ? 'active' : ''}">反应-扩散（科学）</button>
    </div>
    ${bodyHTML}
    ${sciToolsHTML}
    <div class="btn-row">
      <button class="ghost" data-action="reseed">按当前配方重播</button>
      <button class="ghost" data-action="mutate">分裂突变</button>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* Sound panel                                                        */
/* ------------------------------------------------------------------ */

function renderSoundPanel() {
  const m = state.recipe.seed.genome.mapping;
  /* 重绘时保持"乐器编制"折叠区的展开状态，避免改一个下拉就自动收起 */
  const detailsWasOpen = !!$('#panel-sound .instrument-details')?.open;
  const activeVoices = INSTRUMENT_PARTS.filter((p) => voiceOf(m, p.key) !== 'off').length;
  $('#panel-sound').innerHTML = `
    <div class="section-label">音阶约束 · 五声</div>
    <div class="field">
      <div class="field-head"><label>根音</label><span class="val">${ROOT_NAMES[m.root]}</span></div>
      <select class="select" data-map-select="root" style="width:100%">
        ${ROOT_NAMES.map((n, i) => `<option value="${i}" ${i === m.root ? 'selected' : ''}>${n} · 根音</option>`).join('')}
      </select>
    </div>
    <div class="field">
      <div class="field-head"><label>音阶</label><span class="val">${SCALES[m.scale]?.note || ''}</span></div>
      <div class="preset-grid">
        ${Object.entries(SCALES).map(([key, s]) => `<button class="preset ${m.scale === key ? 'active' : ''}" data-scale="${key}"><b>${s.label}</b><span>${s.note}</span></button>`).join('')}
      </div>
    </div>
    <div class="section-label">映射</div>
    <div class="param-grid">
      ${sliderHTML('音区 Register', Math.round(m.register * 100), 0, 100, 1, 'data-map-param="register"', '%')}
      ${sliderHTML('亮度 Brightness', Math.round(m.brightness * 100), 10, 100, 1, 'data-map-param="brightness"', '%')}
      ${sliderHTML('节奏 Tempo', Math.round(m.tempo * 100), 10, 100, 1, 'data-map-param="tempo"', '%')}
      ${sliderHTML('约束 Strictness', Math.round(m.strictness * 100), 20, 100, 1, 'data-map-param="strictness"', '%')}
    </div>
    <div class="section-label">声部</div>
    <div class="switch-row"><span>持续低音 · 密度驱动</span><button class="switch ${m.drone ? 'on' : ''}" data-map-toggle="drone"></button></div>
    <div class="switch-row"><span>脉冲音符 · 活跃度驱动</span><button class="switch ${m.pulse ? 'on' : ''}" data-map-toggle="pulse"></button></div>
    <div class="switch-row"><span>生命周期事件声</span><button class="switch ${m.events ? 'on' : ''}" data-map-toggle="events"></button></div>
    <div class="section-label">音色</div>
    <div class="segmented">
      ${['sine', 'triangle', 'sawtooth', 'square'].map((w) => `<button data-wave="${w}" class="${m.wave === w ? 'active' : ''}">${w}</button>`).join('')}
    </div>
    <div class="section-label">混音台 · ${INSTRUMENT_PARTS.length} 声部</div>
    ${mixerSummaryHTML(m)}
    <div class="btn-row">
      <button class="primary soft" data-action="open-mixer">打开混音台</button>
      <button class="ghost" data-action="export-wav">导出 30s WAV</button>
    </div>
    <div class="btn-row">
      <button class="ghost" data-action="listen">试听一个事件</button>
    </div>
    <details class="instrument-details">
      <summary>乐器编制 · ${activeVoices}/${INSTRUMENT_PARTS.length} 在响</summary>
      <div class="instrument-list">
        ${INSTRUMENT_PARTS.map((p) => {
          const cur = voiceOf(m, p.key);
          return `<div class="field" style="margin-bottom:6px">
            <div class="field-head"><label>${p.label}</label><span class="val">${INSTRUMENT_VOICE_LABELS[cur] || cur}</span></div>
            <select class="select" data-instrument-select="${p.key}" style="width:100%">
              ${p.opts.map((o) => `<option value="${o}" ${o === cur ? 'selected' : ''}>${INSTRUMENT_VOICE_LABELS[o] || o}</option>`).join('')}
            </select>
          </div>`;
        }).join('')}
      </div>
    </details>
    <p class="hint">
      <b>密度</b> → 低音音量 · <b>熵</b> → 滤波器亮度 · <b>活跃度</b> → 节奏与音符密度 ·
      <b>周期</b> → 节奏规律性。拖动滑杆越慢越精细，按住 <b>Shift</b> 可微调，双击恢复默认。
    </p>`;
  if (detailsWasOpen) {
    const d = $('#panel-sound .instrument-details');
    if (d) d.open = true;
  }
}

/* ------------------------------------------------------------------ */
/* Mixer（专业混音台）                                                 */
/* ------------------------------------------------------------------ */

function mixerState() {
  const mapping = state.recipe.seed.genome.mapping;
  mapping.mixer = normalizeMixer(mapping.mixer);
  return mapping.mixer;
}

function mixerValueLabel(param, v) {
  if (param === 'gain' || param === 'send') return `${Math.round(v * 100)}`;
  if (param === 'pan') return v === 0 ? 'C' : (v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`);
  return v > 0 ? `+${v}` : String(v);
}

/* 滑块值（0–150 / −100–100 / −2–2）直接转显示文本 */
function mixerSliderLabel(param, raw) {
  if (param === 'gain' || param === 'send') return `${Math.round(raw)}`;
  if (param === 'pan') return raw === 0 ? 'C' : (raw < 0 ? `L${Math.round(-raw)}` : `R${Math.round(raw)}`);
  return raw > 0 ? `+${raw}` : String(raw);
}

function mixerSummaryHTML(mapping) {
  const mx = normalizeMixer(mapping.mixer);
  const active = INSTRUMENT_PARTS.filter((p) => voiceOf(mapping, p.key) !== 'off').length;
  const solos = INSTRUMENT_PARTS.filter((p) => mx.parts[p.key].solo).map((p) => p.label);
  return `<div class="mixer-summary" data-action="open-mixer" role="button" tabindex="0" title="打开混音台">
    <span>在响 ${active}/${INSTRUMENT_PARTS.length}</span>
    <span>主控 ${Math.round(mx.master * 100)}%</span>
    <span>速度 ×${mx.tempo.toFixed(2)}</span>
    <span>混响 ${Math.round(mx.reverb * 100)}%</span>
    ${solos.length ? `<span class="solo-flag">SOLO ${solos.join(' / ')}</span>` : ''}
  </div>`;
}

function mixerCtl(part, param, value, min, max, step, cap) {
  return `<label class="mix-ctl mini">
    <span class="mix-cap">${cap}</span>
    <input type="range" min="${min}" max="${max}" step="${step}" value="${value}"
      data-mixer-part="${part}" data-mixer-param="${param}">
    <span class="mix-val" data-mixer-val="${part}:${param}">${mixerSliderLabel(param, value)}</span>
  </label>`;
}

function mixerBodyHTML() {
  const mapping = state.recipe.seed.genome.mapping;
  const mx = normalizeMixer(mapping.mixer);
  const anySolo = INSTRUMENT_PARTS.some((p) => mx.parts[p.key].solo);
  const rows = INSTRUMENT_PARTS.map((p) => {
    const c = mx.parts[p.key];
    const cur = voiceOf(mapping, p.key);
    const dim = anySolo && !c.solo && !c.mute;
    return `<div class="mix-row${c.mute ? ' mute' : ''}${dim ? ' solo-dim' : ''}" data-mixer-row="${p.key}">
      <div class="mix-top">
        <div class="mix-name">${p.label}</div>
        <select class="select" data-instrument-select="${p.key}" aria-label="${p.label} 音色">
          ${p.opts.map((o) => `<option value="${o}" ${o === cur ? 'selected' : ''}>${INSTRUMENT_VOICE_LABELS[o] || o}</option>`).join('')}
        </select>
        <button class="mix-btn audition" data-mixer-audition="${p.key}" title="试听 ${p.label}" aria-label="试听 ${p.label}">♪</button>
        <button class="mix-btn${c.mute ? ' on' : ''}" data-mixer-mute="${p.key}" title="静音" aria-label="静音 ${p.label}">M</button>
        <button class="mix-btn solo${c.solo ? ' on' : ''}" data-mixer-solo="${p.key}" title="独奏" aria-label="独奏 ${p.label}">S</button>
      </div>
      <div class="mix-sliders">
        ${mixerCtl(p.key, 'gain', Math.round(c.gain * 100), 0, 150, 5, '音量')}
        ${mixerCtl(p.key, 'pan', Math.round(c.pan * 100), -100, 100, 5, '声像')}
        ${mixerCtl(p.key, 'oct', c.oct, -2, 2, 1, '八度')}
        ${mixerCtl(p.key, 'send', Math.round(c.send * 100), 0, 100, 5, '发送')}
      </div>
    </div>`;
  }).join('');

  return `
    <div class="mixer-presets">
      ${MIXER_PRESETS.map((p) => `<button class="preset${state.mixerPresetKey === p.key ? ' active' : ''}" data-mixer-preset="${p.key}"><b>${p.label}</b><span>${p.note}</span></button>`).join('')}
    </div>
    <div class="mixer-global">
      <label class="mix-ctl">主音量
        <input type="range" min="0" max="150" step="5" value="${Math.round(mx.master * 100)}" data-mixer-global="master">
        <span class="mix-val" data-mixer-val="global:master">${Math.round(mx.master * 100)}</span>
      </label>
      <label class="mix-ctl">速度
        <input type="range" min="50" max="200" step="5" value="${Math.round(mx.tempo * 100)}" data-mixer-global="tempo">
        <span class="mix-val" data-mixer-val="global:tempo">×${mx.tempo.toFixed(2)}</span>
      </label>
      <label class="mix-ctl">混响
        <input type="range" min="0" max="100" step="5" value="${Math.round(mx.reverb * 100)}" data-mixer-global="reverb">
        <span class="mix-val" data-mixer-val="global:reverb">${Math.round(mx.reverb * 100)}</span>
      </label>
    </div>
    <div class="mixer-table">
      <div class="mix-head"><span>声部</span><span>音色</span><span>♪</span><span>M</span><span>S</span><span>音量</span><span>声像</span><span>八度</span><span>发送</span></div>
      ${rows}
    </div>
    <div class="mixer-status" id="mixerStatus" aria-live="polite"></div>
    <p class="hint">♪ 试听当前音色 · 慢拖更精细，按住 Shift 微调 · 双击任意滑块恢复默认 · 音量 0–150% · 声像 L/C/R · 八度 −2…+2 · 发送 = 混响量。M 静音；S 独奏（独奏时其余声部自动变暗静音）。</p>`;
}

function openMixerModal() {
  const layer = openModal({
    eyebrow: 'MIXER · 11 CHANNELS',
    title: '专业混音台',
    body: mixerBodyHTML(),
    actions: [
      { label: '重置混音台', cls: 'ghost', onClick: () => resetMixer() },
      { label: '完成', cls: 'primary', onClick: () => closeModal() },
    ],
  });
  $('.modal-card', layer)?.classList.add('mixer-modal');
  /* 用属性赋值而非 addEventListener：重复打开不会叠加监听 */
  layer.oninput = onMixerInput;
  layer.onchange = onMixerChange;
  layer.onclick = onMixerClick;
  layer.ondblclick = onMixerDblClick;
}

function refreshMixerModal() {
  const layer = $('#modalLayer');
  if (!layer || layer.classList.contains('hidden')) return;
  const body = $('.modal-body', layer);
  if (body && body.querySelector('.mixer-table')) body.innerHTML = mixerBodyHTML();
}

function refreshMixerSummary() {
  const summ = $('#panel-sound .mixer-summary');
  if (summ) summ.outerHTML = mixerSummaryHTML(state.recipe.seed.genome.mapping);
}

function applyMixerToAudio() {
  state.mixerPresetKey = null;
  $$('.mixer-presets .preset.active').forEach((b) => b.classList.remove('active'));
  markGenomeChanged();   // 内部已调用 audio.setGenome（含 setMixer）
  refreshMixerSummary();
}

function resetMixer() {
  const mapping = state.recipe.seed.genome.mapping;
  mapping.mixer = normalizeMixer(DEFAULT_MIXER);
  state.mixerPresetKey = null;
  markGenomeChanged();
  renderSoundPanel();
  refreshMixerModal();
  toast('混音台已重置为中性值', 1600);
}

function auditionPart(part, btn) {
  if (!state.audioOn) setAudio(true);
  ensureAudio();
  state.audio?.audition(part);
  if (btn) {
    btn.classList.add('on');
    setTimeout(() => btn.classList.remove('on'), 240);
  }
}

/* 双击滑块 → 恢复该参数默认值 */
function onMixerDblClick(e) {
  const target = e.target;
  if (!target || !target.closest) return;
  const globalEl = target.closest('[data-mixer-global]');
  const partEl = target.closest('[data-mixer-part]');
  if (!globalEl && !partEl) return;
  e.preventDefault();
  const mx = mixerState();

  if (globalEl) {
    const key = globalEl.dataset.mixerGlobal;
    mx[key] = DEFAULT_MIXER[key];
    globalEl.value = String(Math.round(mx[key] * 100));
    syncRangeFill(globalEl);
    const valEl = $(`[data-mixer-val="global:${key}"]`);
    if (valEl) valEl.textContent = key === 'tempo' ? `×${mx.tempo.toFixed(2)}` : `${Math.round(mx[key] * 100)}`;
  } else {
    const part = partEl.dataset.mixerPart;
    const param = partEl.dataset.mixerParam;
    const def = DEFAULT_MIXER.parts[part]?.[param] ?? 0;
    mx.parts[part][param] = def;
    partEl.value = String(param === 'oct' ? def : Math.round(def * 100));
    syncRangeFill(partEl);
    const valEl = $(`[data-mixer-val="${part}:${param}"]`);
    if (valEl) valEl.textContent = mixerValueLabel(param, def);
  }
  applyMixerToAudio();
}

function onMixerInput(e) {
  const target = e.target;
  if (!target || !target.closest) return;
  const globalEl = target.closest('[data-mixer-global]');
  const partEl = target.closest('[data-mixer-part]');
  if (!globalEl && !partEl) return;
  const mx = mixerState();

  if (globalEl) {
    const key = globalEl.dataset.mixerGlobal;
    const raw = parseFloat(globalEl.value);
    if (!Number.isFinite(raw)) return;
    mx[key] = raw / 100;
    const valEl = $(`[data-mixer-val="global:${key}"]`);
    if (valEl) valEl.textContent = key === 'tempo' ? `×${mx.tempo.toFixed(2)}` : `${Math.round(raw)}`;
    applyMixerToAudio();
    return;
  }

  const part = partEl.dataset.mixerPart;
  const param = partEl.dataset.mixerParam;
  const raw = parseFloat(partEl.value);
  if (!Number.isFinite(raw)) return;
  const val = param === 'oct' ? Math.round(raw) : raw / 100;
  mx.parts[part][param] = val;
  const valEl = $(`[data-mixer-val="${part}:${param}"]`);
  if (valEl) valEl.textContent = mixerValueLabel(param, val);
  applyMixerToAudio();
}

function onMixerChange(e) {
  const sel = e.target.closest?.('[data-instrument-select]');
  if (!sel) return;
  const part = sel.dataset.instrumentSelect;
  const mapping = state.recipe.seed.genome.mapping;
  if (!mapping.instruments) mapping.instruments = { ...DEFAULT_INSTRUMENTS };
  mapping.instruments[part] = sel.value;
  markGenomeChanged();
  renderSoundPanel();
  const p = INSTRUMENT_PARTS.find((x) => x.key === part);
  toast(`${p?.label ?? part}：${INSTRUMENT_VOICE_LABELS[sel.value] || sel.value}`, 1200);
}

function onMixerClick(e) {
  const target = e.target;
  if (!target || !target.closest) return;
  const auditionBtn = target.closest('[data-mixer-audition]');
  if (auditionBtn) {
    auditionPart(auditionBtn.dataset.mixerAudition, auditionBtn);
    return;
  }
  const muteBtn = target.closest('[data-mixer-mute]');
  if (muteBtn) {
    const c = mixerState().parts[muteBtn.dataset.mixerMute];
    c.mute = !c.mute;
    muteBtn.classList.toggle('on', c.mute);
    muteBtn.closest('.mix-row')?.classList.toggle('mute', c.mute);
    applyMixerToAudio();
    return;
  }
  const soloBtn = target.closest('[data-mixer-solo]');
  if (soloBtn) {
    const c = mixerState().parts[soloBtn.dataset.mixerSolo];
    c.solo = !c.solo;
    applyMixerToAudio();
    /* 独奏会改变其他声部的可听状态，重绘一次让"变暗"状态同步 */
    refreshMixerModal();
    return;
  }
  const presetBtn = target.closest('[data-mixer-preset]');
  if (presetBtn) applyMixerPreset(presetBtn.dataset.mixerPreset);
}

function applyMixerPreset(key) {
  const preset = MIXER_PRESETS.find((p) => p.key === key);
  if (!preset) return;
  const mapping = state.recipe.seed.genome.mapping;
  mapping.instruments = { ...DEFAULT_INSTRUMENTS, ...preset.instruments };
  mapping.mixer = normalizeMixer(preset.mixer);
  state.mixerPresetKey = preset.key;
  markGenomeChanged();
  renderSoundPanel();
  refreshMixerModal();
  toast(`编制：${preset.label}`, 1400);
}

function exportMixdown() {
  if (state.exportingWav) return;
  state.exportingWav = true;
  const status = $('#mixerStatus');
  if (status) status.textContent = '离线渲染 30 秒中…';
  toast('离线渲染 30 秒中，请稍等 …', 5000);
  const rec = state.recipe;
  renderMixdownWav({
    genome: rec.seed.genome,
    env: rec.env,
    rngSeed: rec.rngSeed,
    seconds: 30,
    speed: 3,
  }).then((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `commons-${(rec.seed.name || 'mix').replace(/[^\w\u4e00-\u9fa5-]+/g, '_')}-30s.wav`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    const sizeMb = (blob.size / 1048576).toFixed(1);
    if (status) status.textContent = `已导出 ${sizeMb} MB WAV`;
    toast(`已导出 ${sizeMb} MB WAV`, 2600);
  }).catch((err) => {
    if (status) status.textContent = `导出失败：${err?.message || err}`;
    toast(`导出失败：${err?.message || err}`, 3200);
  }).finally(() => {
    state.exportingWav = false;
  });
}

/* ------------------------------------------------------------------ */
/* Environment panel                                                  */
/* ------------------------------------------------------------------ */

function renderPetHUD() {
  const hudPet = $('#hudPet');
  const hudPetMood = $('#hudPetMood');
  const hudPetBars = $('#hudPetBars');
  const exoticPill = $('#exoticPill');
  const exoticTarget = state.exoticEnvId
    ? EXOTIC_ENVIRONMENTS.find((x) => x.id === state.exoticEnvId)
    : null;
  if (!exoticTarget && state.exoticEnvId) state.exoticEnvId = null;
  if (!hudPet || !state.pet.state) {
    if (exoticPill) exoticPill.style.display = 'none';
    return;
  }

  const p = state.pet.state;
  const snap = p.snapshot();

  // 情绪 emoji + label
  const moodEmoji = PET_MOOD_EMOJI[snap.mood] || '';
  const moodLabel = PET_MOOD_LABEL[snap.mood] || '';
  if (hudPetMood) hudPetMood.innerHTML = `
    <span class="pet-emoji">${moodEmoji}</span>
    <span class="pet-label">${moodLabel}</span>
    ${state.exoticEnvId ? `<span class="pet-exotic" title="当前极端环境">⚠ 极端</span>` : ''}
  `;

  // 四状态 bar
  if (hudPetBars) {
    hudPetBars.innerHTML = `
      ${petBar('⚖ 平衡', snap.balance, '#d7261e')}
      ${petBar('⚗ 均匀', snap.uniform, '#121212')}
      ${petBar('⚡ 能量', snap.energy, '#d9a400')}
      ${petBar('🔥 活跃', snap.activity, '#b81d13')}
    `;
  }

  // 当前极端环境标签（右下角一个小 pill）
  if (exoticPill) {
    if (exoticTarget) {
      exoticPill.style.display = 'flex';
      exoticPill.innerHTML = `${exoticTarget.emoji} ${exoticTarget.label} <button class="exotic-close" data-exotic-cancel title="切回普通环境">×</button>`;
    } else {
      exoticPill.style.display = 'none';
    }
  }
}

function petBar(label, value, color) {
  const v = Math.round(parseFloat(value) * 100);
  return `<div class="pet-bar">
    <div class="pb-label">${label}</div>
    <div class="pb-track"><div class="pb-fill" style="width:${v}%;background:${color}"></div></div>
    <div class="pb-val">${v}</div>
  </div>`;
}

function renderEnvPanel() {
  const e = state.recipe.env;
  /* 极端环境可能超出常规滑杆范围（噪声 60%、时间 5× / 0.05×），
   * 动态扩展范围，避免 thumb 被浏览器夹住、读数与滑杆位置不一致。 */
  const noiseMax = Math.max(30, Math.ceil((e.noise || 0) * 100));
  const tsMin = Math.min(0.35, Math.floor((e.timeScale || 1) * 100) / 100);
  const tsMax = Math.max(2, Math.ceil((e.timeScale || 1) * 100) / 100);
  $('#panel-env').innerHTML = `
    <div class="section-label">🌌 极端 / 外星环境</div>
    <div class="exotic-row">
      ${EXOTIC_ENVIRONMENTS.map(x => {
        const active = (state.exoticEnvId === x.id) ? ' active' : '';
        return `<button class="exotic-preset${active}" data-exotic="${x.id}" title="${x.desc}">
          <span class="exotic-emoji">${x.emoji}</span>
          <span class="exotic-label">${x.label}</span>
          <span class="exotic-meta">${x.env.timeScale}× · N${Math.round(x.env.noise*100)} · C${Math.round(x.env.constraint*100)}</span>
        </button>`;
      }).join('')}
    </div>
    <div class="section-label">初始形态</div>
    <div class="preset-grid">
      ${Object.entries(PATTERNS).map(([key, p]) => `<button class="preset ${e.pattern === key ? 'active' : ''}" data-pattern="${key}"><b>${p.label}</b><span>${p.desc}</span></button>`).join('')}
    </div>
    <div class="section-label">边界条件</div>
    <div class="preset-grid">
      ${Object.entries(BOUNDARIES).map(([key, b]) => `<button class="preset ${e.boundary === key ? 'active' : ''}" data-boundary="${key}"><b>${b.label}</b><span>${b.desc}</span></button>`).join('')}
    </div>
    <div class="section-label">邻域类型 · Conway 系适用</div>
    <div class="segmented">
      ${Object.entries(NEIGHBORHOODS).map(([n, info]) => `<button data-neighborhood="${n}" class="${state.recipe.seed.genome.life.neighborhood === parseInt(n) ? 'active' : ''}">${info.label.split('·')[0].trim()}</button>`).join('')}
    </div>
    <div class="section-label">扰动与资源</div>
    ${sliderHTML('噪声扰动', Math.round(e.noise * 100), 0, noiseMax, 0.5, 'data-env-param="noise"', '%')}
    ${sliderHTML('资源注入率', Math.round(e.resource.rate * 100), 0, 50, 1, 'data-env-param="rate"', '%')}
    ${sliderHTML('资源周期', e.resource.period, 20, 200, 2, 'data-env-param="period"', ' 代')}
    ${sliderHTML('约束强度', Math.round(e.constraint * 100), 0, 100, 1, 'data-env-param="constraint"', '%')}
    ${sliderHTML('时间尺度', e.timeScale.toFixed(2), tsMin, tsMax, 0.05, 'data-env-param="timeScale"', '×')}
    <div class="btn-row">
      <button class="ghost" data-action="reseed-env">按此环境重新播种</button>
    </div>
    <p class="hint">
      <b>约束强度</b>（0-100%）抑制噪声和扰动。<b>资源节律</b>按周期注入营养。
      改变形态或边界会重新播种，但随机种子不变，所以同颗种子在不同家里会长成不同样子。
    </p>`;
}

/* ------------------------------------------------------------------ */
/* Structure panel                                                    */
/* ------------------------------------------------------------------ */

function renderStructPanel() {
  const sysPrefersReduced = !!(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
  const motionHint = sysPrefersReduced
    ? '已自动跟随系统的"减少动效"设置。'
    : '关掉它之后，所有呼吸和闪烁会停住，画面更稳定。';
  $('#panel-struct').innerHTML = `
    <div class="switch-row"><span><b>♪ 用心聆听模式</b><br><span class="hint" style="margin:0">先凭心里的感觉判断，再回来看它的样子。</span></span><button class="switch ${state.blind ? 'on' : ''}" data-action="blind"></button></div>
    <div class="blind-note">数值暂时藏起来了。先听 30 秒，再打开它看看自己的感受准不准 ♡</div>
    <div class="switch-row" style="margin-top:12px"><span><b>🌿 生命呼吸动效</b><br><span class="hint" style="margin:0">${motionHint}</span></span><button class="switch ${state.motion ? 'on' : ''}" data-action="motion"></button></div>
    <div class="struct-content">
    <div class="section-label">诊断</div>
    <div class="diagnosis" id="structDiagnosis">—</div>
    <div class="section-label">结构仪表盘</div>
    <div class="metric-grid">
      <div class="metric-card">
        <div class="m-label">DENSITY · 密度</div>
        <div class="m-value" id="sp-density">—</div>
        <canvas id="spark-density"></canvas>
      </div>
      <div class="metric-card">
        <div class="m-label">ENTROPY · 熵</div>
        <div class="m-value" id="sp-entropy">—</div>
        <canvas id="spark-entropy"></canvas>
      </div>
      <div class="metric-card">
        <div class="m-label" id="spPeriodLabel">PERIOD · 周期</div>
        <div class="m-value" id="sp-period">—</div>
      </div>
      <div class="metric-card">
        <div class="m-label">DIAMETER · 邻接直径</div>
        <div class="m-value" id="sp-diameter">—</div>
      </div>
      <div class="metric-card">
        <div class="m-label">ACTIVITY · 活跃度</div>
        <div class="m-value" id="sp-activity">—</div>
        <canvas id="spark-activity"></canvas>
      </div>
      <div class="metric-card">
        <div class="m-label">COMPONENTS · 连通块</div>
        <div class="m-value" id="sp-components">—</div>
      </div>
      <div class="metric-card wide">
        <div>
          <div class="m-label">FINGERPRINT · 结构指纹</div>
          <div class="m-value" id="sp-fingerprint" style="font-size:15px">—</div>
        </div>
        <canvas id="structGlyph"></canvas>
      </div>
    </div>
    <div class="section-label">亲缘提示</div>
    <div class="kin-list" id="structKin"><div class="hint">公地尚无剖析完成的邻居。</div></div>
    <div class="btn-row">
      <button class="ghost" data-action="goto-compare">对比聆听</button>
      <button class="ghost" data-action="goto-commons">浏览公地</button>
    </div>
    <p class="hint">结构指标用于理解、比较与亲缘提示，不替代聆听。</p>
    </div>
    <div class="blind-stage">
      <div class="blind-sigil"><span></span></div>
      <p class="blind-title">数值藏起来啦 ♡</p>
      <p class="blind-copy">先听 30 秒：它是安睡、呼吸，还是灵动？<br>再打开数值，对照一下自己的感受。</p>
      <button class="ghost" data-action="blind">打开数值看看</button>
    </div>`;
}

function toggleBlind() {
  state.blind = !state.blind;
  document.body.classList.toggle('blind-listen', state.blind);
  renderStructPanel();
  updateStructValues();
  updateHUD(true);
  toast(state.blind ? '♪ 数值藏起来啦，先用心听。' : '数值打开啦，来对照一下感受。');
}

function toggleMotion() {
  state.motion = !state.motion;
  // 用户手动覆盖后写入 localStorage，后续系统设置变化不再自动跟随
  try {
    localStorage.setItem('commons.motion.v1', state.motion ? 'on' : 'off');
  } catch (_) {}
  setMotionEnabled(state.motion);
  document.body.classList.toggle('motion-off', !state.motion);
  renderStructPanel();
  // 如果当前在 commons 视图，motion 关掉时立即取消 rAF 以省电
  if (!state.motion && _galleryBreathRafId) {
    cancelAnimationFrame(_galleryBreathRafId);
    _galleryBreathRafId = null;
    // 画一次静态缩略图替代 rAF 循环
    if (state.view === 'commons') renderCommons();
  } else if (state.motion && state.view === 'commons') {
    // 重新进入 commons 时会由 renderCommons 自己启动 rAF
  }
  toast(state.motion ? '🌿 生命的呼吸回来啦 ♡' : '呼吸停住了，画面更安静。');
}

function updateStructValues() {
  const m = state.metrics;
  if (!m) return;
  const set = (id, html) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  };
  set('sp-density', `${(m.density * 100).toFixed(1)}<small>%</small>`);
  set('sp-entropy', `${m.entropy.toFixed(2)}`);
  const periodIsLc = m.periodKind === 'correlation-length';
  const periodLabelEl = document.getElementById('spPeriodLabel');
  if (periodLabelEl) periodLabelEl.textContent = periodIsLc ? 'L_c · 相关长度' : 'PERIOD · 周期';
  set('sp-period', m.period ? `${m.period}<small>${periodIsLc ? '格' : '代'}</small>` : `∅<small>未收敛</small>`);
  set('sp-diameter', `${m.diameter}<small>格</small>`);
  set('sp-activity', `${m.activity.toFixed(2)}`);
  set('sp-components', `${m.components}<small>块</small>`);
  set('sp-fingerprint', formatFp(currentFingerprint()));

  const diag = $('#structDiagnosis');
  if (diag) diag.innerHTML = diagnosisText(m);

  drawSparkline($('#spark-density'), state.history.density, 'a', { min: 0, max: 0.4 });
  drawSparkline($('#spark-entropy'), state.history.entropy, 'a', { min: 0, max: 1 });
  drawSparkline($('#spark-activity'), state.history.activity, 'a', { min: 0, max: 1 });
  drawFingerprintGlyph($('#structGlyph'), m, 'a');

  const kinEl = $('#structKin');
  if (kinEl) {
    const self = { id: state.recipe.id, seed: state.recipe.seed, metrics: m };
    const rows = allCommons(state.lib)
      .filter((r) => r.id !== self.id && r.metrics)
      .map((r) => ({ r, k: kinship(self, r) }))
      .filter((x) => x.k)
      .sort((a, b) => a.k.gene + a.k.pheno - (b.k.gene + b.k.pheno))
      .slice(0, 4);
    kinEl.innerHTML = rows.length
      ? rows
          .map(
            ({ r, k }) => `<div class="kin-row">
              <span class="k-name">${esc(r.seed.name)}</span>
              <span class="k-tag" data-tone="${k.tone}">${k.label}</span>
            </div>`,
          )
          .join('')
      : '<div class="hint">公地尚无剖析完成的邻居。</div>';
  }
}

function diagnosisText(m) {
  const pct = (m.density * 100).toFixed(1);
  const hints = {
    stable: '歌声温柔持续，像一段慢慢的呼吸，最适合用来做参照。',
    periodic: '歌声会形成能认出来的循环，像一颗在跳动的小心心 ♪',
    chaotic: '声音更密、更亮、节奏也更灵动；它还在寻找自己的节奏。',
    endangered: '声音变得轻轻的，歌声拖长了，节拍也快要消失了。',
    extinct: '只剩下环境的轻轻哼唱和一点点余音。',
    drifting: '歌声随着它慢慢漫步，还没有定下来。',
  };
  let html = `它现在是<b>${m.typeLabel}</b>态：密度 ${pct}%，温柔度 ${m.entropy.toFixed(2)}，`;
  html += m.period
    ? (m.periodKind === 'correlation-length'
      ? `相关长度 ${m.period} 格，`
      : `呼吸周期 ${m.period} 代，`)
    : '还没有明显的呼吸周期，';
  html += `活跃度 ${m.activity.toFixed(2)}，邻接范围 ${m.diameter} 格，${m.components} 个连通块。<br>${hints[m.type] || ''}`;
  if (m.type === 'endangered') {
    html += '<br><b>轻轻关怀</b>：试试调低扰动、增加温柔的约束，或换个更宽容的家，也许它会好起来 ♡';
  } else if (m.type === 'chaotic' && m.density > 0.24) {
    html += '<br><b>温柔引导</b>：提高约束或减少一点资源注入，也许它会找到安静的节奏。';
  }
  return html;
}


function renderCommons() {
  const grid = $('#commonsGrid');
  if (!grid) return;
  const q = ($('#commonsSearch')?.value || '').trim().toLowerCase();
  const sort = $('#commonsSort')?.value || 'new';
  let list = allCommons(state.lib);

  if (q) {
    list = list.filter((r) => {
      const hay = `${r.seed.name} ${r.seed.latin} ${r.note} ${r.seed.genome.engine} ${ruleLabel(r.seed.genome)} ${r.seed.lineage?.generation || 0}`.toLowerCase();
      return hay.includes(q);
    });
  }

  const self = { id: state.recipe.id, seed: state.recipe.seed, metrics: state.metrics };
  if (sort === 'active') {
    list.sort((a, b) => (b.metrics?.activity || 0) - (a.metrics?.activity || 0));
  } else if (sort === 'stable') {
    list.sort((a, b) => (b.metrics?.stability || 0) - (a.metrics?.stability || 0));
  } else if (sort === 'kin') {
    list.sort((a, b) => {
      const ka = kinship(self, a);
      const kb = kinship(self, b);
      return (ka ? ka.gene + ka.pheno : 9) - (kb ? kb.gene + kb.pheno : 9);
    });
  } else {
    list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  grid.innerHTML = list
    .map((r) => {
      const k = r.id === self.id ? { label: '当前生命', tone: 'both', geneKin: false, phenoKin: false } : kinship(self, r);
      const m = r.metrics;
      const tags = [];
      if (k && k.label !== '远缘' && k.label !== '当前生命') {
        tags.push(`<span class="${k.tone}">${k.label}</span>`);
      }
      if (r.seed.lineage?.generation > 0) tags.push(`<span>G${r.seed.lineage.generation}</span>`);
      if (r.curated) tags.push('<span>原生</span>');
      if (r.auto) tags.push('<span>杂交</span>');
      return `<article class="seed-card" data-id="${esc(r.id)}">
        <div class="thumb">
          <canvas data-thumb="${esc(r.id)}"></canvas>
          <div class="thumb-fp">${r.fingerprint ? formatFp(parseInt(r.fingerprint, 16)) : 'PROFILING'}</div>
          <div class="thumb-tag">${tags.join('')}</div>
        </div>
        <div class="card-body">
          <div class="card-title">
            <h3>${esc(r.seed.name)}</h3>
            <span class="latin">${esc(r.seed.latin || '')}</span>
          </div>
          <div class="card-note">${esc(r.note || (m ? diagnosisShort(m) : '正在剖析结构指纹…'))}</div>
          <div class="card-metrics">
            ${m ? `<span>密度<b>${((m.density || 0) * 100).toFixed(1)}%</b></span>
            <span>熵<b>${(m.entropy || 0).toFixed(2)}</b></span>
            <span>${m.periodKind === 'correlation-length' ? 'L_c' : '周期'}<b>${m.period || '∅'}</b></span>
            <span>型<b>${m.typeLabel || '—'}</b></span>` : '<span>结构剖析中…</span>'}
          </div>
          <div class="card-actions">
            <button class="act-primary" data-adopt="${esc(r.id)}">领养</button>
            <button data-compare-with="${esc(r.id)}">对比</button>
            <button data-hybrid-with="${esc(r.id)}">杂交</button>
            <button data-share="${esc(r.id)}">分享</button>
          </div>
        </div>
      </article>`;
    })
    .join('');

  // thumbnails — 动效开启时持续呼吸动画（30fps），关闭时只画一次静态
  if (_galleryBreathRafId) { cancelAnimationFrame(_galleryBreathRafId); _galleryBreathRafId = null; }

  const paintOnce = (now) => {
    for (const r of list) {
      const canvas = grid.querySelector(`canvas[data-thumb="${CSS.escape(r.id)}"]`);
      if (!canvas) continue;
      const snap = decodeSnapshot(r.snapshot);
      drawSnapshot(canvas, snap || placeholderSnapshot(r), 'a', {
        ...(now ? { now } : {}),
        attrType: r.metrics ? r.metrics.type : 'stable',
        metrics: r.metrics,
      });
    }
  };

  if (!state.motion) {
    // 动效关闭：只画一次静态，不跑 rAF 循环（零开销）
    requestAnimationFrame(() => paintOnce(null));
  } else {
    // 动效开启：30fps 节流的持续呼吸循环
    const _breathTick = () => {
      if (state.view !== 'commons') { _galleryBreathRafId = null; return; }
      if (!state.motion) { _galleryBreathRafId = null; requestAnimationFrame(() => paintOnce(null)); return; }
      const grid = $('#commonsGrid');
      if (!grid) return;
      if (!_galleryLastTick || performance.now() - _galleryLastTick >= 33) {
        _galleryLastTick = performance.now();
        paintOnce(_galleryLastTick);
      }
      _galleryBreathRafId = requestAnimationFrame(_breathTick);
    };
    _galleryBreathRafId = requestAnimationFrame(_breathTick);
  }

  const user = state.lib.recipes.length;
  const hybrids = state.lib.recipes.filter((r) => r.auto).length;
  const profiled = list.filter((r) => r.metrics).length;
  $('#commonsStats').innerHTML = `
    <div class="stat-chip">收录 <b>${list.length}</b></div>
    <div class="stat-chip">本地保存 <b>${user}</b></div>
    <div class="stat-chip">杂交后代 <b>${hybrids}</b></div>
    <div class="stat-chip">已完成剖析 <b>${profiled}</b></div>
    <div class="stat-chip">引擎 <b>AL-${ENGINE_VERSION}</b></div>`;

  renderEnvRecipes();
  queueProfiles();
}

function renderEnvRecipes() {
  const gallery = $('#envGallery');
  if (!gallery) return;
  gallery.innerHTML = ENV_PRESETS.map((e) => {
    const fp = toHex(hashString(JSON.stringify(e.env)), 6).toLowerCase();
    const res = e.env.resource.rate
      ? ` · 资源 ${Math.round(e.env.resource.rate * 100)}% / ${e.env.resource.period} 代`
      : '';
    return `<div class="env-card">
      <div class="env-name">${esc(e.label)}<span class="env-fp">${fp}</span></div>
      <div class="env-spec">${PATTERNS[e.env.pattern].label} · ${BOUNDARY_LABEL[e.env.boundary]}<br>噪声 ${Math.round(e.env.noise * 100)}% · 约束 ${Math.round(e.env.constraint * 100)}%${res}</div>
      <div class="env-actions">
        <button data-env-apply="${e.id}">应用到当前</button>
        <button data-env-hatch="${e.id}">以此孵化</button>
        <button data-env-share="${e.id}">分享</button>
      </div>
    </div>`;
  }).join('');
}

function applyEnvPreset(envId, mode) {
  const preset = ENV_PRESETS.find((e) => e.id === envId);
  if (!preset) return;
  if (mode === 'apply') {
    /* 换成常规“家的环境”时，退出极端环境并清掉注入物理，避免徽标/物理残留 */
    if (state.exoticEnvId) {
      state.exoticEnvId = null;
      state.preExoticEnv = null;
      if (state.sim.clearPhysics) state.sim.clearPhysics();
    }
    state.recipe.env = deepClone(preset.env);
    state.sim.setEnv(state.recipe.env);
    state.sim.reset();
    afterEnvReset();
    renderEnvPanel();
    renderPetHUD();
    switchView('cultivate');
    toast(`家的环境换好啦：${preset.label} ♡`);
    return;
  }
  if (mode === 'hatch') {
    const env = deepClone(preset.env);
    const genome = deepClone(state.recipe.seed.genome);
    const hash = hashString(JSON.stringify({ genome, env }) + Date.now());
    const name = proceduralName(hash);
    const rec = {
      id: uid('r'),
      seed: {
        id: uid('s'),
        name: name.zh,
        latin: name.latin,
        genome,
        lineage: { parents: [state.recipe.id], parentNames: [state.recipe.seed.name], generation: (state.recipe.seed.lineage?.generation || 0) + 1 },
      },
      env,
      rngSeed: hash,
      note: `同种子异环境 · ${preset.label}`,
    };
    attachRecipe(rec);
    state.events = [];
    renderTimeline();
    addLifecycle('hatch', `环境孵化 · ${name.zh}`, state.metrics, { force: true, toast: false });
    switchView('cultivate');
    toast(`在「${preset.label}」家里孵出了一颗新种子 ♡`);
    return;
  }
  if (mode === 'share') {
    const env = deepClone(preset.env);
    const rec = {
      id: uid('r'),
      seed: deepClone(state.recipe.seed),
      env,
      rngSeed: hashString(JSON.stringify({ g: state.recipe.seed.genome, e: env })),
      note: `环境配方 · ${preset.label}`,
    };
    shareRecipeObject(rec);
  }
}

function placeholderSnapshot(r) {
  /* 占位快照：用种子名+随机种子生成稳定的伪年龄/场强度数据。
     让每颗种子即使没有真实快照也能有独特的缩略图水彩感。 */
  const rand = mulberry32(hashString(r.seed.name + r.rngSeed));
  const w = 80;
  const h = 45;
  const data = new Uint8Array(w * h);
  // 中心点 + 随机散布，让每颗种子结构不同
  const cx = Math.floor(rand() * w);
  const cy = Math.floor(rand() * h);
  const density = 0.08 + rand() * 0.14;
  const range = 12 + Math.floor(rand() * 10);
  for (let i = 0; i < data.length; i++) {
    if (rand() < density) {
      const x = i % w, y = Math.floor(i / w);
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (dist < range) data[i] = Math.max(1, Math.round(255 * (1 - dist / range) * rand()));
    }
  }
  // 保证不纯白
  if (!data.some(v => v > 0)) data[Math.floor(rand() * data.length)] = 20;
  return { data, w, h };
}

function queueProfiles() {
  const pending = allCommons(state.lib).filter((r) => !r.metrics);
  if (!pending.length) return;
  for (const r of pending) {
    if (!profileQueue.find((q) => q.id === r.id)) profileQueue.push(r);
  }
  if (profileTimer) return;
  const run = () => {
    profileTimer = null;
    const rec = profileQueue.shift();
    if (!rec) return;
    profileRecipe(rec);
    if (!rec.curated) saveLibrary(state.lib);
    if (state.view === 'commons') renderCommons();
    else if (state.view === 'compare') refreshCompareOptions();
    if (profileQueue.length) profileTimer = setTimeout(run, 120);
  };
  profileTimer = setTimeout(run, 30);
}

function findRecipe(id) {
  if (!id) return null;
  if (id === 'current') return currentRecipeForCompare();
  return allCommons(state.lib).find((r) => r.id === id) || null;
}

function adoptRecipe(rec, opts = {}) {
  const copy = normalizeRecipe(rec);
  attachRecipe(copy);
  state.events = [];
  renderTimeline();
  addLifecycle(opts.kind || 'hatch', opts.label || `领养 · ${copy.seed.name}`, state.metrics, {
    force: true,
    tone: 'stable',
    toast: opts.toast || false,
  });
  switchView('cultivate');
  toast(opts.toastText || `领养成功 ♡「${copy.seed.name}」`);
}

function hatchRandom(opts = {}) {
  const rand = mulberry32((Math.random() * 0xffffffff) >>> 0);
  const engine = rand() < 0.62 ? 'life' : 'lenia';
  const genome = defaultGenome(engine, engine === 'life' ? 'conway' : 'bloom');
  if (engine === 'life') {
    const lifeKeys = Object.keys(LIFE_PRESETS);
    const key = lifeKeys[Math.floor(rand() * lifeKeys.length)];
    applyLifePreset(genome, key);
    if (rand() < 0.35) {
      const set = new Set(genome.life.birth);
      set.delete(Math.floor(rand() * 9));
      set.add(1 + Math.floor(rand() * 8));
      genome.life.birth = Array.from(set).sort((a, b) => a - b);
      genome.life.preset = 'custom';
    }
  } else {
    const keys = Object.keys(LENIA_PRESETS);
    applyLeniaPreset(genome, keys[Math.floor(rand() * keys.length)]);
    genome.lenia.mu = clamp(genome.lenia.mu + (rand() - 0.5) * 0.08, 0.06, 0.38);
    genome.lenia.sigma = clamp(genome.lenia.sigma + (rand() - 0.5) * 0.01, 0.008, 0.045);
    genome.lenia.radius = Math.round(clamp(genome.lenia.radius + (rand() - 0.5) * 2, 2, 6));
  }
  const map = genome.mapping;
  map.root = Math.floor(rand() * 12);
  map.scale = ['major', 'minor', 'lydian'][Math.floor(rand() * 3)];
  map.wave = ['sine', 'triangle', 'sawtooth', 'square'][Math.floor(rand() * 4)];
  map.register = 0.25 + rand() * 0.5;
  map.brightness = 0.3 + rand() * 0.55;
  map.tempo = 0.2 + rand() * 0.65;
  map.strictness = 0.45 + rand() * 0.5;

  const patterns = Object.keys(PATTERNS);
  const env = defaultEnv({
    pattern: patterns[Math.floor(rand() * patterns.length)],
    boundary: rand() < 0.7 ? 'torus' : 'wall',
    noise: rand() < 0.5 ? rand() * 0.04 : 0,
    constraint: 0.15 + rand() * 0.65,
    timeScale: 0.7 + rand() * 0.8,
  });
  if (rand() < 0.2) env.resource = { rate: 0.08 + rand() * 0.25, period: 40 + rand() * 120 };
  if (engine === 'lenia' && ['glider', 'oscillator'].includes(env.pattern)) env.pattern = 'blob';

  const hash = hashString(JSON.stringify({ genome, env }) + Date.now() + rand());
  const name = proceduralName(hash);
  const rec = {
    id: uid('r'),
    seed: {
      id: uid('s'),
      name: name.zh,
      latin: name.latin,
      genome,
      lineage: { parents: [], generation: 0 },
    },
    env,
    rngSeed: hash,
    note: `随机孵化 · ${PATTERNS[env.pattern].label} · ${BOUNDARY_LABEL[env.boundary]}`,
  };
  attachRecipe(rec);
  state.events = [];
  renderTimeline();
  addLifecycle('hatch', `孵化 · ${name.zh}`, state.metrics, { force: true, toast: false });
  switchView('cultivate');
  toast(`随机孵出了一颗小心心 ♡「${name.zh}」`, 'ok');
}

/* ------------------------------------------------------------------ */
/* Actions                                                            */
/* ------------------------------------------------------------------ */

function reseed() {
  rebuildSim();
  addLifecycle('hatch', '按配方重播', state.metrics, { force: true, toast: false });
  toast('按配方重新播种好啦 ♪');
}

function mutateCurrent() {
  const parent = state.recipe;
  const rand = mulberry32(hashString(JSON.stringify(parent.seed.genome) + Date.now()));
  const genome = deepClone(parent.seed.genome);
  if (genome.engine === 'life') {
    const birth = new Set(genome.life.birth);
    const survive = new Set(genome.life.survive);
    if (rand() < 0.6) {
      const n = Math.floor(rand() * 9);
      if (birth.has(n)) birth.delete(n);
      else birth.add(n);
    }
    if (rand() < 0.6) {
      const n = Math.floor(rand() * 9);
      if (survive.has(n)) survive.delete(n);
      else survive.add(n);
    }
    genome.life.birth = Array.from(birth).sort((a, b) => a - b);
    genome.life.survive = Array.from(survive).sort((a, b) => a - b);
    genome.life.preset = 'mutant';
  } else {
    genome.lenia.mu = clamp(genome.lenia.mu + (rand() - 0.5) * 0.05, 0.06, 0.38);
    genome.lenia.sigma = clamp(genome.lenia.sigma + (rand() - 0.5) * 0.008, 0.008, 0.045);
    genome.lenia.radius = Math.round(clamp(genome.lenia.radius + (rand() < 0.3 ? 1 : 0), 2, 6));
  }
  const map = genome.mapping;
  map.root = (map.root + (rand() < 0.3 ? 1 : 0)) % 12;
  map.tempo = clamp(map.tempo + (rand() - 0.5) * 0.15, 0.15, 1);
  if (rand() < 0.25) map.scale = ['major', 'minor', 'lydian'][Math.floor(rand() * 3)];

  const hash = hashString(JSON.stringify(genome) + Date.now());
  const name = proceduralName(hash);
  const child = makeRecipe(
    {
      id: uid('s'),
      name: name.zh,
      latin: name.latin,
      genome,
      lineage: {
        parents: [parent.id],
        parentNames: [parent.seed.name],
        generation: (parent.seed.lineage?.generation || 0) + 1,
      },
    },
    parent.env,
    hash,
    null,
    null,
    { note: `分裂自「${parent.seed.name}」`, auto: true },
  );
  profileRecipe(child, 90);
  state.lib.recipes.push(child);
  saveLibrary(state.lib);
  attachRecipe(child);
  addLifecycle('mutate', `分裂 · ${name.zh}`, state.metrics, {
    force: true,
    toast: false,
    detail: `亲本 ${parent.seed.name}`,
  });
  toast(`轻轻分裂出了「${name.zh}」，家谱已记录 ♡`, 'ok');
}

function iterateCurrentSeed() {
  const rec = normalizeRecipe(deepClone(state.recipe));
  rec.seed.genome = deepClone(rec.seed.genome);
  return rec;
}

/* ------------------------------------------------------------------ */
/* Save / share / hybrid                                              */
/* ------------------------------------------------------------------ */

function openModal({ eyebrow = '', title, body, actions = [] }) {
  const layer = $('#modalLayer');
  /* 只在没有其他弹窗时记录来源焦点，避免嵌套打开时丢失 */
  if (!document.body.classList.contains('modal-open')) {
    _modalReturnFocus = document.activeElement;
  }
  layer.innerHTML = `<div class="modal-card">
    <div class="modal-head">
      <div><div class="eyebrow">${esc(eyebrow)}</div><h3>${esc(title)}</h3></div>
      <button class="modal-close" data-close="1">✕</button>
    </div>
    <div class="modal-body">${body}</div>
    <div class="modal-actions"></div>
  </div>`;
  layer.classList.remove('hidden');
  document.body.classList.add('modal-open');
  const actionsEl = $('.modal-actions', layer);
  for (const a of actions) {
    const btn = document.createElement('button');
    btn.className = a.cls || 'ghost';
    btn.textContent = a.label;
    btn.addEventListener('click', () => a.onClick?.(layer));
    actionsEl.appendChild(btn);
  }
  $('.modal-close', layer).addEventListener('click', closeModal);
  const card = $('.modal-card', layer);
  card.setAttribute('tabindex', '-1');
  const focusCard = () => { try { card.focus({ preventScroll: true }); } catch (_) { /* noop */ } };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focusCard);
  else focusCard();
  return layer;
}

function closeModal() {
  const layer = $('#modalLayer');
  layer.classList.add('hidden');
  layer.innerHTML = '';
  document.body.classList.remove('modal-open');
  if (_modalReturnFocus && _modalReturnFocus.isConnected) {
    try { _modalReturnFocus.focus({ preventScroll: true }); } catch (_) { /* noop */ }
  }
  _modalReturnFocus = null;
}

function openSaveModal() {
  const m = state.metrics;
  const defaultName = state.recipe.seed.name;
  const layer = openModal({
    eyebrow: 'SAVE TO COMMONS',
    title: '把这枚生命留在公地',
    body: `
      <p>保存完整配方：生命种子 + 环境 + 随机种子 + 引擎版本，并附当前结构指纹。任何人可用它复现同一段演化。</p>
      <div class="field"><label>名字</label><input id="saveName" type="text" value="${esc(defaultName)}" maxlength="24" /></div>
      <div class="field"><label>备注（可选）</label><textarea id="saveNote" rows="3" maxlength="120" placeholder="它此刻听起来像什么？">${esc(state.recipe.note || '')}</textarea></div>
      <div class="field"><label>结构指纹</label><input type="text" readonly value="${formatFp(currentFingerprint())} · ${m?.typeLabel || '—'} · ${m ? (m.density * 100).toFixed(1) : '0'}%" /></div>`,
    actions: [
      { label: '取消', cls: 'ghost', onClick: closeModal },
      { label: '保存', cls: 'primary', onClick: (el) => saveCurrent(el) },
    ],
  });
  const input = $('#saveName', layer);
  input?.focus();
  input?.select();
}

function saveCurrent(layer) {
  const name = ($('#saveName', layer)?.value || '').trim() || state.recipe.seed.name;
  const note = ($('#saveNote', layer)?.value || '').trim();
  const rec = makeRecipe(
    {
      ...state.recipe.seed,
      name,
      genome: state.recipe.seed.genome,
    },
    state.recipe.env,
    state.recipe.rngSeed,
    state.metrics,
    state.sim.snapshot(2),
    { note },
  );
  rec.seed.lineage = deepClone(state.recipe.seed.lineage);
  state.lib.recipes.push(rec);
  saveLibrary(state.lib);
  closeModal();
  toast(`「${name}」已存入花园 ♡`, 'ok');
  renderCommons();
  refreshCompareOptions();
}

function openShareModal() {
  const code = encodeRecipe(state.recipe);
  const base = location.href.split('#')[0];
  const url = `${base}#r=${code}`;
  openModal({
    eyebrow: 'SHARE RECIPE',
    title: '分享完整生命配方',
    body: `
      <p>链接包含生命种子、环境、随机种子与引擎版本；接收者打开后会在本地复现同一段演化。结构指纹随配方一起校验。</p>
      <textarea id="shareText" rows="4" readonly>${esc(url)}</textarea>
      <p class="hint">不包含音频、个人数据或匿名记录。</p>`,
    actions: [
      { label: '关闭', cls: 'ghost', onClick: closeModal },
      {
        label: '复制链接',
        cls: 'primary',
        onClick: async (el) => {
          const text = $('#shareText', el)?.value || url;
          const ok = await copyText(text);
          toast(ok ? '链接已复制到剪贴板 ✿' : '没能自动复制，来手动选一下吧 ♡', ok ? 'ok' : 'warn');
        },
      },
    ],
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e2) {
      return false;
    }
  }
}

function openHybridModal(prePartnerId) {
  const partners = allCommons(state.lib).filter((r) => r.id !== state.recipe.id);
  if (!partners.length) {
    toast('花园里还没有其他种子可以一起相爱，先存几颗进来吧 ♡', 'warn');
    return;
  }
  const rows = partners
    .map((r) => {
      const k = kinship(currentRecipeForCompare(), r);
      return `<button class="choice ${r.id === prePartnerId ? 'selected' : ''}" data-partner="${esc(r.id)}">
        <div>
          <div class="ch-name">${esc(r.seed.name)}</div>
          <div class="ch-meta">${ruleLabel(r.seed.genome)} · ${ENGINE_LABEL[r.seed.genome.engine]} · ${k?.label || '待剖析'}</div>
        </div>
        <span class="ch-radio"></span>
      </button>`;
    })
    .join('');
  const layer = openModal({
    eyebrow: 'HYBRIDISE',
    title: '与另一枚种子杂交',
    body: `
      <p>规则、声音映射与环境会按父代交叉，并加入轻微突变。子代会继承谱系，记录双亲与世代。</p>
      <div class="choice-list" id="partnerList">${rows}</div>
      <p class="hint">选择一枚伙伴，系统将生成新的生命种子并自动记录谱系。</p>`,
    actions: [
      { label: '取消', cls: 'ghost', onClick: closeModal },
      {
        label: '生成子代',
        cls: 'primary',
        onClick: (el) => {
          const selected = $('.choice.selected', el)?.dataset.partner;
          if (!selected) {
            toast('选一个你喜欢的伙伴吧 ♡', 'warn');
            return;
          }
          doHybrid(selected);
        },
      },
    ],
  });
  const list = $('#partnerList', layer);
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-partner]');
    if (!btn) return;
    $$('.choice', list).forEach((b) => b.classList.toggle('selected', b === btn));
  });
}

function doHybrid(partnerId) {
  const partner = findRecipe(partnerId);
  if (!partner) return;
  const child = hybridize(state.recipe, partner, { rngSeed: (Math.random() * 0xffffffff) >>> 0 });
  profileRecipe(child, 100);
  state.lib.recipes.push(child);
  saveLibrary(state.lib);
  closeModal();
  attachRecipe(child);
  addLifecycle('hybrid', `杂交 · ${child.seed.name}`, state.metrics, {
    force: true,
    toast: false,
    detail: `亲本 ${state.recipe.seed.name} × ${partner.seed.name}`,
  });
  toast(`它们相爱生出了「${child.seed.name}」，家谱已更新 ♡`, 'ok');
  renderCommons();
  refreshCompareOptions();
}

function shareRecipe(id) {
  const rec = findRecipe(id);
  if (!rec) return;
  shareRecipeObject(rec);
}

function shareRecipeObject(rec) {
  const fpCode = rec.fingerprint || toHex(rec.metrics ? structuralFingerprint(rec.metrics) : currentFingerprint(), 8);
  const code = encodeRecipe({ ...rec, fingerprint: fpCode });
  const url = `${location.href.split('#')[0]}#r=${code}`;
  const fp = formatFp(parseInt(fpCode, 16));
  openModal({
    eyebrow: 'SHARE',
    title: `分享「${rec.seed.name}」`,
    body: `<p>该链接包含完整配方与随机种子，接收者可复现同一生命。${rec.note ? `<br><span class="hint">${esc(rec.note)}</span>` : ''}</p>
      <p class="hint">结构指纹 ${fp} · 引擎 AL-${ENGINE_VERSION}</p>
      <textarea id="shareText" rows="4" readonly>${esc(url)}</textarea>`,
    actions: [
      { label: '关闭', cls: 'ghost', onClick: closeModal },
      {
        label: '复制链接',
        cls: 'primary',
        onClick: async (el) => {
          const ok = await copyText($('#shareText', el)?.value || url);
          toast(ok ? '链接已复制 ✿' : '没能自动复制，来手动选一下吧 ♡', ok ? 'ok' : 'warn');
        },
      },
    ],
  });
}

/* ------------------------------------------------------------------ */
/* Compare                                                            */
/* ------------------------------------------------------------------ */

function compareSeedPool() {
  const pool = [{ key: 'current', recipe: currentRecipeForCompare() }];
  for (const r of allCommons(state.lib)) {
    if (r.id === state.recipe.id) continue;
    pool.push({ key: r.id, recipe: r });
  }
  return pool;
}

function refreshCompareOptions() {
  const c = state.compare;
  const pool = compareSeedPool();
  const seedOptions = pool
    .map(
      ({ key, recipe }) =>
        `<option value="${esc(key)}">${esc(recipe.seed.name)}${recipe.seed.lineage?.generation ? ` · G${recipe.seed.lineage.generation}` : ''}</option>`,
    )
    .join('');
  for (const side of ['a', 'b']) {
    const sel = $(`#compareSeed${side.toUpperCase()}`);
    if (!sel) continue;
    const prev = sel.value;
    sel.innerHTML = seedOptions;
    const want = c.keys[side] && pool.find((p) => p.key === c.keys[side]) ? c.keys[side] : prev || 'current';
    sel.value = want;
    c.keys[side] = want;
  }
  const envOptions = ENV_PRESETS.map(
    (e) => `<option value="${e.id}">${e.label}</option>`,
  ).join('');
  for (const side of ['a', 'b']) {
    const sel = $(`#compareEnv${side.toUpperCase()}`);
    if (!sel) continue;
    const prev = sel.value;
    sel.innerHTML = envOptions;
    sel.value = c.envKeys[side] || prev || ENV_PRESETS[0].id;
    c.envKeys[side] = sel.value;
  }
}

function openCompare() {
  const c = state.compare;
  if (!c.ready) {
    if (!c.keys.a) c.keys.a = 'current';
    if (!c.keys.b) {
      const pool = compareSeedPool();
      const alt = pool.find((p) => p.key !== c.keys.a);
      c.keys.b = alt ? alt.key : c.keys.a;
    }
    refreshCompareOptions();
    c.ready = true;
    rebuildCompare();
  } else {
    refreshCompareOptions();
    applyCompareMode();
  }
  updateCompareModeUI();
}

function updateCompareModeUI() {
  const mode = state.compare.mode;
  $$('#compareMode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
}

function envFor(id) {
  return deepClone((ENV_PRESETS.find((e) => e.id === id) || ENV_PRESETS[0]).env);
}

function applyCompareMode() {
  const c = state.compare;
  const seedA = $('#compareSeedA');
  const seedB = $('#compareSeedB');
  const envA = $('#compareEnvA');
  const envB = $('#compareEnvB');
  if (!seedA || !seedB) return;
  if (c.mode === 'seed') {
    seedB.disabled = false;
    envB.disabled = true;
    envB.value = envA.value;
    c.envKeys.b = envA.value;
  } else {
    seedB.disabled = true;
    envB.disabled = false;
    seedB.value = seedA.value;
    c.keys.b = c.keys.a;
  }
}

function rebuildCompare() {
  const c = state.compare;
  const pool = compareSeedPool();
  if (!pool.find((p) => p.key === c.keys.a)) c.keys.a = 'current';
  if (!pool.find((p) => p.key === c.keys.b)) c.keys.b = pool[1]?.key || 'current';
  if (c.mode === 'env') c.keys.b = c.keys.a;
  const recA = pool.find((p) => p.key === c.keys.a)?.recipe || state.recipe;
  const recB = pool.find((p) => p.key === c.keys.b)?.recipe || recA;
  const envA = envFor(c.envKeys.a);
  const envB = c.mode === 'seed' ? envFor(c.envKeys.a) : envFor(c.envKeys.b);
  if (c.mode === 'env') c.keys.b = c.keys.a;

  const rngA = recA.rngSeed || hashString(JSON.stringify(recA.seed.genome));
  const rngB = recB.rngSeed || hashString(JSON.stringify(recB.seed.genome));

  c.recipeA = { ...recA, env: envA, rngSeed: rngA };
  c.recipeB = { ...recB, env: envB, rngSeed: rngB };
  c.simA = createEngine(recA.seed.genome, envA, rngA);
  c.simB = createEngine(recB.seed.genome, envB, rngB);
  c.metricsA = computeMetrics(c.simA);
  c.metricsB = computeMetrics(c.simB);
  c.accA = 0;
  c.accB = 0;
  c.stepA = 0;
  c.stepB = 0;
  c.rendererA.attach(c.simA);
  c.rendererB.attach(c.simB);
  c.rendererA.setMetrics(c.metricsA);
  c.rendererB.setMetrics(c.metricsB);
  c.rendererA.clear();
  c.rendererB.clear();
  if (c.audioA) {
    c.audioA.setGenome(recA.seed.genome);
    c.audioA.updateMetrics(c.metricsA);
    c.audioB.setGenome(recB.seed.genome);
    c.audioB.updateMetrics(c.metricsB);
  }
  const selA = $('#compareSeedA');
  const selB = $('#compareSeedB');
  if (selA) selA.value = c.keys.a;
  if (selB) selB.value = c.keys.b;
  const envAEl = $('#compareEnvA');
  const envBEl = $('#compareEnvB');
  if (envAEl) envAEl.value = c.envKeys.a;
  if (envBEl) envBEl.value = c.envKeys.b;
  applyCompareMode();
  updateCompareModeUI();
  updateCompareUI();
}

function stepCompareSide(side, dt) {
  const c = state.compare;
  const sim = side === 'a' ? c.simA : c.simB;
  if (!sim) return;
  const accKey = side === 'a' ? 'accA' : 'accB';
  const stepKey = side === 'a' ? 'stepA' : 'stepB';
  const stepMs = sim.kind === 'lenia' ? 42 : 80;
  c[accKey] += dt;
  let count = 0;
  while (c[accKey] >= stepMs && count < 3) {
    sim.step();
    c[accKey] -= stepMs;
    count++;
    c[stepKey]++;
    if (c.audioA && state.audioOn) {
      const a = side === 'a' ? c.audioA : c.audioB;
      a.pushBirths(sim.lastBirths, sim.w, sim.h);
    }
  }
  if (c[stepKey] >= 5) {
    c[stepKey] = 0;
    const m = computeMetrics(sim);
    if (side === 'a') {
      c.metricsA = m;
      c.rendererA.setMetrics(m);
      if (c.audioA && state.audioOn) c.audioA.updateMetrics(m);
    } else {
      c.metricsB = m;
      c.rendererB.setMetrics(m);
      if (c.audioB && state.audioOn) c.audioB.updateMetrics(m);
    }
  }
}

function updateCompareUI() {
  const c = state.compare;
  if (!c.metricsA) return;
  for (const side of ['a', 'b']) {
    const m = side === 'a' ? c.metricsA : c.metricsB;
    const badge = $(`#compareBadge${side.toUpperCase()}`);
    if (badge) badge.textContent = `${m.typeLabel} · G${m.gen}`;
    const el = $(`#compareMetrics${side.toUpperCase()}`);
    if (el)
      el.innerHTML = `
      <div class="cm-cell">TYPE<b>${m.typeLabel}</b></div>
      <div class="cm-cell">DENSITY<b>${(m.density * 100).toFixed(1)}%</b></div>
      <div class="cm-cell">ENTROPY<b>${m.entropy.toFixed(2)}</b></div>
      <div class="cm-cell">PERIOD<b>${m.period || '∅'}</b></div>
      <div class="cm-cell">DIAMETER<b>${m.diameter}</b></div>
      <div class="cm-cell">ACTIVITY<b>${m.activity.toFixed(2)}</b></div>`;
  }
  renderCompareInsight();
}

function renderCompareInsight() {
  const c = state.compare;
  if (!c.metricsA || !c.metricsB) return;
  const a = { id: 'A', seed: c.recipeA.seed, metrics: c.metricsA };
  const b = { id: 'B', seed: c.recipeB.seed, metrics: c.metricsB };
  const k = kinship(a, b);
  const ma = c.metricsA;
  const mb = c.metricsB;
  const rows = [
    { label: '密度', a: ma.density, b: mb.density, span: 0.3, fmt: (v) => `${(v * 100).toFixed(1)}%` },
    { label: '熵', a: ma.entropy, b: mb.entropy, span: 1, fmt: (v) => v.toFixed(2) },
    { label: '周期', a: ma.period, b: mb.period, span: 16, fmt: (v) => (v ? `${v}` : '∅') },
    { label: '直径', a: ma.diameterNorm, b: mb.diameterNorm, span: 1, fmt: (v, src) => `${src.diameter}` },
    { label: '活跃度', a: ma.activity, b: mb.activity, span: 1, fmt: (v) => v.toFixed(2) },
  ];
  const deltaHTML = rows
    .map((r) => {
      const diff = clamp((r.b - r.a) / r.span, -1, 1);
      const width = Math.abs(diff) * 50;
      const left = diff >= 0 ? 50 : 50 - width;
      return `<div class="delta">
        <div class="d-label"><span>${r.label}</span><span>${r.fmt(r.a, ma)} → ${r.fmt(r.b, mb)}</span></div>
        <div class="d-bar"><i style="width:${width}%;left:${left}%;background:${diff >= 0 ? '#d9a400' : '#121212'}"></i></div>
      </div>`;
    })
    .join('');

  const denser = mb.density > ma.density ? 'B' : 'A';
  const brighter = mb.entropy > ma.entropy ? 'B' : 'A';
  const faster = mb.activity > ma.activity ? 'B' : 'A';
  const listen = `${denser} 更密，${brighter} 更亮，${faster} 的节奏更急。先听左右声道的密度与亮度差异，再回到结构指标验证。`;
  const detail = k?.detail ? `${k.detail}。` : '';

  $('#compareInsight').innerHTML = `
    <div class="insight-head">
      <h3>${esc(c.recipeA.seed.name)} <span style="color:var(--dim)">↔</span> ${esc(c.recipeB.seed.name)}</h3>
      <span class="k-tag" data-tone="${k?.tone || 'far'}">${k?.label || '—'}</span>
      <span class="badge">基因距离 <b>${k ? k.gene.toFixed(2) : '—'}</b></span>
      <span class="badge">表型距离 <b>${k ? k.pheno.toFixed(2) : '—'}</b></span>
    </div>
    <p class="insight-copy">${esc(detail)} ${esc(listen)}</p>
    <div class="delta-grid">${deltaHTML}</div>`;
}

function updateCompareAudioButton() {
  const btn = $('#compareAudio');
  if (!btn) return;
  btn.textContent = state.audioOn && state.view === 'compare' ? '停止聆听' : '同步聆听';
  btn.classList.toggle('soft', state.audioOn && state.view === 'compare');
}

/* ------------------------------------------------------------------ */
/* Research data                                                      */
/* ------------------------------------------------------------------ */

function openResearchModal() {
  const lib = state.lib;
  const summary = telemetrySummary(lib);
  const setConsent = (on) => {
    lib.consent = on;
    saveLibrary(lib);
    updateResearchLabel();
    $('#consentSwitch')?.classList.toggle('on', on);
    const primary = $('#modalLayer .modal-actions .primary');
    if (primary) primary.textContent = on ? '关闭温柔分享' : '开启温柔分享';
    toast(on ? '温柔分享已开启 ♡ 数据只保存在你本机' : '温柔分享已关闭', on ? 'ok' : 'warn');
  };
  const body = `
    <p>匿名科研数据用于理解生命周期事件与结构指标的分布。它完全可选，默认关闭，且只保存在本机浏览器。</p>
    <div class="switch-row"><span><b>记录匿名运行数据</b><br><span class="hint" style="margin:0">开启后记录下方字段；随时可关闭。</span></span>
      <button class="switch ${lib.consent ? 'on' : ''}" id="consentSwitch"></button></div>
    <div class="section-label">记录字段</div>
    <p class="hint" style="line-height:1.9">
      · 引擎类型与版本<br>
      · 生命周期事件类型与世代<br>
      · 结构指标：密度、熵、周期<br>
      · 会话事件计数
    </p>
    <div class="section-label">不记录</div>
    <p class="hint">音频、文本输入、账号、位置、设备指纹、IP。数据不会上传到服务器。</p>
    <div class="section-label">当前记录</div>
    <p>共 <b style="color:var(--text)">${summary.n}</b> 条匿名事件。${summary.n ? '可导出为 JSON 留存。' : ''}</p>`;
  const actions = [
    { label: '关闭', cls: 'ghost', onClick: closeModal },
    {
      label: '导出 JSON',
      cls: 'ghost',
      onClick: () => {
        downloadJSON(
          `commons-anonymous-${new Date().toISOString().slice(0, 10)}.json`,
          { version: 1, engine: `AL-${ENGINE_VERSION}`, exportedAt: new Date().toISOString(), events: lib.telemetry },
        );
        toast('温柔分享数据已导出 ✿');
      },
    },
  ];
  if (summary.n > 0) {
    actions.push({
      label: '清空记录',
      cls: 'ghost',
      onClick: () => {
        lib.telemetry = [];
        saveLibrary(lib);
        openResearchModal();
        toast('温柔分享记录已清空', 'warn');
      },
    });
  }
  actions.push({
    label: lib.consent ? '关闭匿名记录' : '开启匿名记录',
    cls: 'primary',
    onClick: () => setConsent(!lib.consent),
  });
  openModal({
    eyebrow: 'ANONYMOUS RESEARCH DATA',
    title: '匿名科研数据',
    body,
    actions,
  });
  const sw = $('#consentSwitch', $('#modalLayer'));
  sw?.addEventListener('click', () => setConsent(!lib.consent));
}

function updateResearchLabel() {
  const el = $('#researchLabel');
  const btn = $('#researchBtn');
  if (!el) return;
  el.textContent = state.lib.consent ? '匿名数据 · 开' : '匿名数据 · 关';
  const dot = btn.querySelector('.dot');
  if (dot) {
    dot.style.background = state.lib.consent ? 'var(--mint)' : 'var(--dim)';
    dot.style.boxShadow = state.lib.consent ? '0 0 8px var(--mint)' : 'none';
  }
}

/* ------------------------------------------------------------------ */
/* 研究 · 侧门：独立的可选页面，不进入个人主循环                       */
/* ------------------------------------------------------------------ */

function exportLocalDiscoveries() {
  const lb = loadLeaderboard();
  if (!lb.length) {
    toast('还没有可导出的发现，先去「看懂它」保存一个', 'warn');
    return;
  }
  downloadJSON(`commons-discoveries-${Date.now()}.json`, lb);
  toast('本地发现已导出', 1600);
}

/* ---- 研究关：真实实验目标 + 服务端复核 + 共享榜单 ---- */

const researchLab = { targets: null, loading: null, models: null, modelsLoading: null };

const PATTERN_LABELS = { spots: '斑点', stripes: '条纹', mixed: '混合', blank: '空场' };

function currentResearchTarget() {
  const sel = $('#researchTarget');
  if (!researchLab.targets?.length) return null;
  return researchLab.targets.find((t) => t.id === sel?.value) || researchLab.targets[0];
}

function drawResearchField(canvas, field, w, h) {
  if (!canvas || !field?.length) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = Math.max(0, Math.min(1, field[i] || 0));
    const c = Math.round(242 - v * 200);
    img.data[i * 4] = c;
    img.data[i * 4 + 1] = c;
    img.data[i * 4 + 2] = c;
    img.data[i * 4 + 3] = 255;
  }
  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  tmp.getContext('2d')?.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
}

function renderResearchTarget() {
  const t = currentResearchTarget();
  if (!t) return;
  drawResearchField($('#researchTargetCanvas'), t.field, t.w, t.h);
  const meta = $('#researchTargetMeta');
  if (meta) {
    const src = t.source
      ? `${esc(t.source.citation)}<br>${esc(t.source.license)} · ${esc(t.source.note || '')}`
      : '';
    const modelNote = t.model === 'lengyelEpstein'
      ? '<br>复核模型：Lengyel–Epstein（CIMA 同族）'
      : '';
    meta.innerHTML = `<b>${esc(t.label)}</b> · ${t.kind === 'real' ? '真实实验' : '文献校准'}<br>${src}<br>
      ρ ${(t.features.density * 100).toFixed(1)}% · A ${(t.features.anisotropy ?? 0).toFixed(2)} ·
      L_c ${t.features.period || '—'} · N ${Math.round((t.features.components ?? 0) * t.w * t.h)} ·
      P ${(t.features.perimeter ?? 0).toFixed(2)}
      ${t.calibration ? `<br>参考上限 ~${Number(t.calibration.bestScore).toFixed(1)} · ${esc(t.calibration.note || '')}` : ''}
      ${modelNote}`;
  }
  const le = $('#researchLEParams');
  const isLE = t.model === 'lengyelEpstein';
  if (le) {
    le.hidden = !isLE;
    if (isLE) {
      const d = t.leDefaults || { a: 8, b: 6, sigma: 0.6 };
      const ea = $('#researchLEA');
      const eb = $('#researchLEB');
      const es = $('#researchLESigma');
      if (ea) ea.value = String(d.a);
      if (eb) eb.value = String(d.b);
      if (es) es.value = String(d.sigma);
    }
  }
  const verify = $('#researchVerify');
  if (verify) verify.textContent = isLE ? '用这些参数复核' : '提交当前生命';
  const propose = $('#researchPropose');
  if (propose) propose.disabled = false;
}

function renderResearchBoard(items, target) {
  const host = $('#researchBoard');
  if (!host) return;
  const rows = (items || []).slice(0, 10).map((it) => `<div class="rb-row">
      <span class="rb-rank">#${it.rank}</span>
      <span>${esc(it.name || '匿名生命')}</span>
      <span class="rb-score">${Number(it.score).toFixed(1)}</span>
      <span class="rb-time">${new Date(it.at).toLocaleString('zh-CN', { hour12: false })}</span>
    </div>`).join('');
  host.innerHTML = `<div class="rb-head">共享榜单 · ${esc(target?.label || '全部目标')} · 仅显示前 10</div>
    ${rows || '<div class="rb-empty">还没有提交。成为第一个。</div>'}`;
}

async function loadResearchTargets() {
  const status = $('#researchLabStatus');
  try {
    const res = await fetch('/api/research/targets', { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data.targets) || !data.targets.length) throw new Error('目标包为空');
    researchLab.targets = data.targets;
    const sel = $('#researchTarget');
    if (sel) {
      sel.innerHTML = data.targets
        .map((t) => `<option value="${esc(t.id)}">${esc(t.label)}</option>`)
        .join('');
      sel.value = data.targets[0].id;
    }
    $('#researchVerify').disabled = false;
    const proposeBtn = $('#researchPropose');
    if (proposeBtn) proposeBtn.disabled = false;
    const exportBtn = $('#researchExportBoard');
    if (exportBtn) exportBtn.disabled = false;
    if (status) {
      status.textContent = '已连接研究服务。服务端会用确定性种子重跑反应—扩散（GS 480 步 / LE 12000 步），再按结构统计评分。';
      if (data.storage === 'persistent') {
        status.textContent += ' 榜单写入外部存储，实例重启不会清空。';
      } else if (data.storage === 'ephemeral') {
        status.textContent += ' 榜单暂存于当前运行实例，重启后会清空。';
      } else if (data.storage === 'configured' || data.storage === 'local') {
        status.textContent += ' 榜单写入可写的本地目录。';
      }
    }
    renderResearchTarget();
    loadResearchBoard();
  } catch (_) {
    researchLab.targets = null;
    const sel = $('#researchTarget');
    if (sel) sel.innerHTML = '<option value="">未连接</option>';
    const verify = $('#researchVerify');
    if (verify) verify.disabled = true;
    const proposeBtn = $('#researchPropose');
    if (proposeBtn) proposeBtn.disabled = true;
    const exportBtn = $('#researchExportBoard');
    if (exportBtn) exportBtn.disabled = true;
    if (status) {
      status.textContent = '未连接研究服务（当前为静态预览）。服务端复核与共享榜单需要 FunctionWeb 部署。';
    }
  }
}

async function loadResearchBoard() {
  const host = $('#researchBoard');
  if (!host) return;
  const target = currentResearchTarget();
  if (!target) return;
  try {
    const res = await fetch(`/api/research/leaderboard?targetId=${encodeURIComponent(target.id)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderResearchBoard(data.items, target);
  } catch (_) {
    host.innerHTML = '<div class="rb-empty">榜单暂不可用</div>';
  }
}

async function exportResearchBoard() {
  const target = currentResearchTarget();
  if (!target) return;
  try {
    const res = await fetch(`/api/research/leaderboard?targetId=${encodeURIComponent(target.id)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.items?.length) {
      toast('还没有可导出的榜单记录', 'warn');
      return;
    }
    downloadJSON(`commons-research-${target.id}-${Date.now()}.json`, {
      target: target.id,
      exportedAt: new Date().toISOString(),
      items: data.items,
    });
    toast('榜单已导出', 1600);
  } catch (err) {
    toast(`导出失败：${err.message}`, 'warn');
  }
}

function renderResearchResult(data) {
  const host = $('#researchResult');
  if (!host) return;
  const f = data.features || {};
  const tf = data.targetFeatures || {};
  const num = (v, digits = 2) => (Number.isFinite(v) ? Number(v).toFixed(digits) : '—');
  const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');
  const cells = [
    ['密度 ρ', pct(f.density), pct(tf.density)],
    ['各向异性 A', num(f.anisotropy), num(tf.anisotropy)],
    ['相关长度 L_c', String(f.period || '—'), String(tf.period || '—')],
    ['斑块数 N', String(Math.round((f.components ?? 0) * 4096)), Number.isFinite(tf.components) ? String(Math.round(tf.components * 4096)) : '—'],
    ['边界密度 P', num(f.perimeter), num(tf.perimeter)],
  ];
  const isReplicate = data.type === 'replicate' || typeof data.model === 'object';
  const modelLabel = typeof data.model === 'object' ? (data.model.short || data.model.label) : '';
  const b = data.behavior;
  const behaviorHTML = b ? `<div class="rr-behavior">
      <div class="rrb-head">行为指纹 · ${PATTERN_LABELS[b.pattern] || b.pattern || '—'}</div>
      <div class="rrb-grid">
        <span>稳定 ${b.stabilizeSteps} 步</span>
        <span>活跃度 ${num(b.activity, 3)}</span>
        <span>翻转率 ${num(b.flipRate, 3)}</span>
        <span>增长 ${num(b.growthRate, 1)} / 1000 步</span>
      </div>
    </div>` : '';
  const checksHTML = data.checks?.length ? `<div class="rr-checks">
      <div class="rrc-head">模型检查 · ${data.passed ? '全部通过' : '有未通过项'}</div>
      <div class="rrc-grid">
        ${data.checks.map((c) => {
          const actual = typeof c.actual === 'number'
            ? (Number.isInteger(c.actual) ? String(c.actual) : c.actual.toFixed(3))
            : String(c.actual);
          return `<span class="${c.ok ? 'ok' : 'warn'}">${esc(c.key)} ${c.ok ? '✓' : '✗'} <i>${esc(actual)}</i></span>`;
        }).join('')}
      </div>
    </div>` : '';
  host.hidden = false;
  host.innerHTML = `<div class="rr-top">
      <span class="rr-score">${Number(data.score).toFixed(1)}</span>
      <span class="rr-unit">/ 100 · 结构距离 ${Number(data.distance).toFixed(3)}</span>
    </div>
    <div class="rr-meta">
      ${isReplicate ? `模型复现 · ${esc(modelLabel)} · 服务端重跑 ${data.steps} 步` : `服务端重跑 ${data.steps} 步 · ${(data.modelType || data.model) === 'lengyelEpstein' ? 'LE 固定噪声种子' : data.usedFixedSeed ? '目标固定校准种子' : data.usedMask ? '使用你提交的种子' : '使用确定性默认种子'}`}
      ${data.rank ? ` · 本轮排名 #${data.rank}` : ''}
      ${data.persisted === false && !isReplicate ? ' · 榜单暂不可写' : ''}
    </div>
    <div class="rr-grid">
      ${cells.map(([label, a, b2]) => `<div class="rr-cell">${label}<b>${a}</b><i>目标 ${b2}</i></div>`).join('')}
    </div>
    ${behaviorHTML}
    ${checksHTML}`;
}

function renderModelLives(models) {
  const host = $('#researchModelLives');
  if (!host) return;
  if (!models?.length) {
    host.innerHTML = '<div class="hint">模型生命暂不可用。</div>';
    return;
  }
  host.innerHTML = models.map((m) => `<article class="model-card" data-model-id="${esc(m.id)}">
      <div class="mc-top">
        <span class="mc-engine">${esc(m.engine)}</span>
        <span class="mc-steps">${esc(String(m.steps))} 步</span>
      </div>
      <h4>${esc(m.short || m.label)}</h4>
      <p>${esc(m.description || '')}</p>
      <div class="mc-meta">
        <span>目标 · ${esc(m.target?.label || m.targetId)}</span>
        <span>种子 · ${esc(m.seedPolicy || '—')}</span>
        <span>预期 · ${esc(PATTERN_LABELS[m.expected?.pattern] || m.expected?.pattern || '—')}</span>
      </div>
      <div class="mc-invariants">${(m.invariants || []).slice(0, 2).map((x) => `<code>${esc(x)}</code>`).join('')}</div>
      <div class="mc-foot">
        <span class="mc-source">${esc(m.provenance?.license || '')}</span>
        <button class="mc-replicate" data-replicate="${esc(m.id)}">复现</button>
      </div>
    </article>`).join('');
}

async function loadModelLives() {
  const host = $('#researchModelLives');
  try {
    const res = await fetch('/api/research/model-lives', { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    researchLab.models = data.models || [];
    renderModelLives(researchLab.models);
  } catch (_) {
    researchLab.models = null;
    if (host) host.innerHTML = '<div class="hint">模型生命暂不可用（研究服务未连接）。</div>';
  }
}

async function replicateModel(modelId, btn) {
  const status = $('#researchLabStatus');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '复现中…';
  }
  if (status) status.textContent = '服务端按模型卡固定参数与种子重跑…';
  try {
    const res = await fetch('/api/research/replicate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId }),
    });
    const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    renderResearchResult(data);
    if (status) {
      status.textContent = data.passed
        ? `复现完成：${data.model.label} 的结构与行为检查全部通过。`
        : `复现完成：${data.model.label} 有检查项未通过，请看结果区。`;
    }
    toast(`复现 ${data.model.label} · ${data.score} 分`, data.passed ? 'ok' : 'warn');
  } catch (err) {
    if (status) status.textContent = `复现失败：${err.message}`;
    toast(`复现失败：${err.message}`, 'warn');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '复现';
    }
  }
}

function researchPayloadBase() {
  const g = state.recipe.seed.genome;
  const sci = g.scientific || {};
  return {
    name: state.recipe.seed.name,
    recipeId: state.recipe.id,
    engine: g.engine,
    f: Number.isFinite(sci.f) ? sci.f : REACTION_DIFFUSION_PRESETS.gs_spots.f,
    k: Number.isFinite(sci.k) ? sci.k : REACTION_DIFFUSION_PRESETS.gs_spots.k,
    D_u: Number.isFinite(sci.D_u) ? sci.D_u : PUZZLE_DU,
    D_v: Number.isFinite(sci.D_v) ? sci.D_v : PUZZLE_DV,
    dt: Number.isFinite(sci.dt) ? sci.dt : 1.0,
    a: parseFloat($('#researchLEA')?.value),
    b: parseFloat($('#researchLEB')?.value),
    sigma: parseFloat($('#researchLESigma')?.value),
    mask: Array.isArray(sci.mask) ? sci.mask : null,
    maskW: sci.maskW || 64,
    maskH: sci.maskH || 64,
  };
}

async function runResearchVerify(payload) {
  const target = currentResearchTarget();
  if (!target) {
    toast('先选择一个研究目标', 'warn');
    return;
  }
  const btn = $('#researchVerify');
  const status = $('#researchLabStatus');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '复核中…';
  }
  if (status) status.textContent = '服务端正在重跑反应—扩散…';
  try {
    const res = await fetch('/api/research/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, targetId: target.id }),
    });
    const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    renderResearchResult(data);
    renderResearchBoard(data.leaderboard, target);
    if (status) {
      status.textContent = data.persisted === false
        ? '复核完成，但榜单暂不可写（运行环境只读）。'
        : '复核完成，结果已写入共享榜单。';
    }
    toast(`研究关复核：${data.score} 分`, 'ok');
  } catch (err) {
    if (status) status.textContent = `复核失败：${err.message}`;
    toast(`复核失败：${err.message}`, 'warn');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '提交当前生命';
    }
  }
}

async function submitResearchVerification() {
  if (!currentResearchTarget()) {
    toast('先选择一个研究目标', 'warn');
    return;
  }
  await runResearchVerify(researchPayloadBase());
}

async function submitResearchCandidate(candidate) {
  if (!currentResearchTarget()) {
    toast('先选择一个研究目标', 'warn');
    return;
  }
  await runResearchVerify({
    ...researchPayloadBase(),
    useCalibrationSeed: true,
    mask: null,
    maskW: null,
    maskH: null,
    ...candidate,
  });
}

async function proposeResearchCandidates() {
  const target = currentResearchTarget();
  if (!target) {
    toast('先选择一个研究目标', 'warn');
    return;
  }
  const host = $('#researchProposals');
  const btn = $('#researchPropose');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '提议中…';
  }
  try {
    const res = await fetch(`/api/research/propose?targetId=${encodeURIComponent(target.id)}&limit=3`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.items?.length) {
      if (host) host.hidden = true;
      toast(data.note || '该目标暂无代理', 'warn');
      return;
    }
    if (host) {
      const metrics = data.metrics;
      const top3 = metrics?.poolRecall?.top3Hit ?? metrics?.top3Hit;
      const metricText = metrics
        ? ` · 留出集候选池 Top-3 ${Math.round((top3 || 0) * 100)}% · 分数 MAE ${Number(metrics.scoreMae).toFixed(1)}`
        : '';
      const head = data.engine === 'mlp-surrogate'
        ? `降阶神经代理（MLP · 签名级）· 非裁判${metricText}`
        : '响应面代理 · 固定校准种子 · 非裁判';
      host.hidden = false;
      host.innerHTML = `<div class="rp-head">${head} · 点击候选做服务端复核</div>
        ${data.items.map((it) => {
          const isLE = Number.isFinite(it.a);
          const attrs = isLE
            ? `data-a="${it.a}" data-b="${it.b}" data-sigma="${it.sigma}"`
            : `data-f="${it.f}" data-k="${it.k}"`;
          const label = isLE
            ? `a ${Number(it.a).toFixed(2)} · b ${Number(it.b).toFixed(2)} · σ ${Number(it.sigma).toFixed(2)}`
            : `f ${Number(it.f).toFixed(3)} · k ${Number(it.k).toFixed(3)}`;
          return `<button class="rp-item" ${attrs}>
            <span>${label}</span>
            <span class="rp-score">预测 ${Number(it.predictedScore).toFixed(1)}</span>
          </button>`;
        }).join('')}`;
    }
  } catch (err) {
    toast(`提议失败：${err.message}`, 'warn');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '代理提议';
    }
  }
}

async function initResearchView() {
  if (!researchLab.targets && !researchLab.loading) {
    researchLab.loading = loadResearchTargets().finally(() => {
      researchLab.loading = null;
    });
  }
  if (!researchLab.models && !researchLab.modelsLoading) {
    researchLab.modelsLoading = loadModelLives().finally(() => {
      researchLab.modelsLoading = null;
    });
  }
  if (researchLab.loading) await researchLab.loading;
  if (researchLab.modelsLoading) await researchLab.modelsLoading;
  if (researchLab.targets) {
    renderResearchTarget();
    loadResearchBoard();
  }
}

function downloadJSON(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ------------------------------------------------------------------ */
/* Navigation & bindings                                              */
/* ------------------------------------------------------------------ */

function switchView(view) {
  const prev = state.view;
  state.view = view;
  const navKey = view === 'compare' ? 'cultivate' : view === 'research' ? 'commons' : view;
  for (const btn of $$('#nav button')) btn.classList.toggle('active', btn.dataset.view === navKey);
  for (const v of ['cultivate', 'commons', 'compare', 'puzzle', 'lineage', 'research']) {
    $(`#view-${v}`)?.classList.toggle('active', v === view);
  }
  if (prev === 'puzzle' && view !== 'puzzle') puzzleView.deactivate();
  if (view === 'commons') renderCommons();
  if (view === 'compare') openCompare();
  if (view === 'puzzle') puzzleView.activate();
  if (view === 'research') initResearchView();
  if (view === 'lineage') lineageView.render();
  syncAudioForView();
  updateCompareAudioButton();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function bindUI() {
  for (const btn of $$('[data-view]')) {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  }
  $('#audioBtn').addEventListener('click', () => setAudio(!state.audioOn));
  $('#researchBtn').addEventListener('click', openResearchModal);
  $('#openCompare')?.addEventListener('click', () => switchView('compare'));
  $('#compareBack')?.addEventListener('click', () => switchView('cultivate'));

  $('#playBtn').addEventListener('click', () => {
    state.playing = !state.playing;
    $('#playBtn').textContent = state.playing ? '暂停' : '继续';
  });
  $('#stepBtn').addEventListener('click', () => {
    state.playing = false;
    $('#playBtn').textContent = '继续';
    stepMain();
    refreshMainMetrics();
  });
  $('#speedRange').addEventListener('input', (e) => {
    state.speed = parseFloat(e.target.value);
    $('#speedVal').textContent = `${state.speed.toFixed(2).replace(/0$/, '')}×`;
  });

  /* ---- 右侧控制台：滑动指示块 + 方向切页 + 键盘操作 ---- */
  const railTabsEl = $('#railTabs');
  const railInk = $('.rail-ink', railTabsEl);
  railTabsEl.setAttribute('role', 'tablist');
  $$('#railTabs button').forEach((b) => {
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(b.classList.contains('active')));
  });
  const moveRailInk = (btn, animate = true) => {
    if (!railInk || !btn) return;
    if (!animate) railInk.style.transition = 'none';
    railInk.style.width = `${btn.offsetWidth}px`;
    railInk.style.transform = `translateX(${btn.offsetLeft}px)`;
    if (!animate) {
      void railInk.offsetWidth;
      railInk.style.transition = '';
    }
  };
  const isCompactLayout = () => window.matchMedia('(max-width: 1180px)').matches;
  /* 手机上切页后，若标签栏已被滚出视口，把它带回顶部，避免内容高度变化造成跳页 */
  const keepRailInView = () => {
    if (!isCompactLayout()) return;
    const topbar = $('.topbar');
    const offset = (topbar?.offsetHeight || 0) + 8;
    const y = railTabsEl.getBoundingClientRect().top + window.scrollY - offset;
    if (window.scrollY > y + 2) window.scrollTo({ top: y, behavior: 'smooth' });
  };
  const activateRailTab = (btn) => {
    if (!btn || btn.classList.contains('active')) return;
    const tabs = $$('#railTabs button');
    const oldIdx = tabs.findIndex((b) => b.classList.contains('active'));
    const newIdx = tabs.indexOf(btn);
    const dir = newIdx >= oldIdx ? 1 : -1;
    moveRailInk(btn, true);
    for (const b of tabs) {
      const on = b === btn;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    }
    for (const p of $$('.panel')) {
      const on = p.id === `panel-${btn.dataset.tab}`;
      p.classList.toggle('active', on);
      p.classList.remove('panel-enter-left', 'panel-enter-right');
      if (on) p.classList.add(dir > 0 ? 'panel-enter-right' : 'panel-enter-left');
    }
    const railBody = $('.rail-body');
    if (railBody && railBody.scrollTop > 0) railBody.scrollTo({ top: 0, behavior: 'smooth' });
    keepRailInView();
    if (btn.dataset.tab === 'struct') updateStructValues();
    if (btn.dataset.tab === 'science') sciencePanel.render();
  };
  railTabsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (btn) activateRailTab(btn);
  });
  railTabsEl.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const tabs = $$('#railTabs button');
    let i = tabs.indexOf(document.activeElement);
    if (i < 0) i = tabs.findIndex((b) => b.classList.contains('active'));
    if (i < 0) return;
    e.preventDefault();
    let n = i;
    if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'ArrowRight') n = (i + 1) % tabs.length;
    else if (e.key === 'Home') n = 0;
    else n = tabs.length - 1;
    tabs[n].focus();
    activateRailTab(tabs[n]);
  });
  /* 首帧定位指示块（避免从 0 滑入），字体/窗口变化后重新对齐 */
  const initRailInk = () => moveRailInk(railTabsEl.querySelector('button.active'), false);
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(initRailInk);
  else initRailInk();
  if (document.fonts?.ready) document.fonts.ready.then(initRailInk).catch(() => {});
  let railInkRaf = 0;
  window.addEventListener('resize', () => {
    if (typeof requestAnimationFrame !== 'function') return;
    if (railInkRaf) return;
    railInkRaf = requestAnimationFrame(() => {
      railInkRaf = 0;
      moveRailInk(railTabsEl.querySelector('button.active'), false);
    });
  });

  /* ---- 滑杆：实时填充 + 拖动气泡 + 抓取反馈 ---- */
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (!el || el.type !== 'range') return;
    syncRangeFill(el);
    if (typeof requestAnimationFrame !== 'function') return;
    /* 等面板自己的 input 处理器更新完 .val 文本，再更新拖动气泡 */
    requestAnimationFrame(() => {
      if (el.classList.contains('dragging')) moveRangeBubble(el);
    });
  }, true);
  document.addEventListener('pointerdown', (e) => {
    if (e.target && e.target.type === 'range') beginRangeDrag(e.target, e);
  }, true);
  document.addEventListener('pointermove', (e) => {
    if (_rangeDrag) handleRangeMove(e);
  }, true);
  document.addEventListener('pointerup', endRangeDrag, true);
  document.addEventListener('pointercancel', endRangeDrag, true);
  window.addEventListener('blur', endRangeDrag);
  const rangeObserver = typeof MutationObserver === 'function'
    ? new MutationObserver(() => syncRanges())
    : null;
  for (const node of $$('.panel').concat([$('#modalLayer'), $('#view-puzzle')])) {
    if (node && rangeObserver) rangeObserver.observe(node, { childList: true, subtree: true });
  }
  syncRanges();

  $('#panel-rule').addEventListener('click', onRuleClick);
  $('#panel-rule').addEventListener('input', onRuleInput);
  $('#panel-sound').addEventListener('click', onSoundClick);
  $('#panel-sound').addEventListener('input', onSoundInput);
  $('#panel-sound').addEventListener('change', onSoundChange);
  $('#panel-sound').addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest?.('.mixer-summary')) {
      e.preventDefault();
      openMixerModal();
    }
  });
  $('#panel-env').addEventListener('click', onEnvClick);
  $('#panel-env').addEventListener('input', onEnvInput);
  /* 极端环境徽标在舞台上，不在环境面板内，需要单独绑定取消事件；
   * 同时阻止冒泡，避免点 × 时触发舞台的“开始聆听”。 */
  $('#exoticPill')?.addEventListener('click', (e) => {
    if (!e.target.closest('[data-exotic-cancel]')) return;
    e.stopPropagation();
    onEnvClick(e);
  });

  $('#stageHost').addEventListener('click', () => {
    if (!state.audioOn) {
      setAudio(true);
      toast('♪ 聆听开始啦');
    }
  });

  $('#commonsHatch').addEventListener('click', () => hatchRandom());
  $('#commonsSearch').addEventListener('input', renderCommons);
  $('#commonsSort').addEventListener('change', renderCommons);
  $('#commonsGrid').addEventListener('click', onCommonsClick);
  $('#envGallery').addEventListener('click', (e) => {
    const apply = e.target.closest('[data-env-apply]');
    if (apply) return applyEnvPreset(apply.dataset.envApply, 'apply');
    const hatch = e.target.closest('[data-env-hatch]');
    if (hatch) return applyEnvPreset(hatch.dataset.envHatch, 'hatch');
    const share = e.target.closest('[data-env-share]');
    if (share) return applyEnvPreset(share.dataset.envShare, 'share');
  });
  $('#clearLocal').addEventListener('click', openClearModal);
  $('#researchDoor')?.addEventListener('click', () => switchView('research'));
  $('#researchBack')?.addEventListener('click', () => switchView('commons'));
  $('#researchEnterSci')?.addEventListener('click', () => {
    switchView('cultivate');
    requestAnimationFrame(() => {
      $('#railTabs [data-tab="science"]')?.click();
    });
  });
  $('#researchExport')?.addEventListener('click', exportLocalDiscoveries);
  $('#researchVerify')?.addEventListener('click', submitResearchVerification);
  $('#researchPropose')?.addEventListener('click', proposeResearchCandidates);
  $('#researchModelLives')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-replicate]');
    if (!btn) return;
    replicateModel(btn.dataset.replicate, btn);
  });
  $('#researchProposals')?.addEventListener('click', (e) => {
    const item = e.target.closest('.rp-item');
    if (!item) return;
    if (item.dataset.a) {
      submitResearchCandidate({
        a: parseFloat(item.dataset.a),
        b: parseFloat(item.dataset.b),
        sigma: parseFloat(item.dataset.sigma),
        D_v: 80,
        dt: 0.001,
      });
      return;
    }
    submitResearchCandidate({
      f: parseFloat(item.dataset.f),
      k: parseFloat(item.dataset.k),
      useCalibrationSeed: true,
    });
  });
  $('#researchExportBoard')?.addEventListener('click', exportResearchBoard);
  $('#researchTarget')?.addEventListener('change', () => {
    const proposals = $('#researchProposals');
    if (proposals) proposals.hidden = true;
    const result = $('#researchResult');
    if (result) result.hidden = true;
    renderResearchTarget();
    loadResearchBoard();
  });

  $('#compareMode').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mode]');
    if (!btn) return;
    const c = state.compare;
    c.mode = btn.dataset.mode;
    if (c.mode === 'env' && c.envKeys.b === c.envKeys.a) {
      c.envKeys.b = c.envKeys.a === 'low-constraint' ? 'feed' : 'low-constraint';
    }
    if (c.mode === 'seed' && c.keys.b === c.keys.a) {
      const alt = compareSeedPool().find((p) => p.key !== c.keys.a);
      if (alt) c.keys.b = alt.key;
    }
    $$('#compareMode button').forEach((b) => b.classList.toggle('active', b === btn));
    applyCompareMode();
    rebuildCompare();
  });
  for (const id of ['compareSeedA', 'compareSeedB', 'compareEnvA', 'compareEnvB']) {
    $(`#${id}`).addEventListener('change', () => {
      const c = state.compare;
      c.keys.a = $('#compareSeedA').value;
      c.keys.b = $('#compareSeedB').value;
      c.envKeys.a = $('#compareEnvA').value;
      c.envKeys.b = $('#compareEnvB').value;
      applyCompareMode();
      rebuildCompare();
    });
  }
  $('#compareAudio').addEventListener('click', () => setAudio(!state.audioOn));
  $('#comparePlay').addEventListener('click', () => {
    state.compare.playing = !state.compare.playing;
    $('#comparePlay').textContent = state.compare.playing ? '暂停' : '继续';
  });
  $('#lineageHybrid').addEventListener('click', () => openHybridModal());

  // global action delegation for buttons rendered into panels
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'hatch') hatchRandom();
    else if (action === 'mutate') mutateCurrent();
    else if (action === 'save') openSaveModal();
    else if (action === 'share') openShareModal();
    else if (action === 'hybrid') openHybridModal();
    else if (action === 'reseed' || action === 'reseed-env') reseed();
    else if (action === 'listen') {
      if (!state.audioOn) setAudio(true);
      ensureAudio();
      state.audio?.triggerEvent('periodic', 1);
      toast('听听生命的小脚印 ♪');
    } else if (action === 'open-mixer') openMixerModal();
    else if (action === 'export-wav') exportMixdown();
    else if (action === 'goto-compare') switchView('compare');
    else if (action === 'goto-commons') switchView('commons');
    else if (action === 'blind') toggleBlind();
    else if (action === 'motion') toggleMotion();
  });

  $('#introListen').addEventListener('click', () => {
    state.lib.seenIntro = true;
    saveLibrary(state.lib);
    $('#intro').classList.add('hidden');
    setAudio(true);
    toast('欢迎来到小心心花园 ♡ 先听，再看。');
  });
  $('#introSilent').addEventListener('click', () => {
    state.lib.seenIntro = true;
    saveLibrary(state.lib);
    $('#intro').classList.add('hidden');
  });

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && typeof t.matches === 'function' && t.matches('input, textarea, select')) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (state.view === 'compare') {
        state.compare.playing = !state.compare.playing;
        $('#comparePlay').textContent = state.compare.playing ? '暂停' : '继续';
      } else {
        state.playing = !state.playing;
        $('#playBtn').textContent = state.playing ? '暂停' : '继续';
      }
    } else if (e.key === 'r' || e.key === 'R') {
      hatchRandom();
    } else if (e.key === 'Escape') {
      closeModal();
    }
  });

  $('#modalLayer').addEventListener('click', (e) => {
    if (e.target.id === 'modalLayer') closeModal();
  });
}

/* ------------------------------------------------------------------ */
/* Panel handlers                                                     */
/* ------------------------------------------------------------------ */

function markGenomeChanged() {
  state.recipe.metrics = null;
  state.forceMetrics = true;
  if (state.audio) state.audio.setGenome(state.recipe.seed.genome);
}

function onRuleClick(e) {
  const engineBtn = e.target.closest('[data-engine]');
  if (engineBtn) {
    const engine = engineBtn.dataset.engine;
    if (engine !== state.recipe.seed.genome.engine) {
      state.recipe.seed.genome.engine = engine;
      if (engine === 'life' && !state.recipe.seed.genome.life.preset) state.recipe.seed.genome.life.preset = 'conway';
      if (engine === 'lenia' && !state.recipe.seed.genome.lenia.preset) state.recipe.seed.genome.lenia.preset = 'bloom';
      if (engine === 'scientific') {
        // 切到科学引擎时初始化默认 Gray-Scott 斑点
        const sci = state.recipe.seed.genome.scientific = state.recipe.seed.genome.scientific || {};
        if (!sci.preset || sci.preset === 'custom') {
          const def = REACTION_DIFFUSION_PRESETS.gs_spots;
          sci.preset = 'gs_spots'; sci.engineType = def.engine;
          sci.D_u = def.D_u; sci.D_v = def.D_v; sci.f = def.f; sci.k = def.k; sci.dt = def.dt;
        }
      }
      rebuildSim();
      renderRulePanel();
      renderStructPanel();
      updateStructValues();
      toast(`已切换到 ${ENGINE_LABEL[engine]}，按同一配方重新孵化`);
    }
    return;
  }
  const lifePreset = e.target.closest('[data-life-preset]');
  if (lifePreset) {
    applyLifePreset(state.recipe.seed.genome, lifePreset.dataset.lifePreset);
    state.sim.applyGenome(state.recipe.seed.genome);
    markGenomeChanged();
    renderRulePanel();
    refreshMainMetrics();
    toast(`规则：${LIFE_PRESETS[lifePreset.dataset.lifePreset].label}`);
    return;
  }
  const leniaPreset = e.target.closest('[data-lenia-preset]');
  if (leniaPreset) {
    applyLeniaPreset(state.recipe.seed.genome, leniaPreset.dataset.leniaPreset);
    state.sim.applyGenome(state.recipe.seed.genome);
    markGenomeChanged();
    renderRulePanel();
    refreshMainMetrics();
    toast(`规则：${LENIA_PRESETS[leniaPreset.dataset.leniaPreset].label}`);
    return;
  }
  const sciPreset = e.target.closest('[data-sci-preset]');
  if (sciPreset) {
    const key = sciPreset.dataset.sciPreset;
    const p = REACTION_DIFFUSION_PRESETS[key];
    if (!state.recipe.seed.genome.scientific) state.recipe.seed.genome.scientific = {};
    // 把所有参数都写入 genome.scientific，让 UI 和引擎用同一套值
    const sci = state.recipe.seed.genome.scientific;
    sci.preset = key;
    sci.engineType = p.engine;
    sci.D_u = p.D_u; sci.D_v = p.D_v; sci.dt = p.dt;
    if (p.f !== undefined) sci.f = p.f;
    if (p.k !== undefined) sci.k = p.k;
    if (p.a !== undefined) sci.a = p.a;
    if (p.b !== undefined) sci.b = p.b;
    if (p.c !== undefined) sci.c = p.c;
    if (p.sigma !== undefined) sci.sigma = p.sigma;
    if (p.A !== undefined) sci.A = p.A;
    if (p.B !== undefined) sci.B = p.B;
    state.sim.applyGenome(state.recipe.seed.genome);
    markGenomeChanged();
    renderRulePanel();
    refreshMainMetrics();
    toast(`科学引擎：${p.label}（${p.engine}）`);
    return;
  }
  const sciType = e.target.closest('[data-sci-type]');
  if (sciType) {
    const t = sciType.dataset.sciType;
    if (!state.recipe.seed.genome.scientific) state.recipe.seed.genome.scientific = {};
    state.recipe.seed.genome.scientific.engineType = t;
    state.sim.applyGenome(state.recipe.seed.genome);
    state.sim.reset();
    markGenomeChanged();
    renderRulePanel();
    refreshMainMetrics();
    toast(`切换到 ${t}`);
    return;
  }

  /* ---- 玩家驱动的科学工具按钮 ---- */
  const sciAction = e.target.closest('[data-sci-action]');
  if (sciAction) {
    handleSciAction(sciAction.dataset.sciAction);
    return;
  }
  const birth = e.target.closest('[data-birth]');
  if (birth) {
    const n = parseInt(birth.dataset.birth, 10);
    const set = new Set(state.recipe.seed.genome.life.birth);
    if (set.has(n)) set.delete(n);
    else set.add(n);
    state.recipe.seed.genome.life.birth = Array.from(set).sort((a, b) => a - b);
    state.recipe.seed.genome.life.preset = 'custom';
    state.sim.applyGenome(state.recipe.seed.genome);
    birth.classList.toggle('on');
    markGenomeChanged();
    refreshMainMetrics();
    return;
  }
  const survive = e.target.closest('[data-survive]');
  if (survive) {
    const n = parseInt(survive.dataset.survive, 10);
    const set = new Set(state.recipe.seed.genome.life.survive);
    if (set.has(n)) set.delete(n);
    else set.add(n);
    state.recipe.seed.genome.life.survive = Array.from(set).sort((a, b) => a - b);
    state.recipe.seed.genome.life.preset = 'custom';
    state.sim.applyGenome(state.recipe.seed.genome);
    survive.classList.toggle('on');
    markGenomeChanged();
    refreshMainMetrics();
    return;
  }
  const nb = e.target.closest('[data-neighborhood]');
  if (nb) {
    state.recipe.seed.genome.life.neighborhood = parseInt(nb.dataset.neighborhood, 10);
    state.sim.applyGenome(state.recipe.seed.genome);
    renderRulePanel();
    markGenomeChanged();
    refreshMainMetrics();
  }
}

function onRuleInput(e) {
  const leniaKey = e.target.dataset.leniaParam;
  const sciKey = e.target.dataset.sciParam;
  const v = parseFloat(e.target.value);
  const g = state.recipe.seed.genome;

  if (sciKey) {
    // 科学引擎物理参数热更新（每帧仿真就用新值，不需要 reset）
    if (!g.scientific) g.scientific = {};
    // ① JEPA：记录调参前的形态（debounce 起点）
    const wasSciCustom = g.scientific.preset === 'custom';
    g.scientific[sciKey] = v;
    g.scientific.preset = 'custom';
    state.sim.applyGenome(g);
    markGenomeChanged();
    const head = e.target.closest('.field')?.querySelector('.val');
    if (head) head.textContent = v.toFixed(sciKey === 'dt' ? 2 : 3);
    refreshMainMetrics();

    // ② JEPA 直觉训练：debounced — 停 180ms 后跑 K=20 步算形态变化
    const j = state.jepa;
    if (j.trainingOn && state.recipe.seed.genome.engine === 'scientific') {
      if (!j.pendingDebounce) {
        j.embBefore = state.metrics ? toMorphoEmbedding(state.metrics) : null;
        j.paramChangePending = { [sciKey]: v };
      }
      if (j.pendingDebounce) clearTimeout(j.pendingDebounce);
      j.pendingDebounce = setTimeout(() => {
        j.pendingDebounce = null;
        debouncedJepaFeedback(sciKey, v, g);
      }, 180);
    }
    return;
  }

  if (leniaKey) {
    if (leniaKey === 'radius') g.lenia.radius = Math.round(v);
    else g.lenia[leniaKey] = v;
    g.lenia.preset = 'custom';
    state.sim.applyGenome(g);
    markGenomeChanged();
    const head = e.target.closest('.field')?.querySelector('.val');
    if (head) head.textContent = leniaKey === 'radius' ? String(g.lenia.radius) : v.toFixed(leniaKey === 'dt' ? 2 : 3);
    refreshMainMetrics();
  }
}

function onSoundClick(e) {
  const scale = e.target.closest('[data-scale]');
  if (scale) {
    state.recipe.seed.genome.mapping.scale = scale.dataset.scale;
    markGenomeChanged();
    renderSoundPanel();
    if (state.audio) state.audio.setGenome(state.recipe.seed.genome);
    toast(`音阶：${SCALES[scale.dataset.scale].label}`);
    return;
  }
  const wave = e.target.closest('[data-wave]');
  if (wave) {
    state.recipe.seed.genome.mapping.wave = wave.dataset.wave;
    markGenomeChanged();
    renderSoundPanel();
    if (state.audio) state.audio.setGenome(state.recipe.seed.genome);
    return;
  }
  const toggle = e.target.closest('[data-map-toggle]');
  if (toggle) {
    const key = toggle.dataset.mapToggle;
    const m = state.recipe.seed.genome.mapping;
    m[key] = !m[key];
    toggle.classList.toggle('on', m[key]);
    markGenomeChanged();
    if (state.audio) state.audio.setGenome(state.recipe.seed.genome);
  }
}

function onSoundInput(e) {
  const key = e.target.dataset.mapParam;
  if (!key) return;
  const v = parseFloat(e.target.value) / 100;
  const m = state.recipe.seed.genome.mapping;
  m[key] = v;
  markGenomeChanged();
  const head = e.target.closest('.field')?.querySelector('.val');
  if (head) head.textContent = `${Math.round(v * 100)}%`;
  if (state.audio) {
    state.audio.setGenome(state.recipe.seed.genome);
    if (state.metrics) state.audio.updateMetrics(state.metrics);
  }
}

function onSoundChange(e) {
  const instSel = e.target.closest('[data-instrument-select]');
  if (instSel) {
    const part = instSel.dataset.instrumentSelect;
    const mapping = state.recipe.seed.genome.mapping;
    if (!mapping.instruments) mapping.instruments = { ...DEFAULT_INSTRUMENTS };
    mapping.instruments[part] = instSel.value;
    markGenomeChanged();
    renderSoundPanel();
    if (state.audio) state.audio.setGenome(state.recipe.seed.genome);
    const p = INSTRUMENT_PARTS.find((x) => x.key === part);
    toast(`${p?.label ?? part}：${INSTRUMENT_VOICE_LABELS[instSel.value] || instSel.value}`, 1200);
    return;
  }
  const key = e.target.dataset.mapSelect;
  if (!key) return;
  const m = state.recipe.seed.genome.mapping;
  m[key] = key === 'root' ? parseInt(e.target.value, 10) : e.target.value;
  markGenomeChanged();
  renderSoundPanel();
  if (state.audio) state.audio.setGenome(state.recipe.seed.genome);
}

/* 当前生命真正使用的反应-扩散子类型。
 * 优先读运行中的 RD 参数，避免 scientific 预设只存了 preset 时被误判成非科学引擎。 */
function currentScienceEngineType() {
  const sim = state.sim;
  if (sim?.kind === 'reaction-diffusion' && sim._rd?.params?.engine) {
    return sim._rd.params.engine;
  }
  const sci = state.recipe.seed.genome.scientific || {};
  if (sci.engineType) return sci.engineType;
  const preset = sci.preset && REACTION_DIFFUSION_PRESETS[sci.preset];
  return preset?.engine || state.recipe.seed.genome.engine;
}

/* 把当前极端环境的物理参数注入（或重新注入）到运行中的引擎。
 * 新引擎/新生命创建后 `_physics` 是空的，必须在创建后调用一次。 */
function injectExoticPhysics() {
  if (!state.exoticEnvId || !state.sim?.setPhysics) return;
  state.recipe.env._exoticId = state.exoticEnvId;
  const physicsObj = applyExoticPhysics(
    state.recipe.env,
    currentScienceEngineType(),
    state.sim.w,
    state.sim.h,
  );
  if (physicsObj && !physicsObj._nonScientific) state.sim.setPhysics(physicsObj);
}

/* 退出极端环境：恢复进入前的环境快照（没有快照时回代码默认值），
 * 并清掉注入物理，避免 slider 数值仍停留在极端预设。 */
function restoreNormalEnv() {
  const restore = state.preExoticEnv ? deepClone(state.preExoticEnv) : defaultEnv();
  delete restore._exoticId;
  state.exoticEnvId = null;
  state.preExoticEnv = null;
  if (state.sim.clearPhysics) state.sim.clearPhysics();
  state.recipe.env = restore;
  state.sim.setEnv(state.recipe.env);
  state.sim.reset();
  state.pet.state = new PetState();
  state.lastPetMood = null;
  afterEnvReset();
  renderEnvPanel();
  renderPetHUD();
  refreshMainMetrics();
}

function onEnvClick(e) {
  /* ---- 🌌 极端环境一键切换 ---- */
  const exotic = e.target.closest('[data-exotic]');
  if (exotic) {
    const id = exotic.dataset.exotic;
    const target = EXOTIC_ENVIRONMENTS.find(x => x.id === id);
    if (!target) return;
    /* 首次进入极端环境时保存原环境；极端环境之间切换则保留最初的快照 */
    if (!state.exoticEnvId) state.preExoticEnv = deepClone(state.recipe.env);
    // 深拷贝 env（避免 defaultEnv 共享引用）
    const newEnv = defaultEnv(target.env);
    newEnv._exoticId = id;  // 打上极端环境标记
    // 保持当前 pattern 不变（除非你想完全切），这里用极端预设的 pattern
    state.recipe.env = newEnv;
    state.sim.setEnv(newEnv);
    state.sim.reset();

    /* ===== 物理注入：physics.js → ScientificEngine._physics → step() 真实扩散/反应 ===== */
    const physicsObj = applyExoticPhysics(
      newEnv,
      currentScienceEngineType(),
      state.sim.w,
      state.sim.h
    );
    if (physicsObj?._nonScientific) {
      /* 🔴 Attention 审计修复：非科学引擎收到明确降级标记 → toast 提示用户 */
      toast(`⚠️ 此引擎是 ${state.recipe.seed.engine} 系，极端物理参数仅作用于科学引擎（反应-扩散）。环境 slider 已生效。`, 3200, 'warn');
    } else if (physicsObj && state.sim.setPhysics) {
      state.sim.setPhysics(physicsObj);
    }

    state.exoticEnvId = id;
    afterEnvReset();
    renderEnvPanel();
    renderPetHUD();
    toast(`${target.emoji} 切到「${target.label}」· ${target.desc}`, 2600);
    return;
  }
  /* ---- 极端环境右上角取消 ---- */
  const cancelExotic = e.target.closest('[data-exotic-cancel]');
  if (cancelExotic) {
    restoreNormalEnv();
    toast('♡ 已切回普通环境 · 物理清零 · 重新播种');
    return;
  }

  /* ---- 邻域类型（Conway 系）：控制渲染在环境面板里，事件也必须在这里处理 ---- */
  const neighborhood = e.target.closest('[data-neighborhood]');
  if (neighborhood) {
    const nb = neighborhood.dataset.neighborhood;
    state.recipe.seed.genome.life.neighborhood = parseInt(nb, 10);
    state.sim.applyGenome(state.recipe.seed.genome);
    markGenomeChanged();
    renderRulePanel();
    renderEnvPanel();
    refreshMainMetrics();
    toast(`邻域：${NEIGHBORHOODS[nb]?.label || nb}`);
    return;
  }

  const pattern = e.target.closest('[data-pattern]');
  if (pattern) {
    state.recipe.env.pattern = pattern.dataset.pattern;
    /* 挑战产出的生命带有自定义种子 mask；用户主动换初始形态时，
     * mask 会让“初始形态”按钮看起来失效，所以这里显式清掉。 */
    const sci = state.recipe.seed.genome.scientific;
    if (sci?.mask) {
      delete sci.mask;
      delete sci.maskW;
      delete sci.maskH;
      state.sim.applyGenome?.(state.recipe.seed.genome);
      markGenomeChanged();
    }
    state.sim.setEnv(state.recipe.env);
    state.sim.reset();
    afterEnvReset();
    renderEnvPanel();
    toast(`初始形态：${PATTERNS[pattern.dataset.pattern].label}`);
    return;
  }
  const boundary = e.target.closest('[data-boundary]');
  if (boundary) {
    state.recipe.env.boundary = boundary.dataset.boundary;
    state.sim.setEnv(state.recipe.env);
    state.sim.reset();
    afterEnvReset();
    renderEnvPanel();
    toast(`边界：${BOUNDARY_LABEL[boundary.dataset.boundary]}`);
  }
}

/* ================================================================ */
/*  科学工具：玩家驱动的科研能力                                     */
/* ================================================================ */
/* ================================================================ */
/*  Commons-JEPA 直觉训练：debounced 反馈                             */
/*                                                                  */
/*  玩家调科学引擎参数 → 等 180ms → 跑 K=30 步 → 算形态变化            */
/*  → jepaSoundFeedback → 调 audio tension/reverb → 训练直觉          */
/* ================================================================ */
function debouncedJepaFeedback(paramKey, newValue, genome) {
  const sim = state.sim;
  if (!sim || !sim.step) return;

  // ① 保存当前仿真状态（不 reset，不打断玩家的演化流）
  // 直接在热更新后的新参数下跑 K=30 步到"半稳定"
  const K = 30;
  for (let i = 0; i < K; i++) sim.step();

  // ② 算参数变化后的形态嵌入
  const afterMetrics = sim.metrics();
  const embAfter = toMorphoEmbedding(afterMetrics);

  const j = state.jepa;
  const embBefore = j.embBefore;
  if (!embBefore) { j.embBefore = embAfter; return; }

  // ③ 让 PlayerPredictor 学习这条经验
  const dParams = j.paramChangePending || { [paramKey]: newValue };
  j.predictor.record({
    dParams,
    embBefore: embBefore.slice(),
    embAfter: embAfter.slice(),
  });

  // ④ JEPA predictor 预测（如果历史够）
  const predicted = j.predictor.predict(dParams, embBefore);

  // ⑤ 计算预测误差（如果有）
  let predictionError = null;
  if (predicted) {
    // 玩家直觉是否和历史上类似调参的实际变化一致？
    predictionError = morphoDistance(embAfter, predicted);
  }

  // ⑥ 生成声音反馈 tension + reverb 实时调
  const feedback = jepaSoundFeedback(embBefore, embAfter);

  // ⑦ 应用到 audio.js（如果有）
  if (state.audio && state.audio.built && state.audio.enabled) {
    // tension → 实时调 brightness / drone filter center
    const now = state.audio.ctx.currentTime;
    const droneFilter = state.audio.droneFilter;
    if (droneFilter && droneFilter.frequency) {
      // tension 高 → 频率往下拉（紧张/不协和）
      const tensionShift = feedback.tension * 120;  // 最高 -120Hz
      droneFilter.frequency.setTargetAtTime(
        Math.max(120, droneFilter.frequency.value - tensionShift + feedback.freq - 260),
        now, 0.15
      );
    }
    // reverb 模拟：delayWet
    if (state.audio.delayWet && state.audio.delayWet.gain) {
      state.audio.delayWet.gain.setTargetAtTime(feedback.reverbMix * 0.4, now, 0.12);
    }
    // 加一个短音事件（玩家调参数 → 发出一个音）
    state.audio.emitEvent?.({ type: 'jepa', ...feedback });
  }

  // ⑧ 控制台打印（玩家可以 F12 看自己的直觉训练数据）
  const d = feedback.shiftMagnitude;
  const label = (() => {
    if (!feedback.meaningful) return '形态基本稳定（没变化）';
    const tags = feedback.directionTags;
    const parts = [];
    if (tags.λ_up)   parts.push('更混沌 λ↑');
    if (tags.λ_down) parts.push('更稳定 λ↓');
    if (tags.D_up)   parts.push('更复杂 D↑');
    if (tags.D_down) parts.push('更简单 D↓');
    if (tags.E_up)   parts.push('更活跃 E↑');
    if (tags.E_down) parts.push('更松弛 E↓');
    return parts.join(' + ') || '小幅抖动';
  })();


  // ⑨ toast 给玩家反馈（简洁，不刷屏）
  const icon = !feedback.meaningful ? '·' : (predictionError !== null && predictionError < 0.15 ? '✓' : '→');
  toast(`JEPA ${icon} ${label}（d=${d.toFixed(2)}，历史 ${j.predictor.size} 条）`);

  // ⑩ 更新 state.metrics（让 HUD 也同步）
  state.metrics = afterMetrics;
  state.jepa.embBefore = null;
  state.jepa.paramChangePending = null;
}

function handleSciAction(action) {
  if (action === 'mc' && runPlayerMC) {
    toast('🧬 让 CPM 来调一下...');
    const mc = runPlayerMC(state.sim, 4, { temperature: 0.2, nTypes: 6 });
    const deltaStr = mc.energyDelta < 0 ? `✓ 能量下降 ${(-mc.energyDelta).toFixed(0)}` : `ΔE=${mc.energyDelta.toFixed(0)}`;
    toast(`CPM MC 完成：接受率 ${(mc.acceptedRate*100).toFixed(1)}% | ${deltaStr}`);
    state.sciMCResult = mc;
    return;
  }
  if (action === 'match' && matchPatternLibrary) {
    const m = metricsFor(state.sim);
    const matches = matchPatternLibrary(m);
    state.sciMatches = matches;
    toast(`📚 模式匹配 Top-1：${matches[0]?.label ?? '—'} ${matches[0]?.similarity ?? 0}%`);
    // 在控制台打印详细匹配，方便玩家复制
    return;
  }
  if (action === 'scan' && runParameterScan) {
    // 选引擎对应的默认扫描轴
    const sci = state.recipe.seed.genome.scientific || {};
    const et = sci.engineType || 'grayScott';
    const axesDef = DEFAULT_SCAN_AXES?.[et] || DEFAULT_SCAN_AXES.grayScott;
    const baseAxes = axesDef.slice(0, 2);
    toast('🗺️ 跑参数扫描中（可能需要 5-30 秒）...');
    runParameterScan(
      state.sim._rd ? state.sim._rd.params : {},
      { xAxis: { ...baseAxes[0], N: 10 }, yAxis: { ...baseAxes[1], N: 10 } },
      { w: 40, h: 28, steps: 200, progressCb: (p) => { /* console.log 不刷屏 */ } }
    ).then(result => {
      state.sciScanResult = result;
      toast(`扫描完成：最佳点 E=${result.bestPoint.energy.toFixed(3)}`);
    }).catch(err => { toast('❌ 扫描失败：' + err.message); console.error(err); });
    return;
  }
  if (action === 'save' && saveAsDiscovery) {
    const m = metricsFor(state.sim);
    const matches = matchPatternLibrary ? matchPatternLibrary(m) : [];
    const rec = saveAsDiscovery(state.recipe, m, matches);
    state.sciDiscovery = rec;
    const issue = buildOpenScienceIssue ? buildOpenScienceIssue(rec) : null;
    toast(`⭐ 已保存到本地开放科学仓库（${loadLeaderboard().length} 条）`);
    if (issue) {
      // 把 body 写入剪贴板（如果可能）并打印
      try { navigator.clipboard?.writeText(issue.body); toast('📋 Issue body 已复制到剪贴板'); } catch {}
    }
    return;
  }
  toast('❌ 科学模块未加载（可能是浏览器不支持）');
}

function afterEnvReset() {
  state.metrics = metricsFor(state.sim);
  resetHistory();
  state.lastType = state.metrics.type;
  state.lastTypeLabel = state.metrics.typeLabel;
  state.lastDensity = state.metrics.density;
  state.renderer.attach(state.sim);
  state.renderer.setMetrics(state.metrics);
  state.renderer.clear();
  updateHUD(true);
  updateStructValues();
  if (state.audio) state.audio.updateMetrics(state.metrics);
}

function onEnvInput(e) {
  const key = e.target.dataset.envParam;
  if (!key) return;
  const v = parseFloat(e.target.value);
  const env = state.recipe.env;
  let display = '';
  if (key === 'noise') {
    env.noise = v / 100;
    display = `${Math.round(v)}%`;
  } else if (key === 'rate') {
    env.resource.rate = v / 100;
    display = `${Math.round(v)}%`;
  } else if (key === 'period') {
    env.resource.period = Math.round(v);
    display = `${Math.round(v)} 代`;
  } else if (key === 'constraint') {
    env.constraint = v / 100;
    display = `${Math.round(v)}%`;
  } else if (key === 'timeScale') {
    env.timeScale = v;
    display = `${v.toFixed(2)}×`;
  }
  state.sim.setEnv(env);
  state.forceMetrics = true;
  const head = e.target.closest('.field')?.querySelector('.val');
  if (head) head.textContent = display;

  /* ===== 🌌 如果当前在极端环境，改完 slider 后重算 physics 注入 =====
   * 极端环境的 physics.transform() 里 noiseField/constraintField 是用 env.noise/constraint 生成的，
   * 所以用户改了这些 slider 后必须重新注入，否则 physics 里的 field 还是旧值。
   */
  if (state.exoticEnvId && state.sim.setPhysics) {
    env._exoticId = state.exoticEnvId;  // 确保 marker 在
    const physicsObj = applyExoticPhysics(
      env,
      currentScienceEngineType(),
      state.sim.w,
      state.sim.h
    );
    if (physicsObj) {
      state.sim.setPhysics(physicsObj);
      // 不需要 reset，physics 注入在 step() 里自动生效
    }
  }
}

function onCommonsClick(e) {
  const adopt = e.target.closest('[data-adopt]');
  if (adopt) {
    const rec = findRecipe(adopt.dataset.adopt);
    if (rec) adoptRecipe(rec);
    return;
  }
  const cmp = e.target.closest('[data-compare-with]');
  if (cmp) {
    const id = cmp.dataset.compareWith;
    state.compare.ready = false;
    state.compare.keys.a = 'current';
    state.compare.keys.b = id;
    if (id === state.recipe.id) {
      state.compare.mode = 'env';
      state.compare.envKeys.a = 'torus-soup';
      state.compare.envKeys.b = 'low-constraint';
    } else {
      state.compare.mode = 'seed';
      state.compare.envKeys.a = 'torus-soup';
      state.compare.envKeys.b = 'low-constraint';
    }
    switchView('compare');
    return;
  }
  const hyb = e.target.closest('[data-hybrid-with]');
  if (hyb) {
    openHybridModal(hyb.dataset.hybridWith);
    return;
  }
  const share = e.target.closest('[data-share]');
  if (share) {
    shareRecipe(share.dataset.share);
  }
}

function openClearModal() {
  openModal({
    eyebrow: 'CLEAR LOCAL',
    title: '清空本地收录？',
    body: '<p>只会删除保存在本浏览器中的种子与杂交记录。公地原生种与当前运行中的生命不受影响。</p>',
    actions: [
      { label: '取消', cls: 'ghost', onClick: closeModal },
      {
        label: '清空',
        cls: 'primary',
        onClick: () => {
          state.lib.recipes = [];
          state.lib.telemetry = [];
          saveLibrary(state.lib);
          closeModal();
          renderCommons();
          refreshCompareOptions();
          toast('花园已清空 ♡', 'warn');
        },
      },
    ],
  });
}

/* ------------------------------------------------------------------ */
/* Frame loop                                                         */
/* ------------------------------------------------------------------ */

function frame(now) {
  const dt = Math.min(120, now - (state.lastFrame || now));
  state.lastFrame = now;

  if (state.playing && state.view !== 'compare' && state.view !== 'puzzle') {
    state.frameAcc += dt * state.speed * (state.recipe?.env.timeScale || 1);
    const stepMs = state.sim?.kind === 'lenia' ? 42 : 80;
    let count = 0;
    while (state.frameAcc >= stepMs && count < 5) {
      stepMain();
      state.frameAcc -= stepMs;
      count++;
    }
  }
  if (state.forceMetrics && now - state.lastMetricsAt > 120) {
    refreshMainMetrics();
  }

  if (state.view === 'cultivate' && state.renderer) {
    state.renderer.draw(now);
  }

  if (state.view === 'compare' && state.compare.ready) {
    if (state.compare.playing) {
      stepCompareSide('a', dt * state.speed * (state.compare.recipeA?.env.timeScale || 1));
      stepCompareSide('b', dt * state.speed * (state.compare.recipeB?.env.timeScale || 1));
    }
    state.compare.rendererA?.draw(now);
    state.compare.rendererB?.draw(now);
  }

  if (state.audioOn && state.audioCtx) {
    const t = state.audioCtx.currentTime;
    if (state.view === 'compare') {
      if (state.compare.playing) {
        state.compare.audioA?.tick(t);
        state.compare.audioB?.tick(t);
      }
    } else if (state.playing && state.view !== 'puzzle') {
      state.audio?.tick(t);
    }
  }

  if (now - state.lastUI > 220) {
    state.lastUI = now;
    if (state.view === 'cultivate') {
      updateHUD();
      if (now - state.lastStructUI > 850) {
        state.lastStructUI = now;
        updateStructValues();
      }
    }
    if (state.view === 'compare' && state.compare.ready) updateCompareUI();
  }

  requestAnimationFrame(frame);
}

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */

function initialRecipe() {
  const m = location.hash.match(/r=([A-Za-z0-9_-]+)/);
  if (m) {
    const decoded = decodeRecipe(m[1]);
    if (decoded) {
      try {
        history.replaceState(null, '', location.pathname + location.search);
      } catch (e) {
        /* file:// may refuse history updates */
      }
      return { recipe: decoded, shared: true };
    }
  }
  return null;
}

function boot() {
  /* ---- 无障碍：动效开关初始化 ---- */
  setMotionEnabled(state.motion);
  document.body.classList.toggle('motion-off', !state.motion);
  // 监听系统设置变化（仅在用户没手动覆盖时自动跟随）
  try {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    mq.addEventListener?.('change', (e) => {
      const saved = localStorage.getItem('commons.motion.v1');
      if (saved) return;  // 用户已手动覆盖，不自动跟
      state.motion = !e.matches;
      setMotionEnabled(state.motion);
      document.body.classList.toggle('motion-off', !state.motion);
    });
  } catch (_) {}

  state.renderer = new StageRenderer($('#stageCanvas'), { tint: 'a' });
  const c = state.compare;
  c.rendererA = new StageRenderer($('#compareCanvasA'), { tint: 'a' });
  c.rendererB = new StageRenderer($('#compareCanvasB'), { tint: 'b' });

  bindUI();
  updateResearchLabel();

  const shared = initialRecipe();
  const start = shared?.recipe || allCommons(state.lib)[0] || {
    id: uid('r'),
    seed: {
      id: uid('s'),
      name: '初生·00',
      latin: 'Primordia 00',
      genome: defaultGenome('life', 'conway'),
      lineage: { parents: [], generation: 0 },
    },
    env: defaultEnv({ pattern: 'soup' }),
    rngSeed: 12345,
    note: '公地原生种',
  };

  attachRecipe(start);
  state.events = [];
  renderTimeline();
  addLifecycle('hatch', `领养 · ${start.seed.name}`, state.metrics, {
    force: true,
    toast: false,
    tone: 'stable',
  });

  if (!state.lib.seenIntro) {
    $('#intro').classList.remove('hidden');
  }
  if (shared) {
    toast('通过朋友的链接领养了一颗 ♡');
  }
  switchView('cultivate');
  requestAnimationFrame(frame);
  setTimeout(() => queueProfiles(), 1600);
}

boot();
