import type { SimState } from '../sim/types';
import { checkDoor, waitDoor, openDoor } from '../sim/door';

export function createDoorUi(root: HTMLElement): { update: (s: SimState) => void } {
  let checked = false;

  root.addEventListener('contextmenu', (e) => e.preventDefault());

  root.innerHTML = `
    <div>回燃门：右键选择</div>
    <button data-act="check">按住试温</button>
    <button data-act="wait">等 30 秒</button>
    <button data-act="open">开门</button>
  `;

  let holdTimer: number | null = null;

  const act = (name: string) => {
    const s = (window as unknown as { __sim: SimState }).__sim;
    if (!s || s.door.opened) return;
    if (name === 'check') {
      checked = true;
      checkDoor(s);
    }
    if (name === 'wait') waitDoor(s);
    if (name === 'open') openDoor(s);
  };

  root.addEventListener('pointerdown', (e) => {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn || btn.dataset.act !== 'check') return;
    holdTimer = window.setTimeout(() => act('check'), 600);
  });

  root.addEventListener('pointerup', () => {
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  });

  root.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn) return;
    const name = btn.dataset.act;
    if (name === 'wait' || name === 'open') act(name);
  });

  return {
    update(s: SimState) {
      const atDoor = s.crew.atDoor && !s.door.opened;
      root.style.display = atDoor ? 'block' : 'none';
      const checkBtn = root.querySelector<HTMLButtonElement>('[data-act="check"]')!;
      checkBtn.textContent = checked || s.door.checked ? '已试温（烫）' : '按住试温';
      checkBtn.disabled = s.door.checked;
    },
  };
}
