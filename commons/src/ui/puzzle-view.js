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

export function createPuzzleView({
  state, toast, getLifeParams = null, applyToLife = null, makeLifeScientific = null,
  saveToGarden = null, openGarden = null,
}) {
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
  let ghostOn = false;
  let undoStack = [];
  let followingLife = true;
  let lastSave = null;

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

  function readLifeParams() {
    try {
      return typeof getLifeParams === 'function' ? getLifeParams() : null;
    } catch (_) {
      return null;
    }
  }

  function sessionForLevel(id) {
    if (!followingLife) return createSession(id);
    const lp = readLifeParams();
    return lp ? createSession(id, { f: lp.f, k: lp.k, inherited: lp }) : createSession(id);
  }

  function syncParamInputs() {
    if (!session) return;
    const fEl = $('#puzzleF');
    const kEl = $('#puzzleK');
    if (fEl) { fEl.value = String(session.f); syncFill(fEl); }
    if (kEl) { kEl.value = String(session.k); syncFill(kEl); }
    const fVal = $('#puzzleFVal');
    const kVal = $('#puzzleKVal');
    if (fVal) fVal.textContent = fmt(session.f);
    if (kVal) kVal.textContent = fmt(session.k);
  }

  function lifeLinkInnerHTML() {
    if (!session) return '';
    if (session.inherited) {
      const clampNote = session.inherited.clamped ? ' · 已按关卡范围裁剪' : '';
      return `<span>从当前生命继承：f <b>${fmt(session.f)}</b> · k <b>${fmt(session.k)}</b>${clampNote}</span>
        <button class="btn ghost tiny" id="puzzleRelink">重新继承</button>`;
    }
    if (!followingLife) {
      return `<span>已手动调整参数，未跟随当前生命。</span>
        <button class="btn ghost tiny" id="puzzleRelink">重新继承</button>`;
    }
    return `<span>当前生命不是反应-扩散形态，本关使用默认起始参数。</span>
      ${typeof applyToLife === 'function'
        ? '<button class="btn ghost tiny" id="puzzleAdoptRD">切换当前生命为反应-扩散</button>'
        : ''}`;
  }

  function renderLifeLink() {
    const host = $('#puzzleLifeLink');
    if (!host) return;
    host.classList.toggle('muted', !session?.inherited);
    host.innerHTML = lifeLinkInnerHTML();
    $('#puzzleRelink')?.addEventListener('click', relinkLife);
    $('#puzzleAdoptRD')?.addEventListener('click', adoptReactionDiffusion);
  }

  function relinkLife() {
    if (!session || running) return;
    const lp = readLifeParams();
    if (!lp) {
      toast('当前生命不是反应-扩散形态，先在培育台切换引擎', 2200);
      return;
    }
    followingLife = true;
    const next = createSession(session.levelId, { f: lp.f, k: lp.k, inherited: lp });
    session.f = next.f;
    session.k = next.k;
    session.inherited = next.inherited;
    markEdited();
    syncParamInputs();
    draw();
    renderLifeLink();
    schedulePreview(380);
    toast(`已继承当前生命：f ${fmt(session.f)} · k ${fmt(session.k)}`, 2200);
  }

  function adoptReactionDiffusion() {
    if (!session || running) return;
    if (typeof makeLifeScientific === 'function') {
      makeLifeScientific();
    } else if (typeof applyToLife === 'function') {
      applyToLife({ preset: 'gs_spots' });
    } else {
      return;
    }
    followingLife = true;
    const lp = readLifeParams();
    if (lp) {
      const next = createSession(session.levelId, { f: lp.f, k: lp.k, inherited: lp });
      session.f = next.f;
      session.k = next.k;
      session.inherited = next.inherited;
    }
    markEdited();
    syncParamInputs();
    draw();
    renderLifeLink();
    if (!lp) toast('已切换引擎，但暂未读到参数；回培育台看一眼再回来', 2600);
    schedulePreview(420);
  }

  function writeToLife() {
    if (!session || typeof applyToLife !== 'function') return;
    applyToLife({ f: session.f, k: session.k });
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

  function paintField(canvas, field, mode = 'gray', ghostField = null) {
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
        /* 目标叠影：把目标高密度区域淡淡染成朱红，帮助对齐 */
        if (ghostField) {
          const gv = Math.max(0, Math.min(1, ghostField[i] || 0));
          if (gv > 0.35) {
            const a = ((gv - 0.35) / 0.65) * 0.26;
            c = [
              Math.round(c[0] + (red[0] - c[0]) * a),
              Math.round(c[1] + (red[1] - c[1]) * a),
              Math.round(c[2] + (red[2] - c[2]) * a),
            ];
          }
        }
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
    const ghost = ghostOn ? target?.field : null;
    if (displayMode === 'seed') {
      paintField(work, session.mask, 'gray', ghost);
    } else if (displayMode === 'diff' && previewField && target) {
      const diff = new Float32Array(FIELD_SIZE * FIELD_SIZE);
      for (let i = 0; i < diff.length; i++) diff[i] = Math.abs(previewField[i] - target.field[i]);
      paintField(work, diff, 'diff');
    } else {
      paintField(work, previewField || session.mask, 'gray', ghost);
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

  function hintFor(r, valid) {
    if (!valid) return '先画几笔，让种子连成块；半径 2 以下的碎点很难成核。';
    if (r.total >= 80) return '很接近了。试试减少墨量，或微调 f/k 拿满最后几分。';
    if (r.sLayout < 45) return '布局偏了：切到「差异」看红色区域，把种子放到目标最密的地方。';
    if (r.sStruct < 45) return '结构不像：试试目标类别的 f/k，或按一次 Wiggle。';
    if (r.sRobust < 50) return '不太稳：把种子集中成几块，不要撒得太碎。';
    if (r.sInk < 50) return '墨太多了：减小笔刷，清掉不参与成图的区域。';
    return '继续微调：先动布局，再动参数。';
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
      const stars = starsFor(r.total);
      host.innerHTML = `
        <div class="puzzle-score-top">
          <span class="puzzle-total">${valid ? r.total.toFixed(0) : '—'}</span>
          <span class="dim">${valid ? '总分 / 100' : '种子太少，尚未成图'}</span>
          ${valid ? `<span class="puzzle-stars" aria-label="${stars} 星">${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}</span>` : ''}
          <span class="puzzle-best">最佳 ${Math.round(Number(progress[session.levelId]?.best) || 0)}</span>
        </div>
        <div class="puzzle-bars">
          ${bar('结构 50%', r.sStruct)}
          ${bar('布局 25%', r.sLayout)}
          ${bar('稳健 15%', r.sRobust)}
          ${bar('墨量 10%', r.sInk)}
        </div>
        <p class="puzzle-hint">${hintFor(r, valid)}</p>
        <div class="puzzle-features">
          <span>ρ 目标 ${(tf.density * 100).toFixed(1)}% · 当前 ${((f.density || 0) * 100).toFixed(1)}%</span>
          <span>H_v 目标 ${(tf.entropy || 0).toFixed(2)} · 当前 ${(f.entropy || 0).toFixed(2)}</span>
          <span>L_c 目标 ${tf.period || 0} · 当前 ${Math.round(f.period || 0)} 格</span>
          <span>D_box 目标 ${(tf.fractal || 0).toFixed(2)} · 当前 ${(f.fractal || 0).toFixed(2)}</span>
          <span>墨量 ${(r.ink * 100).toFixed(1)}% · ${r.painted} 格</span>
          <span>结构距离 ${r.distance.toFixed(3)}</span>
        </div>`;
      const totalEl = host.querySelector('.puzzle-total');
      if (totalEl && valid) {
        totalEl.classList.add('pop');
        setTimeout(() => totalEl.classList.remove('pop'), 340);
      }
    }

    const reveal = $('#puzzleReveal');
    if (reveal) {
      if (submitted && lastResult && lastResult.total >= 50) {
        const idx = PUZZLE_LEVELS.findIndex((l) => l.id === session.levelId);
        const next = PUZZLE_LEVELS[idx + 1];
        const nextUnlocked = next ? isLevelUnlocked(idx + 1, progress) : false;
        reveal.hidden = false;
        reveal.innerHTML = `<b>通关揭示</b>
          <div>隐藏参数：f ${fmt(session.level.target.f)} · k ${fmt(session.level.target.k)}</div>
          <div>类别：${session.level.classLabel} · 你的 f ${fmt(session.f)} · k ${fmt(session.k)}</div>
          <div class="dim">目标由已知参数与固定种子合成，是<b>合成标定关卡</b>，不是实验数据。参数不唯一；同浏览器、同种子可复现。</div>
          <div class="dim">参考：${session.level.refs.join(' · ')}</div>
          ${lastSave?.saved
            ? `<div class="puzzle-saved">已存入花园 · 第 ${lastSave.generation} 代 · ${lastSave.name}</div>
               ${typeof openGarden === 'function' ? '<button class="btn tiny" id="puzzleGoGarden">去花园看看</button>' : ''}`
            : lastSave?.duplicate ? '<div class="dim">花园里已有相同形态，没有重复写入。</div>' : ''}
          ${next
            ? `<button class="btn tiny" id="puzzleNext" ${nextUnlocked ? '' : 'disabled'}>进入下一关 →</button>`
            : '<div class="puzzle-done">全部关卡完成 ♡</div>'}`;
        $('#puzzleNext')?.addEventListener('click', () => {
          if (nextUnlocked) selectLevel(next.id);
        });
        $('#puzzleGoGarden')?.addEventListener('click', () => {
          if (typeof openGarden === 'function') openGarden();
        });
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
    lastSave = null;
    previewField = null;
    displayMode = 'seed';
    updateSeedChip();
    updateScoreUI();
  }

  function pushUndo() {
    if (!session) return;
    undoStack.push(Float32Array.from(session.mask));
    if (undoStack.length > 12) undoStack.shift();
  }

  function undo() {
    if (!session || running) return;
    const prev = undoStack.pop();
    if (!prev) {
      toast('没有可撤销的笔画', 1200);
      return;
    }
    session.mask = prev;
    markEdited();
    draw();
    schedulePreview(360);
  }

  function setBrush(next) {
    brush = Math.max(2, Math.min(8, next));
    const el = $('#puzzleBrush');
    if (el) {
      el.value = String(brush);
      syncFill(el);
    }
    const label = $('#puzzleBrushVal');
    if (label) label.textContent = String(brush);
    updateBrushCursorSize();
  }

  function toggleErase() {
    erase = !erase;
    const el = $('#puzzleErase');
    if (el) {
      el.textContent = erase ? '橡皮：开' : '橡皮：关';
      el.setAttribute('aria-pressed', String(erase));
    }
    const cursor = $('#puzzleBrushCursor');
    if (cursor) cursor.classList.toggle('erasing', erase);
  }

  function updateBrushCursorSize() {
    const canvas = $('#puzzleWork');
    const cursor = $('#puzzleBrushCursor');
    if (!canvas || !cursor) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    const size = Math.max(8, (brush * 2 / FIELD_SIZE) * rect.width);
    cursor.style.width = `${size}px`;
    cursor.style.height = `${size}px`;
  }

  function moveBrushCursor(ev) {
    const canvas = $('#puzzleWork');
    const cursor = $('#puzzleBrushCursor');
    const stage = canvas?.parentElement;
    if (!canvas || !cursor || !stage) return;
    if (ev.pointerType && ev.pointerType !== 'mouse') {
      cursor.hidden = true;
      return;
    }
    const canvasRect = canvas.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    if (!canvasRect.width) return;
    updateBrushCursorSize();
    cursor.style.left = `${ev.clientX - stageRect.left}px`;
    cursor.style.top = `${ev.clientY - stageRect.top}px`;
    cursor.classList.toggle('erasing', erase);
    cursor.hidden = false;
  }

  function hideBrushCursor() {
    const cursor = $('#puzzleBrushCursor');
    if (cursor) cursor.hidden = true;
  }

  function bindCanvas() {
    const canvas = $('#puzzleWork');
    if (!canvas) return;
    canvas.addEventListener('pointerdown', (ev) => {
      if (!session || running) return;
      const p = toGrid(ev, canvas);
      if (!p) return;
      pushUndo();
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
      moveBrushCursor(ev);
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
    canvas.addEventListener('pointerleave', () => {
      hideBrushCursor();
      end();
    });
    canvas.addEventListener('pointerenter', moveBrushCursor);
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
    const beforeInherited = session.inherited;
    const beforeFollowing = followingLife;
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
      const markManual = () => {
        const changed = Math.abs(session.f - beforeF) > 1e-9 || Math.abs(session.k - beforeK) > 1e-9;
        if (changed) {
          followingLife = false;
          session.inherited = null;
        } else {
          followingLife = beforeFollowing;
          session.inherited = beforeInherited;
        }
        syncParamInputs();
        renderLifeLink();
      };
      markManual();
      setRunning(null);
      setStatus('');
      await runPreview({ silent: true });
      /* 局部目标（结构+布局）不包含稳健/墨量；若总分反而下降，保留原参数 */
      if (beforeTotal != null && lastResult && lastResult.total < beforeTotal - 0.5) {
        session.f = beforeF;
        session.k = beforeK;
        followingLife = beforeFollowing;
        session.inherited = beforeInherited;
        syncParamInputs();
        renderLifeLink();
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
    lastSave = null;
    if (lastResult.total >= 50 && typeof saveToGarden === 'function') {
      try {
        lastSave = saveToGarden({
          levelId: session.levelId,
          levelName: session.level.name,
          f: session.f,
          k: session.k,
          mask: session.mask,
          total: lastResult.total,
          stars,
          steps: session.level.steps,
        });
      } catch (_) {
        toast('挑战成绩已保存，但写回花园失败', 2600);
      }
    }
    const savedText = lastSave?.saved
      ? ` · 已存入花园（第 ${lastSave.generation} 代）`
      : lastSave?.duplicate ? ' · 花园里已有相同形态' : '';
    toast(`提交：${lastResult.total.toFixed(0)} 分 · ${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}${unlocked ? ' · 解锁下一关' : ''}${savedText}`, 3800);
    render();
  }

  function doShake() {
    if (!session || running) return;
    pushUndo();
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
    <div id="puzzleLifeLink" class="puzzle-life-link"></div>

    <div class="puzzle-canvases">
      <figure class="puzzle-canvas-card">
        <figcaption>目标斑图</figcaption>
        <canvas id="puzzleTarget" width="${FIELD_SIZE}" height="${FIELD_SIZE}"></canvas>
      </figure>
      <figure class="puzzle-canvas-card puzzle-work-card">
        <figcaption>你的斑图 · <span id="puzzleModeTag">种子</span></figcaption>
        <div class="puzzle-canvas-stage">
          <canvas id="puzzleWork" width="${FIELD_SIZE}" height="${FIELD_SIZE}"></canvas>
          <div id="puzzleBrushCursor" class="puzzle-brush-cursor" hidden></div>
        </div>
        <p class="puzzle-tip">按住拖动画种子；笔刷越大，成核越容易。</p>
      </figure>
    </div>

    <div class="puzzle-toolbar">
      <label class="puzzle-tool">笔刷 <input type="range" id="puzzleBrush" min="2" max="8" step="1" value="${brush}"><span id="puzzleBrushVal">${brush}</span></label>
      <button class="btn ghost tiny" id="puzzleErase" aria-pressed="${erase ? 'true' : 'false'}">${erase ? '橡皮：开' : '橡皮：关'}</button>
      <button class="btn ghost tiny" id="puzzleUndo">撤销</button>
      <button class="btn ghost tiny" id="puzzleGhost" aria-pressed="${ghostOn ? 'true' : 'false'}">目标叠影：${ghostOn ? '开' : '关'}</button>
      <button class="btn ghost tiny" id="puzzleClear">清空</button>
      <button class="btn ghost tiny" id="puzzleReset">重置本关</button>
      <span class="puzzle-modes">
        <button class="puzzle-mode${displayMode === 'result' ? ' active' : ''}" data-mode="result">结果</button>
        <button class="puzzle-mode${displayMode === 'seed' ? ' active' : ''}" data-mode="seed">种子</button>
        <button class="puzzle-mode${displayMode === 'diff' ? ' active' : ''}" data-mode="diff">差异</button>
      </span>
    </div>
    <p class="puzzle-shortcuts">[/] 笔刷 · E 橡皮 · Ctrl/Cmd+Z 撤销 · P 预览</p>

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
      ${typeof applyToLife === 'function' ? '<button class="btn ghost" id="puzzleWriteLife">写回当前生命</button>' : ''}
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
        setBrush(parseInt(brushEl.value, 10) || 5);
      });
    }
    $('#puzzleErase')?.addEventListener('click', toggleErase);
    $('#puzzleUndo')?.addEventListener('click', undo);
    $('#puzzleWriteLife')?.addEventListener('click', writeToLife);
    $('#puzzleGhost')?.addEventListener('click', () => {
      ghostOn = !ghostOn;
      const el = $('#puzzleGhost');
      if (el) {
        el.textContent = `目标叠影：${ghostOn ? '开' : '关'}`;
        el.setAttribute('aria-pressed', String(ghostOn));
      }
      draw();
    });
    $('#puzzleClear')?.addEventListener('click', () => {
      if (!session || running) return;
      pushUndo();
      markEdited();
      session.mask = clearMask();
      updateSeedChip();
      draw();
      updateScoreUI();
      toast('种子已清空，撤销可恢复', 1600);
    });
    $('#puzzleReset')?.addEventListener('click', () => {
      if (!session || running) return;
      undoStack = [];
      followingLife = true;
      session = sessionForLevel(session.levelId);
      previewField = null;
      lastResult = null;
      lastSave = null;
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
      if (followingLife) {
        followingLife = false;
        session.inherited = null;
        renderLifeLink();
      }
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
    followingLife = true;
    session = sessionForLevel(id);
    target = getTarget(id);
    previewField = null;
    lastResult = null;
    lastSave = null;
    submitted = false;
    displayMode = 'seed';
    statusText = '';
    undoStack = [];
    render();
  }

  function render() {
    const root = $('#view-puzzle');
    if (!root) return;
    if (!session) {
      followingLife = true;
      session = sessionForLevel(PUZZLE_LEVELS[0].id);
      target = getTarget(session.levelId);
    }
    if (!target) target = getTarget(session.levelId);

    root.innerHTML = `
      <header class="view-head">
        <div class="view-title">
          <div class="eyebrow">FORM CHALLENGES · 形态挑战</div>
          <h2>用最少的墨，种出目标形态</h2>
          <p>花园里的形态考试：默认继承当前生命的参数；也可以手动调整后写回生命。画种子 → 预览 → Wiggle / Shake → 提交。</p>
        </div>
        <span class="puzzle-source">合成标定关卡 · 非实验数据</span>
      </header>
      <div class="puzzle-layout">
        <aside class="puzzle-levels" aria-label="关卡列表">${levelCardsHTML()}</aside>
        <section class="puzzle-work">${workspaceHTML()}</section>
      </div>`;

    bindEvents();
    renderLifeLink();
    draw();
    updateScoreUI();
  }

  function activate() {
    token += 1;
    if (!session) {
      followingLife = true;
      session = sessionForLevel(PUZZLE_LEVELS[0].id);
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
    hideBrushCursor();
    if (running) setRunning(null);
  }

  /* 键盘快捷键：[/] 笔刷、E 橡皮、Ctrl/Cmd+Z 撤销、P 预览 */
  document.addEventListener('keydown', (ev) => {
    if (state.view !== 'puzzle') return;
    const tag = ev.target?.tagName || '';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
    if (document.body.classList.contains('modal-open')) return;
    const key = ev.key;
    if ((ev.ctrlKey || ev.metaKey) && key.toLowerCase() === 'z') {
      ev.preventDefault();
      undo();
      return;
    }
    if (key === '[') {
      ev.preventDefault();
      setBrush(brush - 1);
    } else if (key === ']') {
      ev.preventDefault();
      setBrush(brush + 1);
    } else if (key.toLowerCase() === 'e') {
      ev.preventDefault();
      toggleErase();
    } else if (key.toLowerCase() === 'p') {
      ev.preventDefault();
      runPreview();
    }
  });

  return { render, activate, deactivate };
}
