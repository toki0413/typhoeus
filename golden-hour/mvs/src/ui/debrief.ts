import type { DebriefCard } from '../eval/debrief';

export function renderDebrief(
  root: HTMLElement,
  card: DebriefCard,
  onRestart?: () => void
): void {
  const rows = card.timeline
    .map((t) => `<li>${t.atSec}s · ${t.type} · ${t.label}</li>`)
    .join('');
  const omissions = card.omissions.length
    ? card.omissions.map((o) => `<li>${o}</li>`).join('')
    : '<li>无</li>';
  const injury = card.tactical.crewInjured ? ' · 班组受伤' : '';
  const used = card.tactical.resourcesConsumed.extinguisher ?? 0;

  root.innerHTML = `
    <h2>行动后回顾</h2>
    <p>救出 ${card.tactical.rescued} / 被困 ${card.tactical.trapped} / 死亡 ${card.tactical.lost}${injury}</p>
    <p>灭火器消耗 ${used}</p>
    <h3>时间线</h3><ul>${rows}</ul>
    <h3>遗漏清单</h3><ul>${omissions}</ul>
    <h3>学习记录</h3>
    <ul>${card.learning.map((l) => `<li>${l.anchorId} · ${l.correct}/${l.attempts}</li>`).join('')}</ul>
    <button id="export">导出复盘卡 JSON</button>
    <button id="replay">同种子重打</button>
  `;

  root.querySelector('#export')?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(card, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `debrief-${card.seed}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  });

  if (onRestart) {
    root.querySelector('#replay')?.addEventListener('click', onRestart);
  }
}
