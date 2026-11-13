/* 生成“声音对照包”的三段音频。
 *
 * 用法：
 *   node tools/audio-pack.cjs [baseUrl]
 *
 * 产物（/workspace/commons-materials/sound）：
 *   01-binaural-same-seed.wav   同一颗种子，两个环境，左/右耳
 *   02-mutation-before-after.wav 同一环境，Conway → HighLife
 *   03-mapping-and-events.wav   指标到声音的完整混音（沿用 30s 预览）
 *
 * 全部由页面里的 AudioEngine 离线渲染，不是另外合成的“配乐”。
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.CHROME_PATH
  || '/root/.cache/puppeteer/chrome/linux-155.0.8059.39/chrome-linux64/chrome';
const BASE = process.env.APP_URL || process.argv[2] || 'http://127.0.0.1:4200';
const OUT = path.resolve(__dirname, '../../commons-materials/sound');

function wavFromBase64(b64, name) {
  fs.writeFileSync(path.join(OUT, name), Buffer.from(b64.split(',').pop(), 'base64'));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE + '/index.html', { waitUntil: 'load', timeout: 30000 });

  const out = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio.js');
    const { defaultGenome, createEngine, computeMetrics } = await import('/src/engines.js');
    const { computeAudioChain } = await import('/src/physics.js');
    const { StructureTracker } = await import('/src/structures.js');
    const music2 = await import('/src/music2.js');

    const SR = 44100;
    const SPEED = 3;
    const pet = { mood: 'content', energy: 0.6, tension: 0.25 };

    function makeSim(genome, env, seed) {
      const sim = createEngine(genome, env, seed);
      for (let i = 0; i < 200; i++) sim.step();
      return sim;
    }

    function encodeWav(L, R, sr = SR) {
      const N = L.length;
      const bytes = 44 + N * 4;
      const ab = new ArrayBuffer(bytes);
      const dv = new DataView(ab);
      const wstr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
      wstr(0, 'RIFF'); dv.setUint32(4, bytes - 8, true); wstr(8, 'WAVE');
      wstr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);
      dv.setUint32(24, sr, true); dv.setUint32(28, sr * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true);
      wstr(36, 'data'); dv.setUint32(40, N * 4, true);
      let o = 44;
      for (let i = 0; i < N; i++) {
        dv.setInt16(o, Math.max(-1, Math.min(1, L[i])) * 32767, true); o += 2;
        dv.setInt16(o, Math.max(-1, Math.min(1, R[i])) * 32767, true); o += 2;
      }
      const u8 = new Uint8Array(ab);
      let bin = '';
      for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      return btoa(bin);
    }

    function trackEngine(eng, sim, tracker, t, state) {
      while (t >= state.nextStep) {
        for (let k = 0; k < SPEED; k++) {
          sim.step();
          const sr = tracker.update(sim.grid, t);
          if (sr && sr.events.length) {
            for (const evt of sr.events) eng.triggerStructure(evt, t);
          }
        }
        state.nextStep += 0.08;
      }
      eng.pushBirths(sim.lastBirths, sim.w, sim.h);
      eng.voices = 0;
      if (t >= state.nextMetrics) {
        const m = computeMetrics(sim);
        eng.updateMetrics(m);
        eng.setAudioChain(computeAudioChain(m, pet, null, music2));
        state.nextMetrics += 0.4;
      }
      eng.tick(t);
    }

    async function renderTrack({ genome, env, seed, dur, pan = 0 }) {
      const sim = makeSim(genome, env, seed);
      const off = new OfflineAudioContext(2, SR * dur, SR);
      const eng = new AudioEngine(off, off.destination, { pan });
      eng.setGenome(genome);
      eng.updateMetrics(computeMetrics(sim));
      eng.setAudioChain(computeAudioChain(computeMetrics(sim), pet, null, music2));
      eng.setEnabled(true);
      const tracker = new StructureTracker(sim.w, sim.h, { interval: 4 });
      const state = { nextStep: 0.08, nextMetrics: 0.4 };
      for (let t = 0.05; t < dur; t += 0.05) trackEngine(eng, sim, tracker, t, state);
      const buf = await off.startRendering();
      return { L: buf.getChannelData(0), R: buf.getChannelData(1) };
    }

    async function renderBinaural({ genome, envL, envR, seed, dur }) {
      const simL = makeSim(genome, envL, seed);
      const simR = makeSim(genome, envR, seed);
      const off = new OfflineAudioContext(2, SR * dur, SR);
      const engL = new AudioEngine(off, off.destination, { pan: -0.92 });
      const engR = new AudioEngine(off, off.destination, { pan: 0.92 });
      for (const [eng, sim] of [[engL, simL], [engR, simR]]) {
        eng.setGenome(genome);
        eng.updateMetrics(computeMetrics(sim));
        eng.setAudioChain(computeAudioChain(computeMetrics(sim), pet, null, music2));
        eng.setEnabled(true);
      }
      const trL = new StructureTracker(simL.w, simL.h, { interval: 4 });
      const trR = new StructureTracker(simR.w, simR.h, { interval: 4 });
      const stL = { nextStep: 0.08, nextMetrics: 0.4 };
      const stR = { nextStep: 0.08, nextMetrics: 0.4 };
      for (let t = 0.05; t < dur; t += 0.05) {
        trackEngine(engL, simL, trL, t, stL);
        trackEngine(engR, simR, trR, t, stR);
      }
      const buf = await off.startRendering();
      return { L: buf.getChannelData(0), R: buf.getChannelData(1) };
    }

    function concat(A, B, fade = 0.4) {
      const n = A.L.length + B.L.length - Math.round(fade * SR);
      const L = new Float32Array(n);
      const R = new Float32Array(n);
      L.set(A.L); R.set(A.R);
      const off = A.L.length - Math.round(fade * SR);
      for (let i = 0; i < B.L.length; i++) {
        const k = off + i;
        if (k < 0 || k >= n) continue;
        const w = i < fade * SR ? i / (fade * SR) : 1;
        L[k] = L[k] * (1 - w) + B.L[i] * w;
        R[k] = R[k] * (1 - w) + B.R[i] * w;
      }
      return { L, R };
    }

    const genome = defaultGenome('life', 'conway');
    const high = defaultGenome('life', 'highlife');
    const envSoup = { pattern: 'soup', boundary: 'torus', noise: 0.03, constraint: 0.2, timeScale: SPEED };
    const envGlider = { pattern: 'glider', boundary: 'torus', noise: 0.03, constraint: 0.2, timeScale: SPEED };

    const binaural = await renderBinaural({
      genome, envL: envSoup, envR: envGlider, seed: 42, dur: 30,
    });
    const before = await renderTrack({ genome, env: envSoup, seed: 42, dur: 15, pan: 0 });
    const after = await renderTrack({ genome: high, env: envSoup, seed: 42, dur: 15, pan: 0 });
    const mutation = concat(before, after, 0.5);

    return {
      binaural: encodeWav(binaural.L, binaural.R),
      mutation: encodeWav(mutation.L, mutation.R),
      meta: {
        binaural: { dur: 30, envL: envSoup, envR: envGlider, seed: 42 },
        mutation: { dur: 30, before: 'conway', after: 'highlife', env: envSoup, seed: 42 },
      },
    };
  });

  wavFromBase64(out.binaural, '01-binaural-same-seed.wav');
  wavFromBase64(out.mutation, '02-mutation-before-after.wav');
  const mapping = path.resolve(__dirname, '../../commons-audio-preview.wav');
  if (fs.existsSync(mapping)) {
    fs.copyFileSync(mapping, path.join(OUT, '03-mapping-and-events.wav'));
  }
  fs.writeFileSync(path.join(OUT, 'render-meta.json'), JSON.stringify(out.meta, null, 2));
  console.log(JSON.stringify({ ...out.meta, errors: out.errors }, null, 2));
  await browser.close();
})().catch((e) => { console.error('AUDIO_PACK_FAIL', e); process.exit(1); });
