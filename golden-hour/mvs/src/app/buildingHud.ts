/** HUD 元素集合：入口只负责取一次引用，刷新逻辑集中在这里。 */
export interface HudView {
  room: HTMLElement;
  target: HTMLElement;
  phase: HTMLElement;
  seed: HTMLElement;
  stamina: HTMLElement;
  exposure: HTMLElement;
  air: HTMLElement;
  resident: HTMLElement;
  time: HTMLElement;
  wind: HTMLElement;
  perf: HTMLElement;
  routes: HTMLElement;
  zones: HTMLElement;
  residents: HTMLElement;
  tools: HTMLElement;
  log: HTMLElement;
  outcome: HTMLElement;
  outcomeTitle: HTMLElement;
  outcomeBody: HTMLElement;
  outcomeScore: HTMLElement;
  curve: HTMLElement;
  debrief: HTMLElement;
}

function need(doc: Document, id: string): HTMLElement {
  const element = doc.getElementById(id);
  if (!element) throw new Error(`缺少 HUD 元素 #${id}`);
  return element;
}

/** 按固定 id 取齐 HUD、日志与结算弹层元素。 */
export function createHudView(doc: Document): HudView {
  return {
    room: need(doc, 'hud-room'),
    target: need(doc, 'hud-target'),
    phase: need(doc, 'hud-phase'),
    seed: need(doc, 'hud-seed'),
    stamina: need(doc, 'hud-stamina'),
    exposure: need(doc, 'hud-exposure'),
    air: need(doc, 'hud-air'),
    resident: need(doc, 'hud-resident'),
    time: need(doc, 'hud-time'),
    wind: need(doc, 'hud-wind'),
    perf: need(doc, 'perf'),
    routes: need(doc, 'routes'),
    zones: need(doc, 'zones'),
    residents: need(doc, 'residents'),
    tools: need(doc, 'tools'),
    log: need(doc, 'log'),
    outcome: need(doc, 'outcome'),
    outcomeTitle: need(doc, 'outcome-title'),
    outcomeBody: need(doc, 'outcome-body'),
    outcomeScore: need(doc, 'outcome-score'),
    curve: need(doc, 'outcome-curve'),
    debrief: need(doc, 'outcome-debrief'),
  };
}

/** 一帧 HUD 需要的只读数值；中文文案在入口按模式算好。 */
export interface HudState {
  room: string;
  target: string;
  phase: string;
  seedLabel: string;
  staminaPct: number;
  airPct: number;
  exposurePct: number;
  windLabel: string;
  residentLabel: string;
  timeSeconds: number;
}

/** 把状态写进 HUD 文本；不读游戏状态，便于单独测试。 */
export function updateHud(view: HudView, state: HudState): void {
  view.room.textContent = state.room;
  view.target.textContent = state.target;
  view.phase.textContent = state.phase;
  view.seed.textContent = state.seedLabel;
  view.stamina.textContent = `${state.staminaPct}%`;
  view.air.textContent = `${state.airPct}%`;
  view.exposure.textContent = `${state.exposurePct}%`;
  view.wind.textContent = state.windLabel;
  view.resident.textContent = state.residentLabel;
  view.time.textContent = `${state.timeSeconds.toFixed(1)}s`;
}
