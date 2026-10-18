"""p21 反推排水需求 + p22 反推降雨阈值（两个反问题）。

都是问"要达到某个结果，输入端需要多少"，只是反解的变量不同：

p21（排水侧）：固定降雨，反解使某点峰值水深 ≤ 目标值所需的**排水能力系数**。
     —— 回答"这条街要加多少排水能力才不淹到 15 cm"。

p22（降雨侧）：固定排水，反解使某点峰值水深达到目标值的**面雨量**。
     —— 回答"多大的雨会让这个点达到 50 cm"，即该点的"降雨承载上限"。

方法：
    p21 二分搜索 drainage_coeff_m_s（单调：能力越大深度越小）。
    p22 线性扫面雨量缩放（单调：雨越大深度越大）+ 二分细化。

代价：每次求值一次内核（约 6 s）。为避免重复，grid 与基准雨只加载一次。

用法：python -m typhoeus.inverse
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SEED = ROOT / "data" / "seed"
OUT = ROOT / "out"

LON_MIN, LON_MAX = 121.550139, 121.699583
LAT_MIN, LAT_MAX = 29.840417, 29.919861

# 代表性涝点：优先"排水可挖型"（FP018）—— 三种分型里反解最有意义的
# （排水兜底型反解必然要求巨量排水；模型无水型反解恒为"无论多大雨都不越阈"）
TARGETS = [
    ("FP018", "排水可挖型"),
]
# 只解两个业务阈值：15 cm（GB 51222 道路）与 50 cm（红色）
GOALS_M = [0.15, 0.50]
COEFF_GRID = [1.2e-3, 4.8e-3, 1.92e-2, 7.68e-2]
SCALE_GRID = [0.75, 1.0, 1.5, 2.0, 2.5]
REFINE = 3          # 二分细化次数（2^-3 ≈ 12% 相对精度）


class Engine:
    """缓存 grid / 基准雨 / 点位索引，提供单次求值。"""

    def __init__(self):
        from typhoeus import cli as CLI
        from typhoeus import config as CFG
        from typhoeus import data as D
        from typhoeus import observe as OB
        from typhoeus import rainsrc as RS

        self.cfg = CFG.Config()
        inp = D.load_all(self.cfg.l2.bbox, self.cfg.l4.resample)
        self.grid = inp.grid
        base, _ = RS.get_rainfall(self.grid, stations=OB.load_rain_stations(),
                                  use_cache=True,
                                  calibrate=self.cfg.l2.rain_calibrate,
                                  verbose=False)
        self.base = np.asarray(base, dtype=float)
        self.kp_base = CLI._kernel_params(self.cfg)
        self.base_mm = float(self.base.mean(axis=(1, 2)).sum()
                             * self.cfg.l4.dt_s / 3600.0)
        self.lon = np.asarray(self.grid.lon)
        self.lat = np.asarray(self.grid.lat)
        self.n_calls = 0

    def idx(self, x: float, y: float) -> tuple[int, int]:
        return (int(np.abs(self.lat - y).argmin()),
                int(np.abs(self.lon - x).argmin()))

    def peak(self, scale: float = 1.0, coeff: float | None = None,
             ij: tuple[int, int] | None = None) -> float:
        """跑一次内核，返回指定点的峰值水深（不给 ij 则返回全域峰值）。"""
        import copy

        from typhoeus import kernel as K

        kp = copy.copy(self.kp_base)
        if coeff is not None:
            kp.drainage_coeff_m_s = coeff
        rain = self.base * scale
        res = K.run(self.grid, rain, kp)
        self.n_calls += 1
        f = np.asarray(res.depth).max(axis=0)
        return float(f[ij[0], ij[1]]) if ij else float(f.max())


def _load_points() -> dict[str, dict]:
    import csv
    with open(SEED / "flood_points_2021_infa.csv", encoding="utf-8-sig") as f:
        rows = [{k.lstrip("\ufeff"): v for k, v in r.items()} for r in csv.DictReader(f)]
    return {r["point_id"]: r for r in rows}


def build(outdir: str = "out", verbose: bool = True) -> dict:
    eng = Engine()
    pts = _load_points()
    if verbose:
        print(f"  基准面雨量 {eng.base_mm:.1f} mm；一次求值约 6 s", flush=True)

    results = {}
    for pid, kind in TARGETS:
        r = pts.get(pid)
        if not r:
            continue
        x, y = float(r["lon"]), float(r["lat"])
        if not (LON_MIN <= x <= LON_MAX and LAT_MIN <= y <= LAT_MAX):
            continue
        ij = eng.idx(x, y)
        entry = {"编号": pid, "名称": r["name"], "分型": kind,
                 "当前实际峰值_m": round(eng.peak(1.0, None, ij), 4)}

        # ---------- p21：反推排水能力 ----------
        p21 = []
        for goal in GOALS_M:
            # 先扫网格，找第一个满足 goal 的系数
            hit = None
            for c in COEFF_GRID:
                v = eng.peak(1.0, c, ij)
                if v <= goal:
                    hit = c
                    break
            if hit is None:
                p21.append({"目标_m": goal, "所需排水系数": None,
                            "结论": "在扫描上限内不可达"})
                continue
            # 二分细化
            lo, hi = 0.0, hit
            for _ in range(REFINE):
                mid = (lo + hi) / 2
                if eng.peak(1.0, mid, ij) <= goal:
                    hi = mid
                else:
                    lo = mid
            p21.append({"目标_m": goal,
                        "所需排水系数": float(f"{hi:.3e}"),
                        "相对现状倍数": round(hi / 1.2e-3, 2),
                        "结论": "可解"})
        entry["P21_排水反解"] = p21

        # ---------- p22：反推降雨阈值 ----------
        p22 = []
        for goal in GOALS_M:
            hit = None
            prev = None
            for s in SCALE_GRID:
                v = eng.peak(s, None, ij)
                if v >= goal:
                    hit = (prev, s) if prev else (s, s)
                    break
                prev = s
            if hit is None:
                p22.append({"目标_m": goal, "所需面雨量_mm": None,
                            "结论": "在扫描上限（2.5 倍）内不可达"})
                continue
            lo, hi = hit
            for _ in range(REFINE):
                mid = (lo + hi) / 2
                if eng.peak(mid, None, ij) >= goal:
                    hi = mid
                else:
                    lo = mid
            p22.append({"目标_m": goal,
                        "所需面雨量_mm": round(hi * eng.base_mm, 1),
                        "相对事件倍数": round(hi, 2),
                        "结论": "可解"})
        entry["P22_降雨反解"] = p22

        results[pid] = entry
        if verbose:
            print(f"  {pid} {r['name'][:14]}（{kind}）当前峰值 "
                  f"{entry['当前实际峰值_m']:.3f} m", flush=True)
            for x_ in p21:
                print(f"    p21 水深≤{x_['目标_m']} m 需排水系数 "
                      f"{x_['所需排水系数']}（×{x_.get('相对现状倍数')}）", flush=True)
            for x_ in p22:
                print(f"    p22 达到{x_['目标_m']} m 需面雨量 "
                      f"{x_['所需面雨量_mm']} mm（×{x_.get('相对事件倍数')}）", flush=True)

    payload = {
        "名称": "反问题：排水需求与降雨阈值",
        "生成时间": datetime.now().isoformat(timespec="seconds"),
        "基准面雨量_mm": round(eng.base_mm, 1),
        "求值次数": eng.n_calls,
        "P21_排水反解": {
            "问题": "固定这场雨，这条街要加多少排水能力才不淹到 X cm？",
            "方法": "网格扫描找首个满足点，再二分细化 5 次",
        },
        "P22_降雨反解": {
            "问题": "多大的雨会让这个点达到 X cm？",
            "方法": "按面雨量倍数扫描（0.5–2.5），找到越阈区间后二分细化 5 次",
        },
        "结果": results,
        "边界": [
            "反解依赖模型的排水与降雨参数；参数本身未经实测标定，故反解值是模型内的相对量。",
            "排水系数为集总参数，不对应管径/坡度等具体工程指标；倍数应读作『量级的多少倍』。",
            "降雨按全场等比缩放，未改变空间型与时间分布，故为『同型更猛』而非『另一种雨型』。",
            "模型在部分点无信号时，反解退化为『无论多大雨都不越阈』，须结合 p17 分型判读。",
        ],
    }
    p = Path(outdir)
    p.mkdir(parents=True, exist_ok=True)
    (p / "p21-p22_反问题.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    if verbose:
        print(f"→ {p / 'p21-p22_反问题.json'}（共 {eng.n_calls} 次求值）")
    return payload


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="typhoeus.inverse")
    ap.add_argument("outdir", nargs="?", default="out")
    a = ap.parse_args(argv)
    build(a.outdir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
