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

export function createSciencePanel({ state, toast, openModal, downloadJSON }) {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

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
      ${SCIENCE_METRIC_LABELS.energy.symbol} = ${SCIENCE_METRIC_LABELS.energy.note}。
      它们只用于本工具内的相对比较，不是严格物理量。
    </div>`;

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
            Δλ_est ${p.diff.lyapunov > 0 ? '+' : ''}${p.diff.lyapunov}
            · ΔD_box ${p.diff.fractal > 0 ? '+' : ''}${p.diff.fractal}
            · ΔE_field ${p.diff.energy}
            · ΔT ${p.diff.period > 0 ? '+' : ''}${p.diff.period}
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
