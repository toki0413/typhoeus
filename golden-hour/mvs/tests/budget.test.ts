import { describe, it, expect } from 'vitest';
// @ts-expect-error 纯 JS 门禁脚本没有类型声明
import { evaluateBudget, groupEntries } from '../scripts/budget.mjs';

describe('包体预算', () => {
  it('按文件名前缀分组 gzip', () => {
    const grouped = groupEntries([
      { name: 'main-a.js', gzip: 10 },
      { name: 'main-b.js', gzip: 5 },
      { name: 'room-a.js', gzip: 7 },
      { name: 'three.module-x.js', gzip: 100 },
    ]);
    expect(grouped).toEqual({ main: 15, room: 7, 'three.module': 100 });
  });

  it('超出预算返回失败项', () => {
    const failures = evaluateBudget(
      { main: 2048, room: 512 },
      { main: 1024, room: 1024 }
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('main');
  });
});
