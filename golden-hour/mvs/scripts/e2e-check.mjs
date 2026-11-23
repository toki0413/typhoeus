import {
  launchBrowser,
  screenshot,
  startServer,
} from './browser-harness.mjs';

const server = await startServer(5201);
const { browser, page, errors } = await launchBrowser({ width: 1280, height: 800 });
let failed = false;

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
}

try {
  await page.goto(`${server.url}building.html?zones=multi&seed=1`, {
    waitUntil: 'networkidle0',
    timeout: 30000,
  });

  const chips = await page.$$eval('#zones .zone-chip', (nodes) =>
    nodes.map((node) => node.textContent?.trim() ?? '')
  );
  check('默认显示 5 个救援区域', chips.length === 5, chips.join(' / '));

  const phase = await page.$eval('#hud-phase', (node) => node.textContent ?? '');
  check('阶段为搜救', phase.includes('搜救'), phase);

  const residents = await page.$eval('#hud-resident', (node) => node.textContent ?? '');
  check('居民总数为 10', residents.includes('/10'), residents);

  await page.waitForSelector('#routes button', { timeout: 10000 });
  await page.click('#routes button');
  await page.waitForSelector('#residents [data-rescue]', { timeout: 20000 });

  const carry = await page.$('#residents button[data-rescue$=":carry"]');
  check('进入区域后出现背出按钮', carry !== null);
  if (!carry) throw new Error('找不到背出按钮');
  await carry.click();

  await page.waitForSelector('#residents [data-confirm]', { timeout: 20000 });
  check('带离后出现确认送达按钮', true);
  await page.click('#residents [data-confirm]');

  await page.waitForFunction(
    () => (document.getElementById('hud-resident')?.textContent ?? '').includes('1/10'),
    { timeout: 15000 }
  );
  check('确认送达后计入 1/10', true);

  await page.click('#save-btn');
  await page.waitForFunction(
    () =>
      Object.keys(window.localStorage).some((key) => key.startsWith('gh-save:')),
    { timeout: 5000 }
  );
  check('保存写入 localStorage', true);

  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(
    () => {
      const button = document.getElementById('continue-btn');
      return button instanceof HTMLButtonElement && !button.hidden;
    },
    { timeout: 10000 }
  );
  check('刷新后出现继续上一局', true);

  await page.click('#continue-btn');
  await page.waitForFunction(
    () => (document.getElementById('hud-resident')?.textContent ?? '').includes('1/10'),
    { timeout: 10000 }
  );
  const room = await page.$eval('#hud-room', (node) => node.textContent ?? '');
  check('恢复后回到目标房间且保留 1/10', room.includes('room-202-F1'), room);

  check('无页面级异常', errors.length === 0, errors.join(' | '));
  await screenshot(page, 'e2e-multi');
} catch (error) {
  failed = true;
  console.error('E2E 失败：', error);
  console.error('页面错误：', errors);
} finally {
  await browser.close();
  server.stop();
}

process.exit(failed ? 1 : 0);
