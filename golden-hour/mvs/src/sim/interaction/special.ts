import { cellAt, clamp01, inBounds, type RoomState } from '../spatial/fields';

export interface ThermalScan {
  x: number;
  y: number;
  heat: number;
  fuel: number;
  throughWall: boolean;
}

/** 热像仪读取视线前方 1..2 格的最高热区；第二格视为隔墙/门后。 */
export function thermalScan(
  room: RoomState,
  x: number,
  y: number,
  dx: number,
  dy: number
): ThermalScan {
  let best: ThermalScan = { x, y, heat: 0, fuel: 0, throughWall: false };

  for (let step = 1; step <= 2; step++) {
    const nx = x + dx * step;
    const ny = y + dy * step;
    if (!inBounds(room.config, nx, ny)) break;
    const cell = cellAt(room, nx, ny);
    if (cell.heat >= best.heat) {
      best = {
        x: nx,
        y: ny,
        heat: cell.heat,
        fuel: cell.fuel,
        throughWall: step > 1,
      };
    }
  }

  return best;
}

/** 排烟机：把源格的一部分烟推到相邻格。返回移动量。 */
export function ventSmoke(
  room: RoomState,
  x: number,
  y: number,
  dx: number,
  dy: number,
  strength = 0.4
): number {
  if (!inBounds(room.config, x, y)) return 0;

  const source = cellAt(room, x, y);
  const moved = source.smoke * Math.min(1, Math.max(0, strength));
  source.smoke = clamp01(source.smoke - moved);

  const tx = x + dx;
  const ty = y + dy;
  if (inBounds(room.config, tx, ty)) {
    const target = cellAt(room, tx, ty);
    target.smoke = clamp01(target.smoke + moved * 0.8);
  }

  return moved;
}

export interface BreachResult {
  before: number;
  after: number;
  ready: boolean;
}

/** 破拆：降低结构，结构 ≤0.3 视为可打通。 */
export function breachCell(
  room: RoomState,
  x: number,
  y: number,
  amount = 0.25
): BreachResult {
  if (!inBounds(room.config, x, y)) {
    return { before: 0, after: 0, ready: false };
  }

  const cell = cellAt(room, x, y);
  const before = cell.structure;
  cell.structure = Math.max(0, before - Math.max(0, amount));
  cell.heat = clamp01(cell.heat + 0.02);
  return { before, after: cell.structure, ready: cell.structure <= 0.3 };
}
