"""p65 组合测试与总结：六种机制逐一试过，哪一条能闭合？

单机制结果（均对 2021 烟花，目标面积 2.19%、点位 0.396、MAE 0.0909）
  基线                面积 19.09%  点位 0.0366  MAE 0.3593
  初损 167 mm         面积 18.94%  点位 0.0389  MAE 0.3569
  初损 240 mm         面积 12.75%  点位 0.0286  MAE 0.3673
  D8 路由 rate 0.35   面积 14.65%  点位 0.0374  MAE 0.3585
  填洼+路由           面积 16.58%  点位 0.0376  MAE 0.3583
  排水异质（4 结构）   面积 19.10%  点位 0.0786  MAE 0.3173

本件试组合，并给出总判定。
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
WET_TH = 0.05
TARGET_AREA = 2.19
TARGET_PT = 0.396
TARGET_MAE = 0.0909
PRIOR = {"下穿立交": 0.10, "桥洞": 0.10, "低洼小区": 0.50, "低洼路段": 0.70}
RAD = 2


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
    with open(ROOT / "data/seed/flood_points_2021_infa.csv",
              encoding="utf-8-sig") as f:
        ledger = list(csv.DictReader(f))
    lmap = {r["point_id"]: r for r in ledger}

    cfg = CFG.Config()
    inp = D.load_all(cfg.l2.bbox, cfg.l4.resample)
    g = inp.grid
    lon, lat = np.asarray(g.lon), np.asarray(g.lat)
    rain, _ = RS.get_rainfall(g, stations=OB.load_rain_stations(),
                              use_cache=True, calibrate=cfg.l2.rain_calibrate,
                              verbose=False)
    base_kp = CLI._kernel_params(cfg)
    area_ha = float(g.elev.size) * (g.cell_m ** 2) / 1e4

    def build_mult():
        m = np.ones(g.elev.shape, dtype="float64")
        for r in ledger:
            st = r["structure_type"]
            if st not in PRIOR:
                continue
            x, y = float(r["lon"]), float(r["lat"])
            if not (lon.min() <= x <= lon.max()
                    and lat.min() <= y <= lat.max()):
                continue
            i = int(np.abs(lat - y).argmin())
            j = int(np.abs(lon - x).argmin())
            r0, r1 = max(0, i - RAD), min(g.elev.shape[0], i + RAD + 1)
            c0, c1 = max(0, j - RAD), min(g.elev.shape[1], j + RAD + 1)
            yy, xx = np.mgrid[r0:r1, c0:c1]
            disc = (yy - i) ** 2 + (xx - j) ** 2 <= RAD ** 2
            m[r0:r1, c0:c1][disc] = PRIOR[st]
        return m

    mult = build_mult()

    def ia(rain_arr, dt_s, dep_mm):
        if dep_mm <= 0:
            return rain_arr
        dt_h = dt_s / 3600.0
        cum = np.cumsum(rain_arr * dt_h, axis=0)
        eff = np.maximum(cum - dep_mm, 0.0)
        return np.diff(eff, axis=0, prepend=0.0) / dt_h

    combos = [
        ("基线", dict(rate=0.0, filled=False, dep=0.0, drain=False)),
        ("路由0.35+排水异质", dict(rate=0.35, filled=False, dep=0.0, drain=True)),
        ("初损120+排水异质", dict(rate=0.0, filled=False, dep=120.0, drain=True)),
        ("路由0.35+初损120+排水异质",
         dict(rate=0.35, filled=False, dep=120.0, drain=True)),
        ("路由0.35+初损240+排水异质",
         dict(rate=0.35, filled=False, dep=240.0, drain=True)),
    ]

    rows = []
    for name, c in combos:
        kp = copy.copy(base_kp)
        kp.concentration_rate = float(c["rate"])
        kp.concentration_use_filled = bool(c["filled"])
        if c["drain"]:
            kp.drainage_mult = mult
            kp.drainage_profile = f"combo_{int(c['rate']*100)}"
        else:
            kp.drainage_mult = None
            kp.drainage_profile = "uniform"
        try:
            res = K.run(g, ia(np.asarray(rain, float), kp.dt_s, c["dep"]), kp)
        except Exception as e:  # noqa: BLE001
            print(f"    {name} 失败 {type(e).__name__}")
            continue
        peak = np.asarray(res.depth).max(axis=0)
        mod_pt = []
        for p in pts:
            r = lmap.get(p["编号"])
            if r is None:
                mod_pt.append(np.nan)
                continue
            x, y = float(r["lon"]), float(r["lat"])
            i = int(np.abs(lat - y).argmin())
            j = int(np.abs(lon - x).argmin())
            mod_pt.append(float(peak[i, j]))
        mod_pt = np.array(mod_pt, float)
        resi = obs - mod_pt
        wet = float((peak >= WET_TH).sum()) * (g.cell_m ** 2) / 1e4 / area_ha * 100
        rows.append({
            "组合": name, **{k: v for k, v in c.items()},
            "湿格面积_pct": round(wet, 3),
            "面积相对观测倍数": round(wet / TARGET_AREA, 2),
            "点位均值_m": round(float(np.nanmean(mod_pt)), 4),
            "点位MAE_m": round(float(np.nanmean(np.abs(resi))), 4),
            "残差均值_m": round(float(np.nanmean(resi)), 4),
        })
        print(f"    {name:<26} 湿格 {wet:6.2f}%（{wet/TARGET_AREA:4.2f}×）"
              f"  点位 {np.nanmean(mod_pt):.4f}  "
              f"MAE {np.nanmean(np.abs(resi)):.4f}")

    # 各单机制（来自 p59-p64 实测）
    singles = [
        ("分辨率 30 m（p28）", "—", 0.3306, "MAE 仅改善 8%"),
        ("聚合=邻域最大（p59）", "—", 0.2780, "仅解释 22.6%"),
        ("初损 167 mm（p62）", 18.94, 0.3569, "面积几乎不动"),
        ("初损 240 mm（p62）", 12.75, 0.3673, "点位反而更浅"),
        ("D8 路由 0.35（p61/p64）", 14.65, 0.3585, "面积降但点位不动"),
        ("填洼后路由（p64）", 16.58, 0.3583, "比不填洼更差"),
        ("排水异质（p63）", 19.10, 0.3173, "点位翻倍但不改面积"),
        ("加性校正（p58）", "—", 0.0909, "留出验证可迁移，但非物理"),
    ]

    best = min(rows, key=lambda r: r["点位MAE_m"])
    closes = (abs(best["面积相对观测倍数"] - 1.0) < 0.5
              and best["点位MAE_m"] < TARGET_MAE * 1.5)

    payload = {
        "名称": "组合测试与总结：六种机制逐一试过，无一闭合",
        "生成时间": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "目标": {"湿格面积_pct": TARGET_AREA, "点位均值_m": TARGET_PT,
               "点位MAE_m": TARGET_MAE,
               "来源": "全部来自既有实测（p56 SAR / p25 观测 / p58 留出校正），非新设"},
        "单机制汇总": [{"机制": a, "湿格面积_pct": b, "点位MAE_m": c,
                    "备注": d} for a, b, c, d in singles],
        "组合测试": rows,
        "最优组合": best,
        "是否闭合": bool(closes),
        "结论": [],
        "边界": [
            "所有新机制默认关闭（concentration_rate=0、drainage_mult=None、初损 0），"
            "故主链结论与产物数字**未被改动**；本件是诊断实验，不进主链。",
            "组合只试了 5 组，未做全面搜索。",
            "排水乘子仍是结构先验，非实测管网。",
            "rate 与初损量级均无实测标定。",
            "未做跨事件验证。",
        ],
    }

    concl = [
        ("**八条单机制，没有一条把面积拉近 2.19% 或把 MAE 压到 0.09**："
         + "；".join(f"{a}→{d}" for a, _, _, d in singles) + "。"),
        (f"**最优组合是「{best['组合']}」**：面积 "
         f"{best['湿格面积_pct']}%（{best['面积相对观测倍数']}×）、"
         f"MAE {best['点位MAE_m']}、残差均值 {best['残差均值_m']:+}。"),
    ]
    if closes:
        concl.append("**该组合基本闭合**——可作为下一版主链候选。")
    else:
        concl.append(
            "**没有任何组合闭合。** 面积仍在观测的 "
            f"{best['面积相对观测倍数']} 倍以上，MAE 仍是目标 "
            f"{TARGET_MAE} 的 {best['点位MAE_m']/TARGET_MAE:.1f} 倍。")
        concl.append(
            "**所以问题不在『缺某一个机制』，而在模型类别**："
            "本模型用**均匀管网 + 浅水图通量**表达城市排水，"
            "而真实系统是**管网容量沿街道强异质、且下穿隧道靠单根支管**。"
            "八个机制都只是在这个类别内部微调，故都碰不到量级差。")
        concl.append(
            "**唯一真正闭合的是 p58 的加性校正（MAE 0.0909）**，"
            "但它不是物理——它是『按现有口径比对需加 0.36 m』的经验修正，"
            "且成因未分离（模型偏浅 vs 点位/格点口径差，p59 已排除后者的大部分）。")
    payload["结论"] = concl

    (OUT / "p65_机制组合与总结.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n  最优组合 {best['组合']}  面积 {best['湿格面积_pct']}%  "
          f"MAE {best['点位MAE_m']}")
    print(f"  是否闭合 {bool(closes)}")
    print(f"→ {OUT / 'p65_机制组合与总结.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
