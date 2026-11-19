import type { SimState } from './types';
import { clamp01 } from './smoke';

export function checkDoor(s: SimState): void {
  if (s.door.checked || s.door.opened) return;
  s.door.checked = true;
  s.door.temp = 'hot';
  s.decisions.push({ at: s.t, kind: 'door', label: '门温试探' });
  s.events.push({
    at: s.t,
    type: 'evidence',
    anchorId: 'K-DOOR-TEMP',
    detail: '手背试温：门把烫手',
  });
}

export function waitDoor(s: SimState): void {
  if (s.door.opened || s.door.safe || s.door.waitUntil !== null) return;
  s.door.waitUntil = s.t + 30;
  s.decisions.push({ at: s.t, kind: 'door', label: '等待 30 秒' });
}

export function openDoor(s: SimState): void {
  if (s.door.opened) return;
  s.door.opened = true;
  s.door.waitUntil = null;
  s.decisions.push({ at: s.t, kind: 'door', label: '开门' });

  if (!s.door.checked) {
    s.events.push({
      at: s.t,
      type: 'omission',
      anchorId: 'O-DOOR-TEMP',
      detail: '未进行门温试探',
    });
  }

  if (s.door.safe) {
    s.victim.rescued = true;
    s.victim.alive = true;
    s.events.push({
      at: s.t,
      type: 'rescue',
      anchorId: 'K-RESCUE',
      detail: '开门后救出被困者',
    });
    return;
  }

  s.victim.alive = false;
  s.victim.rescued = false;
  s.crew.injured = true;
  s.exposure.heat = clamp01(s.exposure.heat + 0.5);
  s.events.push({
    at: s.t,
    type: 'injury',
    anchorId: 'K-BACKDRAFT-FAIL',
    detail: '回燃，班组受伤',
  });
  s.events.push({
    at: s.t,
    type: 'death',
    anchorId: 'K-VICTIM-LOST',
    detail: '被困者未能救出',
  });
}
