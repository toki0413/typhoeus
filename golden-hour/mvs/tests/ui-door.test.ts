// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createWorld } from '../src/sim/world';
import { createDoorUi } from '../src/ui/door';

function setup(seed = 'x') {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const sim = createWorld(seed);
  sim.phase = 'execute';
  sim.crew.atDoor = true;
  const ui = createDoorUi(root, sim);
  ui.update(sim);
  return { root, sim, ui };
}

const button = (root: HTMLElement, act: string) =>
  root.querySelector<HTMLButtonElement>(`[data-act="${act}"]`)!;

beforeEach(() => {
  document.body.innerHTML = '';
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    value: () => {},
    configurable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('门面板', () => {
  it('到门口且处于执行阶段时显示', () => {
    const { root } = setup();
    expect(root.style.display).toBe('block');
    expect(root.textContent).toContain('门');
  });

  it('不在门口时隐藏', () => {
    const { root, sim, ui } = setup();
    sim.crew.atDoor = false;
    ui.update(sim);
    expect(root.style.display).toBe('none');
  });

  it('规划阶段即使标记到门口也隐藏', () => {
    const { root, sim, ui } = setup();
    sim.phase = 'plan';
    ui.update(sim);
    expect(root.style.display).toBe('none');
  });

  it('点击等待设置计时器并显示倒计时', () => {
    const { root, sim, ui } = setup();
    button(root, 'wait').click();
    expect(sim.door.waitUntil).not.toBeNull();
    ui.update(sim);
    expect(button(root, 'wait').textContent).toContain('等待中');
    expect(button(root, 'wait').disabled).toBe(true);
  });

  it('按住 600ms 完成试温并禁用按钮', () => {
    vi.useFakeTimers();
    const { root, sim, ui } = setup();
    const check = button(root, 'check');
    check.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    vi.advanceTimersByTime(600);
    expect(sim.door.checked).toBe(true);
    ui.update(sim);
    expect(check.textContent).toBe('门把很烫');
    expect(check.disabled).toBe(true);
  });

  it('不到 600ms 松开不会试温', () => {
    vi.useFakeTimers();
    const { root, sim } = setup();
    const check = button(root, 'check');
    check.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    vi.advanceTimersByTime(300);
    check.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    vi.advanceTimersByTime(600);
    expect(sim.door.checked).toBe(false);
  });

  it('键盘长按空格也能试温', () => {
    vi.useFakeTimers();
    const { root, sim } = setup();
    const check = button(root, 'check');
    check.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
    vi.advanceTimersByTime(600);
    expect(sim.door.checked).toBe(true);
  });

  it('未试温直接开门会记录遗漏', () => {
    const { root, sim } = setup();
    button(root, 'open').click();
    expect(sim.door.opened).toBe(true);
    expect(sim.events.some((e) => e.anchorId === 'O-DOOR-TEMP')).toBe(true);
  });

  it('等待结束但未试温时提示门仍然烫手', () => {
    const { root, sim, ui } = setup();
    button(root, 'wait').click();
    ui.update(sim);

    sim.t = 31;
    sim.door.waitUntil = null;
    ui.update(sim);

    expect(root.textContent).toContain('等待结束，门仍然烫手');
  });
});
