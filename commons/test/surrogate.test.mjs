/**
 * 神经代理（降阶 MLP）：
 *   - 权重可载入，前向输出有限
 *   - 候选排序按预测分降序，参数在训练范围内
 *   - 留出集指标达到可用门槛（签名误差、场误差、排序）
 *   - 预测不是裁判：分数仍由 evaluateTarget 决定
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  loadSurrogate, predict, predictScore, rankCandidates, surrogateSummary,
} from '../server/research/surrogate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGETS = JSON.parse(
  readFileSync(path.join(HERE, '..', 'server', 'research', 'targets.json'), 'utf8'),
).targets;
const MODEL = loadSurrogate();

const CASES = [
  ['grayScott', 'gs-spots-lit', { f: 0.035, k: 0.062 }],
  ['lengyelEpstein', 'cima-stripes', { a: 8, b: 6, sigma: 0.6 }],
];

function targetFor(id) {
  return TARGETS.find((t) => t.id === id);
}

test('代理权重可载入且包含两类模型', () => {
  assert.ok(MODEL, '缺少 server/research/surrogate.json');
  assert.ok(MODEL.kinds.grayScott, '缺少 Gray–Scott 代理');
  assert.ok(MODEL.kinds.lengyelEpstein, '缺少 Lengyel–Epstein 代理');
  const summary = surrogateSummary(MODEL);
  assert.equal(summary.model || summary.kind, 'mlp-field-pca');
});

test('前向预测输出有限且签名在物理范围内', () => {
  for (const [kind, , params] of CASES) {
    const out = predict(MODEL, kind, params);
    assert.ok(out, `${kind} 无预测`);
    for (const key of ['density', 'anisotropy', 'period', 'components', 'perimeter']) {
      assert.ok(Number.isFinite(out.features[key]), `${kind} ${key} 非有限`);
    }
    assert.ok(out.features.density >= 0 && out.features.density <= 1);
    assert.ok(out.features.anisotropy >= 0 && out.features.anisotropy <= 1);
    assert.ok(out.features.period >= 0 && out.features.period <= 64);
    assert.equal(out.field.length, 256);
    assert.ok(out.field.every((v) => v >= 0 && v <= 1));
  }
});

test('候选排序：两类目标都降序，参数在训练范围内', () => {
  for (const [kind, targetId] of CASES) {
    const target = targetFor(targetId);
    const items = rankCandidates(MODEL, kind, target.features, 3);
    assert.equal(items.length, 3, `${kind} 候选数`);
    for (let i = 1; i < items.length; i++) {
      assert.ok(items[i - 1].predictedScore >= items[i].predictedScore, `${kind} 未排序`);
    }
    for (const it of items) {
      const m = MODEL.kinds[kind];
      const values = m.params.map((name) => it[name]);
      values.forEach((v, i) => {
        assert.ok(v >= m.ranges[m.params[i]][0] - 1e-6, `${kind} ${m.params[i]} 低于范围`);
        assert.ok(v <= m.ranges[m.params[i]][1] + 1e-6, `${kind} ${m.params[i]} 高于范围`);
      });
      assert.ok(Number.isFinite(it.predictedScore));
      assert.ok(Number.isFinite(predictScore(MODEL, kind, target.features, it).distance));
    }
  }
});

test('留出集指标达到可用门槛', () => {
  for (const [kind] of CASES) {
    const metrics = MODEL.kinds[kind].metrics?.holdout;
    assert.ok(metrics, `${kind} 缺少留出集指标`);
    assert.ok(metrics.signatureRmse.density < 0.3, `${kind} 密度 RMSE ${metrics.signatureRmse.density}`);
    assert.ok(metrics.signatureRmse.anisotropy < 0.2, `${kind} 各向异性 RMSE ${metrics.signatureRmse.anisotropy}`);
    assert.ok(metrics.scoreMae < 8, `${kind} 分数 MAE ${metrics.scoreMae}`);
    assert.ok(metrics.fieldRmse < 0.3, `${kind} 场 RMSE ${metrics.fieldRmse}`);
    assert.ok(metrics.scorePearson > 0.5, `${kind} 分数相关 ${metrics.scorePearson}`);
    assert.ok(metrics.poolRecall.top3Hit > 0.85, `${kind} 候选池 Top-3 ${metrics.poolRecall.top3Hit}`);
  }
});
