/* 音频渲染与验证工具（需要 Chrome + puppeteer-core）
 *
 * 用法：
 *   npm run audio:render          # 30s 离线渲染 → WAV / 频谱图 / 钢琴卷帘 / 对照图
 *   npm run audio:check <url>     # 真实浏览器点「♪ 聆听」，检查运行时错误
 *
 * 环境变量：
 *   CHROME_PATH   Chrome for Testing 可执行文件路径
 *   APP_URL       本地服务地址（默认 http://127.0.0.1:4200）
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.CHROME_PATH
  || '/root/.cache/puppeteer/chrome/linux-155.0.8059.39/chrome-linux64/chrome';
const BASE = process.env.APP_URL || process.argv[2] || 'http://127.0.0.1:4200';
const OUT = path.resolve(__dirname, '../..');   // /workspace

(async () => {
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

    const SR = 44100, DUR = 30, SPEED = 3;
    const genome = defaultGenome('life', 'conway');
    const env = { pattern: 'soup', boundary: 'torus', noise: 0.03, constraint: 0.2, timeScale: SPEED };
    const sim = createEngine(genome, env, 42);
    for (let i = 0; i < 200; i++) sim.step();
    const m0 = computeMetrics(sim);
    const pet = { mood: 'content', energy: 0.6, tension: 0.25 };

    const off = new OfflineAudioContext(2, SR * DUR, SR);
    const notes = [];
    const BC = Object.getPrototypeOf(off);
    const origOsc = BC.createOscillator;
    BC.createOscillator = function () {
      const o = origOsc.call(this);
      let lastF = null;
      const svt = o.frequency.setValueAtTime.bind(o.frequency);
      o.frequency.setValueAtTime = (v, t) => { if (Number.isFinite(v) && v >= 20) lastF = v; return svt(v, t); };
      const st = o.start.bind(o);
      o.start = (t) => {
        const hz = lastF ?? o.frequency.value;
        if (Number.isFinite(hz) && hz >= 20) notes.push({ t: +(t || 0).toFixed(3), hz: Math.round(hz * 10) / 10, type: o.type });
        return st(t);
      };
      return o;
    };

    const eng = new AudioEngine(off, null, { pan: 0 });
    eng.setGenome(genome);
    eng.updateMetrics(m0);
    eng.setAudioChain(computeAudioChain(m0, pet, null, music2));
    eng.setEnabled(true);

    const tracker = new StructureTracker(sim.w, sim.h, { interval: 4 });
    const structEvents = [];
    const metricLog = [];
    let nextStep = 0.08, nextMetrics = 0.4, nextLog = 0;
    for (let t = 0.05; t < DUR; t += 0.05) {
      while (t >= nextStep) {
        for (let k = 0; k < SPEED; k++) {
          sim.step();
          const sr = tracker.update(sim.grid, t);
          if (sr && sr.events.length) {
            for (const evt of sr.events) {
              structEvents.push({ t: +t.toFixed(2), type: evt.type, count: evt.count });
              eng.triggerStructure(evt, t);
            }
          }
        }
        nextStep += 0.08;
      }
      eng.pushBirths(sim.lastBirths, sim.w, sim.h);
      eng.voices = 0;   // 离线无 onended，模拟实时释放
      if (t >= nextMetrics) {
        const m2 = computeMetrics(sim);
        eng.updateMetrics(m2);
        eng.setAudioChain(computeAudioChain(m2, pet, null, music2));
        nextMetrics += 0.4;
      }
      if (t >= nextLog) {
        const mm = computeMetrics(sim);
        metricLog.push({ t: +t.toFixed(2), density: +mm.density.toFixed(4), activity: +mm.activity.toFixed(3), intensity: +eng._intensity.toFixed(3) });
        nextLog += 0.5;
      }
      eng.tick(t);
    }
    const buf = await off.startRendering();

    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    const N = L.length;
    const mono = new Float32Array(N);
    let peak = 0, sumSq = 0, clip = 0, diffSq = 0, sumPair = 0;
    for (let i = 0; i < N; i++) {
      const l = L[i], r = R[i];
      mono[i] = (l + r) / 2;
      const a = Math.max(Math.abs(l), Math.abs(r));
      if (a > peak) peak = a;
      if (a >= 0.999) clip++;
      sumSq += (l * l + r * r) / 2;
      diffSq += (l - r) * (l - r); sumPair += (l + r) * (l + r);
    }
    const rms = Math.sqrt(sumSq / N);
    const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

    /* FFT */
    function fft(re, im) {
      const n = re.length;
      for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
      }
      for (let len = 2; len <= n; len <<= 1) {
        const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
          let cr = 1, ci = 0;
          for (let k = 0; k < len / 2; k++) {
            const ur = re[i + k], ui = im[i + k];
            const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
            const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
            re[i + k] = ur + vr; im[i + k] = ui + vi;
            re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
            const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
          }
        }
      }
    }
    const FFT_N = 2048, HOP = 1024;
    const hann = new Float32Array(FFT_N);
    for (let i = 0; i < FFT_N; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FFT_N - 1));
    const frames = [];
    for (let s = 0; s + FFT_N <= N; s += HOP) {
      const re = new Float32Array(FFT_N), im = new Float32Array(FFT_N);
      for (let i = 0; i < FFT_N; i++) re[i] = mono[s + i] * hann[i];
      fft(re, im);
      const mags = new Float32Array(FFT_N / 2);
      let num = 0, den = 0;
      for (let k = 0; k < FFT_N / 2; k++) {
        mags[k] = Math.hypot(re[k], im[k]) / (FFT_N / 4);
        const f = k * SR / FFT_N;
        num += f * mags[k]; den += mags[k];
      }
      frames.push({ t: s / SR, mags, centroid: den > 1e-9 ? num / den : 0 });
    }

    const SW = 1180, PAD_L = 60, PAD_R = 20, PAD_T = 30;
    const plotW = SW - PAD_L - PAD_R;
    const xOf = (t, w = plotW) => PAD_L + (t / DUR) * w;

    /* 频谱图 */
    const SH = 420, PAD_B = 56, plotH = SH - PAD_T - PAD_B, FMIN = 30, FMAX = 8000;
    const cv = document.createElement('canvas'); cv.width = SW; cv.height = SH;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#070a12'; ctx.fillRect(0, 0, SW, SH);
    const img = ctx.createImageData(plotW, plotH);
    for (let px = 0; px < plotW; px++) {
      const fr = frames[Math.min(frames.length - 1, Math.floor(px / plotW * frames.length))];
      for (let py = 0; py < plotH; py++) {
        const f = FMIN * Math.pow(FMAX / FMIN, 1 - py / plotH);
        const bin = Math.max(1, Math.min(fr.mags.length - 1, Math.round(f * FFT_N / SR)));
        const d = 20 * Math.log10((fr.mags[bin] || 0) + 1e-9);
        const t = Math.max(0, Math.min(1, (d + 78) / 60));
        const r = Math.round(255 * Math.min(1, 1.6 * t));
        const g = Math.round(255 * Math.max(0, Math.pow(t, 1.4) * 1.05 - 0.12));
        const b = Math.round(255 * Math.max(0, 0.85 - Math.abs(t - 0.28) * 1.5) * 0.85);
        const idx = (py * plotW + px) * 4;
        img.data[idx] = r; img.data[idx + 1] = g; img.data[idx + 2] = b; img.data[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, PAD_L, PAD_T);
    ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.strokeRect(PAD_L, PAD_T, plotW, plotH);
    ctx.font = '11px ui-monospace, monospace';
    for (const f of [50, 100, 200, 500, 1000, 2000, 4000, 8000]) {
      const y = PAD_T + plotH - (Math.log(f / FMIN) / Math.log(FMAX / FMIN)) * plotH;
      ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(PAD_L + plotW, y); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.textAlign = 'right';
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : String(f), PAD_L - 8, y + 4);
    }
    for (let t = 0; t <= DUR; t += 5) {
      const x = xOf(t);
      ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.beginPath(); ctx.moveTo(x, PAD_T); ctx.lineTo(x, PAD_T + plotH); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.textAlign = 'center';
      ctx.fillText(`${t}s`, x, SH - 32);
    }
    ctx.textAlign = 'left'; ctx.fillStyle = '#f0e9ff'; ctx.font = 'bold 13px ui-sans-serif, system-ui';
    ctx.fillText('频谱图（30s，生命 3× 速度）· 30Hz–8kHz 对数', PAD_L, 18);
    ctx.font = '11px ui-monospace, monospace'; ctx.fillStyle = 'rgba(255,255,255,.55)';
    ctx.fillText('亮黄=低音/心跳 · 细横线=旋律与和弦泛音 · 竖向条纹=心跳脉冲', PAD_L, SH - 8);
    const spectrogram = cv.toDataURL('image/png');

    /* 钢琴卷帘 */
    const PH = 420;
    const pc = document.createElement('canvas'); pc.width = SW; pc.height = PH;
    const pctx = pc.getContext('2d');
    pctx.fillStyle = '#070a12'; pctx.fillRect(0, 0, SW, PH);
    const pH = PH - PAD_T - PAD_B;
    const pY = (f) => PAD_T + pH - (Math.log(f / 30) / Math.log(8000 / 30)) * pH;
    pctx.strokeStyle = 'rgba(255,255,255,.18)'; pctx.strokeRect(PAD_L, PAD_T, plotW, pH);
    pctx.font = '11px ui-monospace, monospace';
    for (const f of [50, 100, 200, 500, 1000, 2000, 4000]) {
      const y = pY(f);
      pctx.strokeStyle = 'rgba(255,255,255,.08)'; pctx.beginPath(); pctx.moveTo(PAD_L, y); pctx.lineTo(PAD_L + plotW, y); pctx.stroke();
      pctx.fillStyle = 'rgba(255,255,255,.7)'; pctx.textAlign = 'right';
      pctx.fillText(f >= 1000 ? `${f / 1000}k` : String(f), PAD_L - 8, y + 4);
    }
    for (let t = 0; t <= DUR; t += 5) {
      const x = xOf(t);
      pctx.strokeStyle = 'rgba(255,255,255,.08)'; pctx.beginPath(); pctx.moveTo(x, PAD_T); pctx.lineTo(x, PAD_T + pH); pctx.stroke();
      pctx.fillStyle = 'rgba(255,255,255,.7)'; pctx.textAlign = 'center';
      pctx.fillText(`${t}s`, x, PH - 32);
    }
    const colorOf = { sine: '#66d9ff', triangle: '#ffb347', sawtooth: '#c39bff', square: '#ff7a9c' };
    for (const n of notes) {
      pctx.fillStyle = colorOf[n.type] || '#9be7a8';
      pctx.beginPath(); pctx.arc(xOf(n.t), pY(n.hz), 1.6, 0, Math.PI * 2); pctx.fill();
    }
    pctx.fillStyle = '#f0e9ff'; pctx.font = 'bold 13px ui-sans-serif, system-ui'; pctx.textAlign = 'left';
    pctx.fillText('钢琴卷帘（30s）· 每个点=一次发声', PAD_L, 18);
    pctx.font = '11px ui-monospace, monospace'; pctx.fillStyle = 'rgba(255,255,255,.55)';
    pctx.fillText('蓝=sine 旋律/心跳/微光 · 橙=triangle 和弦/琶音 · 看中段是否换句、换音区', PAD_L, PH - 8);
    const pianoRoll = pc.toDataURL('image/png');

    /* 对照图 */
    const DH = 560;
    const dc = document.createElement('canvas'); dc.width = SW; dc.height = DH;
    const dctx = dc.getContext('2d');
    dctx.fillStyle = '#070a12'; dctx.fillRect(0, 0, SW, DH);
    const topY = 46, topH = 200, botY = 330, botH = 170;
    const plotX = PAD_L + 10, plotW2 = SW - plotX - 90;
    const x2 = (t) => plotX + (t / DUR) * plotW2;
    const drawLine = (arr, yOf, color) => {
      dctx.strokeStyle = color; dctx.lineWidth = 2; dctx.beginPath();
      arr.forEach((p, i) => { const xx = x2(p.t), yy = yOf(p.v); i ? dctx.lineTo(xx, yy) : dctx.moveTo(xx, yy); });
      dctx.stroke();
    };
    const yDensity = (v) => topY + topH - (v / 0.12) * topH;
    const yUnit = (v) => topY + topH - v * topH;
    drawLine(metricLog.map((m) => ({ t: m.t, v: m.density })), yDensity, '#7cffb2');
    drawLine(metricLog.map((m) => ({ t: m.t, v: m.activity })), yUnit, '#ffc46b');
    drawLine(metricLog.map((m) => ({ t: m.t, v: m.intensity })), yUnit, '#ff7a9c');
    dctx.strokeStyle = 'rgba(255,255,255,.18)'; dctx.strokeRect(plotX, topY, plotW2, topH);
    dctx.fillStyle = '#f0e9ff'; dctx.font = 'bold 13px ui-sans-serif, system-ui';
    dctx.fillText('生命指标（上）与音乐特征（下）—— 30 秒', PAD_L, 22);
    dctx.font = '11px ui-monospace, monospace';
    const dMin = Math.min(...metricLog.map((m) => m.density)), dMax = Math.max(...metricLog.map((m) => m.density));
    dctx.fillStyle = '#7cffb2'; dctx.fillText(`密度 ${(dMin * 100).toFixed(1)}–${(dMax * 100).toFixed(1)}%`, plotX + 6, topY + 14);
    dctx.fillStyle = '#ffc46b'; dctx.fillText('活跃度', plotX + 160, topY + 14);
    dctx.fillStyle = '#ff7a9c'; dctx.fillText('编曲强度', plotX + 240, topY + 14);

    const secNotes = [];
    for (let s = 0; s < DUR; s++) secNotes.push(notes.filter((n) => n.t >= s && n.t < s + 1).length);
    const maxNotes = Math.max(...secNotes, 1);
    for (let s = 0; s < DUR; s++) {
      const h = (secNotes[s] / maxNotes) * botH;
      dctx.fillStyle = 'rgba(90,190,255,.35)';
      dctx.fillRect(x2(s) + 2, botY + botH - h, Math.max(2, (plotW2 / DUR) - 4), h);
    }
    const rmsSec = [];
    for (let s = 0; s < DUR; s++) {
      let sum = 0, cnt = 0;
      for (let i = s * SR; i < Math.min(N, (s + 1) * SR); i++) { sum += mono[i] * mono[i]; cnt++; }
      rmsSec.push({ t: s + 0.5, v: db(Math.sqrt(sum / Math.max(1, cnt))) });
    }
    drawLine(rmsSec, (v) => botY + botH - ((v + 45) / 45) * botH, '#ffc46b');
    const centSec = [];
    for (let s = 0; s < DUR; s++) {
      const fs = frames.filter((f) => f.t >= s && f.t < s + 1);
      centSec.push({ t: s + 0.5, v: fs.reduce((a, f) => a + f.centroid, 0) / Math.max(1, fs.length) });
    }
    drawLine(centSec, (v) => botY + botH - Math.min(1, v / 2500) * botH, '#c39bff');
    dctx.strokeStyle = 'rgba(255,255,255,.18)'; dctx.strokeRect(plotX, botY, plotW2, botH);

    const evColor = { glider: '#7cffb2', oscillator: '#57d8ff', still: '#c39bff', merge: '#ffc46b', split: '#ff7a9c', birthSurge: '#9be7a8', deathSurge: '#ff9a9a' };
    for (const e of structEvents) {
      const xx = x2(e.t);
      dctx.fillStyle = evColor[e.type] || '#fff';
      dctx.beginPath(); dctx.moveTo(xx, botY - 3); dctx.lineTo(xx - 3.5, botY - 10); dctx.lineTo(xx + 3.5, botY - 10);
      dctx.closePath(); dctx.fill();
    }
    for (let t = 0; t <= DUR; t += 5) {
      dctx.fillStyle = 'rgba(255,255,255,.55)'; dctx.textAlign = 'center';
      dctx.fillText(`${t}s`, x2(t), botY + botH + 18);
    }
    dctx.textAlign = 'left'; dctx.font = '11px ui-monospace, monospace';
    dctx.fillStyle = 'rgba(90,190,255,.8)'; dctx.fillText('每秒音符数', plotX + 6, botY + 14);
    dctx.fillStyle = '#ffc46b'; dctx.fillText('响度 RMS', plotX + 110, botY + 14);
    dctx.fillStyle = '#c39bff'; dctx.fillText('频谱重心', plotX + 190, botY + 14);
    dctx.fillStyle = 'rgba(255,255,255,.55)';
    dctx.fillText('▲ 结构动机：绿=滑翔机 · 蓝=振荡器 · 紫=静止块', plotX, DH - 8);
    const dashboard = dc.toDataURL('image/png');

    /* WAV */
    const bytes = 44 + N * 4;
    const ab = new ArrayBuffer(bytes);
    const dv = new DataView(ab);
    const wstr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    wstr(0, 'RIFF'); dv.setUint32(4, bytes - 8, true); wstr(8, 'WAVE');
    wstr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);
    dv.setUint32(24, SR, true); dv.setUint32(28, SR * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true);
    wstr(36, 'data'); dv.setUint32(40, N * 4, true);
    let o = 44;
    for (let i = 0; i < N; i++) {
      dv.setInt16(o, Math.max(-1, Math.min(1, L[i])) * 32767, true); o += 2;
      dv.setInt16(o, Math.max(-1, Math.min(1, R[i])) * 32767, true); o += 2;
    }
    let bin = '';
    const u8 = new Uint8Array(ab);
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    const wav = btoa(bin);

    const types = {};
    for (const n of notes) types[n.type] = (types[n.type] || 0) + 1;
    const sc = {};
    for (const e of structEvents) sc[e.type] = (sc[e.type] || 0) + 1;
    return {
      analysis: {
        duration: DUR, notes: notes.length, noteTypes: types,
        pitchRange: [Math.min(...notes.map((n) => n.hz)), Math.max(...notes.map((n) => n.hz))],
        peakDb: +db(peak).toFixed(1), rmsDb: +db(rms).toFixed(1), clip,
        stereoWidth: +Math.sqrt(diffSq / (sumPair || 1)).toFixed(3),
        secNotes, centroidRange: [Math.round(Math.min(...centSec.map((p) => p.v))), Math.round(Math.max(...centSec.map((p) => p.v)))],
        structureCounts: sc,
        structureEvents: structEvents.map((e) => ({ t: e.t, type: e.type })),
        densityRange: [dMin, dMax],
      },
      wav, spectrogram, pianoRoll, dashboard,
    };
  });

  const save = (name, b64) => fs.writeFileSync(path.join(OUT, name), Buffer.from(b64.split(',').pop(), 'base64'));
  save('commons-audio-preview.wav', out.wav);
  save('commons-audio-spectrogram.png', out.spectrogram);
  save('commons-audio-notes.png', out.pianoRoll);
  save('commons-audio-dashboard.png', out.dashboard);
  console.log(JSON.stringify({ analysis: out.analysis, errors }, null, 2));
  await browser.close();
})().catch((e) => { console.error('AUDIO_RENDER_FAIL', e); process.exit(1); });
