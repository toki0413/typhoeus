import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 架构边界检查：模拟层必须保持纯 TypeScript、确定性，不依赖渲染/DOM。
 * 这是 lint 的轻量替代，专门守住最容易退化的边界。
 */
const RULES = [
  { name: 'three 依赖', re: /from\s+['"]three(?:\/[^'"]*)?['"]/ },
  { name: '渲染层依赖', re: /from\s+['"][^'"]*render\// },
  { name: 'DOM document', re: /(?<![.\w])document\./ },
  { name: 'DOM window', re: /(?<![.\w])window\./ },
  { name: 'Math.random', re: /\bMath\.random\s*\(/ },
  { name: 'Date.now', re: /\bDate\.now\s*\(/ },
  { name: 'performance.now', re: /\bperformance\.now\s*\(/ },
];

function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else if (name.endsWith('.ts')) files.push(path);
  }
  return files;
}

const root = join(process.cwd(), 'src', 'sim');
const failures = [];

for (const file of walk(root)) {
  const text = readFileSync(file, 'utf8');
  for (const rule of RULES) {
    if (rule.re.test(text)) {
      failures.push(`${file.replace(process.cwd() + '/', '')}: ${rule.name}`);
    }
  }
}

if (failures.length) {
  console.error('模拟层边界检查失败：');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('模拟层边界检查通过');
