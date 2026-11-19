import type { SimState } from './types';
import { clamp01, stepSmoke } from './smoke';

export function stepSim(s: SimState, dt: number): void {
  s.t += dt;

  const fireGrowth = s.t < 40 ? 0.045 : 0.085;
  s.fire = clamp01(s.fire + fireGrowth * dt);

  stepSmoke(s.smoke, s.fire, dt);

  for (let i = 0; i < s.smoke.length; i++) {
    const target = Math.max(0, s.fire - i * 0.13) * 0.85;
    s.heat[i] = clamp01(s.heat[i] + (target - s.heat[i]) * dt * 0.5);
  }

  if (s.crew.order) {
    const target = s.crew.order.floor;
    if (s.crew.floor < target) {
      s.crew.progress += dt * 0.2;
      if (s.crew.progress >= 1) {
        s.crew.progress -= 1;
        s.crew.floor += 1;
      }
    }
    s.crew.atDoor = s.crew.floor === 1 && s.crew.progress > 0.6;
  }

  const f = s.crew.floor;
  s.exposure.smoke = clamp01(s.exposure.smoke + s.smoke[f] * 0.55 * dt);
  s.exposure.heat = clamp01(s.exposure.heat + s.heat[f] * 0.22 * dt);
  s.exposure.strain = clamp01(s.exposure.strain + 0.06 * dt);

  if (s.door.waitUntil !== null && s.t >= s.door.waitUntil) {
    s.door.waitUntil = null;
    if (s.door.checked) {
      s.door.safe = true;
      s.events.push({
        at: s.t,
        type: 'evidence',
        anchorId: 'K-BACKDRAFT-WAIT',
        detail: '等待后烟色转灰白、呼吸减弱',
      });
    }
  }
}
