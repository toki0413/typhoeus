import {
  cellAt,
  clamp01,
  computeBackdraftRisk,
  index,
  inBounds,
  isFuelRich,
  roomSummary,
  type Opening,
  type RoomState,
} from './fields';

/** 固定步长：场以 10 Hz 推进，渲染层自行插值。 */
export const FIXED_DT = 0.1;

const DOOR_INTAKE = 0.85;
const WINDOW_INTAKE = 0.24;
const DOOR_VENT = 0.55;
const WINDOW_VENT = 2.2;

const SMOKE_DIFFUSION = 1.6;
const OXYGEN_DIFFUSION = 2.4;
const HEAT_DIFFUSION = 1.8;
const HEAT_COOLING = 0.12;

const BURN_RATE = 0.05;
const OXY_CONSUME = 40;
const HEAT_GAIN = 7;
const SMOKE_GAIN = 20;

const DOOR_TEMP_CONTACT = 0.7;
const BACKDRAFT_DELAY = 0.9;
const BACKDRAFT_DOOR_TEMP = 0.3;

export function openingOpen(o: Opening): boolean {
  return o.open || o.broken;
}

function applyVentilation(state: RoomState, dt: number): void {
  for (const id of ['door', 'window'] as const) {
    const o = state.openings[id];
    if (!openingOpen(o)) continue;
    const c = cellAt(state, o.x, o.y);

    const intake = id === 'door' ? DOOR_INTAKE : WINDOW_INTAKE;
    const before = c.oxygen;
    c.oxygen = clamp01(c.oxygen + (1 - c.oxygen) * Math.min(1, intake * dt));
    state.stats.oxygenIn += c.oxygen - before;

    const vent = id === 'door' ? DOOR_VENT : WINDOW_VENT;
    const removed = c.smoke * Math.min(1, vent * dt);
    c.smoke -= removed;
    state.stats.smokeVented += removed;
  }
}

function diffuse(state: RoomState, dt: number): void {
  const { config, cells } = state;
  const n = cells.length;
  const smoke = new Float32Array(n);
  const oxygen = new Float32Array(n);
  const heat = new Float32Array(n);

  const kSmoke = Math.min(0.9, SMOKE_DIFFUSION * dt);
  const kOxy = Math.min(0.9, OXYGEN_DIFFUSION * dt);
  const kHeat = Math.min(0.9, HEAT_DIFFUSION * dt);

  for (let y = 0; y < config.rows; y++) {
    for (let x = 0; x < config.cols; x++) {
      const i = index(config, x, y);
      const c = cells[i];
      let sAcc = c.smoke;
      let oAcc = c.oxygen;
      let hAcc = c.heat;
      let count = 1;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + dx;
        const ny = y + dy;
        if (!inBounds(config, nx, ny)) continue;
        const nb = cells[index(config, nx, ny)];
        sAcc += nb.smoke;
        oAcc += nb.oxygen;
        hAcc += nb.heat;
        count += 1;
      }
      smoke[i] = clamp01(c.smoke + (sAcc / count - c.smoke) * kSmoke);
      oxygen[i] = clamp01(c.oxygen + (oAcc / count - c.oxygen) * kOxy);
      heat[i] = clamp01(c.heat + (hAcc / count - c.heat) * kHeat);
    }
  }

  for (let i = 0; i < n; i++) {
    cells[i].smoke = smoke[i];
    cells[i].oxygen = oxygen[i];
    cells[i].heat = heat[i];
  }
}

function burn(state: RoomState, dt: number): void {
  for (const c of state.cells) {
    if (c.fire <= 0.001 && c.fuel <= 0.001) {
      c.heat = clamp01(c.heat - c.heat * HEAT_COOLING * dt);
      continue;
    }

    if (c.fuel > 0.001 && c.oxygen > 0.04 && c.water < 0.6) {
      const target = Math.min(1, c.oxygen * 1.6) * (0.35 + c.combustibility * 0.65);
      c.fire = clamp01(c.fire + (target - c.fire) * 0.5 * dt);
      const burned = c.fire * BURN_RATE * dt;
      c.fuel = Math.max(0, c.fuel - burned);
      c.oxygen = clamp01(c.oxygen - burned * OXY_CONSUME);
      c.heat = clamp01(c.heat + burned * HEAT_GAIN);
      c.smoke = clamp01(c.smoke + burned * c.smokeYield * SMOKE_GAIN);
    } else {
      c.fire = clamp01(c.fire - 0.45 * dt);
    }

    if (c.fuel <= 0.001) {
      c.fire = clamp01(c.fire - 0.3 * dt);
    }
    c.heat = clamp01(c.heat - c.heat * HEAT_COOLING * dt);
  }
}

function applyWater(state: RoomState, dt: number): void {
  for (const c of state.cells) {
    if (c.water <= 0) continue;
    c.fire = clamp01(c.fire - c.water * 0.9 * dt);
    c.heat = clamp01(c.heat - c.water * 0.5 * dt);
    c.water = Math.max(0, c.water - 0.12 * dt);
  }
}

function applyStructure(state: RoomState, dt: number): void {
  for (const c of state.cells) {
    if (c.heat <= 0.75) continue;
    c.structure = Math.max(0, c.structure - (c.heat - 0.75) * 0.2 * dt);
  }
}

function trackDoorTemp(state: RoomState, dt: number): void {
  const s = roomSummary(state);
  const contact = cellAt(state, state.openings.door.x, state.openings.door.y).heat;
  const target = clamp01(contact * DOOR_TEMP_CONTACT + s.heat * (1 - DOOR_TEMP_CONTACT));
  const door = state.openings.door;
  door.temp = clamp01(door.temp + (target - door.temp) * 0.6 * dt);
  const win = state.openings.window;
  const winContact = cellAt(state, win.x, win.y).heat;
  win.temp = clamp01(win.temp + (clamp01(winContact * 0.8 + s.heat * 0.2) - win.temp) * 0.6 * dt);
}

function resolveBackdraft(state: RoomState): void {
  if (!state.pendingBackdraft) return;
  if (state.lastOpenedAt === null) return;
  if (state.t - state.lastOpenedAt < BACKDRAFT_DELAY) return;
  triggerBackdraft(state);
}

/** 开门/窗瞬间判定：富燃料 + 门板高温，才会把新鲜空气变成爆燃。 */
export function shouldBackdraft(state: RoomState, id: 'door' | 'window'): boolean {
  const o = state.openings[id];
  if (!o.backdraftTrigger) return false;
  return isFuelRich(state) && o.temp > BACKDRAFT_DOOR_TEMP;
}

export function triggerBackdraft(state: RoomState): void {
  const source = state.lastOpened ? state.openings[state.lastOpened] : state.openings.door;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const x = source.x + dx;
      const y = source.y + dy;
      if (!inBounds(state.config, x, y)) continue;
      const d = Math.hypot(dx, dy);
      const w = Math.max(0, 1 - d / 3);
      const c = cellAt(state, x, y);
      c.fire = clamp01(Math.max(c.fire, 0.75 * w));
      c.heat = clamp01(Math.max(c.heat, 0.9 * w));
      c.smoke = clamp01(c.smoke + 0.6 * w);
      c.oxygen = clamp01(c.oxygen - 0.25 * w);
    }
  }
  state.backdraftAt = state.t;
  state.pendingBackdraft = false;
  state.stats.peakHeat = 1;
  state.log.push({ at: state.t, kind: 'backdraft', detail: '开门瞬间回燃' });
}

/** 推进一个固定步长。所有子系统按固定顺序执行，保证确定性。 */
export function stepRoom(state: RoomState, dt = FIXED_DT): void {
  state.t += dt;
  applyVentilation(state, dt);
  diffuse(state, dt);
  burn(state, dt);
  applyWater(state, dt);
  applyStructure(state, dt);
  trackDoorTemp(state, dt);
  resolveBackdraft(state);
  state.backdraftRisk = computeBackdraftRisk(state);
  state.stats.peakHeat = Math.max(state.stats.peakHeat, roomSummary(state).heat);
}

/** 测试与复盘用：按固定步长推进若干秒。 */
export function runRoom(state: RoomState, seconds: number): void {
  const steps = Math.round(seconds / FIXED_DT);
  for (let i = 0; i < steps; i++) stepRoom(state, FIXED_DT);
}
