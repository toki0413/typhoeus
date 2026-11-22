import {
  launchBrowser,
  openApp,
  report,
  screenshot,
  startServer,
} from './browser-harness.mjs';

const server = await startServer();
const { browser, page, errors } = await launchBrowser();
const checks = [];
let failed = false;

const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

try {
  await openApp(page, server.url);

  const startState = await page.evaluate(() => {
    const button = document.querySelector('[data-action="start"]');
    const notice = document.querySelector('[data-notice]');
    return {
      disabled: button instanceof HTMLButtonElement ? button.disabled : null,
      notice: notice instanceof HTMLElement && !notice.hidden ? notice.textContent : '',
    };
  });
  check('标题页渲染', await page.$('#shell.open') !== null);
  check('WebGL 可用', startState.disabled === false, startState.notice || '开始按钮可点击');

  await screenshot(page, '01-title');

  if (startState.disabled !== false) {
    throw new Error('WebGL 不可用，无法继续视觉验证');
  }

  await page.click('[data-action="start"]');
  await page.waitForFunction(() => document.body.dataset.run === 'playing', { timeout: 10000 });
  const glbLoaded = await page
    .waitForFunction(() => window.__gh?.agents?.usingGLB?.() === true, { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  check('消防员 GLB 已加载', glbLoaded);
  await new Promise((resolve) => setTimeout(resolve, 1600));
  await screenshot(page, '02-gameplay');

  const renderState = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const gl = canvas ? canvas.getContext('webgl2') || canvas.getContext('webgl') : null;
    return {
      width: canvas?.width ?? 0,
      height: canvas?.height ?? 0,
      renderer: gl ? gl.getParameter(gl.RENDERER) : null,
      hud: document.getElementById('hud')?.textContent ?? '',
    };
  });
  check('3D 画布已渲染', renderState.width > 0 && renderState.height > 0, `${renderState.width}x${renderState.height}`);
  check('软件 WebGL 上下文', Boolean(renderState.renderer), renderState.renderer ?? '无');
  check('HUD 显示现场数据', renderState.hud.includes('烟') && renderState.hud.includes('体力'));

  await page.keyboard.press('t');
  // 无头环境会节流 rAF，强制推进若干帧让班组走到门口再截图。
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        let frames = 0;
        const step = () => {
          frames += 1;
          if (frames > 45) resolve();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      })
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  await screenshot(page, '03-door');

  const doorVisible = await page.evaluate(() => {
    const panel = document.getElementById('door-ui');
    const open = document.querySelector('[data-act="open"]');
    return Boolean(panel && open && getComputedStyle(panel).display !== 'none');
  });
  check('到达门口并出现交互', doorVisible);

  if (doorVisible) {
    await page.click('[data-act="open"]');
    await page.waitForFunction(() => document.body.dataset.run === 'debrief', { timeout: 10000 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const debrief = await page.evaluate(() => {
      const panel = document.getElementById('debrief');
      return {
        visible: panel instanceof HTMLElement && getComputedStyle(panel).display !== 'none',
        text: panel?.textContent ?? '',
      };
    });
    await screenshot(page, '04-debrief');
    check('复盘页显示', debrief.visible && debrief.text.includes('行动后回顾'));
    check('复盘包含本次证据', debrief.text.includes('本次训练证据'));
  }

  check('无页面级异常', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (error) {
  failed = true;
  console.error(`FAIL  验证中断 — ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await browser.close();
  server.stop();
}

report('视觉验证', checks.map((item) => `${item.ok ? 'PASS' : 'FAIL'}  ${item.name}`));
process.exit(failed ? 1 : 0);
