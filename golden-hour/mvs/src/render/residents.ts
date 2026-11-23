/**
 * Phase 3 P3.3：居民视图映射。
 *
 * 只做纯数据转换：把模拟层的居民状态压缩成渲染层需要的标记与可视状态。
 * 不接触 DOM/canvas，便于单元测试与确定性重放。
 */

import type { ResidentState } from '../sim/agents/resident';

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

/** 已获救的居民不再作为场上标记。 */
export function residentMarkers(residents: ResidentState[]): ResidentMarker[] {
  return residents
    .filter((resident) => !resident.rescued)
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
