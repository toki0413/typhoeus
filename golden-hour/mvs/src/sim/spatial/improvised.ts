import { FIRE_CLASSES, type AgentId } from './agents';
import { cellAt, clamp01, type FireClass, type RoomState } from './fields';
import { breakOpening, isolate, spray, type SprayResult } from './verbs';

/**
 * 就地取材：没有对应灭火器、或者器材过期压力不足时，用生活里能找到的东西应急。
 *
 * 每一项都有明确的适用边界——“湿棉被能压 A 类小火，但盖不住 B 类液体火”，
 * 这就是要传达的专业判断，而不是给玩家一个万能按钮。
 */
export type ImprovisedId =
  | 'wetBlanket'
  | 'potLid'
  | 'salt'
  | 'bucketWater'
  | 'wetTowel'
  | 'powerCut'
  | 'closeDoor'
  | 'kickWindow';

export interface ImprovisedSpec {
  id: ImprovisedId;
  label: string;
  /** 等价灭火剂；null 表示个人防护或场景操作 */
  agent: AgentId | null;
  /** 相对专业器材的效率 */
  factor: number;
  validOn: FireClass[];
  invalidOn: FireClass[];
  lesson: string;
  effect?: 'power-cut' | 'close-door' | 'protection' | 'break';
}

export const IMPROVISED: Record<ImprovisedId, ImprovisedSpec> = {
  wetBlanket: {
    id: 'wetBlanket',
    label: '湿棉被覆盖',
    agent: 'blanket',
    factor: 0.7,
    validOn: ['A', 'F'],
    invalidOn: ['B', 'C', 'D', 'E'],
    lesson:
      '湿棉被能隔绝空气，适合压灭 A 类固体小火和 F 类油锅；对液体火盖不严会复燃，对带电火会导电。',
  },
  potLid: {
    id: 'potLid',
    label: '锅盖窒息',
    agent: 'blanket',
    factor: 1,
    validOn: ['F'],
    invalidOn: ['A', 'B', 'C', 'D', 'E'],
    lesson: 'F 类油锅先关火，再从侧面把锅盖推上去，绝不能用水——水会瞬间汽化把热油带起来。',
  },
  salt: {
    id: 'salt',
    label: '干食盐覆盖',
    agent: 'sand',
    factor: 0.9,
    validOn: ['D'],
    invalidOn: ['A', 'B', 'C', 'E', 'F'],
    lesson: 'D 类金属火只能用干沙、干燥食盐覆盖隔离；水、泡沫、二氧化碳都会和高温金属剧烈反应。',
  },
  bucketWater: {
    id: 'bucketWater',
    label: '水桶 / 脸盆接力',
    agent: 'water',
    factor: 0.45,
    validOn: ['A'],
    invalidOn: ['B', 'C', 'D', 'E', 'F'],
    lesson: '少量水能对付 A 类初起火灾；对油、电、金属火会帮倒忙，还可能触电或爆燃。',
  },
  wetTowel: {
    id: 'wetTowel',
    label: '湿毛巾捂口鼻',
    agent: null,
    factor: 0,
    validOn: [],
    invalidOn: [],
    lesson:
      '湿毛巾只能短暂过滤颗粒物，挡不住一氧化碳。真正保命的是低姿、沿墙、尽快离开，而不是硬冲。',
    effect: 'protection',
  },
  powerCut: {
    id: 'powerCut',
    label: '切断电源',
    agent: null,
    factor: 0,
    validOn: ['E'],
    invalidOn: [],
    lesson: 'E 类带电火灾必须先断电再灭火；没断电就用水，电流会顺着水柱回来。',
    effect: 'power-cut',
  },
  closeDoor: {
    id: 'closeDoor',
    label: '关门断氧',
    agent: null,
    factor: 0,
    validOn: ['A', 'B', 'C', 'D', 'E', 'F'],
    invalidOn: [],
    lesson: '关门能显著减慢火势蔓延，但会把烟和热关在里面。这是“放弃这间房、保住其他房间”的处置。',
    effect: 'close-door',
  },
  kickWindow: {
    id: 'kickWindow',
    label: '破窗排烟',
    agent: null,
    factor: 0,
    validOn: [],
    invalidOn: [],
    lesson: '破窗能排烟降温，但也会引入氧气；室内已经富燃料时，破窗反而可能诱发回燃。',
    effect: 'break',
  },
};

export interface ImprovisedResult {
  ok: boolean;
  lesson: string;
  spray?: SprayResult;
  /** 湿毛巾等个人防护的减伤系数 0..1 */
  protection?: number;
}

/** 断电：带电火转为普通固体火，之后才能按 A 类用水。 */
export function cutPower(state: RoomState): number {
  let count = 0;
  for (const c of state.cells) {
    if (c.fireClass === 'E') {
      c.fireClass = 'A';
      count += 1;
    }
  }
  state.log.push({
    at: state.t,
    kind: 'vent',
    detail: '切断电源，带电火转为普通固体火',
  });
  return count;
}

/** 没有对应灭火剂时，这类火还能用什么生活素材应急。 */
export function improvisedFor(fireClass: FireClass): ImprovisedId[] {
  return (Object.keys(IMPROVISED) as ImprovisedId[]).filter((id) =>
    IMPROVISED[id].validOn.includes(fireClass)
  );
}

/**
 * 使用一项就地取材动作。
 *
 * 用对了有实际场效果；用错了不仅无效，还会让火势变大，并给出解释。
 */
export function useImprovised(
  state: RoomState,
  id: ImprovisedId,
  x: number,
  y: number
): ImprovisedResult {
  const spec = IMPROVISED[id];

  if (spec.effect === 'close-door') {
    isolate(state);
    return { ok: true, lesson: spec.lesson };
  }
  if (spec.effect === 'break') {
    breakOpening(state, 'window');
    return { ok: true, lesson: spec.lesson };
  }
  if (spec.effect === 'power-cut') {
    const n = cutPower(state);
    return {
      ok: n > 0,
      lesson: n > 0 ? spec.lesson : '这里没有带电设备。',
    };
  }
  if (spec.effect === 'protection') {
    return { ok: true, lesson: spec.lesson, protection: 0.5 };
  }

  if (!spec.agent) return { ok: false, lesson: spec.lesson };

  const target = cellAt(state, x, y);
  const fireClass = target.fireClass;

  if (spec.invalidOn.includes(fireClass)) {
    target.fire = clamp01(target.fire + 0.12 * spec.factor);
    target.smoke = clamp01(target.smoke + 0.08 * spec.factor);
    state.log.push({
      at: state.t,
      kind: 'misagent',
      detail: `${spec.label}对 ${FIRE_CLASSES[fireClass].label} 无效，反而助燃`,
    });
    return {
      ok: false,
      lesson: `${spec.label}对 ${FIRE_CLASSES[fireClass].label} 无效。${spec.lesson}`,
    };
  }

  const result = spray(state, spec.agent, x, y, {
    radius: 1.2,
    amount: 0.3 * spec.factor,
    free: true,
  });
  return { ok: result.ok, lesson: spec.lesson, spray: result };
}
