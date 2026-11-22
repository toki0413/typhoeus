export interface ScenarioDef {
  seed: string;
  name: string;
  brief: string;
}

export const SCENARIOS: ScenarioDef[] = [
  {
    seed: 'GH-FIRE-MVS',
    name: '标准局',
    brief: '基准火势、烟气与事件节奏。',
  },
  {
    seed: 'GH-FIRE-05',
    name: '浓烟早发局',
    brief: '烟气源头更重，202 与楼梯间的事件都来得更早。',
  },
  {
    seed: 'GH-FIRE-02',
    name: '缓烟晚发局',
    brief: '烟气扩散较慢，但两个事件会拖到更晚才出现。',
  },
];

export function scenarioFor(seed: string): ScenarioDef | undefined {
  return SCENARIOS.find((scenario) => scenario.seed === seed);
}

export function nextScenario(
  seed: string,
  plays: Record<string, number>
): ScenarioDef {
  const candidates = SCENARIOS.filter((scenario) => scenario.seed !== seed);
  const pool = candidates.length ? candidates : SCENARIOS;

  return [...pool].sort((a, b) => {
    const played = (plays[a.seed] ?? 0) - (plays[b.seed] ?? 0);
    return played !== 0 ? played : SCENARIOS.indexOf(a) - SCENARIOS.indexOf(b);
  })[0];
}
