import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  artifacts,
  ensureArtifacts,
  launchBrowser,
  openApp,
  report,
  startServer,
} from './browser-harness.mjs';

const server = await startServer(5200);
const { browser, page, errors } = await launchBrowser();
const checks = [];
let failed = false;

const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function peakLevel() {
  let peak = 0;
  for (let i = 0; i < 8; i += 1) {
    const value = await page.evaluate(() => window.__gh?.audio.level() ?? 0);
    peak = Math.max(peak, value);
    await sleep(100);
  }
  return peak;
}

try {
  ensureArtifacts();
  await openApp(page, server.url);
  const startDisabled = await page.evaluate(
    () => document.querySelector('[data-action="start"]')?.disabled ?? true
  );
  check('WebGL 可用', startDisabled === false);

  if (startDisabled !== false) throw new Error('WebGL 不可用，无法启动音频场景');

  await page.click('[data-action="start"]');
  await page.waitForFunction(() => document.body.dataset.run === 'playing', { timeout: 10000 });
  await sleep(1200);

  const openPeak = await peakLevel();
  check('音频引擎有输出电平', openPeak > 0.0005, `peak RMS ${openPeak.toFixed(4)}`);

  const recording = await page.evaluate(() => {
    const stream = window.__gh.audio.record();
    if (!stream || typeof MediaRecorder === 'undefined') {
      return { ok: false, reason: 'MediaRecorder 或 MediaStreamDestination 不可用' };
    }
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';
    const recorder = new MediaRecorder(stream, { mimeType: mime });
    const chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.start(200);
    window.__rec = { recorder, chunks, mime };
    return { ok: true, mime, tracks: stream.getAudioTracks().length };
  });
  check('开始录音输出', recording.ok === true, recording.reason ?? recording.mime);
  if (!recording.ok) throw new Error(recording.reason);

  // 让环境声、无线电、心跳、受伤与门轴都有机会进入录音。
  await sleep(2200);
  await page.keyboard.press('t');
  await sleep(900);
  await page.keyboard.press('t');
  await sleep(1200);

  const doorVisible = await page.evaluate(() => {
    const panel = document.getElementById('door-ui');
    const open = document.querySelector('[data-act="open"]');
    return Boolean(panel && open && getComputedStyle(panel).display !== 'none');
  });
  if (doorVisible) {
    await page.click('[data-act="open"]');
    await sleep(1400);
  }

  const duringPeak = await peakLevel();
  check('录音期间仍有输出电平', duringPeak > 0.0005, `peak RMS ${duringPeak.toFixed(4)}`);

  const captured = await page.evaluate(async () => {
    const { recorder, chunks, mime } = window.__rec;
    await new Promise((resolve) => {
      recorder.onstop = resolve;
      recorder.stop();
    });
    const blob = new Blob(chunks, { type: mime });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode(...bytes.subarray(i, i + step));
    }
    return { base64: btoa(binary), size: bytes.length, mime };
  });

  const webm = join(artifacts, 'session.webm');
  const wav = join(artifacts, 'session.wav');
  writeFileSync(webm, Buffer.from(captured.base64, 'base64'));
  check('录音文件已生成', captured.size > 4096, `${(captured.size / 1024).toFixed(1)} KB`);

  const convert = spawnSync('ffmpeg', ['-y', '-i', webm, '-ac', '1', '-ar', '44100', wav], {
    encoding: 'utf8',
  });
  check('可解码为 WAV', convert.status === 0 && !convert.error);

  const probe = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', wav],
    { encoding: 'utf8' }
  );
  const duration = Number(probe.stdout.trim());
  check('录音包含有效时长', Number.isFinite(duration) && duration > 2, `${duration.toFixed(2)}s`);

  const volume = spawnSync(
    'ffmpeg',
    ['-i', wav, '-af', 'volumedetect', '-f', 'null', '-'],
    { encoding: 'utf8' }
  );
  const maxMatch = /max_volume:\s*(-?[\d.]+) dB/.exec(volume.stderr);
  const meanMatch = /mean_volume:\s*(-?[\d.]+) dB/.exec(volume.stderr);
  const maxVolume = maxMatch ? Number(maxMatch[1]) : -Infinity;
  const meanVolume = meanMatch ? Number(meanMatch[1]) : -Infinity;
  check(
    '录音不是静音',
    Number.isFinite(maxVolume) && maxVolume > -40,
    `max ${maxVolume} dB / mean ${meanVolume} dB`
  );

  spawnSync(
    'ffmpeg',
    [
      '-y',
      '-i',
      wav,
      '-filter_complex',
      'showwavespic=s=1200x300:colors=#e5b567',
      '-frames:v',
      '1',
      join(artifacts, 'audio-wave.png'),
    ],
    { encoding: 'utf8' }
  );
  spawnSync(
    'ffmpeg',
    [
      '-y',
      '-i',
      wav,
      '-lavfi',
      'showspectrumpic=s=1200x400:legend=1',
      '-frames:v',
      '1',
      join(artifacts, 'audio-spectrum.png'),
    ],
    { encoding: 'utf8' }
  );

  check('无页面级异常', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (error) {
  failed = true;
  console.error(`FAIL  验证中断 — ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await browser.close();
  server.stop();
}

report('音频验证', checks.map((item) => `${item.ok ? 'PASS' : 'FAIL'}  ${item.name}`));
process.exit(failed ? 1 : 0);
