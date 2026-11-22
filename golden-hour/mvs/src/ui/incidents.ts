import type { SimState } from '../sim/types';
import { activeIncident, resolveIncident } from '../sim/incidents';

export function createIncidentUi(
  root: HTMLElement,
  sim: SimState
): { update: (s: SimState) => void } {
  let renderedId: string | null = null;

  return {
    update(s: SimState) {
      const incident = activeIncident(s);
      if (!incident) {
        root.style.display = 'none';
        renderedId = null;
        return;
      }

      root.style.display = 'block';

      if (renderedId !== incident.id) {
        renderedId = incident.id;
        root.innerHTML = `
          <div class="incident-head">
            <span class="incident-title">${incident.title}</span>
            <span class="incident-timer" data-timer></span>
          </div>
          <p class="incident-detail">${incident.detail}</p>
          <div class="incident-options">
            ${incident.options
              .map((o) => `<button data-opt="${o.id}">${o.label}</button>`)
              .join('')}
          </div>
        `;

        root.querySelectorAll<HTMLButtonElement>('[data-opt]').forEach((button) => {
          button.addEventListener('click', () => {
            resolveIncident(sim, incident.id, button.dataset.opt!);
          });
        });
      }

      const timer = root.querySelector<HTMLElement>('[data-timer]');
      if (timer) {
        timer.textContent = `还剩 ${Math.max(0, Math.ceil(incident.deadline - s.t))} 秒`;
      }
    },
  };
}
