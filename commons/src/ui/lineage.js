/* ==========================================================================
 * 谱系视图 — 按世代渲染所有生命节点
 * 从 app.js 抽出，用 createLineageView(ctx) 注入宿主能力。
 * ========================================================================== */

import { allCommons } from '../store.js';
import { esc, ENGINE_LABEL, ruleLabel } from './format.js';

export function createLineageView({ state, findRecipe, adoptRecipe }) {
  const $ = (sel, root = document) => root.querySelector(sel);

  function currentRecipeForCompare() {
    return {
      id: state.recipe.id,
      seed: state.recipe.seed,
      env: state.recipe.env,
      rngSeed: state.recipe.rngSeed,
      metrics: state.metrics,
    };
  }

  function render() {
    const all = allCommons(state.lib);
    const cur = currentRecipeForCompare();
    const map = new Map();
    for (const r of all) map.set(r.id, r);
    map.set(cur.id, cur);

    const nodes = Array.from(map.values());
    const maxGen = Math.max(0, ...nodes.map((n) => n.seed.lineage?.generation || 0));
    const groups = new Map();
    for (const n of nodes) {
      const g = n.seed.lineage?.generation || 0;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(n);
    }

    const hybrids = nodes.filter((n) => n.seed.lineage?.parents?.length).length;
    $('#lineageSummary').innerHTML = `
      <div class="stat-chip">节点 <b>${nodes.length}</b></div>
      <div class="stat-chip">最深世代 <b>${maxGen}</b></div>
      <div class="stat-chip">杂交个体 <b>${hybrids}</b></div>
      <div class="stat-chip">公地原生 <b>${nodes.filter((n) => n.curated).length}</b></div>`;

    const tree = $('#lineageTree');
    if (!nodes.length) {
      tree.innerHTML = '<div class="lineage-empty">谱系还没有节点。先孵化或杂交一枚生命。</div>';
      return;
    }

    const gens = Array.from(groups.keys()).sort((a, b) => a - b);
    tree.innerHTML = gens
      .map((g) => {
        const items = groups
          .get(g)
          .sort((a, b) => (a.curated === b.curated ? 0 : a.curated ? -1 : 1))
          .map((n) => {
            const parents = (n.seed.lineage?.parentNames || []).join(' × ') || '—';
            const isCurrent = n.id === cur.id;
            return `<button class="lineage-node ${n.curated ? 'curated' : ''} ${n.auto ? 'auto' : ''}" data-adopt="${esc(n.id)}">
              <div class="ln-name">${esc(n.seed.name)}${isCurrent ? ' · 当前' : ''}</div>
              <div class="ln-meta">${ENGINE_LABEL[n.seed.genome.engine]} · ${ruleLabel(n.seed.genome)}</div>
              <div class="ln-parents">亲本：${esc(parents)}</div>
            </button>`;
          })
          .join('');
        return `<div class="gen-row">
          <div class="gen-label">GENERATION ${g}</div>
          <div class="gen-nodes">${items}</div>
        </div>`;
      })
      .join('');
    tree.querySelectorAll('[data-adopt]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const rec = findRecipe(btn.dataset.adopt);
        if (rec) adoptRecipe(rec, { toastText: `已回到「${rec.seed.name}」` });
      });
    });
  }

  return { render };
}
