"""p72 台账坐标审计：用 DEM 检查每个涝点是否落在合理地形上。

判据（不依赖任何外部数据）：
  1. 高程异常度 = 本格高程 − 5×5 邻域中位数；|异常| ≥ 2 m 记为可疑；
  2. 局部凸起：8 邻域全部低于本格且差 > 2 m，记为「台地」，优先复核。

用法：python tools/ledger_audit.py
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from typhoeus import config as CFG  # noqa: E402
from typhoeus import data as D  # noqa: E402
from typhoeus import observe as OB  # noqa: E402


def main() -> int:
    cfg = CFG.Config()
    inp = D.load_all(cfg.l2.bbox, cfg.l4.resample)
    g = inp.grid
    bb = cfg.l2.bbox
    e = np.asarray(g.elev, dtype=float)
    ny, nx = e.shape

    rows = []
    for q in OB.load_flood_points():
        inside = (bb["lon_min"] <= q.lon <= bb["lon_max"]
                  and bb["lat_min"] <= q.lat <= bb["lat_max"])
        i = int(np.argmin(np.abs(g.lat - q.lat)))
        j = int(np.argmin(np.abs(g.lon - q.lon)))
        win = e[max(0, i - 2):i + 3, max(0, j - 2):j + 3]
        med = float(np.median(win))
        nb = [e[i + di, j + dj]
              for di in (-1, 0, 1) for dj in (-1, 0, 1)
              if (di, dj) != (0, 0)
              and 0 <= i + di < ny and 0 <= j + dj < nx]
        low_n = sum(1 for v in nb if v < e[i, j] - 2.0)
        anomaly = float(e[i, j] - med)
        flags = []
        if abs(anomaly) >= 2.0:
            flags.append("高程异常")
        if low_n == len(nb) and len(nb) == 8:
            flags.append("局部凸起")
        rows.append({
            "point_id": q.point_id, "name": q.name,
            "structure_type": q.structure_type,
            "in_domain": inside,
            "cell": [i, j],
            "elev_m": round(float(e[i, j]), 2),
            "neigh_median_m": round(med, 2),
            "anomaly_m": round(anomaly, 2),
            "lower_neighbours": low_n,
            "flags": flags,
        })

    suspect = [r for r in rows if r["flags"] and r["in_domain"]]
    payload = {
        "名称": "台账坐标审计（DEM 地形一致性）",
        "生成时间": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "判据": {"高程异常": "|本格 − 5×5 中位数| ≥ 2 m",
                 "局部凸起": "8 邻域全部低于本格 > 2 m"},
        "汇总": {"总点数": len(rows),
                 "域内": sum(1 for r in rows if r["in_domain"]),
                 "可疑": len(suspect)},
        "可疑点位": suspect,
        "全部点位": rows,
        "结论": [
            f"域内 {sum(1 for r in rows if r['in_domain'])} 个点中，"
            f"{len(suspect)} 个地形可疑：" +
            "、".join(f"{r['point_id']}({r['anomaly_m']:+.1f} m)" for r in suspect) +
            "。" if suspect else "无地形可疑点。",
            "「局部凸起」优先复核坐标——水不可能停在比周围高 2 m 以上的格子上。",
        ],
        "边界": [
            "判据只看 DEM，不判断台账水深是否正确。",
            "30 m DSM 含建筑高度（已压平？本域为压平版），仍可能残留构筑物。",
            "域外点不参与判定（模型未覆盖，无格点可比）。",
        ],
    }
    p = ROOT / "out" / "p72_台账坐标审计.json"
    p.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"写入 {p}  可疑 {len(suspect)} 个")
    for r in suspect:
        print(f"  {r['point_id']} {r['name'][:12]:<12} {r['elev_m']:.1f} m "
              f"(邻域中位 {r['neigh_median_m']:.1f}, {r['anomaly_m']:+.1f}) {r['flags']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
