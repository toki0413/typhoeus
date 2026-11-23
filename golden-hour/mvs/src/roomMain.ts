import {
  cellAt,
  clamp01,
  computeBackdraftRisk,
  createRoom,
  roomSummary,
  type RoomState,
  type ToolKey,
} from './sim/spatial/fields';
import { FIXED_DT, stepRoom } from './sim/spatial/spread';
import { gridToWorld } from './sim/spatial/coords';
import { inspectTool, measureOpening, openOpening, spray } from './sim/spatial/verbs';
import { type AgentId } from './sim/spatial/agents';
import { useImprovised } from './sim/spatial/improvised';
import { createRoomView } from './render/roomView';
import { createActor, moveActor, stepActor } from './sim/spatial/actor';
import {
  attachOccupant,
  createOccupant,
  extractOccupant,
  nearestOpenExit,
  stepOccupant,
  syncCarriedOccupant,
} from './sim/spatial/rescue';

const canvas = document.getElementById('room-canvas') as HTMLCanvasElement;
const view = createRoomView(canvas);

let room: RoomState = createRoom();
const actor = createActor();
const occupant = createOccupant();
let unconsciousLogged = false;
let lowStance = false;
let lastBackdraft: number | null = null;
let ended = false;
let lastLesson = '先贴门测温，再决定要不要开。';
let logs: { text: string; kind: 'info' | 'lesson' | 'danger' }[] = [];
let lastHud = 0;

const keys = new Set<string>();

const out = {
  oxygen: document.getElementById('val-oxygen')!,
  smoke: document.getElementById('val-smoke')!,
  heat: document.getElementById('val-heat')!,
  risk: document.getElementById('val-risk')!,
  door: document.getElementById('val-door')!,
  self: document.getElementById('val-self')!,
  barOxygen: document.getElementById('bar-oxygen')!,
  barSmoke: document.getElementById('bar-smoke')!,
  barHeat: document.getElementById('bar-heat')!,
  barRisk: document.getElementById('bar-risk')!,
  barDoor: document.getElementById('bar-door')!,
  barSelf: document.getElementById('bar-self')!,
  tools: document.getElementById('tool-list')!,
  log: document.getElementById('log')!,
  outcome: document.getElementById('outcome')!,
  outcomeTitle: document.getElementById('outcome-title')!,
  outcomeBody: document.getElementById('outcome-body')!,
};

const TOOL_ROWS: { key: ToolKey; label: string }[] = [
  { key: 'water', label: '水枪 / 水带' },
  { key: 'dryPowder', label: 'ABC 干粉' },
  { key: 'co2', label: '二氧化碳' },
  { key: 'foam', label: '泡沫' },
  { key: 'wetChemical', label: '湿化学（F 类）' },
  { key: 'sand', label: '干沙 / 覆盖' },
];

function addLog(text: string, kind: 'info' | 'lesson' | 'danger' = 'info'): void {
  logs = [{ text, kind }, ...logs].slice(0, 6);
  lastLesson = text;
  renderLog();
}

function renderLog(): void {
  out.log.innerHTML = logs
    .map((entry) => `<p class="${entry.kind === 'lesson' ? 'lesson' : entry.kind === 'danger' ? 'danger' : ''}">${entry.text}</p>`)
    .join('');
}

function renderTools(): void {
  out.tools.innerHTML = TOOL_ROWS.map((row) => {
    const info = inspectTool(room, row.key);
    const pct = Math.round(info.charge * 100);
    const tag =
      info.condition === 'ok'
        ? `<span class="tag">${pct}%</span>`
        : `<span class="tag bad">${conditionText(info.condition)}</span>`;
    return `<div class="tool"><div>${row.label}<br><small>${info.advice}</small></div>${tag}</div>`;
  }).join('');
}

function conditionText(condition: string): string {
  switch (condition) {
    case 'expired':
      return '已过期';
    case 'depressurized':
      return '压力不足';
    case 'broken':
      return '破损';
    case 'empty':
      return '空';
    default:
      return '可用';
  }
}

function nearestFire(gx: number, gy: number): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestDist = Infinity;
  for (let y = 0; y < room.config.rows; y++) {
    for (let x = 0; x < room.config.cols; x++) {
      const c = cellAt(room, x, y);
      if (c.fire <= 0.03) continue;
      const d = Math.hypot(x - gx, y - gy);
      if (d < bestDist) {
        bestDist = d;
        best = { x, y };
      }
    }
  }
  return best;
}

function playerGrid(): { x: number; y: number } {
  const g = view.worldToGrid(actor.x, actor.z);
  return {
    x: Math.min(room.config.cols - 1, Math.max(0, g.x)),
    y: Math.min(room.config.rows - 1, Math.max(0, g.y)),
  };
}

function nearOpening(id: 'door' | 'window', range = 1.7): boolean {
  const point = gridToWorld(room.openings[id].x, room.openings[id].y);
  return Math.hypot(actor.x - point.x, actor.z - point.z) <= range;
}

function action(name: string): void {
  if (ended) return;
  const g = playerGrid();

  if (name === 'reset') {
    window.location.reload();
    return;
  }

  if (name === 'measure') {
    const m = measureOpening(room, 'door');
    const temperature = `门温约 ${m.celsius}°C（${m.band === 'hot' ? '烫手' : m.band === 'warm' ? '温热' : '常温'}）`;
    const risk = m.risk > 0.55 ? '室内富燃料，开门可能回燃。' : m.risk > 0.3 ? '有回燃苗头，先降压降温。' : '暂时没有明显回燃迹象。';
    addLog(`${temperature} ${risk}`, m.risk > 0.55 ? 'danger' : 'lesson');
    return;
  }

  if (name === 'door') {
    if (!nearOpening('door')) {
      addLog('离门太远，先走到门边。', 'info');
      return;
    }
    const res = openOpening(room, 'door');
    if (!res.opened) {
      addLog('门已经开了。', 'info');
      return;
    }
    addLog(
      res.backdraft ? '门刚开一条缝，热烟就顶了回来——可能要回燃。' : '门打开了，暂时没有回燃。',
      res.backdraft ? 'danger' : 'lesson'
    );
    return;
  }

  if (name === 'window') {
    if (!nearOpening('window')) {
      addLog('离窗太远，先走到窗边。', 'info');
      return;
    }
    const res = openOpening(room, 'window');
    if (!res.opened) {
      addLog('窗已经开了。', 'info');
      return;
    }
    addLog('窗户打开，烟开始往外走，但新鲜空气也会进来。', 'lesson');
    return;
  }

  if (name === 'water' || name === 'dryPowder' || name === 'co2') {
    const target = nearestFire(g.x, g.y);
    if (!target) {
      addLog('附近没有明火，先把周围降降温。', 'info');
      return;
    }
    const dist = Math.hypot(target.x - g.x, target.y - g.y);
    if (dist > 4) {
      addLog('火点太远，需要靠近再喷。', 'info');
      return;
    }
    const agent = name as AgentId;
    const res = spray(room, agent, target.x, target.y, { radius: 1.8, amount: 0.24 });
    addLog(res.lesson, res.misagent ? 'danger' : 'lesson');
    renderTools();
    return;
  }

  if (name === 'wetBlanket') {
    const target = nearestFire(g.x, g.y);
    if (!target) {
      addLog('没有火需要覆盖。', 'info');
      return;
    }
    const res = useImprovised(room, 'wetBlanket', target.x, target.y);
    addLog(res.lesson, res.ok ? 'lesson' : 'danger');
    return;
  }

  if (name === 'powerCut') {
    const res = useImprovised(room, 'powerCut', g.x, g.y);
    addLog(res.lesson, 'lesson');
    return;
  }

  if (name === 'closeDoor') {
    const res = useImprovised(room, 'closeDoor', g.x, g.y);
    addLog(res.lesson, 'lesson');
    return;
  }

  if (name === 'carry') {
    if (occupant.carried) {
      const exit = nearestOpenExit(room, actor.x, actor.z);
      const ok = exit !== null && extractOccupant(occupant, actor, room, exit);
      addLog(
        ok ? '把居民带出火场，任务完成。' : '先把人背到打开的门或窗边再撤。',
        ok ? 'lesson' : 'info'
      );
    } else if (attachOccupant(actor, occupant)) {
      addLog(
        occupant.mood === 'unconscious'
          ? '居民已经失去意识，只能硬背，移动会明显变慢。'
          : '背起居民，移动会明显变慢。',
        'lesson'
      );
    } else {
      addLog('离居民太远，先靠近再背。', 'info');
    }
    return;
  }
}

function setBar(bar: HTMLElement, value: number): void {
  bar.style.width = `${Math.round(clamp01(value) * 100)}%`;
}

function updateHud(): void {
  const s = roomSummary(room);
  const risk = computeBackdraftRisk(room);
  const self = clamp01(actor.exposure.smoke + actor.exposure.heat);
  const doorC = Math.round(20 + room.openings.door.temp * 700);

  out.oxygen.textContent = `${Math.round(s.oxygen * 100)}%`;
  out.smoke.textContent = `${Math.round((1 - s.smoke) * 100)}%`;
  out.heat.textContent = `${Math.round(20 + s.heat * 700)}°C`;
  out.risk.textContent = `${Math.round(risk * 100)}%`;
  out.door.textContent = `${doorC}°C`;
  out.self.textContent = `${Math.round(self * 100)}%`;

  setBar(out.barOxygen, s.oxygen);
  setBar(out.barSmoke, s.smoke);
  setBar(out.barHeat, s.heat);
  setBar(out.barRisk, risk);
  setBar(out.barDoor, room.openings.door.temp);
  setBar(out.barSelf, self);
}

function checkOutcome(): void {
  if (ended) return;

  if (actor.downed) {
    end(
      '你被烟和热压倒了',
      '暴露超限。低姿、湿毛巾、先排烟都能降低吸入；别在浓烟里硬撑。'
    );
    return;
  }

  if (occupant.rescued) {
    end(
      '居民已救出',
      `用时 ${room.t.toFixed(1)} 秒，水耗 ${room.stats.waterUsed.toFixed(2)}，烟排出 ${room.stats.smokeVented.toFixed(2)}。`
    );
    return;
  }

  if (occupant.health <= 0 && occupant.mood === 'unconscious' && !unconsciousLogged) {
    unconsciousLogged = true;
    addLog('居民失去意识，尽快背出去。', 'danger');
  }
}

function end(title: string, body: string): void {
  ended = true;
  out.outcomeTitle.textContent = title;
  out.outcomeBody.textContent = body;
  out.outcome.classList.add('show');
}

function update(dt: number): void {
  let dx = 0;
  let dz = 0;
  if (keys.has('a') || keys.has('arrowleft')) dx -= 1;
  if (keys.has('d') || keys.has('arrowright')) dx += 1;
  if (keys.has('w') || keys.has('arrowup')) dz -= 1;
  if (keys.has('s') || keys.has('arrowdown')) dz += 1;

  actor.stance = lowStance ? 'low' : 'upright';
  const moving = Math.hypot(dx, dz) > 0;
  if (moving) moveActor(actor, dx, dz, dt);

  syncCarriedOccupant(occupant, actor);
  stepActor(actor, room, dt, moving);
  stepOccupant(occupant, room, dt);

  if (room.backdraftAt !== null && room.backdraftAt !== lastBackdraft) {
    lastBackdraft = room.backdraftAt;
    actor.exposure.heat = clamp01(actor.exposure.heat + 0.55);
    addLog('回燃！热浪和烟一起涌出来，你被迫后退。', 'danger');
  }
}

let last = performance.now();
let acc = 0;

function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (!ended) {
    acc += dt;
    while (acc >= FIXED_DT) {
      stepRoom(room, FIXED_DT);
      acc -= FIXED_DT;
    }
    update(dt);
    checkOutcome();
  }

  view.sync(room, actor, dt, occupant);
  view.render();

  if (now - lastHud > 100) {
    lastHud = now;
    updateHud();
  }

  requestAnimationFrame(frame);
}

window.addEventListener('keydown', (event) => {
  const k = event.key.toLowerCase();
  keys.add(k);
  if (k === 'shift') lowStance = true;
  if (k === 'q') action('measure');
  if (k === 'e') action('door');
  if (k === 'r') action('window');
  if (k === '1') action('water');
  if (k === '2') action('dryPowder');
  if (k === '3') action('co2');
  if (k === '4') action('wetBlanket');
  if (k === '5') action('powerCut');
  if (k === '6') action('closeDoor');
  if (k === 'c') action('carry');
});

window.addEventListener('keyup', (event) => {
  const k = event.key.toLowerCase();
  keys.delete(k);
  if (k === 'shift') lowStance = false;
});

document.getElementById('actions')!.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const name = target.dataset.action;
  if (name) action(name);
});

document.getElementById('outcome-reset')!.addEventListener('click', () => window.location.reload());

addLog('到场：左门、右窗。先测温，再决定开门、排烟还是直接打火源。', 'lesson');
renderTools();
updateHud();
requestAnimationFrame(frame);
