import { cellAt } from './sim/spatial/fields';
import { FIXED_DT } from './sim/spatial/spread';
import { DRILLS } from './content/drills';
import {
  coolDoor,
  createDrillSession,
  evaluateSession,
  measureDoor,
  openDoor,
  setLowStance,
  tickSession,
  type DrillSession,
} from './app/drillSession';

const BASE = [23, 28, 34] as const;

/** 参考建筑剖视图的混色：火偏橙红，热加亮，烟偏灰蓝。 */
function cellColor(fire: number, smoke: number, heat: number): string {
  const f = Math.min(1, fire * 6);
  const s = Math.min(1, smoke);
  const h = Math.min(1, heat);
  const r = Math.min(255, BASE[0] + 232 * f + 90 * h + 40 * s);
  const g = Math.min(255, BASE[1] + 94 * f + 20 * h + 40 * s);
  const b = Math.min(255, BASE[2] + 4 * f + 10 * h + 50 * s);
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
}

/** 破拆 > 打开 > 关闭，三种状态用不同颜色区分。 */
function openingColor(open: boolean, broken: boolean): string {
  if (broken) return '#6fbf9a';
  if (open) return '#e5b567';
  return '#5a6270';
}

const canvas = document.getElementById('drill-canvas') as HTMLCanvasElement;
const listEl = document.getElementById('drill-list') as HTMLElement;
const titleEl = document.getElementById('drill-title') as HTMLElement;
const hintEl = document.getElementById('drill-hint') as HTMLElement;
const statusEl = document.getElementById('drill-status') as HTMLElement;
const actionsEl = document.getElementById('drill-actions') as HTMLElement;
const resetEl = document.getElementById('drill-reset') as HTMLButtonElement;
const timerEl = document.getElementById('drill-timer') as HTMLElement;

let session: DrillSession = createDrillSession(DRILLS[0].id);
let acc = 0;
let last = 0;

const listButtons = new Map<string, HTMLButtonElement>();

for (const drill of DRILLS) {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.drill = drill.id;
  button.textContent = drill.label;
  button.addEventListener('click', () => selectDrill(drill.id));
  listEl.appendChild(button);
  listButtons.set(drill.id, button);
}

function showStatus(text: string, tone: 'plain' | 'ok' | 'danger'): void {
  statusEl.textContent = text;
  statusEl.className = tone === 'plain' ? '' : tone;
}

function updateTimer(): void {
  if (session.drill.kind !== 'low-stance') return;
  timerEl.textContent = `低姿累计 ${session.progress.lowStanceSeconds.toFixed(1)} 秒`;
}

/** 动作反馈与成功判定：成功后结果写入会话，失败只显示原因。 */
function report(feedback: string, danger = false): void {
  const result = evaluateSession(session);
  if (result.ok) {
    showStatus(`${feedback}，演练完成。`, 'ok');
  } else {
    showStatus(`${feedback}，${result.reason}。`, danger ? 'danger' : 'plain');
  }
}

function makeAction(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', onClick);
  actionsEl.appendChild(button);
  return button;
}

function buildActions(): void {
  actionsEl.innerHTML = '';
  switch (session.drill.kind) {
    case 'measure':
      makeAction('贴门测温', () => {
        measureDoor(session);
        const temp = session.room.openings.door.temp;
        report(`门温 ${temp.toFixed(2)}`);
      });
      break;
    case 'backdraft':
      makeAction('冷却门板', () => {
        coolDoor(session);
        report(`门板已打湿至 ${session.room.openings.door.wet.toFixed(2)}`);
      });
      makeAction('直接开门', () => {
        if (openDoor(session)) {
          evaluateSession(session);
          showStatus('回燃发生，演练失败。', 'danger');
        } else {
          report('门已打开');
        }
      });
      break;
    case 'low-stance': {
      const toggle = makeAction('低姿前进', () => {
        const active = !session.lowStanceActive;
        setLowStance(session, active);
        toggle.classList.toggle('active', active);
        toggle.setAttribute('aria-pressed', String(active));
        const result = evaluateSession(session);
        if (result.ok) {
          showStatus('低姿累计达标，演练完成。', 'ok');
        } else {
          showStatus(active ? '低姿前进中，保持贴近地面。' : '已停下，低姿时间不再累计。', 'plain');
        }
        updateTimer();
      });
      toggle.setAttribute('aria-pressed', String(session.lowStanceActive));
      toggle.classList.toggle('active', session.lowStanceActive);
      break;
    }
  }
}

function syncChrome(): void {
  for (const [id, button] of listButtons) {
    const active = id === session.drill.id;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  titleEl.textContent = session.drill.label;
  hintEl.textContent = session.drill.hint;
  timerEl.hidden = session.drill.kind !== 'low-stance';
  updateTimer();
  buildActions();
  showStatus('按提示完成演练动作。', 'plain');
}

function selectDrill(id: string): void {
  session = createDrillSession(id);
  acc = 0;
  syncChrome();
}

function drawSession(): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssW = canvas.clientWidth || 320;
  const cssH = canvas.clientHeight || 320;
  const w = Math.max(1, Math.round(cssW * dpr));
  const h = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.fillStyle = '#0a0c0f';
  ctx.fillRect(0, 0, w, h);

  const { cols, rows } = session.room.config;
  const size = Math.min(w, h) * 0.86;
  const ox = (w - size) / 2;
  const oy = (h - size) / 2;
  const cw = size / cols;
  const ch = size / rows;

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const cell = cellAt(session.room, x, y);
      ctx.fillStyle = cellColor(cell.fire, cell.smoke, cell.heat);
      ctx.fillRect(ox + x * cw, oy + y * ch, cw + 0.5, ch + 0.5);
    }
  }

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= cols; x++) {
    ctx.beginPath();
    ctx.moveTo(ox + x * cw, oy);
    ctx.lineTo(ox + x * cw, oy + size);
    ctx.stroke();
  }
  for (let y = 0; y <= rows; y++) {
    ctx.beginPath();
    ctx.moveTo(ox, oy + y * ch);
    ctx.lineTo(ox + size, oy + y * ch);
    ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
  ctx.lineWidth = 2 * dpr;
  ctx.strokeRect(ox, oy, size, size);

  const { door, window: win } = session.room.openings;

  // 门在左墙、窗在右墙，与单房间模型的开口位置一致。
  ctx.fillStyle = openingColor(door.open, door.broken);
  ctx.fillRect(ox - 3 * dpr, oy + door.y * ch + ch * 0.15, 6 * dpr, ch * 0.7);
  ctx.fillStyle = openingColor(win.open, win.broken);
  ctx.fillRect(ox + size - 3 * dpr, oy + win.y * ch + ch * 0.15, 6 * dpr, ch * 0.7);

  ctx.fillStyle = '#9aa3ad';
  ctx.font = `${Math.max(10, Math.round(10 * dpr))}px ui-monospace, monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('门', ox + 6 * dpr, oy + (door.y + 0.5) * ch);
  ctx.textAlign = 'right';
  ctx.fillText('窗', ox + size - 6 * dpr, oy + (win.y + 0.5) * ch);
}

function frame(now: number): void {
  const dtReal = last === 0 ? 0 : Math.min(0.25, (now - last) / 1000);
  last = now;
  acc += dtReal;

  let stepped = false;
  while (acc >= FIXED_DT) {
    acc -= FIXED_DT;
    tickSession(session, FIXED_DT);
    stepped = true;
  }

  if (stepped && session.drill.kind === 'low-stance' && !session.result) {
    updateTimer();
    if (evaluateSession(session).ok) {
      showStatus('低姿累计达标，演练完成。', 'ok');
    }
  }

  drawSession();
  requestAnimationFrame(frame);
}

resetEl.addEventListener('click', () => selectDrill(session.drill.id));
selectDrill(DRILLS[0].id);
requestAnimationFrame(frame);
