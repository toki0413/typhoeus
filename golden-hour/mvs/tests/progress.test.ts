import { describe, it, expect } from 'vitest';
import {
  PROGRESS_KEY,
  emptyProgress,
  isUnlocked,
  loadProgress,
  parseProgress,
  recordRun,
  saveProgress,
  serializeProgress,
  type ProgressState,
} from '../src/app/progress';

class MemoryStorage {
  data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

/** 读取会抛错的存储，模拟隐私模式或配额问题。 */
const brokenStorage = {
  getItem(): string | null {
    throw new Error('storage unavailable');
  },
  setItem(): void {
    throw new Error('storage unavailable');
  },
};

describe('户型解锁进度', () => {
  it('空状态与坏 JSON 回退，序列化可往返', () => {
    expect(emptyProgress()).toEqual({ best: {}, cleared: [] });
    expect(parseProgress(null)).toEqual(emptyProgress());
    expect(parseProgress('')).toEqual(emptyProgress());
    expect(parseProgress('not-json')).toEqual(emptyProgress());
    expect(parseProgress('[1,2,3]')).toEqual(emptyProgress());
    expect(parseProgress(JSON.stringify({ best: 'x', cleared: 'y' }))).toEqual(emptyProgress());

    const state: ProgressState = {
      best: { classic: 88, narrow: 61 },
      cleared: ['classic', 'narrow'],
    };
    expect(parseProgress(serializeProgress(state))).toEqual(state);
  });

  it('解析时忽略非法数值与重复的已通关户型', () => {
    const parsed = parseProgress(
      JSON.stringify({
        best: { classic: 70, narrow: '80', courtyard: null },
        cleared: ['classic', 'classic', 3, 'narrow'],
      })
    );

    expect(parsed.best).toEqual({ classic: 70 });
    expect(parsed.cleared).toEqual(['classic', 'narrow']);
  });

  it('recordRun 只提高最高分，得分大于 0 时去重记入已通关', () => {
    const first = recordRun(emptyProgress(), 'classic', 62);
    expect(first.best.classic).toBe(62);
    expect(first.cleared).toEqual(['classic']);

    const lower = recordRun(first, 'classic', 40);
    expect(lower.best.classic).toBe(62);
    expect(lower.cleared).toEqual(['classic']);

    const higher = recordRun(lower, 'classic', 91);
    expect(higher.best.classic).toBe(91);
    expect(higher.cleared).toEqual(['classic']);

    const zero = recordRun(higher, 'narrow', 0);
    expect(zero.best.narrow).toBe(0);
    expect(zero.cleared).toEqual(['classic']);
  });

  it('isUnlocked：首个户型永远解锁，后续要求前一个已通关', () => {
    const ids = ['classic', 'narrow', 'courtyard'];
    const empty = emptyProgress();

    expect(isUnlocked(empty, ids, 'classic')).toBe(true);
    expect(isUnlocked(empty, ids, 'narrow')).toBe(false);
    expect(isUnlocked(empty, ids, 'courtyard')).toBe(false);
    expect(isUnlocked(empty, ids, 'unknown')).toBe(false);

    const clearedFirst = recordRun(empty, 'classic', 55);
    expect(isUnlocked(clearedFirst, ids, 'narrow')).toBe(true);
    expect(isUnlocked(clearedFirst, ids, 'courtyard')).toBe(false);

    // 跳过前一个户型通关不会解锁后面的户型。
    const skipped = recordRun(empty, 'courtyard', 70);
    expect(isUnlocked(skipped, ids, 'narrow')).toBe(false);
    expect(isUnlocked(skipped, ids, 'courtyard')).toBe(false);
  });

  it('load/save 使用注入的存储，存储失败时静默回退', () => {
    const storage = new MemoryStorage();
    const state = recordRun(emptyProgress(), 'classic', 77);

    saveProgress(state, storage);
    expect(storage.getItem(PROGRESS_KEY)).toBe(serializeProgress(state));
    expect(loadProgress(storage)).toEqual(state);

    expect(loadProgress(brokenStorage)).toEqual(emptyProgress());
    expect(() => saveProgress(state, brokenStorage)).not.toThrow();
  });

  it('recordRun 不修改入参', () => {
    const original: ProgressState = { best: { classic: 80 }, cleared: ['classic'] };
    const snapshot = JSON.parse(JSON.stringify(original)) as ProgressState;

    const next = recordRun(original, 'narrow', 70);

    expect(original).toEqual(snapshot);
    expect(next).not.toBe(original);
    expect(next.best).not.toBe(original.best);
    expect(next.cleared).not.toBe(original.cleared);
    expect(next.cleared).toEqual(['classic', 'narrow']);
  });
});
