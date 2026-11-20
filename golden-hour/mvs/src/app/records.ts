import type { DebriefCard } from '../eval/debrief';
import type { StorageLike } from './prefs';

export interface TrainingRecord {
  runs: number;
  bestDensity: number;
  rescued: number;
  lost: number;
  lastDensity: number;
  lastElapsedSec: number;
  doorChecks: number;
  waits: number;
  incidentsHandled: number;
  incidentsIgnored: number;
  seedPlays: Record<string, number>;
  lastSeed: string;
}

export const EMPTY_RECORD: TrainingRecord = {
  runs: 0,
  bestDensity: 0,
  rescued: 0,
  lost: 0,
  lastDensity: 0,
  lastElapsedSec: 0,
  doorChecks: 0,
  waits: 0,
  incidentsHandled: 0,
  incidentsIgnored: 0,
  seedPlays: {},
  lastSeed: '',
};

const RECORDS_KEY = 'golden-hour.mvs.records.v1';

const count = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;

const readPlays = (value: unknown): Record<string, number> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const plays: Record<string, number> = {};
  for (const [seed, times] of Object.entries(value)) {
    if (typeof times === 'number' && Number.isFinite(times) && times >= 0) {
      plays[seed] = times;
    }
  }
  return plays;
};

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
      doorChecks: count(parsed.doorChecks, 0),
      waits: count(parsed.waits, 0),
      incidentsHandled: count(parsed.incidentsHandled, 0),
      incidentsIgnored: count(parsed.incidentsIgnored, 0),
      seedPlays: readPlays(parsed.seedPlays),
      lastSeed: typeof parsed.lastSeed === 'string' ? parsed.lastSeed : '',
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
  const seedPlays = {
    ...previous.seedPlays,
    [card.seed]: (previous.seedPlays[card.seed] ?? 0) + 1,
  };

  return {
    runs: previous.runs + 1,
    bestDensity: Math.max(previous.bestDensity, card.decisionDensity),
    rescued: previous.rescued + card.tactical.rescued,
    lost: previous.lost + card.tactical.lost,
    lastDensity: card.decisionDensity,
    lastElapsedSec: card.tactical.elapsedSec,
    doorChecks: previous.doorChecks + (card.practice.doorChecked ? 1 : 0),
    waits: previous.waits + (card.practice.waited ? 1 : 0),
    incidentsHandled: previous.incidentsHandled + card.practice.incidentsResolved,
    incidentsIgnored: previous.incidentsIgnored + card.practice.incidentsIgnored,
    seedPlays,
    lastSeed: card.seed,
  };
}
