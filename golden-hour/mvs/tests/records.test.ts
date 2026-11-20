import { describe, it, expect } from 'vitest';
import {
  EMPTY_RECORD,
  loadRecords,
  recordRun,
  saveRecords,
} from '../src/app/records';
import type { DebriefCard } from '../src/eval/debrief';

class MemoryStorage {
  data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

function card(
  rescued: number,
  lost: number,
  density: number,
  seed = 'x',
  practice = {
    doorChecked: false,
    waited: false,
    incidentsResolved: 0,
    incidentsIgnored: 0,
  }
): DebriefCard {
  return {
    schemaVersion: 'mvs-2',
    seed,
    objectives: [],
    practice,
    tactical: {
      rescued,
      trapped: 0,
      lost,
      resourcesConsumed: {},
      elapsedSec: 48,
      exposurePeak: { smoke: 0.2, heat: 0.1, strain: 0.3 },
      crewInjured: false,
      neighborSaved: false,
      neighborLost: false,
    },
    learning: [],
    omissions: [],
    decisions: [],
    decisionDensity: density,
    timeline: [],
    provenance: {
      standardEdition: 'IFRC-2025',
      assistedMode: false,
      evidenceGrade: 'A',
      chapter: 2,
      chapterPreset: true,
    },
  };
}

describe('训练记录', () => {
  it('没有存储时返回空记录', () => {
    expect(loadRecords(null)).toEqual(EMPTY_RECORD);
    expect(loadRecords(new MemoryStorage())).toEqual(EMPTY_RECORD);
  });

  it('累加局数、救援与遇难，并保留最高决策密度', () => {
    const first = recordRun(EMPTY_RECORD, card(1, 0, 4.2));
    expect(first.runs).toBe(1);
    expect(first.bestDensity).toBe(4.2);
    expect(first.rescued).toBe(1);

    const second = recordRun(first, card(0, 1, 6.1));
    expect(second.runs).toBe(2);
    expect(second.bestDensity).toBe(6.1);
    expect(second.rescued).toBe(1);
    expect(second.lost).toBe(1);

    const third = recordRun(second, card(1, 0, 3));
    expect(third.bestDensity).toBe(6.1);
    expect(third.lastDensity).toBe(3);
  });

  it('累计训练行为与场景次数，并记录最后场景', () => {
    const first = recordRun(
      EMPTY_RECORD,
      card(1, 0, 4, 'A', {
        doorChecked: true,
        waited: true,
        incidentsResolved: 1,
        incidentsIgnored: 1,
      })
    );
    expect(first.doorChecks).toBe(1);
    expect(first.waits).toBe(1);
    expect(first.incidentsHandled).toBe(1);
    expect(first.incidentsIgnored).toBe(1);
    expect(first.seedPlays).toEqual({ A: 1 });
    expect(first.lastSeed).toBe('A');

    const second = recordRun(first, card(0, 1, 3, 'B'));
    expect(second.doorChecks).toBe(1);
    expect(second.seedPlays).toEqual({ A: 1, B: 1 });
    expect(second.lastSeed).toBe('B');
  });

  it('读回缺失的新字段时补零，而不是产生 NaN', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      'golden-hour.mvs.records.v1',
      JSON.stringify({ runs: 2, bestDensity: 5, rescued: 1, lost: 0 })
    );
    const record = loadRecords(storage);
    expect(record.runs).toBe(2);
    expect(record.doorChecks).toBe(0);
    expect(record.seedPlays).toEqual({});
    expect(record.lastSeed).toBe('');
  });

  it('存储后可读回，损坏数据回落为空记录', () => {
    const storage = new MemoryStorage();
    const saved = recordRun(EMPTY_RECORD, card(1, 0, 5));
    saveRecords(storage, saved);
    expect(loadRecords(storage)).toEqual(saved);

    storage.setItem('golden-hour.mvs.records.v1', 'not-json');
    expect(loadRecords(storage)).toEqual(EMPTY_RECORD);
  });
});
