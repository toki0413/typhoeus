import { describe, it, expect } from 'vitest';
import { createRoom, roomSummary, type RoomState } from '../src/sim/spatial/fields';
import {
  buildDebrief,
  explainAction,
  fieldDelta,
  sampleRoom,
  type ActionRecord,
  type FieldSample,
} from '../src/eval/causal';

function sample(partial: Partial<FieldSample> = {}): FieldSample {
  return {
    fire: 0.3,
    smoke: 0.4,
    heat: 0.3,
    oxygen: 0.7,
    structure: 1,
    ...partial,
  };
}

function recordById(id: string, action: string, before: FieldSample, after: FieldSample): ActionRecord {
  return { id, at: 12, action, roomId: '202', before, after };
}

describe('因果复盘', () => {
  it('复盘条目能指到具体动作，delta 等于前后之差', () => {
    const before = sample();
    const after = sample({ fire: 0.1, heat: 0.15, oxygen: 0.8 });
    const rec: ActionRecord = { id: 'rescue-A', at: 8.5, action: 'carry', roomId: '301', before, after };

    const entry = explainAction(rec);

    expect(entry.actionId).toBe(rec.id);
    expect(entry.at).toBe(rec.at);
    expect(entry.action).toBe(rec.action);
    expect(entry.roomId).toBe(rec.roomId);
    for (const key of ['fire', 'smoke', 'heat', 'oxygen', 'structure'] as const) {
      expect(entry.delta[key]).toBeCloseTo(after[key] - before[key]);
    }
  });

  it('因果解释随场变化而不同', () => {
    const vent = explainAction(
      recordById('vent-1', '开窗', sample({ smoke: 0.6, oxygen: 0.5 }), sample({ smoke: 0.2, oxygen: 0.75 }))
    );
    const cool = explainAction(
      recordById('cool-1', '水冷却', sample({ fire: 0.6, heat: 0.6 }), sample({ fire: 0.2, heat: 0.25 }))
    );
    const damage = explainAction(
      recordById('damage-1', '破拆', sample({ structure: 1 }), sample({ structure: 0.6 }))
    );

    expect(vent.summary).toMatch(/通风|氧/);
    expect(cool.summary).toMatch(/火|热/);
    expect(damage.summary).toMatch(/结构/);

    const summaries = [vent.summary, cool.summary, damage.summary];
    expect(new Set(summaries).size).toBe(3);
  });

  it('无变化也有解释', () => {
    const entry = explainAction(recordById('noop-1', '待命', sample(), sample()));
    expect(entry.summary).toContain('没有明显变化');
    expect(entry.summary).toContain('待命');
  });

  it('顺序与完整性保持不变', () => {
    const records = [
      recordById('a', 'open-door', sample(), sample({ oxygen: 0.75 })),
      recordById('b', 'vent', sample(), sample({ smoke: 0.1 })),
      recordById('c', 'carry', sample(), sample({ fire: 0.1 })),
    ];

    const entries = buildDebrief(records);

    expect(entries).toHaveLength(records.length);
    expect(entries.map((e) => e.actionId)).toEqual(['a', 'b', 'c']);
  });

  it('sampleRoom 与 roomSummary 一致', () => {
    const room: RoomState = createRoom();
    room.cells[0].fire = 0.5;
    room.cells[0].smoke = 0.4;
    room.cells[0].heat = 0.6;
    room.cells[0].oxygen = 0.3;
    room.cells[0].structure = 0.5;

    const summary = roomSummary(room);
    const field = sampleRoom(room);

    expect(field.fire).toBeCloseTo(summary.fire);
    expect(field.smoke).toBeCloseTo(summary.smoke);
    expect(field.heat).toBeCloseTo(summary.heat);
    expect(field.oxygen).toBeCloseTo(summary.oxygen);
    expect(field.structure).toBeCloseTo(summary.structure);
    expect(fieldDelta(field, field)).toEqual({
      fire: 0,
      smoke: 0,
      heat: 0,
      oxygen: 0,
      structure: 0,
    });
  });
});
