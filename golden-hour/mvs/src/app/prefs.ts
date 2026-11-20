export interface Settings {
  muted: boolean;
  reducedMotion: boolean;
  largeText: boolean;
  highContrast: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  muted: false,
  reducedMotion: false,
  largeText: false,
  highContrast: false,
};

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const SETTINGS_KEY = 'golden-hour.mvs.settings.v1';

export function loadSettings(
  storage: StorageLike | null,
  prefersReducedMotion = false
): Settings {
  const fallback: Settings = { ...DEFAULT_SETTINGS, reducedMotion: prefersReducedMotion };
  if (!storage) return fallback;

  try {
    const raw = storage.getItem(SETTINGS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Record<keyof Settings, unknown>>;
    const read = (key: keyof Settings): boolean =>
      typeof parsed[key] === 'boolean' ? (parsed[key] as boolean) : fallback[key];
    return {
      muted: read('muted'),
      reducedMotion: read('reducedMotion'),
      largeText: read('largeText'),
      highContrast: read('highContrast'),
    };
  } catch {
    return fallback;
  }
}

export function saveSettings(storage: StorageLike | null, settings: Settings): void {
  if (!storage) return;
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // 隐私模式或配额用尽时静默降级，不影响训练。
  }
}

export function toggleSetting(settings: Settings, key: keyof Settings): Settings {
  return { ...settings, [key]: !settings[key] };
}

export function applySettings(doc: Document, settings: Settings): void {
  const root = doc.documentElement;
  root.classList.toggle('reduce-motion', settings.reducedMotion);
  root.classList.toggle('large-text', settings.largeText);
  root.classList.toggle('high-contrast', settings.highContrast);
}
