/* ==========================================================================
 * 斑图解谜视图 — 人画种子，机器 Wiggle/Shake
 * 工厂模式与 science-panel 一致：宿主注入 state / toast。
 * ========================================================================== */

import {
  PUZZLE_LEVELS, PUZZLE_SIZE, MIN_PAINTED, getTarget, createSession, evaluate,
  countPainted, stampLine, clearMask, shakeSession, wiggle,
  loadPuzzleProgress, savePuzzleProgress, starsFor, isLevelUnlocked,
} from '../puzzle.js';

const FIELD_SIZE = PUZZLE_SIZE;

export function createPuzzleView({ state, toast }) {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  let session = null;
  let target = null;
  let previewField = null;
  let lastResult = null;
  let submitted = false;
  let running = null;
  let displayMode = 'seed';
  let brush = 5;
  let erase = false;
  let painting = false;
  let lastPoint = null;
  let previewTimer = null;
  let token = 0;
  let progress = loadPuzzleProgress();
  let statusText = '';

  /* ------------------------------------------------------------------ */
  /* 工具                                                                */
  /* ------------------------------------------------------------------ */

  const fmt = (v, d = 3) => Number(v).toFixed(d);
  const pct = (v) => `${Math.max(0, Math.min(100, v)).toFixed(0)}%`;

  function syncFill(el) {
    if (!el || el.type !== 'range') return;
    const min = parseFloat(el.min || '0');
    const max = parseFloat(el.max || '100');
    const val = parseFloat(el.value || '0');
    const p = max > min ? ((val - min) / (max - min)) * 100 : 0;
    el.style.setProperty('--fill', `${Math.max(0, Math.min(100, p))}%`);
  }

  function syncFills() {
    $$('#view-puzzle input[type="range"]').forEach(syncFill);
  }

  function setStatus(text) {
    statusText = text || '';
    const el = $('#puzzleStatus');
    if (el) el.textContent = statusText;
  }

  function setRunning(mode) {
    running = mode;
    for (const sel of ['#puzzlePreview', '#puzzleWiggle', '#puzzleShake', '#puzzleSubmit',
      '#puzzleClear', '#puzzleReset', '#puzzleErase', '#puzzleBrush', '#puzzleF', '#puzzleK']) {
      const el = $(sel);
      if (el) el.disabled = !!mode;
    }
    const work = $('#puzzleWork');
    if (work) work.classList.toggle('busy', !!mode);
  }

  function checkToken(myToken) {
    return myToken === token && state.view === 'puzzle';
  }

  function schedulePreview(delay = 480) {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      if (state.view === 'puzzle' && !running && session) runPreview({ silent: true });
    }, delay);
  }

  /* ------------------------------------------------------------------ */
  /* 绘制                                                                */
  /* ------------------------------------------------------------------ */

  function paintField(canvas, field, mode = 'gray') {
    if (!canvas || !field) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(FIELD_SIZE, FIELD_SIZE);
    const base = [242, 239, 230];
    const ink = [18, 18, 18];
    const red = [215, 38, 30];
    for (let i = 0; i < field.length; i++) {
      const v = Math.max(0, Math.min(1, field[i] || 0));
      let c;
      if (mode === 'diff') {
        c = [
          Math.round(base[0] + (red[0] - base[0]) * v),
          Math.round(base[1] + (red[1] - base[1]) * v),
          Math.round(base[2] + (red[2] - base[2]) * v),
        ];
      } else {
        c = [
          Math.round(base[0] + (ink[0] - base[0]) * v),
          Math.round(base[1] + (ink[1] - base[1]) * v),
          Math.round(base[2] + (ink[2] - base[2]) * v),
        ];
      }
      const p = i * 4;
      img.data[p] = c[0];
      img.data[p + 1] = c[1];
      img.data[p + 2] = c[2];
      img.data[p + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  function draw() {
    if (!session) return;
    const targetCanvas = $('#puzzleTarget');
    if (targetCanvas && target) paintField(targetCanvas, target.field, 'gray');

    const work = $('#puzzleWork');
    if (!work) return;
    if (displayMode === 'seed') {
      paintField(work, session.mask, 'gray');
    } else if (displayMode === 'diff' && previewField && target) {
      const diff = new Float32Array(FIELD_SIZE * FIELD_SIZE);
      for (let i = 0; i < diff.length; i++) diff[i] = Math.abs(previewField[i] - target.field[i]);
      paintField(work, diff, 'diff');
    } else {
      paintField(work, previewField || session.mask, 'gray');
    }

    const tag = $('#puzzleModeTag');
    if (tag) tag.textContent = displayMode === 'seed' ? '种子' : displayMode === 'diff' ? '差异' : '结果';
    for (const btn of $$('.puzzle-mode')) {
      btn.classList.toggle('active', btn.dataset.mode === displayMode);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 分数 UI                                                             */
  /* ------------------------------------------------------------------ */

  function bar(label, value) {
    return `<div class="puzzle-bar">
      <span>${label}</span>
      <span class="puzzle-bar-track"><span class="puzzle-bar-fill" style="width:${pct(value)}"></span></span>
      <b>${value.toFixed(0)}</b>
    </div>`;
  }

  function updateScoreUI() {
    const host = $('#puzzleScore');
    if (!host) return;
    if (!lastResult) {
      host.innerHTML = `<p class="dim" style="margin:0">画出种子后点「预览」，这里会显示结构、布局、稳健与墨量四项分数。</p>`;
    } else {
      const r = lastResult;
      const f = r.mean || {};
      const tf = target?.features || {};
      const valid = r.valid && r.total > 0;
      host.innerHTML = `
        <div class="puzzle-score-top">
          <span class="puzzle-total">${valid ? r.total.toFixed(0) : '—'}</span>
          <span class="dim">${valid ? '总分 / 100' : '种子太少，尚未成图'}</span>
          <span class="puzzle-best">最佳 ${Math.round(Number(progress[session.levelId]?.best) || 0)}</span>
        </div>
        <div class="puzzle-bars">
          ${bar('结构 50%', r.sStruct)}
          ${bar('布局 25%', r.sLayout)}
          ${bar('稳健 15%', r.sRobust)}
          ${bar('墨量 10%', r.sInk)}
        </div>
        <div class="puzzle-features">
          <span>ρ 目标 ${(tf.density * 100).toFixed(1)}% · 当前 ${((f.density || 0) * 100).toFixed(1)}%</span>
          <span>H_v 目标 ${(tf.entropy || 0).toFixed(2)} · 当前 ${(f.entropy || 0).toFixed(2)}</span>
          <span>L_c 目标 ${tf.period || 0} · 当前 ${Math.round(f.period || 0)} 格</span>
          <span>D_box 目标 ${(tf.fractal || 0).toFixed(2)} · 当前 ${(f.fractal || 0).toFixed(2)}</span>
          <span>墨量 ${(r.ink * 100).toFixed(1)}% · ${r.painted} 格</span>
          <span>结构距离 ${r.distance.toFixed(3)}</span>
        </div>`;
    }

    const reveal = $('#puzzleReveal');
    if (reveal) {
      if (submitted && lastResult && lastResult.total >= 50) {
        reveal.hidden = false;
        reveal.innerHTML = `<b>通关揭示</b>
          <div>隐藏参数：f ${fmt(session.level.target.f)} · k ${fmt(session.level.target.k)}</div>
          <div>类别：${session.level.classLabel} · 你的 f ${fmt(session.f)} · k ${fmt(session.k)}</div>
          <div class="dim">目标由已知参数与固定种子合成，是<b>合成标定关卡</b>，不是实验数据。参数不唯一；同浏览器、同种子可复现。</div>
          <div class="dim">参考：${session.level.refs.join(' · ')}</div>`;
      } else {
        reveal.hidden = true;
        reveal.innerHTML = '';
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 交互                                                                */
  /* ------------------------------------------------------------------ */

  function toGrid(ev, canvas) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = ((ev.clientX - rect.left) / rect.width) * FIELD_SIZE;
    const y = ((ev.clientY - rect.top) / rect.height) * FIELD_SIZE;
    return { x: Math.max(0, Math.min(FIELD_SIZE - 1, x)), y: Math.max(0, Math.min(FIELD_SIZE - 1, y)) };
  }

  function updateSeedChip() {
    const chip = $('#puzzleSeedChip');
    if (chip && session) chip.textContent = `种子 ${countPainted(session.mask)} 格`;
  }

  function markEdited() {
    lastResult = null;
    submitted = false;
    previewField = null;
    displayMode = 'seed';
    updateSeedChip();
    updateScoreUI();
  }

  function bindCanvas() {
    const canvas = $('#puzzleWork');
    if (!canvas) return;
    canvas.addEventListener('pointerdown', (ev) => {
      if (!session || running) return;
      const p = toGrid(ev, canvas);
      if (!p) return;
      painting = true;
      lastPoint = p;
      markEdited();
      stampLine(session.mask, p.x, p.y, p.x, p.y, { brush, erase });
      updateSeedChip();
      draw();
      try { canvas.setPointerCapture(ev.pointerId); } catch (_) { /* noop */ }
      ev.preventDefault();
    });
    canvas.addEventListener('pointermove', (ev) => {
      if (!painting || !session) return;
      const p = toGrid(ev, canvas);
      if (!p) return;
      stampLine(session.mask, lastPoint.x, lastPoint.y, p.x, p.y, { brush, erase });
      lastPoint = p;
      updateSeedChip();
      draw();
      ev.preventDefault();
    });
    const end = () => {
      if (!painting) return;
      painting = false;
      lastPoint = null;
      schedulePreview();
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointerleave', end);
  }

  async function runPreview({ silent = false } = {}) {
    if (!session || running) return;
    if (countPainted(session.mask) < MIN_PAINTED) {
      toast('先画下至少几个种子格，再预览', 2000);
      return;
    }
    const myToken = token;
    setRunning('preview');
    setStatus('演化中：3 个复现，各 ' + session.level.steps + ' 步…');
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (!checkToken(myToken)) return;
    try {
      const result = evaluate(session);
      if (!checkToken(myToken)) return;
      lastResult = result;
      previewField = result.field;
      displayMode = 'result';
      draw();
      updateScoreUI();
      if (!silent) toast(`预览：${result.total.toFixed(0)} 分`, 1800);
    } catch (err) {
      toast(`演化失败：${err?.message || err}`, 2600);
    } finally {
      if (myToken === token) {
        setRunning(null);
        setStatus('');
      }
    }
  }

  async function runWiggle() {
    if (!session || running) return;
    const myToken = token;
    const beforeF = session.f;
    const beforeK = session.k;
    const beforeTotal = lastResult ? lastResult.total : null;
    setRunning('wiggle');
    setStatus('Wiggle：局部搜索 f / k…');
    try {
      const res = await wiggle(session, {
        budget: 24,
        onProgress: (done, total) => {
          if (checkToken(myToken)) setStatus(`Wiggle：${done} / ${total} 次评估`);
        },
        isCancelled: () => !checkToken(myToken),
      });
      if (!checkToken(myToken)) return;
      session.f = res.f;
      session.k = res.k;
      const applySliders = () => {
        const fEl = $('#puzzleF');
        const kEl = $('#puzzleK');
        if (fEl) { fEl.value = String(session.f); syncFill(fEl); }
        if (kEl) { kEl.value = String(session.k); syncFill(kEl); }
        const fVal = $('#puzzleFVal');
        const kVal = $('#puzzleKVal');
        if (fVal) fVal.textContent = fmt(session.f);
        if (kVal) kVal.textContent = fmt(session.k);
      };
      applySliders();
      setRunning(null);
      setStatus('');
      await runPreview({ silent: true });
      /* 局部目标（结构+布局）不包含稳健/墨量；若总分反而下降，保留原参数 */
      if (beforeTotal != null && lastResult && lastResult.total < beforeTotal - 0.5) {
        session.f = beforeF;
        session.k = beforeK;
        applySliders();
        await runPreview({ silent: true });
        toast('Wiggle 没找到更好的参数，已保留原值', 2400);
      } else {
        toast(`Wiggle 完成 · ${res.evals} 次评估${res.gain > 0.5 ? ` · 局部目标 +${res.gain.toFixed(1)}` : ''}`, 2400);
      }
    } catch (err) {
      toast(`Wiggle 失败：${err?.message || err}`, 2600);
      setRunning(null);
      setStatus('');
    }
  }

  async function submit() {
    if (!session || running) return;
    if (!lastResult) await runPreview({ silent: true });
    if (!lastResult) return;
    submitted = true;
    progress = savePuzzleProgress(session.levelId, {
      best: lastResult.total,
      params: { f: session.f, k: session.k },
    });
    const stars = starsFor(lastResult.total);
    const idx = PUZZLE_LEVELS.findIndex((l) => l.id === session.levelId);
    const next = PUZZLE_LEVELS[idx + 1];
    const unlocked = next && isLevelUnlocked(idx + 1, progress);
    toast(`提交：${lastResult.total.toFixed(0)} 分 · ${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}${unlocked ? ' · 解锁下一关' : ''}`, 3200);
    render();
  }

  function doShake() {
    if (!session || running) return;
    markEdited();
    shakeSession(session);
    updateSeedChip();
    draw();
    updateScoreUI();
    schedulePreview(700);
    toast('Shake：种子被轻轻抖了一下', 1600);
  }

  /* ------------------------------------------------------------------ */
  /* 渲染                                                                */
  /* ------------------------------------------------------------------ */

  function levelCardsHTML() {
    return PUZZLE_LEVELS.map((level, i) => {
      const unlocked = isLevelUnlocked(i, progress);
      const best = Number(progress[level.id]?.best) || 0;
      const stars = starsFor(best);
      const active = session?.levelId === level.id;
      return `<button class="puzzle-level${active ? ' active' : ''}${unlocked ? '' : ' locked'}"
        data-level="${level.id}" ${unlocked ? '' : 'disabled aria-disabled="true"'}>
        <span class="pl-index">${String(i + 1).padStart(2, '0')}</span>
        <span class="pl-name">${level.name}</span>
        <span class="pl-class">${level.classLabel}</span>
        <span class="pl-meta">${unlocked
          ? `最佳 ${best ? Math.round(best) : '—'}${best ? ` · ${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}` : ''}`
          : '完成上一关解锁'}</span>
      </button>`;
    }).join('');
  }

  function workspaceHTML() {
    if (!session) return '';
    const lv = session.level;
    return `<div class="puzzle-work-head">
      <div>
        <div class="eyebrow">LEVEL ${PUZZLE_LEVELS.findIndex((l) => l.id === lv.id) + 1} · ${lv.classLabel}</div>
        <h3>${lv.name}</h3>
        <p class="dim">${lv.subtitle}。${lv.hint}</p>
      </div>
      <span class="puzzle-chip" id="puzzleSeedChip">种子 ${countPainted(session.mask)} 格</span>
    </div>

    <div class="puzzle-canvases">
      <figure class="puzzle-canvas-card">
        <figcaption>目标斑图</figcaption>
        <canvas id="puzzleTarget" width="${FIELD_SIZE}" height="${FIELD_SIZE}"></canvas>
      </figure>
      <figure class="puzzle-canvas-card puzzle-work-card">
        <figcaption>你的斑图 · <span id="puzzleModeTag">种子</span></figcaption>
        <canvas id="puzzleWork" width="${FIELD_SIZE}" height="${FIELD_SIZE}"></canvas>
        <p class="puzzle-tip">按住拖动画种子；笔刷越大，成核越容易。</p>
      </figure>
    </div>

    <div class="puzzle-toolbar">
      <label class="puzzle-tool">笔刷 <input type="range" id="puzzleBrush" min="2" max="8" step="1" value="${brush}"><span id="puzzleBrushVal">${brush}</span></label>
      <button class="btn ghost tiny" id="puzzleErase" aria-pressed="${erase ? 'true' : 'false'}">${erase ? '橡皮：开' : '橡皮：关'}</button>
      <button class="btn ghost tiny" id="puzzleClear">清空</button>
      <button class="btn ghost tiny" id="puzzleReset">重置本关</button>
      <span class="puzzle-modes">
        <button class="puzzle-mode${displayMode === 'result' ? ' active' : ''}" data-mode="result">结果</button>
        <button class="puzzle-mode${displayMode === 'seed' ? ' active' : ''}" data-mode="seed">种子</button>
        <button class="puzzle-mode${displayMode === 'diff' ? ' active' : ''}" data-mode="diff">差异</button>
      </span>
    </div>

    <div class="puzzle-params">
      <label class="puzzle-param">
        <span>feed f <b id="puzzleFVal">${fmt(session.f)}</b></span>
        <input type="range" id="puzzleF" min="${lv.knobs.f.min}" max="${lv.knobs.f.max}" step="${lv.knobs.f.step}" value="${session.f}">
      </label>
      <label class="puzzle-param">
        <span>kill k <b id="puzzleKVal">${fmt(session.k)}</b></span>
        <input type="range" id="puzzleK" min="${lv.knobs.k.min}" max="${lv.knobs.k.max}" step="${lv.knobs.k.step}" value="${session.k}">
      </label>
    </div>

    <div class="puzzle-actions">
      <button class="btn" id="puzzlePreview">预览</button>
      <button class="btn ghost" id="puzzleWiggle">Wiggle · 机器调参</button>
      <button class="btn ghost" id="puzzleShake">Shake · 抖动种子</button>
      <button class="btn" id="puzzleSubmit">提交评分</button>
    </div>
    <div id="puzzleStatus" class="puzzle-status">${statusText}</div>
    <div id="puzzleScore" class="puzzle-score"></div>
    <div id="puzzleReveal" class="puzzle-reveal" hidden></div>`;
  }

  function bindEvents() {
    for (const card of $$('.puzzle-level')) {
      card.addEventListener('click', () => {
        if (card.disabled) return;
        selectLevel(card.dataset.level);
      });
    }
    bindCanvas();

    const brushEl = $('#puzzleBrush');
    if (brushEl) {
      brushEl.addEventListener('input', () => {
        brush = parseInt(brushEl.value, 10) || 5;
        const v = $('#puzzleBrushVal');
        if (v) v.textContent = String(brush);
        syncFill(brushEl);
      });
    }
    const eraseEl = $('#puzzleErase');
    if (eraseEl) {
      eraseEl.addEventListener('click', () => {
        erase = !erase;
        eraseEl.textContent = erase ? '橡皮：开' : '橡皮：关';
        eraseEl.setAttribute('aria-pressed', String(erase));
      });
    }
    $('#puzzleClear')?.addEventListener('click', () => {
      if (!session || running) return;
      markEdited();
      session.mask = clearMask();
      updateSeedChip();
      draw();
      updateScoreUI();
      toast('种子已清空，重新画吧', 1600);
    });
    $('#puzzleReset')?.addEventListener('click', () => {
      if (!session || running) return;
      session = createSession(session.levelId);
      previewField = null;
      lastResult = null;
      submitted = false;
      displayMode = 'seed';
      render();
      toast('已重置本关', 1400);
    });

    for (const btn of $$('.puzzle-mode')) {
      btn.addEventListener('click', () => {
        if (!previewField && btn.dataset.mode !== 'seed') {
          toast('先点「预览」生成结果', 1600);
          return;
        }
        displayMode = btn.dataset.mode;
        draw();
      });
    }

    const fEl = $('#puzzleF');
    const kEl = $('#puzzleK');
    const onParam = () => {
      if (!session) return;
      session.f = parseFloat(fEl.value);
      session.k = parseFloat(kEl.value);
      const fv = $('#puzzleFVal');
      const kv = $('#puzzleKVal');
      if (fv) fv.textContent = fmt(session.f);
      if (kv) kv.textContent = fmt(session.k);
      syncFill(fEl);
      syncFill(kEl);
      previewField = null;
      lastResult = null;
      submitted = false;
      updateScoreUI();
      schedulePreview(520);
    };
    fEl?.addEventListener('input', onParam);
    kEl?.addEventListener('input', onParam);

    $('#puzzlePreview')?.addEventListener('click', () => runPreview());
    $('#puzzleWiggle')?.addEventListener('click', runWiggle);
    $('#puzzleShake')?.addEventListener('click', doShake);
    $('#puzzleSubmit')?.addEventListener('click', submit);

    syncFills();
  }

  function selectLevel(id) {
    const idx = PUZZLE_LEVELS.findIndex((l) => l.id === id);
    if (idx < 0 || !isLevelUnlocked(idx, progress)) {
      toast('先完成上一关', 1600);
      return;
    }
    token += 1;
    session = createSession(id);
    target = getTarget(id);
    previewField = null;
    lastResult = null;
    submitted = false;
    displayMode = 'seed';
    statusText = '';
    render();
  }

  function render() {
    const root = $('#view-puzzle');
    if (!root) return;
    if (!session) {
      session = createSession(PUZZLE_LEVELS[0].id);
      target = getTarget(session.levelId);
    }
    if (!target) target = getTarget(session.levelId);

    root.innerHTML = `
      <header class="view-head">
        <div class="view-title">
          <div class="eyebrow">PATTERN PUZZLES · 斑图解谜</div>
          <h2>用最少的墨，种出目标斑图</h2>
          <p>你负责空间布局，机器只做局部调参。画种子 → 预览 → Wiggle / Shake → 提交评分。</p>
        </div>
        <span class="puzzle-source">合成标定关卡 · 非实验数据</span>
      </header>
      <div class="puzzle-layout">
        <aside class="puzzle-levels" aria-label="关卡列表">${levelCardsHTML()}</aside>
        <section class="puzzle-work">${workspaceHTML()}</section>
      </div>`;

    bindEvents();
    draw();
    updateScoreUI();
  }

  function activate() {
    token += 1;
    if (!session) {
      session = createSession(PUZZLE_LEVELS[0].id);
      target = getTarget(session.levelId);
    }
    progress = loadPuzzleProgress();
    render();
  }

  function deactivate() {
    token += 1;
    clearTimeout(previewTimer);
    previewTimer = null;
    painting = false;
    lastPoint = null;
    if (running) setRunning(null);
  }

  return { render, activate, deactivate };
}
