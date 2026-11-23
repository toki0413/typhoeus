import { describe, it } from 'vitest';
import { createRoom, roomSummary, cellAt, computeBackdraftRisk } from '../src/sim/spatial/fields';
import { runRoom } from '../src/sim/spatial/spread';
import { openOpening, spray, measureOpening } from '../src/sim/spatial/verbs';

function report(tag: string, room: ReturnType<typeof createRoom>) {
  const s = roomSummary(room);
  console.log(
    tag,
    JSON.stringify({
      t: +room.t.toFixed(1),
      fire: +s.fire.toFixed(3),
      heat: +s.heat.toFixed(3),
      smoke: +s.smoke.toFixed(3),
      oxygen: +s.oxygen.toFixed(3),
      doorTemp: +room.openings.door.temp.toFixed(3),
      risk: +computeBackdraftRisk(room).toFixed(3),
      sourceFire: +cellAt(room, 5, 4).fire.toFixed(3),
      oilFire: +cellAt(room, 2, 5).fire.toFixed(3),
    })
  );
}

describe('debug room numbers', () => {
  it('smolder timeline', () => {
    const room = createRoom();
    for (const t of [5, 10, 20, 30, 40, 60]) {
      runRoom(room, t - room.t);
      report(`smolder ${t}s`, room);
    }
  });

  it('open door without cooling', () => {
    const room = createRoom();
    runRoom(room, 40);
    report('before open', room);
    const res = openOpening(room, 'door');
    console.log('open result', res, measureOpening(room, 'door'));
    runRoom(room, 2);
    report('after 2s', room);
    console.log('backdraftAt', room.backdraftAt, 'peak', room.stats.peakHeat);
  });

  it('cool door then open', () => {
    const room = createRoom();
    runRoom(room, 40);
    for (let i = 0; i < 6; i++) spray(room, 'water', 0, 4, { radius: 1, amount: 0.2 });
    runRoom(room, 4);
    report('after cool', room);
    const res = openOpening(room, 'door');
    console.log('cooled open result', res, measureOpening(room, 'door'));
    runRoom(room, 2);
    report('cooled after 2s', room);
  });

  it('vent window then open', () => {
    const room = createRoom();
    runRoom(room, 40);
    openOpening(room, 'window');
    for (const t of [10, 20, 30]) {
      runRoom(room, 10);
      report(`vent ${t}s`, room);
    }
    const res = openOpening(room, 'door');
    console.log('vented open result', res, measureOpening(room, 'door'));
  });

  it('water on sofa vs water on oil', () => {
    const room = createRoom();
    runRoom(room, 10);
    report('pre spray', room);
    for (let i = 0; i < 8; i++) {
      spray(room, 'water', 5, 4, { radius: 2, amount: 0.2 });
      runRoom(room, 1);
    }
    report('sofa sprayed', room);

    const oil = createRoom();
    runRoom(oil, 10);
    const before = cellAt(oil, 2, 5).fire;
    const bad = spray(oil, 'water', 2, 5, { radius: 1, amount: 0.3 });
    console.log('oil water result', bad, 'oil fire', before, '->', cellAt(oil, 2, 5).fire);

    const good = spray(oil, 'dryPowder', 2, 5, { radius: 1, amount: 0.3 });
    console.log('oil powder result', good, 'oil fire ->', cellAt(oil, 2, 5).fire);
  });
});
