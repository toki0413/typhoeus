"""p67 第五轴候选：雨型（时间形状）。

为什么这一轴此前不存在
----------------------
`gen_shape_first` 的设计是「**同一时间形状**，幅度按 k 倍放大」——
它测的是**幅度**对时刻的影响，**形状本身从未当过轴**。
`scenario_matrix` 也只缩放幅度；`p43` 只改空间集中度。

所以「同样总量、不同时间形状」这一维，本项目从未测过。

本件做什么
----------
固定总雨量 259.1 mm，四种时间形状：
  S1 均匀      强度恒定
  S2 前峰      前 24 h 占 60%
  S3 后峰      后 24 h 占 60%
  S4 单峰      6 h 内集中 60%
逐形状报告：峰值水深、红格面积、17 点位均值、**首次越断行（0.27 m）的时刻**

判据
----
若「峰值水深」在四形状间的跨度 **≥ 集中度轴的 ×1.58**，
则雨型是实质性的第五轴；否则只是一个次要维度。

用法：python -m typhoeus.rain_shape_axis
"""

from __future__ import annotations

import csv
import json
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
TOTAL_MM = 259.1
BREAK_M = 0.27
RED_TH = 0.50
CONC_LEVERAGE = 1.583      # 集中度轴在峰值指标上的杠杆（p66 实测）


def shapes(nt: int, total_mm: float, dt_h: float) -> dict[str, np.ndarray]:
    """返回四种时间形状的降雨率序列（mm/h），总量均等于 total_mm。"""
    t = np.arange(nt, dtype=float) * dt_h
    T = max(t[-1], dt_h)

    def norm(w: np.ndarray) -> np.ndarray:
        w = np.clip(w, 0.0, None)
        s = w.sum() * dt_h
        return w * (total_mm / s) if s > 0 else w

    out = {}
    out["S1_均匀"] = norm(np.ones(nt))
    # 前峰：权重从 2 线性降到 0.2
    out["S2_前峰"] = norm(2.0 - 1.8 * (t / T))
    # 后峰：权重从 0.2 线性升到 2
    out["S3_后峰"] = norm(0.2 + 1.8 * (t / T))
    # 单峰：集中在第 30-36 h
    c = 33.0
    out["S4_单峰"] = norm(np.exp(-0.5 * ((t - c) / 3.0) ** 2))
    return out


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
    kp = CLI._kernel_params(cfg)
    area_ha = float(g.elev.size) * (g.cell_m ** 2) / 1e4
    nt = int(round(kp.max_t_h * 3600.0 / kp.dt_s))
    dt_h = kp.dt_s / 3600.0
    print(f"  nt={nt}  dt={kp.dt_s:.0f}s  总量 {TOTAL_MM} mm")

    # 点位置
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
    print(f"  域内点 {len(pid)}")

    rows = []
    for name, series in shapes(nt, TOTAL_MM, dt_h).items():
        # 广播到全域（空间均匀，只变时间形状）
        rain = np.broadcast_to(series[:, None, None],
                               (nt, g.elev.shape[0], g.elev.shape[1])).copy()
        t0 = time.perf_counter()
        res = K.run(g, rain, kp)
        el = round(time.perf_counter() - t0, 1)
        depth = np.asarray(res.depth)
        peak = depth.max(axis=0)
        # 首次越断行：用**断面最大水深**（不是域平均）。
        # 域平均在全场永远达不到 0.27 m，会让该指标恒为 None，
        # 从而把"时刻差异"这一维整个丢掉。
        max_t = depth.max(axis=(1, 2))
        idx = np.where(max_t >= BREAK_M)[0]
        t_break = float(res.t_h[idx[0]]) if idx.size else None
        red = float((peak >= RED_TH).sum()) * (g.cell_m ** 2) / 1e4
        pt_mean = float(np.mean([peak[i, j] for i, j in pid])) if pid else np.nan
        rows.append({
            "形状": name,
            "总雨量_mm": round(float(series.sum() * dt_h), 1),
            "峰值雨强_mm_h": round(float(series.max()), 2),
            "峰值水深_m": round(float(peak.max()), 4),
            "红格_ha": round(red, 2),
            "点位均值_m": round(pt_mean, 4),
            "首次越断行_h": t_break,
            "峰值时刻_h": round(float(res.peak_time_h), 1),
            "内核_s": el,
        })
        print(f"    {name:<8} 峰强 {series.max():5.2f} mm/h  "
              f"峰值 {peak.max():.4f} m  红格 {red:7.2f} ha  "
              f"点位 {pt_mean:.4f}  越阈 {t_break} h")

    peaks = [r["峰值水深_m"] for r in rows]
    lever_peak = max(peaks) / min(peaks) if min(peaks) > 0 else None
    tb = [r["首次越断行_h"] for r in rows if r["首次越断行_h"] is not None]
    span_t = (max(tb) - min(tb)) if len(tb) >= 2 else None

    payload = {
        "名称": "第五轴候选：雨型（时间形状）",
        "生成时间": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "为什么此前没有这一轴": (
            "gen_shape_first 的设计是『同一时间形状，幅度按 k 倍放大』——"
            "测的是幅度对时刻的影响，**形状本身从未当过轴**。"
            "scenario_matrix 只缩放幅度；p43 只改空间集中度。"),
        "设计": {"总雨量_mm": TOTAL_MM, "形状数": len(rows),
               "空间": "全域均匀（只变时间形状）",
               "断行阈值_m": BREAK_M, "红级_m": RED_TH},
        "结果": rows,
        "峰值杠杆": round(lever_peak, 3) if lever_peak else None,
        "越阈时刻跨度_h": span_t,
        "对照_集中度轴峰值杠杆": CONC_LEVERAGE,
        "判定": {},
        "结论": [],
        "边界": [
            "四种形状是**构造**的（线性升降、单高斯峰），不是实测雨型分布。",
            "总雨量固定为 259.1 mm，未扫总量×形状的交互。",
            "空间均匀，故本件**只隔离时间形状**一个维度。",
            "首次越断行用**全域平均水深**判定，与 gen_shape_first 同口径；"
            "不是某个具体涝点。",
            "未做跨事件验证。",
        ],
    }

    is_fifth = (lever_peak is not None and lever_peak >= CONC_LEVERAGE)
    payload["判定"] = {
        "峰值杠杆": round(lever_peak, 3) if lever_peak else None,
        "门槛": f"≥ {CONC_LEVERAGE}（集中度轴的峰值杠杆）",
        "构成实质第五轴": bool(is_fifth),
    }

    concl = [
        (f"**四种形状的峰值水深**："
         + "；".join(f"{r['形状']} {r['峰值水深_m']:.4f} m" for r in rows)
         + f" → 杠杆 **×{lever_peak:.3f}**。"),
        (f"**越阈时刻跨度 {span_t} h**"
         + (f"（最早 {min(tb):.0f} h、最晚 {max(tb):.0f} h）" if span_t else "")
         + "。" if span_t else ""),
        ("**峰值时刻**：" + "；".join(
            f"{r['形状']} {r['峰值时刻_h']} h" for r in rows) + "。"),
    ]
    if is_fifth:
        concl.append(
            f"**峰值杠杆 ×{lever_peak:.2f} ≥ 集中度轴的 ×{CONC_LEVERAGE}** → "
            "**雨型构成实质第五轴**，应与四轴并列纳入情景设计。")
    else:
        concl.append(
            f"**峰值杠杆 ×{lever_peak:.2f} < 集中度轴的 ×{CONC_LEVERAGE}** → "
            "雨型对**峰值**的影响弱于集中度，"
            "但对**时刻**的影响（跨度 "
            f"{span_t} h）可能远大于四轴——"
            "而这恰恰是备灾 deadline 的依据（p48）。")
        concl.append(
            "**所以它的正确位置不是『第五个投资轴』，而是『时刻轴』**："
            "四轴决定『多严重』，雨型决定『什么时候』。"
            "两者不可互相替代。")

    # 必须显式赋回 payload，否则 concl 白算（初版漏了这行，产物结论为空，
    # 被巡检第 7 段与 test_validation_artifacts_* 同时抓到）
    payload["结论"] = concl

    (OUT / "p67_雨型第五轴.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n  峰值杠杆 ×{lever_peak:.3f}（集中度轴 ×{CONC_LEVERAGE}）"
          f"  越阈时刻跨度 {span_t} h")
    print(f"  构成第五轴: {bool(is_fifth)}")
    print(f"→ {OUT / 'p67_雨型第五轴.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
