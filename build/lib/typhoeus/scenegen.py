"""情景族生成器：JEPA 路线 A 的第 1 步。

用途：JEPA 需要大量轨迹做自监督预训练。内核可无限生成，因此**不需要观测**。

每场情景：
  - 降雨：以 ERA5 事件场为基准，施加四类扰动
      scale  (0.75–1.40) 强度缩放
      shift_h (-6..+6)   时间平移（按步滚动）
      amp_h  (0.8–1.2)   峰值增强（钟形窗加权）
      jitter (0.9–1.1)   逐时随机扰动（固定种子）
  - 运行图守恒律内核，保存**每小时**的降雨场与水深场（float16）

落盘：data/jepa/scen_XXXX.npz  { rain (T,ny,nx), depth (T,ny,nx) }
      data/jepa/index.json      每场参数与统计

用法：
  python -m typhoeus.scenegen --n 60
  python -m typhoeus.scenegen --n 200 --workers 1
"""

from __future__ import annotations

import argparse
import json
import time
from datetime import datetime
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "jepa"


def build_scenario(base_rain: np.ndarray, rng: np.random.Generator) -> tuple[np.ndarray, dict]:
    """对基准雨场施加扰动，返回 (新雨场, 参数)。"""
    scale = float(rng.uniform(0.75, 1.40))
    shift = int(rng.integers(-36, 37))          # ±6 h（10 分钟步长下 6*6=36 步）
    amp = float(rng.uniform(0.80, 1.20))
    jit_amp = float(rng.uniform(0.90, 1.10))

    rain = base_rain.astype("float32") * scale
    if shift:
        rain = np.roll(rain, shift, axis=0)
        if shift > 0:
            rain[:shift] = 0.0
        else:
            rain[shift:] = 0.0
    # 钟形窗增强峰值：以时间轴中点为峰
    n = rain.shape[0]
    t = np.linspace(-1.0, 1.0, n)[:, None, None]
    win = np.exp(-(t ** 2) * 2.0)
    rain = rain * (1.0 + (amp - 1.0) * win)
    # 逐时抖动（注意 jit_amp 可能 <1，须先排序否则 low>high）
    lo, hi = sorted((1.0 / jit_amp, jit_amp))
    jit = rng.uniform(lo, hi, size=(n, 1, 1)).astype("float32")
    rain = rain * jit
    return np.maximum(rain, 0.0), {"scale": round(scale, 4), "shift_steps": shift,
                                   "amp": round(amp, 4), "jitter": round(jit_amp, 4)}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="typhoeus.scenegen")
    ap.add_argument("--n", type=int, default=60)
    ap.add_argument("--seed", type=int, default=20261017)
    ap.add_argument("--hourly", action="store_true", default=True,
                    help="按小时抽样保存（默认开）")
    a = ap.parse_args(argv)

    from typhoeus import cli as CLI
    from typhoeus import config as CFG
    from typhoeus import data as D
    from typhoeus import kernel as K
    from typhoeus import observe as OB
    from typhoeus import rainsrc as RS

    cfg = CFG.Config()
    inp = D.load_all(cfg.l2.bbox, cfg.l4.resample)
    base, rep = RS.get_rainfall(inp.grid, stations=OB.load_rain_stations(),
                                use_cache=True, calibrate=cfg.l2.rain_calibrate,
                                verbose=False)
    base = np.asarray(base, dtype="float32")
    kp = CLI._kernel_params(cfg)
    step_h = kp.dt_s / 3600.0
    per_hour = max(1, int(round(1.0 / step_h)))       # 每小时步数
    print(f"基准雨场 {base.shape}，步长 {step_h:.4f} h，每小时 {per_hour} 步")
    print(f"计划生成 {a.n} 场，每小时抽样保存 {base.shape[0] // per_hour + 1} 帧")

    OUT.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(a.seed)
    index = []
    t_all = time.time()

    for i in range(a.n):
        rain, params = build_scenario(base, rng)
        t0 = time.perf_counter()
        res = K.run(inp.grid, rain, kp)
        elapsed = time.perf_counter() - t0
        depth = np.asarray(res.depth, dtype="float32")
        # 每小时抽样
        idx = np.arange(0, depth.shape[0], per_hour)
        rain_h = rain[idx].astype("float16")
        depth_h = depth[idx].astype("float16")
        f = OUT / f"scen_{i:04d}.npz"
        np.savez_compressed(f, rain=rain_h, depth=depth_h)
        rec = {
            "file": f.name, "i": i, **params,
            "面雨量_mm": round(float(rain.mean(axis=(1, 2)).sum() * step_h), 2),
            "峰值水深_m": round(float(depth.max()), 4),
            "潮湿格点占比_0.05m": round(float((depth.max(axis=0) >= 0.05).mean()), 4),
            "守恒残差": float(res.mass_resid),
            "求解_s": round(elapsed, 2),
            "帧数": int(len(idx)),
        }
        index.append(rec)
        if (i + 1) % 5 == 0 or i == a.n - 1:
            el = time.time() - t_all
            print(f"  {i+1}/{a.n}  面雨量 {rec['面雨量_mm']:.0f} mm  "
                  f"峰值 {rec['峰值水深_m']:.3f} m  "
                  f"{(i+1)/el*60:.1f} 场/分钟", flush=True)

    (OUT / "index.json").write_text(json.dumps({
        "生成时间": datetime.now().isoformat(timespec="seconds"),
        "场次数": len(index),
        "参数分布": {
            "scale": [min(r["scale"] for r in index), max(r["scale"] for r in index)],
            "amp": [min(r["amp"] for r in index), max(r["amp"] for r in index)],
        },
        "每小时帧数": int(len(idx)),
        "网格": [int(depth_h.shape[1]), int(depth_h.shape[2])],
        "情景": index,
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    total_mb = sum(f.stat().st_size for f in OUT.glob("scen_*.npz")) / 1e6
    print(f"\n完成 {len(index)} 场，{total_mb:.0f} MB，用时 {(time.time()-t_all)/60:.1f} min")
    print(f"→ {OUT/'index.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
