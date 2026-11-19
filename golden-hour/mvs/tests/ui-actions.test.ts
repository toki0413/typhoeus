// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { createWorld } from '../src/sim/world';
import { createActions } from '../src/ui/actions';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('行动面板', () => {
  it('规划阶段隐藏，执行阶段显示', () => {
    const root = document.createElement('div');
    const sim = createWorld('x');
    const ui = createActions(root, sim);

    ui.update(sim);
    expect(root.style.display).toBe('none');

    sim.phase = 'execute';
    ui.update(sim);
    expect(root.style.display).toBe('block');
  });

  it('点击压制消耗一具灭火器', () => {
    const root = document.createElement('div');
    const sim = createWorld('x');
    sim.phase = 'execute';
    createActions(root, sim);

    (root.querySelector('[data-act="suppress"]') as HTMLButtonElement).click();

    expect(sim.resources.extinguisher).toBe(1);
  });
});
