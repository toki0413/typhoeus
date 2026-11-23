// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderCurve, renderDebrief, renderScore } from '../src/app/buildingOutcome';
import type { ScoreBreakdown } from '../src/eval/score';

function el(): HTMLElement {
  return document.createElement('div');
}

const breakdown: ScoreBreakdown = {
  score: 860,
  stars: 2,
  reasons: ['全部救出', '用时偏长'],
};

describe('建筑结算渲染', () => {
  it('没有曲线采样时给出提示', () => {
    const box = el();
    renderCurve(box, [], []);
    expect(box.innerHTML).toContain('没有采样到暴露曲线');
  });

  it('有本次曲线时画三条线并标注图例', () => {
    const box = el();
    renderCurve(
      box,
      [
        { t: 0, smoke: 0, heat: 0 },
        { t: 1, smoke: 0.2, heat: 0.1, fire: 0.3 },
      ],
      []
    );
    expect(box.querySelectorAll('path.smoke')).toHaveLength(1);
    expect(box.querySelectorAll('path.heat')).toHaveLength(1);
    expect(box.querySelectorAll('path.fire')).toHaveLength(1);
    expect(box.textContent).toContain('烟 / 热 / 火');
  });

  it('有最佳曲线时叠加幽灵线', () => {
    const box = el();
    const samples = [
      { t: 0, smoke: 0, heat: 0 },
      { t: 1, smoke: 0.2, heat: 0.1 },
    ];
    renderCurve(box, samples, samples);
    expect(box.querySelectorAll('path.ghost-smoke')).toHaveLength(1);
    expect(box.textContent).toContain('实线 本次');
  });

  it('首次记录显示首次提示，有对比时显示差值', () => {
    const first = el();
    renderScore(first, breakdown, null, 860);
    expect(first.textContent).toContain('首次记录');
    expect(first.textContent).toContain('该户型最佳 860 分');
    expect(first.querySelector('.stars')?.textContent).toBe('★★☆');

    const versus = el();
    renderScore(
      versus,
      breakdown,
      { rescuedDelta: 1, timeDelta: -2.5, exposureDelta: 0.05, scoreDelta: 40, better: true },
      900
    );
    expect(versus.textContent).toContain('救出 +1');
    expect(versus.textContent).toContain('用时 -2.5s');
    expect(versus.textContent).toContain('峰值暴露 +0.05');
  });

  it('复盘列表用调用方提供的区域名并支持空态', () => {
    const empty = el();
    renderDebrief(empty, [], (id) => id);
    expect(empty.textContent).toContain('没有可复盘的动作');

    const box = el();
    renderDebrief(
      box,
      [
        {
          actionId: 'a1',
          at: 12.34,
          action: '开门',
          roomId: 'room-202',
          delta: { smoke: 0.1, heat: 0.2, fire: 0, oxygen: -0.1, structure: 0 },
          summary: '空气被抽走',
        },
      ],
      () => '202 主卧'
    );
    expect(box.querySelectorAll('li')).toHaveLength(1);
    expect(box.textContent).toContain('12.3s');
    expect(box.textContent).toContain('202 主卧');
    expect(box.textContent).toContain('空气被抽走');
  });
});
