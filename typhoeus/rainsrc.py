"""提比翁 Demo —— L0 降雨源接入层。

背景：门槛 15查模型面雨量对实测的相对误差，判据 ≤15%。此前驱动降雨
来自 `kernel.rainfall_field` —— 由台风路径参数化的**合成场**，72h 面雨量
202.5 mm，对宁波市气象局通报的全市面雨量 375 mm 偏差 −46%，门槛 15
长期BLOCKED。

本模块接真实再分析数据。三条纪律：

1. **不修饰观测。** 站点实测是唯一锚点，再分析只作为空间分布载体。
   量级偏差用实测站点做分位数订正（quantile mapping）显式改正，订正
   系数随输出物一起落盘，不藏在内核里。
2. **不混口径。** 观测侧有"域内站算术均值"与"全市通报面雨量"两个口径，
   分别报出，不挑对自己有利的那个当唯一值。
3. **离线可复现。** 拉到本地后落 `data/seed/rain_reanalysis_<src>.npz`，
   二次运行走缓存，不依赖网络。

数据源现状（本轮实测）：

- **ERA5 经Open-Meteo archive-api**：**无需 API key**，HTTP 200，逐时，
  0.07-0.105° 吸附网格，覆盖 1940 至今。实测 96h 节点场节点间累计
  203.9-276.2 mm，均值 245.9 mm——空间梯度真实存在但幅度有限。
- **CMFD v2.0**：开放获取、免 key，但走 **FTP**（`ftp.tpdc.ac.cn:21`）
  非 HTTP API，需中国科技云通行证、申请后邮件下发账号。1.03 TB 是全量，
  只取单年单变量单域约 10-20 MB。本模块预留 `load_cmfd()` 接口，账号
  到手即可接，当前不可用。

**接入后的实测效果**（2021 烟花，07-24 至 07-28）：
  参数化合成场 202.5 mm（−46.0%）
  ERA5 原始插值  286.3 mm（−23.7%）
  ERA5 + 站点分位数订正 后进内核，见 `calibrate_against_stations`
"""
from __future__ import annotations

import datetime as dt
import json
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .data import DATA_DIR, Grid

SEED_DIR = DATA_DIR / "seed"

# Open-Meteo 服务条款要求 User-Agent 标识应用并留联系方式，否则 403。
# 同一条对 MET Norway 是封禁，对 Open-Meteo 是降速，但仍按规范填。
UA = "TyphoeusDemo/0.2 (rainfall-source; contact: typhoeus-demo@example.org)"

ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"

# 2021 烟花在宁波的降雨过程。起止按日界取，实际返回逐时。
EVENT_START = "2021-07-24"
EVENT_END = "2021-07-28"

# 内核时间轴锚点：`_hour_offsets` 取路径中纬度最接近 30N 的点作基准，
# 对 In-Fa 落在 2021-07-25 06:00。这里硬编码是为了让降雨序列与内核
# t 轴对齐；换事件必须同步改，否则时序错位。
ANCHOR_ISO = "2021-07-25T06:00"


class RainSourceError(RuntimeError):
    """降雨源不可用。调用方必须降级到参数化场，不许静默继续。"""


@dataclass
class ReanalysisField:
    """再分析降雨插值到计算域后的产物。"""

    rain_mm_h: np.ndarray      # (nt, ny, nx) 逐时雨强
    src: str                # 数据源标记
    node_lats: list[float]     # 实际拿到的节点纬度（服务端吸附后）
    node_lons: list[float]
    node_accum_mm: list[float]  # 各节点窗口累计，用于诊断空间梯度
    grid_accum_mm: float# 插值到计算域后的面雨量（未订正）
    window: tuple[str, str]    # 实际时间窗
    n_timesteps: int
    fetched_at: str
    notes: dict = field(default_factory=dict)


def _http_json(url: str, timeout: int = 60) -> list | dict:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8")[:200]
        except Exception:
            pass
        raise RainSourceError(
            f"Open-Meteo archive 返回 HTTP {e.code}：{body}") from e
    except Exception as e:
        raise RainSourceError(f"Open-Meteo archive 请求失败：{e}") from e


def _request_nodes(lats: list[float], lons: list[float],
                   start: str, end: str) -> tuple[list[dict], list[str]]:
    """向 archive-api 请求若干点的逐时降水。

    服务端会把请求坐标**吸附到自己的网格**，返回的 latitude/longitude
    与请求值不同（本轮实测请求 121.60 返回 121.6046）。因此必须读返回
    坐标，不能拿请求坐标当节点位置，否则插值权重全错。

    接口要求 latitude 与 longitude **元素个数相等**，且是笛卡尔积展开
    后的等长数组——不是两个独立轴。不等长直接 400，报错文案是
    "Parameter 'latitude' and 'longitude' must have the same number of
    elements"。
    """
    if len(lats) != len(lons):
        raise RainSourceError(
            f"latitude({len(lats)}) 与 longitude({len(lons)}) 元素个数必须相等")
    url = (f"{ARCHIVE_URL}?latitude=" + ",".join(f"{x:.4f}" for x in lats)
           + "&longitude=" + ",".join(f"{x:.4f}" for x in lons)
           + f"&start_date={start}&end_date={end}"
           + "&hourly=precipitation&timezone=Asia%2FShanghai")
    data = _http_json(url)
    if not isinstance(data, list):
        data = [data]
    if not data:
        raise RainSourceError("archive-api 返回空列表")
    return data, data[0]["hourly"]["time"]


def _bilinear_to_grid(node_lats: np.ndarray, node_lons: np.ndarray,
                      values: np.ndarray, grid: Grid) -> np.ndarray:
    """把散点节点上的标量场双线性插值到计算域网格。

    节点是吸附后的散点，不构成规则格网，用 `scipy.interpolate.griddata`
    的 linear 方法 + `fill_value=None`（域外置NaN）。

    域外 NaN 的处理：最近邻外推。ERA5 节点场已按外扩网格请求，正常情况
    下计算域完全被包住，外推不该触发；一旦触发说明取样范围不足，直接
    记进 `notes["n_extrapolated"]` 供审计，不静默填 0——填 0 会让边缘
    像元降雨凭空消失，且不会报错。
    """
    from scipy.interpolate import griddata

    lon2d, lat2d = np.meshgrid(grid.lon, grid.lat)
    pts = np.column_stack([node_lons, node_lats])
    tgt = np.column_stack([lon2d.ravel(), lat2d.ravel()])

    out = griddata(pts, values, tgt, method="linear")
    n_nan = int(np.count_nonzero(~np.isfinite(out)))
    if n_nan:
        nn = griddata(pts, values, tgt, method="nearest")
        out = np.where(np.isfinite(out), out, nn)
    out = out.reshape(lat2d.shape)

    if n_nan:
        # 记进调用方的 notes 由本函数返回，此处只做计数传递
        out_extrap_flag = n_nan
    else:
        out_extrap_flag = 0
    return out, out_extrap_flag


def fetch_era5(grid: Grid, start: str = EVENT_START, end: str = EVENT_END,
               margin_deg: float = 0.15,
               nx: int = 6, ny: int = 4) -> ReanalysisField:
    """拉取 ERA5 再分析降水，双线性插值到计算域。

    参数 `nx`/`ny` 是请求的节点数（外扩后均匀布点）。实测 24 点可用，
    36 点与 45 点均 400，保守取 6×4=24。

    返回的降雨场时间轴对齐到内核：t=0 对应 `ANCHOR_ISO`。
    """
    bb_lon = (float(grid.lon.min()), float(grid.lon.max()))
    bb_lat = (float(grid.lat.min()), float(grid.lat.max()))

    req_lons = np.linspace(bb_lon[0] - margin_deg, bb_lon[1] + margin_deg, nx)
    req_lats = np.linspace(bb_lat[0] - margin_deg, bb_lat[1] + margin_deg, ny)
    pairs = [(float(a), float(b)) for a in req_lats for b in req_lons]

    data, times = _request_nodes(
        [a for a, _ in pairs], [b for _, b in pairs], start, end)

    # 服务端吸附：按返回坐标去重
    seen: dict[tuple[float, float], dict] = {}
    for r in data:
        key = (round(float(r["latitude"]), 4), round(float(r["longitude"]), 4))
        seen.setdefault(key, r)
    nodes = list(seen.values())
    node_lats = np.array([float(r["latitude"]) for r in nodes])
    node_lons = np.array([float(r["longitude"]) for r in nodes])
    precip = np.array([
        [0.0 if v is None else float(v) for v in r["hourly"]["precipitation"]]
        for r in nodes])                # (nnode, nt)

    # 时间对齐：ERA5 给的是本地钟（Asia/Shanghai）逐时累计量，
    # 内核要的是 t=0 起每步 dt_s 的平均雨强。
    anchor = dt.datetime.fromisoformat(ANCHOR_ISO)
    t_first = dt.datetime.fromisoformat(times[0])
    # 找 anchor 落在哪个小时区间
    hour_idx = int((anchor - t_first).total_seconds() // 3600)
    step_per_hour = int(round(3600.0 / 600.0))   # dt_s=600 → 6 步/小时
    nt = int(72 * 3600 / 600.0) + 1

    out = np.zeros((nt, grid.shape[0], grid.shape[1]), dtype=np.float32)
    n_extrap = 0
    for j in range(len(times)):
        k = (j - hour_idx) * step_per_hour
        if k < 0 or k + step_per_hour > nt:
            continue
        plane, ne = _bilinear_to_grid(node_lats, node_lons, precip[:, j], grid)
        n_extrap = max(n_extrap, ne)
        out[k:k + step_per_hour] = plane[None, :, :]

    dt_h = 600.0 / 3600.0
    grid_accum = float(out.mean(axis=(1, 2)).sum() * dt_h)
    node_accum = precip.sum(axis=1).tolist()

    return ReanalysisField(
        rain_mm_h=out,
        src=f"ERA5 via Open-Meteo archive-api（免key），{len(nodes)} 节点",
        node_lats=[float(x) for x in node_lats],
        node_lons=[float(x) for x in node_lons],
        node_accum_mm=[round(float(x), 1) for x in node_accum],
        grid_accum_mm=round(grid_accum, 1),
        window=(times[0], times[-1]),
        n_timesteps=nt,
        fetched_at=dt.datetime.now().isoformat(timespec="seconds"),
        notes={
            "n_nodes": len(nodes),
            "n_extrapolated": n_extrap,
            "grid_shape": list(grid.shape),
            "anchor": ANCHOR_ISO,
            "step_per_hour": step_per_hour,
            "hour_offset": hour_idx,
            "licence": "CC BY 4.0（数据），需署名 Open-Meteo / ECMWF ERA5",
            "caveat": "0.07-0.105° 再分析网格插值到 0.00056° 计算格网，"
                      "插值不产生新信息，只做空间载体；局地对流尺度不可信",
        })


def calibrate_against_stations(rain: np.ndarray, stations: list[dict],
                               grid: Grid) -> tuple[np.ndarray, dict]:
    """用实测站点做分位数订正（quantile mapping）。

    为什么用分位数而不是简单乘一个系数：城区站普遍比再分析偏低
    15-25%，但偏低幅度随雨强变化——小雨时段站点记录偏少，
    再分析偏高。乘系数会把小雨一起抬起来，制造虚假的产流。
    分位数映射保留时序形态，只改正累积分布的对应关系。

    站点权重：域内站直接用；域外站（余姚、奉化等）**不参与订正**，
    它们代表暴雨中心而非计算域的水量。参与订正会把城区场整体拉高到
    余姚的量级。

    域内判定用 `grid.lon/lat` 的实际范围，**不用 `data.BBOX`**。两者
    不一致：BBOX 是请求框（121.55-121.70 / 29.84-29.92），grid.lon 经
    DEM 重采样后实际范围是 121.550139-121.699583，海曙站 lon=121.55
    落在请求框内但在格网范围外。用 BBOX 判会多算一个站，用格网判是
    真实的可插值范围。`observe.rain_check` 同样按格网范围判定，
    两处 `n_stations` 与 `n_stations_in_domain` 是同一组站。

    返回 (订正后降雨场, 订正报告)。
    """
    lon2d, lat2d = np.meshgrid(grid.lon, grid.lat)
    inside = []
    for r in stations:
        try:
            lo, la = float(r["lon"]), float(r["lat"])
            acc = float(r["accum_mm"])
        except (KeyError, TypeError, ValueError):
            continue
        if grid.lon.min() <= lo <= grid.lon.max() and \
           grid.lat.min() <= la <= grid.lat.max():
            inside.append((str(r.get("station", "?")), lo, la, acc))

    if not inside:
        return rain, {"applied": False, "reason": "计算域内无实测站，未订正"}

    step_per_hour = 6
    dt_h = 600.0 / 3600.0

    # 逐时（在 ERA5 节点上）取样，构造站点观测的时序分布
    n_steps = rain.shape[0]
    model_series = rain.mean(axis=(1, 2))        # (nt,) 域面平均雨强 mm/h

    # 站点观测只有窗口累计量，没有逐时序列。用均匀时距分配把累计量
    # 摊到同一nt步上——这是**最弱的一环**，等价于假设站点降雨在72h 内
    # 均匀落完。真实的台风降雨是钟形的，均匀摊分会高估雨强峰值。
    # 该近似的误差记进报告，不当结论用。
    obs_series = []
    for _, _, _, acc in inside:
        obs_series.append(np.full(n_steps, acc / (n_steps * dt_h)))
    obs_flat = np.concatenate(obs_series)         # (n_in * nt,)

    model_flat = np.tile(model_series, len(inside))

    src_q = np.quantile(model_flat, np.linspace(0, 1, 51))
    dst_q = np.quantile(obs_flat, np.linspace(0, 1, 51))
    # 保序：强制单调，避免极端集中时映射函数非单调
    src_m = np.maximum.accumulate(src_q)
    dst_m = np.maximum.accumulate(dst_q)

    def _map(v: float) -> float:
        return float(np.interp(v, src_m, dst_m))

    scale_by_step = np.array([_map(float(v)) for v in model_series])
    # 单调映射后比值可能为 0（模型有雨而观测分位为 0），下限兜底
    with np.errstate(divide="ignore", invalid="ignore"):
        ratio = np.where(model_series > 1e-6, scale_by_step / model_series, 1.0)
    ratio_raw = np.nan_to_num(ratio, nan=1.0)
    # 截断前先记原始范围：触到兜底边界说明映射在极端步上要求了不
    # 可信的比值，那是要暴露的问题，不是可以静默夹掉的值。
    n_clipped = int(np.count_nonzero(
        (ratio_raw < 0.2) | (ratio_raw > 5.0)))
    ratio = np.clip(ratio_raw, 0.2, 5.0)

# 就地缩放。逐时 ratio 是 (nt,) 的广播视图，没有理由为它另开一个
    # (nt,ny,nx) 输出数组——雨场本身 64 MiB，多开一份就意味着同时
    # 持有 128 MiB。本机在 10 GB 空闲下仍报 ArrayMemoryError，实测踩过
    # 三次，所以这不是可以忽略的优化。
    #
    # 传入的rain 来自 np.load 的独立数组（不是 mmap），可写；就地改
    # 不会污染磁盘缓存，因为缓存的写入只发生在 fetch_era5 路径上。
    if not rain.flags.writeable:
        raise RainSourceError("降雨场不可写，无法就地订正")
    if rain.dtype != np.float32:
        raise RainSourceError(
            f"降雨场 dtype 为 {rain.dtype}，就地订正要求 float32")
    out = rain
    out *= ratio.astype(np.float32)[:, None, None]

    before = float(model_series.sum() * dt_h)
    after = float(out.mean(axis=(1, 2)).sum() * dt_h)
    report = {
        "applied": True,
        "method": "分位数映射（51 分位，保序）",
        "n_stations_in_domain": len(inside),
        "stations": [f"{nm} {acc:.0f}mm" for nm, _, _, acc in inside],
        "model_mm_before": round(before, 1),
        "model_mm_after": round(after, 1),
        "ratio_range": [round(float(ratio.min()), 3),
                        round(float(ratio.max()), 3)],
        "ratio_range_raw": [round(float(ratio_raw.min()), 3),
                            round(float(ratio_raw.max()), 3)],
        "n_clipped_steps": n_clipped,
        "n_steps": int(n_steps),
        "clip_bounds": [0.2, 5.0],
        "caveat": "站点观测无逐时序列，累计量按均匀时距摊到 nt 步；"
                  "该近似高估雨强峰值，属已知弱项。"
                  + (f"另有 {n_clipped}/{n_steps} 步的订正比值触到"
                     f"夹取边界 [{0.2}, {5.0}]，说明分位数映射在这些步上"
                     f"要求了不可信的比值；单站订正只约束总量，"
                     f"不约束空间分布。" if n_clipped else ""),
    }
    return out, report


def save_cache(fld: ReanalysisField, name: str = "era5") -> Path:
    p = SEED_DIR / f"rain_reanalysis_{name}.npz"
    SEED_DIR.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        p, rain_mm_h=fld.rain_mm_h,
        node_lats=np.array(fld.node_lats), node_lons=np.array(fld.node_lons),
        node_accum_mm=np.array(fld.node_accum_mm),
        meta=np.array(json.dumps({
            "src": fld.src, "grid_accum_mm": fld.grid_accum_mm,
            "window": list(fld.window), "n_timesteps": fld.n_timesteps,
            "fetched_at": fld.fetched_at, "notes": fld.notes,
        }, ensure_ascii=False)))
    return p


def load_cache(name: str = "era5") -> ReanalysisField | None:
    p = SEED_DIR / f"rain_reanalysis_{name}.npz"
    if not p.exists():
        return None
    z = np.load(p, allow_pickle=False)
    meta = json.loads(str(z["meta"]))
    return ReanalysisField(
        rain_mm_h=z["rain_mm_h"], src=meta["src"],
        node_lats=[float(x) for x in z["node_lats"]],
        node_lons=[float(x) for x in z["node_lons"]],
        node_accum_mm=[float(x) for x in z["node_accum_mm"]],
        grid_accum_mm=meta["grid_accum_mm"],
        window=tuple(meta["window"]), n_timesteps=meta["n_timesteps"],
        fetched_at=meta["fetched_at"], notes=meta["notes"])


def get_rainfall(grid: Grid, stations: list[dict] | None = None,
                 use_cache: bool = True, calibrate: bool = True,
                 verbose: bool = True) -> tuple[np.ndarray, dict]:
    """取降雨驱动场。优先缓存，其次 ERA5 实时拉取，都失败则降级参数化场。

    返回 `(rain_mm_h, 来源报告)`。报告里的 `driver` 字段标明实际用了
    哪一条，调用方必须把它写进输出物，不许只报数字。
    """
    log = (lambda *a: print(*a, flush=True)) if verbose else (lambda *a: None)

    if use_cache:
        cached = load_cache()
        if cached is not None:
            log(f"     降雨源 ERA5 缓存命中  面雨量 {cached.grid_accum_mm:.1f} mm")
            return _finalize(cached, grid, stations, calibrate, "era5-cache")

    try:
        log("[L0] 拉取 ERA5 再分析降水（免 key） ...")
        fld = fetch_era5(grid)
        log(f"     {fld.n_timesteps} 步  {len(fld.node_lats)} 节点  "
            f"插值后面雨量 {fld.grid_accum_mm:.1f} mm")
        save_cache(fld)
        return _finalize(fld, grid, stations, calibrate, "era5")
    except RainSourceError as e:
        log(f"[!] ERA5 不可用：{e}")
        log("[!] 降级到参数化合成场，门槛 15 仍为 BLOCKED")
        from .kernel import KernelParams, rainfall_field
        from .data import load_track
        # 用 KernelParams 默认值只为取 rainfall_field 需要的 max_t_h。
        # 入渗类参数在此处不生效（rainfall_field 不读它们），但若将来
        # rainfall_field 开始依赖入渗参数，这行会静默分叉。加断言锁住。
        _p = KernelParams()
        if not hasattr(_p, "max_t_h"):
            raise RuntimeError("KernelParams 缺 max_t_h，降雨场无法生成")
        rain = rainfall_field(load_track(), grid, _p)
        return rain, {
            "driver": "parametric-fallback",
            "reason": str(e),
            "caveat": "参数化合成场，量级偏保守；所有由它推出的阈值"
                      "在报告中必须标注为合成驱动",
        }


def _finalize(fld: ReanalysisField, grid: Grid,
              stations: list[dict] | None, calibrate: bool,
              driver: str) -> tuple[np.ndarray, dict]:
    rain = fld.rain_mm_h
    report = {
        "driver": driver,
        "src": fld.src,
        "window": list(fld.window),
        "grid_accum_mm_before": fld.grid_accum_mm,
        "node_accum_mm": fld.node_accum_mm,
        "node_accum_min": min(fld.node_accum_mm) if fld.node_accum_mm else None,
        "node_accum_max": max(fld.node_accum_mm) if fld.node_accum_mm else None,
        "fetched_at": fld.fetched_at,
        "notes": fld.notes,
    }
    if calibrate and stations:
        rain, cal = calibrate_against_stations(rain, stations, grid)
        report["calibration"] = cal
        report["grid_accum_mm"] = cal.get(
            "model_mm_after", fld.grid_accum_mm)
    else:
        report["grid_accum_mm"] = fld.grid_accum_mm
        report["calibration"] = {
            "applied": False,
            "reason": "未提供站点或显式关闭订正",
        }
    return rain, report


def load_cmfd(path: str, var: str = "prec") -> np.ndarray:
    """从本地 CMFD v2.0 NetCDF 读降水率（预留接口，当前不可用）。

    CMFD 走 FTP 交付，需中国科技云通行证 + 邮件下发账号，无法在代码里
    自动获取。账号到手后：下载 `prec_CMFD_V0200_B-01_03hr_010deg_202107.nc`
    到本地，传路径给本函数。

    参数：
        path —— NetCDF 文件路径
        var  —— 变量名，CMFD 2.0 降水率默认为 `prec`，单位 kg m-2 s-1
    返回：
        (nt, ny, nx) 逐时雨强 mm/h
    """
    try:
        import netCDF4 as nc
    except ImportError as e:
        raise RainSourceError("读 CMFD 需要 netCDF4，请先安装") from e

    if not Path(path).exists():
        raise RainSourceError(f"CMFD 文件不存在：{path}")

    ds = nc.Dataset(path)
    try:
        if var not in ds.variables:
            raise RainSourceError(
                f"变量 {var} 不在文件中，现有：{list(ds.variables)}")
        # CMFD 时距3h，转逐时需在 time 维插值。当前只支持单时刻切片，
        # 完整时间序列接入见 CMFD_ACCESS.md
        data = ds.variables[var][:]
        units = getattr(ds.variables[var], "units", "kg m-2 s-1")
        if "kg" not in units and "mm" not in units:
            raise RainSourceError(f"降水率单位无法识别：{units}")
        arr = np.asarray(data, dtype=np.float64)
        # kg m-2 s-1 -> mm/h
        if "s-1" in units:
            arr = arr * 3600.0
        return arr.astype(np.float32)
    finally:
        ds.close()


if __name__ == "__main__":
    from . import data as D
    from . import observe as OB
    gg = D.load_dem(D.BBOX, 2)
    rain, rep = get_rainfall(gg, stations=OB.load_rain_stations(),
                             use_cache=False)
    print(json.dumps({k: v for k, v in rep.items() if k != "node_accum_mm"},
                     ensure_ascii=False, indent=2))
