import type { SimState } from '../sim/types';

export function createHud(root: HTMLElement): { update: (s: SimState) => void } {
  return {
    update(s: SimState) {
      const hint = s.phase === 'plan' ? '<div>按 Enter 下达搜索二层指令</div>' : '';
      root.innerHTML = [
        `<div>seed ${s.seed}</div>`,
        `<div>t ${s.t.toFixed(1)}s</div>`,
        `<div>烟 ${Math.round(s.smoke[s.crew.floor] * 100)}%</div>`,
        `<div>热 ${Math.round(s.exposure.heat * 100)}%</div>`,
        `<div>体力 ${Math.round(s.exposure.strain * 100)}%</div>`,
        hint,
      ].join('');
    },
  };
}
