import type { SimState } from '../sim/types';
import { scenarioFor } from '../content/scenarios';

export function createHud(root: HTMLElement): { update: (s: SimState) => void } {
  return {
    update(s: SimState) {
      const hint = s.phase === 'plan' ? '<div>按 Enter 下达搜索二层指令</div>' : '';
      const density = s.t > 0 ? s.decisions.length / (s.t / 60) : 0;
      const scenario = scenarioFor(s.seed)?.name;
      root.innerHTML = [
        `<div>${scenario ? `${scenario} · ` : ''}seed ${s.seed}</div>`,
        `<div>t ${s.t.toFixed(1)}s</div>`,
        `<div>烟 ${Math.round(s.smoke[s.crew.floor] * 100)}%</div>`,
        `<div>热 ${Math.round(s.exposure.heat * 100)}%</div>`,
        `<div>体力 ${Math.round(s.exposure.strain * 100)}%</div>`,
        `<div>决策 ${s.decisions.length} · ${density.toFixed(1)}/min</div>`,
        hint,
      ].join('');
    },
  };
}
