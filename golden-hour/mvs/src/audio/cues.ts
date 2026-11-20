import type { SimState } from '../sim/types';
import { radioLinesUpTo } from '../content/radio';

export type CueKind = 'radio' | 'door' | 'heartbeat';

export interface AudioCue {
  kind: CueKind;
  gain: number;
}

export interface AudioSnapshot {
  doorOpened: boolean;
  radioCount: number;
  heartbeatOn: boolean;
}

export const EMPTY_SNAPSHOT: AudioSnapshot = {
  doorOpened: false,
  radioCount: 0,
  heartbeatOn: false,
};

export function deriveAudioCues(
  previous: AudioSnapshot,
  s: SimState
): { cues: AudioCue[]; snapshot: AudioSnapshot } {
  const cues: AudioCue[] = [];

  const radioCount = radioLinesUpTo(s.t);
  if (radioCount > previous.radioCount) {
    cues.push({ kind: 'radio', gain: 0.55 + Math.min(0.35, (radioCount - previous.radioCount) * 0.1) });
  }

  if (s.door.opened && !previous.doorOpened) {
    cues.push({ kind: 'door', gain: 0.9 });
  }

  const floor = Math.min(s.crew.floor, s.smoke.length - 1);
  const smoke = s.smoke[floor] ?? 0;
  const heartbeatOn = s.phase === 'execute' && smoke >= 0.5;
  if (heartbeatOn && !previous.heartbeatOn) {
    cues.push({ kind: 'heartbeat', gain: Math.min(1, smoke) });
  }

  return {
    cues,
    snapshot: { doorOpened: s.door.opened, radioCount, heartbeatOn },
  };
}
