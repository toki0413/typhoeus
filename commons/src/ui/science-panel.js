/* ==========================================================================
 * 🔬 科学发现面板 — Pattern Match / CPM 细胞调谐 / 参数扫描 / 众包排行
 * 从 app.js 抽出（原“Science Discovery Panel”整节），用 createSciencePanel(ctx)
 * 注入宿主依赖，避免这 ~300 行 DOM 子系统继续挤在组合根里。
 * ========================================================================== */

import { runParameterScan, DEFAULT_SCAN_AXES, renderHeatmap } from '../scan.js';
import {
  rankDiscoveries,
  loadLeaderboard,
  saveAsDiscovery,
  clearLeaderboard,
  buildOpenScienceIssue,
} from '../leaderboard.js';
import { escapeHtml, sortLabel } from './format.js';
import { SCIENCE_METRIC_LABELS } from '../config.js';
import {
  imageToField, extractPatternFeatures, makeReferencePattern, fitPattern,
  DEFAULT_FIT_SIZE, DEFAULT_FIT_STEPS, DEFAULT_FIT_GRID,
} from '../fit.js';

export function createSciencePanel({ state, toast, openModal, downloadJSON, applyScientificParams }) {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* ================= 实验斑图拟合 ================= */
  const FIT_GRID_TOTAL = DEFAULT_FIT_GRID.f.length * DEFAULT_FIT_GRID.k.length * DEFAULT_FIT_GRID.Du.length;

  function ensureFitState() {
    if (!state.fit) {
      state.fit = {
        field: null, w: DEFAULT_FIT_SIZE, h: DEFAULT_FIT_SIZE,
        features: null, result: null,
        running: false, progress: 0, total: 0, kind: null, imageData: null, invert: false,
      };
    }
    return state.fit;
  }

  function fitResultHTML(result) {
    if (!result?.best) return '';
    const b = result.best;
    return `<div class="fit-best">
      <b>最佳结构匹配 ${b.score.toFixed(1)}%</b>
      <div>f ${b.params.f.toFixed(3)} · k ${b.params.k.toFixed(3)} · D_u ${b.params.D_u.toFixed(2)} · D_v ${b.params.D_v.toFixed(2)}</div>
      <div class="dim">结构距离 ${b.distance.toFixed(3)} · 评估 ${result.evaluated} 组 · 只匹配结构统计，不是唯一解</div>
    </div>
    ${result.top.slice(0, 3).map((c, i) =>
      `<div class="fit-rank">#${i + 1} f ${c.params.f.toFixed(3)} · k ${c.params.k.toFixed(3)} · D_u ${c.params.D_u.toFixed(2)} → ${c.score.toFixed(1)}%</div>`
    ).join('')}`;
  }

  function fitSectionHTML() {
    const fit = ensureFitState();
    const label = fit.kind === 'demo'
      ? '示例基准（已知参数生成，非实验数据）'
      : fit.kind === 'image' ? '已载入实验图' : '尚未载入';
    return `<div class="sci-section fit-section">
      <h4>实验斑图参数拟合</h4>
      <p class="dim">上传实验/显微斑图，或先用示例基准验证流程。拟合的是结构统计（密度 / H_v / L_c / D_box），不是像素级相位。</p>
      <div class="sci-row">
        <label class="fit-file">选择图片<input type="file" id="fitFile" accept="image/*"></label>
        <button class="btn ghost tiny" id="fitDemo">使用示例基准</button>
        <label class="fit-invert"><input type="checkbox" id="fitInvert" ${fit.invert ? 'checked' : ''}> 反相</label>
      </div>
      <div class="fit-preview-wrap">
        <canvas id="fitPreview" width="240" height="240"></canvas>
        <div class="fit-meta">
          <div><b>目标</b> ${label}</div>
          ${fit.features
            ? `<div>ρ ${(fit.features.density * 100).toFixed(1)}% · H_v ${fit.features.entropy.toFixed(2)} · L_c ${fit.features.period} 格 · D_box ${fit.features.fractal.toFixed(2)}</div>`
            : '<div class="dim">载入后显示结构特征</div>'}
        </div>
      </div>
      <div class="sci-row">
        <button class="btn" id="fitRun" ${!fit.features || fit.running ? 'disabled' : ''}>${fit.running ? '拟合中…' : '开始拟合'}</button>
        <button class="btn ghost tiny" id="fitApply" ${!fit.result?.best ? 'disabled' : ''}>应用最佳参数</button>
      </div>
      <div id="fitProgress" class="fit-progress">${fit.running ? `已评估 ${fit.progress || 0}/${fit.total || 0}` : ''}</div>
      <div id="fitResult" class="fit-result">${fitResultHTML(fit.result)}</div>
    </div>`;
  }

  function drawFitPreview() {
    const canvas = $('#fitPreview');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const fit = ensureFitState();
    const cw = canvas.width;
    const ch = canvas.height;
    if (!fit.field) {
      ctx.fillStyle = '#f2efe6';
      ctx.fillRect(0, 0, cw, ch);
      ctx.fillStyle = '#5f5f5f';
      ctx.font = '12px Arial';
      ctx.textAlign = 'center';
      ctx.fillText('未载入斑图', cw / 2, ch / 2);
      return;
    }
    const img = ctx.createImageData(cw, ch);
    /* 仅用于显示：把场拉伸到 [0,1]，不参与拟合 */
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < fit.field.length; i++) {
      if (fit.field[i] < min) min = fit.field[i];
      if (fit.field[i] > max) max = fit.field[i];
    }
    const span = max - min || 1;
    for (let y = 0; y < ch; y++) {
      const sy = Math.min(fit.h - 1, Math.floor((y * fit.h) / ch));
      for (let x = 0; x < cw; x++) {
        const sx = Math.min(fit.w - 1, Math.floor((x * fit.w) / cw));
        const v = Math.max(0, Math.min(1, (fit.field[sy * fit.w + sx] - min) / span));
        const c = Math.round(242 - v * 200);
        const i = (y * cw + x) * 4;
        img.data[i] = c;
        img.data[i + 1] = c;
        img.data[i + 2] = c;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  function loadImageFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = (err) => { URL.revokeObjectURL(url); reject(err); };
      img.src = url;
    });
  }

  function imageDataFromImage(img) {
    const maxSide = 256;
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }

  function applyImageData(imageData) {
    const fit = ensureFitState();
    const size = DEFAULT_FIT_SIZE;
    const field = imageToField(imageData, size, size, { invert: fit.invert });
    fit.field = field;
    fit.w = size;
    fit.h = size;
    fit.features = extractPatternFeatures(field, size, size);
    fit.result = null;
    fit.kind = 'image';
    render();
  }

  async function runFit() {
    const fit = ensureFitState();
    if (!fit.features || fit.running) return;
    fit.running = true;
    fit.progress = 0;
    fit.total = FIT_GRID_TOTAL;
    fit.result = null;
    render();
    try {
      const result = await fitPattern(fit.features, {
        w: fit.w,
        h: fit.h,
        steps: DEFAULT_FIT_STEPS,
        onProgress: (done, total) => {
          fit.progress = done;
          fit.total = total;
          const el = $('#fitProgress');
          if (el) el.textContent = `已评估 ${done}/${total}`;
        },
      });
      fit.result = result;
      toast(`拟合完成：最佳结构匹配 ${result.best.score.toFixed(1)}%`, 2200);
    } catch (err) {
      toast(`拟合失败：${err?.message || err}`, 2600);
    } finally {
      fit.running = false;
      render();
    }
  }

  function bindFitEvents() {
    drawFitPreview();
    $('#fitFile')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const img = await loadImageFile(file);
        const data = imageDataFromImage(img);
        const fit = ensureFitState();
        fit.imageData = data;
        fit.invert = !!$('#fitInvert')?.checked;
        applyImageData(data);
        toast('实验图已载入，结构特征已提取', 1800);
      } catch (err) {
        toast(`图片载入失败：${err?.message || err}`, 2600);
      }
    });
    $('#fitDemo')?.addEventListener('click', () => {
      const ref = makeReferencePattern();
      const fit = ensureFitState();
      fit.field = ref.field;
      fit.w = ref.w;
      fit.h = ref.h;
      fit.features = extractPatternFeatures(ref.field, ref.w, ref.h);
      fit.result = null;
      fit.kind = 'demo';
      fit.imageData = null;
      render();
      toast('示例基准已载入（已知参数生成，用于验证流程）', 2200);
    });
    $('#fitInvert')?.addEventListener('change', (e) => {
      const fit = ensureFitState();
      fit.invert = e.target.checked;
      if (fit.imageData) applyImageData(fit.imageData);
    });
    $('#fitRun')?.addEventListener('click', runFit);
    $('#fitApply')?.addEventListener('click', () => {
      const best = ensureFitState().result?.best;
      if (!best) return;
      applyScientificParams?.(best.params);
      toast(`已应用 f ${best.params.f.toFixed(3)} · k ${best.params.k.toFixed(3)}`, 2200);
    });
  }

  function render() {
    const panel = $('#panel-science');
    if (!panel) return;
    const sim = state.sim;
    const m = state.metrics;
    const isScientific = sim?.kind === 'reaction-diffusion';

    let html = '';

    /* ---- 指标说明：明确这些是估计量，避免过度声称 ---- */
    html += `<div class="sci-glossary">
      <b>指标说明</b>：${SCIENCE_METRIC_LABELS.lyapunov.symbol} = ${SCIENCE_METRIC_LABELS.lyapunov.note}；
      ${SCIENCE_METRIC_LABELS.fractal.symbol} = ${SCIENCE_METRIC_LABELS.fractal.note}；
      ${SCIENCE_METRIC_LABELS.entropy.symbol} = ${SCIENCE_METRIC_LABELS.entropy.note}；
      ${SCIENCE_METRIC_LABELS.period.symbol} = ${SCIENCE_METRIC_LABELS.period.note}；
      ${SCIENCE_METRIC_LABELS.energy.symbol} = ${SCIENCE_METRIC_LABELS.energy.note}。
      它们用于相对比较；λ_FT 是有限时间估计，不宣称收敛的渐近指数。
    </div>`;

    /* ---- 实验斑图参数拟合 ---- */
    html += fitSectionHTML();

    /* ---- Section 1: Pattern Match 已发表 Turing 模式匹配 ---- */
    html += `<div class="sci-section"><h4>🎯 已发表模式匹配</h4>`;
    if (!m) {
      html += `<p class="dim">先让它演化一会儿…</p>`;
    } else if (!isScientific) {
      html += `<p class="dim">模式匹配只对科学引擎（Reaction-Diffusion）有效。当前引擎不产生可匹配的斑图科学指标。</p>`;
    } else if (state.topPatterns?.length) {
      html += `<ul class="pattern-list">`;
      for (const p of state.topPatterns) {
        const color = p.similarity >= 80 ? 'var(--text)' : p.similarity >= 60 ? 'var(--pink)' : 'var(--muted)';
        html += `<li class="pattern-item">
          <div class="pattern-head">
            <span class="pattern-name">${p.label}</span>
            <span class="pattern-sim" style="color:${color}">${p.similarity}%</span>
          </div>
          <div class="pattern-desc">${p.desc}</div>
          <div class="pattern-diff">
            Δλ_FT ${p.diff.lyapunov > 0 ? '+' : ''}${p.diff.lyapunov}
            · ΔD_box ${p.diff.fractal > 0 ? '+' : ''}${p.diff.fractal}
            · ΔE_field ${p.diff.energy}
            · ΔL_c ${p.diff.period > 0 ? '+' : ''}${p.diff.period}
          </div>
          <div class="pattern-refs dim">${p.refs?.join(' · ') ?? ''}</div>
        </li>`;
      }
      html += `</ul>`;
    } else {
      html += `<p class="dim">正在匹配…</p>`;
    }
    html += `</div>`;

    /* ---- Section 2: CPM Monte Carlo 玩家调谐 ---- */
    html += `<div class="sci-section"><h4>🧬 Cellular Potts 细胞调谐</h4>`;
    if (!isScientific) {
      html += `<p class="dim">CPM 细胞调谐只对科学引擎有效。</p>`;
    } else {
      const mc = sim?.getMCLastResult?.();
      html += `<p class="dim">Metropolis MC sweep × 4 — 把 v 场离散化为 Potts 细胞类型，然后让它们按黏附能自发排序。只在形态场操作，不修改物理方程。</p>`;
      html += `<div class="sci-row">
        <button class="btn" id="mcBtn" ${!state.playing ? '' : 'disabled'}>🧬 运行 MC 细胞调谐</button>
        <button class="btn ghost tiny" id="mcToggle">${state.mcLabelsVisible ? '🙈 隐藏 Potts 标签' : '👁 显示 Potts 标签'}</button>
      </div>`;
      if (mc) {
        const rate = (mc.acceptedRate * 100).toFixed(1);
        const dE = mc.energyDelta.toFixed(3);
        html += `<div class="mc-result">
          <div>接受率 <b>${rate}%</b> | ΔH <b>${dE}</b></div>
          <div class="dim">用 ${mc.usedField} 场 · ${mc.parameters.nTypes} 种细胞类型</div>
        </div>`;
      }
    }
    html += `</div>`;

    /* ---- Section 3: 参数扫描 heatmap ---- */
    html += `<div class="sci-section"><h4>🔥 参数空间扫描</h4>`;
    if (!isScientific) {
      html += `<p class="dim">参数扫描只对科学引擎有效。</p>`;
    } else {
      const engineType = sim.genome?.scientific?.preset || 'gs_spots';
      const axes = scanAxesFor(engineType);
      html += `<p class="dim">选 2 个物理参数 → N×M 网格搜索 → 看能量景观热力图，找到最优参数组合。</p>`;
      html += `<div class="sci-row">
        <button class="btn" id="scanBtn" ${state.scanRunning ? 'disabled' : ''}>
          ${state.scanRunning ? '🔄 扫描中…' : '🔥 开始扫描'}
        </button>
        <button class="btn ghost tiny" id="scanShow" ${state.scanResult ? '' : 'disabled'}>📊 查看热力图</button>
      </div>`;
      if (state.scanResult) {
        const r = state.scanResult;
        html += `<div class="scan-info">
          <div>N×M = ${r.Nx}×${r.Ny} = ${r.Nx * r.Ny} 点</div>
          <div>最佳点：ix=${r.bestPoint.ix}, iy=${r.bestPoint.iy} · E=${r.bestPoint.energy.toFixed(4)}</div>
          <div>最差点：ix=${r.worstPoint.ix}, iy=${r.worstPoint.iy} · E=${r.worstPoint.energy.toFixed(4)}</div>
        </div>`;
      }
      html += `<details class="scan-axes">
        <summary class="dim">扫描轴预设：${axes?.[0]?.label ?? '默认'} × ${axes?.[1]?.label ?? '默认'}</summary>
        <p class="tiny dim">扫描完成后可以点「📊 查看热力图」在 overlay 里看 — 绿色边框=最佳点，红色边框=最差点。</p>
      </details>`;
    }
    html += `</div>`;

    /* ---- Section 4: Leaderboard 众包排名 ---- */
    html += `<div class="sci-section"><h4>🏆 我的发现 · 众包排名</h4>`;
    html += `<p class="dim">每个发现都被自动保存到浏览器本地（privacy-by-default）。排序：</p>
      <div class="sci-row">
        ${['similarity', 'energy', 'lyapunov', 'fractal', 'recent'].map((s) =>
          `<button class="tiny ghost lb-sort" data-sort="${s}">${sortLabel(s)}</button>`
        ).join('')}
      </div>
      <div id="lbList" class="lb-list"></div>
      <div class="sci-row">
        <button class="btn tiny" id="lbSaveNow">💾 立即保存当前发现</button>
        <button class="btn ghost tiny" id="lbClear">🗑 清空</button>
        <button class="btn ghost tiny" id="lbExport">📤 导出 JSON</button>
        <button class="btn ghost tiny" id="lbOSR">🌐 提交到开放科学</button>
      </div>`;
    html += `</div>`;

    panel.innerHTML = html;

    /* ---- Bindings ---- */
    bindFitEvents();
    $('#mcBtn')?.addEventListener('click', runMcNow);
    $('#mcToggle')?.addEventListener('click', () => {
      state.mcLabelsVisible = !state.mcLabelsVisible;
      sim?.renderer?.setMCOverlay?.(state.mcLabelsVisible ? sim.getMCLabels?.() : null);
      render();
    });
    $('#scanBtn')?.addEventListener('click', startScan);
    $('#scanShow')?.addEventListener('click', showHeatmap);

    // Leaderboard sort + actions
    $$('.lb-sort').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.leaderboard = rankDiscoveries(loadLeaderboard(), btn.dataset.sort);
        renderLeaderboardList();
      });
    });
    $('#lbSaveNow')?.addEventListener('click', () => {
      if (!state.metrics) { toast('没有可保存的发现', 1600); return; }
      const rec = saveAsDiscovery(state.recipe, state.metrics, state.topPatterns);
      state.leaderboard = loadLeaderboard();
      renderLeaderboardList();
      toast(`💾 发现已保存 · ${rec.fingerprint}`, 2000);
    });
    $('#lbClear')?.addEventListener('click', () => {
      if (!confirm('清空本地所有发现？（不可恢复）')) return;
      clearLeaderboard();
      state.leaderboard = [];
      renderLeaderboardList();
      toast('已清空', 1200);
    });
    $('#lbExport')?.addEventListener('click', () => {
      const lb = loadLeaderboard();
      if (!lb.length) { toast('没有发现可导出', 1600); return; }
      downloadJSON(`commons-discoveries-${Date.now()}.json`, lb);
    });
    $('#lbOSR')?.addEventListener('click', () => {
      const lb = loadLeaderboard();
      if (!lb.length) { toast('先保存一个发现', 1600); return; }
      // 用最近保存的那个
      const latest = lb[0];
      const { title, body, url } = buildOpenScienceIssue(latest);
      // 给用户看 body，让他们 copy-paste
      openModal({
        eyebrow: '开放科学仓库提交',
        title: `提交发现：${title}`,
        body: `<p class="dim">把下面的内容复制，然后在浏览器打开仓库 issue 页面粘贴提交。</p>
          <pre class="osr-body" id="osrBody">${escapeHtml(body)}</pre>
          <p class="tiny dim">目标仓库 URL：<a href="${url}" target="_blank">${url}</a></p>`,
        actions: [
          { label: '复制 body', cls: 'primary', onClick: () => {
              navigator.clipboard?.writeText(body).then(() => toast('已复制！', 1400));
            } },
          { label: '打开仓库', cls: 'ghost', onClick: () => window.open(url, '_blank') },
          { label: '关闭', cls: 'ghost' },
        ],
      });
    });

    // Initial leaderboard render
    state.leaderboard = loadLeaderboard();
    renderLeaderboardList();
  }

  function renderLeaderboardList() {
    const host = $('#lbList');
    if (!host) return;
    const lb = state.leaderboard;
    if (!lb.length) {
      host.innerHTML = `<p class="dim">还没有发现 — 让它演化一会儿，自动保存会生效。或点「💾 立即保存当前发现」。</p>`;
      return;
    }
    const sorted = rankDiscoveries(lb, 'similarity');
    host.innerHTML = sorted.slice(0, 20).map((r, i) => {
      const topMatch = r.patternMatches?.[0];
      const sim = topMatch ? `${topMatch.similarity}%` : '—';
      const lyap = r.metrics?.lyapunov?.toFixed(3) ?? '—';
      const fract = r.metrics?.fractal?.toFixed(3) ?? '—';
      const eng = r.metrics?.energy?.total?.toFixed(4) ?? '—';
      const time = new Date(r.timestamp).toLocaleTimeString();
      return `<div class="lb-row">
        <span class="lb-rank">#${i + 1}</span>
        <span class="lb-sim">${sim}</span>
        <span class="lb-tiny dim">λ${lyap}·D${fract}·E${eng}</span>
        <span class="lb-time dim tiny">${time}</span>
      </div>`;
    }).join('');
  }

  function runMcNow() {
    const sim = state.sim;
    if (!sim?.mcStep) { toast('CPM 只对科学引擎有效', 1600); return; }
    const res = sim.mcStep(4);
    if (!res) { toast('MC 调谐失败', 1600); return; }
    const rate = (res.acceptedRate * 100).toFixed(1);
    const dE = res.energyDelta.toFixed(3);
    toast(`🧬 MC 完成 · 接受率 ${rate}% · ΔH ${dE}`, 2200);
    render();
  }

  async function startScan() {
    const sim = state.sim;
    if (!sim || sim.kind !== 'reaction-diffusion') { toast('扫描只对科学引擎有效', 1800); return; }

    state.scanRunning = true;
    render();
    toast('🔥 开始参数扫描…', 1600);

    try {
      const engineType = sim.genome?.scientific?.preset || 'gs_spots';
      const axes = scanAxesFor(engineType);
      const axesObj = {
        xAxis: { key: axes[0].key, min: axes[0].min, max: axes[0].max, N: 16 },
        yAxis: { key: axes[1].key, min: axes[1].min, max: axes[1].max, N: 16 },
      };
      // 引擎归属由 preset 决定（scientific.js 的 preset 表是唯一事实源），这里不再硬编码 engine
      const baseParams = { preset: engineType };
      const result = await runParameterScan(baseParams, axesObj, { w: 40, h: 30, steps: 200 });
      state.scanResult = result;
      toast(`✅ 扫描完成 · 最佳 E=${result.bestPoint.energy.toFixed(4)}`, 2000);
    } catch (err) {
      toast('扫描失败：' + (err.message ?? '未知'), 2000);
    } finally {
      state.scanRunning = false;
      render();
    }
  }

  function showHeatmap() {
    const r = state.scanResult;
    if (!r) { toast('先跑一次扫描', 1600); return; }
    openModal({
      eyebrow: '参数空间能量景观',
      title: `Heatmap · ${r.Nx}×${r.Ny}`,
      body: `<p class="dim">绿色边框=能量最低（最接近吸引子），红色边框=能量最高（最远离）。</p>
        <div style="text-align:center"><canvas id="heatmapCanvas"></canvas></div>
        <p class="tiny dim">x 轴: ${r.axes.xAxis.label} (${r.gridX[0].toFixed(3)} → ${r.gridX[r.Nx - 1].toFixed(3)})
          <br>y 轴: ${r.axes.yAxis.label} (${r.gridY[0].toFixed(3)} → ${r.gridY[r.Ny - 1].toFixed(3)})</p>`,
      actions: [
        { label: '导出扫描 JSON', cls: 'ghost', onClick: () => downloadJSON(`commons-scan-${Date.now()}.json`, r) },
        { label: '关闭', cls: 'ghost' },
      ],
      onOpen: () => {
        // renderHeatmap 需要 canvas 已经挂载到 DOM — openModal 的 body 渲染后
        setTimeout(() => {
          const c = $('#heatmapCanvas');
          if (c) renderHeatmap(c, r, 'energy', 'viridis');
        }, 50);
      },
    });
  }

  return { render, renderLeaderboardList, runMcNow, startScan, showHeatmap };
}

/* preset key → 扫描轴（gs_* / fhn_* / brs_*） */
function scanAxesFor(engineType) {
  const group = engineType.startsWith('gs') ? 'grayScott'
    : engineType.startsWith('fhn') ? 'fitzHughNagumo'
    : engineType.startsWith('brs') ? 'brusselator'
    : 'grayScott';
  return DEFAULT_SCAN_AXES[group];
}
