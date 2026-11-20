import type { Incident, SimState } from './types';

export function createIncidents(shift = 0): Incident[] {
  const neighborAt = Math.max(3, 8 + shift);
  const stairsAt = Math.max(neighborAt + 4, 18 + shift);

  return [
    {
      id: 'neighbor',
      at: neighborAt,
      deadline: neighborAt + 12,
      title: '102 有人呼救',
      detail: '陈桂英被反锁在家，烟已经从门缝进来。',
      options: [
        { id: 'coach', label: '指导她关门堵缝' },
        { id: 'divert', label: '让班组折返救人' },
        { id: 'ignore', label: '先处理回燃门' },
      ],
      resolved: false,
      choice: null,
      activatedAt: null,
    },
    {
      id: 'stairs',
      at: stairsAt,
      deadline: stairsAt + 10,
      title: '楼梯间异响',
      detail: '钢筋在响，粉尘往下落。',
      options: [
        { id: 'shore', label: '花时间加固' },
        { id: 'withdraw', label: '立刻撤出' },
        { id: 'ignore', label: '继续上楼' },
      ],
      resolved: false,
      choice: null,
      activatedAt: null,
    },
  ];
}

export function activeIncident(s: SimState): Incident | null {
  return s.incidents.find((i) => i.activatedAt !== null && !i.resolved) ?? null;
}

export function resolveIncident(s: SimState, id: string, choice: string): boolean {
  const incident = s.incidents.find((i) => i.id === id);
  if (!incident || incident.resolved || incident.activatedAt === null) return false;

  incident.resolved = true;
  incident.choice = choice;

  const option = incident.options.find((o) => o.id === choice);
  s.decisions.push({
    at: s.t,
    kind: choice === 'ignore' ? 'ignore' : 'incident',
    label: `${incident.title}：${option?.label ?? choice}`,
  });

  if (incident.id === 'neighbor') {
    if (choice === 'coach') {
      s.neighbor.saveAt = s.t + 3;
      s.crew.busyUntil = Math.max(s.crew.busyUntil, s.t + 3);
    } else if (choice === 'divert') {
      s.neighbor.saveAt = s.t + 8;
      s.crew.busyUntil = Math.max(s.crew.busyUntil, s.t + 8);
    } else {
      s.neighbor.doomAt = s.t + 10;
    }
  }

  if (incident.id === 'stairs') {
    if (choice === 'shore') {
      s.stairs.safe = true;
      s.crew.busyUntil = Math.max(s.crew.busyUntil, s.t + 4);
    } else if (choice === 'withdraw') {
      s.ended = true;
    } else {
      s.stairs.collapseAt = s.t + 8;
    }
  }

  return true;
}
