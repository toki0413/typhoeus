import type { SimState } from './types';
import { clamp01, stepSmoke } from './smoke';

export function stepSim(s: SimState, dt: number): void {
  s.t += dt;

  const fireGrowth = s.t < 40 ? 0.012 : 0.02;
  s.fire = clamp01(s.fire + fireGrowth * dt);

  stepSmoke(s.smoke, s.fire, dt);

  for (let i = 0; i < s.smoke.length; i++) {
    const target = Math.max(0, s.fire - i * 0.13) * 0.85;
    s.heat[i] = clamp01(s.heat[i] + (target - s.heat[i]) * dt * 0.5);
  }

  if (s.crew.order) {
    const target = Math.min(s.crew.order.floor, s.smoke.length - 1);
    if (s.crew.floor < target) {
      s.crew.progress += dt * 0.2;
      if (s.crew.progress >= 1) {
        s.crew.progress -= 1;
        s.crew.floor += 1;
      }
    }
    s.crew.atDoor = s.crew.floor === 1 && target === 1;
  } else {
    s.crew.atDoor = false;
  }

  const f = Math.min(s.crew.floor, s.smoke.length - 1);
  s.exposure.smoke = clamp01(s.exposure.smoke + s.smoke[f] * 0.55 * dt);
  s.exposure.heat = clamp01(s.exposure.heat + s.heat[f] * 0.22 * dt);
  s.exposure.strain = clamp01(s.exposure.strain + 0.06 * dt);

  if (!s.door.opened && !s.door.safe && s.door.waitUntil !== null && s.t >= s.door.waitUntil) {
    s.door.waitUntil = null;
    if (s.door.checked && s.door.temp === 'hot') {
      s.door.safe = true;
      s.events.push({
        at: s.t,
        type: 'evidence',
        anchorId: 'K-BACKDRAFT-WAIT',
        detail: '等待 30 秒后开门',
      });
    }
  }
}
