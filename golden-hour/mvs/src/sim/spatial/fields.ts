/**
 * Phase 0：单房间粗网格场模型。
 *
 * 一格 = 0.75 m，6×6 m 房间 = 8×8 格。每格独立记录燃料、火、热、烟、氧、水与结构。
 * 这里只做“场”，不碰渲染与输入；保证固定步长、无随机、可重放。
 */

export type OpeningId = 'door' | 'window';

export interface RoomConfig {
  cols: number;
  rows: number;
  cellSize: number;
}

export interface Cell {
  /** 剩余燃料 0..1 */
  fuel: number;
  /** 燃烧强度 0..1 */
  fire: number;
  /** 温度 0..1（归一化，0 环境温度，1 轰燃温度） */
  heat: number;
  /** 上层烟浓度 0..1 */
  smoke: number;
  /** 氧气 0..1（1 = 新鲜空气） */
  oxygen: number;
  /** 水膜 0..1，会持续抑制燃烧并带走热量 */
  water: number;
  /** 结构完整度 1..0 */
  structure: number;
  /** 可燃性 0..1 */
  combustibility: number;
  /** 单位燃料产烟系数 */
  smokeYield: number;
}

export interface Opening {
  id: OpeningId;
  x: number;
  y: number;
  open: boolean;
  /** 玻璃破碎 / 门板破拆，等同于半开通道 */
  broken: boolean;
  /** 门板 / 窗框表面温度 0..1 */
  temp: number;
  /** 打开时是否会把新鲜空气直接送进富燃料烟气层（门为 true，窗为 false） */
  backdraftTrigger: boolean;
}

export interface RoomEvent {
  at: number;
  kind: 'open' | 'break' | 'cool' | 'backdraft' | 'ignite' | 'extinguish' | 'vent';
  detail: string;
}

export interface RoomStats {
  smokeVented: number;
  oxygenIn: number;
  waterUsed: number;
  peakHeat: number;
}

export interface RoomState {
  config: RoomConfig;
  cells: Cell[];
  openings: Record<OpeningId, Opening>;
  /** 模拟时间（秒） */
  t: number;
  /** 0..1，供 HUD 与动词判断；等于 roomSummary + 风险函数的结果 */
  backdraftRisk: number;
  /** 回燃发生的时刻；null 表示还没发生 */
  backdraftAt: number | null;
  /** 已判定但尚未兑现的回燃（点燃发生在开门后约 1 秒） */
  pendingBackdraft: boolean;
  lastOpened: OpeningId | null;
  lastOpenedAt: number | null;
  log: RoomEvent[];
  stats: RoomStats;
}

export const ROOM_COLS = 8;
export const ROOM_ROWS = 8;
export const CELL_SIZE = 0.75;

export function index(config: RoomConfig, x: number, y: number): number {
  return y * config.cols + x;
}

export function inBounds(config: RoomConfig, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < config.cols && y < config.rows;
}

export function cellAt(state: RoomState, x: number, y: number): Cell {
  return state.cells[index(state.config, x, y)];
}

function emptyCell(): Cell {
  return {
    fuel: 0,
    fire: 0,
    heat: 0.05,
    smoke: 0,
    oxygen: 0.95,
    water: 0,
    structure: 1,
    combustibility: 0,
    smokeYield: 0,
  };
}

function makeFuel(
  fuel: number,
  combustibility: number,
  smokeYield: number
): Partial<Cell> {
  return { fuel, combustibility, smokeYield };
}

/**
 * 一个房间：左侧门、右侧窗、右侧一组沙发、沙发旁的火源。
 * 门与窗同一高度，方便“穿堂风”与“先排烟再进”两种解法都成立。
 */
export function createRoom(config: Partial<RoomConfig> = {}): RoomState {
  const full: RoomConfig = {
    cols: ROOM_COLS,
    rows: ROOM_ROWS,
    cellSize: CELL_SIZE,
    ...config,
  };

  const cells: Cell[] = [];
  for (let y = 0; y < full.rows; y++) {
    for (let x = 0; x < full.cols; x++) {
      cells.push(emptyCell());
    }
  }

  const state: RoomState = {
    config: full,
    cells,
    openings: {
      door: {
        id: 'door',
        x: 0,
        y: Math.floor(full.rows / 2),
        open: false,
        broken: false,
        temp: 0.12,
        backdraftTrigger: true,
      },
      window: {
        id: 'window',
        x: full.cols - 1,
        y: Math.floor(full.rows / 2),
        open: false,
        broken: false,
        temp: 0.12,
        backdraftTrigger: false,
      },
    },
    t: 0,
    backdraftRisk: 0,
    backdraftAt: null,
    pendingBackdraft: false,
    lastOpened: null,
    lastOpenedAt: null,
    log: [],
    stats: { smokeVented: 0, oxygenIn: 0, waterUsed: 0, peakHeat: 0 },
  };

  // 沙发：靠窗的一块 L 形可燃家具
  const sofa = [
    [5, 3],
    [6, 3],
    [5, 4],
    [6, 4],
    [5, 5],
  ];
  for (const [x, y] of sofa) {
    if (!inBounds(full, x, y)) continue;
    Object.assign(cellAt(state, x, y), makeFuel(1, 0.8, 1.4));
  }

  // 火源在沙发中间
  const source = cellAt(state, 5, 4);
  source.fire = 0.45;
  source.fuel = 1;
  source.combustibility = 0.85;
  source.smokeYield = 1.6;
  source.heat = 0.2;

  return state;
}

/** 场聚合值，供 HUD、风险和测试使用。 */
export function roomSummary(state: RoomState): {
  fire: number;
  heat: number;
  smoke: number;
  oxygen: number;
  fuel: number;
  structure: number;
} {
  const n = state.cells.length;
  let fire = 0;
  let heat = 0;
  let smoke = 0;
  let oxygen = 0;
  let fuel = 0;
  let structure = 0;
  for (const c of state.cells) {
    fire += c.fire;
    heat += c.heat;
    smoke += c.smoke;
    oxygen += c.oxygen;
    fuel += c.fuel;
    structure += c.structure;
  }
  return {
    fire: fire / n,
    heat: heat / n,
    smoke: smoke / n,
    oxygen: oxygen / n,
    fuel: fuel / n,
    structure: structure / n,
  };
}

/**
 * 回燃风险：氧气不足 + 烟气富集 + 高温，三者同时成立才危险。
 * 门的表面温度单独进入判断，所以“先冷却门”能实质降低风险。
 */
export function computeBackdraftRisk(state: RoomState): number {
  const s = roomSummary(state);
  const oxygenDeficit = clamp01((0.55 - s.oxygen) / 0.32);
  const smokeLoad = clamp01(s.smoke / 0.5);
  const bodyHeat = clamp01(s.heat / 0.45);
  const doorHeat = clamp01(state.openings.door.temp / 0.5);
  return clamp01(oxygenDeficit * 0.35 + smokeLoad * 0.25 + bodyHeat * 0.15 + doorHeat * 0.25);
}

/** 富燃料（闷烧）状态：回燃的前提。 */
export function isFuelRich(state: RoomState): boolean {
  const s = roomSummary(state);
  return s.oxygen < 0.6 && s.smoke > 0.3 && s.heat > 0.28;
}

export function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  return Math.min(1, Math.max(0, v));
}
