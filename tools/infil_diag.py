"""入渗机制诊断：扫峰值雨强，对比 legacy 与 green_ampt。

用小网格（每 4 格抽 1）跑，主链的单次推演要 30 s+
（433格 × 433 步 × 3 次松弛迭代），诊断不需要全分辨率。

已实测的三组结论（36×68 网格，cell 214 m）：

1) legacy 的锁定效应（72 h 钟形雨场，面雨量 59→1179 mm）
   峰值mm/h:2    4     8     16    24    40
   入渗 mm  :49.2  54.6  58.3  59.4  59.8  60.0
   跨 12 倍雨量入渗只变 22%。衰减由地表水深驱动，与土壤状态无关。

2) 硬化面折减是必需的（72 h，imperv=0.75，有效容量 7.5 mm）
   θ0=0.45 下入渗 4.79–4.83 mm，饱和在强场次才起作用。
   不折减时（有效容量 30 mm）入渗被容量锁死在 20.2 mm，
   59 mm 与 1179 mm 雨场的入渗只差 0.04 mm——把整片城区当成了裸土农田。

3) θ0=0.75 会让机制失效
   有效容量 7.5 mm、θ0=0.75 时仅剩 1.875 mm 可吸，场次一开始土壤就饱和，
   吸力增益在所有场次恒为 0，Green-Ampt 退化成常数入渗。
   θ0=0.45 留 4.1 mm 余量，强弱场次才在增益上有区分。

用法：
  python tools/infil_diag.py                          # A/B，12 h
  python tools/infil_diag.py --hours 72# 12 倍雨量跨度
  python tools/infil_diag.py --theta0 0.45 --imperv 0.75
"""
from __future__ import annotations

import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from typhoeus import data as D
from typhoeus import kernel as K


def subgrid(inp: D.Inputs, step: int = 4):
    """抽稀网格。lat/lon 是一维坐标轴，elev 才是二维场。"""
    g = inp.grid
    sl = (slice(None, None, step), slice(None, None, step))
    return type("G", (), {
        "lat": np.asarray(g.lat)[::step],
        "lon": np.asarray(g.lon)[::step],
        "elev": np.asarray(g.elev)[sl],
        "cell_m": float(g.cell_m) * step,
    })()


def storm(peak: float, nt: int, dt_h: float, ny: int, nx: int) -> np.ndarray:
    """钟形雨场：峰值在 nt/3 处，宽度 nt/6。"""
    t = np.arange(nt) * dt_h
    shape = np.exp(-0.5 * ((t - nt * dt_h / 3.0) / (nt * dt_h / 6.0)) ** 2)
    return np.tile((peak * shape)[:, None, None], (1, ny, nx)).astype(np.float32)


def sweep(grid, kcfg: K.KernelParams, peaks, nt, dt_h, label=""):
    rows = []
    for peak in peaks:
        r = storm(peak, nt, dt_h, grid.lat.size, grid.lon.size)
        t0 = time.perf_counter()
        res = K.run(grid, r, kcfg)
        el = time.perf_counter() - t0
        b = res.budget_mm()
        row = {
            "peak_mm_h": peak,
            "rain_mm": round(b["降雨"], 2),
            "peak_depth_m": round(res.max_depth, 4),
            "infil_mm": round(b["下渗"], 3),
            "drain_mm": round(b["排水"], 2),
            "stored_mm": round(b["域内存量"], 3),
            "mass_resid": float(f"{res.mass_resid:.3e}"),
            "elapsed_s": round(el, 2),
        }
        if kcfg.infiltration_mode == "green_ampt":
            be = res.budget_energy()
            row["Ksat本底_mm"] = be["下渗_Ksat本底_mm"]
            row["吸力增益_mm"] = be["下渗_吸力增益_mm"]
            row["土壤蒸发_mm"] = be["土壤蒸发_mm"]
            row["储水变化_mm"] = be["土壤储水变化_mm"]
            row["饱和比例"] = be.get("根区饱和比例_期末")
            row["潜热激活"] = be.get("潜热激活步占比")
        rows.append(row)
        print(json.dumps(row, ensure_ascii=False), flush=True)
    return {"label": label, "mode": kcfg.infiltration_mode, "rows": rows}


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--modes", default="legacy,green_ampt")
    ap.add_argument("--peaks", default="2,4,8,16,24,40")
    ap.add_argument("--hours", type=float, default=12.0)
    ap.add_argument("--theta0", type=float, default=None)
    ap.add_argument("--ksat", type=float, default=None)
    ap.add_argument("--imperv", type=float, default=None)
    ap.add_argument("--cap", type=float, default=None)
    args = ap.parse_args()

    peaks = [float(x) for x in args.peaks.split(",")]
    inp = D.load_all()
    g = subgrid(inp, 4)
    print(f"# grid {g.lat.size}x{g.lon.size} cell={g.cell_m:.0f}m "
          f"window={args.hours}h", flush=True)

    all_out = []
    for mode in args.modes.split(","):
        kw = {}
        if mode == "green_ampt":
            if args.theta0 is not None:
                kw["soil_theta0"] = args.theta0
            if args.ksat is not None:
                kw["soil_ksat_m_h"] = args.ksat
            if args.imperv is not None:
                kw["impervious_frac"] = args.imperv
            if args.cap is not None:
                kw["soil_capacity_mm"] = args.cap
        kc = K.KernelParams(dt_s=600.0, max_t_h=args.hours,
                            infiltration_mode=mode, **kw)
        nt = int(kc.max_t_h * 3600 / kc.dt_s) + 1
        all_out.append(sweep(g, kc, peaks, nt, kc.dt_s / 3600.0, label=mode))

    json.dump(all_out, sys.stdout, ensure_ascii=False, indent=1)