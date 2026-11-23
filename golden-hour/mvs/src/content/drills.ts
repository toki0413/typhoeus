import type { RoomState } from '../sim/spatial/fields';

export type DrillKind = 'measure' | 'backdraft' | 'low-stance';

export interface DrillProgress {
  /** 是否完成贴门测温 */
  measuredDoor: boolean;
  /** 是否冷却/打湿过门板 */
  cooledDoor: boolean;
  /** 低姿累计秒数 */
  lowStanceSeconds: number;
}

export interface DrillDefinition {
  id: string;
  kind: DrillKind;
  label: string;
  hint: string;
  /** 把房间布置成演练初始状态；只改场与开口，不推进模拟。 */
  setup(room: RoomState): void;
  /** 明确、可测的成功条件。 */
  success(progress: DrillProgress, room: RoomState): boolean;
}

export const DRILLS: DrillDefinition[] = [
  {
    id: 'measure-door',
    kind: 'measure',
    label: '贴门测温',
    hint: '用手背贴门板上沿感受温度，温度高说明门后火势不小。',
    setup(room: RoomState): void {
      room.openings.door.temp = 0.55;
    },
    success(progress: DrillProgress, room: RoomState): boolean {
      return progress.measuredDoor && room.openings.door.temp > 0.4;
    },
  },
  {
    id: 'backdraft-watch',
    kind: 'backdraft',
    label: '回燃判断',
    hint: '富燃料烟气遇上新鲜空气会回燃；先冷却或打湿门板再开门。',
    setup(room: RoomState): void {
      for (const cell of room.cells) {
        cell.smoke = 0.55;
        cell.heat = 0.35;
        cell.oxygen = 0.45;
      }
      room.openings.door.temp = 0.5;
      room.openings.door.wet = 0;
      room.backdraftAt = null;
    },
    success(progress: DrillProgress, room: RoomState): boolean {
      return room.backdraftAt === null && room.openings.door.wet >= 0.3;
    },
  },
  {
    id: 'low-stance',
    kind: 'low-stance',
    label: '低姿穿越',
    hint: '烟气聚在上层，贴近地面移动能避开高温与浓烟。',
    setup(room: RoomState): void {
      for (const cell of room.cells) {
        cell.smoke = 0.6;
        cell.heat = 0.2;
      }
    },
    success(progress: DrillProgress): boolean {
      return progress.lowStanceSeconds >= 3;
    },
  },
];

export function createDrillProgress(): DrillProgress {
  return { measuredDoor: false, cooledDoor: false, lowStanceSeconds: 0 };
}

export function drillById(id: string): DrillDefinition | undefined {
  return DRILLS.find((drill) => drill.id === id);
}

/** 未完成时给出与成功条件对应的中文原因，完成时统一返回“完成”。 */
function failureReason(
  drill: DrillDefinition,
  progress: DrillProgress,
  room: RoomState
): string {
  switch (drill.kind) {
    case 'measure':
      if (!progress.measuredDoor) return '还没完成贴门测温';
      return '门板温度不足，测温结论不成立';
    case 'backdraft':
      if (room.backdraftAt !== null) return '已经发生回燃';
      return '门板还没冷却';
    case 'low-stance':
      return '低姿时间不足';
    default:
      return '成功条件尚未满足';
  }
}

export function evaluateDrill(
  drill: DrillDefinition,
  progress: DrillProgress,
  room: RoomState
): { ok: boolean; reason: string } {
  if (drill.success(progress, room)) return { ok: true, reason: '完成' };
  return { ok: false, reason: failureReason(drill, progress, room) };
}
