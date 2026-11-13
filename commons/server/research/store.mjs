/**
 * 榜单存储适配器
 *
 * 平台在多数部署形态下没有持久卷，dist 只读、/tmp 与 /home 都在 overlay 上，
 * 实例重启就清空。要真正持久，只能把榜单放到进程外：
 *
 *   COMMONS_STORE_URL=https://...   启用 HTTP JSON KV（优先级高于本地文件）
 *   COMMONS_STORE_TOKEN=...         可选，Authorization: Bearer
 *   COMMONS_STORE_KEY=commons:submissions  可选，默认 commons:submissions
 *   COMMONS_STORE_PROTOCOL=generic|upstash 可选；upstash 也可由域名自动识别
 *
 * generic 协议（自建 KV / 网关）：
 *   GET  {url}?key=...  -> {"items":[...]} 或 {"value":"<json>"} 或裸 JSON
 *   PUT  {url}?key=...  body {"version":1,"items":[...]}
 *
 * upstash 协议（Upstash Redis REST）：
 *   GET  {url}/get/{key} -> {"result":"<json>"}
 *   POST {url} body ["SET", key, "<json>"]
 *
 * 没有外部配置时回落到本地文件；health 会如实返回当前后端与持久性。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_KEY = 'commons:submissions';
const EMPTY = () => ({ version: 1, items: [] });

function resolveLocalDir(env) {
  const configured = env.COMMONS_DATA_DIR ? path.resolve(env.COMMONS_DATA_DIR) : null;
  const candidates = [
    configured,
    path.join(HERE),
    path.join(os.tmpdir(), 'commons-research'),
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch (_) { /* 尝试下一个 */ }
  }
  return null;
}

function parsePayload(raw) {
  if (!raw) return null;
  let data = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch (_) {
      return null;
    }
  }
  if (data && Array.isArray(data.items)) return data;
  if (data && data.value !== undefined) return parsePayload(data.value);
  return null;
}

function createHttpStore(env) {
  const base = env.COMMONS_STORE_URL.replace(/\/+$/, '');
  const token = env.COMMONS_STORE_TOKEN || '';
  const key = env.COMMONS_STORE_KEY || DEFAULT_KEY;
  const protocol = env.COMMONS_STORE_PROTOCOL
    || (/\.upstash\.io$/i.test(new URL(base).hostname) ? 'upstash' : 'generic');
  const timeout = Number(env.COMMONS_STORE_TIMEOUT) || 8000;

  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;

  async function request(url, options = {}, { allowNotFound = false } = {}) {
    const res = await fetch(url, {
      ...options,
      headers: { ...headers, ...(options.headers || {}) },
      signal: AbortSignal.timeout(timeout),
    });
    const text = await res.text();
    if (allowNotFound && res.status === 404) return '';
    if (!res.ok) throw new Error(`存储服务 HTTP ${res.status}: ${text.slice(0, 120)}`);
    return text;
  }

  return {
    backend: 'http',
    protocol,
    key,
    mode: 'persistent',
    async load() {
      if (protocol === 'upstash') {
        const text = await request(`${base}/get/${encodeURIComponent(key)}`, {}, { allowNotFound: true });
        const body = JSON.parse(text || '{}');
        return parsePayload(body?.result ?? body);
      }
      const text = await request(`${base}?key=${encodeURIComponent(key)}`, {}, { allowNotFound: true });
      return parsePayload(text);
    },
    async save(payload) {
      if (protocol === 'upstash') {
        await request(base, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(['SET', key, JSON.stringify(payload)]),
        });
        return;
      }
      await request(`${base}?key=${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    },
    describe() {
      let host = 'unknown';
      try { host = new URL(base).host; } catch (_) { /* 忽略非法 URL */ }
      return { backend: 'http', protocol, host, key };
    },
  };
}

function createFileStore(env) {
  const dir = resolveLocalDir(env);
  if (!dir) {
    return {
      backend: 'memory',
      mode: 'ephemeral',
      async load() { return null; },
      async save() { throw new Error('没有可写目录'); },
      describe() { return { backend: 'memory' }; },
    };
  }
  const configured = env.COMMONS_DATA_DIR ? path.resolve(env.COMMONS_DATA_DIR) : null;
  const file = path.join(dir, 'submissions.json');
  const mode = configured && dir === configured
    ? 'configured'
    : dir === path.join(os.tmpdir(), 'commons-research') ? 'ephemeral' : 'local';
  return {
    backend: 'file',
    mode,
    file,
    async load() {
      try {
        return parsePayload(fs.readFileSync(file, 'utf8'));
      } catch (_) {
        return null;
      }
    },
    async save(payload) {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(payload));
      fs.renameSync(tmp, file);
    },
    describe() {
      return { backend: 'file', dir, file };
    },
  };
}

export function createStore(env = process.env) {
  if (env.COMMONS_STORE_URL) {
    try {
      return createHttpStore(env);
    } catch (err) {
      const fallback = createFileStore(env);
      fallback.configError = err.message;
      return fallback;
    }
  }
  return createFileStore(env);
}

export async function openStore(env = process.env) {
  const store = createStore(env);
  let error = null;
  let loaded = null;
  try {
    loaded = await store.load();
  } catch (err) {
    error = err.message;
  }
  const data = loaded && Array.isArray(loaded.items) ? { ...EMPTY(), ...loaded } : EMPTY();
  return {
    store,
    data,
    error,
    async save(payload) {
      await store.save(payload);
    },
  };
}

export { parsePayload };
