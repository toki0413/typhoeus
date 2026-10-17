"""集合分位数稳定性实测：成员数要多少，p90 才不再靠运气。

先复现归档读数（`out/01_preset_plan.json` 的四个分位），复现不上就
停止并报错——这条 harness 只有在能复算主链数字时才有资格谈稳定性。
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    import os
    os.environ.setdefault(_v, "2")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import numpy as np  # noqa: E402

from typhoeus import cli as CLI  # noqa: E402
from typhoeus import config as CFG  # noqa: E402
from typhoeus import data as D  # noqa: E402
from typhoeus import measure as M  # noqa: E402
from typhoeus import observe as OB  # noqa: E402
from typhoeus import rainsrc as RS  # noqa: E402


def main() -> int:
    art = json.loads((ROOT / "out" / "01_preset_plan.json").read_text(encoding="utf-8"))
    shipped = art["台风测度"]
    cfg = CFG.Config()
    t0 = time.time()
    inputs = D.load_all(cfg.l2.bbox, cfg.l4.resample)
    rain, _ = RS.get_rainfall(inputs.grid, stations=OB.load_rain_stations(),
                              use_cache=True, calibrate=True, verbose=False)
    kcfg = CLI._kernel_params(cfg)
    print(f"[载入] {time.time()-t0:.1f} s", flush=True)

    base = M.estimate(inputs.track, grid=inputs.grid, kcfg=kcfg, rain_field=rain,
                      cfg=M.MeasureParams())
    now = base.joint_quantile
    ok = all(abs(now[k] - shipped[k]) < 0.05 for k in shipped)
    print(f"[自检] 主链复现 {'一致' if ok else '不一致'}：现 {now} 归档 {shipped}",
          flush=True)
    if not ok:
        print("[停止] 复现不上归档读数，后面的稳定性结论没有根据", flush=True)
        return 1

    ref = float(np.quantile(np.array(sorted(
        x["rain72_mm"] for x in M.estimate(
            inputs.track, grid=inputs.grid, kcfg=kcfg, rain_field=rain,
            cfg=M.MeasureParams(n_members=20000, seed=777)).members)), 0.90))
    print(f"[参照] 20000 成员的 p90 = {ref:.2f} mm", flush=True)

    rows = []
    for n in (5, 10, 20, 50, 100, 200, 1000):
        vals = []
        for s in range(40):
            mo = M.estimate(inputs.track, grid=inputs.grid, kcfg=kcfg,
                            rain_field=rain,
                            cfg=M.MeasureParams(n_members=n, seed=1000 + s))
            vals.append(mo.joint_quantile["p90"])
        v = np.array(vals)
        rel = np.abs(v - ref) / ref * 100.0
        rows.append({"n_members": n, "p90_mean_mm": round(float(v.mean()), 2),
                     "p90_sd_mm": round(float(v.std(ddof=1)), 2),
                     "p90_min_mm": round(float(v.min()), 2),
                     "p90_max_mm": round(float(v.max()), 2),
                     "rel_err_mean_pct": round(float(rel.mean()), 2),
                     "rel_err_p95_pct": round(float(np.quantile(rel, 0.95)), 2),
                     "frac_within_5pct": round(float((rel < 5.0).mean()), 3)})
        print(f"[n={n:>5}] p90 {v.mean():.1f}±{v.std(ddof=1):.1f} mm  "
              f"对参照偏差中位 {np.median(rel):.1f}%  "
              f"5% 以内占比 {(rel<5).mean()*100:.0f}%", flush=True)

    out = {"reference_p90_mm": round(ref, 2), "replicates": 40,
           "reproduces_archive": bool(ok), "archive_quantiles": shipped,
           "rows": rows,
           "note": ("参照 p90 由 20000 成员的一次抽样给出；每档成员数重抽 40 次。"
                    "判读口径：5% 以内占比 ≥0.95 视为该档可用。"),
           "elapsed_s": round(time.time() - t0, 1)}
    p = ROOT / "out" / "ensemble_stability.json"
    p.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    usable = [r["n_members"] for r in rows if r["frac_within_5pct"] >= 0.95]
    print(f"[结论] 满足 5% 以内占比 ≥95% 的最小成员数：{min(usable) if usable else '无档满足'}",
          flush=True)
    print(f"[落盘] {p}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
