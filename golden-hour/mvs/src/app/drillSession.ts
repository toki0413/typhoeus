import { createRoom, type RoomState } from '../sim/spatial/fields';
import { shouldBackdraft, triggerBackdraft } from '../sim/spatial/spread';
import {
  DRILLS,
  createDrillProgress,
  evaluateDrill,
  type DrillDefinition,
  type DrillProgress,
} from '../content/drills';

export interface DrillSession {
  drill: DrillDefinition;
  room: RoomState;
  progress: DrillProgress;
  /** 演练内部计时（秒） */
  elapsed: number;
  /** 已结束时的结果；未结束为 null */
  result: { ok: boolean; reason: string } | null;
  /** 低姿按键是否处于按下状态 */
  lowStanceActive: boolean;
}

/** 未知 id 回退到第一条演练；房间只布置一次，之后由动作推进。 */
export function createDrillSession(id: string): DrillSession {
  const drill = DRILLS.find((item) => item.id === id) ?? DRILLS[0];
  const room = createRoom();
  drill.setup(room);
  return {
    drill,
    room,
    progress: createDrillProgress(),
    elapsed: 0,
    result: null,
    lowStanceActive: false,
  };
}

/** 贴门测温：只记录动作，温度是否成立交给成功条件判断。 */
export function measureDoor(session: DrillSession): void {
  if (session.result) return;
  session.progress.measuredDoor = true;
}

/** 冷却门板：记录动作并至少打湿 0.4，湿门不再成为回燃点火面。 */
export function coolDoor(session: DrillSession): void {
  if (session.result) return;
  session.progress.cooledDoor = true;
  session.room.openings.door.wet = Math.max(session.room.openings.door.wet, 0.4);
}

/** 直接开门：若会回燃则触发 triggerBackdraft 并返回 true；否则开门返回 false。 */
export function openDoor(session: DrillSession): boolean {
  if (session.result) return false;
  if (shouldBackdraft(session.room, 'door')) {
    triggerBackdraft(session.room);
    return true;
  }
  session.room.openings.door.open = true;
  return false;
}

/** 记录低姿按键状态；是否累计由 tickSession 决定。 */
export function setLowStance(session: DrillSession, active: boolean): void {
  if (session.result) return;
  session.lowStanceActive = active;
}

/** 按固定步长推进内部计时；只有低姿演练且按键激活时才累加低姿秒数。 */
export function tickSession(session: DrillSession, dt: number): void {
  if (session.result) return;
  if (!Number.isFinite(dt) || dt <= 0) return;
  session.elapsed += dt;
  if (session.drill.kind === 'low-stance' && session.lowStanceActive) {
    session.progress.lowStanceSeconds += dt;
  }
}

/** 成功时写入结果并返回；失败只返回原因，不写入 result，便于重试。 */
export function evaluateSession(session: DrillSession): { ok: boolean; reason: string } {
  if (session.result) return session.result;
  const result = evaluateDrill(session.drill, session.progress, session.room);
  if (!result.ok) return result;
  const done = { ok: true, reason: '完成' };
  session.result = done;
  return done;
}
