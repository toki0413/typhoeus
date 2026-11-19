// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { createWorld } from '../src/sim/world';
import { stepSim } from '../src/sim/step';
import { createIncidentUi } from '../src/ui/incidents';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('并发事件面板', () => {
  it('事件激活后显示标题与倒计时', () => {
    const root = document.createElement('div');
    const sim = createWorld('x');
    sim.phase = 'execute';
    while (sim.t < 9) stepSim(sim, 1 / 20);

    const ui = createIncidentUi(root, sim);
    ui.update(sim);

    expect(root.style.display).toBe('block');
    expect(root.textContent).toContain('102');
    expect(root.textContent).toContain('还剩');
  });

  it('点击选项后事件解决且面板隐藏', () => {
    const root = document.createElement('div');
    const sim = createWorld('x');
    sim.phase = 'execute';
    while (sim.t < 9) stepSim(sim, 1 / 20);

    const ui = createIncidentUi(root, sim);
    ui.update(sim);

    (root.querySelector('[data-opt="coach"]') as HTMLButtonElement).click();
    expect(sim.neighbor.saveAt).not.toBeNull();

    ui.update(sim);
    expect(root.style.display).toBe('none');
  });
});
