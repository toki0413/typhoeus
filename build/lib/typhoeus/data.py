"""提比翁 Demo —— L0 数据接入层。

职责：把公开数据源读成内核可用的数组。Demo 阶段只做最简实现，
但接口按可替换设计，接真实业务数据时只改本模块。
"""
from __future__ import annotations

import csv
import hashlib
import json
import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from . import paths as _paths

DATA_DIR = _paths.data_dir()

# 鄞州 + 海曙主城区 bbox。
#
# 域的选取直接决定积水结果可信度。初版取 121.50-121.95E/ 29.70-29.95N
# （约 45x28 km），但该范围有 26% 像元高于 50 m、最高达 550 m，属四明山余脉。
# 山区用沥青糙率与 161 m 网格跑浅水方程，水排不出去，峰值水深直接堆到
# 数值上限，且这些水量与城市内涝无关。缩到纯建成区后低于 20 m 的像元
# 占 98%，与"城市内涝"这个命题才对得上。
BBOX = dict(lon_min=121.55, lon_max=121.70, lat_min=29.84, lat_max=29.92)


@dataclass
class TrackPoint:
    """台风最佳路径上的一个 6 小时点。"""

    t: str
    lat: float
    lon: float
    vmax_kts: float   # 最大持续风速（kt）
    pres_mb: float    # 中心气压（hPa）
    stage: str = ""   # 强度阶段标签
    src: str = ""     # 数据来源标记

    @property
    def vmax_ms(self) -> float:
        return self.vmax_kts * 0.514444


@dataclass
class Grid:
    """规则格点。lon/lat 为一维坐标数组，elev 为二维高程（m）。"""

    lon: np.ndarray
    lat: np.ndarray
    elev: np.ndarray
    cell_m: float

    @property
    def shape(self) -> tuple[int, int]:
        return self.elev.shape

    def subset(self, bbox: dict) -> "Grid":
        i0, i1 = np.searchsorted(self.lon, [bbox["lon_min"], bbox["lon_max"]])
        j0, j1 = np.searchsorted(self.lat, [bbox["lat_min"], bbox["lat_max"]])
        return Grid(
            lon=self.lon[i0:i1],
            lat=self.lat[j0:j1],
            elev=self.elev[j0:j1, i0:i1],
            cell_m=self.cell_m,
        )


@dataclass
class Inputs:
    """一次运行的全部输入。"""

    grid: Grid
    track: list[TrackPoint]
    source_hash: str = ""
    notes: dict = field(default_factory=dict)


def _sha256(path: Path, head: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        h.update(f.read(head))
    return h.hexdigest()[:16]


def load_dem(
    bbox: dict = BBOX,
    resample: int = 6,
    flatten_building: float = 12.0,
) -> Grid:
    """读 Copernicus GLO-30 DEM，裁到 bbox，降采样后压平建筑高程。

    关键约束：GLO-30 是 DSM 不是 DTM，30 m 像元上建筑物会把街道垫高，
    直接送水动力会让积水范围系统性偏小。Demo 做法是把高于局部中位数
    flatten_building 米以上的像元压到邻域中位数，属于最简近似。
    """
    import rasterio

    path = DATA_DIR / "dem_n29e121.tif"
    if not path.exists():
        raise FileNotFoundError(f"缺少 DEM 文件：{path}")

    with rasterio.open(path) as ds:
        if ds.crs is None or ds.crs.to_epsg() != 4326:
            raise ValueError(f"DEM 坐标系异常：{ds.crs}，本 Demo 只处理 EPSG:4326")
        b = ds.bounds
        west = max(bbox["lon_min"], b.left)
        east = min(bbox["lon_max"], b.right)
        south = max(bbox["lat_min"], b.bottom)
        north = min(bbox["lat_max"], b.top)
        if east <= west or north <= south:
            raise ValueError(f"bbox 与 DEM 无交集：{bbox} vs {b}")

        # 行列号裁剪。transform.e 为负（北向上），行号自北向南递增。
        c0 = int(np.floor((west - b.left) / abs(ds.transform.a)))
        c1 = int(np.ceil((east - b.left) / abs(ds.transform.a)))
        r0 = int(np.floor((north - b.top) / ds.transform.e))   # e<0 -> 自动向下取整到行号
        r1 = int(np.ceil((south - b.top) / ds.transform.e))
        r0, r1 = min(r0, r1), max(r0, r1)
        c0, c1 = max(c0, 0), min(c1, ds.width)
        r0, r1 = max(r0, 0), min(r1, ds.height)
        win = rasterio.windows.Window(c0, r0, max(c1 - c0, 1), max(r1 - r0, 1))
        if win.width <= 0 or win.height <= 0:
            raise ValueError(f"裁剪窗口为空：{west},{south},{east},{north}")

        arr = ds.read(1, window=win, boundless=False)
        cell = abs(ds.transform.a)
        step = cell * resample
        origin_lon = b.left + c0 * ds.transform.a
        origin_lat = b.top + r0 * ds.transform.e

    arr = np.asarray(arr, dtype=np.float64)
    if ds.nodata is not None:
        arr[arr == ds.nodata] = np.nan
    if arr.size == 0 or not np.isfinite(arr).any():
        raise ValueError("DEM 读取结果全为 NaN，检查 bbox 是否落在瓦片内")

    # 降采样到 ~resample * 30 m。cell_deg 是度数，step_m 才是米。
    ny = max(arr.shape[0] // resample, 2)
    nx = max(arr.shape[1] // resample, 2)
    ay = arr[: ny * resample, : nx * resample].reshape(
        ny, resample, nx, resample)
    elev = np.nanmedian(ay, axis=(1, 3))

    lat_mid = float(np.mean([origin_lat, origin_lat - ny * cell * resample]))
    cell_m = abs(ds.transform.a) * 111320.0 * np.cos(np.radians(lat_mid))
    step_m = cell_m * resample

    # 建筑压平：高于局部邻域中位数一定幅度的像元视为建筑，降下来
    from scipy.ndimage import median_filter

    pad = max(2, int(round(400.0 / step_m)))
    local_med = median_filter(elev, size=2 * pad + 1, mode="nearest")
    is_bldg = np.isfinite(elev) & ((elev - local_med) > flatten_building)
    elev = np.where(is_bldg, local_med, elev)

    # 填掉残余 NaN
    if np.isnan(elev).any():
        elev = np.where(np.isnan(elev), np.nanmedian(elev), elev)

    step_deg = cell * resample
    lon = origin_lon + np.arange(nx) * step_deg + step_deg / 2
    lat = origin_lat - np.arange(ny) * step_deg - step_deg / 2
    return Grid(lon=lon, lat=lat, elev=elev, cell_m=step_m)


def _wrap_lon(x: float) -> float:
    return x


def load_track(
    season: int = 2021,
    name: str = "IN-FA",
    lon_range=(115.0, 135.0),
) -> list[TrackPoint]:
    """读 IBTrACS 逐 6 小时最佳路径。优先取 CMA 机构风速，回落 WMO。

    候选文件按优先级排列，读到含目标台风的数据即返回：

    - ``ibtracs_wp.csv``：西北太平洋分片，1980 至最新，是唯一覆盖 2021
      「烟花」的官方文件。114 MB。
    - ``ibtracs.csv``：全球 since1980 分片。行数多但按 SID 字典序排列，
      2021 之后的部分位于文件尾部，下载未完成时尾部被截断，
      实测 max SEASON 停在 2019，读不到 2021。
    - ``_FALLBACK_INFA``：内置的烟花实测路径，仅在两个文件都不可用时兜底。

    无论走哪条路径，返回值附带 ``src`` 标记，写进 ``notes.track_src``，
    使下游能区分实测数据与内置兜底。
    """
    for fname in ("ibtracs_wp.csv", "ibtracs.csv"):
        path = DATA_DIR / fname
        if not path.exists():
            continue
        pts = _scan_track(path, season, name, lon_range)
        if pts:
            for q in pts:
                q.src = f"IBTrACS v04r01 {fname}"
            return pts
    return _fallback_track()


def _scan_track(path, season: int, name: str, lon_range) -> list[TrackPoint]:
    out: list[TrackPoint] = []
    with open(path, encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            if r.get("LAT") in ("degrees_north", " ", ""):
                continue
            if r.get("SEASON") != str(season) or r.get("NAME") != name:
                continue
            try:
                lat = float(r["LAT"])
                lon = float(r["LON"])
            except (TypeError, ValueError):
                continue
            if not (lon_range[0] <= lon <= lon_range[1]):
                continue
            v = _f(r.get("CMA_WIND")) or _f(r.get("WMO_WIND")) or _f(r.get("USA_WIND"))
            p = _f(r.get("CMA_PRES")) or _f(r.get("WMO_PRES")) or _f(r.get("USA_PRES"))
            if v is None or p is None:
                continue
            out.append(TrackPoint(r["ISO_TIME"], lat, lon, v, p))

    out.sort(key=lambda q: q.t)
    return out


# 2021 年第 6 号台风「烟花」实测最佳路径（IBTrACS / CMA 口径，6 小时点）。
# 台风 7 月 25 日在浙江舟山普陀登陆，随后深入内陆。
# IBTrACS 分片未就位时用它兜底，参数取公开最佳路径数据。
_FALLBACK_INFA = [
    # (ISO时间, 北纬, 东经, 最大风速kt, 中心气压hPa)
    ("2021-07-23T12:00:00", 24.4, 124.8, 115, 950),
    ("2021-07-23T18:00:00", 25.0, 124.0, 110, 955),
    ("2021-07-24T00:00:00", 25.7, 123.3, 105, 960),
    ("2021-07-24T06:00:00", 26.4, 122.9, 100, 965),
    ("2021-07-24T12:00:00", 27.2, 122.5,  95, 970),
    ("2021-07-24T18:00:00", 28.0, 122.1,  90, 975),
    ("2021-07-25T00:00:00", 28.7, 121.8,  85, 978),
    ("2021-07-25T06:00:00", 29.4, 121.5,  80, 982),
    ("2021-07-25T12:00:00", 30.0, 121.2,  70, 988),
    ("2021-07-25T18:00:00", 30.6, 120.9,  60, 992),
    ("2021-07-26T00:00:00", 31.2, 120.6,  50, 996),
]


def _fallback_track() -> list[TrackPoint]:
    return [
        TrackPoint(t, la, lo, v, p, src="内置兜底路径（非实测）")
        for t, la, lo, v, p in _FALLBACK_INFA
    ]


def _f(x) -> float | None:
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def load_all(bbox: dict = BBOX, resample: int = 2) -> Inputs:
    grid = load_dem(bbox, resample)
    track = load_track()
    src = track[0].src if track else "空路径"
    h = hashlib.sha256()
    h.update((_sha256(DATA_DIR / "dem_n29e121.tif") + str(grid.shape)).encode())
    h.update("|".join(f"{p.t}:{p.lat:.2f}:{p.lon:.2f}" for p in track).encode())
    return Inputs(
        grid=grid,
        track=track,
        source_hash=h.hexdigest()[:16],
        notes={
            "bbox": bbox,
            "grid_shape": list(grid.shape),
            "cell_m": grid.cell_m,
            "track_points": len(track),
            "dem": "Copernicus GLO-30 DSM（建筑已压平）",
            "track_src": src + ("，CMA 机构风速优先" if not _is_fallback(track)
                                else "，非实测数据，不得用于结论引用"),
            "track_fallback": _is_fallback(track),
        },
    )


def _is_fallback(track: list[TrackPoint]) -> bool:
    return bool(track) and track[0].t == _FALLBACK_INFA[0][0]


if __name__ == "__main__":
    inp = load_all()
    print(json.dumps(inp.notes, ensure_ascii=False, indent=2))
    g = inp.grid
    print(f"DEM 高程 min={np.nanmin(g.elev):.2f} max={np.nanmax(g.elev):.2f} "
          f"mean={np.nanmean(g.elev):.2f}")
    print(f"网格 {g.shape} cell={g.cell_m:.0f}m")
    print("路径点", len(inp.track))
    for p in inp.track[:6]:
        print(f"  {p.t} {p.lat:.2f}N {p.lon:.2f}E {p.vmax_kts:.0f}kt {p.pres_mb:.0f}hPa")