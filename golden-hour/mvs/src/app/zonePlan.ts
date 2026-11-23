/**
 * Phase Z4 · 区域目标规划（纯函数）。
 *
 * 入口只消费这里的结果渲染区域条与路线目标，不在视图里重复判定完成状态。
 */

import { zoneResolved, type HouseholdState } from '../sim/agents/household';

export type ZoneStatus = 'pending' | 'active' | 'done';

/** 每个区域的状态：已完成 / 当前目标 / 待处理。 */
export function zoneStatuses(household: HouseholdState): Record<string, ZoneStatus> {
  const statuses: Record<string, ZoneStatus> = {};

  for (const zone of household.zones) {
    if (zoneResolved(household, zone.roomId)) {
      statuses[zone.roomId] = 'done';
    } else if (zone.roomId === household.activeRoomId) {
      statuses[zone.roomId] = 'active';
    } else {
      statuses[zone.roomId] = 'pending';
    }
  }

  return statuses;
}

/** 下一个目标：优先当前区域；否则第一个未完成区域；全部完成返回 null。 */
export function nextZoneId(household: HouseholdState): string | null {
  const active = household.activeRoomId;
  if (active && !zoneResolved(household, active)) return active;

  const next = household.zones.find((zone) => !zoneResolved(household, zone.roomId));
  return next?.roomId ?? null;
}

/** 区域显示名；找不到时回退房间 id。 */
export function zoneLabel(household: HouseholdState, roomId: string): string {
  return household.zones.find((zone) => zone.roomId === roomId)?.label ?? roomId;
}

export type RunPhase = 'rescue' | 'evacuate' | 'done';

/** allDone=false → rescue；allDone 且未到出口 → evacuate；到出口 → done。 */
export function runPhase(allDone: boolean, atExit: boolean): RunPhase {
  if (!allDone) return 'rescue';
  return atExit ? 'done' : 'evacuate';
}
