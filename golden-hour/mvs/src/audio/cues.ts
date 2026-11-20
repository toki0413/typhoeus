import type { SimState } from '../sim/types';
import { radioLinesUpTo } from '../content/radio';
import { activeIncident } from '../sim/incidents';

export type CueKind =
  | 'radio'
  | 'arrive'
  | 'door-check'
  | 'door-wait-safe'
  | 'door-wait-fail'
  | 'door-open'
  | 'suppress'
  | 'incident'
  | 'resolve'
  | 'ignore'
  | 'injury'
  | 'rescue'
  | 'loss'
  | 'heartbeat'
  | 'alarm';

export interface AudioCue {
  kind: CueKind;
  gain: number;
}

export interface AudioSnapshot {
  time: number;
  radioCount: number;
  atDoor: boolean;
  doorChecked: boolean;
  doorWaiting: boolean;
  doorOpened: boolean;
  extinguishers: number;
  events: number;
  activeIncident: string | null;
  resolved: number;
  urgent: boolean;
  heartbeatOn: boolean;
}

export const EMPTY_SNAPSHOT: AudioSnapshot = {
  time: 0,
  radioCount: 0,
  atDoor: false,
  doorChecked: false,
  doorWaiting: false,
  doorOpened: false,
  extinguishers: 0,
  events: 0,
  activeIncident: null,
  resolved: 0,
  urgent: false,
  heartbeatOn: false,
};

export function deriveAudioCues(
  previous: AudioSnapshot,
  s: SimState
): { cues: AudioCue[]; snapshot: AudioSnapshot } {
  const prev = s.t + 0.001 < previous.time ? EMPTY_SNAPSHOT : previous;
  const cues: AudioCue[] = [];

  const radioCount = radioLinesUpTo(s.t);
  if (radioCount > prev.radioCount) {
    cues.push({
      kind: 'radio',
      gain: 0.55 + Math.min(0.35, (radioCount - prev.radioCount) * 0.1),
    });
  }

  if (s.crew.atDoor && !prev.atDoor) {
    cues.push({ kind: 'arrive', gain: 0.7 });
  }

  if (s.door.checked && !prev.doorChecked) {
    cues.push({ kind: 'door-check', gain: 0.85 });
  }

  if (prev.doorWaiting && s.door.waitUntil === null && !s.door.opened) {
    cues.push({
      kind: s.door.safe ? 'door-wait-safe' : 'door-wait-fail',
      gain: 0.8,
    });
  }

  if (s.door.opened && !prev.doorOpened) {
    cues.push({ kind: 'door-open', gain: 0.95 });
  }

  if (s.resources.extinguisher < prev.extinguishers) {
    cues.push({ kind: 'suppress', gain: 0.9 });
  }

  const incident = activeIncident(s);
  const activeId = incident?.id ?? null;
  if (activeId && activeId !== prev.activeIncident) {
    cues.push({ kind: 'incident', gain: 0.8 });
  }

  const resolvedIncidents = s.incidents.filter((item) => item.resolved);
  if (resolvedIncidents.length > prev.resolved) {
    const newlyResolved = resolvedIncidents.slice(prev.resolved);
    const ignored = newlyResolved.some((item) => item.choice === 'ignore');
    cues.push({ kind: ignored ? 'ignore' : 'resolve', gain: ignored ? 0.6 : 0.7 });
  }
  const resolved = resolvedIncidents.length;

  const urgent = incident !== null && incident.deadline - s.t <= 6;
  if (urgent && !prev.urgent) {
    cues.push({ kind: 'alarm', gain: 0.7 });
  }

  const fresh = s.events.slice(prev.events);
  if (fresh.some((event) => event.type === 'injury')) {
    cues.push({ kind: 'injury', gain: 1 });
  }
  if (fresh.some((event) => event.type === 'death')) {
    cues.push({ kind: 'loss', gain: 0.85 });
  }
  if (fresh.some((event) => event.type === 'rescue')) {
    cues.push({ kind: 'rescue', gain: 0.75 });
  }

  const floor = Math.min(s.crew.floor, s.smoke.length - 1);
  const smoke = s.smoke[floor] ?? 0;
  const heartbeatOn = s.phase === 'execute' && smoke >= 0.5;
  if (heartbeatOn && !prev.heartbeatOn) {
    cues.push({ kind: 'heartbeat', gain: Math.min(1, smoke) });
  }

  return {
    cues,
    snapshot: {
      time: s.t,
      radioCount,
      atDoor: s.crew.atDoor,
      doorChecked: s.door.checked,
      doorWaiting: s.door.waitUntil !== null,
      doorOpened: s.door.opened,
      extinguishers: s.resources.extinguisher,
      events: s.events.length,
      activeIncident: activeId,
      resolved,
      urgent,
      heartbeatOn,
    },
  };
}
