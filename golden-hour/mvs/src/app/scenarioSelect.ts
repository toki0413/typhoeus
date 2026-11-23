export type ScenarioId = 'tutorial' | 'room' | 'building';

export interface ScenarioEntry {
  id: ScenarioId;
  label: string;
  href: string;
}

export const SCENARIO_ENTRIES: ScenarioEntry[] = [
  { id: 'tutorial', label: '教学关', href: './' },
  { id: 'room', label: '单房间原型', href: './room.html' },
  { id: 'building', label: '建筑沙盒（实验）', href: './building.html' },
];

/** 从 location.search 解析场景；未知或缺失时回退教学关。 */
export function resolveScenario(search: string): ScenarioId {
  const value = new URLSearchParams(search).get('scenario');
  if (value === 'room' || value === 'building') return value;
  return 'tutorial';
}
