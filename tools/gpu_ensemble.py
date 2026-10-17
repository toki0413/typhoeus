"""集合分位数的稳定性实测（GPU 上的蒙特卡洛）。

照抄 typhoeus/measure.py:114-135 的成员生成式，不另起模型：
    rel = U(cc_ci_low, cc_ci_high) / mid_cc
    jitter = clip(rel, 0.85, 1.15)
    rain72 = base_rain72 * jitter ** 1.4
    分位数 = sorted(members)[int(q * n)]      # 现口径用截断索引

要回答的两个问题，都是产物里已经暴露的：
  1) `01_preset_plan.json` 里 p80=p90=p95=251.6 是 bug 还是口径？
  2) 要让这三档真的分开、且 p90/p95 的抽样误差进到 ±2 mm，成员数得多少？

注意这条改的是什么、不改的是什么：成员数放大修的是**分位数不稳**，
修不了"这个 ±15% 截断扰动没有实测依据"——后者仍是先验，见输出里的两端堆积占比。
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent


def shipped_quantiles(base: float, lo: float, hi: float, n: int) -> tuple[dict, list]:
    """逐行复刻 measure.py:114-135 的成员生成式与截断索引取法。"""
    rng = np.random.default_rng(20210725)
    mid = 0.5 * (lo + hi)
    vals = []
    for _ in range(n):
        rel = rng.uniform(lo, hi) / max(mid, 1e-6)
        jitter = float(np.clip(rel, 0.85, 1.15))
        vals.append(base * jitter ** 1.4)
    vals.sort()
    return {f"p{int(q*100)}": round(vals[min(n - 1, int(q * n))], 1)
            for q in (0.5, 0.8, 0.9, 0.95)}, vals


def gpu_mc(base: float, lo: float, hi: float, n_members: int, n_rep: int, dev: str) -> dict:
    """GPU 上重复抽样 n_rep 组、每组 n_members 个成员，统计各分位数的分布。"""
    import torch
    g = torch.Generator(device=dev)
    g.manual_seed(7)
    mid = 0.5 * (lo + hi)
    t0 = time.time()
    out = {}
    with torch.no_grad():
        u = torch.empty((n_rep, n_members), device=dev).uniform_(lo, hi, generator=g)
        jitter = (u / mid).clamp(0.85, 1.15)
        rain = base * jitter.pow(1.4)
        srt, _ = torch.sort(rain, dim=1)
        idx = {q: min(n_members - 1, int(q * n_members)) for q in (0.5, 0.8, 0.9, 0.95)}
        for q, i in idx.items():
            col = srt[:, i]
            out[f"p{int(q*100)}"] = {
                "mean": round(float(col.mean()), 2),
                "sd": round(float(col.std()), 3),
                "q025": round(float(torch.quantile(col, 0.025)), 2),
                "q975": round(float(torch.quantile(col, 0.975)), 2),
                "index_used": i,
            }
        # 边界堆积：jitter 落在 clip 上下界的比例
        out["clipped_low_frac"] = round(float((jitter <= 0.85 + 1e-9).float().mean()), 4)
        out["clipped_high_frac"] = round(float((jitter >= 1.15 - 1e-9).float().mean()), 4)
        out["distinct_p80_p90_p95"] = bool(len({idx[0.8], idx[0.9], idx[0.95]}) == 3)
    out["wall_s"] = round(time.time() - t0, 2)
    out["n_rep"] = n_rep
    out["n_members"] = n_members
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", type=float, default=0.0,
                    help="base_rain72_mm；为 0 时从仓内 out/05 或 CLI 现算")
    ap.add_argument("--device", default="cuda")
    ap.add_argument("--rep", type=int, default=20000)
    ap.add_argument("--out", default=str(ROOT / "out_cloud" / "ensemble_stability.json"))
    a = ap.parse_args()

    import torch
    dev = a.device if torch.cuda.is_available() else "cpu"
    if dev == "cpu" and a.device == "cuda":
        print("[warn] CUDA 不可用，退回 CPU（结果同口径，只是慢）", flush=True)

    import sys
    sys.path.insert(0, str(ROOT))
    from typhoeus import config as CFG
    from typhoeus.measure import MeasureParams

    cfg = CFG.Config()
    mp = MeasureParams()
    lo = float(getattr(cfg.l3, "cc_ci_low", mp.cc_ci_low))
    hi = float(getattr(cfg.l3, "cc_ci_high", mp.cc_ci_high))
    n0 = int(getattr(cfg.l3, "n_members", mp.n_members))
    print(f"[口径] cc 区间 [{lo}, {hi}]  现用成员数 n={n0}"
          f"{'（取自 L3）' if hasattr(cfg.l3, 'n_members') else '（L3 无该项，取 MeasureParams 默认）'}",
          flush=True)

    base = a.base
    if not base:
        from typhoeus import data as D, kernel as K, observe as OB, rainsrc as RS
        inputs = D.load_all(cfg.l2.bbox, cfg.l4.resample)
        rain, rep = RS.get_rainfall(inputs.grid, stations=OB.load_rain_stations(),
                                    use_cache=True, calibrate=True, verbose=False)
        kcfg = K.KernelParams(drainage_invert_m=cfg.l2.drainage_invert_m,
                              drainage_coeff_m_s=cfg.l2.drainage_coeff_m_s,
                              infiltration_mode=cfg.l2.infiltration_mode)
        base = float(rain.mean(axis=(1, 2)).sum() * kcfg.dt_s / 3600.0)
        print(f"[base] 现算面雨量基线 {base:.1f} mm（驱动={rep['driver']}）", flush=True)

    ship, vals = shipped_quantiles(base, lo, hi, n0)
    print(f"[现口径 n={n0}] {ship}  ← 与 out/01 的 p80=p90=p95 对照", flush=True)

    scan = {}
    for n in (n0, 10, 20, 40, 100, 400):
        r = gpu_mc(base, lo, hi, n, a.rep, dev)
        scan[n] = r
        p90, p95 = r["p90"], r["p95"]
        print(f"[n={n:>4}] p80 {r['p80']['mean']:.1f}±{r['p80']['sd']:.2f} | "
              f"p90 {p90['mean']:.1f}±{p90['sd']:.2f} | p95 {p95['mean']:.1f}±{p95['sd']:.2f} | "
              f"三档索引互不相同={r['distinct_p80_p90_p95']} | 截断到下界 {r['clipped_low_frac']*100:.1f}% "
              f"上界 {r['clipped_high_frac']*100:.1f}% | {r['wall_s']} s", flush=True)

    need = next((n for n, r in scan.items()
                 if r["distinct_p80_p90_p95"] and r["p90"]["sd"] <= 2.0
                 and r["p95"]["sd"] <= 2.0), None)
    out = {"base_rain72_mm": round(base, 1), "cc_ci": [lo, hi], "n_members_now": n0,
           "shipped_like": ship, "shipped_values_used": [round(v, 2) for v in vals],
           "scan": scan, "n_needed_for_pm2mm": need,
           "note": "放大成员数只修分位数不稳，不修 ±15% 截断扰动的先验性质；"
                   "两端堆积占比就是该先验没有实测支撑的直接读数",
           "device": dev, "n_rep": a.rep}
    p = Path(a.out)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    back = json.loads(p.read_text(encoding="utf-8"))
    assert back["base_rain72_mm"] == out["base_rain72_mm"], "读回不一致"
    print(f"[结论] 现 n={n0} 时三档索引相同={not scan[n0]['distinct_p80_p90_p95']}；"
          f"要 p90 与 p95 的抽样误差都收到 ±2 mm 以内，成员数至少 {need}", flush=True)
    print(f"[落盘] {p}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
