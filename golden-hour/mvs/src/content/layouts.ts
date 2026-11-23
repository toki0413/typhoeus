/**
 * Phase 5 · P5.2 户型。
 *
 * 纯内容数据：用房间规格与连接规格描述几种可选的建筑布局，
 * 不碰渲染、输入与随机数。房间场由 fields 层的 createRoom 初始化。
 */

import { createRoom } from '../sim/spatial/fields';
import type { BuildingGraph, LinkKind, RoomLink, RoomNode } from '../sim/spatial/rooms';

export interface LayoutDefinition {
  id: string;
  label: string;
  /** 入口房间 id */
  entrance: string;
  /** 目标房间 id */
  target: string;
  build(): BuildingGraph;
}

interface RoomSpec {
  id: string;
  floor: number;
  x: number;
  z: number;
}

interface LinkSpec {
  a: string;
  b: string;
  kind: LinkKind;
  time: number;
  risk: number;
}

interface GraphSpec {
  rooms: RoomSpec[];
  links: LinkSpec[];
}

/** 由规格搭出建筑图；连接 id 每次从 L1 起编号，保证重复构建稳定。 */
function buildGraph(spec: GraphSpec): BuildingGraph {
  const rooms: Record<string, RoomNode> = {};
  for (const room of spec.rooms) {
    rooms[room.id] = {
      id: room.id,
      floor: room.floor,
      bounds: { x: room.x, z: room.z, w: 6, d: 6 },
      room: createRoom(),
    };
  }

  const links: RoomLink[] = spec.links.map((link, i) => ({
    id: `L${i + 1}`,
    a: link.a,
    b: link.b,
    kind: link.kind,
    time: link.time,
    risk: link.risk,
    blocked: false,
    // TODO(P5.5): 接入移动与渲染时，再按房间边界推导真实锚点。
    aAnchor: { x: 0, z: 0 },
    bAnchor: { x: 0, z: 0 },
  }));

  return { rooms, links };
}

const classic: LayoutDefinition = {
  id: 'classic',
  label: '经典两层',
  entrance: 'entrance',
  target: 'room-202-F1',
  build: () =>
    buildGraph({
      rooms: [
        { id: 'entrance', floor: 0, x: -8, z: 8 },
        { id: 'lobby-F0', floor: 0, x: -2, z: 8 },
        { id: 'stair-F0', floor: 0, x: 4, z: 8 },
        { id: 'stair-F1', floor: 1, x: 4, z: 8 },
        { id: 'room-202-F1', floor: 1, x: 4, z: 2 },
        { id: 'escape-F1', floor: 1, x: 10, z: 2 },
        { id: 'roof', floor: 2, x: 10, z: -4 },
      ],
      links: [
        { a: 'entrance', b: 'lobby-F0', kind: 'door', time: 2, risk: 0.02 },
        { a: 'lobby-F0', b: 'stair-F0', kind: 'door', time: 3, risk: 0.03 },
        { a: 'stair-F0', b: 'stair-F1', kind: 'stair', time: 8, risk: 0.08 },
        { a: 'stair-F1', b: 'room-202-F1', kind: 'door', time: 4, risk: 0.25 },
        { a: 'room-202-F1', b: 'escape-F1', kind: 'window', time: 2, risk: 0.3 },
        { a: 'escape-F1', b: 'roof', kind: 'ladder', time: 6, risk: 0.35 },
      ],
    }),
};

const narrow: LayoutDefinition = {
  id: 'narrow',
  label: '窄楼梯',
  entrance: 'entrance',
  target: 'room-202-F1',
  build: () =>
    buildGraph({
      rooms: [
        { id: 'entrance', floor: 0, x: -8, z: 8 },
        { id: 'hall-F0', floor: 0, x: -2, z: 8 },
        { id: 'stair-narrow-F0', floor: 0, x: 4, z: 8 },
        { id: 'stair-narrow-F1', floor: 1, x: 4, z: 8 },
        { id: 'room-202-F1', floor: 1, x: 4, z: 2 },
        { id: 'escape-narrow-F1', floor: 1, x: 10, z: 2 },
      ],
      links: [
        { a: 'entrance', b: 'hall-F0', kind: 'door', time: 2, risk: 0.02 },
        { a: 'hall-F0', b: 'stair-narrow-F0', kind: 'door', time: 2, risk: 0.03 },
        { a: 'stair-narrow-F0', b: 'stair-narrow-F1', kind: 'stair', time: 7, risk: 0.1 },
        { a: 'stair-narrow-F1', b: 'room-202-F1', kind: 'door', time: 3, risk: 0.2 },
        { a: 'room-202-F1', b: 'escape-narrow-F1', kind: 'window', time: 2, risk: 0.3 },
      ],
    }),
};

const courtyard: LayoutDefinition = {
  id: 'courtyard',
  label: '内院双梯',
  entrance: 'entrance',
  target: 'room-202-F1',
  build: () =>
    buildGraph({
      rooms: [
        { id: 'entrance', floor: 0, x: -8, z: 8 },
        { id: 'courtyard', floor: 0, x: -2, z: 8 },
        { id: 'stairA-F0', floor: 0, x: 4, z: 8 },
        { id: 'stairA-F1', floor: 1, x: 4, z: 8 },
        { id: 'stairB-F0', floor: 0, x: 4, z: 2 },
        { id: 'stairB-F1', floor: 1, x: 4, z: 2 },
        { id: 'room-202-F1', floor: 1, x: 10, z: 4 },
        { id: 'balcony-F1', floor: 1, x: 16, z: 4 },
        { id: 'courtyard-roof', floor: 2, x: 16, z: 4 },
      ],
      links: [
        { a: 'entrance', b: 'courtyard', kind: 'door', time: 2, risk: 0.02 },
        { a: 'courtyard', b: 'stairA-F0', kind: 'door', time: 3, risk: 0.03 },
        { a: 'courtyard', b: 'stairB-F0', kind: 'door', time: 3, risk: 0.04 },
        { a: 'stairA-F0', b: 'stairA-F1', kind: 'stair', time: 8, risk: 0.08 },
        { a: 'stairB-F0', b: 'stairB-F1', kind: 'stair', time: 8, risk: 0.1 },
        { a: 'stairA-F1', b: 'room-202-F1', kind: 'door', time: 4, risk: 0.2 },
        { a: 'stairB-F1', b: 'room-202-F1', kind: 'door', time: 4, risk: 0.22 },
        { a: 'room-202-F1', b: 'balcony-F1', kind: 'window', time: 2, risk: 0.3 },
        { a: 'balcony-F1', b: 'courtyard-roof', kind: 'ladder', time: 6, risk: 0.35 },
      ],
    }),
};

const duplex: LayoutDefinition = {
  id: 'duplex',
  label: '跃层',
  entrance: 'entrance',
  target: 'room-202-F2',
  build: () =>
    buildGraph({
      rooms: [
        { id: 'entrance', floor: 0, x: -8, z: 8 },
        { id: 'stair-F0', floor: 0, x: 0, z: 8 },
        { id: 'stair-F1', floor: 1, x: 0, z: 8 },
        { id: 'room-202-F1', floor: 1, x: 6, z: 4 },
        { id: 'room-202-F2', floor: 2, x: 6, z: 4 },
        { id: 'garden-F1', floor: 1, x: 12, z: 8 },
        { id: 'balcony-F2', floor: 2, x: 12, z: 4 },
      ],
      links: [
        { a: 'entrance', b: 'stair-F0', kind: 'door', time: 2, risk: 0.02 },
        { a: 'stair-F0', b: 'stair-F1', kind: 'stair', time: 8, risk: 0.08 },
        { a: 'stair-F1', b: 'room-202-F1', kind: 'door', time: 3, risk: 0.2 },
        { a: 'room-202-F1', b: 'room-202-F2', kind: 'stair', time: 6, risk: 0.15 },
        { a: 'room-202-F1', b: 'garden-F1', kind: 'door', time: 3, risk: 0.1 },
        { a: 'garden-F1', b: 'balcony-F2', kind: 'ladder', time: 6, risk: 0.3 },
        { a: 'balcony-F2', b: 'room-202-F2', kind: 'window', time: 2, risk: 0.25 },
      ],
    }),
};

export const LAYOUTS: LayoutDefinition[] = [classic, narrow, courtyard, duplex];

export function layoutById(id: string): LayoutDefinition | undefined {
  return LAYOUTS.find((layout) => layout.id === id);
}

/** 未知 id 回退第一个户型。 */
export function createLayout(id: string): BuildingGraph {
  const layout = layoutById(id) ?? LAYOUTS[0];
  return layout.build();
}

/** 返回错误列表；空数组表示合法。 */
export function validateLayout(graph: BuildingGraph, entrance: string): string[] {
  const errors: string[] = [];

  for (const room of Object.values(graph.rooms)) {
    if (!Number.isInteger(room.floor) || room.floor < 0 || room.floor > 3) {
      errors.push(`房间 ${room.id} 的楼层 ${room.floor} 超出 0..3`);
    }
  }

  if (!graph.rooms[entrance]) {
    errors.push(`入口房间 ${entrance} 不存在`);
  }

  const seen = new Set<string>();
  for (const link of graph.links) {
    if (seen.has(link.id)) {
      errors.push(`连接 id 重复：${link.id}`);
    }
    seen.add(link.id);

    for (const end of [link.a, link.b]) {
      if (!graph.rooms[end]) {
        errors.push(`连接 ${link.id} 的端点 ${end} 不存在`);
      }
    }

    if (!(link.time > 0)) {
      errors.push(`连接 ${link.id} 的耗时必须大于 0`);
    }

    if (!(link.risk >= 0 && link.risk <= 1)) {
      errors.push(`连接 ${link.id} 的风险 ${link.risk} 超出 0..1`);
    }
  }

  // 从入口做广度优先，确认所有房间都能走到。
  if (graph.rooms[entrance]) {
    const visited = new Set<string>([entrance]);
    const queue: string[] = [entrance];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      for (const link of graph.links) {
        if (link.blocked) continue;
        const next = link.a === current ? link.b : link.b === current ? link.a : null;
        if (next && graph.rooms[next] && !visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }

    const missing = Object.keys(graph.rooms).filter((id) => !visited.has(id));
    if (missing.length > 0) {
      errors.push(`从入口 ${entrance} 无法到达：${missing.join('、')}`);
    }
  }

  return errors;
}
