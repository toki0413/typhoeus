/* ==========================================================================
 * 结构识别 — 把 Conway 生命里的"具体形态"识别出来，供声音层绑定动机。
 *
 * 识别的是**行为类别**而不是精确图案库（不依赖 RLE）：
 *   still      静止块：小面积、质心几乎不动、面积稳定
 *   oscillator 振荡器：区域内 ≥35% 细胞以 2/3 代为周期循环
 *   mover      移动体（滑翔机类）：质心稳定移动、面积基本不变
 *   merge / split：连通块数量突变（合并 / 分裂）
 *   birthSurge / deathSurge：出生/死亡数显著高于近期均值
 *
 * 事件是"节拍式"的：同类最小间隔 minGap 秒、任意两类之间 globalGap 秒，
 * 且每轮最多抛一个结构事件 —— 保证声音上是点缀而不是噪声。
 *
 * 纯函数 + 显式状态，不依赖 DOM，可直接单测。
 * ========================================================================== */

function cloneGrid(grid) {
  return Uint8Array.from(grid);
}

/* 8 邻域连通块（环形边界），返回质心/面积/单元格索引 */
export function findComponents(grid, w, h) {
  const seen = new Uint8Array(w * h);
  const comps = [];
  const stack = [];
  for (let i = 0; i < w * h; i++) {
    if (!grid[i] || seen[i]) continue;
    let area = 0, sx = 0, sy = 0;
    const cells = [];
    stack.length = 0;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop();
      const x = j % w;
      const y = (j / w) | 0;
      cells.push(j);
      area++; sx += x; sy += y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = (x + dx + w) % w;
          const ny = (y + dy + h) % h;
          const k = ny * w + nx;
          if (grid[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
        }
      }
    }
    comps.push({ area, cx: sx / area, cy: sy / area, cells, kind: 'changing' });
  }
  return comps;
}

/* 细胞级周期：返回 2 或 3（否则 0）。history 为按时间排列的 grid 副本。 */
function cellPeriod(history, i) {
  const n = history.length;
  const cur = history[n - 1][i];
  if (!cur) return 0;
  for (const p of [2, 3]) {
    if (n <= p) continue;
    if (history[n - 1 - p][i] !== cur) continue;
    let differs = false;
    for (let k = 1; k < p; k++) {
      if (history[n - 1 - k][i] !== cur) { differs = true; break; }
    }
    if (differs) return p;
  }
  return 0;
}

export class StructureTracker {
  /**
   * @param {number} w
   * @param {number} h
   * @param {{interval?:number, historySize?:number, minGap?:number, globalGap?:number}} opts
   *   interval   — 每 N 代做一次连通块分析（默认 4）
   *   minGap     — 同类事件最小间隔（秒，默认 2.5）
   *   globalGap  — 任意两个结构事件最小间隔（秒，默认 0.9）
   */
  constructor(w, h, opts = {}) {
    this.w = w;
    this.h = h;
    this.interval = opts.interval ?? 4;
    this.minGap = opts.minGap ?? 4.0;
    this.globalGap = opts.globalGap ?? 2.2;
    this.historySize = opts.historySize ?? 4;
    this.reset();
  }

  reset() {
    this.prevGrid = null;
    this.history = [];
    this.step = 0;
    this.prevComps = null;
    this.counts = { still: 0, oscillator: 0, mover: 0, changing: 0 };
    this.persist = { glider: 0, oscillator: 0, still: 0 };
    this.prevPersist = { glider: 0, oscillator: 0, still: 0 };
    this.birthEma = 0;
    this.deathEma = 0;
    this.lastAnyAt = -1e9;
    this.nextAnyAt = 0;
    this.lastEventAt = { glider: -1e9, oscillator: -1e9, still: -1e9, merge: -1e9, split: -1e9, birthSurge: -1e9, deathSurge: -1e9 };
  }

  _canEmit(type, now) {
    return now >= this.nextAnyAt && now - this.lastEventAt[type] >= this.minGap;
  }

  _emit(events, type, now, count) {
    events.push({ type, t: now, count });
    this.lastEventAt[type] = now;
    this.lastAnyAt = now;
    /* 加一点随机抖动，避免动机像节拍器一样每 2.2 秒固定出现 */
    this.nextAnyAt = now + this.globalGap * (0.65 + Math.random() * 0.9);
  }

  /**
   * 每代调用一次。
   * @param {Uint8Array} grid
   * @param {number} [tSec] 经过的秒数（离线渲染/实时都可传；缺省用代数）
   * @returns {null | {births:number, deaths:number, counts:object, events:Array<{type:string,t:number,count:number}>}}
   */
  update(grid, tSec) {
    if (!grid) return null;
    const N = this.w * this.h;
    const now = Number.isFinite(tSec) ? tSec : this.step;

    if (!this.prevGrid) {
      this.prevGrid = cloneGrid(grid);
      this.history.push(cloneGrid(grid));
      this.step++;
      return null;
    }

    let births = 0, deaths = 0;
    for (let i = 0; i < N; i++) {
      if (grid[i] && !this.prevGrid[i]) births++;
      else if (!grid[i] && this.prevGrid[i]) deaths++;
    }
    this.prevGrid = cloneGrid(grid);

    this.history.push(cloneGrid(grid));
    if (this.history.length > this.historySize) this.history.shift();
    this.step++;

    const events = [];

    // 出生/死亡潮：与指数滑动均值比较
    this.birthEma = this.birthEma * 0.9 + births * 0.1;
    this.deathEma = this.deathEma * 0.9 + deaths * 0.1;
    if (this._canEmit('birthSurge', now) && births > Math.max(8, this.birthEma * 2.4)) {
      this._emit(events, 'birthSurge', now, births);
    } else if (this._canEmit('deathSurge', now) && deaths > Math.max(8, this.deathEma * 2.4)) {
      this._emit(events, 'deathSurge', now, deaths);
    }

    // 连通块分析（每 interval 代）
    if (this.step % this.interval !== 0) {
      return { births, deaths, counts: { ...this.counts }, events };
    }

    const comps = findComponents(grid, this.w, this.h);
    const prev = this.prevComps;
    const counts = { still: 0, oscillator: 0, mover: 0, changing: 0 };

    if (!prev) {
      for (const c of comps) { c.kind = classifySlow(c); counts[c.kind]++; }
      this.prevComps = comps;
      this.counts = counts;
      return { births, deaths, counts, events };
    }

    const matched = new Set();
    let newComps = 0, goneComps = 0;
    let persistGlider = 0, persistOsc = 0, persistStill = 0;
    for (const c of comps) {
      let best = null, bestD = 9e9;
      for (let i = 0; i < prev.length; i++) {
        if (matched.has(i)) continue;
        const p = prev[i];
        const d = Math.hypot(c.cx - p.cx, c.cy - p.cy);
        if (d < bestD && d <= Math.max(3.5, Math.sqrt(p.area) + 2)) { bestD = d; best = i; }
      }
      if (best == null) { newComps++; c.kind = classifySlow(c); counts[c.kind]++; continue; }
      matched.add(best);
      const p = prev[best];
      const areaRatio = Math.abs(c.area - p.area) / Math.max(1, p.area);
      const oscRatio = c.cells.reduce((n, i) => n + (cellPeriod(this.history, i) ? 1 : 0), 0) / Math.max(1, c.area);

      let kind = 'changing';
      if (oscRatio >= 0.35 && c.area <= 60) kind = 'oscillator';
      else if (bestD > 0.8 && areaRatio < 0.3 && c.area <= 40) kind = 'mover';
      else if (bestD < 0.35 && areaRatio < 0.1 && c.area <= 12) kind = 'still';
      counts[kind]++;
      // 持续性：连续两轮同一类别才算"稳定存在"
      if (kind === 'mover' && p.kind === 'mover') persistGlider++;
      if (kind === 'oscillator' && p.kind === 'oscillator') persistOsc++;
      if (kind === 'still' && p.kind === 'still') persistStill++;
      c.kind = kind;
    }
    goneComps = prev.length - matched.size;

    // 合并 / 分裂：块数突变 ≥3 且总面积大致守恒
    const prevArea = prev.reduce((s, c) => s + c.area, 0);
    const curArea = comps.reduce((s, c) => s + c.area, 0);
    const areaStable = prevArea === 0 ? curArea === 0 : Math.abs(curArea - prevArea) / prevArea < 0.25;
    const newPersist = { glider: persistGlider, oscillator: persistOsc, still: persistStill };

    // 每轮最多抛一个结构事件，优先级：移动体 > 振荡器 > 静止块 > 合并 > 分裂
    if (this._canEmit('glider', now) && persistGlider > this.prevPersist.glider) {
      this._emit(events, 'glider', now, persistGlider);
    } else if (this._canEmit('oscillator', now) && persistOsc > this.prevPersist.oscillator) {
      this._emit(events, 'oscillator', now, persistOsc);
    } else if (this._canEmit('still', now) && persistStill > this.prevPersist.still) {
      this._emit(events, 'still', now, persistStill);
    } else if (this._canEmit('merge', now) && areaStable && comps.length <= 12 && newComps >= 3 && goneComps >= 2) {
      this._emit(events, 'merge', now, newComps);
    } else if (this._canEmit('split', now) && areaStable && prev.length <= 12 && goneComps >= 3 && newComps >= 2) {
      this._emit(events, 'split', now, goneComps);
    }

    this.prevPersist = newPersist;
    this.persist = newPersist;
    this.counts = counts;
    this.prevComps = comps;
    return { births, deaths, counts: { ...counts }, events };
  }
}

/* 无历史时只能按面积粗略分类 */
function classifySlow(c) {
  if (c.area <= 8) return 'still';
  return 'changing';
}

export const STRUCTURE_LABEL = {
  still: '静止块',
  oscillator: '振荡器',
  glider: '移动体',
  merge: '合并',
  split: '分裂',
  birthSurge: '出生潮',
  deathSurge: '死亡潮',
};
