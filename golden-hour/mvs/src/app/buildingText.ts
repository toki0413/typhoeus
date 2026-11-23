import type {
  ConfirmReason,
  EscortReason,
  RescueReason,
} from '../sim/agents/crowd';
import type { ResidentVisualState } from '../render/residents';
import type { ZoneStatus } from './zonePlan';

export interface WindLike {
  x: number;
  y: number;
  speed: number;
}

export const RESIDENT_STATE_TEXT: Record<ResidentVisualState, string> = {
  calm: '平静',
  panic: '恐慌',
  hidden: '躲藏',
  unconscious: '昏迷',
  dead: '已失去',
  rescued: '已救出',
};

export const ZONE_STATUS_TEXT: Record<ZoneStatus, string> = {
  pending: '待救',
  active: '进行',
  done: '完成',
};

/** 8 个中文方位：0° 指向东，每 45° 一档。 */
const WIND_LABELS = ['东', '东北', '北', '西北', '西', '西南', '南', '东南'];

/** 把导演的风矢量翻成“方位 · 风速”，供 HUD 显示。 */
export function windText(wind: WindLike): string {
  const { x, y, speed } = wind;
  if (Math.hypot(x, y) < 1e-6) return `无风 · ${speed.toFixed(2)}`;
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  const slot = Math.round(((deg + 360) % 360) / 45) % 8;
  return `${WIND_LABELS[slot]} · ${speed.toFixed(2)}`;
}

export function rescueReasonText(reason: RescueReason | EscortReason): string {
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
    case 'already-escorted':
      return '已带离';
    case 'ok':
      return '成功';
  }
}

export function confirmReasonText(reason: ConfirmReason): string {
  switch (reason) {
    case 'too-far':
      return '离门口太远';
    case 'not-escorted':
      return '尚未带离';
    case 'lost':
      return '已经失去';
    case 'already-rescued':
      return '已确认';
    case 'ok':
      return '已确认';
  }
}
