import type { SimState } from '../sim/types';
import { checkDoor, waitDoor, openDoor } from '../sim/door';

export function createDoorUi(
  root: HTMLElement,
  sim: SimState
): { update: (s: SimState, allow?: boolean) => void } {
  root.innerHTML = `
    <div class="panel-head">
      <span class="panel-title">202 · 入户门</span>
      <span class="status-pill" data-status></span>
    </div>
    <button data-act="check" class="primary">按住：触碰门把</button>
    <div class="row">
      <button data-act="wait">等待</button>
      <button data-act="open" class="danger">开门</button>
    </div>
  `;

  let holdTimer: number | null = null;
  let prevWaiting = false;
  let lastWaitFailed = false;

  const clearHold = () => {
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  };

  const startHold = () => {
    clearHold();
    holdTimer = window.setTimeout(() => {
      holdTimer = null;
      act('check');
    }, 600);
  };

  const act = (name: string) => {
    if (sim.phase !== 'execute' || sim.door.opened) return;
    if (name === 'check') checkDoor(sim);
    if (name === 'wait') waitDoor(sim);
    if (name === 'open') openDoor(sim);
  };

  root.addEventListener('pointerdown', (e) => {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn || btn.dataset.act !== 'check') return;
    btn.setPointerCapture(e.pointerId);
    startHold();
  });

  root.addEventListener('pointerup', clearHold);
  root.addEventListener('pointercancel', clearHold);
  root.addEventListener('lostpointercapture', clearHold);

  root.addEventListener('keydown', (e) => {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn || btn.dataset.act !== 'check') return;
    if ((e.code === 'Space' || e.code === 'Enter') && !e.repeat) {
      e.preventDefault();
      startHold();
    }
  });

  root.addEventListener('keyup', (e) => {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn || btn.dataset.act !== 'check') return;
    if (e.code === 'Space' || e.code === 'Enter') clearHold();
  });

  root.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn) return;
    const name = btn.dataset.act;
    if (name === 'wait' || name === 'open') act(name);
  });

  return {
    update(s: SimState, allow = s.crew.atDoor) {
      if (s.phase === 'plan') {
        prevWaiting = false;
        lastWaitFailed = false;
      }

      const atDoor = allow && !s.door.opened && s.phase === 'execute';
      root.style.display = atDoor ? 'block' : 'none';

      const checkBtn = root.querySelector<HTMLButtonElement>('[data-act="check"]')!;
      checkBtn.textContent = s.door.checked ? '门把很烫' : '按住：触碰门把';
      checkBtn.disabled = s.door.checked;

      const waiting = s.door.waitUntil !== null;
      if (prevWaiting && !waiting && !s.door.checked) lastWaitFailed = true;
      if (waiting && s.door.checked) lastWaitFailed = false;

      const waitBtn = root.querySelector<HTMLButtonElement>('[data-act="wait"]')!;
      waitBtn.textContent = waiting ? `等待中 ${Math.ceil(s.door.waitUntil! - s.t)}s` : '等待';
      waitBtn.disabled = waiting;

      const status = root.querySelector<HTMLElement>('[data-status]')!;
      status.textContent = lastWaitFailed ? '等待结束，门仍然烫手' : '';

      prevWaiting = waiting;
    },
  };
}
