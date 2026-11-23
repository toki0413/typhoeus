import { clamp01 } from './sim/spatial/fields';
import { FIXED_DT } from './sim/spatial/spread';
import { createActor, stepActor } from './sim/spatial/actor';
import { createResident, type ResidentState } from './sim/agents/resident';
import {
  createCrowd,
  rescueResident,
  stepCrowd,
  type RescueReason,
  type RescueVerb,
} from './sim/agents/crowd';
import { gridToWorld } from './sim/spatial/coords';
import {
  createBuildingScenario,
  snapshotScenario,
  stepScenario,
} from './sim/spatial/scene';
import {
  createDirector,
  setWind,
  stepDirector,
  type DirectorEvent,
} from './sim/events/director';
import { sampleRoom, buildDebrief, type ActionRecord } from './eval/causal';
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
const def = createBuildingScenario();
const actor = createActor();
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

const crowd = createCrowd(
  def.targetRoom,
  [
    residentAt('A', 2, 5, 1, 0),
    residentAt('B', 2, 2, 0.45, 0.6),
    residentAt('C', 4, 6, 0.22, 0.3),
  ],
  def.seed
);

let currentRoom = def.startRoom;
let routes: Route[] = [];
let ended = false;
let acc = 0;
let lastHud = 0;
let logs: { text: string; kind: 'info' | 'ok' | 'danger' }[] = [];

/** 事件导演：风向、窗户失效与坍塌都由它决定，完全确定性。 */
const director = createDirector(def.seed);
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

const out = {
  room: document.getElementById('hud-room')!,
  target: document.getElementById('hud-target')!,
  stamina: document.getElementById('hud-stamina')!,
  exposure: document.getElementById('hud-exposure')!,
  resident: document.getElementById('hud-resident')!,
  wind: document.getElementById('hud-wind')!,
  routes: document.getElementById('routes')!,
  residents: document.getElementById('residents')!,
  log: document.getElementById('log')!,
  outcome: document.getElementById('outcome')!,
  outcomeTitle: document.getElementById('outcome-title')!,
  outcomeBody: document.getElementById('outcome-body')!,
  debrief: document.getElementById('outcome-debrief')!,
};

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

/** 推进一个固定步长：风向日程 → 火场 → 人群 → 事件导演。 */
function advanceWorld(dt: number, stepCrowdNow = true): void {
  applyWindSchedule();
  stepScenario(def, dt);
  // 救援动作内部已按耗时推进过人群，外部补时间时不能重复推进。
  if (stepCrowdNow) stepCrowd(crowd, roomOf(def.targetRoom), dt);
  stepDirector(director, def.building, dt);
  flushDirectorEvents();
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
      '<p class="hint">在 202：从居民列表选择牵出或背出。</p>';
    return;
  }
  if (!routes.length) {
    out.routes.innerHTML = '<p class="hint">没有可行路线，先休息恢复体力。</p>';
    return;
  }
  out.routes.innerHTML = routes
    .map((route, index) => {
      const kinds = route.steps.map((step) => step.kind).join(' → ');
      return `<button data-route="${index}">
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
    out.residents.innerHTML = '<p class="hint">抵达 202 后可选择牵出或背出。</p>';
    return;
  }

  const rows = crowd.residents
    .filter((resident) => !resident.rescued)
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
          <button data-rescue="${resident.id}:lead"${
            canLead ? '' : ' disabled'
          }>牵</button>
          <button data-rescue="${resident.id}:carry"${
            isDead ? ' disabled' : ''
          }>背</button>
        </span>
      </div>`;
    })
    .join('');

  out.residents.innerHTML = rows || '<p class="hint">没有待救的居民。</p>';
}

let residentsSig = '';

/** 居民面板的内容指纹；只有状态变化时才重建，避免每帧替换按钮。 */
function residentSignature(): string {
  const parts = crowd.residents.map(
    (resident) =>
      `${resident.id}:${resident.rescued ? 1 : 0}:${resident.dead ? 1 : 0}:${
        resident.mood
      }:${Math.round(resident.health * 20)}`
  );
  return `${currentRoom}|${ended ? 1 : 0}|${parts.join(',')}`;
}

function syncResidents(): void {
  if (residentSignature() === residentsSig) return;
  renderResidents();
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
  updateHud();
  checkOutcome();
}

/** 建筑入口按“同处一室即可施救”处理：室内逐米位移留到后续阶段。 */
const ROOM_REACH = 6;

function handleRescue(id: string, verb: RescueVerb): void {
  if (ended) return;
  if (currentRoom !== def.targetRoom) {
    addLog('先到 202 才能救人。', 'danger');
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
    verb,
    ROOM_REACH
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
  } else {
    addLog(`${reasonText(result.reason)}（居民 ${id}）`, 'danger');
  }

  syncResidents();
  updateHud();
  checkOutcome();
}

function updateHud(): void {
  const exposure = clamp01(actor.exposure.smoke + actor.exposure.heat);
  const remaining = crowd.residents.length - crowd.rescued - crowd.lost;
  out.room.textContent = currentRoom;
  out.target.textContent = targetRoom();
  out.stamina.textContent = `${Math.round(actor.stamina * 100)}%`;
  out.exposure.textContent = `${Math.round(exposure * 100)}%`;
  out.wind.textContent = windText();
  out.resident.textContent = `${crowd.rescued} 救出 · ${crowd.lost} 失去 · ${remaining} 待救`;
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

function end(title: string, body: string): void {
  ended = true;
  out.outcomeTitle.textContent = title;
  out.outcomeBody.textContent = body;
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
}

let last = performance.now();

function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (!ended) {
    acc += dt;
    while (acc >= FIXED_DT) {
      advanceWorld(FIXED_DT);
      stepActor(actor, roomOf(currentRoom), FIXED_DT, false);
      acc -= FIXED_DT;
    }
    checkOutcome();
  }

  const snap = snapshotScenario(def, currentRoom, actor);
  view.sync(
    def.building,
    snap,
    currentRoom,
    targetRoom(),
    routes[0]?.steps.map((step) => step.id) ?? [],
    residentMarkers(crowd.residents)
  );
  view.render();

  if (now - lastHud > 100) {
    lastHud = now;
    updateHud();
    syncResidents();
  }

  requestAnimationFrame(frame);
}

window.addEventListener('keydown', (event) => {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === '1') takeRoute(0);
  if (key === '2') takeRoute(1);
  if (key === '3') takeRoute(2);
  if (key === 'r') recalcRoutes();
});

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

document.getElementById('reset-btn')!.addEventListener('click', () => window.location.reload());
document.getElementById('outcome-reset')!.addEventListener('click', () => window.location.reload());

addLog('到场：入口。目标 202，楼梯、消防梯、破拆三条路线。');
recalcRoutes();
syncResidents();
updateHud();
requestAnimationFrame(frame);
