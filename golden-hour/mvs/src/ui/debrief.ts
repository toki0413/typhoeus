import type { DebriefCard } from '../eval/debrief';
import type { TrainingRecord } from '../app/records';
import { scenarioFor } from '../content/scenarios';

export interface DebriefOptions {
  history?: TrainingRecord;
  nextScenarioName?: string;
  onRestart?: () => void;
  onNextScenario?: () => void;
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
    ? ' · 202 获救'
    : card.tactical.neighborLost
      ? ' · 202 遇难'
      : '';
  const used = card.tactical.resourcesConsumed.extinguisher ?? 0;
  const decisions = card.decisions
    .map((d) => `<li>${Math.round(d.at)}s · ${d.label}</li>`)
    .join('');
  const scenarioName = scenarioFor(card.seed)?.name ?? card.seed;
  const evidence = card.objectives
    .map(
      (objective) =>
        `<li><b>${objective.title}</b><span>${objective.observed}</span><em>${objective.outcome}</em></li>`
    )
    .join('');
  const history = options.history
    ? `<p class="history">第 ${options.history.runs} 次训练 · ${scenarioName}` +
      ` · 最佳决策密度 ${options.history.bestDensity}/分钟` +
      ` · 累计救出 ${options.history.rescued} 人 · 累计遇难 ${options.history.lost} 人</p>` +
      `<p class="history">累计：门温试探 ${options.history.doorChecks} 次` +
      ` · 门外等待 ${options.history.waits} 次` +
      ` · 事件处理 ${options.history.incidentsHandled} 次` +
      ` · 事件忽略 ${options.history.incidentsIgnored} 次</p>`
    : `<p class="history">场景：${scenarioName}</p>`;
  const nextButton = options.onNextScenario
    ? `<button id="next-scenario">换一个场景再练${
        options.nextScenarioName ? `：${options.nextScenarioName}` : ''
      }</button>`
    : '';

  root.innerHTML = `
    <h2>行动后回顾</h2>
    ${history}
    <p>救出 ${card.tactical.rescued} / 被困 ${card.tactical.trapped} / 死亡 ${card.tactical.lost}${injury}${neighbor}</p>
    <p>灭火器消耗 ${used} · 决策密度 ${card.decisionDensity}/分钟（${card.decisions.length} 次）</p>
    <h3>本次训练证据</h3>
    <ul class="evidence">${evidence}</ul>
    <div class="debrief-actions">
      <button id="export">导出复盘卡 JSON</button>
      <button id="replay">同种子重打</button>
      ${nextButton}
      <button id="title">返回标题</button>
    </div>
    <h3>决策记录</h3><ul>${decisions}</ul>
    <h3>时间线</h3><ul>${rows}</ul>
    <h3>未完成动作</h3><ul>${omissions}</ul>
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
  if (options.onNextScenario) {
    root.querySelector('#next-scenario')?.addEventListener('click', options.onNextScenario);
  }
  if (options.onTitle) {
    root.querySelector('#title')?.addEventListener('click', options.onTitle);
  }
}
