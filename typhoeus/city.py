"""外域推演：给一个中心坐标，下载 DEM、拉 ERA5、跑内核、出产物。

不依赖标定域的台账与配置边界；参数用默认值，管网能力与分级阈值需本地重标，
结果以 GeoTIFF（峰值水深）与 JSON（指标+出处）落盘。

用法：
    python -m typhoeus.cli city --name 台州 --lon 121.42 --lat 28.66
"""
from __future__ import annotations

import hashlib
import json
import math
import time
import urllib.request
from pathlib import Path

import numpy as np

from .paths import out_dir

BUCKET = "https://copernicus-dem-30m.s3.amazonaws.com"
UA = {"User-Agent": "typhoeus-city/1.0 (city onboarding; contact: typhoeus-demo@example.org)"}
NX, NY = 270, 144
DX, DY = 0.1493, 0.0795          # 与标定域同幅面，约 12.6 km × 8.8 km
LEV = (0.10, 0.20, 0.50)


def tile_name(lat: float, lon: float) -> str:
    ns = "N" if lat >= 0 else "S"
    ew = "E" if lon >= 0 else "W"
    return (f"Copernicus_DSM_COG_10_{ns}{int(math.floor(abs(lat))):02d}_00_"
            f"{ew}{int(math.floor(abs(lon))):03d}_00_DEM")


def fetch_dem(lat: float, lon: float, cache: Path) -> Path:
    cache.mkdir(parents=True, exist_ok=True)
    t = tile_name(lat, lon)
    p = cache / f"{t}.tif"
    if p.exists() and p.stat().st_size > 1e6:
        return p
    url = f"{BUCKET}/{t}/{t}.tif"
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=420) as r, \
            open(p, "wb") as f:
        while True:
            blk = r.read(1 << 20)
            if not blk:
                break
            f.write(blk)
    return p


def build_grid(dem_path: Path, lon_c: float, lat_c: float):
    import rasterio
    from rasterio.warp import Resampling, reproject

    from .data import Grid

    lon_min, lon_max = lon_c - DX / 2, lon_c + DX / 2
    lat_min, lat_max = lat_c - DY / 2, lat_c + DY / 2
    with rasterio.open(dem_path) as src:
        elev = src.read(1).astype("float64")
        tr, crs = src.transform, src.crs
    dst = np.full((NY, NX), np.nan, dtype="float64")
    dtr = rasterio.transform.from_bounds(lon_min, lat_min, lon_max, lat_max, NX, NY)
    reproject(source=elev, destination=dst, src_transform=tr, src_crs=crs,
              dst_transform=dtr, dst_crs="EPSG:4326",
              resampling=Resampling.bilinear, dst_nodata=np.nan)
    dst = np.nan_to_num(dst, nan=float(np.nanmedian(dst)))
    cell_m = ((lon_max - lon_min) * 111320.0 * math.cos(math.radians(lat_c)) / NX
              + (lat_max - lat_min) * 110540.0 / NY) / 2
    return Grid(lon=np.linspace(lon_min, lon_max, NX),
                lat=np.linspace(lat_min, lat_max, NY),
                elev=dst, cell_m=float(cell_m))


def run_city(name: str, lon: float, lat: float, verbose: bool = True) -> dict:
    from . import cli as CLI
    from . import config as CFG
    from . import kernel as K
    from . import rainsrc as RS

    log = print if verbose else (lambda *a: None)
    cfg = CFG.Config()
    cache = Path("data/seed/cities")
    t0 = time.perf_counter()

    log(f"[外域] {name}  ({lon:.4f}, {lat:.4f})")
    dem = fetch_dem(lat, lon, cache)
    log(f"       DEM 瓦片 {dem.name}  {dem.stat().st_size/1e6:.1f} MB")
    grid = build_grid(dem, lon, lat)
    log(f"       网格 {grid.shape}  像元 {grid.cell_m:.0f} m")

    rain, rep = RS.get_rainfall(grid, stations=None, use_cache=True,
                                calibrate=False, verbose=verbose)
    log(f"       降雨 {rep['driver']}  面雨量 {rep['grid_accum_mm']:.1f} mm")

    kp = CLI._kernel_params(cfg)
    res = K.run(grid, rain, kp)
    depth = np.asarray(res.depth)
    peak = depth.max(axis=0)
    land = grid.elev >= 0.5
    n_land = int(land.sum())
    shares = {}
    prev = 0.0
    for lo, hi in zip((0.0,) + LEV, LEV + (float("inf"),)):
        shares[f"{lo:g}-{hi:g}m"] = round(
            float(((peak >= lo) & (peak < hi) & land).sum()) / max(n_land, 1), 4)
        prev = lo
    idx = np.unravel_index(int(np.argmax(peak)), peak.shape)

    iso = time.strftime("%Y-%m-%dT%H:%M:%S")
    prov = hashlib.sha256(
        f"{dem.name}|{lon:.4f}|{lat:.4f}|{kp}".encode()).hexdigest()[:12]

    out = out_dir() / "cities" / name
    out.mkdir(parents=True, exist_ok=True)
    tif = out / "peak_depth_m.tif"
    try:
        import rasterio
        from rasterio.transform import from_bounds
        tr = from_bounds(grid.lon.min(), grid.lat.min(), grid.lon.max(),
                         grid.lat.max(), grid.shape[1], grid.shape[0])
        with rasterio.open(tif, "w", driver="GTiff", height=grid.shape[0],
                           width=grid.shape[1], count=1, dtype="float32",
                           crs="EPSG:4326", transform=tr, nodata=-9999.0) as dst:
            dst.write(peak.astype("float32"), 1)
        tif_rel = str(tif.relative_to(Path.cwd())) if tif.is_relative_to(Path.cwd()) else str(tif)
    except Exception as e:  # noqa: BLE001
        tif_rel = f"写出失败：{e}"

    payload = {
        "名称": f"{name} 外域推演",
        "生成时间": iso,
        "中心坐标": [round(lon, 4), round(lat, 4)],
        "DEM": dem.name,
        "网格": {"nx": NX, "ny": NY, "cell_m": round(grid.cell_m, 1)},
        "降雨": {"driver": rep["driver"], "面雨量_mm": round(rep["grid_accum_mm"], 1),
                "时长_h": round(float(kp.dt_s) * rain.shape[0] / 3600.0, 1)},
        "结果": {
            "峰值水深_m": round(float(peak.max()), 4),
            "峰值位置": {"lon": round(float(grid.lon[idx[1]]), 4),
                      "lat": round(float(grid.lat[idx[0]]), 4)},
            "峰值时刻_h": round(float(res.t_h[int(np.argmax(depth.max(axis=(1, 2))))]), 1),
            "分级面积占比": shares,
            "守恒残差": f"{res.mass_resid:.3e}",
            "全链_s": round(time.perf_counter() - t0, 1),
        },
        "产物": {"峰值水深栅格": tif_rel},
        "出处": {"参数指纹": hashlib.sha256(str(kp).encode()).hexdigest()[:12],
                "本城指纹": prov},
        "说明": [
            "参数沿用默认值，未按本城重标；管网能力与分级阈值需本地校准。",
            "无本地台账时只有结构与量级结论，不提供逐点精度。",
        ],
    }
    (out / "city.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2),
                                   encoding="utf-8")
    log(f"       {out}/city.json  峰值 {peak.max():.3f} m  用时 {time.perf_counter()-t0:.0f} s")
    return payload
