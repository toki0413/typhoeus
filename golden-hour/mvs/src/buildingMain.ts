import { clamp01, computeBackdraftRisk, roomSummary } from './sim/spatial/fields';
import { FIXED_DT } from './sim/spatial/spread';
import { createActor, moveActor, stepActor } from './sim/spatial/actor';
import {
  createResident,
  findResident,
  type ResidentState,
} from './sim/agents/resident';
import {
  createCrowd,
  rescueResident,
  stepCrowd,
  type RescueReason,
  type RescueVerb,
} from './sim/agents/crowd';
import { gridToWorld } from './sim/spatial/coords';
import { createScenarioForBuilding, snapshotScenario, stepScenario } from './sim/spatial/scene';
import { LAYOUTS, layoutById, layoutFireProfile } from './content/layouts';
import { buildingToolActions, type BuildingToolAction } from './app/buildingTools';
import { isUnlocked, loadProgress, recordRun, saveProgress } from './app/progress';
import {
  createSave,
  deserializeSave,
  serializeSave,
  type GameSave,
} from './app/save';
import {
  compareRuns,
  scoreRun,
  type RunComparison,
  type RunResult,
  type ScoreBreakdown,
} from './eval/score';
import { createToolLoadout, type CarryLoadout } from './sim/interaction/tools';
import { executeVerb } from './sim/interaction/multiSolution';
import {
  createDirector,
  COLLAPSE_SECONDS,
  setWind,
  stepDirector,
  type DirectorEvent,
} from './sim/events/director';
import { sampleRoom, buildDebrief, type ActionRecord } from './eval/causal';
import { buildCurvePaths, trimCurve, type CurveSample } from './eval/curves';
import { BRIEFING, RADIO_LINES } from './content/narrative';
import { findRoutes, type Route } from './sim/nav/graph';
import { travelRoute } from './sim/nav/travel';
import { createBuildingView } from './render/buildingView';
import {
  residentMarkers,
  residentVisualState,
  type ResidentVisualState,
} from './render/residents';

const canvas = document.getElementById('building-canvas') as HTMLCanvasElement;
const view = createBuildingView(canvas);
const params = new URLSearchParams(window.location.search);
/** 从查询串选择户型；未解锁或未知 id 回退到第一个已解锁户型。 */
const requestedLayout = params.get('layout') ?? '';
/** 每日挑战与普通局共用同一解锁进度，按分数解锁，不额外区分。 */
let progress = loadProgress();
const layoutIds = LAYOUTS.map((item) => item.id);
const requested = layoutById(requestedLayout);
const layout =
  requested && isUnlocked(progress, layoutIds, requested.id)
    ? requested
    : LAYOUTS.find((item) => isUnlocked(progress, layoutIds, item.id)) ?? LAYOUTS[0];
/** 每日挑战用当天日期（YYYYMMDD）当种子；普通局用 seed 参数，非法则回退 1。 */
const daily = params.get('daily') === '1';
/** ?perf=1 时显示帧率与固定步长耗时，便于桌面 60fps 实测。 */
const perfMode = params.get('perf') === '1';
const seedParam = Number(params.get('seed'));
const seed = daily
  ? Number(new Date().toISOString().slice(0, 10).replace(/-/g, ''))
  : Number.isFinite(seedParam) && seedParam > 0
    ? Math.floor(seedParam)
    : 1;
let def = createScenarioForBuilding(
  layout.build(),
  layout.entrance,
  layout.target,
  'layout-' + layout.id,
  seed,
  layoutFireProfile(layout)
);
let actor = createActor();
/** 随身器材；工具动作会消耗 charge，用空后按钮禁用。 */
let loadout: CarryLoadout = createToolLoadout();
// 建筑入口按消防员佩戴空呼处理：烟热仍会累积，但足以支撑多次进出救援。
actor.masked = true;

/** 在 202 的指定格放置一名居民，并写入初始健康/恐慌。 */
function residentAt(
  id: string,
  gx: number,
  gy: number,
  health: number,
  panic: number
): ResidentState {
  const point = gridToWorld(gx, gy);
  const resident = createResident(def.targetRoom, point.x, point.z, id);
  resident.health = health;
  resident.panic = panic;
  return resident;
}

/** 居民 C 初始就躲在下侧中段；血线略高，留给“发现 + 走过去”的窗口。 */
const residentC = residentAt('C', 3, 6, 0.6, 0.3);
residentC.hidden = true;

let crowd = createCrowd(
  def.targetRoom,
  [
    residentAt('A', 2, 5, 1, 0),
    residentAt('B', 2, 2, 0.45, 0.6),
    residentC,
  ],
  seed
);

/** 存档键：与最佳记录一样按户型 + 种子隔离，只在同户型同种子下恢复。 */
const SAVE_KEY = 'gh-save:' + layout.id + ':' + seed;

let currentRoom = def.startRoom;
let routes: Route[] = [];
let ended = false;
let acc = 0;
let lastHud = 0;
let logs: { text: string; kind: 'info' | 'ok' | 'danger' }[] = [];

/** 事件导演：风向、窗户失效与坍塌都由它决定，完全确定性。 */
let director = createDirector(seed);
/** 固定风向日程：按模拟时间触发，每条只生效一次。 */
const WIND_SCHEDULE = [
  { at: 15, x: 1, y: 0, speed: 0.7 },
  { at: 30, x: 0, y: 1, speed: 0.8 },
];
let windCursor = 0;
let seenEvents = 0;
/** 因果复盘用的动作记录；按发生顺序追加。 */
const actions: ActionRecord[] = [];
let actionSeq = 0;
/** 对非 A 类火使用水枪的次数；先只维护，供后续评分使用。 */
let wrongAgent = 0;
/** 结算暴露曲线的采样；每 0.5 秒一条。 */
const exposureSamples: CurveSample[] = [];
let lastSampleT = -1;
let radioCursor = 0;
/** 当前按下的移动键；键盘与触控 D-pad 共用同一集合。 */
const held = new Set<string>();
/** 三类前兆只提示一次，避免在 HUD 节流循环里重复刷屏。 */
let airWarned = false;
let backdraftWarned = false;
let collapseWarned = false;
/** 已写入因果复盘的失去居民 id，防止同一人重复记录。 */
const lostIds = new Set<string>();

const out = {
  room: document.getElementById('hud-room')!,
  target: document.getElementById('hud-target')!,
  seed: document.getElementById('hud-seed')!,
  stamina: document.getElementById('hud-stamina')!,
  exposure: document.getElementById('hud-exposure')!,
  air: document.getElementById('hud-air')!,
  resident: document.getElementById('hud-resident')!,
  time: document.getElementById('hud-time')!,
  wind: document.getElementById('hud-wind')!,
  perf: document.getElementById('perf')!,
  routes: document.getElementById('routes')!,
  residents: document.getElementById('residents')!,
  tools: document.getElementById('tools')!,
  log: document.getElementById('log')!,
  outcome: document.getElementById('outcome')!,
  outcomeTitle: document.getElementById('outcome-title')!,
  outcomeBody: document.getElementById('outcome-body')!,
  outcomeScore: document.getElementById('outcome-score')!,
  curve: document.getElementById('outcome-curve')!,
  debrief: document.getElementById('outcome-debrief')!,
};

/** 户型下拉：选项来自 LAYOUTS，切换后带查询串重新载入入口。 */
const layoutSelect = document.getElementById('layout-select') as HTMLSelectElement | null;
if (layoutSelect) {
  layoutSelect.innerHTML = LAYOUTS.map((item) => {
    const unlocked = isUnlocked(progress, layoutIds, item.id);
    const label = unlocked ? item.label : `${item.label}（未解锁）`;
    return `<option value="${item.id}"${
      item.id === layout.id ? ' selected' : ''
    }${unlocked ? '' : ' disabled'}>${label}</option>`;
  }).join('');
  layoutSelect.addEventListener('change', () => {
    const url = new URL(window.location.href);
    url.searchParams.set('layout', layoutSelect.value);
    window.location.assign(url.toString());
  });
}

/** 每日挑战入口：带当前户型跳到当天种子，清掉旧查询串。 */
const dailyLink = document.getElementById('daily-link') as HTMLAnchorElement | null;
if (dailyLink) {
  const url = new URL(window.location.href);
  url.search = '';
  url.searchParams.set('daily', '1');
  url.searchParams.set('layout', layout.id);
  dailyLink.href = url.toString();
}

const STATE_TEXT: Record<ResidentVisualState, string> = {
  calm: '平静',
  panic: '恐慌',
  hidden: '躲藏',
  unconscious: '昏迷',
  dead: '已失去',
  rescued: '已救出',
};

/** 8 个中文方位：0° 指向东，每 45° 一档。 */
const WIND_LABELS = ['东', '东北', '北', '西北', '西', '西南', '南', '东南'];

/** 把导演的风矢量翻成“方位 · 风速”，供 HUD 显示。 */
function windText(): string {
  const { x, y, speed } = director.wind;
  if (Math.hypot(x, y) < 1e-6) return `无风 · ${speed.toFixed(2)}`;
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  const slot = Math.round(((deg + 360) % 360) / 45) % 8;
  return `${WIND_LABELS[slot]} · ${speed.toFixed(2)}`;
}

function addLog(text: string, kind: 'info' | 'ok' | 'danger' = 'info'): void {
  logs = [{ text, kind }, ...logs].slice(0, 6);
  out.log.innerHTML = logs
    .map((entry) => `<p class="${entry.kind}">${entry.text}</p>`)
    .join('');
}

function roomOf(id: string) {
  return def.building.rooms[id].room;
}

function targetRoom(): string {
  return def.targetRoom;
}

/** 按模拟时间触发固定风向日程，每条只触发一次。 */
function applyWindSchedule(): void {
  while (
    windCursor < WIND_SCHEDULE.length &&
    director.t >= WIND_SCHEDULE[windCursor].at
  ) {
    const next = WIND_SCHEDULE[windCursor];
    setWind(director, next.x, next.y, next.speed);
    windCursor += 1;
  }
}

/** 把导演的新事件写进日志；坍塌会封锁链路，需要立刻刷新路线。 */
function flushDirectorEvents(): void {
  for (; seenEvents < director.events.length; seenEvents++) {
    const event: DirectorEvent = director.events[seenEvents];
    addLog(event.detail, event.kind === 'collapse' ? 'danger' : 'info');
    if (event.kind === 'collapse') recalcRoutes();
  }
}

/**
 * 每 0.5 秒采样一次目标房间与玩家的烟热暴露；
 * 同时把到点的无线电写进日志，每条只触发一次。
 */
function sampleRun(): void {
  const target = roomOf(def.targetRoom);
  const t = target.t;
  if (t - lastSampleT >= 0.5) {
    lastSampleT = t;
    exposureSamples.push({
      t,
      smoke: actor.exposure.smoke,
      heat: actor.exposure.heat,
      fire: roomSummary(target).fire,
    });
  }
  while (radioCursor < RADIO_LINES.length && RADIO_LINES[radioCursor].at <= t) {
    const line = RADIO_LINES[radioCursor];
    radioCursor += 1;
    addLog(`【${line.speaker}】${line.text}`);
  }
}

/**
 * 把新失去的居民写进因果复盘；每人只记一次。
 * 前后场取当前聚合值，损失本身不改变房间场，只记录发生时刻。
 */
function recordLosses(): void {
  for (const resident of crowd.residents) {
    if (!resident.dead || resident.rescued) continue;
    if (lostIds.has(resident.id)) continue;
    lostIds.add(resident.id);
    const room = roomOf(def.targetRoom);
    const current = sampleRoom(room);
    actions.push({
      id: 'lost-' + resident.id,
      at: room.t,
      action: 'lost:' + resident.id,
      roomId: def.targetRoom,
      before: current,
      after: current,
    });
  }
}

/** 推进一个固定步长：风向日程 → 火场 → 人群 → 事件导演 → 采样。 */
function advanceWorld(dt: number, stepCrowdNow = true): void {
  applyWindSchedule();
  stepScenario(def, dt);
  // 救援动作内部已按耗时推进过人群，外部补时间时不能重复推进。
  if (stepCrowdNow) stepCrowd(crowd, roomOf(def.targetRoom), dt);
  stepDirector(director, def.building, dt);
  flushDirectorEvents();
  sampleRun();
  recordLosses();
}

function reasonText(reason: RescueReason): string {
  switch (reason) {
    case 'too-far':
      return '离居民太远';
    case 'not-found':
      return '没找到';
    case 'unconscious-needs-carry':
      return '昏迷只能背';
    case 'lost':
      return '已经失去';
    case 'actor-downed':
      return '你已失去行动能力';
    case 'already-rescued':
      return '已救出';
    case 'ok':
      return '成功';
  }
}

function recalcRoutes(): void {
  routes =
    currentRoom === targetRoom()
      ? []
      : findRoutes(def.building, currentRoom, targetRoom(), actor, 3);
  renderRoutes();
}

function renderRoutes(): void {
  if (currentRoom === targetRoom()) {
    out.routes.innerHTML =
      '<p class="hint">在目标房间：WASD/方向键移动，靠近居民后牵出或背出；角落可能有躲藏者。工具在右侧面板。</p>';
    return;
  }
  if (!routes.length) {
    out.routes.innerHTML = '<p class="hint">没有可行路线，先休息恢复体力。</p>';
    return;
  }
  out.routes.innerHTML = routes
    .map((route, index) => {
      const kinds = route.steps.map((step) => step.kind).join(' → ');
      return `<button data-route="${index}" aria-label="选择路线 ${index + 1}：${kinds}">
        <b>${index + 1}. ${kinds}</b>
        <small>${route.time.toFixed(0)}s · 累计风险 ${route.risk.toFixed(2)}</small>
      </button>`;
    })
    .join('');
}

/** 把 #residents 渲染成每个未获救居民一行，附牵/背按钮。 */
function renderResidents(): void {
  residentsSig = residentSignature();
  if (ended) {
    out.residents.innerHTML = '<p class="hint">本轮已结束。</p>';
    return;
  }
  if (currentRoom !== def.targetRoom) {
    out.residents.innerHTML = '<p class="hint">抵达目标房间后可选择牵出或背出。</p>';
    return;
  }

  const rows = crowd.residents
    .filter((resident) => !resident.rescued)
    .filter((resident) => !resident.hidden || findResident(resident, actor))
    .map((resident) => {
      const state = residentVisualState(resident);
      const isDead = state === 'dead';
      const canLead = state !== 'unconscious' && !isDead;
      return `<div class="resident-row">
        <span class="resident-name">居民 ${resident.id}</span>
        <span class="resident-meta">${Math.round(resident.health * 100)}% · ${
          STATE_TEXT[state]
        }</span>
        <span class="resident-actions">
          <button data-rescue="${resident.id}:lead" aria-label="牵出居民 ${resident.id}"${
            canLead ? '' : ' disabled'
          }>牵</button>
          <button data-rescue="${resident.id}:carry" aria-label="背出居民 ${resident.id}"${
            isDead ? ' disabled' : ''
          }>背</button>
        </span>
      </div>`;
    })
    .join('');

  out.residents.innerHTML =
    rows || '<p class="hint">房间角落可能有居民，靠近搜索。</p>';
}

let residentsSig = '';

/** 居民面板的内容指纹；只有状态变化时才重建，避免每帧替换按钮。 */
function residentSignature(): string {
  const parts = crowd.residents.map(
    (resident) =>
      `${resident.id}:${resident.rescued ? 1 : 0}:${resident.dead ? 1 : 0}:${
        resident.mood
      }:${Math.round(resident.health * 20)}:${findResident(resident, actor) ? 1 : 0}`
  );
  return `${currentRoom}|${ended ? 1 : 0}|${parts.join(',')}`;
}

function syncResidents(): void {
  if (residentSignature() === residentsSig) return;
  renderResidents();
}

let toolsSig = '';

/** 工具面板的内容指纹：房间、结束状态、可用性与余量百分比。 */
function toolsSignature(actions: BuildingToolAction[], inactive: boolean): string {
  const parts = actions.map(
    (action) => `${action.verbId}:${action.enabled ? 1 : 0}:${Math.round(action.charge * 100)}`
  );
  return `${inactive ? 1 : 0}|${parts.join(',')}`;
}

/** 渲染右侧工具面板；不在目标房间或已结束时全部禁用。 */
function refreshTools(): void {
  const inactive = ended || currentRoom !== def.targetRoom;
  const actions = buildingToolActions(roomOf(def.targetRoom), loadout);
  const sig = toolsSignature(actions, inactive);
  if (sig === toolsSig) return;
  toolsSig = sig;

  out.tools.innerHTML = actions
    .map((action) => {
      const enabled = action.enabled && !inactive;
      const percent = Math.round(action.charge * 100);
      return `<button data-verb="${action.verbId}" aria-label="${action.label}，余量 ${percent}%"${
        enabled ? '' : ' disabled'
      }>${action.label}<small>${percent}%</small></button>`;
    })
    .join('');
}

/** 执行一次工具动作，并记录因果复盘与用错灭火剂的次数。 */
function runToolAction(action: BuildingToolAction): void {
  if (ended || currentRoom !== def.targetRoom) return;

  const room = roomOf(def.targetRoom);
  const before = sampleRoom(room);
  const at = room.t;
  // 是否“用错水”，取决于动作发生时正在燃烧的火类。
  const wetNonA = room.cells.some((cell) => cell.fire > 0 && cell.fireClass !== 'A');
  const result = executeVerb(action.verbId, {
    room,
    loadout,
    actor,
    target: action.target,
  });

  actions.push({
    id: 'tool-' + action.verbId + '-' + ++actionSeq,
    at,
    action: 'tool:' + action.verbId,
    roomId: def.targetRoom,
    before,
    after: sampleRoom(room),
  });

  addLog(result.lesson, result.ok ? 'ok' : 'danger');
  if (action.verbId === 'fire-water' && result.ok && wetNonA) wrongAgent += 1;

  refreshTools();
  updateHud();
}

function takeRoute(index: number): void {
  if (ended) return;
  const route = routes[index];
  if (!route) return;

  const travel = travelRoute(def.building, route, actor, currentRoom);
  if (!travel.ok) {
    addLog('这条路线现在过不去，重新规划。', 'danger');
    recalcRoutes();
    return;
  }

  // 行进前后各取一次 202 的聚合场，用于因果复盘。
  const before = sampleRoom(roomOf(def.targetRoom));
  const at = roomOf(def.targetRoom).t;

  currentRoom = travel.roomId;
  // 到达 202 时落在门侧入口，避免玩家站在火源所在格上承受数倍暴露。
  if (currentRoom === def.targetRoom) {
    actor.x = -2.4;
    actor.z = 0;
  } else {
    actor.x = 0;
    actor.z = 0;
  }

  const ticks = Math.max(1, Math.round(travel.time / FIXED_DT));
  for (let i = 0; i < ticks; i++) {
    // 路上只推进世界，玩家暴露由到达后的驻留与救援承担。
    advanceWorld(FIXED_DT);
  }

  actions.push({
    id: 'travel-' + ++actionSeq,
    at,
    action: 'travel:' + route.steps.map((step) => step.kind).join('→'),
    roomId: def.targetRoom,
    before,
    after: sampleRoom(roomOf(def.targetRoom)),
  });

  addLog(`通过 ${route.steps.map((step) => step.kind).join(' → ')}，到达 ${currentRoom}`, 'ok');
  recalcRoutes();
  syncResidents();
  refreshTools();
  updateHud();
  checkOutcome();
}

function handleRescue(id: string, verb: RescueVerb): void {
  if (ended) return;
  if (currentRoom !== def.targetRoom) {
    addLog('先到目标房间才能救人。', 'danger');
    return;
  }

  // 救援前后各取一次 202 的聚合场，用于因果复盘。
  const before = sampleRoom(roomOf(def.targetRoom));
  const at = roomOf(def.targetRoom).t;
  const t0 = crowd.t;
  const result = rescueResident(
    crowd,
    id,
    actor,
    roomOf(def.targetRoom),
    verb
  );
  const elapsed = crowd.t - t0;

  // 救援消耗的模拟时间同样推进火场与玩家暴露，让取舍有真实代价。
  const ticks = Math.max(0, Math.round(elapsed / FIXED_DT));
  for (let i = 0; i < ticks; i++) {
    advanceWorld(FIXED_DT, false);
    stepActor(actor, roomOf(currentRoom), FIXED_DT, true);
  }

  actions.push({
    id: 'rescue-' + id + '-' + ++actionSeq,
    at,
    action: verb === 'carry' ? 'carry' : 'lead',
    roomId: def.targetRoom,
    before,
    after: sampleRoom(roomOf(def.targetRoom)),
  });

  if (result.ok) {
    addLog(`${verb === 'carry' ? '已背出' : '已牵出'} 居民 ${id}`, 'ok');
    // 救援内部推进过世界，工具余量可能随动作变化，刷新面板。
    refreshTools();
  } else {
    addLog(`${reasonText(result.reason)}（居民 ${id}）`, 'danger');
  }

  recordLosses();
  syncResidents();
  updateHud();
  checkOutcome();
}

function updateHud(): void {
  const exposure = clamp01(actor.exposure.smoke + actor.exposure.heat);
  const remaining = crowd.residents.length - crowd.rescued - crowd.lost;
  out.room.textContent = currentRoom;
  out.target.textContent = targetRoom();
  out.seed.textContent = daily ? `每日 #${seed}` : `种子 ${seed}`;
  out.stamina.textContent = `${Math.round(actor.stamina * 100)}%`;
  out.air.textContent = `${Math.round(actor.air * 100)}%`;
  out.exposure.textContent = `${Math.round(exposure * 100)}%`;
  out.wind.textContent = windText();
  out.resident.textContent = `${crowd.rescued} 救出 · ${crowd.lost} 失去 · ${remaining} 待救`;
  out.time.textContent = `${roomOf(def.targetRoom).t.toFixed(1)}s`;
}

function checkOutcome(): void {
  if (ended) return;
  const total = crowd.residents.length;
  // 先结算“所有人都有了结果”，避免最后一救后被随后累积的暴露覆盖成绩。
  if (crowd.rescued + crowd.lost >= total) {
    const seconds = def.building.rooms[def.startRoom].room.t;
    end(
      `救出 ${crowd.rescued} / ${total}`,
      `失去 ${crowd.lost} 人，用时 ${seconds.toFixed(1)} 秒。结果来自行动顺序与火场压力。`
    );
    return;
  }
  if (actor.downed) {
    end('你被烟和热压倒了', '路线不是免费的：烟层、体力都会改变可选路径。');
  }
}

/** 最佳记录：本局结果 + 暴露曲线，用于结算时的幽灵对比。 */
interface BestRecord {
  run: RunResult;
  curve: CurveSample[];
}

/** 结算时先画本次实线；若最佳记录有曲线，再叠两条虚线幽灵。 */
function renderCurve(bestCurve: CurveSample[]): void {
  const curve = buildCurvePaths(exposureSamples);
  if (!curve.hasData) {
    out.curve.innerHTML = '<p class="hint">没有采样到暴露曲线。</p>';
    return;
  }
  // 最佳曲线复用同一画布尺寸，横向按各自时间轴铺满。
  const ghost = bestCurve.length
    ? buildCurvePaths(bestCurve, curve.width, curve.height)
    : null;
  const ghostPaths = ghost?.hasData
    ? `<path class="ghost-smoke" d="${ghost.smoke}" />
        <path class="ghost-heat" d="${ghost.heat}" />`
    : '';
  const legend = ghostPaths ? '实线 本次 · 虚线 最佳' : '烟 / 热 / 火（0–1）';
  out.curve.innerHTML = `<svg viewBox="0 0 ${curve.width} ${curve.height}" role="img" aria-label="烟热暴露曲线">
        <path class="smoke" d="${curve.smoke}" />
        <path class="heat" d="${curve.heat}" />
        <path class="fire" d="${curve.fire}" />
        ${ghostPaths}
      </svg>
      <div class="curve-legend">${legend}</div>`;
}

/** 最佳记录按户型 + 种子隔离，避免每日挑战与普通局互相覆盖。 */
const BEST_KEY = `gh-best:${layout.id}:${seed}`;

/** 汇总本局结果：时间取起点房间时钟，峰值暴露取采样中烟+热的最大值。 */
function collectRun(): RunResult {
  let peak = 0;
  for (const sample of exposureSamples) {
    peak = Math.max(peak, sample.smoke + sample.heat);
  }
  return {
    rescued: crowd.rescued,
    lost: crowd.lost,
    total: crowd.residents.length,
    seconds: def.building.rooms[def.startRoom].room.t,
    peakExposure: clamp01(peak),
    wrongAgent,
    airLeft: actor.air,
  };
}

const RUN_KEYS = [
  'rescued',
  'lost',
  'total',
  'seconds',
  'peakExposure',
  'wrongAgent',
  'airLeft',
] as const;

/** 判断对象是否含完整的 RunResult 数值字段。 */
function isRunResult(value: unknown): value is RunResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return RUN_KEYS.every(
    (key) => typeof record[key] === 'number' && Number.isFinite(record[key] as number)
  );
}

/** 只保留数值合法的曲线采样点，坏点直接丢弃。 */
function readCurve(value: unknown): CurveSample[] {
  if (!Array.isArray(value)) return [];
  const samples: CurveSample[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const sample = item as Record<string, unknown>;
    const { t, smoke, heat, fire } = sample;
    if (typeof t !== 'number' || !Number.isFinite(t)) continue;
    if (typeof smoke !== 'number' || !Number.isFinite(smoke)) continue;
    if (typeof heat !== 'number' || !Number.isFinite(heat)) continue;
    const cleaned: CurveSample = { t, smoke, heat };
    if (typeof fire === 'number' && Number.isFinite(fire)) cleaned.fire = fire;
    samples.push(cleaned);
  }
  return samples;
}

/** 读取最佳记录；兼容旧的纯 RunResult 格式（无曲线）。 */
function loadBest(): BestRecord | null {
  try {
    const raw = window.localStorage.getItem(BEST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    // 旧格式直接存 RunResult：视为 run 且 curve 为空。
    if (isRunResult(parsed)) return { run: parsed, curve: [] };
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (!isRunResult(record.run)) return null;
    return { run: record.run, curve: readCurve(record.curve) };
  } catch {
    return null;
  }
}

/** 写入最佳记录（结果 + 截断曲线）；隐私模式或配额不足时静默放弃。 */
function saveBest(record: BestRecord): void {
  try {
    window.localStorage.setItem(BEST_KEY, JSON.stringify(record));
  } catch {
    // 忽略写入失败。
  }
}

/** 把存档写回运行期状态；只刷新入口面板，不改动模拟层。 */
function restoreFromSave(save: GameSave): void {
  def = save.def;
  actor = save.actor;
  // 旧存档没有器材余量：保留当前新建的一套。
  if (save.loadout) loadout = save.loadout;
  crowd = save.crowd;
  director = save.director;
  currentRoom = save.currentRoom;

  // 重置运行期状态，避免把上一局的时间轴与面板指纹带进来。
  ended = false;
  acc = 0;
  last = performance.now();
  seenEvents = director.events.length;
  // 无线电按目标房间已走过的模拟时刻推进，恢复后不重播旧台词。
  const t = roomOf(def.targetRoom).t;
  radioCursor = 0;
  while (radioCursor < RADIO_LINES.length && RADIO_LINES[radioCursor].at <= t) {
    radioCursor += 1;
  }
  lastSampleT = -1;
  exposureSamples.length = 0;
  actions.length = 0;
  actionSeq = 0;
  wrongAgent = 0;
  lostIds.clear();
  residentsSig = '';

  out.outcome.classList.remove('show');
  recalcRoutes();
  syncResidents();
  refreshTools();
  updateHud();
  addLog('已恢复上一局。', 'ok');
}

/** 保存当前进度；已经结束的局没有恢复价值，直接拒绝。 */
function saveCurrent(): void {
  if (ended) {
    addLog('本局已结束，无法保存。', 'danger');
    return;
  }
  const save = createSave({ def, actor, crowd, director, currentRoom, loadout });
  try {
    window.localStorage.setItem(SAVE_KEY, serializeSave(save));
  } catch {
    addLog('保存失败：浏览器存储不可用。', 'danger');
    return;
  }
  addLog('已保存当前进度。', 'ok');
}

/** 渲染星级、分数、原因列表、本次/最佳对比与该户型最佳分。 */
function renderScore(
  breakdown: ScoreBreakdown,
  comparison: RunComparison | null,
  bestScore: number
): void {
  const stars = '★'.repeat(breakdown.stars) + '☆'.repeat(3 - breakdown.stars);
  const versus = comparison
    ? `本次 vs 最佳：救出 ${comparison.rescuedDelta >= 0 ? '+' : ''}${
        comparison.rescuedDelta
      } · 用时 ${comparison.timeDelta >= 0 ? '+' : ''}${comparison.timeDelta.toFixed(
        1
      )}s · 峰值暴露 ${comparison.exposureDelta >= 0 ? '+' : ''}${comparison.exposureDelta.toFixed(
        2
      )}`
    : '首次记录，已保存为最佳';
  out.outcomeScore.innerHTML = `<b class="stars">${stars}</b> ${breakdown.score} 分<div class="reasons">${breakdown.reasons.join(
    ' · '
  )}</div><div class="versus">${versus}</div><div class="progress-best">该户型最佳 ${bestScore} 分</div>`;
}

function end(title: string, body: string): void {
  ended = true;
  out.outcomeTitle.textContent = title;
  out.outcomeBody.textContent = body;
  const run = collectRun();
  const breakdown = scoreRun(run);
  const previous = loadBest();
  const comparison = previous ? compareRuns(run, previous.run) : null;
  // 首次记录或刷新最佳时，连同截断后的曲线一起写回。
  const record: BestRecord =
    !previous || comparison?.better
      ? { run, curve: trimCurve(exposureSamples, 150) }
      : previous;
  if (!previous || comparison?.better) saveBest(record);
  // 解锁进度按户型记最高分；每日挑战与普通局共用同一份进度。
  progress = recordRun(progress, layout.id, breakdown.score);
  saveProgress(progress);
  renderScore(breakdown, comparison, progress.best[layout.id]);
  renderCurve(record.curve);
  // 取最近 6 条动作，逐条给出前后场差异与中文因果解释。
  const debrief = buildDebrief(actions).slice(-6);
  out.debrief.innerHTML = debrief.length
    ? debrief
        .map(
          (entry) =>
            `<li><b>${entry.at.toFixed(1)}s</b> ${entry.action} · ${entry.roomId}<span>${entry.summary}</span></li>`
        )
        .join('')
    : '<li>没有可复盘的动作。</li>';
  out.outcome.classList.add('show');
  renderResidents();
  refreshTools();
  // 结算弹层出现后把焦点交给“再来一次”，键盘用户不必重新寻路。
  (document.getElementById('outcome-reset') as HTMLButtonElement | null)?.focus();
}

let last = performance.now();
/** ?perf=1 的统计窗口：每秒刷新一次 FPS 与固定步长耗时。 */
let perfFrames = 0;
let perfElapsed = 0;
let perfStepMs = 0;

/** 把当前按下的移动键合成 -1/0/1 的方向；没有输入时返回 null。 */
function moveInput(): { x: number; z: number } | null {
  let x = 0;
  let z = 0;
  if (held.has('w') || held.has('arrowup')) z -= 1;
  if (held.has('s') || held.has('arrowdown')) z += 1;
  if (held.has('a') || held.has('arrowleft')) x -= 1;
  if (held.has('d') || held.has('arrowright')) x += 1;
  return x === 0 && z === 0 ? null : { x, z };
}

function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (!ended) {
    // 只有进入目标房间后才能自由移动；移动方向由键盘/D-pad 合成。
    const input = currentRoom === def.targetRoom ? moveInput() : null;
    const moving = input !== null;
    if (input) moveActor(actor, input.x, input.z, dt);

    const stepStart = perfMode ? performance.now() : 0;
    acc += dt;
    while (acc >= FIXED_DT) {
      advanceWorld(FIXED_DT);
      stepActor(actor, roomOf(currentRoom), FIXED_DT, moving);
      acc -= FIXED_DT;
    }
    if (perfMode) perfStepMs += performance.now() - stepStart;
    checkOutcome();
  }

  const snap = snapshotScenario(def, currentRoom, actor);
  view.sync(
    def.building,
    snap,
    currentRoom,
    targetRoom(),
    routes[0]?.steps.map((step) => step.id) ?? [],
    residentMarkers(crowd.residents, actor),
    currentRoom === def.targetRoom ? { x: actor.x, z: actor.z } : undefined
  );
  view.render();

  if (now - lastHud > 100) {
    lastHud = now;
    updateHud();
    syncResidents();
    refreshTools();

    // 三类前兆只在首次满足条件时提示，避免节流循环刷屏。
    if (actor.air <= 0 && !airWarned) {
      addLog('空呼耗尽，防护下降。', 'danger');
      airWarned = true;
    }
    if (computeBackdraftRisk(roomOf(def.targetRoom)) > 0.55 && !backdraftWarned) {
      addLog('门缝在吸风，可能回燃。先冷却门板。', 'danger');
      backdraftWarned = true;
    }
    if (
      (director.weakFor[def.targetRoom] ?? 0) >= COLLAPSE_SECONDS / 2 &&
      !collapseWarned
    ) {
      addLog('结构在响，可能坍塌。', 'danger');
      collapseWarned = true;
    }
  }

  // 性能面板：只在 ?perf=1 时显示，避免影响正常 HUD。
  perfFrames += 1;
  perfElapsed += dt;
  if (perfMode && perfElapsed >= 1) {
    out.perf.hidden = false;
    out.perf.textContent = `FPS ${Math.round(perfFrames / perfElapsed)} · 模拟 ${(
      perfStepMs / perfFrames
    ).toFixed(2)} ms/帧`;
    perfFrames = 0;
    perfElapsed = 0;
    perfStepMs = 0;
  }

  requestAnimationFrame(frame);
}

/** 键盘移动键；统一用小写，和触控 D-pad 共用 held 集合。 */
const MOVE_KEYS = new Set([
  'w',
  'a',
  's',
  'd',
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
]);

window.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const key = event.key.toLowerCase();
  if (MOVE_KEYS.has(key)) {
    // 方向键默认会滚动页面，移动时阻止默认行为。
    event.preventDefault();
    held.add(key);
  }
  if (event.repeat) return;
  if (key === '1') takeRoute(0);
  if (key === '2') takeRoute(1);
  if (key === '3') takeRoute(2);
  if (key === 'r') recalcRoutes();
});

window.addEventListener('keyup', (event) => {
  const key = event.key.toLowerCase();
  if (MOVE_KEYS.has(key)) held.delete(key);
});

/** 触控 D-pad 的按钮方向映射到与键盘相同的键名。 */
const MOVE_BUTTON_KEYS: Record<string, string> = {
  up: 'w',
  left: 'a',
  down: 's',
  right: 'd',
};

for (const button of document.querySelectorAll<HTMLButtonElement>('#move-pad [data-move]')) {
  const key = MOVE_BUTTON_KEYS[button.dataset.move ?? ''];
  if (!key) continue;
  button.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    held.add(key);
  });
  const release = (): void => {
    held.delete(key);
  };
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('pointerleave', release);
}

document.getElementById('routes')!.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest('button');
  if (!target) return;
  const index = Number(target.dataset.route);
  if (Number.isInteger(index)) takeRoute(index);
});

out.residents.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest('button');
  if (!button || (button as HTMLButtonElement).disabled) return;
  const spec = button.dataset.rescue;
  if (!spec) return;
  const [id, verb] = spec.split(':');
  if (id && (verb === 'lead' || verb === 'carry')) handleRescue(id, verb);
});

out.tools.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest('button');
  if (!button || (button as HTMLButtonElement).disabled) return;
  const verbId = button.dataset.verb;
  if (!verbId) return;
  // 每次点击都按当前场态重算目标格，避免火势移动后仍打旧位置。
  const action = buildingToolActions(roomOf(def.targetRoom), loadout).find(
    (entry) => entry.verbId === verbId
  );
  if (action) runToolAction(action);
});

document.getElementById('reset-btn')!.addEventListener('click', () => window.location.reload());
document.getElementById('outcome-reset')!.addEventListener('click', () => window.location.reload());

const saveBtn = document.getElementById('save-btn');
saveBtn?.addEventListener('click', saveCurrent);

/** 启动时若存在可解析的存档，就放出“继续上一局”入口。 */
const continueBtn = document.getElementById('continue-btn') as HTMLButtonElement | null;
try {
  const raw = window.localStorage.getItem(SAVE_KEY);
  if (raw) {
    deserializeSave(raw);
    if (continueBtn) continueBtn.hidden = false;
  }
} catch {
  // 存档损坏或不可读：保持隐藏，不影响新开一局。
}

continueBtn?.addEventListener('click', () => {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(SAVE_KEY);
  } catch {
    raw = null;
  }
  if (!raw) {
    addLog('没有可恢复的存档。', 'danger');
    continueBtn.hidden = true;
    return;
  }
  try {
    restoreFromSave(deserializeSave(raw));
  } catch {
    addLog('存档已损坏，无法恢复。', 'danger');
    continueBtn.hidden = true;
  }
});

addLog(`到场：入口。目标 ${def.targetRoom}，楼梯、消防梯、破拆三条路线。`);
for (const line of BRIEFING) addLog(`【${line.speaker}】${line.text}`);
recalcRoutes();
syncResidents();
refreshTools();
updateHud();
requestAnimationFrame(frame);
