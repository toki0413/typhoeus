import { describe, it, expect } from 'vitest';
import { createResident } from '../src/sim/agents/resident';
import { createActor } from '../src/sim/spatial/actor';
import { residentMarkers, residentVisualState } from '../src/render/residents';

describe('居民视图映射', () => {
  it('已获救的居民被过滤掉，不再作为场上标记', () => {
    const rescued = createResident('room-202-F1', 0, 0, 'A');
    rescued.rescued = true;
    const alive = createResident('room-202-F1', 1, 1, 'B');

    expect(residentMarkers([rescued, alive]).map((marker) => marker.id)).toEqual(['B']);
  });

  it('dead / unconscious / hidden 映射为对应可视状态', () => {
    const dead = createResident('r', 0, 0, 'D');
    dead.health = 0;
    dead.mood = 'unconscious';
    dead.dead = true;
    const unconscious = createResident('r', 0, 0, 'U');
    unconscious.mood = 'unconscious';
    const hidden = createResident('r', 0, 0, 'H');
    hidden.hidden = true;
    hidden.mood = 'hidden';

    expect(residentVisualState(dead)).toBe('dead');
    expect(residentVisualState(unconscious)).toBe('unconscious');
    expect(residentVisualState(hidden)).toBe('hidden');
  });

  it('rescued 优先级高于 dead', () => {
    const resident = createResident('r', 0, 0, 'X');
    resident.dead = true;
    resident.rescued = true;

    expect(residentVisualState(resident)).toBe('rescued');
  });

  it('roomId 与坐标原样保留', () => {
    const resident = createResident('room-202-F1', -1.875, 1.875, 'A');
    const [marker] = residentMarkers([resident]);

    expect(marker.roomId).toBe('room-202-F1');
    expect(marker.x).toBe(-1.875);
    expect(marker.z).toBe(1.875);
    expect(marker.state).toBe('calm');
  });

  it('躲藏居民距玩家 3m 不显示，1m 时被搜索到', () => {
    const actor = createActor(0, 0);
    const far = createResident('r', 3, 0, 'far');
    far.hidden = true;
    far.mood = 'hidden';
    const near = createResident('r', 1, 0, 'near');
    near.hidden = true;
    near.mood = 'hidden';

    expect(residentMarkers([far], actor)).toHaveLength(0);
    expect(residentMarkers([near], actor).map((marker) => marker.id)).toEqual(['near']);
  });

  it('不传 actor 时仍保留 hidden 居民', () => {
    const hidden = createResident('r', 3, 0, 'H');
    hidden.hidden = true;
    hidden.mood = 'hidden';

    expect(residentMarkers([hidden]).map((marker) => marker.id)).toEqual(['H']);
  });
});
