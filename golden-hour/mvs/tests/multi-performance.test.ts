import { describe, it, expect } from 'vitest';
import { LAYOUTS } from '../src/content/layouts';
import { FIXED_DT } from '../src/sim/spatial/spread';
import { createZoneScenario, stepScenario } from '../src/sim/spatial/scene';
import { stepLinkSmoke } from '../src/sim/spatial/ventilation';
import { createDirector, stepDirector } from '../src/sim/events/director';
import { createHousehold, stepHousehold } from '../src/sim/agents/household';

describe('多区域性能', () => {
  it('5 区 10 人单步平均低于 2ms', () => {
    const layout = LAYOUTS[0];
    const def = createZoneScenario(
      layout.build(),
      layout.entrance,
      layout.zones,
      'perf-multi',
      1
    );
    const household = createHousehold(layout.zones, 1);
    const director = createDirector(1);

    const step = (): void => {
      stepScenario(def, FIXED_DT);
      stepLinkSmoke(def.building, FIXED_DT, director.wind);
      stepHousehold(household, def.building, FIXED_DT);
      stepDirector(director, def.building, FIXED_DT);
    };

    // 预热，避免 JIT 首次编译影响平均值。
    for (let i = 0; i < 100; i++) step();

    const start = performance.now();
    for (let i = 0; i < 1000; i++) step();
    const avg = (performance.now() - start) / 1000;

    expect(avg).toBeLessThan(2);
    expect(def.building.rooms[layout.target].room.t).toBeGreaterThan(100);
  });
});
