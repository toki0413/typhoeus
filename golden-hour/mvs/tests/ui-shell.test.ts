// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createShell, type ShellOptions } from '../src/ui/shell';
import { DEFAULT_SETTINGS } from '../src/app/prefs';
import { EMPTY_RECORD } from '../src/app/records';

beforeEach(() => {
  document.body.innerHTML = '';
});

function options(overrides: Partial<ShellOptions> = {}): ShellOptions {
  return {
    settings: { ...DEFAULT_SETTINGS },
    onStart: vi.fn(),
    onResume: vi.fn(),
    onRestart: vi.fn(),
    onTitle: vi.fn(),
    onSettingsChange: vi.fn(),
    ...overrides,
  };
}

describe('产品外壳', () => {
  it('标题页展示任务简报并可通过按钮开始', () => {
    const root = document.createElement('div');
    const onStart = vi.fn();
    createShell(root, options({ onStart })).showTitle();

    expect(root.textContent).toContain('黄金时间');
    expect(root.textContent).toContain('专业消防队还有十五分钟');
    (root.querySelector('[data-action="start"]') as HTMLButtonElement).click();
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(root.classList.contains('open')).toBe(false);
  });

  it('暂停页提供继续、重开与返回标题', () => {
    const root = document.createElement('div');
    const onResume = vi.fn();
    const onRestart = vi.fn();
    const onTitle = vi.fn();
    createShell(root, options({ onResume, onRestart, onTitle })).showPause();

    (root.querySelector('[data-action="resume"]') as HTMLButtonElement).click();
    (root.querySelector('[data-action="restart"]') as HTMLButtonElement).click();
    (root.querySelector('[data-action="title"]') as HTMLButtonElement).click();

    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(onTitle).toHaveBeenCalledTimes(1);
  });

  it('设置开关更新 aria-pressed 并回传完整设置', () => {
    const root = document.createElement('div');
    const onChange = vi.fn();
    createShell(root, options({ onSettingsChange: onChange })).showTitle();

    const largeText = root.querySelector('[data-toggle="largeText"]') as HTMLButtonElement;
    expect(largeText.getAttribute('aria-pressed')).toBe('false');
    largeText.click();

    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, largeText: true });
    expect(largeText.getAttribute('aria-pressed')).toBe('true');
    expect(largeText.textContent).toContain('开');
  });

  it('音效开关按“是否可听”呈现，而不是静音状态', () => {
    const root = document.createElement('div');
    const onChange = vi.fn();
    createShell(root, options({ onSettingsChange: onChange })).showTitle();

    const sound = root.querySelector('[data-toggle="muted"]') as HTMLButtonElement;
    expect(sound.getAttribute('aria-pressed')).toBe('true');
    expect(sound.textContent).toContain('开');

    sound.click();
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, muted: true });
    expect(sound.getAttribute('aria-pressed')).toBe('false');
    expect(sound.textContent).toContain('关');
  });

  it('音量滑块回传 0–1 的音量并更新百分比', () => {
    const root = document.createElement('div');
    const onChange = vi.fn();
    createShell(root, options({ onSettingsChange: onChange })).showTitle();

    const slider = root.querySelector('[data-volume]') as HTMLInputElement;
    expect(slider.value).toBe('75');
    expect(root.textContent).toContain('75%');

    slider.value = '30';
    slider.dispatchEvent(new Event('input', { bubbles: true }));

    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, volume: 0.3 });
    expect(root.textContent).toContain('30%');
  });

  it('渲染不可用时给出说明并禁用开始按钮', () => {
    const root = document.createElement('div');
    const shell = createShell(root, options());
    shell.showTitle();
    shell.setNotice('当前设备无法创建 3D 场景（WebGL 不可用）。');

    expect(root.textContent).toContain('WebGL 不可用');
    const start = root.querySelector('[data-action="start"]') as HTMLButtonElement;
    expect(start.disabled).toBe(true);
  });

  it('显示累计训练次数与最佳密度', () => {
    const root = document.createElement('div');
    const shell = createShell(root, options());
    shell.setStats({ ...EMPTY_RECORD, runs: 4, bestDensity: 6.4, rescued: 3, lost: 1 });
    shell.showTitle();

    expect(root.textContent).toContain('第 4 次训练');
    expect(root.textContent).toContain('最佳决策密度 6.4');
    expect(root.textContent).toContain('累计救出 3 人');
  });
});
