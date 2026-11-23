/**
 * 建筑入口的移动输入：键盘 WASD/方向键 + 触控 D-pad。
 * 只负责“当前是否在移动”，不碰模拟状态，便于单测。
 */

const MOVE_KEYS = new Set([
  'w',
  'a',
  's',
  'd',
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
]);

const BUTTON_KEYS: Record<string, string> = {
  up: 'w',
  left: 'a',
  down: 's',
  right: 'd',
};

export interface MovementInput {
  vector(): { x: number; z: number } | null;
  dispose(): void;
}

export function createMovementInput(
  win: Window,
  doc: Document,
  onShortcut: (key: string) => void
): MovementInput {
  const held = new Set<string>();
  const cleanups: (() => void)[] = [];

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (MOVE_KEYS.has(key)) {
      // 方向键默认会滚动页面，移动时阻止默认行为。
      event.preventDefault();
      held.add(key);
    }
    if (event.repeat) return;
    onShortcut(key);
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    held.delete(event.key.toLowerCase());
  };

  win.addEventListener('keydown', onKeyDown);
  win.addEventListener('keyup', onKeyUp);
  cleanups.push(() => win.removeEventListener('keydown', onKeyDown));
  cleanups.push(() => win.removeEventListener('keyup', onKeyUp));

  for (const button of doc.querySelectorAll<HTMLButtonElement>('#move-pad [data-move]')) {
    const key = BUTTON_KEYS[button.dataset.move ?? ''];
    if (!key) continue;

    const press = (event: Event): void => {
      event.preventDefault();
      held.add(key);
    };
    const release = (): void => {
      held.delete(key);
    };
    button.addEventListener('pointerdown', press);
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    button.addEventListener('pointerleave', release);
    cleanups.push(() => {
      button.removeEventListener('pointerdown', press);
      button.removeEventListener('pointerup', release);
      button.removeEventListener('pointercancel', release);
      button.removeEventListener('pointerleave', release);
    });
  }

  return {
    vector() {
      let x = 0;
      let z = 0;
      if (held.has('w') || held.has('arrowup')) z -= 1;
      if (held.has('s') || held.has('arrowdown')) z += 1;
      if (held.has('a') || held.has('arrowleft')) x -= 1;
      if (held.has('d') || held.has('arrowright')) x += 1;
      return x === 0 && z === 0 ? null : { x, z };
    },
    dispose() {
      held.clear();
      for (const cleanup of cleanups) cleanup();
    },
  };
}
