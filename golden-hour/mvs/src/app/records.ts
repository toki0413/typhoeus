import type { DebriefCard } from '../eval/debrief';
import type { StorageLike } from './prefs';

export interface TrainingRecord {
  runs: number;
  bestDensity: number;
  rescued: number;
  lost: number;
  lastDensity: number;
  lastElapsedSec: number;
}

export const EMPTY_RECORD: TrainingRecord = {
  runs: 0,
  bestDensity: 0,
  rescued: 0,
  lost: 0,
  lastDensity: 0,
  lastElapsedSec: 0,
};

const RECORDS_KEY = 'golden-hour.mvs.records.v1';

const count = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;

export function loadRecords(storage: StorageLike | null): TrainingRecord {
  if (!storage) return { ...EMPTY_RECORD };

  try {
    const raw = storage.getItem(RECORDS_KEY);
    if (!raw) return { ...EMPTY_RECORD };
    const parsed = JSON.parse(raw) as Partial<Record<keyof TrainingRecord, unknown>>;
    return {
      runs: count(parsed.runs, 0),
      bestDensity: count(parsed.bestDensity, 0),
      rescued: count(parsed.rescued, 0),
      lost: count(parsed.lost, 0),
      lastDensity: count(parsed.lastDensity, 0),
      lastElapsedSec: count(parsed.lastElapsedSec, 0),
    };
  } catch {
    return { ...EMPTY_RECORD };
  }
}

export function saveRecords(storage: StorageLike | null, record: TrainingRecord): void {
  if (!storage) return;
  try {
    storage.setItem(RECORDS_KEY, JSON.stringify(record));
  } catch {
    // 存储不可用时仍允许完成本次训练。
  }
}

export function recordRun(previous: TrainingRecord, card: DebriefCard): TrainingRecord {
  return {
    runs: previous.runs + 1,
    bestDensity: Math.max(previous.bestDensity, card.decisionDensity),
    rescued: previous.rescued + card.tactical.rescued,
    lost: previous.lost + card.tactical.lost,
    lastDensity: card.decisionDensity,
    lastElapsedSec: card.tactical.elapsedSec,
  };
}
