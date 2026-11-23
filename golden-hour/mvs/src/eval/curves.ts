/**
 * 结算暴露曲线：把采样点折成 SVG 路径。
 * 纯函数，不碰 DOM、不用随机数，便于测试与重放。
 */

import { clamp01 } from '../sim/spatial/fields';

export interface CurveSample {
  t: number;
  smoke: number;
  heat: number;
  fire?: number;
}

export interface CurveSet {
  width: number;
  height: number;
  padding: number;
  minT: number;
  maxT: number;
  hasData: boolean;
  smoke: string;
  heat: string;
  fire: string;
}

/** 过滤后的采样点：火势缺省按 0 补齐。 */
interface CleanSample {
  t: number;
  smoke: number;
  heat: number;
  fire: number;
}

const DEFAULT_WIDTH = 320;
const DEFAULT_HEIGHT = 96;
const DEFAULT_PADDING = 6;

/** 只保留有限的时间与数值；可选火势若给出也必须有限。 */
function isFiniteSample(sample: CurveSample): boolean {
  if (!Number.isFinite(sample.t)) return false;
  if (!Number.isFinite(sample.smoke) || !Number.isFinite(sample.heat)) return false;
  if (sample.fire !== undefined && !Number.isFinite(sample.fire)) return false;
  return true;
}

/**
 * 把某一项数值折成 `M x y L x y ...` 路径。
 * 时间映射到横向，数值 clamp01 后映射到纵向（越大越靠上）。
 */
function toPath(
  samples: CleanSample[],
  pick: (sample: CleanSample) => number,
  width: number,
  height: number,
  padding: number
): string {
  const firstT = samples[0].t;
  const spanT = samples[samples.length - 1].t - firstT;
  const innerW = width - padding * 2;
  const innerH = height - padding * 2;
  const segments: string[] = [];
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    // 只有一个时刻时所有点贴在左边界，避免除以零。
    const x = spanT <= 0 ? padding : padding + ((sample.t - firstT) / spanT) * innerW;
    const y = height - padding - clamp01(pick(sample)) * innerH;
    segments.push(`${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`);
  }
  return segments.join(' ');
}

export function buildCurvePaths(
  samples: CurveSample[],
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  padding = DEFAULT_PADDING
): CurveSet {
  // 复制、过滤、按时间升序；不改动调用方的数组。
  const clean: CleanSample[] = samples
    .filter(isFiniteSample)
    .map((sample) => ({
      t: sample.t,
      smoke: sample.smoke,
      heat: sample.heat,
      fire: sample.fire ?? 0,
    }))
    .sort((a, b) => a.t - b.t);

  const set: CurveSet = {
    width,
    height,
    padding,
    minT: 0,
    maxT: 0,
    hasData: clean.length > 0,
    smoke: '',
    heat: '',
    fire: '',
  };
  if (!clean.length) return set;

  set.minT = clean[0].t;
  set.maxT = clean[clean.length - 1].t;
  set.smoke = toPath(clean, (sample) => sample.smoke, width, height, padding);
  set.heat = toPath(clean, (sample) => sample.heat, width, height, padding);
  set.fire = toPath(clean, (sample) => sample.fire, width, height, padding);
  return set;
}
