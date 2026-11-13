/**
 * 模型生命：固定参数 + 固定种子 + 结构/行为检查。
 *
 * 这组测试对应 OpenWorm 式的“模型卡”思路：
 * 模型不是一张好看的图，而是一组可复现的声明与检查项。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { evaluateTarget } from '../server/research/score.mjs';
import { checkModel } from '../server/research/model-life.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGETS = JSON.parse(
  readFileSync(path.join(HERE, '..', 'server', 'research', 'targets.json'), 'utf8'),
).targets;
const MODEL_LIVES = JSON.parse(
  readFileSync(path.join(HERE, '..', 'server', 'research', 'model-lives.json'), 'utf8'),
).models;

function targetFor(id) {
  return TARGETS.find((t) => t.id === id);
}

function replicate(model) {
  const target = targetFor(model.targetId);
  assert.ok(target, `${model.id} 的目标不存在`);
  return evaluateTarget(target, model.params, { includeBehavior: true });
}

test('模型生命卡完整：四个模型、目标、种子、来源与不变量', () => {
  assert.equal(MODEL_LIVES.length, 4);
  const ids = new Set();
  for (const m of MODEL_LIVES) {
    assert.ok(m.id && !ids.has(m.id), `模型 id 重复或缺失：${m.id}`);
    ids.add(m.id);
    assert.ok(m.label && m.short && m.description);
    assert.ok(m.engine === 'grayScott' || m.engine === 'lengyelEpstein');
    assert.ok(targetFor(m.targetId), `${m.id} 缺目标`);
    assert.ok(m.params && typeof m.params === 'object');
    assert.ok(m.seedPolicy, `${m.id} 缺种子策略`);
    assert.ok(Number.isFinite(m.steps), `${m.id} 缺步数`);
    assert.ok(m.expected?.pattern, `${m.id} 缺预期模式`);
    assert.ok(m.provenance?.source && m.provenance?.license, `${m.id} 缺来源/许可`);
    assert.ok(Array.isArray(m.invariants) && m.invariants.length >= 2, `${m.id} 缺不变量`);
  }
});

test('四个模型生命都能复现，并通过模型卡检查', () => {
  for (const m of MODEL_LIVES) {
    const result = replicate(m);
    assert.ok(Number.isFinite(result.score), `${m.id} 分数非有限`);
    assert.ok(result.behavior, `${m.id} 缺行为指纹`);
    for (const key of ['stabilizeSteps', 'activity', 'flipRate', 'growthRate']) {
      assert.ok(Number.isFinite(result.behavior[key]), `${m.id} 行为字段 ${key} 非有限`);
    }
    assert.ok(['spots', 'stripes', 'mixed', 'blank'].includes(result.behavior.pattern));
    const checks = checkModel(m, result);
    const failed = checks.filter((c) => !c.ok);
    assert.equal(failed.length, 0, `${m.id} 检查未通过：${failed.map((c) => `${c.key}=${c.actual}`).join(', ')}`);
  }
});

test('同一模型生命重复复现结果一致', () => {
  for (const id of ['model-gs-spots', 'model-le-stripes']) {
    const m = MODEL_LIVES.find((x) => x.id === id);
    const a = replicate(m);
    const b = replicate(m);
    assert.equal(a.score, b.score, `${id} 分数不稳定`);
    assert.deepEqual(a.features, b.features, `${id} 结构签名不稳定`);
    assert.deepEqual(a.behavior, b.behavior, `${id} 行为指纹不稳定`);
  }
});
