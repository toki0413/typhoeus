import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');

if (!existsSync(dist)) {
  console.error('dist/ 不存在，先运行 npm run build');
  process.exit(1);
}

const gzipSize = (path) => gzipSync(readFileSync(path)).length;

const jsFiles = readdirSync(join(dist, 'assets'))
  .filter((name) => name.endsWith('.js'))
  .map((name) => join(dist, 'assets', name));
const cssFiles = readdirSync(join(dist, 'assets'))
  .filter((name) => name.endsWith('.css'))
  .map((name) => join(dist, 'assets', name));
const htmlFile = join(dist, 'index.html');

const js = jsFiles.reduce((sum, file) => sum + gzipSize(file), 0);
const css = cssFiles.reduce((sum, file) => sum + gzipSize(file), 0);
const html = gzipSize(htmlFile);
const total = js + css + html;

const budgets = {
  js: 190 * 1024,
  css: 24 * 1024,
  html: 16 * 1024,
  total: 220 * 1024,
};

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

console.log(`JS  gzip ${kb(js)} / ${kb(budgets.js)}`);
console.log(`CSS gzip ${kb(css)} / ${kb(budgets.css)}`);
console.log(`HTML gzip ${kb(html)} / ${kb(budgets.html)}`);
console.log(`总计 gzip ${kb(total)} / ${kb(budgets.total)}`);

const failures = [
  ['JS', js, budgets.js],
  ['CSS', css, budgets.css],
  ['HTML', html, budgets.html],
  ['总计', total, budgets.total],
].filter(([, actual, budget]) => actual > budget);

if (failures.length) {
  console.error(`包体超预算：${failures.map(([name]) => name).join('、')}`);
  process.exit(1);
}

console.log('包体预算通过');
