import type { SimState } from '../sim/types';

export type ObjectiveId = 'door' | 'wait' | 'priority';

export interface ObjectiveEvidence {
  id: ObjectiveId;
  title: string;
  observed: string;
  outcome: string;
  practiced: boolean;
}

const stairsOutcome = (s: SimState): string => {
  const stairs = s.incidents.find((incident) => incident.id === 'stairs');
  if (s.stairs.collapsed) return '楼梯坍塌，班组受伤';
  if (stairs?.choice === 'shore') return '楼梯已加固';
  if (s.ended) return '班组撤出';
  if (stairs?.resolved) return '楼梯异响未处理';
  return '楼梯尚未受影响';
};

export function buildObjectives(s: SimState): ObjectiveEvidence[] {
  const doorObserved = s.door.checked
    ? '用手背试了门把温度'
    : s.door.opened
      ? '没有试门把温度就开门'
      : '还没有试门把温度';

  const doorOutcome = !s.door.opened
    ? s.door.checked
      ? '门把烫手，门后仍是未知'
      : '门后仍是未知'
    : s.victim.rescued
      ? '门后是被困者，已救出'
      : !s.victim.alive
        ? '开门后发生回燃，班组受伤，被困者遇难'
        : '开门后进入';

  const waitObserved = s.door.waited ? '选择了在门外等待' : '没有在门外等待';
  const waitOutcome = !s.door.opened
    ? s.door.safe
      ? '门温已下降'
      : '门仍然烫手'
    : s.door.safe
      ? '门温下降，开门后没有回燃'
      : '开门后发生回燃';

  const handled = s.decisions.filter(
    (decision) => decision.kind === 'incident' || decision.kind === 'ignore'
  );
  const titles = handled.map((decision) => decision.label.split('：')[0]);
  const priorityObserved = titles.length
    ? `先处理了「${titles[0]}」${titles[1] ? `，随后处理「${titles[1]}」` : ''}`
    : '没有处理并发事件';

  const neighborOutcome = s.neighbor.saved
    ? '202 获救'
    : !s.neighbor.alive
      ? '202 遇难'
      : '202 仍未脱险';
  const priorityOutcome = `${neighborOutcome}；${stairsOutcome(s)}`;

  return [
    {
      id: 'door',
      title: '门温判断',
      observed: doorObserved,
      outcome: doorOutcome,
      practiced: s.door.checked,
    },
    {
      id: 'wait',
      title: '门外等待',
      observed: waitObserved,
      outcome: waitOutcome,
      practiced: s.door.waited,
    },
    {
      id: 'priority',
      title: '并发事件优先级',
      observed: priorityObserved,
      outcome: priorityOutcome,
      practiced: handled.length > 0,
    },
  ];
}
