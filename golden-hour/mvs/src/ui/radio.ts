import type { SimState } from '../sim/types';
import { RADIO_SCRIPT, radioLinesUpTo } from '../content/radio';

export function createRadio(root: HTMLElement): { update: (s: SimState) => void } {
  let rendered = -1;

  return {
    update(s: SimState) {
      const shown = radioLinesUpTo(s.t);
      if (shown === rendered) return;
      rendered = shown;

      if (shown === 0) {
        root.innerHTML = '';
        return;
      }

      const visible = RADIO_SCRIPT.slice(Math.max(0, shown - 3), shown);
      root.innerHTML = visible
        .map((line, index) => {
          const latest = index === visible.length - 1;
          return `<div class="radio-line${latest ? '' : ' dim'}"><b>${line.speaker}</b> ${line.text}</div>`;
        })
        .join('');
    },
  };
}
