/**
 * 户型解锁进度：纯逻辑，不碰 DOM；存储通过可选参数注入。
 * 入口层传入 localStorage，测试传入内存假存储。
 */

export interface ProgressState {
  /** 每个户型的历史最高分 */
  best: Record<string, number>;
  /** 至少完成过一次（得分 > 0）的户型 */
  cleared: string[];
}

export const PROGRESS_KEY = 'gh-progress:v1';

export function emptyProgress(): ProgressState {
  return { best: {}, cleared: [] };
}

/** 读取默认存储；隐私模式或非浏览器环境里悄悄返回 undefined。 */
function localStore(): Storage | undefined {
  try {
    return typeof globalThis.localStorage === 'undefined'
      ? undefined
      : globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** 坏 JSON、缺字段或类型不对时一律回退为空进度；非法数值单独忽略。 */
export function parseProgress(raw: string | null): ProgressState {
  const empty = emptyProgress();
  if (!raw) return empty;

  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch {
    return empty;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return empty;

  const source = data as Record<string, unknown>;
  const best: Record<string, number> = {};
  if (source.best && typeof source.best === 'object' && !Array.isArray(source.best)) {
    for (const [id, value] of Object.entries(source.best as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) best[id] = value;
    }
  }

  const cleared: string[] = [];
  if (Array.isArray(source.cleared)) {
    for (const id of source.cleared) {
      if (typeof id === 'string' && !cleared.includes(id)) cleared.push(id);
    }
  }

  return { best, cleared };
}

export function serializeProgress(state: ProgressState): string {
  return JSON.stringify(state);
}

export function loadProgress(
  storage: Pick<Storage, 'getItem'> | undefined = localStore()
): ProgressState {
  if (!storage) return emptyProgress();
  try {
    return parseProgress(storage.getItem(PROGRESS_KEY));
  } catch {
    return emptyProgress();
  }
}

export function saveProgress(
  state: ProgressState,
  storage: Pick<Storage, 'setItem'> | undefined = localStore()
): void {
  if (!storage) return;
  try {
    storage.setItem(PROGRESS_KEY, serializeProgress(state));
  } catch {
    // 存储不可用时静默失败，不影响本局结算。
  }
}

/** 返回新对象，不改入参；最高分只升不降，得分 > 0 时记入已通关。 */
export function recordRun(
  state: ProgressState,
  layoutId: string,
  score: number
): ProgressState {
  const previous = state.best[layoutId];
  const best = {
    ...state.best,
    [layoutId]: previous === undefined ? score : Math.max(previous, score),
  };
  const cleared =
    score > 0 && !state.cleared.includes(layoutId)
      ? [...state.cleared, layoutId]
      : state.cleared.slice();
  return { best, cleared };
}

/** 第一个户型永远解锁；第 i 个户型要求前一个户型已 cleared。 */
export function isUnlocked(
  state: ProgressState,
  layoutIds: string[],
  layoutId: string
): boolean {
  const index = layoutIds.indexOf(layoutId);
  if (index < 0) return false;
  if (index === 0) return true;
  return state.cleared.includes(layoutIds[index - 1]);
}
