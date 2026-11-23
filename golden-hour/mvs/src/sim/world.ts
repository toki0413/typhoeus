import type { SimState } from './types';
import { deriveScenario } from './scenario';
import { createIncidents } from './incidents';

export const INITIAL_EXTINGUISHERS = 2;

export function createWorld(seed: string): SimState {
  const scenario = deriveScenario(seed);

  return {
    seed,
    scenario,
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
      manual: false,
    },
    door: {
      checked: false,
      temp: 'unknown',
      waitUntil: null,
      waited: false,
      safe: false,
      opened: false,
    },
    victim: { alive: true, rescued: false, extracted: false },
    neighbor: { alive: true, saved: false, saveAt: null, doomAt: null },
    stairs: { safe: true, collapsed: false, collapseAt: null },
    incidents: createIncidents(scenario.incidentShift),
    decisions: [],
    ended: false,
    resources: { extinguisher: INITIAL_EXTINGUISHERS },
    events: [],
  };
}
