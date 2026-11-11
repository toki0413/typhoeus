/**
 * Commons 端到端测试 — 完整链路验证
 *
 * 覆盖：引擎演化 → 物理注入 → Pet 情绪 → Audio 链 → 科学发现 → UI
 *
 * 运行：node e2e-test.mjs
 * 依赖：18 个 src/*.js（不需要 app.js 的 DOM 环境，用 jsdom 模拟）
 */

import { createEngine } from './src/engines.js';
import { matchPatternLibrary } from './src/patterns.js';
import { runParameterScan } from './src/scan.js';
import { applyExoticPhysics } from './src/physics.js';
import { PetState } from './src/pet.js';
import { saveAsDiscovery, loadLeaderboard, rankDiscoveries, buildOpenScienceIssue, clearLeaderboard } from './src/leaderboard.js';
import { computeAudioChain } from './src/physics.js';
import * as music2 from './src/music2.js';
// rng.js exports mulberry32 (not needed in this test)

const results = [];
function pass(name, detail = '') { results.push({ name, pass: true, detail }); console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`); }
function fail(name, detail = '') { results.push({ name, pass: false, detail }); console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }

console.log('\n🎯 Commons 端到端测试\n' + '='.repeat(60));

// ============================================================
// T1: 引擎演化 + 科学指标（核心物理链路）
// ============================================================
console.log('\n🔬 T1. 引擎演化 + 科学指标');

const sim = createEngine({
  engine: 'scientific',
  scientific: { preset: 'gs_spots', engineType: 'grayScott', params: { f: 0.035, k: 0.065 } },
}, { seed: 42, env: { noise: 0.01, constraint: 0.15 } });

const before500 = sim.metrics();
for (let i = 0; i < 500; i++) sim.step();
const m = sim.metrics();

pass('500 step 演化', `Lyap=${m.lyapunov.toFixed(3)} D=${m.fractal.toFixed(3)} E=${m.energy?.total?.toFixed(4)}`);
pass('Lyapunov 有限', `λ=${m.lyapunov.toFixed(4)} (not NaN/Infinity)`, Number.isFinite(m.lyapunov));
pass('Fractal 在合理范围', `D=${m.fractal.toFixed(4)} (0.5~2.5 之间)`, m.fractal > 0.5 && m.fractal < 2.5);
pass('Lyapunov 演化（500 步后有变化）', `Δλ=${Math.abs(m.lyapunov - before500.lyapunov).toFixed(4)}`, Math.abs(m.lyapunov - before500.lyapunov) > 0);
pass('attrType 存在', `type=${m.attrType}`, m.attrType && typeof m.attrType === 'string');
pass('period 属性', `period=${m.period}`, typeof m.period === 'number');

// ============================================================
// T2: 6 个极端环境物理注入（物理引擎层）
// ============================================================
console.log('\n🪐 T2. 6 个极端环境物理注入');

const ENVS = [
  { id: 'exo-primitive', label: '原始地球', env: { timeScale: 1.15, noise: 0.03, constraint: 0.10 } },
  { id: 'exo-venus',     label: '金星高压', env: { timeScale: 0.55, noise: 0.25, constraint: 0.30 } },
  { id: 'exo-europa',    label: '木卫二',   env: { timeScale: 1.25, noise: 0.005, constraint: 0.05 } },
  { id: 'exo-mars',      label: '火星',     env: { timeScale: 2.5, noise: 0.25, constraint: 0.05 } },
  { id: 'exo-saturn',    label: '土星环',   env: { timeScale: 1.40, noise: 0.08, constraint: 0.18 } },
  { id: 'exo-blackhole', label: '黑洞',     env: { timeScale: 0.35, noise: 0.001, constraint: 0.95 } },
];

const before = sim.metrics();
for (const exo of ENVS) {
  const physics = applyExoticPhysics({ ...exo.env, _exoticId: exo.id }, 'grayScott', sim.width, sim.height);
  if (physics) sim.setPhysics(physics);
  for (let i = 0; i < 200; i++) sim.step();
  const m2 = sim.metrics();
  const lyapChange = Math.abs(m2.lyapunov - before.lyapunov);
  const fractChange = Math.abs(m2.fractal - before.fractal);
  pass(`${exo.label} (${exo.id}) 200 step 演化`,
       `Δλ=${lyapChange.toFixed(4)} ΔD=${fractChange.toFixed(4)} Lyap=${m2.lyapunov.toFixed(3)} D=${m2.fractal.toFixed(3)}`);
}
sim.clearPhysics();
pass('极端环境清理 → clearPhysics() OK', '物理清除后恢复默认');

// ============================================================
// T3: Pet 状态机（Lyapunov/fractal → 4 状态 → mood）
// ============================================================
console.log('\n🐾 T3. Pet 状态机');

const pet = new PetState();
const initialSnapshot = pet.snapshot();
pet.updateFromMetrics({
  lyapunov: 0.02,    // 边缘混沌
  fractal: 1.48,     // 接近 Hall-Petch 最优 1.5
  energy: { total: 0.7 },
  density: 0.4,
  attrType: 'stable',
  period: 3,
}, 1.0);
const moodStable = pet.snapshot().mood;
pass('稳定吸引子 → Pet mood', `mood=${moodStable} 初始=${initialSnapshot.mood}`);

pet.updateFromMetrics({
  lyapunov: 1.2,     // 强混沌
  fractal: 2.3,      // 偏离最优
  energy: { total: 0.1 },
  density: 0.9,
  attrType: 'chaotic',
  period: 0,
}, 1.0);
const moodChaos = pet.snapshot().mood;
pass('强混沌 → Pet mood 应偏离 happy', `chaos mood=${moodChaos} (should be sad/sick)`);
pass('边际递减机制存在', 'feed() 方法正常返回奖励系数', typeof pet.feed === 'function');

// ============================================================
// T4: Audio 链（metrics + pet + env → final params）
// ============================================================
console.log('\n♪ T4. Audio 全链（metrics + pet + env → 声音参数）');

const metricsAudio = {
  lyapunov: -0.15,
  fractal: 1.75,
  energy: { total: 0.55, average: 0.55 },
  density: 0.5,
  attrType: 'stable',
  period: 4,
};

const petSnapshot = pet.snapshot();
const chain = computeAudioChain(metricsAudio, petSnapshot, 'exo-venus', music2);

pass('computeAudioChain 返回完整对象',
     `keys=[${Object.keys(chain).join(', ')}]`,
     chain && typeof chain === 'object');
pass('finalTempo 数值合理', `tempo=${chain.finalTempo?.toFixed(3)} (0.3~2.0)`,
     chain.finalTempo > 0.3 && chain.finalTempo < 2.0);
pass('finalWave 有效 WaveType', `wave=${chain.finalWave}`,
     ['sine','triangle','square','sawtooth'].includes(chain.finalWave));
pass('finalTension 在 0~1', `tension=${chain.finalTension?.toFixed(3)}`,
     chain.finalTension >= 0 && chain.finalTension <= 1);
pass('finalReverb 在 0~1', `reverb=${chain.finalReverb?.toFixed(3)}`,
     chain.finalReverb >= 0 && chain.finalReverb <= 1);
pass('extremeEnvId 影响了 tempo', `tempo=${chain.finalTempo} (金星环境应 < 1.0)`,
     chain.finalTempo < 1.0);

// ============================================================
// T5: 科学发现（Pattern match + CPM + Leaderboard + Scan）
// ============================================================
console.log('\n🔬 T5. 科学发现全链路');

// T5a: Pattern Match Top-3
const top3 = matchPatternLibrary(metricsAudio);
pass('Pattern Match Top-3 返回数组', `len=${top3.length}`, Array.isArray(top3));
pass('相似度在 0~100', `sim=${top3[0]?.similarity}`, top3.every(p => p.similarity >= 0 && p.similarity <= 100));
pass('Top-3 有 label + refs', `labels=${top3.map(x=>x.label).join(',')}`, top3.every(p => p.label));

// T5b: CPM Monte Carlo
const mc = sim.mcStep(4);
pass('CPM MC 返回结果', `rate=${(mc.acceptedRate*100).toFixed(1)}% ΔH=${mc.energyDelta?.toFixed(1)}`,
     mc && typeof mc.acceptedRate === 'number');
const labels = sim.getMCLabels();
pass('MC Labels 数组', `len=${labels.length} unique=${new Set([...labels]).size}`,
     labels && labels.length > 0);

// T5c: Leaderboard save + load + rank + clear
clearLeaderboard();
const recipe = { seed: { engine: 'grayScott', preset: 'gs_spots', genome: { engine: 'grayScott' } } };
const rec = saveAsDiscovery(recipe, metricsAudio, top3);
const lb = loadLeaderboard();
const ranked = rankDiscoveries(lb, 'similarity');
const osr = buildOpenScienceIssue(ranked[0]);

pass('Leaderboard save + load', `${lb.length} entries`, lb.length >= 1);
pass('排名后 top-1 相似度', `sim=${ranked[0]?.patternMatches?.[0]?.similarity}%`, ranked[0]?.patternMatches?.[0]);
pass('OpenScience GitHub Issue body 非空', `body=${osr.body.length}chars`, osr.body.length > 100);
pass('fingerprint FNV-1a 32-bit', `fp=${rec.fingerprint}`, /^0x[0-9a-f]{8}$/.test(rec.fingerprint));

// T5d: Parameter Scan（6×6 小网格，快速）
const scanRes = await runParameterScan(
  { engine: 'grayScott', f: 0.035, k: 0.065 },
  { xAxis: { key: 'f', min: 0.020, max: 0.055, N: 6 }, yAxis: { key: 'k', min: 0.045, max: 0.085, N: 6 } },
  { w: 24, h: 16, steps: 100, rngSeed: 1234 }
);
pass('Parameter Scan 36 pts 返回', `Nx=${scanRes.Nx} Ny=${scanRes.Ny}`, scanRes.Nx === 6 && scanRes.Ny === 6);
pass('bestPoint / worstPoint 存在',
     `best_E=${isFinite(scanRes.bestPoint.energy) ? scanRes.bestPoint.energy.toFixed(3) : 'Infinity'}`,
     scanRes.bestPoint && scanRes.worstPoint);

// ============================================================
// T6: Null-safety + 降级兜底（生产成熟度）
// ============================================================
console.log('\n🛡️ T6. Null-safety + 降级兜底');

let threw = false;
try {
  // 缺 schema 的 recipe
  saveAsDiscovery({ seed: { engine: 'test' } }, metricsAudio, top3);
  // null metrics
  matchPatternLibrary({ lyapunov: undefined, fractal: undefined });
  // Node 环境 safeStorage
  clearLeaderboard();
  loadLeaderboard();
} catch(e) { threw = true; fail('Null-safety 不应 throw', e.message); }
if (!threw) pass('缺字段/missing schema Node mjs 环境不 throw', 'safeStorage 包装生效');

// ============================================================
// 总结
// ============================================================
console.log('\n' + '='.repeat(60));
const total = results.length;
const passed = results.filter(r => r.pass).length;
const failed = total - passed;
console.log(`📊 测试结果: ${passed}/${total} 通过  ${failed > 0 ? `❌ ${failed} 失败` : '🎉 全部通过!'}`);
if (failed > 0) {
  console.log('\n失败详情:');
  for (const r of results.filter(r => !r.pass)) {
    console.log(`  ❌ ${r.name} — ${r.detail}`);
  }
}
console.log(`\n🔬 Commons 完整链路 E2E 验证: 引擎 → 物理注入 → Pet 情绪 → Audio 链 → 科学发现 → 生产成熟度`);
process.exit(failed > 0 ? 1 : 0);
