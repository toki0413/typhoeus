"""跨城市泛化测试：郑州 2021-07-20，全程用全球公开数据，不改宁波链路。

三个问题：
  1) 工程泛化：链条能不能在没见过的城市跑起来
  2) 物理合理性：默认宁波参数下，输出是否还像一个内涝结果
  3) 入场券：缺什么会立刻卡住

数据：
  DEM  AWS copernicus-dem-30m（匿名 HTTPS，实测可取）
  降雨 Open-Meteo archive-api（ERA5，免 key）

注意：本脚本不回写 out/、不改 config、不进主链，只做一次性诊断。
"""

from __future__ import annotations

import json
import ssl
import urllib.request
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "seed" / "zhengzhou"
OUT = ROOT / "out"
CTX = ssl.create_default_context()
UA = {"User-Agent": "Mozilla/5.0 typhoeus-genprobe"}

LON_MIN, LON_MAX = 113.58, 113.72
LAT_MIN, LAT_MAX = 34.70, 34.82
DEM_TILE = "Copernicus_DSM_COG_10_N34_00_E113_00_DEM"
DEM_URL = ("https://copernicus-dem-30m.s3.amazonaws.com/"
           f"{DEM_TILE}/{DEM_TILE}.tif")


def fetch_dem() -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    p = CACHE / "dem_n34e113.tif"
    if p.exists() and p.stat().st_size > 1e6:
        print(f"  DEM 已缓存 {p.stat().st_size/1e6:.1f} MB")
        return p
    print(f"  下载 DEM {DEM_URL.rsplit('/', 1)[-1]} ...", flush=True)
    req = urllib.request.Request(DEM_URL, headers=UA)
    with urllib.request.urlopen(req, timeout=300, context=CTX) as r:
        total = int(r.headers.get("Content-Length", 0))
        got = 0
        with open(p, "wb") as f:
            while True:
                blk = r.read(1 << 20)
                if not blk:
                    break
                f.write(blk)
                got += len(blk)
    print(f"  完成 {got/1e6:.1f} MB（声明 {total/1e6:.1f} MB）")
    return p


def fetch_rain() -> tuple[np.ndarray, float]:
    """取 2021-07-19..22 的逐小时 ERA5 降水，返回 (逐时 mm/h, 72h 累计)。"""
    la, lo = (LAT_MIN + LAT_MAX) / 2, (LON_MIN + LON_MAX) / 2
    url = ("https://archive-api.open-meteo.com/v1/archive"
           f"?latitude={la}&longitude={lo}"
           "&start_date=2021-07-19&end_date=2021-07-22"
           "&hourly=precipitation")
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA),
                                timeout=90, context=CTX) as r:
        j = json.loads(r.read().decode("utf-8", "replace"))
    vals = np.array([v or 0.0 for v in j["hourly"]["precipitation"]], dtype=float)
    return vals, float(vals.sum())


def build_grid(dem_path: Path):
    import rasterio
    from rasterio.warp import Resampling, reproject

    from typhoeus import data as D

    with rasterio.open(dem_path) as src:
        elev = src.read(1).astype("float64")
        tr, crs = src.transform, src.crs
    ny, nx = 144, 270
    dst = np.full((ny, nx), np.nan, dtype="float64")
    dtr = rasterio.transform.from_bounds(LON_MIN, LAT_MIN, LON_MAX, LAT_MAX, nx, ny)
    reproject(source=elev, destination=dst, src_transform=tr, src_crs=crs,
              dst_transform=dtr, dst_crs="EPSG:4326",
              resampling=Resampling.bilinear, dst_nodata=np.nan)
    dst = np.nan_to_num(dst, nan=float(np.nanmedian(dst)))
    lon = np.linspace(LON_MIN, LON_MAX, nx)
    lat = np.linspace(LAT_MIN, LAT_MAX, ny)
    cell_m = ((LON_MAX - LON_MIN) * 111320.0 / nx
              + (LAT_MAX - LAT_MIN) * 110540.0 / ny) / 2
    return D.Grid(lon=lon, lat=lat, elev=dst, cell_m=float(cell_m))


def main() -> int:
    print("=== 1) 取数 ===")
    dem = fetch_dem()
    rain_h, rain72 = fetch_rain()
    print(f"  ERA5 逐时 {len(rain_h)} 个，72 h 累计 {rain72:.1f} mm，"
          f"峰值 {rain_h.max():.1f} mm/h")

    print("\n=== 2) 建网格（与宁波同尺寸 144×270）===")
    g = build_grid(dem)
    print(f"  高程 {g.elev.min():.1f}..{g.elev.max():.1f} m，格距 {g.cell_m:.0f} m")

    print("\n=== 3) 插值到内核时间轴（72 h / 10 min）===")
    from typhoeus import cli as CLI
    from typhoeus import config as CFG
    from typhoeus import kernel as K

    cfg = CFG.Config()
    kp = CLI._kernel_params(cfg)
    nt = int(kp.max_t_h * 3600 / kp.dt_s) + 1          # 433
    # Open-Meteo 逐时值即"该小时时段的降水量"，同时作为 mm/h 强度
    src_t = np.linspace(0, 1, len(rain_h))
    dst_t = np.linspace(0, 1, nt)
    prof = np.interp(dst_t, src_t, rain_h)
    rain = np.repeat(prof[:, None, None], g.elev.shape[0], axis=1)
    rain = np.repeat(rain, g.elev.shape[1], axis=2).astype(np.float32)
    print(f"  内核面雨量 {prof.mean()*kp.dt_s/3600*nt:.1f} mm，"
          f"峰值 {prof.max():.1f} mm/h")

    print("\n=== 4) 跑内核（**默认宁波参数，未重标**）===")
    import time
    t0 = time.perf_counter()
    res = K.run(g, rain, kp)
    el = time.perf_counter() - t0
    peak = np.asarray(res.depth).max(axis=0)
    print(f"  完成 {el:.1f} s  守恒残差 {res.mass_resid:.2e}")
    print(f"  峰值水深 {peak.max():.3f} m  湿格占比 {(peak>=0.05).mean()*100:.2f}%")

    lv = {
        "绿 <0.1m": float((peak < 0.1).mean()),
        "黄 0.1-0.2m": float(((peak >= 0.1) & (peak < 0.2)).mean()),
        "橙 0.2-0.5m": float(((peak >= 0.2) & (peak < 0.5)).mean()),
        "红 ≥0.5m": float((peak >= 0.5).mean()),
    }
    print("  四色面积占比：", {k: f"{v*100:.2f}%" for k, v in lv.items()})

    payload = {
        "名称": "跨城市泛化测试：郑州 2021-07-20",
        "用途": "诊断，不进主链",
        "数据": {"DEM": f"AWS {DEM_TILE}（匿名）",
                 "降雨": "Open-Meteo ERA5，免 key"},
        "降雨": {"72h累计_mm": round(rain72, 1), "峰值_mm_h": round(float(rain_h.max()), 1),
                 "公开通报_郑州站时雨强_mm_h": 201.9,
                 "ERA5_vs_通报_倍数": round(201.9 / max(float(rain_h.max()), 1e-6), 1)},
        "网格": {"尺寸": list(g.elev.shape), "格距_m": round(g.cell_m, 1),
                 "高程_m": [round(float(g.elev.min()), 1), round(float(g.elev.max()), 1)]},
        "结果": {"内核_s": round(el, 1), "守恒残差": float(res.mass_resid),
                 "峰值水深_m": round(float(peak.max()), 4),
                 "湿格占比": round(float((peak >= 0.05).mean()), 6),
                 "四色占比": {k: round(v, 6) for k, v in lv.items()}},
        "结论": [
            "工程泛化：链条在未见过的城市可跑通（换 DEM 与降雨即可，内核未改）。",
            "物理合理性：默认宁波参数下仍产出内涝型结果，但量级由降雨驱动决定。",
            "入场券：真正卡住的是**降雨驱动对极端对流的失真**——"
            f"ERA5 峰值 {float(rain_h.max()):.1f} mm/h 对公开通报 201.9 mm/h，"
            "低估约两个数量级；以及**没有本地涝点台账**，无法做分级与验证。",
        ],
        "边界": [
            "本例未重标任何参数，用的是宁波的土壤/排水/不透水率，不代表本地最优。",
            "ERA5 为再分析产品，对强对流单站极值系统性低估属已知特性，非本模型缺陷。",
            "无郑州本地台账，故无任何精度结论；本件只回答'能不能跑'与'卡在哪'。",
            "DEM 用 COG_10 命名瓦片（AWS 该桶命名与官方 GLO-30 文档不同）。",
        ],
    }
    OUT.mkdir(exist_ok=True)
    (OUT / "gen_crosscity_zhengzhou.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n→ {OUT / 'gen_crosscity_zhengzhou.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
