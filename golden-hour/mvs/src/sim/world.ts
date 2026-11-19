import type { SimState } from './types';
import { deriveScenario } from './scenario';

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
    crew: { floor: 0, progress: 0, order: null, atDoor: false },
    door: { checked: false, temp: 'unknown', waitUntil: null, safe: false, opened: false },
    victim: { alive: true, rescued: false },
    resources: { extinguisher: 2, rope: 1, kit: 1 },
    events: [],
  };
}
