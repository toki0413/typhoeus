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

  it('恰好等于预算应通过', () => {
    expect(evaluateBudget({ main: 1024 }, { main: 1024 })).toEqual([]);
  });

  it('未知入口不参与分项预算', () => {
    expect(evaluateBudget({ vendor: 999999 }, { main: 1024 })).toEqual([]);
  });

  it('含连字符的产物按已知前缀分组', () => {
    expect(
      groupEntries([
        { name: 'three.module-abc.js', gzip: 10 },
        { name: 'admin-panel-a1.js', gzip: 5 },
      ])
    ).toEqual({ 'three.module': 10, admin: 5 });
  });

  it('空列表返回空对象', () => {
    expect(groupEntries([])).toEqual({});
  });
});
