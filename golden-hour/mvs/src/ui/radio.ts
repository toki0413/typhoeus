import type { SimState } from '../sim/types';
import { RADIO_SCRIPT, radioLinesUpTo } from '../content/radio';

export function createRadio(root: HTMLElement): { update: (s: SimState) => void } {
  let rendered = -1;

  return {
    update(s: SimState) {
      const shown = radioLinesUpTo(s.t, s.scenario.incidentShift);
      if (shown === rendered) return;
      rendered = shown;

      if (shown === 0) {
        root.innerHTML = '';
        return;
      }

      const visible = RADIO_SCRIPT.slice(Math.max(0, shown - 3), shown);
      const lines = visible
        .map((line, index) => {
          const latest = index === visible.length - 1;
          return (
            `<div class="radio-line${latest ? '' : ' dim'}">` +
            `<span class="radio-speaker">${line.speaker}</span>${line.text}</div>`
          );
        })
        .join('');
      root.innerHTML = `<div class="radio-head"><span class="radio-dot"></span>无线电 · 现场支援</div>${lines}`;
    },
  };
}
