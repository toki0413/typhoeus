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
  const clips = await page.evaluate(() => window.__gh?.crewClips?.() ?? []);
  check(
    'GLB 含 Idle/Walk/Reach 动画',
    ['Idle', 'Walk', 'Reach'].every((name) => clips.includes(name)),
    clips.join(', ')
  );
  await new Promise((resolve) => setTimeout(resolve, 1600));
  const hudReady = await page
    .waitForFunction(
      () => {
        const text = document.getElementById('hud')?.textContent ?? '';
        return text.includes('烟') && text.includes('体力');
      },
      { timeout: 60000 }
    )
    .then(() => true)
    .catch(() => false);
  await screenshot(page, '02-gameplay');

  const renderState = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const gl = canvas ? canvas.getContext('webgl2') || canvas.getContext('webgl') : null;
    return {
      width: canvas?.width ?? 0,
      height: canvas?.height ?? 0,
      renderer: gl ? gl.getParameter(gl.RENDERER) : null,
    };
  });
  check('3D 画布已渲染', renderState.width > 0 && renderState.height > 0, `${renderState.width}x${renderState.height}`);
  check('软件 WebGL 上下文', Boolean(renderState.renderer), renderState.renderer ?? '无');
  check('HUD 显示现场数据', hudReady);

  await page.evaluate(() => window.__gh?.agents?.snap?.(window.__gh.sim, 0, 1.65, 1));
  const mobile = await page
    .waitForFunction(() => window.__gh?.agents?.mobile?.() === true, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check('二层门口可直接操控', mobile);

  const nearDoor = await page
    .waitForFunction(() => window.__gh?.agents?.nearDoor?.() === true, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check('站到 202 门口', nearDoor);

  const f2Cut = await page
    .waitForFunction(() => window.__gh?.cam?.zone?.() === 'f2', { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check('房间切镜：二层走廊', f2Cut);

  const heroAuto = await page
    .waitForFunction(() => (window.__gh?.hero?.autoRuns?.() ?? 0) >= 1, {
      timeout: 25000,
    })
    .then(() => true)
    .catch(() => false);
  check('门口英雄镜头自动触发', heroAuto);

  // 快进帧可能已经放完整段镜头；为截图重放一次，保证取到推满的画面。
  await page.evaluate(() => window.__gh?.hero?.start?.());
  const heroSeen = await page
    .waitForFunction(() => window.__gh?.hero?.active?.() === true, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check('门口英雄镜头推近', heroSeen);
  if (heroSeen) {
    await page
      .waitForFunction(() => (window.__gh?.hero?.strength?.() ?? 0) > 0.92, {
        timeout: 25000,
      })
      .catch(() => undefined);
  }
  await screenshot(page, '03-hero');

  const heroReturned = await page
    .waitForFunction(() => window.__gh?.hero?.active?.() === false, { timeout: 25000 })
    .then(() => true)
    .catch(() => false);
  check('英雄镜头回到战术视角', heroReturned);
  await screenshot(page, '03-door');

  const doorVisible = await page.evaluate(() => {
    const panel = document.getElementById('door-ui');
    const open = document.querySelector('[data-act="open"]');
    return Boolean(panel && open && getComputedStyle(panel).display !== 'none');
  });
  check('到达门口并出现交互', doorVisible);

  if (doorVisible) {
    await page.click('[data-act="open"]');
    const opened = await page
      .waitForFunction(() => window.__gh?.sim?.door?.opened === true, { timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    check('开门进入 202', opened);

    await page.evaluate(() => window.__gh?.agents?.snap?.(window.__gh.sim, 0.2, 0.35, 1));
    await page.evaluate(() => {
      window.__gh.sim.smoke[1] = 0.85;
    });
    const roomCut = await page
      .waitForFunction(() => window.__gh?.cam?.zone?.() === 'room202', { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    check('房间切镜：202 室内', roomCut);

    const smokeDim = await page
      .waitForFunction(
        () => Number(getComputedStyle(document.getElementById('smoke-screen')).opacity) > 0.12,
        { timeout: 15000 }
      )
      .then(() => true)
      .catch(() => false);
    check('浓烟产生视野压迫', smokeDim);
    await screenshot(page, '04-room');

    await page.evaluate(() => window.__gh?.finishRun?.());
    await page.waitForFunction(() => document.body.dataset.run === 'debrief', { timeout: 20000 });
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
