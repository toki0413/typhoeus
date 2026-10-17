"""量级包络网格（并行版）。

父进程只读一次 DEM 与降雨场，再用 fork 把这份只读数据交给各 worker
（Linux 下 copy-on-write，21 次运行不再各自重读 43 MB 地形与再分析缓存）。
每个格子写一份分片 JSON，最后合并成一个包络件。

为什么这个活值得吃核：PRD 的 F1 要把"绝对水深"换成"区间 + 驱动指纹"，
区间必须由真实扫描给出，而扫描是 7×3=21 次独立推演——串行 20 分钟，
128 核上是一分钟量级。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

for _v in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

COEFF_MULT = (0.125, 0.25, 0.5, 1.0, 2.0, 4.0, 8.0)
INVERTS = (0.0, 0.05, 0.15)

_CTX: dict = {}


def _prepare() -> None:
    from typhoeus import config as CFG, data as D, kernel as K, observe as OB, rainsrc as RS

    cfg = CFG.Config()
    inputs = D.load_all(cfg.l2.bbox, cfg.l4.resample)
    rain, rep = RS.get_rainfall(inputs.grid, stations=OB.load_rain_stations(),
                                use_cache=True, calibrate=True, verbose=False)
    _CTX.update(cfg=cfg, inputs=inputs, rain=rain, rep=rep, pts=OB.load_flood_points(),
                base=K.KernelParams(drainage_invert_m=cfg.l2.drainage_invert_m,
                                    drainage_coeff_m_s=cfg.l2.drainage_coeff_m_s,
                                    infiltration_mode=cfg.l2.infiltration_mode))


def _cell(job):
    from typhoeus import kernel as K, observe as OB
    from typhoeus import config as CFG  # noqa: F401

    cm, inv = job
    cfg, inputs, rain, pts, bb = (_CTX["cfg"], _CTX["inputs"], _CTX["rain"],
                                  _CTX["pts"], _CTX["cfg"].l2.bbox)
    kc = K.KernelParams(**{**_CTX["base"].__dict__,
                           "drainage_coeff_m_s": _CTX["base"].drainage_coeff_m_s * cm,
                           "drainage_invert_m": inv})
    t0 = time.time()
    try:
        res = K.run(inputs.grid, rain, kc)
    except Exception as e:  # noqa: BLE001  触顶会被内核主动拒绝
        return {"coeff_x": cm, "invert_m": inv, "raised": f"{type(e).__name__}: {str(e)[:60]}"}
    acc = OB.depth_accuracy(res.depth, pts, inputs.grid, bb)
    cov = OB.coverage(res.depth.max(axis=0) / max(float(res.depth.max()), 1e-9),
                      pts, inputs.grid, bb, res.depth)
    b = res.budget_mm()
    peak = res.depth.max(axis=0)
    return {"coeff_x": cm, "invert_m": inv,
            "peak_depth_m": round(res.max_depth, 4),
            "drain_share": round(b["排水"] / max(b["降雨"], 1e-9), 4),
            "infil_mm": round(b["下渗"], 2),
            "red_area_frac": round(float((peak >= 0.5).mean()), 5),
            "hit_rate": acc.get("rate"), "mae_m": acc.get("mae_m"),
            "coverage": cov.get("rate"), "n_hit": cov.get("n_hit"),
            "n_below_0.05m": sum(1 for i in acc.get("items", []) if i["model_depth_m"] < 0.05),
            "mass_resid": res.mass_resid, "wall_s": round(time.time() - t0, 1)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--jobs", type=int, default=21)
    ap.add_argument("--out", default=str(ROOT / "out_cloud" / "envelope_grid.json"))
    a = ap.parse_args()

    print("[准备] 读 DEM 与降雨场一次，之后 fork 复用", flush=True)
    _prepare()
    rep = _CTX["rep"]
    print(f"[准备] 网格 {_CTX['inputs'].grid.shape} cell={_CTX['inputs'].grid.cell_m:.1f} m "
          f"驱动={rep['driver']} 面雨量={rep['grid_accum_mm']:.1f} mm", flush=True)

    jobs = [(cm, inv) for cm in COEFF_MULT for inv in INVERTS]
    t0 = time.time()
    rows = []
    with ProcessPoolExecutor(max_workers=min(a.jobs, len(jobs))) as ex:
        for r in ex.map(_cell, jobs):
            rows.append(r)
            print(f"[格] coeff×{r['coeff_x']:<6} invert{r['invert_m']:<5} "
                  + (f"raise {r['raised']}" if "raised" in r else
                     f"peak {r['peak_depth_m']:.3f} m  drain {r['drain_share']:.3f}  "
                     f"hit {r['hit_rate']}  cov {r['coverage']}  {r['wall_s']}s"), flush=True)

    ok = [r for r in rows if "peak_depth_m" in r]
    peaks = [r["peak_depth_m"] for r in ok]
    covs = sorted({r["coverage"] for r in ok})
    hits = sorted({r["hit_rate"] for r in ok})
    out = {"driver": rep["driver"], "areal_mm": round(rep["grid_accum_mm"], 1),
           "n_cells_ok": len(ok), "n_cells_raise": len(rows) - len(ok),
           "peak_min_m": min(peaks), "peak_max_m": max(peaks),
           "coverage_values": covs, "hit_rate_values": hits,
           "wall_s_total": round(time.time() - t0, 1),
           "grid": [list(_CTX["inputs"].grid.shape), round(_CTX["inputs"].grid.cell_m, 1)],
           "rows": rows}
    p = Path(a.out)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    back = json.loads(p.read_text(encoding="utf-8"))
    assert back["n_cells_ok"] == len(ok), "读回的分片数与写入不一致"
    print(f"[完成] {len(ok)}/{len(jobs)} 格成功（其余被内核主动拒绝），峰值带宽 "
          f"{min(peaks):.3f}–{max(peaks):.3f} m，覆盖率取值 {covs}，"
          f"命中率取值 {hits}，总墙钟 {out['wall_s_total']} s → {p}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
