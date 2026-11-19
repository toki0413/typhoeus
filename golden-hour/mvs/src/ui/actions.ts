import type { SimState } from '../sim/types';
import { suppressFire } from '../sim/actions';

export function createActions(
  root: HTMLElement,
  sim: SimState
): { update: (s: SimState) => void } {
  root.innerHTML = '<button data-act="suppress">压制火势</button>';
  const button = root.querySelector<HTMLButtonElement>('[data-act="suppress"]')!;

  button.addEventListener('click', () => {
    suppressFire(sim);
  });

  return {
    update(s: SimState) {
      const visible = s.phase === 'execute' && s.resources.extinguisher > 0 && !s.door.opened;
      root.style.display = visible ? 'block' : 'none';
      button.textContent = `压制火势（剩 ${s.resources.extinguisher} 具）`;
    },
  };
}
