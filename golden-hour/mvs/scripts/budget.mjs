/** 按 Vite 产物文件名前缀（main-xxx.js / room-xxx.js / three.module-xxx.js）分组 gzip 大小。 */
export function groupEntries(files) {
  const groups = new Map();
  for (const file of files) {
    const entry = entryOf(file.name);
    groups.set(entry, (groups.get(entry) ?? 0) + file.gzip);
  }
  return Object.fromEntries(groups);
}

/** 从 Vite 产物名解析入口；已知前缀按最长匹配，未知产物退回第一个连字符段。 */
export function entryOf(name) {
  for (const prefix of KNOWN_PREFIXES) {
    if (name.startsWith(`${prefix}-`)) return prefix;
  }
  return name.replace(/\.js$/, '').split('-')[0];
}

/** 返回超出预算的入口说明；空数组表示通过。 */
export function evaluateBudget(summary, budgets) {
  const failures = [];
  for (const [name, bytes] of Object.entries(summary)) {
    const budget = budgets[name];
    if (budget === undefined) continue;
    if (bytes > budget) {
      failures.push(
        `${name} ${(bytes / 1024).toFixed(1)}KB > ${(budget / 1024).toFixed(1)}KB`
      );
    }
  }
  return failures;
}

export const ENTRY_BUDGETS = {
  main: 60 * 1024,
  room: 80 * 1024,
  // Phase 1 预留：建筑入口出现前不会命中任何产物。
  building: 90 * 1024,
  'three.module': 170 * 1024,
};

// 分项预算是各自上限；TOTAL_JS_BUDGET 是全局上限，二者不必相加相等。
export const TOTAL_JS_BUDGET = 340 * 1024;

const KNOWN_PREFIXES = Object.keys(ENTRY_BUDGETS).sort((a, b) => b.length - a.length);
