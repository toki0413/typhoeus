import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createAgents } from '../src/render/agents';
import { createWorld } from '../src/sim/world';

function run(a: ReturnType<typeof createAgents>, s: ReturnType<typeof createWorld>, frames: number, dt = 0.05) {
  for (let i = 0; i < frames; i++) {
    s.t += dt;
    a.update(s, dt);
  }
}

describe('班组路线', () => {
  it('主楼梯可以把班组带到二层', () => {
    const a = createAgents(new THREE.Scene());
    const s = createWorld('x');
    s.phase = 'execute';
    s.crew.manual = true;

    a.snap(s, -11, 1.65, 0);
    a.update(s, 0.05);
    expect(a.action()?.kind).toBe('up');

    a.performAction(s);
    run(a, s, 40);

    expect(a.floor()).toBe(1);
    expect(s.crew.floor).toBe(1);
  });

  it('楼梯坍塌时主楼梯被封锁，消防梯仍可用', () => {
    const a = createAgents(new THREE.Scene());
    const s = createWorld('x');
    s.phase = 'execute';
    s.crew.manual = true;
    s.stairs.collapsed = true;

    a.snap(s, -11, 1.65, 0);
    a.update(s, 0.05);
    expect(a.action()?.kind).toBe('blocked');

    a.snap(s, 10.5, 1.65, 0);
    a.update(s, 0.05);
    expect(a.action()?.kind).toBe('up');
  });

  it('开门后可以进入 202 并背起被困者', () => {
    const a = createAgents(new THREE.Scene());
    const s = createWorld('x');
    s.phase = 'execute';
    s.crew.manual = true;
    s.door.opened = true;
    s.door.safe = true;
    s.victim.alive = true;

    a.snap(s, 0, 1.65, 1);
    a.move(0, -1);
    for (let i = 0; i < 80 && a.action()?.kind !== 'carry'; i++) {
      s.t += 0.05;
      a.update(s, 0.05);
    }

    expect(a.action()?.kind).toBe('carry');
    a.performAction(s);
    expect(a.carrying()).toBe(true);
  });

  it('背人到达一层出口后完成撤离', () => {
    const a = createAgents(new THREE.Scene());
    const s = createWorld('x');
    s.phase = 'execute';
    s.crew.manual = true;
    s.door.opened = true;
    s.door.safe = true;
    s.victim.alive = true;

    a.snap(s, 0, 1.65, 1);
    a.move(0, -1);
    for (let i = 0; i < 80 && a.action()?.kind !== 'carry'; i++) {
      s.t += 0.05;
      a.update(s, 0.05);
    }
    a.performAction(s);
    expect(a.carrying()).toBe(true);

    a.snap(s, 9.6, 1.65, 0);
    a.update(s, 0.05);
    expect(a.action()?.kind).toBe('exit');
    a.performAction(s);

    expect(s.victim.extracted).toBe(true);
  });
});
