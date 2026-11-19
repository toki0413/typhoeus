import type { SimState } from './types';
import { clamp01 } from './smoke';

export function suppressFire(s: SimState): boolean {
  if (s.phase !== 'execute' || s.resources.extinguisher <= 0) return false;

  s.resources.extinguisher -= 1;
  s.fire = clamp01(s.fire - 0.25);
  s.events.push({
    at: s.t,
    type: 'evidence',
    anchorId: 'K-EXTINGUISH',
    detail: '用灭火器压制一层火势',
  });
  return true;
}
