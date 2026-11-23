import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  ENTRY_BUDGETS,
  TOTAL_JS_BUDGET,
  evaluateBudget,
  groupEntries,
} from './budget.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');

if (!existsSync(dist)) {
  console.error('dist/ 不存在，先运行 npm run build');
  process.exit(1);
}

const gzipSize = (path) => gzipSync(readFileSync(path)).length;
const assetDir = join(dist, 'assets');

const jsFiles = readdirSync(assetDir).filter((name) => name.endsWith('.js'));
const files = jsFiles.map((name) => ({
  name,
  gzip: gzipSize(join(assetDir, name)),
}));

const entries = groupEntries(files);
const totalJs = Object.values(entries).reduce((sum, bytes) => sum + bytes, 0);

const css = readdirSync(assetDir)
  .filter((name) => name.endsWith('.css'))
  .reduce((sum, name) => sum + gzipSize(join(assetDir, name)), 0);

const html = gzipSize(join(dist, 'index.html'));

const media = readdirSync(assetDir)
  .filter((name) => /\.(glb|gltf|bin|ktx2)$/.test(name))
  .reduce((sum, name) => sum + readFileSync(join(assetDir, name)).length, 0);

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

for (const [entry, bytes] of Object.entries(entries)) {
  console.log(`${entry}  JS gzip ${kb(bytes)}`);
}
console.log(`JS 总计 gzip ${kb(totalJs)} / ${kb(TOTAL_JS_BUDGET)}`);
console.log(`CSS gzip ${kb(css)} / 24.0 KB`);
console.log(`HTML gzip ${kb(html)} / 16.0 KB`);
console.log(`3D 资产 ${kb(media)} / 2662.4 KB`);

const failures = evaluateBudget(entries, ENTRY_BUDGETS);

if (totalJs > TOTAL_JS_BUDGET) {
  failures.push(`JS 总计 ${kb(totalJs)} > ${kb(TOTAL_JS_BUDGET)}`);
}
if (css > 24 * 1024) failures.push(`CSS ${kb(css)} > 24.0 KB`);
if (html > 16 * 1024) failures.push(`HTML ${kb(html)} > 16.0 KB`);
if (media > 2.6 * 1024 * 1024) failures.push(`3D 资产 ${kb(media)} > 2662.4 KB`);

if (failures.length) {
  console.error('包体超预算：');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('包体预算通过');
