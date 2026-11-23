// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createHudView, updateHud, type HudState } from '../src/app/buildingHud';

const IDS = [
  'hud-room',
  'hud-target',
  'hud-phase',
  'hud-seed',
  'hud-stamina',
  'hud-exposure',
  'hud-air',
  'hud-resident',
  'hud-time',
  'hud-wind',
  'perf',
  'routes',
  'zones',
  'residents',
  'tools',
  'log',
  'outcome',
  'outcome-title',
  'outcome-body',
  'outcome-score',
  'outcome-curve',
  'outcome-debrief',
];

function mount(ids = IDS): void {
  document.body.innerHTML = ids.map((id) => `<div id="${id}"></div>`).join('');
}

const state: HudState = {
  room: 'room-202-F1',
  target: 'room-203',
  phase: '搜救',
  seedLabel: '种子 7',
  staminaPct: 82,
  airPct: 64,
  exposurePct: 31,
  windLabel: '东南风 0.7',
  residentLabel: '救出 1/10 · 区域 0/5',
  timeSeconds: 12.34,
};

describe('建筑 HUD', () => {
  it('按 id 取齐元素并把状态写进文本', () => {
    mount();
    const view = createHudView(document);
    updateHud(view, state);
    expect(view.room.textContent).toBe('room-202-F1');
    expect(view.target.textContent).toBe('room-203');
    expect(view.phase.textContent).toBe('搜救');
    expect(view.seed.textContent).toBe('种子 7');
    expect(view.stamina.textContent).toBe('82%');
    expect(view.air.textContent).toBe('64%');
    expect(view.exposure.textContent).toBe('31%');
    expect(view.wind.textContent).toBe('东南风 0.7');
    expect(view.resident.textContent).toBe('救出 1/10 · 区域 0/5');
    expect(view.time.textContent).toBe('12.3s');
  });

  it('缺少必需元素时直接报错，避免静默失败', () => {
    mount(IDS.filter((id) => id !== 'hud-air'));
    expect(() => createHudView(document)).toThrow('#hud-air');
  });
});
