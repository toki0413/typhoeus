import type { SimState } from '../sim/types';
import { checkDoor, waitDoor, openDoor } from '../sim/door';

export function createDoorUi(
  root: HTMLElement,
  sim: SimState
): { update: (s: SimState) => void } {
  root.innerHTML = `
    <div>门</div>
    <button data-act="check">按住：触碰门把</button>
    <button data-act="wait">等待</button>
    <button data-act="open">开门</button>
  `;

  let holdTimer: number | null = null;

  const clearHold = () => {
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  };

  const act = (name: string) => {
    if (sim.phase !== 'execute' || sim.door.opened || !sim.crew.atDoor) return;
    if (name === 'check') checkDoor(sim);
    if (name === 'wait') waitDoor(sim);
    if (name === 'open') openDoor(sim);
  };

  root.addEventListener('pointerdown', (e) => {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn || btn.dataset.act !== 'check') return;
    clearHold();
    btn.setPointerCapture(e.pointerId);
    holdTimer = window.setTimeout(() => {
      holdTimer = null;
      act('check');
    }, 600);
  });

  root.addEventListener('pointerup', clearHold);
  root.addEventListener('pointercancel', clearHold);
  root.addEventListener('lostpointercapture', clearHold);

  root.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn) return;
    const name = btn.dataset.act;
    if (name === 'wait' || name === 'open') act(name);
  });

  return {
    update(s: SimState) {
      const atDoor = s.crew.atDoor && !s.door.opened && s.phase === 'execute';
      root.style.display = atDoor ? 'block' : 'none';
      const checkBtn = root.querySelector<HTMLButtonElement>('[data-act="check"]')!;
      checkBtn.textContent = s.door.checked ? '门把很烫' : '按住：触碰门把';
      checkBtn.disabled = s.door.checked;
    },
  };
}
