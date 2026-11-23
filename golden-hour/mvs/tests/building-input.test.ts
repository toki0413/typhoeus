// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createMovementInput } from '../src/app/buildingInput';

function setup() {
  document.body.innerHTML =
    '<div id="move-pad"><button data-move="up"></button><button data-move="left"></button><button data-move="down"></button><button data-move="right"></button></div>';
  const shortcuts: string[] = [];
  const input = createMovementInput(window, document, (key) => shortcuts.push(key));
  return { input, shortcuts };
}

describe('建筑入口移动输入', () => {
  it('键盘移动合成方向，松开后归零', () => {
    const { input } = setup();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd' }));
    expect(input.vector()).toEqual({ x: 1, z: -1 });
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'w' }));
    expect(input.vector()).toEqual({ x: 1, z: 0 });
    input.dispose();
  });

  it('方向键与 WASD 等价', () => {
    const { input } = setup();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(input.vector()).toEqual({ x: 0, z: 1 });
    input.dispose();
  });

  it('快捷动作只在非重复按键时触发', () => {
    const { shortcuts } = setup();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '1' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', repeat: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' }));
    expect(shortcuts).toEqual(['1', 'r']);
  });

  it('触控 D-pad 按下/松开改变方向', () => {
    const { input } = setup();
    const up = document.querySelector('[data-move="up"]') as HTMLButtonElement;
    up.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(input.vector()).toEqual({ x: 0, z: -1 });
    up.dispatchEvent(new Event('pointerup', { bubbles: true }));
    expect(input.vector()).toBeNull();
    input.dispose();
  });

  it('dispose 后不再响应键盘', () => {
    const { input } = setup();
    input.dispose();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }));
    expect(input.vector()).toBeNull();
  });
});
