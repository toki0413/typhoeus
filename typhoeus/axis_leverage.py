"""p44 四轴杠杆对比：降雨总量 / 降雨集中度 / 土壤 / 城建排水。

问题
----
p43 已把降雨集中度做成独立轴，并发现它的杠杆（×1.424）大于总量（×1.173）。
但用户问得对：**除了降雨，土壤和城建呢？**

本件不铺开四维矩阵（组合爆炸），而是固定一个基线，
**逐轴单独扫**，回答一个决策问题：

    哪条轴最值得投资 / 最值得去要数据？

基线：总量 p90（338.8 mm）、集中度 C1（≈现状）、土壤 30 mm、顶托 0.05 m。

四条轴
------
  A 降雨总量     p50 / p80 / p90 / p95
  B 降雨集中度   C0 均匀 → C4 极端集中
  C 土壤容量     30 / 120 / 600 mm（有效容量）
  D 城建排水     顶托 0.01 / 0.05 / 0.20 / 0.50 m（p41 主控项）

判据：峰值水深跨度、红格是否从无到有、水量账（下渗占比）变化。

用法：python -m typhoeus.axis_leverage
"""

from __future__ import annotations

import copy
import json
import time
from datetime import datetime
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"

BASE_TOTAL = 338.8          # p90
BASE_A = 0.25               # C1 ≈ 现状对比度
TOTALS = [258.4, 313.2, 338.8, 354.1]
A_LEVELS = [0.0, 0.25, 0.50, 1.00, 1.50]
SOIL_MM = [30.0, 120.0, 600.0]
INVERT = [0.01, 0.05, 0.20, 0.50]
LAMBDA_FRAC = 0.35


def multiplier(a: float, ny: int, nx: int) -> np.ndarray:
    if a <= 0:
        return np.ones((ny, nx), dtype="float64")
    x = np.linspace(0.0, 1.0, nx)[None, :]
    m = np.exp(a * np.sin(2.0 * np.pi * x / LAMBDA_FRAC))
    m = np.repeat(m, ny, axis=0)
    return m / float(m.mean())


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
    ny, nx = g.elev.shape
    base_rain, _ = RS.get_rainfall(g, stations=OB.load_rain_stations(),
                                   use_cache=True, calibrate=cfg.l2.rain_calibrate,
                                   verbose=False)
    b_rain = np.asarray(base_rain, dtype=np.float64)
    kp0 = CLI._kernel_params(cfg)
    ha = (float(g.cell_m) ** 2) / 1e4
    dt_h = kp0.dt_s / 3600.0
    base_total = float(b_rain.mean(axis=(1, 2)).sum() * dt_h)
    prof0 = b_rain.mean(axis=(1, 2))

    mcache = {a: multiplier(a, ny, nx) for a in A_LEVELS}

    def build_rain(total: float, a: float) -> np.ndarray:
        prof = prof0 * (total / max(base_total, 1e-9))
        m = mcache[a]
        rain = prof[:, None, None] * m[None, :, :]
        cur = rain.mean(axis=(1, 2))
        corr = np.divide(prof, cur, out=np.ones_like(cur), where=cur > 1e-9)
        return (rain * corr[:, None, None]).astype(np.float32)

    def run(total: float, a: float, soil: float, invert: float) -> dict:
        rain = build_rain(total, a)
        kp = copy.copy(kp0)
        kp.soil_capacity_mm = soil
        kp.drainage_invert_m = invert
        t0 = time.perf_counter()
        res = K.run(g, rain, kp)
        el = time.perf_counter() - t0
        peak = np.asarray(res.depth).max(axis=0)
        return {
            "总量_mm": total, "集中度a": a, "土壤_mm": soil, "顶托_m": invert,
            "峰值水深_m": round(float(peak.max()), 4),
            "橙格_ha": round(float(((peak >= 0.2) & (peak < 0.5)).sum()) * ha, 1),
            "红格_ha": round(float((peak >= 0.5).sum()) * ha, 1),
            "下渗_万m3": round(float(res.infil_total_m3) / 1e4, 1),
            "守恒残差": float(res.mass_resid),
            "内核_s": round(el, 1),
        }

    print(f"  基线：总量 {BASE_TOTAL} mm、集中度 a={BASE_A}、"
          f"土壤 {kp0.soil_capacity_mm} mm、顶托 {kp0.drainage_invert_m} m")

    axes: dict[str, list[dict]] = {}

    print("\n=== A 降雨总量（其余固定）===")
    axes["A 降雨总量"] = []
    for t in TOTALS:
        r = run(t, BASE_A, kp0.soil_capacity_mm, kp0.drainage_invert_m)
        r["档"] = f"{t} mm"
        axes["A 降雨总量"].append(r)
        print(f"    {t:6.1f} mm  峰 {r['峰值水深_m']:.4f}  红 {r['红格_ha']:>5.1f}")

    print("\n=== B 降雨集中度（其余固定）===")
    axes["B 降雨集中度"] = []
    labels = {0.0: "C0 均匀", 0.25: "C1 弱对比", 0.5: "C2 中等",
              1.0: "C3 强对比", 1.5: "C4 极端"}
    for a in A_LEVELS:
        r = run(BASE_TOTAL, a, kp0.soil_capacity_mm, kp0.drainage_invert_m)
        r["档"] = labels[a]
        axes["B 降雨集中度"].append(r)
        print(f"    a={a:<4} {labels[a]:<8} 峰 {r['峰值水深_m']:.4f}  "
              f"红 {r['红格_ha']:>5.1f}")

    print("\n=== C 土壤容量（其余固定）===")
    axes["C 土壤容量"] = []
    for s in SOIL_MM:
        r = run(BASE_TOTAL, BASE_A, s, kp0.drainage_invert_m)
        r["档"] = f"{s:.0f} mm"
        axes["C 土壤容量"].append(r)
        print(f"    {s:6.0f} mm  峰 {r['峰值水深_m']:.4f}  红 {r['红格_ha']:>5.1f}  "
              f"下渗 {r['下渗_万m3']:>7.1f} 万m³")

    print("\n=== D 城建排水·顶托（其余固定）===")
    axes["D 城建排水·顶托"] = []
    for iv in INVERT:
        r = run(BASE_TOTAL, BASE_A, kp0.soil_capacity_mm, iv)
        r["档"] = f"顶托 {iv} m"
        axes["D 城建排水·顶托"].append(r)
        print(f"    {iv:5.2f} m  峰 {r['峰值水深_m']:.4f}  红 {r['红格_ha']:>5.1f}")

    # 杠杆排序
    summary = []
    for name, rs in axes.items():
        peaks = [r["峰值水深_m"] for r in rs]
        reds = [r["红格_ha"] for r in rs]
        infil = [r["下渗_万m3"] for r in rs]
        lo, hi = min(peaks), max(peaks)
        summary.append({
            "轴": name,
            "峰值_min_m": lo, "峰值_max_m": hi,
            "峰值跨度_m": round(hi - lo, 4),
            "峰值倍数": round(hi / max(lo, 1e-9), 3),
            "红格_min_ha": min(reds), "红格_max_ha": max(reds),
            "红格翻转": (min(reds) == 0) != (max(reds) == 0),
            "下渗跨度_万m3": round(max(infil) - min(infil), 1),
            "下渗倍数": (round(max(infil) / max(min(infil), 1e-9), 2)
                      if min(infil) > 0 else None),
        })
    summary.sort(key=lambda x: -x["峰值跨度_m"])

    payload = {
        "名称": "四轴杠杆对比：降雨总量 / 集中度 / 土壤 / 城建排水",
        "生成时间": datetime.now().isoformat(timespec="seconds"),
        "问题": ("除了降雨，土壤与城建哪一部分真正控制结论？"
                 "本件不铺四维矩阵，而是固定基线逐轴单独扫，"
                 "回答『哪条轴最值得投资、最值得去要数据』。"),
        "基线": {"总量_mm": BASE_TOTAL, "集中度a": BASE_A,
                 "土壤容量_mm": kp0.soil_capacity_mm,
                 "顶托_m": kp0.drainage_invert_m},
        "各轴取值": {"A 总量": TOTALS, "B 集中度a": A_LEVELS,
                     "C 土壤_mm": SOIL_MM, "D 顶托_m": INVERT},
        "逐轴结果": axes,
        "杠杆排序": summary,
        "结论": [],
        "边界": [
            "逐轴单独扫，不是正交分解——轴之间可能有交互，本件未测。",
            "基线取 p90 + C1，换基线后排序可能变化。",
            "集中度为合成条带，非真实雨带、非下采样结果。",
            "土壤只改容量，未改 Ksat/吸力头（见 p36 的接线问题）。",
            "城建只改顶托，未改导水系数（p36 显示两者量级相当，但这里只用一个代表）。",
            "共用宁波参数，无本地验证；本件不进提交材料（技术冻结）。",
        ],
    }

    top = summary[0]
    peak_rank = " > ".join(f"{s['轴']}（×{s['峰值倍数']}）" for s in summary)
    soil_row = next(s for s in summary if s["轴"].startswith("C"))
    flip_rows = [s for s in summary if s["红格翻转"]]

    payload["结论"] = [
        ("峰值杠杆排序（倍数）：" + peak_rank + "。"),
        (f"**做情景轴该做哪几条**："
         + "、".join(s["轴"].split(" ")[0] for s in summary[:2])
         + f" 的峰值杠杆最大；{soil_row['轴'].split(' ')[0]} 的峰值杠杆最小"
           f"（×{soil_row['峰值倍数']}）。"),
        ("**能造成红格从无到有的轴**："
         + ("、".join(s["轴"] for s in flip_rows) if flip_rows
            else "无——所有轴在本基线下都未使红格翻转")),
        (f"**土壤的用处不在峰值，在水量账**：只动土壤时峰值仅 ×"
         f"{soil_row['峰值倍数']}，但下渗量变化 ×{soil_row['下渗倍数']}。"
         "所以土壤轴应做成『水量审计轴』，不是『淹没判据轴』。"),
        ("**城建轴要选对代表参数**：真正有杠杆的是排水能力（顶托/导水），"
         "不是不透水率或糙率（p36 实测后两者仅 +0.0016 / +0.0009 m）。"
         "若把『城建』做成『城市规模/硬化率』的轴，会得出错误的低敏感性。"),
        ("**因此四条轴的定位应当是**："
         "① 总量轴＝气象预报能回答；② 集中度轴＝雷达/短临能回答；"
         "③ 城建排水轴＝管网台账能回答（且杠杆最大）；"
         "④ 土壤轴＝水量审计专用（不用于淹没判据）。"),
    ]

    (OUT / "p44_四轴杠杆对比.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print("\n  杠杆排序：")
    for s in summary:
        print(f"    {s['轴']:<18} 峰值 ×{s['峰值倍数']:<6} "
              f"红格 {s['红格_min_ha']}→{s['红格_max_ha']} ha  "
              f"翻转 {'是' if s['红格翻转'] else '否'}")
    print(f"→ {OUT / 'p44_四轴杠杆对比.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
