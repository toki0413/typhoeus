import { cellAt, inBounds, type RoomState } from '../spatial/fields';
import { breakOpening, isolate, openOpening, spray } from '../spatial/verbs';
import { useImprovised } from '../spatial/improvised';
import { attachOccupant, distance, type OccupantState } from '../spatial/rescue';
import type { ActorState } from '../spatial/actor';
import {
  consumeTool,
  toolAvailable,
  type CarryLoadout,
  type ToolId,
} from './tools';
import { breachCell, thermalScan, ventSmoke, type ThermalScan } from './special';

export type Obstacle = 'door' | 'window' | 'wall' | 'fire' | 'occupant';

export interface Verb {
  id: string;
  obstacle: Obstacle;
  label: string;
  tool: ToolId | null;
  lesson: string;
}

export const VERBS: Verb[] = [
  { id: 'door-open', obstacle: 'door', label: '开门', tool: null, lesson: '先测温再开门；室内富燃料时开门可能回燃。' },
  { id: 'door-break', obstacle: 'door', label: '破门', tool: 'axe', lesson: '门板变形打不开时，破拆比硬撞快，但会改变通风。' },
  { id: 'door-cool', obstacle: 'door', label: '冷却门板', tool: 'hose', lesson: '给门板降温打湿，能显著降低回燃风险。' },
  { id: 'door-isolate', obstacle: 'door', label: '关门断氧', tool: null, lesson: '关门限制供氧，但会把烟和热关在里面。' },

  { id: 'window-open', obstacle: 'window', label: '开窗', tool: null, lesson: '开窗排烟，但也会引入氧气。' },
  { id: 'window-break', obstacle: 'window', label: '破窗', tool: 'axe', lesson: '打碎玻璃能快速排烟，注意碎片与回燃。' },
  { id: 'window-vent', obstacle: 'window', label: '排烟机', tool: 'fan', lesson: '排烟机把烟往外推，但不要对着火源吹。' },

  { id: 'wall-breach', obstacle: 'wall', label: '破墙', tool: 'axe', lesson: '破墙开通道，先确认不是承重结构。' },
  { id: 'wall-breach-wide', obstacle: 'wall', label: '扩宽破口', tool: 'axe', lesson: '扩大破口能过人，但消耗更多体力与斧刃。' },
  { id: 'wall-cool', obstacle: 'wall', label: '冷却墙体', tool: 'hose', lesson: '给墙体降温，延缓结构失效。' },

  { id: 'fire-water', obstacle: 'fire', label: '水枪', tool: 'hose', lesson: '水适合 A 类固体火；对油、电、金属火要换剂。' },
  { id: 'fire-powder', obstacle: 'fire', label: '干粉', tool: 'extinguisher', lesson: '干粉对液体与带电火更安全。' },
  { id: 'fire-smother', obstacle: 'fire', label: '湿棉被覆盖', tool: null, lesson: '没有对应灭火器时，湿棉被可压灭小火。' },
  { id: 'fire-isolate', obstacle: 'fire', label: '关门断氧', tool: null, lesson: '断氧能压火，但烟热会留在室内。' },
  { id: 'thermal-scan', obstacle: 'fire', label: '热像仪扫描', tool: 'thermal', lesson: '热像仪能隔着门/墙看到热区，先判断再靠近。' },

  { id: 'occupant-carry', obstacle: 'occupant', label: '背起', tool: null, lesson: '失去意识的居民只能背，负重会限制路线。' },
  { id: 'occupant-lead', obstacle: 'occupant', label: '引导', tool: null, lesson: '清醒的居民可以引导，不增加负重。' },
  { id: 'occupant-protect', obstacle: 'occupant', label: '湿毛巾防护', tool: null, lesson: '湿毛巾只能短时过滤颗粒物，不能防一氧化碳。' },
];

export function verbsFor(obstacle: Obstacle): Verb[] {
  return VERBS.filter((verb) => verb.obstacle === obstacle);
}

export function availableVerbs(obstacle: Obstacle, loadout: CarryLoadout): Verb[] {
  return verbsFor(obstacle).filter(
    (verb) => verb.tool === null || toolAvailable(loadout, verb.tool)
  );
}

export interface VerbContext {
  room: RoomState;
  loadout: CarryLoadout;
  target: { x: number; y: number };
  actor?: ActorState;
  occupant?: OccupantState;
}

export interface VerbResult {
  ok: boolean;
  lesson: string;
  effect: number;
  breachReady?: boolean;
  scan?: ThermalScan;
}

const SPRAY_COST = 0.12;
const AXE_COST = 0.2;
const AXE_WIDE_COST = 0.35;
const FAN_COST = 0.08;
const SCAN_COST = 0.04;

function fail(lesson: string): VerbResult {
  return { ok: false, lesson, effect: 0 };
}

function spend(ctx: VerbContext, tool: ToolId, amount: number): boolean {
  return consumeTool(ctx.loadout, tool, amount);
}

export function executeVerb(verbId: string, ctx: VerbContext): VerbResult {
  const verb = VERBS.find((entry) => entry.id === verbId);
  if (!verb) return fail('未知动作。');

  if (verb.tool && !toolAvailable(ctx.loadout, verb.tool)) {
    return fail(`${verb.label}需要可用的${verb.tool}。`);
  }

  switch (verb.id) {
    case 'door-open': {
      const result = openOpening(ctx.room, 'door');
      return { ok: result.opened, lesson: verb.lesson, effect: result.opened ? 1 : 0 };
    }
    case 'door-break': {
      if (ctx.room.openings.door.broken) return fail('门已经破了。');
      if (!spend(ctx, 'axe', AXE_COST)) return fail('斧头不可用。');
      const result = breakOpening(ctx.room, 'door');
      return { ok: result.opened, lesson: verb.lesson, effect: result.opened ? 1 : 0 };
    }
    case 'door-cool': {
      if (!spend(ctx, 'hose', SPRAY_COST)) return fail('水带不可用。');
      const door = ctx.room.openings.door;
      const beforeTemp = door.temp;
      spray(ctx.room, 'water', door.x, door.y, { radius: 1, amount: 0.2, free: true });
      return {
        ok: true,
        lesson: verb.lesson,
        effect: Math.max(0.01, beforeTemp - door.temp + door.wet),
      };
    }
    case 'door-isolate': {
      isolate(ctx.room);
      return { ok: true, lesson: verb.lesson, effect: 1 };
    }
    case 'window-open': {
      const result = openOpening(ctx.room, 'window');
      return { ok: result.opened, lesson: verb.lesson, effect: result.opened ? 1 : 0 };
    }
    case 'window-break': {
      if (ctx.room.openings.window.broken) return fail('窗已经破了。');
      if (!spend(ctx, 'axe', AXE_COST)) return fail('斧头不可用。');
      const result = breakOpening(ctx.room, 'window');
      return { ok: result.opened, lesson: verb.lesson, effect: result.opened ? 1 : 0 };
    }
    case 'window-vent': {
      const source = cellAt(ctx.room, ctx.target.x, ctx.target.y);
      if (!source || source.smoke <= 0.01) return fail('这里没有需要排的烟。');
      if (!spend(ctx, 'fan', FAN_COST)) return fail('排烟机不可用。');
      const moved = ventSmoke(ctx.room, ctx.target.x, ctx.target.y, 0, -1, 0.5);
      return { ok: true, lesson: verb.lesson, effect: moved };
    }
    case 'wall-breach': {
      if (!inBounds(ctx.room.config, ctx.target.x, ctx.target.y)) {
        return fail('目标不在房间里。');
      }
      const wall = cellAt(ctx.room, ctx.target.x, ctx.target.y);
      if (wall.structure <= 0) return fail('墙已经打通了。');
      if (!spend(ctx, 'axe', AXE_COST)) return fail('斧头不可用。');
      const result = breachCell(ctx.room, ctx.target.x, ctx.target.y, 0.25);
      return {
        ok: true,
        lesson: verb.lesson,
        effect: result.before - result.after,
        breachReady: result.ready,
      };
    }
    case 'wall-breach-wide': {
      if (!inBounds(ctx.room.config, ctx.target.x, ctx.target.y)) {
        return fail('目标不在房间里。');
      }
      const wall = cellAt(ctx.room, ctx.target.x, ctx.target.y);
      if (wall.structure <= 0) return fail('墙已经打通了。');
      if (!spend(ctx, 'axe', AXE_WIDE_COST)) return fail('斧头不可用。');
      const result = breachCell(ctx.room, ctx.target.x, ctx.target.y, 0.4);
      return {
        ok: true,
        lesson: verb.lesson,
        effect: result.before - result.after,
        breachReady: result.ready,
      };
    }
    case 'wall-cool': {
      const wall = cellAt(ctx.room, ctx.target.x, ctx.target.y);
      if (!wall || wall.heat <= 0.05) return fail('这面墙不需要冷却。');
      if (!spend(ctx, 'hose', SPRAY_COST)) return fail('水带不可用。');
      const beforeHeat = wall.heat;
      spray(ctx.room, 'water', ctx.target.x, ctx.target.y, { radius: 1.2, amount: 0.18, free: true });
      return {
        ok: true,
        lesson: verb.lesson,
        effect: Math.max(0.01, beforeHeat - wall.heat),
      };
    }
    case 'fire-water': {
      if (!spend(ctx, 'hose', SPRAY_COST)) return fail('水带不可用。');
      const result = spray(ctx.room, 'water', ctx.target.x, ctx.target.y, {
        radius: 2,
        amount: 0.24,
        free: true,
      });
      return { ok: true, lesson: `${verb.lesson} ${result.lesson}`, effect: result.effect };
    }
    case 'fire-powder': {
      if (!spend(ctx, 'extinguisher', SPRAY_COST)) return fail('灭火器不可用。');
      const result = spray(ctx.room, 'dryPowder', ctx.target.x, ctx.target.y, {
        radius: 2,
        amount: 0.24,
        free: true,
      });
      return { ok: true, lesson: `${verb.lesson} ${result.lesson}`, effect: result.effect };
    }
    case 'fire-smother': {
      const result = useImprovised(ctx.room, 'wetBlanket', ctx.target.x, ctx.target.y);
      const effect = result.spray?.effect ?? (result.ok ? 0.01 : 0);
      return { ok: result.ok, lesson: result.lesson, effect };
    }
    case 'fire-isolate': {
      isolate(ctx.room);
      return { ok: true, lesson: verb.lesson, effect: 1 };
    }
    case 'occupant-carry': {
      if (!ctx.actor || !ctx.occupant) return fail('附近没有可救的居民。');
      const ok = attachOccupant(ctx.actor, ctx.occupant);
      return { ok, lesson: verb.lesson, effect: ok ? 1 : 0 };
    }
    case 'occupant-lead': {
      if (!ctx.actor || !ctx.occupant) return fail('附近没有可引导的居民。');
      if (distance(ctx.actor.x, ctx.actor.z, ctx.occupant.x, ctx.occupant.z) > 0.9) {
        return fail('离居民太远。');
      }
      ctx.occupant.mood = 'calm';
      return { ok: true, lesson: verb.lesson, effect: 1 };
    }
    case 'occupant-protect': {
      if (!ctx.actor) return fail('没有可保护的队员。');
      const before = ctx.actor.exposure.smoke;
      ctx.actor.exposure.smoke = before * 0.8;
      return { ok: true, lesson: verb.lesson, effect: before - ctx.actor.exposure.smoke };
    }
    case 'thermal-scan': {
      if (!spend(ctx, 'thermal', SCAN_COST)) return fail('热像仪不可用。');
      const scan = thermalScan(ctx.room, ctx.target.x, ctx.target.y, 0, -1);
      return { ok: true, lesson: verb.lesson, effect: scan.heat, scan };
    }
    default:
      return fail('这个动作还没有实现。');
  }
}
