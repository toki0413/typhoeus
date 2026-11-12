/* ==========================================================================
 * 纯文本/标签工具 — 无 DOM、无状态、可直接单测
 * 从 app.js 抽出，供 app.js 与 ui/* 子模块共用。
 * ========================================================================== */

/* HTML 转义（esc 与 escapeHtml 是同一个实现，历史上两个名字混用） */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
export const esc = escapeHtml;

export const ENGINE_LABEL = { life: 'Conway 系', lenia: 'Lenia 简化', scientific: '反应-扩散（科学）' };

export const TYPE_COLOR = {
  /* 构成主义色板：黑 / 朱红 / 蓝 / 铬黄 */
  stable: '#121212',
  periodic: '#1f4ea3',
  chaotic: '#d7261e',
  endangered: '#d9a400',
  extinct: '#b81d13',
  drifting: '#4d4d4d',
};

export const TYPE_EVENT_LABEL = {
  stable: '进入安睡态 ♡',
  periodic: '开始轻轻呼吸 ♡',
  chaotic: '变得灵动起来 ✿',
  endangered: '需要更多关爱哦 ♡',
  extinct: '安静地休眠了 ♡',
  drifting: '开始慢慢漫步',
};

export function ruleLabel(genome) {
  if (!genome) return '—';
  if (genome.engine === 'life') {
    const b = genome.life.birth.join('');
    const s = genome.life.survive.join('');
    return `B${b || '∅'}/S${s || '∅'}`;
  }
  if (genome.engine === 'scientific') {
    const sci = genome.scientific || {};
    return `GS f${Number(sci.f ?? 0).toFixed(3)} k${Number(sci.k ?? 0).toFixed(3)}`;
  }
  return `Lenia μ${genome.lenia.mu.toFixed(2)} σ${genome.lenia.sigma.toFixed(3)} R${genome.lenia.radius}`;
}

export function formatFp(fp) {
  const h = (fp >>> 0).toString(16).toUpperCase().padStart(8, '0');
  return `${h.slice(0, 4)}-${h.slice(4)}`;
}

export function sortLabel(s) {
  return {
    similarity: '相似度',
    energy: 'E_field 低',
    lyapunov: 'λ_FT 低',
    fractal: 'D_box 最优',
    recent: '最新',
  }[s] ?? s;
}

export function diagnosisShort(m) {
  const map = {
    stable: '安睡中，像一段温柔的呼吸 ♡',
    periodic: `每 ${m.period || '—'} 代轻轻呼吸一次。`,
    chaotic: '灵动而充满惊喜，歌声明亮热闹。',
    endangered: '歌声轻轻的，需要你的关爱 ♡',
    extinct: '安静地休眠了，只剩一点点余音。',
    drifting: '慢慢漫步中，还在找自己的节奏。',
  };
  return map[m.type] || '';
}
