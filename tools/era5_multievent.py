"""ERA5 强制多事件批量 + 扩目录。

前置实测（docs/superpowers/plans/2026-10-17-era5-multievent.md）：
  - 放宽风速阈值在原框内不增样本；扩框（×2）才是增量：37 场。
  - 远处场次参数化雨场被 R_FLOOR 归零，ERA5 再分析能救回真实降雨——
    扩目录与 ERA5 强制天然配对。

本驱动器不改任何既有模块的默认行为：
  - 目录自己筛（IBTrACS 重筛，框 120.4–123.2E / 27.8–31.8N，≥25 m/s，
    season ≥ 1980，路径进框且全场峰值达标）；
  - 每场 anchor = 路径最接计算域中心的时刻，ERA5 窗 anchor−12h .. anchor+3d，
    缓存分键 era5_<年><名>；
  - 内核/投影/Q 总量与主链同函数；分解四项不批量算（口径写明）；
  - 标定直接喂 multievent 的 fit_* 函数（构造 EventResult）。

产物：out_era5/era5_multievent_calibration.json

用法：
  python tools/era5_multievent.py screen          # 只筛目录
  python tools/era5_multievent.py run 1998:TODD   # 试跑单场
  python tools/era5_multievent.py run --all       # 全量
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import math
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

OUT = ROOT / "out_era5"

# 扩目录筛选参数（E1 实测：框×2 + ≥25 m/s → 37 场）
BOX = (120.4, 123.2, 27.8, 31.8)     # (lon_min, lon_max, lat_min, lat_max)
MIN_WIND_MS = 25.0
MIN_SEASON = 1980
LON_RANGE = (110.0, 140.0)
DOMAIN_CENTER = (29.88, 121.625)


def screen(verbose: bool = True) -> list[tuple[int, str]]:
    """从本地 IBTrACS 筛扩目录。返回 [(年, 名)]，按年排序。"""
    csv.field_size_limit(10 ** 7)
    storms: dict[tuple[int, str], dict] = {}
    with open(ROOT / "data" / "ibtracs_wp.csv",
              encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            if r.get("LAT") in ("degrees_north", " ", ""):
                continue
            try:
                lat = float(r["LAT"]); lon = float(r["LON"])
                yr = int(r["SEASON"]); vm = float(r["WMO_WIND"] or 0) * 0.514444
            except (KeyError, ValueError, TypeError):
                continue
            if yr < MIN_SEASON or not (LON_RANGE[0] <= lon <= LON_RANGE[1]):
                continue
            k = (yr, (r.get("NAME") or "").strip())
            s = storms.setdefault(k, {"inbox": False, "vmax": 0.0})
            s["vmax"] = max(s["vmax"], vm)
            if BOX[0] <= lon <= BOX[1] and BOX[2] <= lat <= BOX[3]:
                s["inbox"] = True
    sel = sorted(k for k, v in storms.items()
                 if v["inbox"] and v["vmax"] >= MIN_WIND_MS)
    if verbose:
        print(f"扩目录筛选：进框 {sum(1 for v in storms.values() if v['inbox'])}"
              f" 场，≥{MIN_WIND_MS:.0f} m/s 后 {len(sel)} 场")
    return sel


def _anchor(track) -> str:
    """路径最接计算域中心的时刻（ISO）。"""
    p = min(track, key=lambda p: math.hypot(p.lon - DOMAIN_CENTER[1],
                                            p.lat - DOMAIN_CENTER[0]))
    return p.t


def run_event_era5(year: int, name: str, grid, kcfg, prj_params,
                   verbose: bool = True):
    """ERA5 强制单场。返回 multievent.EventResult（分解项填 0，口径写明）。"""
    from typhoeus import data as D
    from typhoeus import kernel as K
    from typhoeus import multievent as ME
    from typhoeus import projection as PRJ
    from typhoeus import rainsrc as RS
    from typhoeus import reconcile as RC

    t0 = time.perf_counter()
    track = D.load_track(season=year, name=name, lon_range=LON_RANGE)
    if not track:
        return ME.EventResult._skip(year, name, "IBTrACS 无该场路径点")
    dist = min(math.hypot(p.lon - DOMAIN_CENTER[1],
                          p.lat - DOMAIN_CENTER[0]) for p in track) * 111.0
    anchor = dt.datetime.fromisoformat(_anchor(track))
    start = (anchor - dt.timedelta(hours=12)).strftime("%Y-%m-%d")
    end = (anchor + dt.timedelta(days=3)).strftime("%Y-%m-%d")
    # 名字里可能含 ':'（跨洋盆改名，如 KEN:LOLA）——Windows 文件名非法
    # 字符，且落盘后会变成 ADS 流文件、缓存永远命中不了。统一消毒。
    safe = name.lower().replace(":", "_")
    cache_key = f"era5_{year}{safe}"
    try:
        rain, rep = RS.get_rainfall(grid, stations=None, use_cache=True,
                                    calibrate=False, verbose=False,
                                    cache_name=cache_key,
                                    event_window=(start, end),
                                    anchor_iso=_anchor(track))
    except Exception as e:                              # noqa: BLE001
        return ME.EventResult._skip(
            year, name, f"ERA5 拉取失败 {type(e).__name__}: {e}")
    if float(rain.max()) <= 0.0:
        return ME.EventResult._skip(year, name, "ERA5 窗口内无降雨")
    res = K.run(grid, rain, kcfg)
    el = time.perf_counter() - t0
    if not res.positivity_ok:
        return ME.EventResult._skip(year, name, "内核正性校验失败", el)
    if res.cap_loss_m3 > 0.0:
        return ME.EventResult._skip(
            year, name, f"触上限截断 {res.cap_loss_m3:.1f} m³", el)
    proj = PRJ.aggregate(res.depth, prj_params)
    dt_h = float(res.t_h[1] - res.t_h[0])
    total = RC.event_total(proj["Q"], dt_h)
    if verbose:
        print(f"  {year} {name:12s} 距离 {dist:5.0f} km  "
              f"ERA5 {rep['grid_accum_mm']:6.1f} mm  "
              f"峰值 {res.max_depth:.3f} m  Q {total:.4f}  {el:.0f}s",
              flush=True)
    return ME.EventResult(
        year=year, name=name, track_points=len(track), dist_km=dist,
        peak_wind_ms=max(p.vmax_ms for p in track),
        min_pres_mb=min(p.pres_mb for p in track if p.pres_mb > 0)
        if any(p.pres_mb > 0 for p in track) else 0.0,
        rain72_mm=float(res.rain_cum[-1]),
        peak_intensity_mm_h=float(rain.max()),
        max_depth_m=res.max_depth, peak_time_h=res.peak_time_h,
        q_total=total, q_climate=0.0, q_excess=0.0, q_engineering=0.0,
        q_residual=0.0, resid_share=0.0, closed=True,
        elapsed_s=time.perf_counter() - t0)


def run_all(catalog=None, verbose: bool = True) -> dict:
    from typhoeus import cli as CLI
    from typhoeus import config as CFG
    from typhoeus import data as D
    from typhoeus import measure as M
    from typhoeus import multievent as ME
    from typhoeus import projection as PRJ

    cfg = CFG.Config()
    inp = D.load_all(cfg.l2.bbox, cfg.l4.resample)
    kcfg = CLI._kernel_params(cfg)
    prj = PRJ.ProjectionParams(road_capacity=cfg.l3.road_capacity,
                               road_mix=cfg.l3.road_mix)
    cat = catalog or screen(verbose=False)
    events = []
    for i, (yr, nm) in enumerate(cat, 1):
        r = run_event_era5(yr, nm, inp.grid, kcfg, prj, verbose=verbose)
        events.append(r)
        print(f"  [{i:2d}/{len(cat)}] {'OK  ' if r.ok else 'SKIP'} "
              f"{yr} {nm}", flush=True)

    ok = [e for e in events if e.ok]
    flood = [e for e in ok if e.q_total > 0.0]
    no_flood = [{"年": e.year, "台风": e.name,
                 "ERA5_72h面雨量_mm": round(e.rain72_mm, 1),
                 "Q": round(e.q_total, 4)} for e in ok if e.q_total <= 0.0]
    il = ME.fit_intensity_loss(events)
    mono = ME.check_monotonicity(events)
    span = (max(e.year for e in flood) - min(e.year for e in flood) + 1) \
        if flood else 0
    lam = len(flood) / max(span, 1)
    gpd = ME.fit_return_period(np.array([e.rain72_mm for e in flood])) \
        if flood else {"ok": False, "reason": "无致涝场次"}
    emp = ME.empirical_levels(np.array([e.rain72_mm for e in flood]), lam, span)

    payload = {
        "名称": "ERA5 强制多事件批量（扩目录 ×2 框）",
        "生成时间": dt.datetime.now().isoformat(timespec="seconds"),
        "筛选": {"box": BOX, "min_wind_ms": MIN_WIND_MS,
                "min_season": MIN_SEASON,
                "依据": "docs/superpowers/plans/2026-10-17-era5-multievent.md"},
        "降雨口径": "ERA5 再分析（Open-Meteo 免 key），逐事件 anchor=最近点时刻；"
                  "未做站点订正（多数场次无域内通报站）",
        "n_catalog": len(cat), "n_ok": len(ok),
        "n_flood": len(flood), "no_flood": no_flood,
        "skipped": [{"年": e.year, "台风": e.name, "原因": e.reason}
                    for e in events if not e.ok],
        "year_span": [min(e.year for e in ok), max(e.year for e in ok)] if ok else None,
        "lambda_per_year": round(lam, 3),
        "强度_损失_同口径": il,
        "单调性": mono,
        "重现期_GPD": gpd,
        "经验频率": emp,
        "场次明细": [e.as_dict() for e in events],
        "边界": [
            "分解四项（气候/超标/工程/残差）本批未算——只算 Q 总量；"
            "与 out/07（参数化口径）并列表时口径差写明。",
            "ERA5 是再分析不是观测：绝对量级可信区间宽于站点口径。",
            "尾部天花板不变：最大场次与次大之间的空档是观测史实的属性，"
            "扩目录改变的是样本覆盖的体段，造不出尾段信息。",
        ],
    }
    OUT.mkdir(parents=True, exist_ok=True)
    p = OUT / "era5_multievent_calibration.json"
    p.write_text(json.dumps(payload, ensure_ascii=False, indent=2),
                 encoding="utf-8")
    print(f"\n→ {p}")
    print(f"强度—损失（同口径）：斜率 {il.get('log_log_slope')} "
          f"R² {il.get('r2')}（n={il.get('n')}）")
    print(f"单调性违背 {mono['n_violations']} 处")
    return payload


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="era5_multievent")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("screen")
    pr = sub.add_parser("run")
    pr.add_argument("catalog", nargs="?",
                    help="'1998:TODD,2014:FUNG-WONG'；缺省 --all")
    pr.add_argument("--all", action="store_true")
    a = ap.parse_args(argv)
    if a.cmd == "screen":
        cat = screen()
        for yr, nm in cat:
            print(f"{yr} {nm}")
        print(f"共 {len(cat)} 场")
        return 0
    if a.cmd == "run":
        if a.all:
            run_all()
        else:
            cat = []
            for item in (a.catalog or "").split(","):
                if not item.strip():
                    continue
                y, n = item.split(":")
                cat.append((int(y), n.strip()))
            run_all(catalog=cat)
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
