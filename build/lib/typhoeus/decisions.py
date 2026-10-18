"""p19 中断代价加权排序 + p20 决策稳定性。

p19：不按"水最深"排，按"深度 × 该类生命线的真实中断时长"排。
     中断时长取自 2021 烟花 10 条真实断供通报（restored_at − start_at）。

p20：决策稳定性。同一决策规则在不同情景下是否给出同一结论？
     对每个涝点，在 p50–p95 四档情景下求峰值水深；
     决策翻转带 = [min, max]。阈值落在此带内的点，结论随情景改变 → 不稳定。

用法：python -m typhoeus.decisions
"""

from __future__ import annotations

import argparse
import csv
import json
from datetime import datetime
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SEED = ROOT / "data" / "seed"
OUT = ROOT / "out"

LON_MIN, LON_MAX = 121.550139, 121.699583
LAT_MIN, LAT_MAX = 29.840417, 29.919861
SCENARIOS = [("p50", 258.4), ("p80", 313.2), ("p90", 338.8), ("p95", 354.1)]
DECISION_THRESHOLDS = [0.10, 0.15, 0.20, 0.27, 0.30, 0.40, 0.50]

# 结构类型 → 受影响的生命线类别
STRUCT_TO_LIFELINE = {
    "下穿立交": ["道路封道"],
    "低洼路段": ["道路封道"],
    "低洼小区": ["电梯停梯", "配电停供"],
}


def _load(p: Path) -> list[dict]:
    with open(p, encoding="utf-8-sig") as f:
        return [{k.lstrip("\ufeff"): v for k, v in r.items()} for r in csv.DictReader(f)]


def _duration_priors() -> dict:
    """从真实断供通报算各类别中断时长（小时）的中位与分布。"""
    from collections import defaultdict
    by = defaultdict(list)
    for r in _load(SEED / "service_outages_2021_infa.csv"):
        try:
            s = datetime.strptime(r["start_at"], "%Y-%m-%d %H:%M")
            e = datetime.strptime(r["restored_at"], "%Y-%m-%d %H:%M")
        except (KeyError, ValueError):
            continue
        h = (e - s).total_seconds() / 3600.0
        if h > 0:
            by[r["category"]].append(h)
    out = {}
    for k, v in by.items():
        out[k] = {"样本数": len(v), "中位_h": round(float(np.median(v)), 2),
                  "最小_h": round(min(v), 2), "最大_h": round(max(v), 2)}
    return out


def build(outdir: str = "out", verbose: bool = True) -> dict:
    from typhoeus import cli as CLI
    from typhoeus import config as CFG
    from typhoeus import data as D
    from typhoeus import kernel as K
    from typhoeus import observe as OB
    from typhoeus import rainsrc as RS

    cfg = CFG.Config()
    inp = D.load_all(cfg.l2.bbox, cfg.l4.resample)
    base, _ = RS.get_rainfall(inp.grid, stations=OB.load_rain_stations(),
                              use_cache=True, calibrate=cfg.l2.rain_calibrate,
                              verbose=False)
    base = np.asarray(base, dtype=float)
    base_mm = float(base.mean(axis=(1, 2)).sum() * cfg.l4.dt_s / 3600.0)
    kp = CLI._kernel_params(cfg)
    lon, lat = np.asarray(inp.grid.lon), np.asarray(inp.grid.lat)

    # 四档情景各跑一次，保留逐格峰值场
    peaks = {}
    for name, target in SCENARIOS:
        scale = target / base_mm if base_mm else 1.0
        res = K.run(inp.grid, base * scale, kp)
        peaks[name] = np.asarray(res.depth).max(axis=0)
        if verbose:
            print(f"  {name}: 目标 {target} mm × {scale:.3f}  "
                  f"峰值 {peaks[name].max():.4f} m", flush=True)

    def at(x, y):
        return int(np.abs(lat - y).argmin()), int(np.abs(lon - x).argmin())

    priors = _duration_priors()

    # ---------- p19：中断代价加权 ----------
    pts = []
    for r in _load(SEED / "flood_points_2021_infa.csv"):
        try:
            x, y = float(r["lon"]), float(r["lat"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (LON_MIN <= x <= LON_MAX and LAT_MIN <= y <= LAT_MAX):
            continue
        i, j = at(x, y)
        struct = r.get("structure_type", "")
        cats = STRUCT_TO_LIFELINE.get(struct, ["道路封道"])
        durs = [priors.get(c, {}).get("中位_h", 12.0) for c in cats]
        dur = float(np.mean(durs)) if durs else 12.0
        peak = float(peaks["p50"][i, j])
        pts.append({
            "编号": r["point_id"], "名称": r["name"], "结构": struct,
            "生命线类别": cats, "中断时长先验_h": round(dur, 2),
            "峰值水深_m": round(peak, 4),
            "观测水深_m": float(r["depth_m"]) if r["depth_m"] else None,
            "中断代价指数": round(peak * dur, 4),
        })
    # 排序：按代价指数
    pts_sorted = sorted(pts, key=lambda t: -t["中断代价指数"])
    depth_sorted = sorted(pts, key=lambda t: -t["峰值水深_m"])
    rank_depth = {p["编号"]: k + 1 for k, p in enumerate(depth_sorted)}
    for k, p in enumerate(pts_sorted):
        p["代价排名"] = k + 1
        p["深度排名"] = rank_depth[p["编号"]]
        p["排名变化"] = rank_depth[p["编号"]] - (k + 1)

    # ---------- p20：决策稳定性 ----------
    stab = []
    for p in pts:
        i, j = at(*next(([float(r["lon"]), float(r["lat"])]
                         for r in _load(SEED / "flood_points_2021_infa.csv")
                         if r["point_id"] == p["编号"]), [0, 0]))
        vals = {n: float(peaks[n][i, j]) for n, _ in SCENARIOS}
        lo, hi = min(vals.values()), max(vals.values())
        p["四档峰值_m"] = {k: round(v, 4) for k, v in vals.items()}
        flips = [t for t in DECISION_THRESHOLDS if lo < t <= hi]
        stab.append({
            "编号": p["编号"], "名称": p["名称"],
            "四档峰值_m": p["四档峰值_m"],
            "翻转带_h": [round(lo, 4), round(hi, 4)],
            "带内阈值": flips,
            "不稳定": bool(flips),
        })
    n_unstable = sum(1 for x in stab if x["不稳定"])

    payload = {
        "名称": "中断代价加权排序 + 决策稳定性",
        "生成时间": datetime.now().isoformat(timespec="seconds"),
        "P19_中断代价加权": {
            "方法": "代价指数 = 峰值水深 × 该类生命线的真实中断时长中位",
            "中断时长先验": priors,
            "说明": "不按深度排，按『深度 × 中断时长』排；两者排名差异即位次变化",
            "排序": pts_sorted,
        },
        "P20_决策稳定性": {
            "方法": "同一阈值在 p50–p95 四档下结论是否一致；翻转带=[最小峰值,最大峰值]",
            "候选阈值": DECISION_THRESHOLDS,
            "不稳定点数": n_unstable,
            "总点数": len(stab),
            "不稳定占比": round(n_unstable / max(len(stab), 1), 4),
            "明细": stab,
        },
        "边界": [
            "中断时长先验来自 10 条真实通报，多数在计算域外，仅作类别级先验，非本地实测。",
            "代价指数是把深度与时长相乘的启发式，量纲无物理意义，只用于排序。",
            "翻转带只说明『结论随情景改变』，不代表哪个情景更可能发生。",
            "模型在部分点无信号（峰值≈0），这些点的排名无意义。",
        ],
    }
    p = Path(outdir)
    p.mkdir(parents=True, exist_ok=True)
    (p / "p19-p20_代价排序与决策稳定性.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    if verbose:
        print("\n  p19 代价指数 top5：")
        for x in pts_sorted[:5]:
            print(f"    {x['编号']} {x['名称'][:14]}  代价 {x['中断代价指数']:.3f} "
                  f"(深度 {x['峰值水深_m']:.3f} × {x['中断时长先验_h']}h)  "
                  f"深度排名 {x['深度排名']}")
        print(f"\n  p20 不稳定 {n_unstable}/{len(stab)} 个点"
              f"（{n_unstable/max(len(stab),1):.1%}）")
        for x in stab:
            if x["不稳定"]:
                print(f"    {x['编号']} {x['名称'][:14]} 翻转带 {x['翻转带_h']} "
                      f"带内阈值 {x['带内阈值']}")
        print(f"→ {p / 'p19-p20_代价排序与决策稳定性.json'}")
    return payload


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="typhoeus.decisions")
    ap.add_argument("outdir", nargs="?", default="out")
    a = ap.parse_args(argv)
    build(a.outdir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
