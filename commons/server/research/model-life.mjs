/**
 * 模型生命的检查逻辑：把“预期行为”变成可执行的检查项。
 * 与 HTTP 入口分离，测试可以直接调用。
 */

export function checkModel(model, result) {
  const e = model.expected || {};
  const b = result.behavior || {};
  const checks = [];
  if (e.pattern) {
    checks.push({ key: 'pattern', ok: b.pattern === e.pattern, expected: e.pattern, actual: b.pattern });
  }
  if (Array.isArray(e.densityRange)) {
    const [lo, hi] = e.densityRange;
    const value = result.features.density;
    checks.push({ key: 'density', ok: value >= lo && value <= hi, expected: `${lo}–${hi}`, actual: value });
  }
  if (Number.isFinite(e.anisotropyMin)) {
    checks.push({ key: 'anisotropyMin', ok: result.features.anisotropy >= e.anisotropyMin, expected: `≥${e.anisotropyMin}`, actual: result.features.anisotropy });
  }
  if (Number.isFinite(e.anisotropyMax)) {
    checks.push({ key: 'anisotropyMax', ok: result.features.anisotropy <= e.anisotropyMax, expected: `≤${e.anisotropyMax}`, actual: result.features.anisotropy });
  }
  if (Number.isFinite(e.stabilizeStepsMax)) {
    const steps = b.stabilizeSteps;
    checks.push({ key: 'stabilize', ok: steps <= e.stabilizeStepsMax, expected: `≤${e.stabilizeStepsMax}`, actual: steps });
  }
  if (Number.isFinite(e.minScore)) {
    checks.push({ key: 'score', ok: result.score >= e.minScore, expected: `≥${e.minScore}`, actual: result.score });
  }
  return checks;
}
