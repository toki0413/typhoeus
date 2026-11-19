import type { DebriefCard } from '../eval/debrief';

export function renderDebrief(root: HTMLElement, card: DebriefCard): void {
  const rows = card.timeline
    .map((t) => `<li>${t.atSec}s · ${t.type} · ${t.label}</li>`)
    .join('');
  const omissions = card.omissions.length
    ? card.omissions.map((o) => `<li>${o}</li>`).join('')
    : '<li>无</li>';

  root.innerHTML = `
    <h2>行动后回顾</h2>
    <p>救出 ${card.tactical.rescued} / 被困 ${card.tactical.trapped} / 死亡 ${card.tactical.lost}</p>
    <h3>时间线</h3><ul>${rows}</ul>
    <h3>遗漏清单</h3><ul>${omissions}</ul>
    <h3>学习记录</h3>
    <ul>${card.learning.map((l) => `<li>${l.anchorId} · ${l.correct}/${l.attempts}</li>`).join('')}</ul>
    <button id="export">导出复盘卡 JSON</button>
  `;

  root.querySelector('#export')?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(card, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `debrief-${card.seed}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
}
