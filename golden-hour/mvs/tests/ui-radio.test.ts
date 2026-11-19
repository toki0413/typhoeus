// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { createWorld } from '../src/sim/world';
import { createRadio } from '../src/ui/radio';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('无线电支援小队', () => {
  it('开场显示林队的简报', () => {
    const root = document.createElement('div');
    const sim = createWorld('x');
    const radio = createRadio(root);

    radio.update(sim);
    expect(root.textContent).toContain('十五分钟');
    expect(root.textContent).toContain('林队');
  });

  it('按时间推进显示新消息', () => {
    const root = document.createElement('div');
    const sim = createWorld('x');
    const radio = createRadio(root);

    sim.t = 9;
    radio.update(sim);
    expect(root.textContent).toContain('102');
  });

  it('王姨的传言会在后面自我反证', () => {
    const root = document.createElement('div');
    const sim = createWorld('x');
    const radio = createRadio(root);

    sim.t = 5;
    radio.update(sim);
    expect(root.textContent).toContain('已经被邻居救出来了');

    sim.t = 31;
    radio.update(sim);
    expect(root.textContent).toContain('孩子在哭');
  });

  it('重开后从开场重新显示', () => {
    const root = document.createElement('div');
    const sim = createWorld('x');
    const radio = createRadio(root);

    sim.t = 31;
    radio.update(sim);

    sim.t = 0;
    radio.update(sim);
    expect(root.textContent).toContain('十五分钟');
    expect(root.textContent).not.toContain('孩子在哭');
  });
});
