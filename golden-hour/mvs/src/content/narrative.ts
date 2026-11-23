/**
 * 叙事内容：开局简报与行进中的无线电。
 * 纯数据与纯函数，不含剧本分支，也不读时钟或 DOM。
 */

export type NarrativeRole = 'dispatch' | 'neighbor' | 'warden' | 'radio';

export interface NarrativeLine {
  at: number;
  role: NarrativeRole;
  speaker: string;
  text: string;
}

/** 开局简报：解释“为什么进火场”。at 均为 0。 */
export const BRIEFING: NarrativeLine[] = [
  {
    at: 0,
    role: 'dispatch',
    speaker: '林队',
    text: '202 有人，专业队还没到。你先到场判断，别急着硬闯。',
  },
  {
    at: 0,
    role: 'neighbor',
    speaker: '邻居',
    text: '烟从 202 的窗缝里往外冒，我听见里面有人在拍门。',
  },
  {
    at: 0,
    role: 'warden',
    speaker: '楼长',
    text: '202 住着一家三口，老太太腿脚不好，走路得有人扶。',
  },
];

/** 行进中的无线电/邻居/楼长提示，按 at 升序。 */
export const RADIO_LINES: NarrativeLine[] = [
  {
    at: 8,
    role: 'radio',
    speaker: '林队',
    text: '报一下烟热：烟层到哪了，热得还能不能待？',
  },
  {
    at: 20,
    role: 'radio',
    speaker: '林队',
    text: '走消防梯，别从正门顶烟上；风向变了就换侧面上。',
  },
  {
    at: 35,
    role: 'neighbor',
    speaker: '邻居',
    text: '里面还有动静吗？202 那家人到底出来没有？',
  },
  {
    at: 50,
    role: 'radio',
    speaker: '林队',
    text: '烟热再涨就撤，别为了最后一个人把自己搭进去。',
  },
];

/** 取截至 t 的全部提示（含 t 当时），不修改原数组。 */
export function linesUpTo(lines: NarrativeLine[], t: number): NarrativeLine[] {
  return lines.filter((line) => line.at <= t);
}

/** 只取 (fromT, toT] 区间，用于“新触发”判定。 */
export function linesBetween(
  lines: NarrativeLine[],
  fromT: number,
  toT: number
): NarrativeLine[] {
  return lines.filter((line) => line.at > fromT && line.at <= toT);
}
