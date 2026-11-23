import { describe, it, expect } from 'vitest';
import { createRoom } from '../src/sim/spatial/fields';
import {
  DRILLS,
  createDrillProgress,
  drillById,
  evaluateDrill,
} from '../src/content/drills';

const measureDrill = drillById('measure-door')!;
const backdraftDrill = drillById('backdraft-watch')!;
const lowStanceDrill = drillById('low-stance')!;

describe('演练内容定义', () => {
  it('恰好 3 条演练，种类齐全且标识唯一', () => {
    expect(DRILLS).toHaveLength(3);
    expect(DRILLS.map((drill) => drill.kind).sort()).toEqual([
      'backdraft',
      'low-stance',
      'measure',
    ]);
    expect(new Set(DRILLS.map((drill) => drill.id)).size).toBe(3);
    for (const drill of DRILLS) {
      expect(drill.label.length).toBeGreaterThan(0);
      expect(drill.hint.length).toBeGreaterThan(0);
    }
  });
});

describe('贴门测温演练', () => {
  it('只布置温度时不算完成', () => {
    const room = createRoom();
    measureDrill.setup(room);
    expect(room.openings.door.temp).toBe(0.55);
    expect(evaluateDrill(measureDrill, createDrillProgress(), room).ok).toBe(false);
  });

  it('测了门但门板温度偏低时仍不算完成', () => {
    const room = createRoom();
    measureDrill.setup(room);
    room.openings.door.temp = 0.2;
    const progress = { ...createDrillProgress(), measuredDoor: true };
    expect(evaluateDrill(measureDrill, progress, room).ok).toBe(false);
  });

  it('测了门且门板高温时完成', () => {
    const room = createRoom();
    measureDrill.setup(room);
    const progress = { ...createDrillProgress(), measuredDoor: true };
    expect(evaluateDrill(measureDrill, progress, room)).toEqual({
      ok: true,
      reason: '完成',
    });
  });
});

describe('回燃判断演练', () => {
  it('只布置富燃料状态不算完成', () => {
    const room = createRoom();
    backdraftDrill.setup(room);
    expect(room.openings.door.temp).toBe(0.5);
    expect(evaluateDrill(backdraftDrill, createDrillProgress(), room).ok).toBe(false);
  });

  it('打湿门板且没有回燃时完成', () => {
    const room = createRoom();
    backdraftDrill.setup(room);
    room.openings.door.wet = 0.4;
    expect(evaluateDrill(backdraftDrill, createDrillProgress(), room)).toEqual({
      ok: true,
      reason: '完成',
    });
  });

  it('一旦发生回燃就不算完成', () => {
    const room = createRoom();
    backdraftDrill.setup(room);
    room.openings.door.wet = 0.4;
    room.backdraftAt = 5;
    const result = evaluateDrill(backdraftDrill, createDrillProgress(), room);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('回燃');
  });
});

describe('低姿穿越演练', () => {
  it('低姿时间不足 3 秒不算完成', () => {
    const room = createRoom();
    lowStanceDrill.setup(room);
    const progress = { ...createDrillProgress(), lowStanceSeconds: 2.9 };
    expect(evaluateDrill(lowStanceDrill, progress, room).ok).toBe(false);
  });

  it('低姿累计满 3 秒完成', () => {
    const room = createRoom();
    lowStanceDrill.setup(room);
    const progress = { ...createDrillProgress(), lowStanceSeconds: 3 };
    expect(evaluateDrill(lowStanceDrill, progress, room)).toEqual({
      ok: true,
      reason: '完成',
    });
  });
});

describe('演练进度与查找', () => {
  it('失败原因非空且与各自的成功条件对应', () => {
    const room = createRoom();
    const progress = createDrillProgress();

    measureDrill.setup(room);
    expect(evaluateDrill(measureDrill, progress, room).reason).toContain('贴门测温');

    backdraftDrill.setup(room);
    expect(evaluateDrill(backdraftDrill, progress, room).reason).toContain('冷却');

    lowStanceDrill.setup(room);
    expect(evaluateDrill(lowStanceDrill, progress, room).reason).toContain('低姿时间');
  });

  it('新建进度默认全为 0 / false', () => {
    expect(createDrillProgress()).toEqual({
      measuredDoor: false,
      cooledDoor: false,
      lowStanceSeconds: 0,
    });
  });

  it('按标识查不到时返回 undefined', () => {
    expect(drillById('不存在')).toBeUndefined();
  });
});
