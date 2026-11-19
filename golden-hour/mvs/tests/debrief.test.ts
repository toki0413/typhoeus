import { describe, it, expect } from 'vitest';
import { createWorld } from '../src/sim/world';
import { stepSim } from '../src/sim/step';
import { checkDoor, openDoor } from '../src/sim/door';
import { buildDebrief } from '../src/eval/debrief';

describe('buildDebrief', () => {
  it('未试温开门时，遗漏清单包含门温试探', () => {
    const s = createWorld('GH-FIRE-MVS');
    stepSim(s, 1 / 20);
    openDoor(s);
    const card = buildDebrief(s);
    expect(card.omissions).toContain('未进行门温试探');
    expect(card.tactical.lost).toBe(1);
  });

  it('成功救援时，学习记录包含门温与等待', () => {
    const s = createWorld('GH-FIRE-MVS');
    checkDoor(s);
    s.door.waitUntil = s.t - 1;
    stepSim(s, 1 / 20);
    openDoor(s);
    const card = buildDebrief(s);
    expect(card.tactical.rescued).toBe(1);
    const ids = card.learning.map((l) => l.anchorId);
    expect(ids).toContain('K-DOOR-TEMP');
    expect(ids).toContain('K-BACKDRAFT-WAIT');
  });

  it('学习账不包含结果锚点 K-RESCUE', () => {
    const s = createWorld('GH-FIRE-MVS');
    checkDoor(s);
    s.door.waitUntil = s.t - 1;
    stepSim(s, 1 / 20);
    openDoor(s);
    const card = buildDebrief(s);
    expect(card.learning.map((l) => l.anchorId)).not.toContain('K-RESCUE');
    expect(card.timeline.some((t) => t.type === 'rescue')).toBe(true);
  });

  it('死亡局失败锚点 correct 为 0', () => {
    const s = createWorld('GH-FIRE-MVS');
    checkDoor(s);
    openDoor(s);
    const card = buildDebrief(s);
    const fail = card.learning.find((l) => l.anchorId === 'K-BACKDRAFT-FAIL');
    expect(fail?.correct).toBe(0);
    expect(card.tactical.trapped).toBe(0);
    expect(card.tactical.lost).toBe(1);
  });

  it('复盘卡带章节与标准版本信息', () => {
    const card = buildDebrief(createWorld('x'));
    expect(card.provenance.chapter).toBe(2);
    expect(card.provenance.standardEdition).toBe('IFRC-2025');
    expect(card.provenance.assistedMode).toBe(false);
  });
});
