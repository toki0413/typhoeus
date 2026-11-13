/**
 * 录制 Commons 公网演示视频（无配音，带屏幕字幕）
 *
 * 用 puppeteer-core 打开公开站点，按脚本操作，并以固定间隔截图；
 * 截图序列交给 ffmpeg 合成 MP4，音频轨由 tools/audio-render.cjs 离线生成。
 *
 * 用法：
 *   node tools/record-demo.mjs
 *   CHROME_PATH=... APP_URL=https://... node tools/record-demo.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(HERE, '..', '..', 'commons-demo-frames');
const CHROME = process.env.CHROME_PATH
  || '/root/.cache/puppeteer/chrome/linux-155.0.8059.39/chrome-linux64/chrome';
const APP_URL = process.env.APP_URL || 'https://37jalf2ykndtrfn6iou.traesite.cn';
const FPS_MS = Number(process.env.FPS_MS || 260);

fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1440,900',
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.error('[console]', m.text());
});

await page.goto(APP_URL, { waitUntil: 'networkidle2', timeout: 60000 });
await sleep(1200);

/* 字幕与片尾卡：直接画进页面，截图时一起被录下 */
await page.evaluate(() => {
  const style = document.createElement('style');
  style.textContent = `
    #demoCaption {
      position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%);
      z-index: 99999; pointer-events: none;
      background: rgba(18, 16, 22, .84); color: #fff;
      padding: 11px 20px; border-radius: 999px;
      font: 600 18px/1.4 "PingFang SC", "Microsoft YaHei", -apple-system, sans-serif;
      letter-spacing: .02em; box-shadow: 0 10px 34px rgba(0,0,0,.28);
      backdrop-filter: blur(8px); max-width: 82vw; text-align: center;
      opacity: 0; transition: opacity .18s ease;
    }
    #demoCaption.show { opacity: 1; }
    #demoEnd {
      position: fixed; inset: 0; z-index: 100000; display: flex;
      align-items: center; justify-content: center; flex-direction: column;
      background: radial-gradient(circle at 50% 35%, #2a1b2a 0%, #120f16 70%);
      color: #fff; font-family: "PingFang SC", "Microsoft YaHei", sans-serif;
      opacity: 0; pointer-events: none;
    }
    #demoEnd.show { opacity: 1; }
    #demoEnd h1 { font-size: 42px; margin: 0 0 14px; letter-spacing: .04em; }
    #demoEnd p { font-size: 20px; opacity: .8; margin: 0 0 10px; }
    #demoEnd code { margin-top: 18px; font-size: 18px; color: #ffb3cc; }
  `;
  document.head.appendChild(style);
  const cap = document.createElement('div');
  cap.id = 'demoCaption';
  document.body.appendChild(cap);
  window.__demoCaption = (text) => {
    const el = document.getElementById('demoCaption');
    if (!el) return;
    if (!text) { el.classList.remove('show'); return; }
    el.textContent = text;
    el.classList.add('show');
  };
  window.__demoEnd = (url) => {
    let el = document.getElementById('demoEnd');
    if (!el) {
      el = document.createElement('div');
      el.id = 'demoEnd';
      el.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:100000', 'display:flex',
        'align-items:center', 'justify-content:center', 'flex-direction:column',
        'background:#120f16', 'color:#fff', 'font-family:"PingFang SC","Microsoft YaHei",sans-serif',
        'opacity:0', 'pointer-events:none',
      ].join(';');
      el.innerHTML = `<h1 style="font-size:42px;margin:0 0 14px;letter-spacing:.04em">Commons 公地</h1>
        <p style="font-size:20px;opacity:.8;margin:0 0 10px">让人工生命的涌现可见、可听、可比较</p>
        <code style="margin-top:18px;font-size:19px;color:#ffb3cc">评委入口：${url}</code>
        <p style="opacity:.55;font-size:16px;margin-top:18px">无需登录 · 建议桌面 Chrome / Edge · 戴耳机体验双耳对比</p>`;
      document.body.appendChild(el);
    }
    el.style.opacity = '1';
  };
});

async function caption(text) {
  try {
    await page.evaluate((t) => window.__demoCaption(t), text);
  } catch (_) { /* 页面切换期间忽略 */ }
}

async function safeClick(selector) {
  try {
    await page.waitForSelector(selector, { visible: true, timeout: 3000 });
    await page.click(selector);
    return true;
  } catch (_) {
    return page.evaluate((s) => {
      const el = document.querySelector(s);
      if (el) { el.click(); return true; }
      return false;
    }, selector);
  }
}

async function sleepUntil(start, sec) {
  const wait = start + sec * 1000 - Date.now();
  if (wait > 0) await sleep(wait);
}

const frames = [];
let recording = true;
const start = Date.now();

const captureLoop = (async () => {
  while (recording) {
    const t = Date.now();
    const file = path.join(OUT_DIR, `frame-${String(frames.length + 1).padStart(5, '0')}.jpg`);
    try {
      const buf = await page.screenshot({ type: 'jpeg', quality: 86 });
      fs.writeFileSync(file, buf);
      frames.push({ file, t });
    } catch (err) {
      console.error('[capture]', err.message);
    }
    const wait = FPS_MS - (Date.now() - t);
    if (wait > 0) await sleep(wait);
  }
})();

/* ---------- 时间线 ---------- */
await sleepUntil(start, 0);
await caption('Commons 公地 · 让涌现可见、可听、可比较');

await sleepUntil(start, 5);
await safeClick('#introListen');  // 有 intro 时直接开始；没有则忽略
await caption('培育台：生命不是画出来的，是从规则里长出来的');

await sleepUntil(start, 12);
await safeClick('[data-action="hatch"]');
await caption('随机孵化：基因 × 环境 × 随机种子');

await sleepUntil(start, 18);
await safeClick('[data-action="mutate"]');
await caption('轻轻分裂：在同一个谱系里突变出新形态');

await sleepUntil(start, 23);
await safeClick('[data-engine="scientific"]');
await sleep(700);
await safeClick('[data-sci-preset="gs_spots"]');
await caption('反应—扩散：两种物质一快一慢，斑点自己长出来');

await sleepUntil(start, 32);
await safeClick('[data-sci-preset="gs_stripes"]');
await caption('同一套规则，换一组参数，斑点就变成条纹');

await sleepUntil(start, 40);
await caption('存入花园：配方可保存、分享、还原');

await sleepUntil(start, 46);
await safeClick('nav [data-view="commons"]');
await caption('花园：一座可以继续繁殖的形态库');
await page.evaluate(() => window.scrollTo({ top: 420, behavior: 'smooth' }));

await sleepUntil(start, 52);
const mark = (label) => console.log(`[demo] ${((Date.now() - start) / 1000).toFixed(1)}s ${label}`);
mark('research click');
await page.evaluate(() => document.querySelector('#researchDoor')?.click());
await page.waitForFunction(
  () => document.querySelector('#view-research')?.classList.contains('active'),
  { timeout: 15000 },
);
mark('research active');
await page.waitForFunction(
  () => document.querySelectorAll('.model-card').length === 4,
  { timeout: 15000 },
);
await sleep(800);
await page.evaluate(() => document.querySelector('#researchModelLives')?.scrollIntoView({ block: 'center', behavior: 'auto' }));
await sleep(700);
mark('model cards visible');
await caption('MODEL LIVES：四张可复现的模型卡');
await sleep(7000);

await safeClick('[data-replicate="model-gs-spots"]');
await page.waitForFunction(() => {
  const r = document.querySelector('#researchResult');
  return r && !r.hidden && r.textContent.includes('行为指纹') && r.textContent.includes('Gray–Scott 斑点');
}, { timeout: 15000 });
await page.evaluate(() => document.querySelector('#researchResult')?.scrollIntoView({ block: 'center', behavior: 'auto' }));
mark('GS result');
await caption('一键复现：结构签名 + 行为指纹 + 模型检查');
await sleep(7000);

await safeClick('[data-replicate="model-le-stripes"]');
await page.waitForFunction(() => {
  const r = document.querySelector('#researchResult');
  return r && !r.hidden && r.textContent.includes('行为指纹')
    && (r.textContent.includes('Lengyel') || r.textContent.includes('38.7'));
}, { timeout: 20000 });
await page.evaluate(() => document.querySelector('#researchResult')?.scrollIntoView({ block: 'center', behavior: 'auto' }));
mark('LE result');
await caption('LE 条纹：固定噪声种子，慢速稳定，行为指纹不同');
await sleep(7000);

await sleepUntil(start, 90);
await safeClick('nav [data-view="puzzle"]');
await caption('挑战：画种子 → Wiggle 调参 → 提交评分');

await sleepUntil(start, 96);
await safeClick('nav [data-view="lineage"]');
await caption('家谱：世代、双亲与血缘，可追溯的演化谱系');

await sleepUntil(start, 101);
await safeClick('nav [data-view="cultivate"]');
await caption('同一颗种子，放进不同的家，会长出不同的模样与歌');

await sleepUntil(start, 106);
await page.evaluate((url) => window.__demoEnd(url), APP_URL.replace(/^https?:\/\//, ''));
await caption('');
await sleep(4500);

recording = false;
await captureLoop;
await browser.close();

/* ---------- 生成 ffmpeg concat 时间轴 ---------- */
const lines = [];
frames.forEach((f, i) => {
  const next = frames[i + 1];
  const dur = next ? Math.max(0.05, (next.t - f.t) / 1000) : 0.5;
  lines.push(`file '${f.file}'`, `duration ${dur.toFixed(3)}`);
});
lines.push(`file '${frames[frames.length - 1].file}'`);
fs.writeFileSync(path.join(OUT_DIR, 'frames.txt'), lines.join('\n'));

const seconds = frames.length ? ((frames[frames.length - 1].t - frames[0].t) / 1000).toFixed(1) : '0';
console.log(`[record] frames=${frames.length} duration≈${seconds}s dir=${OUT_DIR}`);
