"""p66 杠杆排序是否指标无关：三个指标下的四轴敏感度。

问题
----
`p44` 的杠杆排序（排水 ×2.81 > 集中度 ×1.64 > 总量 ×1.19 > 土壤 ×1.01）
是在**域内峰值水深**上测的。而产品真正要用它回答的是
「该先投哪条轴」——那是**点位/面积**层面的事。

若换指标排序就变，则「先投排水」这句话是**指标依赖**的，必须声明。
若不变，则该建议稳健。

三个指标
--------
  M1 域内峰值水深（p44 的口径，复现对照）
  M2 **17 个涝点的平均水深**（点位层，产品实际关心的量）
  M3 **红格面积**（p47 的序参，规划关心的量）

四条轴（各取极值两端，共 8 次求解 + 1 次基线）
  A 总量：p50 258.4 → p95 354.1（等比缩放降雨）
  B 集中度：a=0 → a=1.5（条带集中度）
  C 土壤容量：30 → 600 mm
  D 排水顶托：0.01 → 0.50 m

用法：python -m typhoeus.leverage_metrics
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
BASE_MM = 258.4


def concentration_rain(base_rain: np.ndarray, a: float) -> np.ndarray:
    """按集中度 a 重塑空间型：a=0 均匀，a>0 压成条带。

    与 p43 同一构造：以域中心为轴，沿 y 方向做高斯条带，
    把总雨量重分布到条带上，a 越大条带越窄。
    """
    nt, ny, nx = base_rain.shape
    if a <= 0:
        return base_rain
    yy = np.arange(ny, dtype=float)[:, None]
    cy = (ny - 1) / 2.0
    sigma = max(ny / (2.0 + 6.0 * a), 1.0)
    w = np.exp(-0.5 * ((yy - cy) / sigma) ** 2)
    w = np.broadcast_to(w, (ny, nx))
    w = w / w.mean()                     # 保总量
    return base_rain * w[None, :, :]


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
    rain0, _ = RS.get_rainfall(g, stations=OB.load_rain_stations(),
                               use_cache=True, calibrate=cfg.l2.rain_calibrate,
                               verbose=False)
    rain0 = np.asarray(rain0, float)
    kp0 = CLI._kernel_params(cfg)
    area_ha = float(g.elev.size) * (g.cell_m ** 2) / 1e4

    # 点位置索引（只取域内）
    pid_idx = []
    for p in pts:
        r = ledger.get(p["编号"])
        if r is None:
            continue
        x, y = float(r["lon"]), float(r["lat"])
        if not (lon.min() <= x <= lon.max() and lat.min() <= y <= lat.max()):
            continue
        pid_idx.append((int(np.abs(lat - y).argmin()),
                        int(np.abs(lon - x).argmin())))
    print(f"  域内点 {len(pid_idx)} 个")

    def metrics(rain, kp):
        res = K.run(g, rain, kp)
        peak = np.asarray(res.depth).max(axis=0)
        m1 = float(peak.max())
        m2 = float(np.mean([peak[i, j] for i, j in pid_idx])) if pid_idx else np.nan
        m3 = float((peak >= RED_TH).sum()) * (g.cell_m ** 2) / 1e4
        return m1, m2, m3

    t0 = time.perf_counter()
    b1, b2, b3 = metrics(rain0, kp0)
    print(f"  基线：峰值 {b1:.4f} m  点位均值 {b2:.4f} m  红格 {b3:.2f} ha")

    # 每轴两个极值端
    axes = []

    # A 总量：按倍数缩放
    for tag, mult in (("A_low", 258.4 / BASE_MM), ("A_high", 354.1 / BASE_MM)):
        axes.append(("A 总量", tag, rain0 * mult, copy.copy(kp0)))

    # B 集中度
    for tag, a in (("B_low", 0.0), ("B_high", 1.5)):
        axes.append(("B 集中度", tag, concentration_rain(rain0, a),
                     copy.copy(kp0)))

    # C 土壤容量
    for tag, cap in (("C_low", 30.0), ("C_high", 600.0)):
        kp = copy.copy(kp0)
        kp.soil_capacity_mm = cap
        axes.append(("C 土壤容量", tag, rain0, kp))

    # D 排水顶托
    for tag, inv in (("D_low", 0.01), ("D_high", 0.50)):
        kp = copy.copy(kp0)
        kp.drainage_invert_m = inv
        axes.append(("D 排水顶托", tag, rain0, kp))

    got: dict[str, dict[str, float]] = {}
    for axis, tag, rain, kp in axes:
        m1, m2, m3 = metrics(rain, kp)
        got.setdefault(axis, {})[tag] = (m1, m2, m3)
        print(f"    {axis:<10} {tag:<7} 峰值 {m1:.4f}  点位 {m2:.4f}  红格 {m3:.2f}")

    rows = []
    for axis, d in got.items():
        if "A_low" in d:
            lo, hi = d.get("A_low"), d.get("A_high")
        elif "B_low" in d:
            lo, hi = d.get("B_low"), d.get("B_high")
        elif "C_low" in d:
            lo, hi = d.get("C_low"), d.get("C_high")
        else:
            lo, hi = d.get("D_low"), d.get("D_high")
        if not lo or not hi:
            continue

        def ratio(i):
            a, b = lo[i], hi[i]
            if a and a > 1e-9:
                return b / a
            return np.nan if b == 0 else np.inf

        rows.append({
            "轴": axis,
            "杠杆_M1_域内峰值": round(ratio(0), 3) if np.isfinite(ratio(0)) else None,
            "杠杆_M2_点均水深": round(ratio(1), 3) if np.isfinite(ratio(1)) else None,
            "杠杆_M3_红格面积": round(ratio(2), 3) if np.isfinite(ratio(2)) else None,
            "M3_低端_ha": round(lo[2], 2), "M3_高端_ha": round(hi[2], 2),
        })

    def ranking(key):
        vals = [(r["轴"], r[key]) for r in rows if r[key] is not None]
        vals.sort(key=lambda x: -(x[1] if x[1] is not None else -1))
        return [v[0] for v in vals]

    r1 = ranking("杠杆_M1_域内峰值")
    r2 = ranking("杠杆_M2_点均水深")
    r3 = ranking("杠杆_M3_红格面积")
    stable = (r1 == r2 == r3)

    payload = {
        "名称": "杠杆排序是否指标无关：三个指标下的四轴敏感度",
        "生成时间": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "为什么问这个": (
            "p44 的杠杆排序（排水×2.81 > 集中度×1.64 > 总量×1.19 > 土壤×1.01）"
            "是在**域内峰值水深**上测的。而产品用它回答『该先投哪条轴』，"
            "那是点位/面积层面的事。若换指标排序就变，则该建议是指标依赖的。"),
        "基线": {"峰值_m": round(b1, 4), "点位均值_m": round(b2, 4),
               "红格_ha": round(b3, 2)},
        "四轴极值端": {k: {t: [round(x, 4) for x in v] for t, v in d.items()}
                  for k, d in got.items()},
        "杠杆": rows,
        "排序": {"M1_域内峰值": r1, "M2_点均水深": r2, "M3_红格面积": r3},
        "三个指标排序一致": bool(stable),
        "耗时_s": round(time.perf_counter() - t0, 1),
        "结论": [],
        "边界": [
            "集中度用「以域中心为轴的高斯条带」构造，与 p43 同思路但参数未必逐位相同。",
            "总量轴按 258.4→354.1 等比缩放，即 p50→p95 的两端。",
            "点位均值只在域内点上算（11 点），样本小，敏感度数字有抽样噪声。",
            "红格面积在基线为 0，故其杠杆可能为 ∞ 或不可定义——已单列两端值。",
            "各轴独立取极值，未做交互。",
            "本件不改变任何既有产物。",
        ],
    }

    concl = [
        f"**三个指标的排序**：M1 峰值 {r1}；M2 点位 {r2}；M3 红格 {r3}。",
    ]
    if stable:
        concl.append(
            "**三者在四条轴上的排序完全一致** → 『先投排水』这个建议**与指标无关**，"
            "可放心使用。")
    else:
        concl.append(
            "**排序随指标变化** → 『先投排水』是**指标依赖**的结论："
            f"在峰值上排序为 {r1}，在点位上为 {r2}，在红格上为 {r3}。"
            "产品若用它指导投资，必须声明是在哪个指标上得出的。")
        concl.append(
            "**为什么这很重要**：我们的点位水深本身已被证明不可用"
            "（八机制试验，见 p65）。若杠杆排序也只在峰值上成立，"
            "那么『先投排水』这句话就**同时依赖一个不可用的指标**。")
    payload["结论"] = concl

    (OUT / "p66_杠杆指标一致性.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print("\n  M1 峰值排序:", r1)
    print("  M2 点位排序:", r2)
    print("  M3 红格排序:", r3)
    print(f"  三者一致: {bool(stable)}")
    print(f"→ {OUT / 'p66_杠杆指标一致性.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
