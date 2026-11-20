// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { createWorld } from '../src/sim/world';
import { createHud } from '../src/ui/hud';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('HUD', () => {
  it('显示种子、时间与暴露数值', () => {
    const root = document.createElement('div');
    const hud = createHud(root);
    const s = createWorld('GH-FIRE-MVS');
    s.t = 12.3;
    hud.update(s);
    expect(root.textContent).toContain('GH-FIRE-MVS');
    expect(root.textContent).toContain('标准局');
    expect(root.textContent).toContain('12.3s');
    expect(root.textContent).toContain('烟');
    expect(root.textContent).toContain('体力');
  });

  it('规划阶段显示 Enter 提示，执行阶段隐藏', () => {
    const root = document.createElement('div');
    const hud = createHud(root);
    const s = createWorld('x');

    hud.update(s);
    expect(root.textContent).toContain('Enter');

    s.phase = 'execute';
    hud.update(s);
    expect(root.textContent).not.toContain('Enter');
  });
});
