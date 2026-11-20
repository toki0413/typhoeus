export interface RadioLine {
  at: number;
  speaker: string;
  text: string;
}

export const RADIO_SCRIPT: RadioLine[] = [
  {
    at: 0,
    speaker: '林队',
    text: '老楼厨房起火，楼里还有人。最近的队十五分钟到。你先看，别急着进。',
  },
  {
    at: 4,
    speaker: '王姨',
    text: '201 的两个孩子已经被邻居救出来了，你们先去别处吧。',
  },
  {
    at: 8,
    speaker: '林队',
    text: '102 有人在敲门。去不去，你自己判断。',
  },
  {
    at: 18,
    speaker: '老周',
    text: '你摸过门把没有？楼梯在响，别硬上。',
  },
  {
    at: 30,
    speaker: '王姨',
    text: '我好像听见孩子在哭……是不是我刚才看错了。',
  },
  {
    at: 42,
    speaker: '林队',
    text: '专业队还有五分钟。里面什么情况，简短说。',
  },
];

export function radioLineTime(line: RadioLine, shift = 0): number {
  return line.at === 0 ? 0 : Math.max(0.5, line.at + shift);
}

export function radioLinesUpTo(t: number, shift = 0): number {
  let count = 0;
  while (
    count < RADIO_SCRIPT.length &&
    t >= radioLineTime(RADIO_SCRIPT[count], shift)
  ) {
    count += 1;
  }
  return count;
}
