export function createMoveUi(
  root: HTMLElement,
  onInput: (dir: number) => void
): { update: (visible: boolean, distance: number) => void } {
  root.innerHTML = `
    <div class="move-hint">走向 <b>202</b> 门口 <span data-dist></span></div>
    <div class="move-row">
      <button data-move="-1" aria-label="向左移动">◀</button>
      <button data-move="1" aria-label="向右移动">▶</button>
    </div>
  `;

  const stop = () => onInput(0);
  for (const btn of root.querySelectorAll<HTMLButtonElement>('[data-move]')) {
    const dir = Number(btn.dataset.move);
    btn.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      btn.setPointerCapture(event.pointerId);
      onInput(dir);
    });
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointercancel', stop);
    btn.addEventListener('lostpointercapture', stop);
    btn.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  const distance = root.querySelector<HTMLElement>('[data-dist]')!;
  return {
    update(visible: boolean, meters: number) {
      root.style.display = visible ? 'block' : 'none';
      distance.textContent = `${meters.toFixed(1)} m`;
    },
  };
}
