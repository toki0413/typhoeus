import type { SimState } from './types';
import { clamp01, stepSmoke } from './smoke';
import { resolveIncident } from './incidents';

export function stepSim(s: SimState, dt: number): void {
  s.t += dt;

  for (const incident of s.incidents) {
    if (incident.activatedAt === null && s.t >= incident.at) {
      incident.activatedAt = s.t;
    }
  }
  for (const incident of s.incidents) {
    if (incident.activatedAt !== null && !incident.resolved && s.t >= incident.deadline) {
      resolveIncident(s, incident.id, 'ignore');
    }
  }

  const fireGrowth = s.t < 40 ? s.scenario.fireGrowthEarly : s.scenario.fireGrowthLate;
  s.fire = clamp01(s.fire + fireGrowth * dt);

  stepSmoke(s.smoke, s.fire, dt, s.scenario.smokeSource, s.scenario.smokeTransfer);

  for (let i = 0; i < s.smoke.length; i++) {
    const target = Math.max(0, s.fire - i * 0.13) * 0.85;
    s.heat[i] = clamp01(s.heat[i] + (target - s.heat[i]) * dt * 0.5);
  }

  if (s.crew.order) {
    const target = Math.min(s.crew.order.floor, s.smoke.length - 1);
    if (s.t >= s.crew.busyUntil && s.crew.floor < target) {
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

  if (s.neighbor.saveAt !== null && !s.neighbor.saved && s.t >= s.neighbor.saveAt) {
    s.neighbor.saved = true;
    s.neighbor.alive = true;
    s.events.push({
      at: s.t,
      type: 'rescue',
      anchorId: 'K-NEIGHBOR-RESCUE',
      detail: '202 居民获救',
    });
  }

  if (s.neighbor.doomAt !== null && s.neighbor.alive && s.t >= s.neighbor.doomAt) {
    s.neighbor.alive = false;
    s.events.push({
      at: s.t,
      type: 'death',
      anchorId: 'K-VICTIM-LOST',
      detail: '202 居民未能获救',
    });
  }

  if (s.stairs.collapseAt !== null && !s.stairs.collapsed && s.t >= s.stairs.collapseAt) {
    s.stairs.collapsed = true;
    s.crew.injured = true;
    s.events.push({
      at: s.t,
      type: 'injury',
      anchorId: 'K-STAIRS-FAIL',
      detail: '楼梯坍塌，班组受伤',
    });
  }

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
