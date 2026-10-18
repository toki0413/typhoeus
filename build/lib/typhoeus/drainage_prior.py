"""p63 把已验证的排水异质接进主链：按结构类型给排水乘子。

不是新机制
----------
`drainage_mult` 早已存在（p31），实测把下穿立交排水降到 0.10 倍时
FP006 由 0.001 m 升到 **0.467 m**，与实测 0.50 m 只差 7%。
但**主链一直用 uniform**，所以全链系统性偏浅。

本件检验：把它接进来，点位误差与湿格面积能改多少。

非循环的约束
------------
乘子按**结构类型的物理先验**给，不按观测水深拟合：
  下穿立交 ×0.10 —— p31 的理由是"下穿立交往往只靠一根支管"，
                    主干管与支管输水能力差一个量级（结构性先验）
  低洼小区 ×0.50 —— 内部支管，弱于主干但不至于像单根
  低洼路段 ×0.70 —— 路面汇流为主，靠边沟
  桥洞     ×0.10 —— 同下穿立交（同一类封闭低点）

**关键是这些数不来自观测水深**，只来自结构判别。故用它检验 17 点不算自证。

三组对照
--------
  U  均匀（现状）
  P  仅下穿立交 ×0.10（p31 的原始口径，最不冒险）
  A  四种结构全按上表（结构性先验）

用法：python -m typhoeus.drainage_prior
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

    cfg = CFG.Config()
    inp = D.load_all(cfg.l2.bbox, cfg.l4.resample)
    g = inp.grid
    lon, lat = np.asarray(g.lon), np.asarray(g.lat)
    rain, _ = RS.get_rainfall(g, stations=OB.load_rain_stations(),
                              use_cache=True, calibrate=cfg.l2.rain_calibrate,
                              verbose=False)
    base_kp = CLI._kernel_params(cfg)
    area_ha = float(g.elev.size) * (g.cell_m ** 2) / 1e4

    def build_mults(kinds: set[str]):
        """按结构类型在建点周围放圆盘乘子。返回 (mult, 命中点数)。"""
        m = np.ones(g.elev.shape, dtype="float64")
        hit = 0
        for r in ledger:
            st = r["structure_type"]
            if st not in kinds:
                continue
            x, y = float(r["lon"]), float(r["lat"])
            if not (lon.min() <= x <= lon.max() and lat.min() <= y <= lat.max()):
                continue
            i = int(np.abs(lat - y).argmin())
            j = int(np.abs(lon - x).argmin())
            r0, r1 = max(0, i - RAD), min(g.elev.shape[0], i + RAD + 1)
            c0, c1 = max(0, j - RAD), min(g.elev.shape[1], j + RAD + 1)
            yy, xx = np.mgrid[r0:r1, c0:c1]
            disc = (yy - i) ** 2 + (xx - j) ** 2 <= RAD ** 2
            m[r0:r1, c0:c1][disc] = PRIOR[st]
            hit += 1
        return m, hit

    variants = [
        ("U_均匀现状", None, "主链现状"),
        ("P_仅下穿立交×0.10", {"下穿立交"}, "p31 原始口径，最不冒险"),
        ("A_四结构先验", set(PRIOR), "全按结构类型给乘子"),
    ]

    rows = []
    for name, kinds, note in variants:
        kp = copy.copy(base_kp)
        hit = 0
        if kinds is None:
            kp.drainage_mult = None
            kp.drainage_profile = "uniform"
        else:
            mult, hit = build_mults(kinds)
            kp.drainage_mult = mult
            kp.drainage_profile = f"prior_{name.split('_')[0]}"
        t0 = time.perf_counter()
        res = K.run(g, rain, kp)
        el = round(time.perf_counter() - t0, 1)
        peak = np.asarray(res.depth).max(axis=0)
        mod_pt = []
        for p in pts:
            r = next((x for x in ledger if x["point_id"] == p["编号"]), None)
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
            "方案": name, "说明": note, "命中点数": hit,
            "指纹": res.drainage_fingerprint,
            "峰值最大_m": round(float(peak.max()), 4),
            "湿格面积_pct": round(wet, 3),
            "面积相对观测倍数": round(wet / TARGET_AREA, 2),
            "点位均值_m": round(float(np.nanmean(mod_pt)), 4),
            "点位MAE_m": round(float(np.nanmean(np.abs(resi))), 4),
            "残差均值_m": round(float(np.nanmean(resi)), 4),
            "守恒残差": float(f"{res.mass_resid:.2e}"),
            "内核_s": el,
        })
        print(f"    {name:<20} 点 {hit:>2}  湿格 {wet:6.2f}%（{wet/TARGET_AREA:4.2f}×）"
              f"  点位 {np.nanmean(mod_pt):.4f}  MAE {np.nanmean(np.abs(resi)):.4f}"
              f"  残差均值 {np.nanmean(resi):+.4f}")

    base = rows[0]
    improved = [r for r in rows[1:]
                if r["点位MAE_m"] < base["点位MAE_m"]
                and abs(r["面积相对观测倍数"] - 1.0)
                < abs(base["面积相对观测倍数"] - 1.0)]
    offset_gone = [r for r in rows if abs(r["残差均值_m"]) < 0.05]

    payload = {
        "名称": "把已验证的排水异质接进主链（按结构类型先验）",
        "生成时间": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "为什么这不是新机制": (
            "drainage_mult 早已存在（p31），实测下穿立交 ×0.10 时 FP006 由 "
            "0.001 m 升到 0.467 m（对实测 0.50 m 差 7%）。"
            "但**主链一直用 uniform**，故全链系统性偏浅。本件把它接进来。"),
        "非循环的理由": (
            "乘子按**结构类型**给（下穿立交靠单根支管、小区靠内部支管、"
            "路段靠边沟），**不按观测水深拟合**。故用 17 点检验不算自证。"),
        "先验乘子": PRIOR,
        "圆盘半径_格": RAD,
        "方案": rows,
        "基线": base,
        "同时改善": bool(improved),
        "可证伪预测": {
            "预测": "若偏浅由排水均匀造成，接进异质排水中残差均值应趋 0",
            "实测": [{"方案": r["方案"], "残差均值_m": r["残差均值_m"]}
                   for r in rows],
            "是否消失": bool(offset_gone),
        },
        "结论": [],
        "边界": [
            "**乘子仍是先验，不是实测**：没有管网台账，0.10/0.50/0.70 是量级假设。",
            "圆盘半径 2 格（约 108 m）是任意值，未做半径敏感性。",
            "只改了 17 个点附近的排水，域内其余仍均匀——真实管网是连续网络。",
            "17 点中 11 点在域外，实际改动点数为命中点数。",
            "未做跨事件验证；若换一场雨，先验乘子未必仍合适。",
        ],
    }

    concl = [
        (f"**基线（均匀）**：湿格 {base['湿格面积_pct']}%"
         f"（{base['面积相对观测倍数']}×）、点位均值 {base['点位均值_m']}、"
         f"MAE {base['点位MAE_m']}、残差均值 {base['残差均值_m']:+}。"),
        ("**三种方案**："
         + "；".join(f"{r['方案']} → 面积 {r['湿格面积_pct']:.2f}%/"
                    f"MAE {r['点位MAE_m']:.3f}/残差 {r['残差均值_m']:+.3f}"
                    for r in rows) + "。"),
    ]
    if improved:
        concl.append(
            "**存在同时改善两者的方案**："
            + "、".join(r["方案"] for r in improved)
            + " → **排水异质确实同时压面积与抬点位**。"
            "这与 p45『85.4% 雨量走管网』一致：管网是主控，它的空间异质才是关键。")
    else:
        concl.append("**没有方案同时改善两者。**")
    if offset_gone:
        concl.append(
            "**可证伪预测成立**：残差均值已降到 ±0.05 m 内，"
            "偏移确由『排水均匀』造成。")
    else:
        concl.append(
            "**可证伪预测未成立**：残差均值仍在 ±0.05 m 之外。"
            "说明除排水均匀外仍有其他机制（如真实汇流路径）。")
    payload["结论"] = concl

    (OUT / "p63_排水异质接主链.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n  同时改善 {bool(improved)}  偏移消失 {bool(offset_gone)}")
    print(f"→ {OUT / 'p63_排水异质接主链.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
