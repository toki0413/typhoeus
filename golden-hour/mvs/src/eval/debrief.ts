import type { SimState } from '../sim/types';

export interface LearningRecord {
  anchorId: string;
  attempts: number;
  correct: number;
}

export interface DebriefCard {
  schemaVersion: 'mvs-1';
  seed: string;
  tactical: {
    rescued: number;
    trapped: number;
    lost: number;
    resourcesConsumed: Record<string, number>;
    elapsedSec: number;
    exposurePeak: { smoke: number; heat: number; strain: number };
  };
  learning: LearningRecord[];
  omissions: string[];
  timeline: Array<{ atSec: number; type: string; label: string }>;
  provenance: {
    standardEdition: string;
    assistedMode: boolean;
    evidenceGrade: 'A' | 'B';
    chapter: 1 | 2 | 3;
    chapterPreset: boolean;
  };
}

export function buildDebrief(s: SimState): DebriefCard {
  const map = new Map<string, LearningRecord>();

  for (const e of s.events) {
    if (!e.anchorId || e.anchorId.startsWith('O-') || e.anchorId === 'K-RESCUE') continue;
    const r = map.get(e.anchorId) ?? { anchorId: e.anchorId, attempts: 0, correct: 0 };
    r.attempts += 1;
    if (e.type === 'evidence' || e.type === 'rescue') r.correct += 1;
    map.set(e.anchorId, r);
  }

  const rescued = s.victim.rescued ? 1 : 0;
  const lost = s.victim.alive ? 0 : 1;
  const trapped = !s.victim.rescued && s.victim.alive ? 1 : 0;

  return {
    schemaVersion: 'mvs-1',
    seed: s.seed,
    tactical: {
      rescued,
      trapped,
      lost,
      // MVS 尚未建模资源消耗，接资源系统后从 state.resources 派生。
      resourcesConsumed: {},
      elapsedSec: Math.round(s.t),
      exposurePeak: {
        smoke: round2(s.exposure.smoke),
        heat: round2(s.exposure.heat),
        strain: round2(s.exposure.strain),
      },
    },
    learning: [...map.values()],
    omissions: s.events
      .filter((e) => e.type === 'omission')
      .map((e) => e.detail ?? e.anchorId ?? '未知遗漏'),
    timeline: s.events.map((e) => ({
      atSec: Math.round(e.at),
      type: e.type,
      label: e.detail ?? e.anchorId ?? '',
    })),
    provenance: {
      standardEdition: 'IFRC-2025',
      assistedMode: false,
      evidenceGrade: 'A',
      chapter: 2,
      chapterPreset: true,
    },
  };
}

const round2 = (v: number): number => Math.round(v * 100) / 100;
