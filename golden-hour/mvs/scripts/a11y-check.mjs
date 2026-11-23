import { join } from 'node:path';
import {
  launchBrowser,
  root,
  screenshot,
  startServer,
} from './browser-harness.mjs';

const server = await startServer(5202);
const { browser, page, errors } = await launchBrowser({ width: 1280, height: 800 });
const axePath = join(root, 'node_modules', 'axe-core', 'axe.min.js');
let failed = false;

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
}

async function scan(path, label) {
  await page.goto(`${server.url}${path}`, { waitUntil: 'networkidle0', timeout: 30000 });
  await page.addScriptTag({ path: axePath });

  const result = await page.evaluate(async () => {
    const axe = window.axe;
    return axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
    });
  });

  const blocking = result.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical'
  );
  for (const violation of blocking) {
    for (const node of violation.nodes.slice(0, 3)) {
      console.log(`  [${violation.impact}] ${violation.id}: ${node.target.join(' ')}`);
    }
  }
  check(`${label} 无 serious/critical 无障碍违规`, blocking.length === 0, `${blocking.length} 项`);

  // 减少动态：按钮过渡时长应近似为 0。
  await page.emulateMediaFeatures([
    { name: 'prefers-reduced-motion', value: 'reduce' },
  ]);
  const transition = await page.$eval(
    path.includes('drills') ? '#drill-actions button' : '#routes button',
    (element) => getComputedStyle(element).transitionDuration
  );
  const seconds = transition.endsWith('ms')
    ? parseFloat(transition) / 1000
    : parseFloat(transition);
  check(`${label} 遵守 prefers-reduced-motion`, seconds <= 0.001, transition);

  await screenshot(page, `a11y-${label}`);
}

try {
  await scan('building.html?zones=multi', 'building');
  await scan('drills.html', 'drills');
  check('无页面级异常', errors.length === 0, errors.join(' | '));
} catch (error) {
  failed = true;
  console.error('可访问性检查失败：', error);
} finally {
  await browser.close();
  server.stop();
}

process.exit(failed ? 1 : 0);
