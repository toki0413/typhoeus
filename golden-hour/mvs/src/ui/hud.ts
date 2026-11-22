import type { SimState } from '../sim/types';
import { scenarioFor } from '../content/scenarios';

interface Stat {
  label: string;
  value: number;
  hot?: boolean;
}

const bar = (stat: Stat): string =>
  `<div class="stat">
    <span class="stat-label">${stat.label}</span>
    <span class="bar"><i class="${stat.hot ? 'hot' : ''}" style="width:${Math.round(
      stat.value * 100
    )}%"></i></span>
    <b class="stat-value">${Math.round(stat.value * 100)}%</b>
  </div>`;

export function createHud(root: HTMLElement): { update: (s: SimState) => void } {
  return {
    update(s: SimState) {
      const scenario = scenarioFor(s.seed)?.name;
      const smoke = s.smoke[s.crew.floor] ?? 0;
      const heat = s.exposure.heat;
      const strain = s.exposure.strain;
      const density = s.t > 0 ? s.decisions.length / (s.t / 60) : 0;
      const hint = s.phase === 'plan' ? '<div class="hud-hint">按 Enter 下达搜索二层指令</div>' : '';

      root.innerHTML = `
        <div class="hud-head">
          <span class="hud-scenario">${scenario ?? '现场'}</span>
          <span class="hud-time">${s.t.toFixed(1)}s</span>
        </div>
        <div class="hud-seed">${s.seed}</div>
        ${bar({ label: '烟', value: smoke, hot: smoke >= 0.55 })}
        ${bar({ label: '热', value: heat, hot: heat >= 0.55 })}
        ${bar({ label: '体力', value: strain, hot: strain >= 0.7 })}
        <div class="hud-foot">
          <span>决策 ${s.decisions.length}</span>
          <span>${density.toFixed(1)}/min</span>
        </div>
        ${hint}
      `;
    },
  };
}
