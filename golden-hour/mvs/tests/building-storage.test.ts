import { describe, it, expect } from 'vitest';
import {
  bestStorageKey,
  parseBest,
  readBest,
  saveStorageKey,
  writeBest,
  type BestRecord,
} from '../src/app/buildingStorage';
import type { RunResult } from '../src/eval/score';

const run: RunResult = {
  rescued: 8,
  lost: 2,
  total: 10,
  seconds: 120,
  peakExposure: 0.4,
  wrongAgent: 1,
  airLeft: 0.2,
};

const record: BestRecord = {
  run,
  curve: [
    { t: 0, smoke: 0, heat: 0 },
    { t: 1, smoke: 0.2, heat: 0.1, fire: 0.3 },
    { t: 2, smoke: 'bad' },
  ] as never,
};

function storage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

describe('建筑入口存储', () => {
  it('最佳/存档键包含户型、种子与模式', () => {
    expect(bestStorageKey('classic', 7, 'multi5')).toBe('gh-best:classic:7:multi5');
    expect(saveStorageKey('classic', 7, 'multi5')).toBe('gh-save:classic:7:multi5');
  });

  it('兼容旧的纯 RunResult 记录', () => {
    const parsed = parseBest(run);
    expect(parsed).toEqual({ run, curve: [] });
  });

  it('解析新格式并过滤坏曲线点', () => {
    const parsed = parseBest(JSON.parse(JSON.stringify(record)));
    expect(parsed?.run).toEqual(run);
    expect(parsed?.curve).toHaveLength(2);
    expect(parsed?.curve[1]).toEqual({ t: 1, smoke: 0.2, heat: 0.1, fire: 0.3 });
  });

  it('损坏记录回退为 null', () => {
    expect(parseBest({ run: { rescued: 1 } })).toBeNull();
    expect(parseBest(null)).toBeNull();
  });

  it('读写往返与坏 JSON 安全', () => {
    const store = storage();
    expect(writeBest(store, 'k', record)).toBe(true);
    expect(readBest(store, 'k')?.run).toEqual(run);
    store.setItem('bad', 'not json');
    expect(readBest(store, 'bad')).toBeNull();
  });
});
