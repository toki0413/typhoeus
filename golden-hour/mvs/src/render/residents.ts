/**
 * Phase 3 P3.3：居民视图映射。
 *
 * 只做纯数据转换：把模拟层的居民状态压缩成渲染层需要的标记与可视状态。
 * 不接触 DOM/canvas，便于单元测试与确定性重放。
 */

import { findResident, type ResidentState } from '../sim/agents/resident';
import type { ActorState } from '../sim/spatial/actor';

export type ResidentVisualState =
  | 'calm'
  | 'panic'
  | 'hidden'
  | 'unconscious'
  | 'dead'
  | 'rescued';

export interface ResidentMarker {
  id: string;
  roomId: string;
  x: number;
  z: number;
  state: ResidentVisualState;
}

/**
 * 已获救的居民不再作为场上标记。
 * 传入 actor 时，躲藏居民只有被搜到（findResident 为 true）才保留；
 * 不传 actor 时保持原行为，便于无玩家上下文的视图与测试。
 */
export function residentMarkers(
  residents: ResidentState[],
  actor?: ActorState
): ResidentMarker[] {
  return residents
    .filter((resident) => !resident.rescued)
    .filter((resident) => !actor || findResident(resident, actor))
    .map((resident) => ({
      id: resident.id,
      roomId: resident.roomId,
      x: resident.x,
      z: resident.z,
      state: residentVisualState(resident),
    }));
}

/** rescued > dead > mood 的优先级。 */
export function residentVisualState(resident: ResidentState): ResidentVisualState {
  if (resident.rescued) return 'rescued';
  if (resident.dead) return 'dead';
  return resident.mood;
}
