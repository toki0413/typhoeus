/* 真实浏览器音频运行时检查：点「♪ 聆听」，确认无控制台/页面错误 */
const puppeteer = require('puppeteer-core');

const CHROME = process.env.CHROME_PATH
  || '/root/.cache/puppeteer/chrome/linux-155.0.8059.39/chrome-linux64/chrome';
const url = process.argv[2] || process.env.APP_URL || 'http://127.0.0.1:4200/index.html';

(async () => {
  const b = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
  });
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', (e) => errs.push(String(e)));
  pg.on('console', (m) => { if (m.type() === 'error' && !/manifest/.test(m.text())) errs.push(m.text()); });
  await pg.goto(url, { waitUntil: 'load', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1500));
  await pg.evaluate(() => document.querySelector('#introListen')?.click());
  await new Promise((r) => setTimeout(r, 3500));
  const info = await pg.evaluate(() => {
    // 切到「♪ 歌声」页，验证乐器开关
    document.querySelector('#railTabs button[data-tab="sound"]')?.click();
    const sel = document.querySelector('[data-instrument-select="choir"]');
    const before = sel?.value;
    const fire = (v) => {
      const el = document.querySelector('[data-instrument-select="choir"]');
      if (!el) return null;
      el.value = v;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return document.querySelector('[data-instrument-select="choir"]')?.value;
    };
    const after = fire('off');
    const restored = fire(before || 'choir');
    return {
      label: document.querySelector('#audioLabel')?.textContent,
      hud: document.querySelector('#hudSound')?.textContent?.trim(),
      audioOn: document.body.classList.contains('audio-on'),
      instrumentSelect: { before, after, restored },
    };
  });
  console.log(JSON.stringify({ info, errs }, null, 2));
  await b.close();
  process.exit(errs.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
