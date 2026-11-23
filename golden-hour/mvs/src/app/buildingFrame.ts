/** 每帧回调：更新模拟、渲染场景、节流刷新 HUD。 */
export interface FrameScene {
  /** 可变步长更新：移动输入、固定步推进、结算判定。 */
  update(dt: number): void;
  /** 每帧渲染：场景同步与性能面板。 */
  render(dt: number): void;
  /** 节流后的 HUD 刷新（默认约 10Hz）。 */
  hud(now: number): void;
}

export interface FrameOptions {
  /** 单帧最大步长，避免切后台回来一次性推进。 */
  maxDt?: number;
  /** HUD 刷新间隔（毫秒）。 */
  hudIntervalMs?: number;
  raf?: (callback: (time: number) => void) => number;
  now?: () => number;
}

/** 主循环句柄：停止排帧，或读档后重置计时基准。 */
export interface FrameHandle {
  stop(): void;
  reset(): void;
}

/** 启动主循环；返回句柄，便于测试、读档重置和页面销毁。 */
export function startBuildingFrame(scene: FrameScene, options: FrameOptions = {}): FrameHandle {
  const maxDt = options.maxDt ?? 0.05;
  const hudIntervalMs = options.hudIntervalMs ?? 100;
  const raf = options.raf ?? ((callback) => requestAnimationFrame(callback));
  const now = options.now ?? (() => performance.now());

  let last = now();
  let lastHud = 0;
  let stopped = false;

  const tick = (time: number): void => {
    if (stopped) return;
    const dt = Math.min(maxDt, (time - last) / 1000);
    last = time;
    scene.update(dt);
    scene.render(dt);
    if (time - lastHud > hudIntervalMs) {
      lastHud = time;
      scene.hud(time);
    }
    raf(tick);
  };

  raf(tick);
  return {
    stop() {
      stopped = true;
    },
    reset() {
      last = now();
      lastHud = 0;
    },
  };
}
