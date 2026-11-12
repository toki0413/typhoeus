// 离线导出：把当前基因组 + 环境渲染成 30 秒立体声 WAV。
// 与 tools/audio-render.cjs 同一套驱动逻辑，但跑在页面里，
// 用 OfflineAudioContext 精确渲染（不受实时掉帧影响）。

import { AudioEngine } from './audio.js';
import { createEngine, computeMetrics } from './engines.js';
import { computeAudioChain } from './physics.js';
import { StructureTracker } from './structures.js';
import * as music2 from './music2.js';

/* 与实时聆听不同的地方：离线没有 Pet 状态，用中性情绪兜底 */
const PET_NEUTRAL = { mood: 'content', energy: 0.6, tension: 0.25 };

function encodeWav(audioBuffer) {
  const L = audioBuffer.getChannelData(0);
  const R = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : L;
  const N = L.length;
  const sr = audioBuffer.sampleRate;
  const bytes = 44 + N * 4;
  const ab = new ArrayBuffer(bytes);
  const dv = new DataView(ab);
  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, 'RIFF'); dv.setUint32(4, bytes - 8, true); wstr(8, 'WAVE');
  wstr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 4, true);
  dv.setUint16(32, 4, true); dv.setUint16(34, 16, true);
  wstr(36, 'data'); dv.setUint32(40, N * 4, true);
  let o = 44;
  for (let i = 0; i < N; i++) {
    dv.setInt16(o, Math.max(-1, Math.min(1, L[i])) * 32767, true); o += 2;
    dv.setInt16(o, Math.max(-1, Math.min(1, R[i])) * 32767, true); o += 2;
  }
  return new Blob([ab], { type: 'audio/wav' });
}

/**
 * @param {object} p
 * @param {object} p.genome   完整 genome（含 mapping.instruments / mapping.mixer）
 * @param {object} p.env      环境参数
 * @param {number} p.rngSeed  随机种子
 * @param {number} p.seconds  时长（秒）
 * @param {number} p.speed    生命加速倍率（每 tick 的仿真步数）
 * @returns {Promise<Blob>}   audio/wav Blob
 */
export async function renderMixdownWav({
  genome, env, rngSeed = 42, seconds = 30, speed = 3, sampleRate = 44100,
}) {
  const Ctor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Ctor) throw new Error('此浏览器不支持离线音频渲染');

  /* 深拷贝：渲染过程会改写 mapping.strictness，不能污染正在播放的生命 */
  const g = JSON.parse(JSON.stringify(genome));
  const off = new Ctor(2, Math.ceil(sampleRate * seconds), sampleRate);

  const sim = createEngine(g, env, rngSeed);
  for (let i = 0; i < 160; i++) sim.step();   // 预热：跳过开局混沌
  const m0 = computeMetrics(sim);

  const eng = new AudioEngine(off, null, { pan: 0 });
  eng.setGenome(g);
  eng.updateMetrics(m0);
  eng.setAudioChain(computeAudioChain(m0, PET_NEUTRAL, null, music2));
  eng.setEnabled(true);

  const tracker = new StructureTracker(sim.w, sim.h, { interval: 4 });
  let nextStep = 0.08;
  let nextMetrics = 0.4;
  for (let t = 0.05; t < seconds; t += 0.05) {
    while (t >= nextStep) {
      for (let k = 0; k < speed; k++) {
        sim.step();
        const sr = tracker.update(sim.grid, t);
        if (sr?.events?.length) {
          for (const evt of sr.events) eng.triggerStructure(evt, t);
        }
      }
      nextStep += 0.08;
    }
    eng.pushBirths(sim.lastBirths, sim.w, sim.h);
    eng.voices = 0;   // 离线没有 onended 回调，手动释放声部计数
    if (t >= nextMetrics) {
      const m2 = computeMetrics(sim);
      eng.updateMetrics(m2);
      eng.setAudioChain(computeAudioChain(m2, PET_NEUTRAL, null, music2));
      nextMetrics += 0.4;
    }
    eng.tick(t);
  }

  const buf = await off.startRendering();
  return encodeWav(buf);
}
