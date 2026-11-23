import {
  availableVerbs,
  type Obstacle,
} from '../sim/interaction/multiSolution';
import {
  CARRY_CONDITION_FACTOR,
  TOOL_SPECS,
  type CarryLoadout,
  type ToolId,
} from '../sim/interaction/tools';

export interface ToolWheel {
  setObstacle(obstacle: Obstacle): void;
  refresh(): void;
}

const OBSTACLES: { id: Obstacle; label: string }[] = [
  { id: 'door', label: '门' },
  { id: 'window', label: '窗' },
  { id: 'wall', label: '墙' },
  { id: 'fire', label: '火' },
  { id: 'occupant', label: '居民' },
];

const TOOL_ORDER: ToolId[] = [
  'hose',
  'extinguisher',
  'axe',
  'fan',
  'thermal',
  'ladder',
  'rope',
];

export function createToolWheel(
  root: HTMLElement,
  loadout: CarryLoadout,
  onVerb: (verbId: string) => void
): ToolWheel {
  let obstacle: Obstacle = 'fire';

  const render = (): void => {
    const tools = TOOL_ORDER.map((id) => {
      const tool = loadout[id];
      const pct = Math.round(tool.charge * 100);
      const bad = CARRY_CONDITION_FACTOR[tool.condition] < 1;
      return `<span class="tool-chip ${bad ? 'bad' : ''}">${TOOL_SPECS[id].label} ${pct}%</span>`;
    }).join('');

    const tabs = OBSTACLES.map(
      (entry) =>
        `<button data-obstacle="${entry.id}" class="${entry.id === obstacle ? 'active' : ''}">${entry.label}</button>`
    ).join('');

    const verbs = availableVerbs(obstacle, loadout)
      .map(
        (verb) =>
          `<button data-verb="${verb.id}" title="${verb.lesson}">${verb.label}</button>`
      )
      .join('');

    root.innerHTML = `
      <h2>工具与动作</h2>
      <div class="tool-chips">${tools}</div>
      <div class="wheel-tabs">${tabs}</div>
      <div class="wheel-verbs">${verbs}</div>
    `;
  };

  root.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest('button');
    if (!target) return;

    const next = target.dataset.obstacle as Obstacle | undefined;
    if (next) {
      obstacle = next;
      render();
      return;
    }

    const verb = target.dataset.verb;
    if (verb) onVerb(verb);
  });

  render();

  return {
    setObstacle(next: Obstacle) {
      obstacle = next;
      render();
    },
    refresh: render,
  };
}
