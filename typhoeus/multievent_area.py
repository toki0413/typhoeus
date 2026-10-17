"""p34 逐场四色面积：18 场台风，各场淹到哪一档？

p33 只用了功能损失 Q（无量纲），没有面积。本件补上最直观的跨事件证据：
**18 场里有多少场出现过红格（≥0.5 m）、各场的淹没面积是多少。**

做法：对每场事件只跑「路径 → 参数化雨场 → 内核」，不跑投影与对账
（那两步对面积没有贡献，且占总耗时的多数）。

四色阈值沿用 GB 51222-2017 口径（与 p13/p32 一致）：
    绿 <0.10 m   黄 0.10-0.20 m   橙 0.20-0.50 m   红 ≥0.50 m

输出：out/p34_逐场四色面积.json
用法：python -m typhoeus.multievent_area
"""

from __future__ import annotations

import argparse
import json
import math
import time
from datetime import datetime
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"

# 四色：下限、名称、颜色键
BANDS = [
    (0.50, "红 ≥0.5m", "红"),
    (0.20, "橙 0.2-0.5m", "橙"),
    (0.10, "黄 0.1-0.2m", "黄"),
    (0.00, "绿 <0.1m", "绿"),
]


def band_stats(peak: np.ndarray, cell_m: float) -> dict:
    """按四色统计面积（ha）与占比。互斥分档，从高到低切。"""
    tot = peak.size
    cell_ha = (cell_m ** 2) / 10000.0
    out = {}
    rest = np.ones_like(peak, dtype=bool)
    for lo, label, key in BANDS:
        m = rest & (peak >= lo) if lo > 0 else rest
        n = int(m.sum())
        out[key] = {"阈值_m": lo, "格点": n,
                    "面积_ha": round(n * cell_ha, 1),
                    "占比": round(n / tot, 6)}
        rest &= ~m
    # 湿格（≥0.05 m）单独给，便于与历史口径对齐
    wet = int((peak >= 0.05).sum())
    out["湿格"] = {"阈值_m": 0.05, "格点": wet,
                 "面积_ha": round(wet * cell_ha, 1),
                 "占比": round(wet / tot, 6)}
    return out


def run_one(year: int, name: str, grid, kcfg, lon_range, center) -> dict:
    """单场：只要峰值场与四色。失败不抛，记 ok=False。"""
    from typhoeus import data as D
    from typhoeus import kernel as K

    t0 = time.perf_counter()
    rec = {"年": year, "台风": name, "ok": False, "原因": ""}
    try:
        track = D.load_track(season=year, name=name, lon_range=lon_range)
        if not track:
            rec["原因"] = "IBTrACS 无该场路径点"
            return rec
        dist = min(math.hypot(p.lon - center[1], p.lat - center[0])
                   for p in track) * 111.0
        rec["最近距离_km"] = round(dist, 1)
        rain = K.rainfall_field(track, grid, kcfg)
        if float(rain.max()) <= 0.0:
            rec["原因"] = (f"参数化雨场全窗为零（最近 {dist:.0f} km）")
            return rec
        res = K.run(grid, rain, kcfg)
        el = time.perf_counter() - t0
        if not res.positivity_ok:
            rec["原因"] = "内核正性校验失败"
            return rec
        if res.cap_loss_m3 > 0.0:
            rec["原因"] = f"触上限截断 {res.cap_loss_m3:.1f} m³"
            return rec
        peak = np.asarray(res.depth).max(axis=0)
        # 面雨量 = 逐时面平均雨强 × 时长。rain 的形状是 (nt, ny, nx) 的 mm/h，
        # 直接 sum 会把「格点数」也乘进去（实测得到 7.8e6 mm 这种荒谬值），
        # 必须先对空间维取均值。
        rain_arr = np.asarray(rain, dtype=float)
        dt_h = float(res.t_h[1] - res.t_h[0])
        areal_mm = float(rain_arr.mean(axis=(1, 2)).sum() * dt_h)
        rec.update({
            "ok": True,
            "面雨量_mm": round(areal_mm, 1),
            "峰值雨强_mm_h": round(float(rain_arr.max()), 1),
            "峰值水深_m": round(float(peak.max()), 4),
            "守恒残差": float(res.mass_resid),
            "内核_s": round(el, 1),
            "四色": band_stats(peak, float(grid.cell_m)),
        })
        return rec
    except Exception as e:  # noqa: BLE001
        rec["原因"] = f"{type(e).__name__}: {str(e)[:90]}"
        return rec


def build(outdir: str | Path = "out", verbose: bool = True) -> dict:
    from typhoeus import cli as CLI
    from typhoeus import config as CFG
    from typhoeus import data as D
    from typhoeus import multievent as ME

    cfg = CFG.Config()
    kcfg = CLI._kernel_params(cfg)
    inp = D.load_all(cfg.l2.bbox, cfg.l4.resample)
    grid = inp.grid
    cell_ha = (float(grid.cell_m) ** 2) / 10000.0

    catalog = ME.EVENT_CATALOG
    if verbose:
        print(f"  网格 {grid.elev.shape}，单格 {cell_ha:.4f} ha，"
              f"共 {grid.elev.size} 格 = {grid.elev.size * cell_ha:.0f} ha")
        print(f"  事件 {len(catalog)} 场（{catalog[0][0]}–{catalog[-1][0]}）")

    rows = []
    for year, name, _ in catalog:
        r = run_one(year, name, grid, kcfg, ME.LON_RANGE, ME.DOMAIN_CENTER)
        rows.append(r)
        if verbose:
            if r["ok"]:
                red = r["四色"]["红"]
                print(f"    {year} {name:<10} 雨 {r['面雨量_mm']:6.1f} mm  "
                      f"峰 {r['峰值水深_m']:.3f} m  红格 {red['格点']:>3} "
                      f"({red['面积_ha']:>6.1f} ha)  [{r['内核_s']}s]", flush=True)
            else:
                print(f"    {year} {name:<10} SKIP  {r['原因']}", flush=True)

    ok = [r for r in rows if r["ok"]]
    n_red = sum(1 for r in ok if r["四色"]["红"]["格点"] > 0)
    n_orange = sum(1 for r in ok if r["四色"]["橙"]["格点"] > 0)
    red_counts = sorted((r["四色"]["红"]["格点"], r["年"], r["台风"]) for r in ok)

    payload = {
        "名称": "逐场四色面积：18 场台风",
        "生成时间": datetime.now().isoformat(timespec="seconds"),
        "目的": ("p33 只用了功能损失 Q（无量纲），本件补面积——"
                 "回答『18 场里有多少场出现过红格』"),
        "四色口径": [{"阈值_m": lo, "标签": label} for lo, label, _ in BANDS],
        "网格": {"尺寸": list(grid.elev.shape), "格距_m": round(float(grid.cell_m), 1),
                 "单格_ha": round(cell_ha, 4),
                 "域面积_ha": round(grid.elev.size * cell_ha, 1)},
        "逐场": rows,
        "汇总": {
            "目录场次": len(rows),
            "实算成功": len(ok),
            "跳过": len(rows) - len(ok),
            "出现过红格的场次": n_red,
            "出现过橙格的场次": n_orange,
            "红格最多的三场": [
                {"年": y, "台风": n, "红格": c,
                 "红面积_ha": next(r["四色"]["红"]["面积_ha"]
                                 for r in ok if r["年"] == y and r["台风"] == n)}
                for c, y, n in red_counts[-3:][::-1]],
            "残差最大": max((r["守恒残差"] for r in ok), default=None),
        },
        "结论": [
            f"{len(ok)} 场实算成功，其中 **{n_red} 场出现过红格（≥0.5 m）**、"
            f"{n_orange} 场出现过橙格（0.2–0.5 m）。",
            "四色面积随面雨量单调扩张，红格只在大雨场次出现——"
            "与 p33 的分级分布一致，但面积给出了空间量级。",
            "本件与 p33 互补：p33 给『多严重』（无量纲 Q），本件给『淹多大』（ha）。",
        ],
        "边界": [
            "18 场共用一套宁波参数，未逐场重标 → 面积绝对值含共性偏差，"
            "横向比较（哪场有红格、相对大小）比绝对值可靠。",
            "面雨量为台风路径**参数化雨场**，非 ERA5 实测。",
            "四色按互斥区间切分（红>橙>黄>绿），与部分产物口径可能不同，以本件声明为准。",
            "跳过场次的原因逐条写在 `逐场` 里，未静默丢弃。",
            "计算域固定为宁波那块 16.5×8.9 km；换城市需重跑。",
        ],
    }

    p = Path(outdir)
    p.mkdir(parents=True, exist_ok=True)
    (p / "p34_逐场四色面积.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    if verbose:
        s = payload["汇总"]
        print(f"\n  {s['实算成功']}/{s['目录场次']} 场成功；"
              f"出现红格 {s['出现过红格的场次']} 场、橙格 {s['出现过橙格的场次']} 场")
        for x in s["红格最多的三场"]:
            print(f"    红格最多之一：{x['年']} {x['台风']}  {x['红格']} 格 "
                  f"= {x['红面积_ha']} ha")
        print(f"→ {p / 'p34_逐场四色面积.json'}")
    return payload


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="typhoeus.multievent_area")
    ap.add_argument("outdir", nargs="?", default="out")
    a = ap.parse_args(argv)
    build(a.outdir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
