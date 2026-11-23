/**
 * 轻量诊断：版本号、全局错误捕获与匿名运行摘要。
 *
 * 只写 localStorage 环形缓冲，不发网络请求；便于线下排查与后续接入上报。
 */

export const APP_VERSION = '0.3.0';

export type DiagnosticKind = 'error' | 'run' | 'zone' | 'drill' | 'info';

export interface DiagnosticEvent {
  at: number;
  kind: DiagnosticKind;
  detail: string;
}

export interface DiagnosticsState {
  version: string;
  events: DiagnosticEvent[];
}

export const DIAGNOSTICS_KEY = 'gh-diag:v1';
const MAX_EVENTS = 50;
const MAX_DETAIL = 300;

export function createDiagnostics(version = APP_VERSION): DiagnosticsState {
  return { version, events: [] };
}

/** 追加一条事件；超过上限时丢弃最旧的，detail 截断避免写入过大。 */
export function recordEvent(
  state: DiagnosticsState,
  kind: DiagnosticKind,
  detail: string,
  at: number
): DiagnosticsState {
  state.events.push({
    at,
    kind,
    detail: String(detail).slice(0, MAX_DETAIL),
  });
  if (state.events.length > MAX_EVENTS) {
    state.events.splice(0, state.events.length - MAX_EVENTS);
  }
  return state;
}

/** 返回副本，调用方无法篡改内部状态。 */
export function snapshot(state: DiagnosticsState): DiagnosticsState {
  return {
    version: state.version,
    events: state.events.map((event) => ({ ...event })),
  };
}

export function serializeDiagnostics(state: DiagnosticsState): string {
  return JSON.stringify(snapshot(state));
}

export function parseDiagnostics(raw: string | null, version = APP_VERSION): DiagnosticsState {
  if (!raw) return createDiagnostics(version);
  try {
    const parsed = JSON.parse(raw) as Partial<DiagnosticsState>;
    if (parsed.version !== version || !Array.isArray(parsed.events)) {
      return createDiagnostics(version);
    }
    const events: DiagnosticEvent[] = [];
    for (const event of parsed.events) {
      if (!event || typeof event.detail !== 'string') continue;
      if (typeof event.at !== 'number' || typeof event.kind !== 'string') continue;
      events.push({
        at: event.at,
        kind: event.kind as DiagnosticKind,
        detail: event.detail.slice(0, MAX_DETAIL),
      });
    }
    return { version, events: events.slice(-MAX_EVENTS) };
  } catch {
    return createDiagnostics(version);
  }
}

export interface DiagnosticsHandle {
  state: DiagnosticsState;
  record(kind: DiagnosticKind, detail: string): void;
  snapshot(): DiagnosticsState;
  clear(): void;
}

type DiagnosticsWindow = Window & {
  __ghDiag?: { version: string; snapshot(): DiagnosticsState; clear(): void };
};

function readStorage(win: DiagnosticsWindow): string | null {
  try {
    return win.localStorage.getItem(DIAGNOSTICS_KEY);
  } catch {
    return null;
  }
}

function writeStorage(win: DiagnosticsWindow, state: DiagnosticsState): void {
  try {
    win.localStorage.setItem(DIAGNOSTICS_KEY, serializeDiagnostics(state));
  } catch {
    // 隐私模式或配额不足时静默失败，不影响游戏。
  }
}

/** 安装全局错误捕获，并把句柄挂到 window.__ghDiag。 */
export function installDiagnostics(
  win: DiagnosticsWindow,
  version = APP_VERSION
): DiagnosticsHandle {
  const state = parseDiagnostics(readStorage(win), version);
  const record = (kind: DiagnosticKind, detail: string): void => {
    recordEvent(state, kind, detail, Date.now());
    writeStorage(win, state);
  };

  win.addEventListener('error', (event) => {
    const message =
      (event as ErrorEvent).message ||
      ((event as ErrorEvent).error as Error | undefined)?.message ||
      'unknown error';
    record('error', message);
  });
  win.addEventListener('unhandledrejection', (event) => {
    record('error', String((event as PromiseRejectionEvent).reason ?? 'unhandled rejection'));
  });

  const handle: DiagnosticsHandle = {
    state,
    record,
    snapshot: () => snapshot(state),
    clear: () => {
      state.events = [];
      writeStorage(win, state);
    },
  };
  win.__ghDiag = {
    version,
    snapshot: handle.snapshot,
    clear: handle.clear,
  };

  console.info(`[golden-hour] v${version} · diagnostics ready`);
  return handle;
}
