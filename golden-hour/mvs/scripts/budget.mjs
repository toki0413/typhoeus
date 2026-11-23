/** 按 Vite 产物文件名前缀（main-xxx.js / room-xxx.js / three.module-xxx.js）分组 gzip 大小。 */
export function groupEntries(files) {
  const groups = new Map();
  for (const file of files) {
    const entry = file.name.split('-')[0];
    groups.set(entry, (groups.get(entry) ?? 0) + file.gzip);
  }
  return Object.fromEntries(groups);
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
  building: 90 * 1024,
  'three.module': 170 * 1024,
};

export const TOTAL_JS_BUDGET = 340 * 1024;
