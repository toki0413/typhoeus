/**
 * Phase Z1 · 区域与居民内容。
 *
 * 纯内容数据：只描述一个救援区域里初始有哪些居民、是否初始起火，
 * 不碰渲染、输入与随机数。模拟层按这里的声明创建场景与人群。
 */

import type { FireClass } from '../sim/spatial/fields';

export interface ResidentSpec {
  id: string;
  /** 网格坐标 0..7 */
  x: number;
  y: number;
  health: number;
  panic: number;
  hidden: boolean;
}

export interface ZoneFireSpec {
  cells: [number, number][];
  /** 0..1 初始燃烧强度 */
  intensity: number;
  /** 可选最热源格，写入更高强度 */
  source?: [number, number];
  sourceIntensity?: number;
}

export interface ZoneSpec {
  roomId: string;
  label: string;
  fireClass: FireClass;
  fire?: ZoneFireSpec;
  residents: ResidentSpec[];
}

/** 内容层构造区域；保留为函数便于后续统一默认值与校验。 */
export function zone(spec: ZoneSpec): ZoneSpec {
  return spec;
}

/** 内容层构造居民；保留为函数便于后续统一默认值。 */
export function resident(spec: ResidentSpec): ResidentSpec {
  return spec;
}
