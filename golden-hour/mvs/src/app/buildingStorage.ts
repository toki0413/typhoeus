import type { RunResult } from '../eval/score';
import type { CurveSample } from '../eval/curves';

/** 最佳记录：运行结果 + 截断后的暴露曲线。 */
export interface BestRecord {
  run: RunResult;
  curve: CurveSample[];
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const RUN_KEYS = [
  'rescued',
  'lost',
  'total',
  'seconds',
  'peakExposure',
  'wrongAgent',
  'airLeft',
] as const;

export function bestStorageKey(layoutId: string, seed: number, mode: string): string {
  return `gh-best:${layoutId}:${seed}:${mode}`;
}

export function saveStorageKey(layoutId: string, seed: number, mode: string): string {
  return `gh-save:${layoutId}:${seed}:${mode}`;
}

export function isRunResult(value: unknown): value is RunResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return RUN_KEYS.every(
    (key) => typeof record[key] === 'number' && Number.isFinite(record[key] as number)
  );
}

/** 只保留数值合法的曲线采样点，坏点直接丢弃。 */
export function readCurve(value: unknown): CurveSample[] {
  if (!Array.isArray(value)) return [];
  const samples: CurveSample[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const sample = item as Record<string, unknown>;
    const { t, smoke, heat, fire } = sample;
    if (typeof t !== 'number' || !Number.isFinite(t)) continue;
    if (typeof smoke !== 'number' || !Number.isFinite(smoke)) continue;
    if (typeof heat !== 'number' || !Number.isFinite(heat)) continue;
    const cleaned: CurveSample = { t, smoke, heat };
    if (typeof fire === 'number' && Number.isFinite(fire)) cleaned.fire = fire;
    samples.push(cleaned);
  }
  return samples;
}

/** 兼容旧的纯 RunResult 格式（无曲线）。 */
export function parseBest(value: unknown): BestRecord | null {
  if (isRunResult(value)) return { run: value, curve: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isRunResult(record.run)) return null;
  return { run: record.run, curve: readCurve(record.curve) };
}

export function readBest(storage: StorageLike, key: string): BestRecord | null {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    return parseBest(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** 写入失败（隐私模式/配额）时静默放弃。 */
export function writeBest(storage: StorageLike, key: string, record: BestRecord): boolean {
  try {
    storage.setItem(key, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}
