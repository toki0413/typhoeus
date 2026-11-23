import { cellAt, type RoomState } from '../sim/spatial/fields';
import type { CarryLoadout, ToolId } from '../sim/interaction/tools';
import { toolAvailable } from '../sim/interaction/tools';
import { verbCost } from '../sim/interaction/multiSolution';

export interface BuildingToolAction {
  verbId: string;
  label: string;
  tool: ToolId;
  /** 0..1 当前余量 */
  charge: number;
  enabled: boolean;
  target: { x: number; y: number };
}

/** 工具是否可用：器材能取用，且余量足够支付该动作的消耗。 */
function canSpend(loadout: CarryLoadout, tool: ToolId, verbId: string): boolean {
  return toolAvailable(loadout, tool) && loadout[tool].charge + 1e-9 >= verbCost(verbId);
}

/** 按行优先扫描，取火势最大的格；平手保留先遇到的格，顺序固定。 */
function hottestCell(room: RoomState): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let maxFire = 0;
  for (let y = 0; y < room.config.rows; y++) {
    for (let x = 0; x < room.config.cols; x++) {
      const fire = cellAt(room, x, y).fire;
      if (fire > maxFire) {
        maxFire = fire;
        best = { x, y };
      }
    }
  }
  return best;
}

/**
 * 把当前房间与携带器材整理成面板上的 5 个工具动作。
 * 火源类动作在没有明火时退回房间中心并禁用。
 */
export function buildingToolActions(
  room: RoomState,
  loadout: CarryLoadout
): BuildingToolAction[] {
  const center = {
    x: Math.floor(room.config.cols / 2),
    y: Math.floor(room.config.rows / 2),
  };
  const door = { x: room.openings.door.x, y: room.openings.door.y };
  const hottest = hottestCell(room);
  const fireTarget = hottest ?? center;

  return [
    {
      verbId: 'door-cool',
      label: '冷却门板',
      tool: 'hose',
      charge: loadout.hose.charge,
      enabled: canSpend(loadout, 'hose', 'door-cool'),
      target: door,
    },
    {
      verbId: 'door-break',
      label: '破拆门',
      tool: 'axe',
      charge: loadout.axe.charge,
      enabled: canSpend(loadout, 'axe', 'door-break'),
      target: door,
    },
    {
      verbId: 'window-vent',
      label: '排烟',
      tool: 'fan',
      charge: loadout.fan.charge,
      enabled: canSpend(loadout, 'fan', 'window-vent'),
      target: center,
    },
    {
      verbId: 'fire-water',
      label: '水枪压制',
      tool: 'hose',
      charge: loadout.hose.charge,
      enabled: hottest !== null && canSpend(loadout, 'hose', 'fire-water'),
      target: fireTarget,
    },
    {
      verbId: 'fire-powder',
      label: '干粉压制',
      tool: 'extinguisher',
      charge: loadout.extinguisher.charge,
      enabled:
        hottest !== null && canSpend(loadout, 'extinguisher', 'fire-powder'),
      target: fireTarget,
    },
  ];
}
