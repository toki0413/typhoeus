import type { Settings } from '../app/prefs';
import type { TrainingRecord } from '../app/records';

export interface ShellOptions {
  settings: Settings;
  onStart: () => void;
  onResume: () => void;
  onRestart: () => void;
  onTitle: () => void;
  onSettingsChange: (settings: Settings) => void;
}

export interface ShellApi {
  showTitle: () => void;
  showPause: () => void;
  hide: () => void;
  isOpen: () => boolean;
  setStats: (record: TrainingRecord) => void;
  setNotice: (message: string | null) => void;
}

type ToggleKey = Exclude<keyof Settings, 'volume'>;

interface ToggleDef {
  key: ToggleKey;
  label: string;
}

const TOGGLES: ToggleDef[] = [
  { key: 'muted', label: '音效' },
  { key: 'reducedMotion', label: '减少动态' },
  { key: 'largeText', label: '大字号' },
  { key: 'highContrast', label: '高对比' },
];

const isOn = (settings: Settings, key: ToggleKey): boolean =>
  key === 'muted' ? !settings.muted : settings[key];

export function createShell(root: HTMLElement, options: ShellOptions): ShellApi {
  let settings = { ...options.settings };
  let stats: TrainingRecord | null = null;

  root.innerHTML = `
    <section class="screen" data-screen="title">
      <div class="kicker">GOLDEN HOUR · MVS</div>
      <h1>黄金时间</h1>
      <p class="sub">老旧居民楼 · 火灾初期响应训练</p>
      <div class="brief">
        <p>你是先到场的社区应急班组。专业消防队还有十五分钟。</p>
        <p>楼里可能还有人。你看什么、先做什么，都会留下后果。</p>
      </div>
      <div class="actions">
        <button class="primary" data-action="start">开始训练</button>
      </div>
      <p class="hint">一次约 10–12 分钟 · 触屏可操作 · Esc 暂停</p>
      <p class="notice" data-notice hidden></p>
      <p class="stats" data-stats></p>
    </section>

    <section class="screen" data-screen="pause" hidden>
      <div class="kicker">PAUSED</div>
      <h1>已暂停</h1>
      <p class="sub">训练计时已停止，现场不会继续恶化。</p>
      <div class="actions">
        <button class="primary" data-action="resume">继续训练</button>
        <button data-action="restart">重新开始</button>
        <button data-action="title">返回标题</button>
      </div>
    </section>

    <section class="settings" aria-label="设置">
      <span class="settings-title">设置</span>
      ${TOGGLES.map(
        (toggle) =>
          `<button data-toggle="${toggle.key}" aria-pressed="false">${toggle.label}</button>`
      ).join('')}
      <label class="volume">
        <span>音量</span>
        <input type="range" min="0" max="100" step="5" data-volume aria-label="训练音量" />
        <span class="volume-value" data-volume-value></span>
      </label>
    </section>
  `;

  const titleScreen = root.querySelector<HTMLElement>('[data-screen="title"]')!;
  const pauseScreen = root.querySelector<HTMLElement>('[data-screen="pause"]')!;
  const statsLine = root.querySelector<HTMLElement>('[data-stats]')!;
  const noticeLine = root.querySelector<HTMLElement>('[data-notice]')!;
  const startButton = root.querySelector<HTMLButtonElement>('[data-action="start"]')!;
  const volumeInput = root.querySelector<HTMLInputElement>('[data-volume]')!;
  const volumeValue = root.querySelector<HTMLElement>('[data-volume-value]')!;

  function renderStats(): void {
    if (!stats) {
      statsLine.textContent = '还没有训练记录。';
      return;
    }
    if (stats.runs === 0) {
      statsLine.textContent = '还没有训练记录。';
      return;
    }
    statsLine.textContent =
      `第 ${stats.runs} 次训练 · 最佳决策密度 ${stats.bestDensity}/分钟` +
      ` · 累计救出 ${stats.rescued} 人 · 累计遇难 ${stats.lost} 人`;
  }

  function renderToggles(): void {
    for (const { key, label } of TOGGLES) {
      const button = root.querySelector<HTMLButtonElement>(`[data-toggle="${key}"]`)!;
      const on = isOn(settings, key);
      button.setAttribute('aria-pressed', String(on));
      button.textContent = `${label}：${on ? '开' : '关'}`;
    }
  }

  function renderVolume(): void {
    const percent = Math.round(settings.volume * 100);
    volumeInput.value = String(percent);
    volumeValue.textContent = `${percent}%`;
    volumeInput.setAttribute('aria-valuetext', `${percent}%`);
  }

  function setOpen(open: boolean): void {
    root.classList.toggle('open', open);
  }

  root.addEventListener('input', (event) => {
    const input = event.target as HTMLInputElement;
    if (!input.hasAttribute('data-volume')) return;
    const next = Number(input.value) / 100;
    if (!Number.isFinite(next)) return;
    settings = { ...settings, volume: Math.min(1, Math.max(0, next)) };
    renderVolume();
    options.onSettingsChange({ ...settings });
  });

  root.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest('button');
    if (!button) return;

    const toggleKey = button.dataset.toggle as ToggleKey | undefined;
    if (toggleKey) {
      settings = { ...settings, [toggleKey]: !settings[toggleKey] };
      renderToggles();
      options.onSettingsChange({ ...settings });
      return;
    }

    switch (button.dataset.action) {
      case 'start':
        setOpen(false);
        options.onStart();
        break;
      case 'resume':
        setOpen(false);
        options.onResume();
        break;
      case 'restart':
        setOpen(false);
        options.onRestart();
        break;
      case 'title':
        options.onTitle();
        break;
    }
  });

  renderStats();
  renderToggles();
  renderVolume();

  return {
    showTitle() {
      titleScreen.hidden = false;
      pauseScreen.hidden = true;
      renderStats();
      setOpen(true);
    },
    showPause() {
      titleScreen.hidden = true;
      pauseScreen.hidden = false;
      setOpen(true);
    },
    hide() {
      setOpen(false);
    },
    isOpen() {
      return root.classList.contains('open');
    },
    setStats(record) {
      stats = record;
      renderStats();
    },
    setNotice(message) {
      noticeLine.hidden = !message;
      noticeLine.textContent = message ?? '';
      startButton.disabled = Boolean(message);
    },
  };
}
