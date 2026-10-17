"""单因子实验：涝点坐标的 ±100 m 误差，值多少覆盖率。

动机：OSM 地名匹配给出的位移中位数是 1260 m（同名不同处，不可用），
而台账本身标注的误差是 ±100 m。这两件事混在一起会得出错误结论——
"补坐标就能把覆盖率从 29.4% 拉到 47%"这句话从没被单独验过。

做法：内核只跑一次，拿到峰值水深场后，把 17 个点的坐标各自按
均匀圆盘扰动到 ±R 米，重复 N 组，统计覆盖率与命中率的分布。
纯采样计算（不重跑内核），所以几千组也只是几秒。

判据写成两分支，免得跑完还要靠解释：
  若波动带覆盖 47% → M1 这个目标由坐标误差就能达到，值得投 F2；
  若波动带窄且远离 47% → 坐标不是那把钥匙，F2 的收益必须重估，
     瓶颈留在"地形没有那个凹陷"与"管网没有建模"。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

for _v in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
M1_TARGET = 0.47


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--groups", type=int, default=4000)
    ap.add_argument("--radius-m", type=float, default=100.0)
    ap.add_argument("--seed", type=int, default=20261016)
    ap.add_argument("--out", default=str(ROOT / "out_cloud" / "coord_sensitivity.json"))
    a = ap.parse_args()

    import numpy as np
    from typhoeus import config as CFG, data as D, kernel as K, observe as OB, rainsrc as RS

    cfg = CFG.Config()
    bb = cfg.l2.bbox
    t0 = time.time()
    inputs = D.load_all(bb, cfg.l4.resample)
    rain, rep = RS.get_rainfall(inputs.grid, stations=OB.load_rain_stations(),
                                use_cache=True, calibrate=True, verbose=False)
    res = K.run(inputs.grid, rain, K.KernelParams(
        drainage_invert_m=cfg.l2.drainage_invert_m,
        drainage_coeff_m_s=cfg.l2.drainage_coeff_m_s,
        infiltration_mode=cfg.l2.infiltration_mode))
    peak = res.depth.max(axis=0)
    risk = peak / max(float(peak.max()), 1e-9)
    print(f"[内核] 一次跑完 {time.time()-t0:.0f} s  峰值 {res.max_depth:.4f} m  "
          f"驱动={rep['driver']}", flush=True)

    pts = [p for p in OB.load_flood_points()
           if not p.is_synthetic and bb["lon_min"] <= p.lon <= bb["lon_max"]
           and bb["lat_min"] <= p.lat <= bb["lat_max"]]
    print(f"[基线] 域内非合成 {len(pts)} 点", flush=True)

    cov0 = OB.coverage(risk, pts, inputs.grid, bb, res.depth)
    acc0 = OB.depth_accuracy(res.depth, pts, inputs.grid, bb)
    print(f"[基线] 覆盖率 {cov0['n_hit']}/{cov0['n_total']} = {(cov0['rate'] or 0)*100:.1f}%  "
          f"命中率 {(acc0['rate'] or 0)*100:.1f}%  MAE {acc0['mae_m']} m", flush=True)

    # 采样一次水深场，之后纯查表：扰动只改"取哪个像元"
    g = np.random.default_rng(a.seed)
    lon0, lat0 = pts[0].lon, pts[0].lat
    kx = 1.0 / (111320.0 * np.cos(np.radians(lat0)))
    ky = 1.0 / 110540.0
    lon_arr = np.asarray(inputs.grid.lon)
    lat_arr = np.asarray(inputs.grid.lat)
    cell = inputs.grid.cell_m

    order = np.argsort(-risk.ravel())[:int(0.2 * risk.size)]
    hi = set(zip(*np.unravel_index(order, risk.shape)))
    lv = lambda x: int(np.searchsorted([0.1, 0.2, 0.5], x, side="right"))

    def rate_at(dls, dla):
        hits, same = 0, 0
        for p, (dx, dy) in zip(pts, zip(dls, dla)):
            j = int(np.argmin(np.abs(lon_arr - (p.lon + dx * kx))))
            i = int(np.argmin(np.abs(lat_arr - (p.lat + dy * ky))))
            if (i, j) in hi:
                hits += 1
            same += int(lv(p.depth_m) == lv(float(peak[i, j])))
        return hits / len(pts), same / len(pts)

    ang = g.uniform(0, 2 * np.pi, size=(a.groups, len(pts)))
    rad = a.radius_m * np.sqrt(g.uniform(0, 1, size=(a.groups, len(pts))))
    dls, dla = rad * np.cos(ang), rad * np.sin(ang)
    t1 = time.time()
    covs, hits = [], []
    for k in range(a.groups):
        c, h = rate_at(dls[k], dla[k])
        covs.append(c)
        hits.append(h)
    covs = np.asarray(covs)
    hits = np.asarray(hits)
    q = lambda x, p: round(float(np.quantile(x, p)), 4)
    print(f"[扫描] {a.groups} 组 × {len(pts)} 点，用时 {time.time()-t1:.1f} s", flush=True)
    print(f"[结果] 覆盖率 扰动后中位 {q(covs,.5)*100:.1f}%  "
          f"[p5 {q(covs,.05)*100:.1f}%, p95 {q(covs,.95)*100:.1f}%]  "
          f"基线 {(cov0['rate'] or 0)*100:.1f}%（扰动中心与台账坐标略有取整差）", flush=True)
    print(f"[结果] 命中率 扰动后中位 {q(hits,.5)*100:.1f}% "
          f"[p5 {q(hits,.05)*100:.1f}%, p95 {q(hits,.95)*100:.1f}%]", flush=True)
    crosses = bool(q(covs, .95) >= M1_TARGET)
    print(f"[判据] ±{a.radius_m:.0f} m 坐标扰动的 95% 分位是否达到 M1={M1_TARGET*100:.0f}%："
          f"{'达到 → 值得先投 F2' if crosses else '达不到 → 坐标不是钥匙，瓶颈在凹陷地形与管网'}", flush=True)

    out = {"kernel_peak_m": round(res.max_depth, 4), "driver": rep["driver"],
           "n_points": len(pts), "baseline_coverage": cov0["rate"],
           "baseline_hit": acc0["rate"], "radius_m": a.radius_m, "groups": a.groups,
           "coverage_quantiles": {f"p{int(p*100)}": q(covs, p) for p in (.05, .25, .5, .75, .95)},
           "hit_quantiles": {f"p{int(p*100)}": q(hits, p) for p in (.05, .25, .5, .75, .95)},
           "m1_target": M1_TARGET, "p95_reaches_m1": crosses,
           "wall_s": round(time.time() - t0, 1)}
    p = Path(a.out)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    back = json.loads(p.read_text(encoding="utf-8"))
    assert back["groups"] == a.groups and back["n_points"] == len(pts), "读回不一致"
    print(f"[落盘] {p}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
