/**
 * 榜单存储适配器：
 *   - 本地目录读写往返
 *   - HTTP JSON KV 读写往返（真实起一个模拟服务）
 *   - 载入失败时如实返回空榜单与错误，而不是假装持久化
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, createStore, parsePayload } from '../server/research/store.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'commons-store-test-'));
}

test('本地存储：写入后重新打开仍在', async () => {
  const dir = tmpDir();
  const first = await openStore({ COMMONS_DATA_DIR: dir });
  assert.equal(first.store.mode, 'configured');
  first.data.items.push({ id: 'a', score: 42 });
  await first.save(first.data);

  const second = await openStore({ COMMONS_DATA_DIR: dir });
  assert.equal(second.store.mode, 'configured');
  assert.equal(second.data.items.length, 1);
  assert.equal(second.data.items[0].score, 42);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('HTTP 存储：generic 协议读写往返', async () => {
  let stored = '';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'PUT') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        stored = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(stored || '');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const opened = await openStore({ COMMONS_STORE_URL: `http://127.0.0.1:${port}/kv` });
  assert.equal(opened.store.mode, 'persistent');
  assert.equal(opened.store.backend, 'http');
  assert.equal(opened.data.items.length, 0);
  assert.equal(opened.error, null);

  opened.data.items.push({ id: 'http-1', score: 88 });
  await opened.save(opened.data);

  const reopened = await openStore({ COMMONS_STORE_URL: `http://127.0.0.1:${port}/kv` });
  assert.equal(reopened.data.items.length, 1);
  assert.equal(reopened.data.items[0].id, 'http-1');
  server.close();
});

test('HTTP 存储：服务不可达时返回错误且不静默成功', async () => {
  const dir = tmpDir();
  const store = createStore({
    COMMONS_STORE_URL: 'http://127.0.0.1:1/kv',
    COMMONS_STORE_TIMEOUT: '200',
    COMMONS_DATA_DIR: dir,
  });
  assert.equal(store.mode, 'persistent');
  await assert.rejects(() => store.save({ version: 1, items: [] }));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('响应解析：兼容 items / value / 裸 JSON', () => {
  assert.deepEqual(parsePayload('{"items":[{"id":1}]}').items, [{ id: 1 }]);
  assert.deepEqual(parsePayload('{"value":"{\\"items\\":[{\\"id\\":2}]}"}').items, [{ id: 2 }]);
  assert.equal(parsePayload('', null), null);
  assert.equal(parsePayload('not json'), null);
});
