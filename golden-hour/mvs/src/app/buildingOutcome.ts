import { buildCurvePaths, type CurveSample } from '../eval/curves';
import type { RunComparison, ScoreBreakdown } from '../eval/score';
import type { DebriefEntry } from '../eval/causal';

/** 结算时的暴露曲线：本次实线，最佳记录存在时叠加两条虚线幽灵。 */
export function renderCurve(
  container: HTMLElement,
  samples: CurveSample[],
  bestCurve: CurveSample[]
): void {
  const curve = buildCurvePaths(samples);
  if (!curve.hasData) {
    container.innerHTML = '<p class="hint">没有采样到暴露曲线。</p>';
    return;
  }
  // 最佳曲线复用同一画布尺寸，横向按各自时间轴铺满。
  const ghost = bestCurve.length
    ? buildCurvePaths(bestCurve, curve.width, curve.height)
    : null;
  const ghostPaths = ghost?.hasData
    ? `<path class="ghost-smoke" d="${ghost.smoke}" />
        <path class="ghost-heat" d="${ghost.heat}" />`
    : '';
  const legend = ghostPaths ? '实线 本次 · 虚线 最佳' : '烟 / 热 / 火（0–1）';
  container.innerHTML = `<svg viewBox="0 0 ${curve.width} ${curve.height}" role="img" aria-label="烟热暴露曲线">
        <path class="smoke" d="${curve.smoke}" />
        <path class="heat" d="${curve.heat}" />
        <path class="fire" d="${curve.fire}" />
        ${ghostPaths}
      </svg>
      <div class="curve-legend">${legend}</div>`;
}

/** 星级、分数、评分原因、本次/最佳对比与该户型最佳分。 */
export function renderScore(
  container: HTMLElement,
  breakdown: ScoreBreakdown,
  comparison: RunComparison | null,
  bestScore: number
): void {
  const stars = '★'.repeat(breakdown.stars) + '☆'.repeat(3 - breakdown.stars);
  const versus = comparison
    ? `本次 vs 最佳：救出 ${comparison.rescuedDelta >= 0 ? '+' : ''}${
        comparison.rescuedDelta
      } · 用时 ${comparison.timeDelta >= 0 ? '+' : ''}${comparison.timeDelta.toFixed(
        1
      )}s · 峰值暴露 ${comparison.exposureDelta >= 0 ? '+' : ''}${comparison.exposureDelta.toFixed(
        2
      )}`
    : '首次记录，已保存为最佳';
  container.innerHTML = `<b class="stars">${stars}</b> ${breakdown.score} 分<div class="reasons">${breakdown.reasons.join(
    ' · '
  )}</div><div class="versus">${versus}</div><div class="progress-best">该户型最佳 ${bestScore} 分</div>`;
}

/** 因果复盘列表：只显示最近几条动作；房间名由调用方按模式格式化。 */
export function renderDebrief(
  container: HTMLElement,
  entries: DebriefEntry[],
  zoneName: (roomId: string) => string
): void {
  container.innerHTML = entries.length
    ? entries
        .map(
          (entry) =>
            `<li><b>${entry.at.toFixed(1)}s</b> ${entry.action} · ${zoneName(
              entry.roomId
            )}<span>${entry.summary}</span></li>`
        )
        .join('')
    : '<li>没有可复盘的动作。</li>';
}
