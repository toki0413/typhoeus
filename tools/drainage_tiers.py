"""排水能力 3 档标定：按结构类型分档施加空间乘子，对 17 点复算。

档位与依据（诚实标注）：
  下穿立交 ×0.10 —— 唯一有实测锚的档（p31：FP006 0.467 vs 实测 0.50，
                    差 7%；物理含义：下穿只靠一根支管，过流约全域均值 1/10）
  低洼小区 ×?   —— 无实测锚，扫描 {1.0, 0.5, 0.25}，探针值
  低洼路段 ×?   —— 无实测锚，扫描 {1.0, 0.5, 0.25}，探针值

判据：17 点 MAE（对基线 0.359）、FP006/FP008 与实测对照。
预期（写明再验）：多数低洼小区/路段点为无汇流型（p31），乘子不会唤醒
它们——若 MAE 改善主要来自下穿档，这正是"分档 vs 一刀切"的证据。

产物：out_tiers/tiers_calibration.json
用法：python tools/drainage_tiers.py
"""
from __future__ import annotations

import copy
import csv
import json
import sys
import time
from datetime import datetime
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
SEED = ROOT / "data" / "seed"
OUT = ROOT / "out_tiers"

LON_MIN, LON_MAX = 121.550139, 121.699583
LAT_MIN, LAT_MAX = 29.840417, 29.919861
RADIUS_CELLS = 2

UNDERPASS_MULT = 0.10
SCAN = [1.0, 0.5, 0.25]     # 低洼小区 / 低洼路段的扫描档（无锚探针）


def _load(p: Path) -> list[dict]:
    with open(p, encoding="utf-8-sig") as f:
        return [{k.lstrip("\ufeff"): v for k, v in r.items()}
                for r in csv.DictReader(f)]


def main() -> int:
    from typhoeus import cli as CLI
    from typhoeus import config as CFG
    from typhoeus import data as D
    from typhoeus import kernel as K
    from typhoeus import observe as OB
    from typhoeus import rainsrc as RS

    cfg = CFG.Config()
    inp = D.load_all(cfg.l2.bbox, cfg.l4.resample)
    g = inp.grid
    lon, lat = np.asarray(g.lon), np.asarray(g.lat)
    ny, nx = lat.size, lon.size
    rain, _ = RS.get_rainfall(g, stations=OB.load_rain_stations(),
                              use_cache=True, calibrate=cfg.l2.rain_calibrate,
                              verbose=False)
    kp_base = CLI._kernel_params(cfg)

    # 域内涝点按结构类型分组
    groups: dict[str, list[dict]] = {"下穿立交": [], "低洼小区": [],
                                     "低洼路段": []}
    for r in _load(SEED / "flood_points_2021_infa.csv"):
        st = r.get("structure_type")
        if st not in groups:
            continue
        try:
            x, y = float(r["lon"]), float(r["lat"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (LON_MIN <= x <= LON_MAX and LAT_MIN <= y <= LAT_MAX):
            continue
        groups[st].append({
            "编号": r["point_id"], "名称": r["name"],
            "观测_m": float(r["depth_m"]) if r["depth_m"] else None,
            "i": int(np.abs(lat - y).argmin()),
            "j": int(np.abs(lon - x).argmin())})
    print({k: len(v) for k, v in groups.items()})

    def mult_map(under: float, comm: float, road: float) -> np.ndarray:
        m = np.ones((ny, nx), dtype="float64")
        for st, mult in (("下穿立交", under), ("低洼小区", comm),
                         ("低洼路段", road)):
            for t in groups[st]:
                r0, r1 = max(0, t["i"] - RADIUS_CELLS), min(ny, t["i"] + RADIUS_CELLS + 1)
                c0, c1 = max(0, t["j"] - RADIUS_CELLS), min(nx, t["j"] + RADIUS_CELLS + 1)
                yy, xx = np.mgrid[r0:r1, c0:c1]
                disc = (yy - t["i"]) ** 2 + (xx - t["j"]) ** 2 <= RADIUS_CELLS ** 2
                blk = m[r0:r1, c0:c1]
                blk[disc] = mult
        return m

    all_points = [t for v in groups.values() for t in v]

    def run_and_score(m: np.ndarray | None, prof: str = "uniform"):
        kp = copy.copy(kp_base)
        kp.drainage_mult = m
        # 乘子场不进 config_hash，必须带档案名（kernel.run 会拒两种静默错配），
        # 并把定影串记进每一档的结果行，供外部复算时核对用的是哪一个场。
        kp.drainage_profile = prof
        t0 = time.perf_counter()
        res = K.run(g, rain, kp)
        el = time.perf_counter() - t0
        peak = np.asarray(res.depth).max(axis=0)
        per = {t["编号"]: float(peak[t["i"], t["j"]]) for t in all_points}
        mae = float(np.mean([abs(per[t["编号"]] - t["观测_m"])
                             for t in all_points if t["观测_m"]]))
        return el, per, mae, float(peak.max()), res.drainage_fingerprint

    results = []
    # 基线（全 1.0，drainage_mult=None 等价）
    el, per0, mae0, gmax0, fp0 = run_and_score(None)
    print(f"基线      MAE {mae0:.4f}  全域峰值 {gmax0:.4f}")
    results.append({"档": "基线(现状标量)", "乘子": {}, "排水指纹": fp0,
                    "MAE_m": round(mae0, 4), "全域峰值_m": round(gmax0, 4)})

    best = {"mae": mae0, "comm": 1.0, "road": 1.0}
    for comm in SCAN:
        for road in SCAN:
            m = mult_map(UNDERPASS_MULT, comm, road)
            prof = (f"tiers3_disc{RADIUS_CELLS}_u{UNDERPASS_MULT}"
                    f"_c{comm}_d{road}")
            el, per, mae, gmax, fp = run_and_score(m, prof)
            results.append({
                "档": f"下穿×{UNDERPASS_MULT}/小区×{comm}/路段×{road}",
                "乘子": {"下穿立交": UNDERPASS_MULT, "低洼小区": comm,
                        "低洼路段": road},
                "排水指纹": fp,
                "MAE_m": round(mae, 4), "全域峰值_m": round(gmax, 4),
                "内核_s": round(el, 1),
                "FP006_m": round(per.get("FP006", float("nan")), 4),
                "FP008_m": round(per.get("FP008", float("nan")), 4)})
            print(f"小区×{comm} 路段×{road}  MAE {mae:.4f}  "
                  f"FP006 {per.get('FP006',0):.4f}", flush=True)
            if mae < best["mae"]:
                best = {"mae": mae, "comm": comm, "road": road}

    payload = {
        "名称": "排水能力按结构类型 3 档标定（对 17 点复算）",
        "生成时间": datetime.now().isoformat(timespec="seconds"),
        "档位依据": {
            "下穿立交×0.10": "有实测锚：p31 FP006 0.467 vs 0.50（差 7%）",
            "低洼小区/路段扫描值": "无实测锚，探针；MAE 改善若主要来自下穿档，"
                             "即『分档优于一刀切』的证据"},
        "扫描结果": results,
        "最优档": {**best, "MAE改善_pct":
                  round((mae0 - best["mae"]) / mae0 * 100, 1)},
        "边界": [
            "乘子按半径 2 格圆盘施加，非真实管网拓扑；0.10 是量级结论非标定值。",
            "低洼小区/路段档无观测锚，最优档是 MAE 意义上的探针最优，"
            "不得写作『已标定』。",
            "12/17 点为无汇流型（p31），乘子不会唤醒它们——MAE 改善有天花板。",
            "观测 0.50 m 为通报口径，可能被取整。",
        ],
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "tiers_calibration.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n最优：{best}（基线 MAE {mae0:.4f}）")
    print(f"→ {OUT / 'tiers_calibration.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
