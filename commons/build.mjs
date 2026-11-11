/**
 * Commons 单文件构建
 *
 *   1. esbuild 打包 src/app.js → bundle.js（minified ESM）
 *   2. 把 styles.css 与 bundle.js 内联进 index.html → commons.html
 *
 * 为什么需要它：commons.html 之前是手工内联的，源码改动后忘记重建，
 * 导致单文件产物与 APK 停留在旧版本（扫描 NaN、缺少 Life Operator Bridge）。
 *
 * 用法：node build.mjs
 */
import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';

const ROOT = new URL('./', import.meta.url).pathname;

/* ---- 1. 打包 JS ---- */
await build({
  entryPoints: [`${ROOT}src/app.js`],
  bundle: true,
  format: 'esm',
  minify: true,
  target: ['es2020'],
  outfile: `${ROOT}bundle.js`,
  logLevel: 'warning',
});

/* ---- 2. 内联进 HTML ---- */
const [html, css, js] = await Promise.all([
  readFile(`${ROOT}index.html`, 'utf8'),
  readFile(`${ROOT}styles.css`, 'utf8'),
  readFile(`${ROOT}bundle.js`, 'utf8'),
]);

const LINK_TAG = '<link rel="stylesheet" href="./styles.css" />';
const SCRIPT_TAG = '<script type="module" src="./src/app.js"></script>';

if (!html.includes(LINK_TAG) || !html.includes(SCRIPT_TAG)) {
  throw new Error('index.html 结构变了：找不到 styles.css link 或 app.js script 标签，请先更新 build.mjs');
}

const swRegister = `
  <script>
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function() {
        navigator.serviceWorker.register('./sw.js').catch(function() {});
      });
    }
  </script>`;

// 用函数式 replacer：字符串替换会被解释 $& / $' / $` 等特殊序列，
// 而压缩后的 JS 里一定出现这些，导致内容被拼接/截断。
const out = html
  .replace(LINK_TAG, () => `<style>\n${css}\n    </style>`)
  .replace(SCRIPT_TAG, () => `<script type="module">\n${js}\n  </script>${swRegister}`);

await writeFile(`${ROOT}commons.html`, out);

const kb = (p) => (statSync(p).size / 1024).toFixed(1);
console.log(`✅ bundle.js    ${kb(`${ROOT}bundle.js`)} KB`);
console.log(`✅ commons.html ${kb(`${ROOT}commons.html`)} KB`);
