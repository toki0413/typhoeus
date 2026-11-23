import { describe, it, expect } from 'vitest';
import {
  APP_VERSION,
  DIAGNOSTICS_KEY,
  createDiagnostics,
  installDiagnostics,
  parseDiagnostics,
  recordEvent,
  serializeDiagnostics,
  snapshot,
} from '../src/app/diagnostics';

describe('诊断与版本', () => {
  it('事件环形缓冲只保留最近 50 条', () => {
    const state = createDiagnostics();
    for (let i = 0; i < 60; i++) recordEvent(state, 'info', `event-${i}`, i);
    expect(state.events).toHaveLength(50);
    expect(state.events[0].detail).toBe('event-10');
    expect(state.events[49].detail).toBe('event-59');
  });

  it('detail 截断到 300 字符，snapshot 为副本', () => {
    const state = createDiagnostics();
    recordEvent(state, 'error', 'x'.repeat(500), 1);
    expect(state.events[0].detail).toHaveLength(300);
    const copy = snapshot(state);
    copy.events[0].detail = 'changed';
    expect(state.events[0].detail).not.toBe('changed');
  });

  it('序列化往返保持版本与事件', () => {
    const state = createDiagnostics();
    recordEvent(state, 'run', '{"rescued":10}', 12);
    const parsed = parseDiagnostics(serializeDiagnostics(state));
    expect(parsed.version).toBe(APP_VERSION);
    expect(parsed.events).toEqual(state.events);
  });

  it('坏 JSON 与版本不匹配回退为空状态', () => {
    expect(parseDiagnostics('not json').events).toHaveLength(0);
    const raw = JSON.stringify({ version: '0.0.1', events: [{ at: 1, kind: 'x', detail: 'y' }] });
    expect(parseDiagnostics(raw).events).toHaveLength(0);
  });

  it('安装后捕获 error 并写入 localStorage', () => {
    const listeners: Record<string, (event: unknown) => void> = {};
    const storage = new Map<string, string>();
    const win = {
      addEventListener: (name: string, fn: (event: unknown) => void) => {
        listeners[name] = fn;
      },
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    } as unknown as Window;

    const handle = installDiagnostics(win);
    listeners.error({ message: 'boom' });
    const saved = parseDiagnostics(storage.get(DIAGNOSTICS_KEY) ?? null);
    expect(saved.events.at(-1)?.detail).toBe('boom');
    expect(handle.snapshot().events.at(-1)?.kind).toBe('error');
  });
});
