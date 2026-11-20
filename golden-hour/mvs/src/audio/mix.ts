import type { SimState } from '../sim/types';
import { clamp01 } from '../sim/smoke';
import { activeIncident } from '../sim/incidents';

export interface AudioSpatial {
  firePan: number;
  doorPan: number;
  stairsPan: number;
  crewPan: number;
}

export const DEFAULT_SPATIAL: AudioSpatial = {
  firePan: -0.35,
  doorPan: 0.3,
  stairsPan: -0.6,
  crewPan: 0,
};

export interface MixParams {
  fire: number;
  severity: number;
  crackleRate: number;
  crackleGain: number;
  airGain: number;
  muffleHz: number;
  heartbeatBpm: number;
  breathInterval: number;
  stepInterval: number;
  moving: boolean;
  siren: number;
  urgent: boolean;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export function mixFromState(s: SimState): MixParams {
  const fire = clamp01(s.fire);
  const floor = Math.min(s.crew.floor, s.smoke.length - 1);
  const smoke = s.smoke[floor] ?? 0;

  // 门把烫手时，呼吸和心跳会先于身体暴露作出反应。
  const doorStress =
    s.crew.atDoor && s.door.checked && s.door.temp === 'hot' && !s.door.opened ? 0.18 : 0;

  // 烟气暴露、体力消耗与受伤共同决定“感官被压住”的程度。
  const severity = clamp01(
    Math.max(
      smoke,
      s.exposure.smoke * 0.9,
      s.exposure.strain * 0.6,
      s.crew.injured ? 0.88 : 0,
      doorStress
    )
  );

  const heartLoad = clamp01(
    Math.max(
      smoke,
      s.exposure.smoke * 0.85,
      s.exposure.strain * 0.7,
      s.crew.injured ? 0.9 : 0,
      doorStress * 1.4
    )
  );

  const target = s.crew.order
    ? Math.min(s.crew.order.floor, s.smoke.length - 1)
    : s.crew.floor;
  const moving =
    Boolean(s.crew.order) && s.t >= s.crew.busyUntil && s.crew.floor < target;

  const incident = activeIncident(s);
  const urgent = incident !== null && incident.deadline - s.t <= 6;

  return {
    fire,
    severity,
    crackleRate: 1.2 + 8.8 * fire,
    crackleGain: 0.35 + 0.65 * fire,
    airGain: 0.2 + smoke * 0.8,
    // 烟气与受伤让高频先消失，像隔着一层楼板听。
    muffleHz: clamp(16000 - 14500 * Math.pow(severity, 1.6), 700, 16000),
    heartbeatBpm: clamp(62 + 60 * heartLoad + (s.crew.injured ? 12 : 0), 58, 145),
    breathInterval: clamp(3.8 - 2.5 * s.exposure.strain, 1.1, 3.8),
    stepInterval: clamp(0.54 - 0.16 * s.exposure.strain, 0.34, 0.54),
    moving,
    siren: clamp01((s.t - 18) / 30) * 0.55,
    urgent,
  };
}
