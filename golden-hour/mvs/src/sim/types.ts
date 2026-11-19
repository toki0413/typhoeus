export type Phase = 'plan' | 'execute' | 'debrief';

export type Order =
  | { kind: 'search'; floor: number }
  | { kind: 'suppress'; floor: number }
  | { kind: 'rescue'; floor: number };

export type EventType = 'evidence' | 'omission' | 'rescue' | 'death' | 'injury';

export interface SimEvent {
  at: number;
  type: EventType;
  anchorId?: string;
  detail?: string;
}

export interface DoorState {
  checked: boolean;
  temp: 'unknown' | 'hot';
  waitUntil: number | null;
  safe: boolean;
  opened: boolean;
}

export interface SimState {
  seed: string;
  t: number;
  phase: Phase;
  fire: number;
  smoke: number[];
  heat: number[];
  exposure: { smoke: number; heat: number; strain: number };
  crew: { floor: number; progress: number; order: Order | null; atDoor: boolean };
  door: DoorState;
  victim: { alive: boolean; rescued: boolean };
  resources: { extinguisher: number; rope: number; kit: number };
  events: SimEvent[];
}
