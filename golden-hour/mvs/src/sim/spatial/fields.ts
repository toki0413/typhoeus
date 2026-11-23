/**
 * Phase 0：单房间粗网格场模型。
 *
 * 一格 = 0.75 m，6×6 m 房间 = 8×8 格。每格独立记录燃料、火、热、烟、氧、水与结构。
 * 这里只做“场”，不碰渲染与输入；保证固定步长、无随机、可重放。
 */

export type OpeningId = 'door' | 'window';

/**
 * 火灾分类（GB/T 4968 / 国际通行）：
 * A 固体（木材、布料、沙发） B 液体/可熔化固体（油、油漆） C 气体
 * D 金属 E 带电 F 食用油（厨房）
 */
export type FireClass = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

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
  /** 蒸汽 0..1：水遇高温产生，降低能见度 */
  steam: number;
  /** 结构完整度 1..0 */
  structure: number;
  /** 可燃性 0..1 */
  combustibility: number;
  /** 单位燃料产烟系数 */
  smokeYield: number;
  /** 该格燃料的火灾类别；决定哪种灭火剂有效 */
  fireClass: FireClass;
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
  /** 门板被打湿的程度 0..1；湿门不易成为回燃的点火面 */
  wet: number;
  /** 打开时是否会把新鲜空气直接送进富燃料烟气层（门为 true，窗为 false） */
  backdraftTrigger: boolean;
}

export interface RoomEvent {
  at: number;
  kind:
    | 'open'
    | 'break'
    | 'cool'
    | 'backdraft'
    | 'ignite'
    | 'extinguish'
    | 'vent'
    | 'misagent';
  detail: string;
}

/**
 * 灭火器材不是“永远满格”的：可能过期、压力不足、水带破损。
 * 玩家要先检查，再决定用器材还是就地取材。
 */
export type ToolKey =
  | 'water'
  | 'dryPowder'
  | 'co2'
  | 'foam'
  | 'wetChemical'
  | 'sand';

export type ToolCondition = 'ok' | 'expired' | 'depressurized' | 'broken' | 'empty';

export interface ToolState {
  /** 余量 0..1 */
  charge: number;
  condition: ToolCondition;
}

export type ToolLoadout = Record<ToolKey, ToolState>;

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
  tools: ToolLoadout;
}

export const ROOM_COLS = 8;
export const ROOM_ROWS = 8;
export const CELL_SIZE = 0.75;

const VISIBILITY_SMOKE_WEIGHT = 0.6;
const VISIBILITY_STEAM_WEIGHT = 0.4;

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
    steam: 0,
    structure: 1,
    combustibility: 0,
    smokeYield: 0,
    fireClass: 'A',
  };
}

function makeFuel(
  fuel: number,
  combustibility: number,
  smokeYield: number,
  fireClass: FireClass = 'A'
): Partial<Cell> {
  return { fuel, combustibility, smokeYield, fireClass };
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
        wet: 0,
        backdraftTrigger: true,
      },
      window: {
        id: 'window',
        x: full.cols - 1,
        y: Math.floor(full.rows / 2),
        open: false,
        broken: false,
        temp: 0.12,
        wet: 0,
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
    tools: {
      water: { charge: 1, condition: 'ok' },
      dryPowder: { charge: 1, condition: 'ok' },
      co2: { charge: 1, condition: 'ok' },
      foam: { charge: 0, condition: 'empty' },
      wetChemical: { charge: 0, condition: 'empty' },
      sand: { charge: 0, condition: 'empty' },
    },
  };

  // 沙发：靠窗的一块 L 形可燃家具（A 类固体火）
  const sofa = [
    [5, 3],
    [6, 3],
    [5, 4],
    [6, 4],
    [5, 5],
  ];
  for (const [x, y] of sofa) {
    if (!inBounds(full, x, y)) continue;
    Object.assign(cellAt(state, x, y), makeFuel(1, 0.8, 1.4, 'A'));
  }

  // 门内侧一桶松香水（B 类液体火）：用水会飞溅扩散，必须先断源或用干粉/泡沫
  Object.assign(cellAt(state, 2, 5), makeFuel(0.5, 0.95, 2.2, 'B'));
  Object.assign(cellAt(state, 2, 5), { fire: 0.15, heat: 0.16 });

  // 火源在沙发中间
  const source = cellAt(state, 5, 4);
  source.fire = 0.45;
  source.fuel = 1;
  source.combustibility = 0.85;
  source.smokeYield = 1.6;
  source.heat = 0.2;
  source.fireClass = 'A';

  return state;
}

/** 场聚合值，供 HUD、风险和测试使用。 */
export function roomSummary(state: RoomState): {
  fire: number;
  heat: number;
  smoke: number;
  steam: number;
  visibility: number;
  oxygen: number;
  fuel: number;
  structure: number;
} {
  const n = state.cells.length;
  let fire = 0;
  let heat = 0;
  let smoke = 0;
  let steam = 0;
  let oxygen = 0;
  let fuel = 0;
  let structure = 0;
  for (const c of state.cells) {
    fire += c.fire;
    heat += c.heat;
    smoke += c.smoke;
    steam += c.steam;
    oxygen += c.oxygen;
    fuel += c.fuel;
    structure += c.structure;
  }
  const avgSmoke = smoke / n;
  const avgSteam = steam / n;
  return {
    fire: fire / n,
    heat: heat / n,
    smoke: avgSmoke,
    steam: avgSteam,
    visibility: clamp01(
      1 - avgSmoke * VISIBILITY_SMOKE_WEIGHT - avgSteam * VISIBILITY_STEAM_WEIGHT
    ),
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
