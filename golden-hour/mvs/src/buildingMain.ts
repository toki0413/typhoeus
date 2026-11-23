import { clamp01 } from './sim/spatial/fields';
import { FIXED_DT } from './sim/spatial/spread';
import { createActor, stepActor } from './sim/spatial/actor';
import {
  attachOccupant,
  createOccupant,
  stepOccupant,
  syncCarriedOccupant,
} from './sim/spatial/rescue';
import {
  createBuildingScenario,
  snapshotScenario,
  stepScenario,
} from './sim/spatial/scene';
import { findRoutes, type Route } from './sim/nav/graph';
import { travelRoute } from './sim/nav/travel';
import { createBuildingView } from './render/buildingView';

const canvas = document.getElementById('building-canvas') as HTMLCanvasElement;
const view = createBuildingView(canvas);
const def = createBuildingScenario();
const actor = createActor();
const occupant = createOccupant(0.3, 0.3);

let currentRoom = def.startRoom;
let routes: Route[] = [];
let ended = false;
let acc = 0;
let lastHud = 0;
let logs: { text: string; kind: 'info' | 'ok' | 'danger' }[] = [];

const out = {
  room: document.getElementById('hud-room')!,
  target: document.getElementById('hud-target')!,
  stamina: document.getElementById('hud-stamina')!,
  load: document.getElementById('hud-load')!,
  exposure: document.getElementById('hud-exposure')!,
  resident: document.getElementById('hud-resident')!,
  routes: document.getElementById('routes')!,
  log: document.getElementById('log')!,
  outcome: document.getElementById('outcome')!,
  outcomeTitle: document.getElementById('outcome-title')!,
  outcomeBody: document.getElementById('outcome-body')!,
};

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
  return occupant.carried || occupant.rescued ? def.startRoom : def.targetRoom;
}

function recalcRoutes(): void {
  const target = targetRoom();
  routes =
    currentRoom === target
      ? []
      : findRoutes(def.building, currentRoom, target, actor, 3);
  renderRoutes();
}

function renderRoutes(): void {
  if (currentRoom === targetRoom()) {
    out.routes.innerHTML = `<p class="hint">${
      occupant.carried ? '在入口，按 C 完成撤离。' : '已在 202，按 C 背起居民。'
    }</p>`;
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
        <small>${route.time.toFixed(0)}s · 风险 ${route.risk.toFixed(2)}</small>
      </button>`;
    })
    .join('');
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

  currentRoom = travel.roomId;
  // 到达新房间时落在房间中心的入口锚点，避免站在燃烧格上。
  actor.x = 0;
  actor.z = 0;

  const ticks = Math.max(1, Math.round(travel.time / FIXED_DT));
  for (let i = 0; i < ticks; i++) {
    stepScenario(def, FIXED_DT);
    if (occupant.carried) syncCarriedOccupant(occupant, actor);
    stepOccupant(
      occupant,
      roomOf(occupant.carried ? currentRoom : def.targetRoom),
      FIXED_DT
    );
  }

  addLog(`通过 ${route.steps.map((step) => step.kind).join(' → ')}，到达 ${currentRoom}`, 'ok');
  recalcRoutes();
  checkOutcome();
}

function handleCarry(): void {
  if (ended) return;

  if (!occupant.carried) {
    if (currentRoom !== def.targetRoom) {
      addLog('先到 202 才能救人。');
      return;
    }
    if (attachOccupant(actor, occupant)) {
      addLog('背起居民，路线会变慢。', 'ok');
      recalcRoutes();
    } else {
      addLog('离居民太远。');
    }
    return;
  }

  if (currentRoom !== def.startRoom) {
    addLog('把居民背回入口才算撤离。');
    return;
  }

  occupant.rescued = true;
  occupant.carried = false;
  actor.load = Math.max(0, actor.load - occupant.carryLoad);
  occupant.carryLoad = 0;
  addLog('把居民带出火场。', 'ok');
  checkOutcome();
}

function updateHud(): void {
  const exposure = clamp01(actor.exposure.smoke + actor.exposure.heat);
  out.room.textContent = currentRoom;
  out.target.textContent = targetRoom();
  out.stamina.textContent = `${Math.round(actor.stamina * 100)}%`;
  out.load.textContent = `${Math.round(actor.load * 100)}%`;
  out.exposure.textContent = `${Math.round(exposure * 100)}%`;
  out.resident.textContent = occupant.rescued
    ? '已救出'
    : `${Math.round(occupant.health * 100)}%`;
}

function checkOutcome(): void {
  if (ended) return;
  if (actor.downed) {
    end('你被烟和热压倒了', '路线不是免费的：烟层、体力、负重都会改变可选路径。');
    return;
  }
  if (occupant.rescued) {
    end('居民已救出', `用时 ${def.building.rooms[def.startRoom].room.t.toFixed(1)} 秒。`);
  }
}

function end(title: string, body: string): void {
  ended = true;
  out.outcomeTitle.textContent = title;
  out.outcomeBody.textContent = body;
  out.outcome.classList.add('show');
}

let last = performance.now();

function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (!ended) {
    acc += dt;
    while (acc >= FIXED_DT) {
      stepScenario(def, FIXED_DT);
      if (occupant.carried) syncCarriedOccupant(occupant, actor);
      stepOccupant(
        occupant,
        roomOf(occupant.carried ? currentRoom : def.targetRoom),
        FIXED_DT
      );
      stepActor(actor, roomOf(currentRoom), FIXED_DT, false);
      acc -= FIXED_DT;
    }
    checkOutcome();
  }

  const snap = snapshotScenario(def, currentRoom, actor, occupant);
  view.sync(
    def.building,
    snap,
    currentRoom,
    targetRoom(),
    routes[0]?.steps.map((step) => step.id) ?? []
  );
  view.render();

  if (now - lastHud > 100) {
    lastHud = now;
    updateHud();
  }

  requestAnimationFrame(frame);
}

window.addEventListener('keydown', (event) => {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === '1') takeRoute(0);
  if (key === '2') takeRoute(1);
  if (key === '3') takeRoute(2);
  if (key === 'c') handleCarry();
  if (key === 'r') recalcRoutes();
});

document.getElementById('routes')!.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest('button');
  if (!target) return;
  const index = Number(target.dataset.route);
  if (Number.isInteger(index)) takeRoute(index);
});

document.getElementById('carry-btn')!.addEventListener('click', handleCarry);
document.getElementById('reset-btn')!.addEventListener('click', () => window.location.reload());
document.getElementById('outcome-reset')!.addEventListener('click', () => window.location.reload());

addLog('到场：入口。目标 202，楼梯、消防梯、破拆三条路线。');
recalcRoutes();
updateHud();
requestAnimationFrame(frame);
