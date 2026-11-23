import { describe, it, expect } from 'vitest';
import {
  RESIDENT_STATE_TEXT,
  ZONE_STATUS_TEXT,
  confirmReasonText,
  rescueReasonText,
  windText,
} from '../src/app/buildingText';

describe('建筑入口文案', () => {
  it('风向按方位与风速显示', () => {
    expect(windText({ x: 1, y: 0, speed: 0.7 })).toBe('东 · 0.70');
    expect(windText({ x: 0, y: 1, speed: 0.8 })).toBe('北 · 0.80');
    expect(windText({ x: -1, y: 0, speed: 0.3 })).toBe('西 · 0.30');
    expect(windText({ x: 0, y: 0, speed: 0.3 })).toBe('无风 · 0.30');
  });

  it('救援/护送失败原因有中文文案', () => {
    expect(rescueReasonText('too-far')).toBe('离居民太远');
    expect(rescueReasonText('unconscious-needs-carry')).toBe('昏迷只能背');
    expect(rescueReasonText('already-escorted')).toBe('已带离');
    expect(rescueReasonText('ok')).toBe('成功');
  });

  it('确认送达失败原因有独立文案', () => {
    expect(confirmReasonText('not-escorted')).toBe('尚未带离');
    expect(confirmReasonText('too-far')).toBe('离门口太远');
    expect(confirmReasonText('ok')).toBe('已确认');
  });

  it('居民与区域状态文案完整', () => {
    expect(RESIDENT_STATE_TEXT).toEqual({
      calm: '平静',
      panic: '恐慌',
      hidden: '躲藏',
      unconscious: '昏迷',
      dead: '已失去',
      rescued: '已救出',
    });
    expect(ZONE_STATUS_TEXT).toEqual({ pending: '待救', active: '进行', done: '完成' });
  });
});
