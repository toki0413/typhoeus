"""p28 分辨率诊断：把 54 m 降到 30 m，洼地能填上吗？

p27 的发现推翻了我原本的假设：
    6 处下穿立交里，5 处在 30 m DSM 上**有**洼地（邻域最大填洼 0.75–2.57 m），
    只有 1 处真没有。所以问题不是"DSM 表达不了"，而是
    **模型在 54 m 网格上把这些洼地平均掉了**。

本件直接检验：把网格从 resample=2（54 m）换成 resample=1（30 m），
下穿立交处的模型水深是否上升。

若上升 → 点位失真是**分辨率**问题，先加分辨率，不必上三维。
若不上升 → 才轮到"缺垂向维度"这个解释。

代价：格点数 ×4，内核耗时约 ×4。

用法：python -m typhoeus.resolution
"""

from __future__ import annotations

import argparse
import csv
import json
import time
from datetime import datetime
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SEED = ROOT / "data" / "seed"
OUT = ROOT / "out"

LON_MIN, LON_MAX = 121.550139, 121.699583
LAT_MIN, LAT_MAX = 29.840417, 29.919861


def _load(p: Path) -> list[dict]:
    with open(p, encoding="utf-8-sig") as f:
        return [{k.lstrip("\ufeff"): v for k, v in r.items()} for r in csv.DictReader(f)]


def _resize_rain(rain: np.ndarray, ny: int, nx: int) -> np.ndarray:
    """把缓存的降雨场双线性上采样到目标网格（雨是平滑场，上采样可接受）。"""
    if rain.shape[1:] == (ny, nx):
        return rain
    t, sy, sx = rain.shape
    yi = np.linspace(0, sy - 1, ny)
    xi = np.linspace(0, sx - 1, nx)
    y0 = np.floor(yi).astype(int).clip(0, sy - 1)
    y1 = np.minimum(y0 + 1, sy - 1)
    x0 = np.floor(xi).astype(int).clip(0, sx - 1)
    x1 = np.minimum(x0 + 1, sx - 1)
    wy = (yi - y0)[:, None]
    wx = (xi - x0)[None, :]
    a = rain[:, y0][:, :, x0]
    b = rain[:, y0][:, :, x1]
    c = rain[:, y1][:, :, x0]
    d = rain[:, y1][:, :, x1]
    return ((a * (1 - wx) + b * wx) * (1 - wy)
            + (c * (1 - wx) + d * wx) * wy).astype(rain.dtype)


def _run(resample: int, verbose: bool = True):
    """在给定重采样倍率下跑内核，返回 (峰值场, grid, 耗时)。"""
    from typhoeus import cli as CLI
    from typhoeus import config as CFG
    from typhoeus import data as D
    from typhoeus import kernel as K
    from typhoeus import observe as OB
    from typhoeus import rainsrc as RS

    cfg = CFG.Config()
    inp = D.load_all(cfg.l2.bbox, resample)
    rain, _ = RS.get_rainfall(inp.grid, stations=OB.load_rain_stations(),
                              use_cache=True, calibrate=cfg.l2.rain_calibrate,
                              verbose=False)
    rain = np.asarray(rain, dtype=float)
    ny, nx = inp.grid.shape[0], inp.grid.shape[1]
    if rain.shape[1:] != (ny, nx):
        if verbose:
            print(f"  降雨场 {rain.shape[1:]} → 上采样到 {(ny, nx)}", flush=True)
        rain = _resize_rain(rain, ny, nx)
    t0 = time.perf_counter()
    res = K.run(inp.grid, rain, CLI._kernel_params(cfg))
    el = time.perf_counter() - t0
    peak = np.asarray(res.depth).max(axis=0)
    if verbose:
        print(f"  resample={resample}: 网格 {peak.shape[0]}×{peak.shape[1]}  "
              f"格点 {peak.size:,}  内核 {el:.1f} s  全域峰值 {peak.max():.4f} m",
              flush=True)
    return peak, inp.grid, el


def build(outdir: str = "out", verbose: bool = True) -> dict:
    peaks = {}
    grids = {}
    times = {}
    for rs in (2, 1):
        peaks[rs], grids[rs], times[rs] = _run(rs, verbose)
    # 若内存吃紧只跑一档，至少保证有 resample=2
    if 1 not in peaks:
        return {}

    pts = _load(SEED / "flood_points_2021_infa.csv")
    rows = []
    for r in pts:
        try:
            x, y, obs = float(r["lon"]), float(r["lat"]), float(r["depth_m"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (LON_MIN <= x <= LON_MAX and LAT_MIN <= y <= LAT_MAX):
            continue
        rec = {"编号": r["point_id"], "名称": r["name"],
               "结构": r.get("structure_type", ""), "观测_m": obs}
        for rs in (2, 1):
            g = grids[rs]
            lon, lat = np.asarray(g.lon), np.asarray(g.lat)
            i = int(np.abs(lat - y).argmin())
            j = int(np.abs(lon - x).argmin())
            rec[f"模型_{rs}_m"] = round(float(peaks[rs][i, j]), 4)
        rec["提升"] = round(rec["模型_1_m"] - rec["模型_2_m"], 4)
        rows.append(rec)

    under = [r for r in rows if r["结构"] == "下穿立交"]
    n_up = sum(1 for r in under if r["提升"] > 1e-3)
    mae2 = float(np.mean(np.abs(np.array([r["模型_2_m"] for r in rows])
                                - np.array([r["观测_m"] for r in rows]))))
    mae1 = float(np.mean(np.abs(np.array([r["模型_1_m"] for r in rows])
                                - np.array([r["观测_m"] for r in rows]))))

    payload = {
        "名称": "分辨率诊断：54 m → 30 m 能否填上洼地",
        "生成时间": datetime.now().isoformat(timespec="seconds"),
        "问题": "点位失真，是分辨率不够还是缺垂向维度？",
        "设置": {"resample=2": "约 54 m（主链口径）", "resample=1": "约 30 m（DEM 原生）"},
        "代价": {"内核_s": {str(k): round(v, 1) for k, v in times.items()},
                 "格点数倍数": round(peaks[1].size / peaks[2].size, 2)},
        "全局": {"MAE_resample2_m": round(mae2, 4), "MAE_resample1_m": round(mae1, 4),
                 "MAE改善": round((mae2 - mae1) / mae2, 4) if mae2 else None},
        "下穿立交": {"处数": len(under), "提升的点数": n_up},
        "逐点": rows,
        "结论": (
            "提高分辨率使下穿立交水深上升 → 点位失真的首要原因是**分辨率**，"
            "应先加分辨率，不必上三维。"
            if n_up >= max(1, len(under) // 2) else
            "提高分辨率未能使下穿立交水深上升 → 分辨率不是主要原因，"
            "需进一步检验垂向维度（容器）解释。"
        ),
        "边界": [
            "resample=1 时格点数 ×4，内核耗时约 ×4；本件是诊断实验，不进主链。",
            "30 m 仍是 DSM 分辨率，真实下穿隧道宽约 5–8 m，仍低于可分辨尺度。",
            "两次运行除网格外其余参数相同，差异可归因于分辨率。",
            "观测水深为通报值（5 处下立交统一 0.50 m），可能被取整。",
        ],
    }
    p = Path(outdir)
    p.mkdir(parents=True, exist_ok=True)
    (p / "p28_分辨率诊断.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    if verbose:
        print(f"\n  MAE：54 m {mae2:.4f} → 30 m {mae1:.4f}"
              f"（改善 {(mae2-mae1)/mae2*100 if mae2 else 0:.1f}%）")
        print(f"  下穿立交 {len(under)} 处，提升 {n_up} 处：")
        for r in under:
            print(f"    {r['编号']} {r['名称'][:16]:<18} 54m {r['模型_2_m']:.4f}  "
                  f"30m {r['模型_1_m']:.4f}  提升 {r['提升']:+.4f}")
        print(f"  → {payload['结论']}")
        print(f"→ {p / 'p28_分辨率诊断.json'}")
    return payload


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="typhoeus.resolution")
    ap.add_argument("outdir", nargs="?", default="out")
    a = ap.parse_args(argv)
    build(a.outdir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
