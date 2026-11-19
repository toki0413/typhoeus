import type { SimState } from '../sim/types';
import { RADIO_SCRIPT } from '../content/radio';

export function createRadio(root: HTMLElement): { update: (s: SimState) => void } {
  let shown = 0;
  let lastT = 0;

  return {
    update(s: SimState) {
      if (s.t < lastT) shown = 0;
      lastT = s.t;

      while (shown < RADIO_SCRIPT.length && s.t >= RADIO_SCRIPT[shown].at) {
        shown += 1;
      }

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
