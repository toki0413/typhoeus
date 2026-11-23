import type { SimState } from './types';

/** 玩家接管后，渲染层把当前楼层同步回模拟，供暴露计算与音频使用。 */
export function setCrewFloor(s: SimState, floor: number): void {
  s.crew.floor = floor;
  s.crew.progress = 0;
  s.crew.atDoor = false;
}

/** 把被困者背到出口后调用；下一次 advance 会切到复盘。 */
export function completeExtraction(s: SimState): void {
  if (s.victim.extracted) return;
  s.victim.extracted = true;
  if (s.victim.alive) {
    s.victim.rescued = true;
    s.events.push({
      at: s.t,
      type: 'rescue',
      anchorId: 'K-EXTRACT',
      detail: '将 202 居民背出火场',
    });
  }
}

/** 未完成搜救就离开火场。 */
export function withdraw(s: SimState): void {
  if (s.ended) return;
  s.ended = true;
  s.events.push({
    at: s.t,
    type: 'omission',
    anchorId: 'O-WITHDRAW',
    detail: '未救出被困者便撤出',
  });
}
