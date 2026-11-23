import { roomSummary, type RoomState } from '../sim/spatial/fields';

/** 房间场的五个关键量：火、烟、热、氧、结构。 */
export interface FieldSample {
  fire: number;
  smoke: number;
  heat: number;
  oxygen: number;
  structure: number;
}

/** 一次玩家动作及其前后场快照，用于因果复盘。 */
export interface ActionRecord {
  /** 动作唯一 id，如 rescue-A、open-door-3 */
  id: string;
  /** 动作发生的模拟时刻（秒） */
  at: number;
  /** 动词名，如 'open-door' | 'carry' | 'vent' */
  action: string;
  roomId: string;
  before: FieldSample;
  after: FieldSample;
}

export interface FieldDelta extends FieldSample {}

export interface DebriefEntry {
  actionId: string;
  at: number;
  action: string;
  roomId: string;
  delta: FieldDelta;
  /** 中文因果解释：为什么场变成这样 */
  summary: string;
}

/** 判定“有变化”的最小阈值，滤掉浮点噪声。 */
const EPS = 1e-4;

/** 读取房间聚合场；只取复盘需要的五项，与 roomSummary 保持一致。 */
export function sampleRoom(room: RoomState): FieldSample {
  const s = roomSummary(room);
  return {
    fire: s.fire,
    smoke: s.smoke,
    heat: s.heat,
    oxygen: s.oxygen,
    structure: s.structure,
  };
}

/** 逐项求差：after - before。 */
export function fieldDelta(before: FieldSample, after: FieldSample): FieldDelta {
  return {
    fire: after.fire - before.fire,
    smoke: after.smoke - before.smoke,
    heat: after.heat - before.heat,
    oxygen: after.oxygen - before.oxygen,
    structure: after.structure - before.structure,
  };
}

function significant(v: number): boolean {
  return Math.abs(v) >= EPS;
}

/**
 * 由 delta 的符号与大小拼出中文因果解释。
 * 同一动作在不同场变化下会得到不同措辞与数值，而非同一句模板。
 */
function describe(action: string, roomId: string, d: FieldDelta): string {
  const head = `${action} 在 ${roomId}`;
  const parts: string[] = [];

  if (
    !significant(d.fire) &&
    !significant(d.smoke) &&
    !significant(d.heat) &&
    !significant(d.oxygen) &&
    !significant(d.structure)
  ) {
    return `场没有明显变化：${head} 此刻没有产生效果`;
  }

  if (significant(d.fire) && d.fire < 0 && significant(d.heat) && d.heat < 0) {
    parts.push('压低了火势并带走热量');
  } else if (significant(d.fire) && d.fire < 0) {
    parts.push('削弱了火势');
  } else if (significant(d.heat) && d.heat < 0) {
    parts.push('带走了热量');
  } else if (significant(d.fire) && d.fire > 0) {
    parts.push('火势上升');
  } else if (significant(d.heat) && d.heat > 0) {
    parts.push('热量积聚');
  }

  if (significant(d.oxygen) && d.oxygen > 0) {
    parts.push('通风补充了氧气');
  } else if (significant(d.oxygen) && d.oxygen < 0) {
    parts.push('氧气被消耗');
  }

  if (significant(d.smoke) && d.smoke > 0) {
    parts.push('烟气增多');
  } else if (significant(d.smoke) && d.smoke < 0) {
    parts.push('排烟使烟气减少');
  }

  if (significant(d.structure) && d.structure < 0) {
    parts.push('结构受损');
  } else if (significant(d.structure) && d.structure > 0) {
    parts.push('结构略有恢复');
  }

  if (parts.length === 0) parts.push('场发生了变化');

  const metrics = [
    `火 ${d.fire.toFixed(2)}`,
    `烟 ${d.smoke.toFixed(2)}`,
    `热 ${d.heat.toFixed(2)}`,
    `氧 ${d.oxygen.toFixed(2)}`,
    `结构 ${d.structure.toFixed(2)}`,
  ].join('，');

  return `${head}：${parts.join('；')}（${metrics}）`;
}

/** 把单条动作记录翻译成可读的因果复盘条目。 */
export function explainAction(record: ActionRecord): DebriefEntry {
  const delta = fieldDelta(record.before, record.after);
  return {
    actionId: record.id,
    at: record.at,
    action: record.action,
    roomId: record.roomId,
    delta,
    summary: describe(record.action, record.roomId, delta),
  };
}

/** 按输入顺序逐条复盘，保证 1:1 对应。 */
export function buildDebrief(records: ActionRecord[]): DebriefEntry[] {
  return records.map(explainAction);
}
