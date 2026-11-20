// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_SETTINGS,
  applySettings,
  loadSettings,
  saveSettings,
  toggleSetting,
} from '../src/app/prefs';

class MemoryStorage {
  private data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

beforeEach(() => {
  document.documentElement.className = '';
});

describe('设置持久化', () => {
  it('没有记录时返回默认值，并尊重系统减少动态偏好', () => {
    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(new MemoryStorage(), true).reducedMotion).toBe(true);
  });

  it('保存后可完整读回', () => {
    const storage = new MemoryStorage();
    const custom = { muted: true, reducedMotion: true, largeText: true, highContrast: false };
    saveSettings(storage, custom);
    expect(loadSettings(storage)).toEqual(custom);
  });

  it('损坏的 JSON 回落到默认值', () => {
    const storage = new MemoryStorage();
    storage.setItem('golden-hour.mvs.settings.v1', '{oops');
    expect(loadSettings(storage)).toEqual(DEFAULT_SETTINGS);
  });

  it('切换单个设置不会改动其他项', () => {
    expect(toggleSetting(DEFAULT_SETTINGS, 'largeText').largeText).toBe(true);
    expect(toggleSetting(DEFAULT_SETTINGS, 'largeText').muted).toBe(false);
  });

  it('应用设置时切换根元素样式类', () => {
    applySettings(document, {
      muted: false,
      reducedMotion: true,
      largeText: true,
      highContrast: true,
    });
    const root = document.documentElement;
    expect(root.classList.contains('reduce-motion')).toBe(true);
    expect(root.classList.contains('large-text')).toBe(true);
    expect(root.classList.contains('high-contrast')).toBe(true);

    applySettings(document, DEFAULT_SETTINGS);
    expect(root.classList.contains('reduce-motion')).toBe(false);
  });
});
