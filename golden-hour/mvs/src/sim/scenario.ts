import { hashSeed, mulberry32 } from './rng';
import type { ScenarioParams } from './types';

export function deriveScenario(seed: string): ScenarioParams {
  const rnd = mulberry32(hashSeed(seed));
  const lerp = (a: number, b: number) => a + (b - a) * rnd();

  return {
    fireGrowthEarly: lerp(0.01, 0.014),
    fireGrowthLate: lerp(0.018, 0.024),
    smokeSource: lerp(0.27, 0.33),
    smokeTransfer: lerp(0.1, 0.14),
    // 让不同种子的事件节奏也有区别，而不是只改烟火数值。
    incidentShift: lerp(-4, 6),
  };
}
