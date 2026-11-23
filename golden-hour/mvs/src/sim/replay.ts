import { FIXED_DT } from './spatial/spread';
import { roomSummary } from './spatial/fields';
import { stepScenario, type ScenarioDefinition } from './spatial/scene';

export type ReplayInputKind = 'open-door' | 'open-window' | 'break-window' | 'noop';

export interface ReplayInput {
  /** 模拟时刻（秒），到达该时刻时应用一次 */
  at: number;
  roomId: string;
  kind: ReplayInputKind;
}

export interface ReplayFrame {
  t: number;
  roomId: string;
  fire: number;
  smoke: number;
  heat: number;
  oxygen: number;
}

/** 把一条输入落到房间开口上；noop 与不存在的房间都不改场。 */
function applyReplayInput(def: ScenarioDefinition, input: ReplayInput): void {
  if (!Object.hasOwn(def.building.rooms, input.roomId)) return;
  const room = def.building.rooms[input.roomId].room;

  switch (input.kind) {
    case 'open-door':
      room.openings.door.open = true;
      break;
    case 'open-window':
      room.openings.window.open = true;
      break;
    case 'break-window':
      room.openings.window.broken = true;
      break;
    case 'noop':
      break;
  }
}

/** 读取目标房间当前时刻的聚合场，作为一帧。 */
function frameOf(def: ScenarioDefinition): ReplayFrame {
  const room = def.building.rooms[def.targetRoom].room;
  const summary = roomSummary(room);
  return {
    t: room.t,
    roomId: def.targetRoom,
    fire: summary.fire,
    smoke: summary.smoke,
    heat: summary.heat,
    oxygen: summary.oxygen,
  };
}

/** 以 def.targetRoom 为目标采样；inputs 按 at 稳定排序后逐条应用。 */
export function replayScenario(
  def: ScenarioDefinition,
  inputs: ReplayInput[],
  seconds = 30,
  sampleSeconds = 0.5
): ReplayFrame[] {
  // 复制后再排序，避免改动调用方数组；at 相同的输入保持原有先后。
  const queue = [...inputs].sort((a, b) => a.at - b.at);
  const frames: ReplayFrame[] = [];
  const sampleSteps = Math.max(1, Math.round(sampleSeconds / FIXED_DT));
  let cursor = 0;
  let step = 0;

  while (def.building.rooms[def.targetRoom].room.t < seconds) {
    const t = def.building.rooms[def.targetRoom].room.t;

    // 到达时刻的输入先落场，再推进一个固定步长；每条输入只应用一次。
    while (cursor < queue.length && queue[cursor].at <= t + 1e-9) {
      applyReplayInput(def, queue[cursor]);
      cursor += 1;
    }

    stepScenario(def, FIXED_DT);
    step += 1;

    if (step % sampleSteps === 0) {
      frames.push(frameOf(def));
    }
  }

  // 收尾帧：末尾没落在采样点上时补一帧；恰好落在采样点则不重复记录。
  const tail = frameOf(def);
  const last = frames[frames.length - 1];
  if (!last || Math.abs(last.t - tail.t) > 1e-9) frames.push(tail);
  return frames;
}

/** FNV-1a 哈希；对每帧数值保留 4 位小数，避免浮点噪声造成误判。 */
export function hashFrames(frames: ReplayFrame[]): number {
  let hash = 0x811c9dc5;

  const feed = (text: string): void => {
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  };

  for (const frame of frames) {
    feed(frame.t.toFixed(4));
    feed(frame.roomId);
    feed(frame.fire.toFixed(4));
    feed(frame.smoke.toFixed(4));
    feed(frame.heat.toFixed(4));
    feed(frame.oxygen.toFixed(4));
    feed('|');
  }

  return hash >>> 0;
}
