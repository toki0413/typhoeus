import type { SimState } from './types';
import { deriveScenario } from './scenario';
import { createIncidents } from './incidents';

export const INITIAL_EXTINGUISHERS = 2;

export function createWorld(seed: string): SimState {
  return {
    seed,
    scenario: deriveScenario(seed),
    t: 0,
    phase: 'plan',
    fire: 0.12,
    smoke: [0, 0],
    heat: [0, 0],
    exposure: { smoke: 0, heat: 0, strain: 0 },
    crew: {
      floor: 0,
      progress: 0,
      order: null,
      atDoor: false,
      injured: false,
      busyUntil: 0,
    },
    door: { checked: false, temp: 'unknown', waitUntil: null, safe: false, opened: false },
    victim: { alive: true, rescued: false },
    neighbor: { alive: true, saved: false, saveAt: null, doomAt: null },
    stairs: { safe: true, collapsed: false, collapseAt: null },
    incidents: createIncidents(),
    decisions: [],
    ended: false,
    resources: { extinguisher: INITIAL_EXTINGUISHERS },
    events: [],
  };
}
