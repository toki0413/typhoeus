/**
 * 单局评分与本次/最佳对比：纯函数，不碰 DOM、不读存储。
 * 输入是本局汇总，输出确定性的分数、星级与对比差值，便于测试与重放。
 */

import { clamp01 } from '../sim/spatial/fields';

export interface RunResult {
  rescued: number;
  lost: number;
  total: number;
  seconds: number;
  /** 0..1 峰值烟热暴露 */
  peakExposure: number;
  wrongAgent: number;
  airLeft: number;
}

export interface ScoreBreakdown {
  score: number; // 0..100 整数
  stars: 1 | 2 | 3;
  reasons: string[];
}

export interface RunComparison {
  better: boolean;
  scoreDelta: number;
  rescuedDelta: number;
  timeDelta: number;
  exposureDelta: number;
}

/** 把数值夹到闭区间 [min, max]；非有限值按 min 处理。 */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** 按救援率、用时、暴露与用错灭火剂给出 0..100 分与 1..3 星。 */
export function scoreRun(result: RunResult): ScoreBreakdown {
  const base = result.total > 0 ? (result.rescued / result.total) * 60 : 0;
  const timeBonus = clamp(30 - result.seconds / 6, 0, 30);
  const exposurePenalty = clamp01(result.peakExposure) * 12;
  const agentPenalty = result.wrongAgent * 6;
  const score = Math.round(clamp(base + timeBonus - exposurePenalty - agentPenalty, 0, 100));
  const stars: 1 | 2 | 3 = score >= 80 ? 3 : score >= 55 ? 2 : 1;

  const reasons = [`救出 ${result.rescued}/${result.total}`];
  let clean = true;
  if (result.lost > 0) {
    reasons.push(`失去 ${result.lost} 人`);
    clean = false;
  }
  if (result.wrongAgent > 0) {
    reasons.push(`错误灭火剂 ${result.wrongAgent} 次`);
    clean = false;
  }
  if (result.peakExposure > 0.6) {
    reasons.push('暴露偏高');
    clean = false;
  }
  if (result.seconds > 120) {
    reasons.push('用时过长');
    clean = false;
  }
  if (clean) reasons.push('干净利落');

  return { score, stars, reasons };
}

/** 当前局与历史最佳逐项对比；分差用评分重算，其余用原始值相减。 */
export function compareRuns(current: RunResult, best: RunResult): RunComparison {
  return {
    better: scoreRun(current).score > scoreRun(best).score,
    scoreDelta: scoreRun(current).score - scoreRun(best).score,
    rescuedDelta: current.rescued - best.rescued,
    timeDelta: current.seconds - best.seconds,
    exposureDelta: current.peakExposure - best.peakExposure,
  };
}
