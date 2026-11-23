/**
 * Phase 4：事件导演。
 *
 * 只读取建筑图与房间场，不推进火焰演化；负责三类“场景级”事件：
 * 风向、窗户高温失效、结构坍塌，以及风驱动的跨房间烟转移。
 * 所有时间取自 director.t，遍历顺序固定，保证纯确定性与可重放。
 */

import { clamp01, roomSummary, type RoomState } from '../spatial/fields';
import type { BuildingGraph } from '../spatial/rooms';

export interface Wind {
  /** 建筑平面方向（x 向东、y 向北），无需归一化 */
  x: number;
  y: number;
  /** 0..1 */
  speed: number;
}

export type DirectorEventKind = 'wind' | 'window' | 'collapse';

export interface DirectorEvent {
  at: number;
  kind: DirectorEventKind;
  roomId?: string;
  linkId?: string;
  detail: string;
}

export interface DirectorState {
  t: number;
  wind: Wind;
  /** 每房间“结构危险”持续时长（秒） */
  weakFor: Record<string, number>;
  /** 已坍塌房间 id */
  collapsed: string[];
  events: DirectorEvent[];
}

export const COLLAPSE_SECONDS = 6;
export const COLLAPSE_STRUCTURE = 0.35;
export const COLLAPSE_HEAT = 0.6;
export const WINDOW_FAIL_TEMP = 0.65;
export const WIND_TRANSFER = 0.35;

/** 初始为东风：x 向东、y 向北。 */
export function createDirector(seed = 1): DirectorState {
  // seed 预留给后续风场扰动 / 湍流；当前实现完全确定性，暂时不消费随机数。
  void seed;
  return {
    t: 0,
    wind: { x: 1, y: 0, speed: 0.3 },
    weakFor: {},
    collapsed: [],
    events: [],
  };
}

export function setWind(
  director: DirectorState,
  x: number,
  y: number,
  speed: number
): void {
  const len = Math.hypot(x, y);
  // 零向量没有方向信息：保留原方向，只更新风速。
  if (len > 0) {
    director.wind.x = x / len;
    director.wind.y = y / len;
  }
  director.wind.speed = clamp01(speed);
  director.events.push({
    at: director.t,
    kind: 'wind',
    detail: `风向 (${director.wind.x.toFixed(2)}, ${director.wind.y.toFixed(
      2
    )})，风速 ${director.wind.speed.toFixed(2)}`,
  });
}

/** 整间房每格烟浓度加同一个量，其它场量不动。 */
function shiftSmoke(state: RoomState, delta: number): void {
  for (const cell of state.cells) {
    cell.smoke = clamp01(cell.smoke + delta);
  }
}

export function stepDirector(
  director: DirectorState,
  graph: BuildingGraph,
  dt: number
): void {
  if (!Number.isFinite(dt) || dt <= 0) return;
  director.t += dt;

  const rooms = Object.values(graph.rooms);

  // 1. 窗户高温失效：玻璃炸裂后形成通风口，只记一次。
  for (const node of rooms) {
    const win = node.room.openings.window;
    if (win.temp > WINDOW_FAIL_TEMP && !win.broken) {
      win.broken = true;
      director.events.push({
        at: director.t,
        kind: 'window',
        roomId: node.id,
        detail: `${node.id} 窗户高温失效，形成通风口`,
      });
    }
  }

  // 2. 坍塌判定：结构不足 + 高温同时满足，并持续足够时间。
  for (const node of rooms) {
    const id = node.id;
    const summary = roomSummary(node.room);
    const weak = summary.structure < COLLAPSE_STRUCTURE && summary.heat > COLLAPSE_HEAT;
    director.weakFor[id] = weak ? (director.weakFor[id] ?? 0) + dt : 0;

    if (director.weakFor[id] < COLLAPSE_SECONDS) continue;
    if (director.collapsed.includes(id)) continue;

    director.collapsed.push(id);
    const touching = graph.links.filter((link) => link.a === id || link.b === id);
    for (const link of touching) link.blocked = true;

    director.events.push({
      at: director.t,
      kind: 'collapse',
      roomId: id,
      detail: `${id} 结构失效坍塌`,
    });
    for (const link of touching) {
      director.events.push({
        at: director.t,
        kind: 'collapse',
        roomId: id,
        linkId: link.id,
        detail: `${link.a} ↔ ${link.b} 被坍塌阻断`,
      });
    }
  }

  // 3. 风驱动烟转移：沿上风→下风的可行连接搬运烟，不碰氧气与热量。
  for (const link of graph.links) {
    if (link.blocked) continue;
    if (link.kind !== 'door' && link.kind !== 'window' && link.kind !== 'breach') continue;

    const a = graph.rooms[link.a];
    const b = graph.rooms[link.b];
    if (!a || !b) continue;

    const dx = b.bounds.x - a.bounds.x;
    const dz = b.bounds.z - a.bounds.z;
    const len = Math.hypot(dx, dz);
    if (len === 0) continue;
    const dirX = dx / len;
    const dirZ = dz / len;

    const dot = director.wind.x * dirX + director.wind.y * dirZ;
    if (Math.abs(dot) < 0.2) continue;

    const up = dot > 0 ? a : b;
    const down = dot > 0 ? b : a;
    const upSmoke = roomSummary(up.room).smoke;
    const downSmoke = roomSummary(down.room).smoke;
    const diff = upSmoke - downSmoke;
    if (diff <= 0.01) continue;

    const amount =
      diff * Math.min(1, WIND_TRANSFER * director.wind.speed * Math.abs(dot) * dt);
    if (amount <= 0) continue;

    shiftSmoke(down.room, amount);
    shiftSmoke(up.room, -amount * 0.5);
  }
}
