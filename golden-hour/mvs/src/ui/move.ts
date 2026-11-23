export interface MoveUiState {
  visible: boolean;
  hint: string;
  distance: number;
  action: string | null;
}

export function createMoveUi(
  root: HTMLElement,
  handlers: { onMove: (x: number, z: number) => void; onAction: () => void }
): { update: (state: MoveUiState) => void } {
  root.innerHTML = `
    <div class="move-hint"><span data-hint></span><span data-dist></span></div>
    <div class="move-pad">
      <button data-move="up" class="up" aria-label="向前">▲</button>
      <button data-move="left" class="left" aria-label="向左">◀</button>
      <button data-move="right" class="right" aria-label="向右">▶</button>
      <button data-move="down" class="down" aria-label="向后">▼</button>
    </div>
    <button class="move-act" data-act hidden></button>
  `;

  const stop = () => handlers.onMove(0, 0);
  const vectors: Record<string, [number, number]> = {
    up: [0, -1],
    down: [0, 1],
    left: [-1, 0],
    right: [1, 0],
  };

  for (const btn of root.querySelectorAll<HTMLButtonElement>('[data-move]')) {
    const vec = vectors[btn.dataset.move ?? ''] ?? [0, 0];
    btn.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      btn.setPointerCapture(event.pointerId);
      handlers.onMove(vec[0], vec[1]);
    });
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointercancel', stop);
    btn.addEventListener('lostpointercapture', stop);
    btn.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  root.querySelector<HTMLButtonElement>('[data-act]')!.addEventListener('click', () => {
    handlers.onAction();
  });

  const hint = root.querySelector<HTMLElement>('[data-hint]')!;
  const distance = root.querySelector<HTMLElement>('[data-dist]')!;
  const action = root.querySelector<HTMLButtonElement>('[data-act]')!;

  return {
    update(state: MoveUiState) {
      root.style.display = state.visible ? 'block' : 'none';
      hint.textContent = state.hint;
      distance.textContent = `${state.distance.toFixed(1)} m`;
      action.hidden = !state.action;
      if (state.action) action.textContent = state.action;
    },
  };
}
