export type Phase = 'plan' | 'execute' | 'debrief';

export interface Order {
  kind: 'search';
  floor: number;
}

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

export interface Decision {
  at: number;
  kind: 'order' | 'door' | 'suppress' | 'incident' | 'ignore';
  label: string;
}

export interface IncidentOption {
  id: string;
  label: string;
}

export interface Incident {
  id: 'neighbor' | 'stairs';
  at: number;
  deadline: number;
  title: string;
  detail: string;
  options: IncidentOption[];
  resolved: boolean;
  choice: string | null;
  activatedAt: number | null;
}

export interface ScenarioParams {
  fireGrowthEarly: number;
  fireGrowthLate: number;
  smokeSource: number;
  smokeTransfer: number;
}

export interface SimState {
  seed: string;
  scenario: ScenarioParams;
  t: number;
  phase: Phase;
  fire: number;
  smoke: number[];
  heat: number[];
  exposure: { smoke: number; heat: number; strain: number };
  crew: {
    floor: number;
    progress: number;
    order: Order | null;
    atDoor: boolean;
    injured: boolean;
    busyUntil: number;
  };
  door: DoorState;
  victim: { alive: boolean; rescued: boolean };
  neighbor: {
    alive: boolean;
    saved: boolean;
    saveAt: number | null;
    doomAt: number | null;
  };
  stairs: {
    safe: boolean;
    collapsed: boolean;
    collapseAt: number | null;
  };
  incidents: Incident[];
  decisions: Decision[];
  ended: boolean;
  resources: { extinguisher: number };
  events: SimEvent[];
}
