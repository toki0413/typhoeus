// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createWorld } from '../src/sim/world';
import { checkDoor, openDoor } from '../src/sim/door';
import { buildDebrief } from '../src/eval/debrief';
import { renderDebrief } from '../src/ui/debrief';

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('复盘界面', () => {
  it('渲染救出结果、遗漏与学习记录', () => {
    const s = createWorld('x');
    openDoor(s);
    const card = buildDebrief(s);
    const root = document.createElement('div');
    renderDebrief(root, card);

    expect(root.textContent).toContain('行动后回顾');
    expect(root.textContent).toContain('未进行门温试探');
    expect(root.textContent).toContain('K-BACKDRAFT-FAIL');
  });

  it('成功救援时显示救出 1 人', () => {
    const s = createWorld('x');
    checkDoor(s);
    s.door.safe = true;
    openDoor(s);
    const root = document.createElement('div');
    renderDebrief(root, buildDebrief(s));
    expect(root.textContent).toContain('救出 1');
  });

  it('导出按钮触发下载并延迟释放 URL', () => {
    const s = createWorld('x');
    openDoor(s);
    const root = document.createElement('div');
    document.body.appendChild(root);
    renderDebrief(root, buildDebrief(s));

    const create = vi.fn(() => 'blob:test');
    const revoke = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: create, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revoke, configurable: true });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    (root.querySelector('#export') as HTMLButtonElement).click();

    expect(create).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(document.querySelector('a')).toBeNull();
  });
});
