/**
 * Phase 5 · P5.1 材料表。
 *
 * 纯内容数据：只描述材料本身的火灾属性，不碰渲染、输入与随机数。
 * 燃料、火、热、烟、氧等场量仍由模拟层负责，这里只给出写入格子的入口。
 */

import type { Cell, FireClass } from '../sim/spatial/fields';

/** A 固体、B 液体、C 气体、D 金属、E 带电、F 食用油，顺序与场模型一致。 */
export const FIRE_CLASSES: FireClass[] = ['A', 'B', 'C', 'D', 'E', 'F'];

export interface Material {
  id: string;
  label: string;
  fireClass: FireClass;
  /** 0..1 可燃性倾向 */
  combustibility: number;
  /** 0..1 产烟系数（相对值，可 >1 的量级请归一化到 0..1，实际场里再乘） */
  smokeYield: number;
  /** 0..1 结构强度贡献 */
  strength: number;
}

export const MATERIALS: Material[] = [
  {
    id: 'wood',
    label: '木材',
    fireClass: 'A',
    combustibility: 0.8,
    smokeYield: 0.55,
    strength: 0.5,
  },
  {
    id: 'foam',
    label: '聚氨酯沙发',
    fireClass: 'A',
    combustibility: 0.9,
    smokeYield: 0.95,
    strength: 0.2,
  },
  {
    id: 'drywall',
    label: '石膏板',
    fireClass: 'A',
    combustibility: 0.1,
    smokeYield: 0.15,
    strength: 0.8,
  },
  {
    id: 'fabric',
    label: '布料',
    fireClass: 'A',
    combustibility: 0.75,
    smokeYield: 0.5,
    strength: 0.1,
  },
  {
    id: 'gasoline',
    label: '汽油',
    fireClass: 'B',
    combustibility: 0.98,
    smokeYield: 0.75,
    strength: 0,
  },
  {
    id: 'diesel',
    label: '柴油',
    fireClass: 'B',
    combustibility: 0.85,
    smokeYield: 0.9,
    strength: 0,
  },
  {
    id: 'propane',
    label: '丙烷',
    fireClass: 'C',
    combustibility: 0.95,
    smokeYield: 0.4,
    strength: 0,
  },
  {
    id: 'magnesium',
    label: '镁合金',
    fireClass: 'D',
    combustibility: 0.85,
    smokeYield: 0.85,
    strength: 0.6,
  },
  {
    id: 'pvc',
    label: 'PVC 电线',
    fireClass: 'E',
    combustibility: 0.6,
    smokeYield: 0.9,
    strength: 0.2,
  },
  {
    id: 'cooking-oil',
    label: '食用油',
    fireClass: 'F',
    combustibility: 0.7,
    smokeYield: 0.6,
    strength: 0,
  },
];

/** 按火灾类别筛选材料；某类没有材料时返回空数组。 */
export function materialsByClass(fireClass: FireClass): Material[] {
  return MATERIALS.filter((material) => material.fireClass === fireClass);
}

/** 每一类各有多少种材料，供内容完整性检查与 UI 展示。 */
export function coverageByClass(): Record<FireClass, number> {
  const coverage = {} as Record<FireClass, number>;
  for (const fireClass of FIRE_CLASSES) {
    coverage[fireClass] = materialsByClass(fireClass).length;
  }
  return coverage;
}

/**
 * 把材料写进一个格子：只覆盖 combustibility/smokeYield/fireClass，
 * 不动 fuel/fire/heat/smoke/oxygen 等运行期场量。
 */
export function applyMaterial(cell: Cell, material: Material): void {
  cell.combustibility = material.combustibility;
  cell.smokeYield = material.smokeYield;
  cell.fireClass = material.fireClass;
}
