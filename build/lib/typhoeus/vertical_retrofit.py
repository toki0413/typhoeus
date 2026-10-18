"""p69 竖向改造：把低洼格抬高多少能消掉红格？

为什么这一条特殊
----------------
`p3` 把"补几何"（填高低洼点、抬高路面）列为可选手段，
但**从未量化其杠杆**。它是**唯一能改地形本身**的手段：
不依赖管网台账，也不依赖雷达 QPE——那两样正是我们拿不到的。

做法
----
把低于某高程阈值的格抬高 Δh，看红格与点位怎么变。
  阈值取域内高程的 P5 / P10 / P20（即最低的一小部分）
  Δh ∈ {0, 0.1, 0.2, 0.3, 0.5} m

不改内核（只改输入的 elev 场），故零代码风险。

用法：python -m typhoeus.vertical_retrofit
"""

from __future__ import annotations

import copy
import csv
import json
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
RED_TH = 0.50
DH = (0.0, 0.10, 0.20, 0.30, 0.50)
PCTS = (5, 10, 20)


def main() -> int:
    from typhoeus import cli as CLI
    from typhoeus import config as CFG
    from typhoeus import data as D
    from typhoeus import kernel as K
    from typhoeus import observe as OB
    from typhoeus import rainsrc as RS

    p25 = json.loads((OUT / "p25_序数技能检验.json").read_text(encoding="utf-8"))
    pts = p25["逐点"]
    with open(ROOT / "data/seed/flood_points_2021_infa.csv",
              encoding="utf-8-sig") as f:
        ledger = {r["point_id"]: r for r in csv.DictReader(f)}

    cfg = CFG.Config()
    inp = D.load_all(cfg.l2.bbox, cfg.l4.resample)
    g = inp.grid
    lon, lat = np.asarray(g.lon), np.asarray(g.lat)
    rain_obs, _ = RS.get_rainfall(g, stations=OB.load_rain_stations(),
                                  use_cache=True,
                                  calibrate=cfg.l2.rain_calibrate,
                                  verbose=False)
    kp = CLI._kernel_params(cfg)
    # **关键**：基准必须用「会产红格」的情景，否则"消红"没有对象。
    # p67 实测同一总量下单峰雨型产 131.41 ha 红格，故以它为基准。
    nt = int(round(kp.max_t_h * 3600.0 / kp.dt_s))
    dt_h = kp.dt_s / 3600.0
    t = np.arange(nt, dtype=float) * dt_h
    w = np.exp(-0.5 * ((t - 33.0) / 3.0) ** 2)
    w = w * (259.1 / (w.sum() * dt_h))
    rain = np.broadcast_to(w[:, None, None],
                           (nt, g.elev.shape[0], g.elev.shape[1])).copy()
    area_ha = float(g.elev.size) * (g.cell_m ** 2) / 1e4
    z0 = np.asarray(g.elev, float)

    pid = []
    for p in pts:
        r = ledger.get(p["编号"])
        if r is None:
            continue
        x, y = float(r["lon"]), float(r["lat"])
        if not (lon.min() <= x <= lon.max() and lat.min() <= y <= lat.max()):
            continue
        pid.append((int(np.abs(lat - y).argmin()),
                    int(np.abs(lon - x).argmin())))

    def run(z):
        g2 = copy.copy(g)
        g2.elev = z
        res = K.run(g2, rain, kp)
        peak = np.asarray(res.depth).max(axis=0)
        red = float((peak >= RED_TH).sum()) * (g.cell_m ** 2) / 1e4
        pt = float(np.mean([peak[i, j] for i, j in pid])) if pid else np.nan
        return round(red, 2), round(pt, 4), round(float(peak.max()), 4)

    rows = []
    base = run(z0)
    rows.append({"方案": "现状", "抬高格占比_pct": 0, "抬升_m": 0.0,
                 "红格_ha": base[0], "点位均值_m": base[1], "峰值_m": base[2]})
    print(f"    现状                        红格 {base[0]:8.2f} ha  "
          f"点位 {base[1]:.4f}  峰值 {base[2]:.4f}")

    for pct in PCTS:
        thr = float(np.percentile(z0, pct))
        mask = z0 <= thr
        for dh in DH:
            if dh <= 0:
                continue
            z = np.where(mask, z0 + dh, z0)
            red, pt, pk = run(z)
            rows.append({"方案": f"抬最低 {pct}% 低洼格 +{dh} m",
                         "抬高格占比_pct": pct, "抬升_m": dh,
                         "阈值高程_m": round(thr, 3),
                         "红格_ha": red, "点位均值_m": pt, "峰值_m": pk})
            print(f"    抬最低 {pct:>2}%（{thr:6.2f} m）+{dh:.2f} m    "
                  f"红格 {red:8.2f} ha  点位 {pt:.4f}  峰值 {pk:.4f}")

    best = min([r for r in rows if r["抬升_m"] > 0],
               key=lambda r: r["红格_ha"])
    zero = [r for r in rows if r["抬升_m"] > 0 and r["红格_ha"] == 0]

    payload = {
        "名称": "竖向改造：在单峰雨型下把低洼格抬高多少能消红格",
        "生成时间": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "为什么这一条特殊": (
            "p3 把『补几何』列为可选手段但**从未量化其杠杆**。"
            "它是**唯一能改地形本身**的手段：不依赖管网台账，也不依赖雷达 QPE"
            "——而这两样正是本项目拿不到的。"),
        "做法": ("基准情景用**单峰雨型**（同总量 259.1 mm，p67 实测产 131.41 ha 红格），"
               "再把它低于高程 P5/P10/P20 阈值的格抬高 Δh；"
               "不改内核，只改输入 elev 场"),
        "现状": {"红格_ha": base[0], "点位均值_m": base[1], "峰值_m": base[2]},
        "扫描": rows,
        "最优": best,
        "能消掉红格的方案": zero,
        "结论": [],
        "边界": [
            "抬高是**全局均匀**加在掩膜上，不是真实工程（真实改造是局部的、带边坡的）。",
            "抬高后 DEM 与建筑足迹、管网开口的对应关系被破坏，"
            "物理意义上只代表『该处地面不再积水』。",
            "未计改造代价（土方量与征地），故不能直接当成本效益结论。",
            "只扫三档面积阈值，未做逐点定向改造。",
            "不改内核，零代码风险；主链数字未改动。",
        ],
    }

    concl = [
        (f"**基准情景（单峰雨型）红格 {base[0]} ha** —— "
         "用它作基准，是因为本模型在观测雨型下红格为 0，"
         "抬高地形的效果会被 0 掩盖，测不出杠杆。"),
        ("**扫描**：" + "；".join(
            f"抬最低 {r['抬高格占比_pct']}% +{r['抬升_m']:.2f} m → 红格 {r['红格_ha']} ha"
            for r in rows if r["抬升_m"] > 0) + "。"),
    ]
    if zero:
        z = min(zero, key=lambda r: (r["抬高格占比_pct"], r["抬升_m"]))
        concl.append(
            f"**最省的消红方案**：抬最低 **{z['抬高格占比_pct']}%** 的格、"
            f"**+{z['抬升_m']:.2f} m**，红格归零。"
            "这是本项目唯一一条**不依赖缺失数据**就能量化的干预。")
    else:
        concl.append(
            "**没有任何方案把红格压到 0**（含抬最高 20% 格 +0.5 m）。"
            "说明竖向改造在本模型里也无法消除红格——"
            "与 p65『模型类别不够』的结论一致。")
    concl.append(
        "**注意基线本身无红格**（本模型基线红格 0 ha），"
        "故本件的『消红』只在抬高**之前比现状更差**的情形下才有意义；"
        "把红格当被消对象时，需先让某个情景产生红格（如雨型单峰、潮位时程）。")

    payload["结论"] = concl

    (OUT / "p69_竖向改造.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n  最优 {best['方案']} → 红格 {best['红格_ha']} ha")
    print(f"  能消红方案数 {len(zero)}")
    print(f"→ {OUT / 'p69_竖向改造.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
