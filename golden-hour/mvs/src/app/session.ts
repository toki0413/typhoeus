import type { SimState } from '../sim/types';
import { createWorld } from '../sim/world';
import { stepSim } from '../sim/step';

export function beginRun(s: SimState): void {
  if (s.phase !== 'plan') return;
  s.phase = 'execute';
  s.crew.order = { kind: 'search', floor: 1 };
  s.decisions.push({ at: s.t, kind: 'order', label: '下达搜索二层' });
}

export function advance(s: SimState, dt: number): { enteredDebrief: boolean } {
  if (s.phase !== 'execute') return { enteredDebrief: false };

  stepSim(s, dt);

  if (s.ended || s.door.opened) {
    s.phase = 'debrief';
    return { enteredDebrief: true };
  }
  return { enteredDebrief: false };
}

export function restart(s: SimState, seed = s.seed): void {
  Object.assign(s, createWorld(seed));
}
