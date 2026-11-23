import { createRoom, type Opening, type RoomState } from './fields';

export interface RoomBounds {
  x: number;
  z: number;
  w: number;
  d: number;
}

export interface RoomNode {
  id: string;
  floor: number;
  bounds: RoomBounds;
  room: RoomState;
}

export type LinkKind = 'door' | 'window' | 'stair' | 'ladder' | 'breach';

export interface RoomLink {
  id: string;
  a: string;
  b: string;
  kind: LinkKind;
  opening: Opening;
  /** 通过耗时（秒） */
  time: number;
  /** 风险 0..1，用于路线评分 */
  risk: number;
  blocked: boolean;
  aAnchor: { x: number; z: number };
  bAnchor: { x: number; z: number };
}

export interface BuildingGraph {
  rooms: Record<string, RoomNode>;
  links: RoomLink[];
}

function opening(id: 'door' | 'window', open = false): Opening {
  return {
    id,
    x: id === 'door' ? 0 : 7,
    y: 4,
    open,
    broken: false,
    temp: 0.12,
    wet: 0,
    backdraftTrigger: id === 'door',
  };
}

let seq = 0;

function link(
  a: string,
  b: string,
  kind: LinkKind,
  time: number,
  risk: number,
  band: 'door' | 'window' = 'door'
): RoomLink {
  seq += 1;
  return {
    id: `L${seq}`,
    a,
    b,
    kind,
    opening: opening(band),
    time,
    risk,
    blocked: false,
    aAnchor: { x: 0, z: 0 },
    bAnchor: { x: 0, z: 0 },
  };
}

export function createBuilding(): BuildingGraph {
  seq = 0;
  const rooms: Record<string, RoomNode> = {};
  const add = (id: string, floor: number, x: number, z: number) => {
    rooms[id] = {
      id,
      floor,
      bounds: { x, z, w: 6, d: 6 },
      room: createRoom(),
    };
  };

  add('entrance', 0, -8, 8);
  add('lobby-F0', 0, -2, 8);
  add('stair-F0', 0, 4, 8);
  add('stair-F1', 1, 4, 8);
  add('stair-F2', 2, 4, 8);
  add('room-201-F1', 1, -2, 2);
  add('room-202-F1', 1, 4, 2);
  add('room-202-F2', 2, 4, 2);
  add('escape-F1', 1, 10, 2);
  add('escape-F2', 2, 10, 2);
  add('roof', 3, 4, -4);

  const links: RoomLink[] = [];
  links.push(link('entrance', 'lobby-F0', 'door', 2, 0.02));
  links.push(link('lobby-F0', 'stair-F0', 'door', 3, 0.03));
  links.push(link('stair-F0', 'stair-F1', 'stair', 8, 0.08));
  links.push(link('stair-F1', 'stair-F2', 'stair', 8, 0.1));
  links.push(link('stair-F1', 'room-201-F1', 'door', 3, 0.15));
  links.push(link('stair-F1', 'room-202-F1', 'door', 4, 0.25));
  links.push(link('stair-F2', 'room-202-F2', 'door', 3, 0.2));
  links.push(link('room-202-F1', 'escape-F1', 'window', 2, 0.3, 'window'));
  links.push(link('escape-F1', 'escape-F2', 'ladder', 6, 0.35));
  links.push(link('escape-F2', 'roof', 'ladder', 4, 0.3));
  links.push(link('room-202-F2', 'room-202-F1', 'breach', 5, 0.5));
  links.push(link('entrance', 'escape-F1', 'ladder', 5, 0.2));

  return { rooms, links };
}
