/**
 * Phase Z3：跨房间烟流。
 *
 * 只按建筑图连接搬运房间平均烟浓度，不碰火焰、热量、氧气与结构。
 * 连接级流量 + 开口渗透系数 + 风向加速；遍历顺序固定，保证确定性。
 */

import { clamp01, roomSummary, type RoomState } from './fields';
import type { BuildingGraph, LinkKind, RoomLink } from './rooms';
import type { Wind } from '../events/director';

export const LINK_SMOKE_RATE = { door: 0.28, window: 0.5, breach: 0.18 } as const;
export const CLOSED_SEEP = 0.06;

type FlowingKind = keyof typeof LINK_SMOKE_RATE;

/** 楼梯与消防梯不参与烟流，避免烟垂直瞬移。 */
function isFlowingKind(kind: LinkKind): kind is FlowingKind {
  return kind === 'door' || kind === 'window' || kind === 'breach';
}

/** 开口开度：门/窗任一端的 open 或 broken 即视为全开，否则只按缝隙渗烟。 */
function openness(link: RoomLink, graph: BuildingGraph, kind: FlowingKind): number {
  if (kind === 'breach') return 1;

  const a = graph.rooms[link.a].room.openings[kind];
  const b = graph.rooms[link.b].room.openings[kind];
  return a.open || a.broken || b.open || b.broken ? 1 : CLOSED_SEEP;
}

/**
 * 风向只加速、不逆转流向：把风向量投影到“高烟→低烟”的方向上，
 * 顺风取正、逆风取 0，因此低烟房间不会反过来被吹回高烟房间。
 */
function windBoost(
  link: RoomLink,
  graph: BuildingGraph,
  highIsA: boolean,
  wind?: Wind
): number {
  if (!wind) return 1;

  const dx = graph.rooms[link.b].bounds.x - graph.rooms[link.a].bounds.x;
  const dz = graph.rooms[link.b].bounds.z - graph.rooms[link.a].bounds.z;
  const len = Math.hypot(dx, dz);
  if (len === 0) return 1;

  const dirX = dx / len;
  const dirZ = dz / len;
  const flowSign = highIsA ? 1 : -1;
  const flowDot = (wind.x * dirX + wind.y * dirZ) * flowSign;
  return 1 + Math.max(0, flowDot) * 0.8;
}

function shiftSmoke(room: RoomState, delta: number): void {
  for (const cell of room.cells) {
    cell.smoke = clamp01(cell.smoke + delta);
  }
}

/**
 * 推进一次跨房间烟流：从高烟房间自然扩散到低烟房间，无需风也会发生。
 * 同一连接同时给低烟房间加 amount、给高烟房间减 amount * 0.5。
 */
export function stepLinkSmoke(graph: BuildingGraph, dt: number, wind?: Wind): void {
  if (!Number.isFinite(dt) || dt <= 0) return;

  for (const link of graph.links) {
    if (link.blocked) continue;
    if (!isFlowingKind(link.kind)) continue;

    const a = graph.rooms[link.a];
    const b = graph.rooms[link.b];
    if (!a || !b) continue;

    const smokeA = roomSummary(a.room).smoke;
    const smokeB = roomSummary(b.room).smoke;
    const diff = smokeA - smokeB;
    if (Math.abs(diff) <= 0.01) continue;

    const highIsA = diff > 0;
    const high = highIsA ? a : b;
    const low = highIsA ? b : a;

    const rate = LINK_SMOKE_RATE[link.kind];
    const open = openness(link, graph, link.kind);
    const boost = windBoost(link, graph, highIsA, wind);
    const amount = Math.abs(diff) * Math.min(0.5, rate * open * boost * dt);
    if (amount <= 0) continue;

    shiftSmoke(low.room, amount);
    shiftSmoke(high.room, -amount * 0.5);
  }
}
