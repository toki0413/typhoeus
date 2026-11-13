/**
 * Commons · 研究侧门服务端
 *
 * 职责：
 *   1. 提供真实实验斑图目标（server/research/targets.json，含来源与许可）
 *   2. 接收提交，用确定性种子在服务端重跑反应—扩散，按结构统计评分
 *   3. 把结果写入共享榜单：COMMONS_STORE_URL 存在时走外部 HTTP KV，
 *      否则回落到本地文件（部署环境通常是临时目录，重启即清空）
 *
 * 诚实边界：评分是结构统计距离，不宣称恢复实验参数，也不代表 CIMA 的真实动力学。
 * 运行：node server/server.mjs（PORT 默认 8000）
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateTarget } from './research/score.mjs';
import { signatureDistance } from './research/signature.mjs';
import { openStore } from './research/store.mjs';
import { loadSurrogate, rankCandidates, surrogateSummary } from './research/surrogate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PARENT = path.resolve(HERE, '..');
const STATIC_ROOT = fs.existsSync(path.join(PARENT, 'index.html'))
  ? PARENT
  : path.join(PARENT, 'www');
const TARGETS_FILE = path.join(HERE, 'research', 'targets.json');

const PORT = Number(process.env.PORT) || 8000;
const HOST = '0.0.0.0';

const TARGETS = loadTargets();
const SURFACE = loadSurface();
const SURROGATE = loadSurrogate();
const STORAGE = await openStore();
const STORE = STORAGE.data;
const RATE = new Map(); // ip -> [timestamps]
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 60;

if (STORAGE.error) {
  console.error('[research] 榜单存储载入失败：', STORAGE.error);
}

function loadTargets() {
  try {
    const raw = JSON.parse(fs.readFileSync(TARGETS_FILE, 'utf8'));
    if (!Array.isArray(raw.targets) || !raw.targets.length) throw new Error('目标包为空');
    return raw;
  } catch (err) {
    console.error('[research] 目标包载入失败：', err.message);
    return { version: 1, targets: [], source: null };
  }
}

function loadSurface() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'research', 'surface.json'), 'utf8'));
    if (Array.isArray(raw.points) && raw.points.length) return raw;
  } catch (_) { /* 没有响应面时提议接口返回空 */ }
  return { version: 1, seed: 'calibration-seed', points: [] };
}

async function saveStore() {
  await STORAGE.save(STORE);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJson(req, limit = 262144) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(text));
      } catch (_) {
        reject(Object.assign(new Error('JSON 解析失败'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function cleanText(value, maxLen) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maxLen);
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress
    || 'unknown';
}

function allowRate(ip) {
  const now = Date.now();
  const list = (RATE.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (list.length >= RATE_LIMIT) {
    RATE.set(ip, list);
    return false;
  }
  list.push(now);
  RATE.set(ip, list);
  return true;
}

/* 没带种子时由 score.mjs 派生确定性种子，保证服务端复核可复现 */

function publicTarget(t) {
  return {
    id: t.id,
    label: t.label,
    pattern: t.pattern,
    kind: t.kind,
    w: t.w,
    h: t.h,
    field: t.field,
    features: t.features,
    calibration: t.calibration || null,
    model: t.verify?.model || 'grayScott',
    leDefaults: t.verify?.model === 'lengyelEpstein'
      ? { a: 8, b: 6, sigma: 0.6, D_v: 80, dt: 0.001 }
      : null,
    source: t.source || TARGETS.source || null,
  };
}

function leaderboard(targetId) {
  const items = STORE.items
    .filter((it) => !targetId || it.targetId === targetId)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map((it, i) => ({
      rank: i + 1,
      name: it.name,
      score: it.score,
      distance: it.distance,
      targetId: it.targetId,
      at: it.at,
    }));
  return items;
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/research/health') {
    const info = STORAGE.store.describe();
    return sendJson(res, 200, {
      ok: true,
      targets: TARGETS.targets.length,
      submissions: STORE.items.length,
      storage: STORAGE.store.mode,
      storageBackend: info.backend,
      storageDetail: info,
      storageError: STORAGE.error || STORAGE.store.configError || null,
      surrogate: surrogateSummary(SURROGATE),
      version: 1,
    });
  }

  if (url.pathname === '/api/research/targets' && req.method === 'GET') {
    return sendJson(res, 200, {
      version: TARGETS.version,
      storage: STORAGE.store.mode,
      source: TARGETS.source,
      targets: TARGETS.targets.map(publicTarget),
    });
  }

  if (url.pathname === '/api/research/leaderboard' && req.method === 'GET') {
    const targetId = url.searchParams.get('targetId') || '';
    return sendJson(res, 200, { targetId, items: leaderboard(targetId) });
  }

  /* 候选提议：优先用 numpy 训练的降阶神经代理（参数 → 结构签名 + PCA 场），
   * 没有权重时回落到 Gray–Scott 响应面。两者都只是排序器，不是裁判。 */
  if (url.pathname === '/api/research/propose' && req.method === 'GET') {
    const target = TARGETS.targets.find((t) => t.id === url.searchParams.get('targetId'));
    if (!target) return sendJson(res, 404, { ok: false, error: '目标不存在' });
    const limit = Math.min(6, Math.max(1, Number(url.searchParams.get('limit')) || 3));
    const kind = target.verify?.model === 'lengyelEpstein' ? 'lengyelEpstein' : 'grayScott';

    if (SURROGATE?.kinds?.[kind]) {
      const items = rankCandidates(SURROGATE, kind, target.features, limit).map((it) => ({
        params: kind === 'grayScott'
          ? { f: it.f, k: it.k, D_u: it.D_u, D_v: it.D_v }
          : { a: it.a, b: it.b, sigma: it.sigma, D_v: it.D_v },
        f: it.f,
        k: it.k,
        a: it.a,
        b: it.b,
        sigma: it.sigma,
        predictedScore: it.predictedScore,
        predictedFeatures: it.features,
      }));
      const metrics = SURROGATE.kinds[kind].metrics?.holdout || null;
      return sendJson(res, 200, {
        ok: true,
        targetId: target.id,
        engine: 'mlp-surrogate',
        model: 'mlp-field-pca',
        note: '降阶神经代理排序，非裁判；最终分数由服务端重跑判定。',
        metrics,
        items,
      });
    }

    if (kind !== 'grayScott' || !SURFACE.points.length) {
      return sendJson(res, 200, {
        ok: true, targetId: target.id, engine: 'none', items: [], note: '该目标暂无代理',
      });
    }
    const items = SURFACE.points
      .map((p) => ({
        f: p.f,
        k: p.k,
        predictedScore: Math.round((100 / (1 + signatureDistance(target.features, p.features))) * 10) / 10,
      }))
      .sort((a, b) => b.predictedScore - a.predictedScore)
      .slice(0, limit);
    return sendJson(res, 200, {
      ok: true, targetId: target.id, seed: SURFACE.seed, engine: 'surface', items,
    });
  }

  if (url.pathname === '/api/research/verify' && req.method === 'POST') {
    if (!allowRate(clientIp(req))) {
      return sendJson(res, 429, { ok: false, error: '提交太频繁了，休息一会儿再试' });
    }
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return sendJson(res, err.status || 400, { ok: false, error: err.message });
    }
    const target = TARGETS.targets.find((t) => t.id === body.targetId);
    if (!target) {
      return sendJson(res, 404, { ok: false, error: '目标不存在' });
    }
    const params = {
      f: body.f,
      k: body.k,
      a: body.a,
      b: body.b,
      sigma: body.sigma,
      D_u: body.D_u,
      D_v: body.D_v,
      dt: body.dt,
      mask: body.mask,
      maskW: body.maskW,
      maskH: body.maskH,
      recipeId: cleanText(body.recipeId, 80),
      name: cleanText(body.name, 40),
    };
    /* 候选参数复核：强制使用与响应面相同的固定校准种子，保证预测和重跑可比 */
    if (body.useCalibrationSeed) params.recipeId = 'calibration-seed';
    let result;
    try {
      result = evaluateTarget(target, params);
    } catch (err) {
      console.error('[research] 复核失败：', err);
      return sendJson(res, 500, { ok: false, error: '服务端复核失败' });
    }

    const item = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      targetId: target.id,
      name: params.name || '匿名生命',
      recipeId: params.recipeId,
      engine: cleanText(body.engine, 24),
      score: result.score,
      distance: result.distance,
      features: result.features,
      params: {
        f: clamp(params.f, 0.005, 0.09, 0.035),
        k: clamp(params.k, 0.005, 0.09, 0.062),
        D_u: clamp(params.D_u, 0.02, 0.3, 0.16),
        D_v: clamp(params.D_v, 0.02, 0.2, 0.08),
      },
      usedMask: result.usedMask,
      at: new Date().toISOString(),
    };
    STORE.items.push(item);
    if (STORE.items.length > 2000) STORE.items = STORE.items.slice(-2000);
    let persisted = true;
    try {
      await saveStore();
    } catch (err) {
      persisted = false;
      console.error('[research] 榜单写入失败：', err.message);
    }
    const board = leaderboard(target.id);
    const rank = board.findIndex((x) => x.name === item.name && x.score === item.score && x.at === item.at) + 1;
    return sendJson(res, 200, {
      ok: true,
      target: { id: target.id, label: target.label, source: target.source },
      score: result.score,
      distance: result.distance,
      features: result.features,
      targetFeatures: target.features,
      steps: result.steps,
      usedMask: result.usedMask,
      usedFixedSeed: result.usedFixedSeed,
      model: result.model,
      persisted,
      rank: rank || null,
      leaderboard: board,
    });
  }

  return sendJson(res, 404, { ok: false, error: '未知接口' });
}

function serveStatic(req, res, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (_) {
    res.writeHead(400);
    return res.end('Bad Request');
  }
  if (pathname === '/') pathname = '/index.html';
  /* 运行产物里包含服务端源码和部署脚本；它们不需要被浏览器访问，
   * 其中 store-config.json 还可能含有外部存储的写权限，必须挡住。 */
  if (pathname === '/server' || pathname.startsWith('/server/')
    || ['/run.sh', '/build.sh', '/package.json', '/package-lock.json'].includes(pathname)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Not Found');
  }
  const filePath = path.resolve(STATIC_ROOT, `.${pathname}`);
  if (!filePath.startsWith(`${STATIC_ROOT}${path.sep}`) && filePath !== STATIC_ROOT) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const headers = { 'content-type': type, 'content-length': stat.size };
    if (pathname === '/index.html' || pathname === '/sw.js') {
      headers['cache-control'] = 'no-cache';
    } else {
      headers['cache-control'] = 'public, max-age=300';
    }
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      console.error('[research] 未处理异常：', err);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: '服务器内部错误' });
    });
    return;
  }
  serveStatic(req, res, url);
});

server.listen(PORT, HOST, () => {
  console.log(`[commons] research server on http://${HOST}:${PORT}`);
  console.log(`[commons] static root: ${STATIC_ROOT}`);
  console.log(`[commons] targets: ${TARGETS.targets.length}, submissions: ${STORE.items.length}`);
});
