import { spawn } from 'node:child_process';
import { existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import puppeteer from 'puppeteer-core';

export const root = fileURLToPath(new URL('..', import.meta.url));
export const artifacts = join(root, '.verify');

export function ensureArtifacts() {
  mkdirSync(artifacts, { recursive: true });
}

export function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  const base = join(process.env.HOME ?? '/root', '.cache', 'puppeteer', 'chrome');
  if (existsSync(base)) {
    const versions = readdirSync(base)
      .filter((name) => name.startsWith('linux-'))
      .sort();
    for (const version of versions.reverse()) {
      const candidate = join(base, version, 'chrome-linux64', 'chrome');
      if (existsSync(candidate)) return candidate;
    }
  }

  throw new Error('找不到 Chrome。设置 CHROME_PATH 指向可执行文件。');
}

export async function startServer(port = 5199) {
  const vite = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!existsSync(vite)) throw new Error('缺少 vite，先运行 npm install');

  const server = spawn(process.execPath, [vite, '--port', String(port), '--host', '127.0.0.1', '--strictPort'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return {
          url,
          stop: () => {
            server.kill('SIGTERM');
          },
        };
      }
    } catch {
      // 还没起来
    }
    await sleep(150);
  }

  server.kill('SIGTERM');
  throw new Error('Vite 开发服务器启动超时');
}

export async function launchBrowser({ width = 1080, height = 675 } = {}) {
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    protocolTimeout: 180000,
    args: [
      '--no-sandbox',
      '--disable-gpu-sandbox',
      '--disable-dev-shm-usage',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio=false',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.bringToFront();

  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  return { browser, page, errors };
}

export async function openApp(page, url) {
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
  await page.waitForSelector('#shell.open', { timeout: 15000 });
}

export async function screenshot(page, name) {
  ensureArtifacts();
  const path = join(artifacts, `${name}.png`);
  await page.screenshot({ path });
  return path;
}

export function report(title, lines) {
  console.log(`\n== ${title} ==`);
  for (const line of lines) console.log(line);
}
