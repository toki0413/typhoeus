"""F2 涝点坐标米级化：高德地理编码 + POI 兜底，然后只换坐标重算一次空间指标。

key 只从环境变量 AMAP_KEY 读，绝不写进命令行、缓存或产物。

单因子归因：的地形、降雨、内核参数一律不动，只把台账坐标换成检索结果，
所以前后覆盖率之差就是坐标精度的贡献。
"""
from __future__ import annotations

import argparse
import dataclasses
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

for _v in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

GEO_CACHE = Path(__file__).resolve().parent.parent / "data" / "seed" / "flood_points_geo.json"
UA = {"User-Agent": "Mozilla/5.0"}
# 高德返回的 level 串决定这次定位能不能当米级坐标用。
LEVEL_UNCERTAIN_M = {
    "interest": 20, "道路中线": 30, "道路": 30, "住宅区": 30, "视线": 30,
    "商圈": 100, "乡镇": 1000, "区县": 5000, "市": 20000,
}


KEY_FILES = (Path(__file__).resolve().parent.parent / ".amap_key", Path.home() / ".amap_key")


def _load_key() -> str:
    """key 只从环境变量或本地私有文件取；两者都不经命令行，也不写进任何产物。"""
    k = os.environ.get("AMAP_KEY", "").strip()
    if k:
        return k
    for p in KEY_FILES:
        if p.exists():
            return p.read_text(encoding="utf-8").strip()
    return ""


def _get(url: str, params: dict, key: str) -> dict:
    q = dict(params, key=key)
    full = f"{url}?{urllib.parse.urlencode(q)}"
    with urllib.request.urlopen(urllib.request.Request(full, headers=UA), timeout=25) as r:
        return json.loads(r.read().decode())


def _check(d: dict, what: str) -> None:
    if str(d.get("status")) != "1":
        raise RuntimeError(f"{what} 返回异常 status={d.get('status')} "
                           f"info={d.get('info')} infocode={d.get('infocode')}")


def _in_bbox(lon: float, lat: float, bb: dict) -> bool:
    return bb["lon_min"] <= lon <= bb["lon_max"] and bb["lat_min"] <= lat <= bb["lat_max"]


def query(name: str, district: str, key: str) -> dict:
    """单点取坐标：先地理编码，落域外或粗粒度时改走 POI 全文检索。"""
    base = re.sub(r"[（(].*?[)）]", "", name).strip()
    tries = [{"端点": "geocode", "查询词": base},
             {"端点": "geocode", "查询词": f"宁波市{base}"},
             {"端点": "place", "查询词": base},
             {"端点": "place", "查询词": f"{district}{base}"}]
    last = {"ok": False, "reason": "未发起查询"}
    for t in tries:
        try:
            if t["端点"] == "geocode":
                d = _get("https://restapi.amap.com/v3/geocode/geo",
                         {"address": t["查询词"], "city": "宁波"}, key)
                _check(d, "geocode")
                gs = d.get("geocodes") or []
                if not gs:
                    last = {"ok": False, "reason": "geocode 空结果", "查询词": t["查询词"]}
                    continue
                lon, lat = (float(v) for v in gs[0]["position"].split(","))
                level, city = gs[0].get("level", ""), str(gs[0].get("city", ""))
            else:
                d = _get("https://restapi.amap.com/v5/place/text",
                         {"keywords": t["查询词"], "region": "宁波", "page_size": 10}, key)
                _check(d, "place")
                ps = d.get("pois") or []
                if not ps:
                    last = {"ok": False, "reason": "place 空结果", "查询词": t["查询词"]}
                    continue
                lon, lat = (float(v) for v in ps[0]["location"].split(","))
                level, city = ps[0].get("type", ""), ps[0].get("pname", "")
            if "宁波" not in city:
                last = {"ok": False, "reason": f"定位到非宁波：{city}", "查询词": t["查询词"]}
                continue
            unc = next((v for k, v in LEVEL_UNCERTAIN_M.items() if k in level), 50)
            return {"ok": True, "端点": t["端点"], "查询词": t["查询词"], "lon": lon, "lat": lat,
                    "level": level, "city": city, "uncertain_m": unc,
                    "ts": time.strftime("%Y-%m-%dT%H:%M:%S")}
        except Exception as e:  # noqa: BLE001
            last = {"ok": False, "reason": f"{type(e).__name__}: {str(e)[:90]}",
                    "查询词": t["查询词"]}
        time.sleep(0.4)
    last.update({"端点": "none", "lon": None, "lat": None, "ts": time.strftime("%Y-%m-%dT%H:%M:%S")})
    return last


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="不联网，只验证复算半边并核对归档基线")
    ap.add_argument("--limit", type=int, default=0, help="只查前 N 个点，用于小成本试算")
    a = ap.parse_args()

    import numpy as np  # noqa: F401
    from typhoeus import config as CFG, cli as CLI, data as D, kernel as K, observe as OB, rainsrc as RS
    from typhoeus import projection as PRJ  # noqa: F401

    key = _load_key()
    if not key and not a.dry_run:
        raise SystemExit("取不到高德 key：设环境变量 AMAP_KEY，或把 key 单独写进 "
                         f"{KEY_FILES[0]} / {KEY_FILES[1]}（本脚本不打印、不落盘到产物）。")

    cfg = CFG.Config()
    bb = cfg.l2.bbox
    inputs = D.load_all(bb, cfg.l4.resample)
    rain, rep = RS.get_rainfall(inputs.grid, stations=OB.load_rain_stations(),
                                use_cache=True, calibrate=True, verbose=False)
    kcfg = CLI._kernel_params(cfg)
    print(f"[复算] 网格 {inputs.grid.shape} cell={inputs.grid.cell_m:.1f} m "
          f"驱动={rep['driver']} 面雨量={rep['grid_accum_mm']:.1f} mm", flush=True)
    res = K.run(inputs.grid, rain, kcfg)
    peak = res.depth.max(axis=0)
    risk = peak / max(float(peak.max()), 1e-9)
    print(f"[复算] 峰值水深 {res.max_depth:.4f} m  守恒残差 {res.mass_resid:.3e}", flush=True)

    pts = OB.load_flood_points()
    inside_all = [p for p in pts if _in_bbox(p.lon, p.lat, bb)]
    inside = [p for p in inside_all if not p.is_synthetic]
    cov0 = OB.coverage(risk, inside, inputs.grid, bb, res.depth)
    acc0 = OB.depth_accuracy(res.depth, inside, inputs.grid, bb)
    print(f"[基线] 域内非合成 {len(inside)} 点  覆盖率 {cov0['n_hit']}/{cov0['n_total']} = "
          f"{(cov0['rate'] or 0)*100:.1f}%  命中率 {(acc0['rate'] or 0)*100:.1f}%  "
          f"MAE {acc0['mae_m']} m", flush=True)
    if a.dry_run:
        print("[dry-run] 未联网。核对上面这行是否等于归档读数 5/17 = 29.4%、命中 0.0%、MAE 0.359 m。")
        return 0

    cache = {}
    if GEO_CACHE.exists():
        cache = {r["point_id"]: r for r in json.loads(GEO_CACHE.read_text(encoding="utf-8"))}
    todo = inside[:a.limit] if a.limit else inside
    recs = []
    for p in todo:
        if p.point_id in cache and cache[p.point_id].get("ok"):
            r = cache[p.point_id]
            print(f"[缓存] {p.point_id} {p.name[:22]} -> {r['lon']:.6f},{r['lat']:.6f} "
                  f"±{r['uncertain_m']} m", flush=True)
        else:
            r = query(p.name, p.district, key)
            dist = None
            if r.get("ok"):
                dist = float(np.hypot((r["lon"] - p.lon) * 111320 * np.cos(np.radians(p.lat)),
                                      (r["lat"] - p.lat) * 110540))
            r = {**r, "point_id": p.point_id, "原名": p.name, "原坐标": [p.lon, p.lat],
                 "位移_m": None if dist is None else round(dist, 1)}
            time.sleep(0.4)
            print(f"[查询] {p.point_id} {p.name[:22]} ok={r.get('ok')} "
                  f"{r.get('reason', '')} 位移 {r.get('位移_m')} m", flush=True)
        recs.append(r)

    merged = {**cache, **{r["point_id"]: r for r in recs}}
    GEO_CACHE.write_text(json.dumps(list(merged.values()), ensure_ascii=False, indent=1),
                         encoding="utf-8")
    print(f"[落盘] {GEO_CACHE.name} 记录 {len(merged)} 条（不含 key）", flush=True)

    ok = [m for m in recs if m.get("ok")]
    new_pts = [dataclasses.replace(p, lon=m["lon"], lat=m["lat"])
               for p, m in zip(todo, recs) if m.get("ok")]
    print(f"[取数] 成功 {len(ok)}/{len(todo)}；位移中位数 "
          f"{np.median([m['位移_m'] for m in ok if m.get('位移_m') is not None]) if ok else float('nan'):.1f} m",
          flush=True)
    if new_pts:
        # 只换成功的那批点的坐标，其余点保持原值，避免把失败点从分母里偷偷删掉。
        repl = {p.point_id: p for p in new_pts}
        mixed = [repl.get(p.point_id, p) for p in inside]
        cov1 = OB.coverage(risk, mixed, inputs.grid, bb, res.depth)
        acc1 = OB.depth_accuracy(res.depth, mixed, inputs.grid, bb)
        print(f"[对照] 覆盖率 {cov0['n_hit']}/{cov0['n_total']} = {(cov0['rate'] or 0)*100:.1f}% -> "
              f"{cov1['n_hit']}/{cov1['n_total']} = {(cov1['rate'] or 0)*100:.1f}%  "
              f"命中率 {(acc0['rate'] or 0)*100:.1f}% -> {(acc1['rate'] or 0)*100:.1f}%  "
              f"MAE {acc0['mae_m']} -> {acc1['mae_m']} m", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
