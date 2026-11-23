/**
 * Phase Z4 · 多人群（户）模型。
 *
 * 一个 HouseholdState 管理多个救援区域：每个区域一支 CrowdState，
 * 各自只读取自己房间的场推进，互不串用。某区域居民全部获救或死亡时
 * 记为完成并写入事件，同时把 activeRoomId 切到下一个未完成区域。
 * 随机只来自传入种子的 mulberry32，不含 DOM/three/Math.random。
 */

import type { ZoneSpec } from '../../content/zones';
import type { BuildingGraph } from '../spatial/rooms';
import { gridToWorld } from '../spatial/coords';
import { createResident } from './resident';
import { createCrowd, stepCrowd, type CrowdState } from './crowd';

export interface HouseholdEvent {
  at: number;
  roomId: string;
  kind: 'zone-done';
  detail: string;
}

export interface HouseholdState {
  zones: ZoneSpec[];
  crowds: Record<string, CrowdState>;
  activeRoomId: string | null;
  events: HouseholdEvent[];
}

/** 按区域内容创建居民与人群；同一 seed 加区域序号，保证抖动确定且各区不同。 */
export function createHousehold(zones: ZoneSpec[], seed = 1): HouseholdState {
  const crowds: Record<string, CrowdState> = {};

  for (let index = 0; index < zones.length; index++) {
    const zone = zones[index];
    const residents = zone.residents.map((spec) => {
      const world = gridToWorld(spec.x, spec.y);
      const item = createResident(zone.roomId, world.x, world.z, spec.id);
      item.health = spec.health;
      item.panic = spec.panic;
      item.hidden = spec.hidden;
      return item;
    });

    crowds[zone.roomId] = createCrowd(zone.roomId, residents, seed + index);
  }

  return {
    zones,
    crowds,
    activeRoomId: zones[0]?.roomId ?? null,
    events: [],
  };
}

/** 区域是否已完全处理：获救与失去之和达到该区居民数。 */
export function zoneResolved(household: HouseholdState, roomId: string): boolean {
  const zone = household.zones.find((item) => item.roomId === roomId);
  const crowd = household.crowds[roomId];
  if (!zone || !crowd) return false;
  return crowd.rescued + crowd.lost >= zone.residents.length;
}

/** 当前目标区域：第一个未完成区域；全部完成则为 null。 */
export function refreshActiveZone(household: HouseholdState): void {
  const next = household.zones.find((zone) => !zoneResolved(household, zone.roomId));
  household.activeRoomId = next?.roomId ?? null;
}

/**
 * 推进全部区域的人群。每个区域只用自己房间的 RoomState；
 * 新完成的区域写入一条 zone-done 事件后切换目标。
 */
export function stepHousehold(
  household: HouseholdState,
  graph: BuildingGraph,
  dt: number
): void {
  if (!Number.isFinite(dt) || dt <= 0) return;

  for (const zone of household.zones) {
    const node = graph.rooms[zone.roomId];
    const crowd = household.crowds[zone.roomId];
    if (!node || !crowd) continue;
    stepCrowd(crowd, node.room, dt);
  }

  for (const zone of household.zones) {
    if (!zoneResolved(household, zone.roomId)) continue;
    const reported = household.events.some(
      (event) => event.kind === 'zone-done' && event.roomId === zone.roomId
    );
    if (reported) continue;

    household.events.push({
      at: graph.rooms[zone.roomId]?.room.t ?? 0,
      roomId: zone.roomId,
      kind: 'zone-done',
      detail: `${zone.label} 已处理完`,
    });
  }

  refreshActiveZone(household);
}

/** 汇总所有区域：获救、失去、居民总数与已完成区域数。 */
export function householdSummary(household: HouseholdState): {
  rescued: number;
  lost: number;
  total: number;
  done: number;
} {
  let rescued = 0;
  let lost = 0;
  let total = 0;
  let done = 0;

  for (const zone of household.zones) {
    const crowd = household.crowds[zone.roomId];
    if (crowd) {
      rescued += crowd.rescued;
      lost += crowd.lost;
    }
    total += zone.residents.length;
    if (zoneResolved(household, zone.roomId)) done += 1;
  }

  return { rescued, lost, total, done };
}
