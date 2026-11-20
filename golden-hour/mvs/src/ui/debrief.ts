import type { DebriefCard } from '../eval/debrief';
import type { TrainingRecord } from '../app/records';

export interface DebriefOptions {
  history?: TrainingRecord;
  onRestart?: () => void;
  onTitle?: () => void;
}

export function renderDebrief(
  root: HTMLElement,
  card: DebriefCard,
  options: DebriefOptions = {}
): void {
  const rows = card.timeline
    .map((t) => `<li>${t.atSec}s · ${t.type} · ${t.label}</li>`)
    .join('');
  const omissions = card.omissions.length
    ? card.omissions.map((o) => `<li>${o}</li>`).join('')
    : '<li>无</li>';
  const injury = card.tactical.crewInjured ? ' · 班组受伤' : '';
  const neighbor = card.tactical.neighborSaved
    ? ' · 102 获救'
    : card.tactical.neighborLost
      ? ' · 102 遇难'
      : '';
  const used = card.tactical.resourcesConsumed.extinguisher ?? 0;
  const decisions = card.decisions
    .map((d) => `<li>${Math.round(d.at)}s · ${d.label}</li>`)
    .join('');
  const history = options.history
    ? `<p class="history">第 ${options.history.runs} 次训练 · 最佳决策密度 ${options.history.bestDensity}/分钟` +
      ` · 累计救出 ${options.history.rescued} 人 · 累计遇难 ${options.history.lost} 人</p>`
    : '';

  root.innerHTML = `
    <h2>行动后回顾</h2>
    ${history}
    <p>救出 ${card.tactical.rescued} / 被困 ${card.tactical.trapped} / 死亡 ${card.tactical.lost}${injury}${neighbor}</p>
    <p>灭火器消耗 ${used} · 决策密度 ${card.decisionDensity}/分钟（${card.decisions.length} 次）</p>
    <h3>决策记录</h3><ul>${decisions}</ul>
    <h3>时间线</h3><ul>${rows}</ul>
    <h3>遗漏清单</h3><ul>${omissions}</ul>
    <h3>学习记录</h3>
    <ul>${card.learning.map((l) => `<li>${l.anchorId} · ${l.correct}/${l.attempts}</li>`).join('')}</ul>
    <button id="export">导出复盘卡 JSON</button>
    <button id="replay">同种子重打</button>
    <button id="title">返回标题</button>
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

  if (options.onRestart) {
    root.querySelector('#replay')?.addEventListener('click', options.onRestart);
  }
  if (options.onTitle) {
    root.querySelector('#title')?.addEventListener('click', options.onTitle);
  }
}
