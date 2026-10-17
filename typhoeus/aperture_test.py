"""p59 口径差检验：格点面平均 vs 格点内最大值 vs 邻域最大值。

要回答的问题
------------
台账记的是**点位通报水深**，模型给的是 **54 m 格点面平均**。
两者本就不同量——一个点的水深可以高于它所在格点的平均。

那个 0.36 m 的加性偏移，是「模型偏浅」还是「口径差」？
用一个决定性检验：**把模型的聚合方式换掉，看 MAE 是否塌下来。**

四种聚合
--------
  A 面平均（现状）        ：点所在 54 m 格点的值
  B 格点内最大值          ：该 54 m 格点内 30 m 子格的最大值
  C 邻域最大值（54 m 3×3）：以点为中心的 3×3 格点最大
  D 邻域最大值（30 m 3×3）：在 30 m 网格上取 3×3 最大

判定
----
若 B/C/D 中任一把 MAE 从 0.36 压到接近 0.09（即 p58 的加性校正水平），
则偏移主要是**口径差**；若都没压下来，则它是**模型偏浅**。

用法：python -m typhoeus.aperture_test
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"


def main() -> int:
    from typhoeus import cli as CLI
    from typhoeus import config as CFG
    from typhoeus import data as D
    from typhoeus import kernel as K
    from typhoeus import observe as OB
    from typhoeus import rainsrc as RS

    p25 = json.loads((OUT / "p25_序数技能检验.json").read_text(encoding="utf-8"))
    pts = p25["逐点"]
    obs = np.array([p["观测_m"] for p in pts], float)

    cfg = CFG.Config()

    # ---- 54 m（主链口径）----
    inp2 = D.load_all(cfg.l2.bbox, 2)
    g2 = inp2.grid
    rain2, _ = RS.get_rainfall(g2, stations=OB.load_rain_stations(),
                               use_cache=True, calibrate=cfg.l2.rain_calibrate,
                               verbose=False)
    t0 = time.perf_counter()
    r2 = K.run(g2, rain2, CLI._kernel_params(cfg))
    peak2 = np.asarray(r2.depth).max(axis=0)
    t_54 = round(time.perf_counter() - t0, 1)

    # ---- 30 m（DEM 原生）----
    inp1 = D.load_all(cfg.l2.bbox, 1)
    g1 = inp1.grid
    rain1, _ = RS.get_rainfall(g1, stations=OB.load_rain_stations(),
                               # 缓存存的是固定网格的场，30 m 必须强制重取，
                               # 否则返回 144×270 与 g1(289×541) 形状不符
                               use_cache=False, calibrate=cfg.l2.rain_calibrate,
                               verbose=False)
    t0 = time.perf_counter()
    r1 = K.run(g1, rain1, CLI._kernel_params(cfg))
    peak1 = np.asarray(r1.depth).max(axis=0)
    t_30 = round(time.perf_counter() - t0, 1)

    lon2, lat2 = np.asarray(g2.lon), np.asarray(g2.lat)
    lon1, lat1 = np.asarray(g1.lon), np.asarray(g1.lat)

    def idx(lon, lat, x, y):
        return (int(np.abs(lat - y).argmin()), int(np.abs(lon - x).argmin()))

    def nbhd_max(a, i, j, k=1):
        r0, r1_ = max(0, i - k), min(a.shape[0], i + k + 1)
        c0, c1_ = max(0, j - k), min(a.shape[1], j + k + 1)
        return float(a[r0:r1_, c0:c1_].max())

    def cellmax_30m(x, y):
        """该点所在的 54 m 格点内，所有 30 m 子格的最大值。"""
        # 54 m 格点边界的经纬度范围
        i2, j2 = idx(lon2, lat2, x, y)
        dlon = abs(lon2[1] - lon2[0]) if len(lon2) > 1 else 0.0
        dlat = abs(lat2[1] - lat2[0]) if len(lat2) > 1 else 0.0
        lo0, lo1 = lon2[j2] - dlon / 2, lon2[j2] + dlon / 2
        la0, la1 = lat2[i2] - dlat / 2, lat2[i2] + dlat / 2
        m = ((lon1 >= lo0) & (lon1 <= lo1))
        mm = ((lat1 >= min(la0, la1)) & (lat1 <= max(la0, la1)))
        if not m.any() or not mm.any():
            return float(peak1[i2 if False else idx(lon1, lat1, x, y)[0],
                               idx(lon1, lat1, x, y)[1]])
        sub = peak1[np.ix_(mm, m)]
        return float(sub.max())

    rows = []
    for p in pts:
        x, y = float(p["lon"]) if "lon" in p else None, None
        # p25 逐点没有经纬度，改用 CSV 补
        rows.append(p)

    # 从台账 CSV 补经纬度
    import csv
    with open(ROOT / "data/seed/flood_points_2021_infa.csv",
              encoding="utf-8-sig") as f:
        meta = {r["point_id"]: r for r in csv.DictReader(f)}

    methods = {"A_面平均54m": [], "B_格点内最大30m": [],
               "C_邻域最大54m": [], "D_邻域最大30m": []}
    for p in pts:
        m = meta.get(p["编号"])
        if not m:
            for k in methods:
                methods[k].append(np.nan)
            continue
        x, y = float(m["lon"]), float(m["lat"])
        i2, j2 = idx(lon2, lat2, x, y)
        i1, j1 = idx(lon1, lat1, x, y)
        methods["A_面平均54m"].append(float(peak2[i2, j2]))
        methods["B_格点内最大30m"].append(cellmax_30m(x, y))
        methods["C_邻域最大54m"].append(nbhd_max(peak2, i2, j2, 1))
        methods["D_邻域最大30m"].append(nbhd_max(peak1, i1, j1, 1))

    summary = []
    for k, v in methods.items():
        arr = np.array(v, float)
        mae = float(np.nanmean(np.abs(obs - arr)))
        ratio = float(np.nanmean(obs) / max(np.nanmean(arr), 1e-12))
        summary.append({"聚合方式": k, "均值_m": round(float(np.nanmean(arr)), 4),
                        "最大_m": round(float(np.nanmax(arr)), 4),
                        "MAE_m": round(mae, 4),
                        "相对A改善_pct": None,
                        "观测/模型倍数": round(ratio, 1)})
    base = summary[0]["MAE_m"]
    for s in summary:
        s["相对A改善_pct"] = round((1 - s["MAE_m"] / base) * 100, 1)

    best = min(summary, key=lambda s: s["MAE_m"])
    # p58 的加性校正可达水平
    p58 = OUT / "p58_加性偏移留出检验.json"
    target = None
    if p58.exists():
        d58 = json.loads(p58.read_text(encoding="utf-8"))
        target = d58["A_留一法"]["MAE_m"]

    closes = bool(target and best["MAE_m"] <= target * 1.5)
    payload = {
        "名称": "口径差检验：格点面平均 vs 格点内最大 vs 邻域最大",
        "生成时间": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "要回答的问题": (
            "台账记点位通报水深，模型给 54 m 格点面平均——两者本就不同量。"
            "那个 0.36 m 加性偏移是『模型偏浅』还是『口径差』？"
            "换掉聚合方式，看 MAE 是否塌下来。"),
        "四种聚合": summary,
        "耗时_s": {"54m": t_54, "30m": t_30},
        "p58加性校正可达MAE": target,
        "判定": {
            "最优聚合": best["聚合方式"],
            "最优MAE_m": best["MAE_m"],
            "是否解释了大半偏移（MAE ≤ 1.5×加性校正水平）": closes,
            "含义": ("偏移主要是**口径差**——模型面平均本就低于点位值"
                   if closes else
                   "偏移主要是**模型偏浅**——换聚合方式救不回来"),
        },
        "结论": [],
        "边界": [
            "p25 逐点无经纬度，已用台账 CSV 的 lon/lat 补。",
            "『格点内最大 30 m』依赖 54 m 与 30 m 网格的嵌套关系；"
            "两者并非严格 3×3 嵌套（54/30=1.8），故子格数为 2×2 或 3×3 不定。",
            "邻域最大值会系统抬高所有点，故倍数下降不代表精度提高——"
            "须与 MAE 同看。",
            "两次运行除网格外参数相同；30 m 内核耗时约 ×4。",
            "观测水深为通报值，非同时刻、同来源（p5 已声明）。",
        ],
    }

    concl = [
        ("**四种聚合的 MAE**："
         + "；".join(f"{s['聚合方式']} {s['MAE_m']:.4f}" for s in summary) + "。"),
        (f"**最优是 {best['聚合方式']}，MAE {best['MAE_m']:.4f}，"
         f"相对面平均改善 {best['相对A改善_pct']}%**。"
         + (f"对照 p58 加性校正可达 {target:.4f}。"
            if target else "")),
    ]
    if closes:
        concl.append(
            "**所以偏移主要是口径差**：把『格点面平均』换成『格点内最大』就基本解释掉了。"
            "这意味着模型并非系统性偏浅，而是我们拿错了聚合量去比。")
        concl.append(
            "**产品含义**：点位水深应报『格点内最大』而非『格点面平均』；"
            "这不是校正，是改正口径。")
    else:
        concl.append(
            f"**所以偏移不是口径差**：最好的聚合也只能把 MAE 压到 "
            f"{best['MAE_m']:.4f}，而加性校正能到 {target}。"
            "**换聚合方式救不回来 → 它是模型偏浅。**")
        concl.append(
            "**这反而把问题锁死在物理上**：既然不是口径、不是分辨率（p28）、"
            "不是聚合方式，那只能是**缺一个把水集中起来的机制**——"
            "即汇流/洼地蓄水，与 p48 的定位一致。")
    payload["结论"] = concl

    (OUT / "p59_口径差检验.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    for s in summary:
        print(f"    {s['聚合方式']:<18} 均值 {s['均值_m']:.4f}  "
              f"MAE {s['MAE_m']:.4f}  改善 {s['相对A改善_pct']:+.1f}%")
    print(f"  最优 {best['聚合方式']}  MAE {best['MAE_m']:.4f}"
          f"  → {'口径差' if closes else '模型偏浅'}")
    print(f"→ {OUT / 'p59_口径差检验.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
