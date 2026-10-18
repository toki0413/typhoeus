"""CMFD 2.0 降水读取与域内切片。

CMFD 2.0（国家青藏高原科学数据中心，何杰等 2024，DOI 10.11888/Atmos.tpdc.302088）：
  - 3 小时、0.1°、1951–2024
  - 文件名 VVVV_CMFD_Vvvvv_CCCC_tttt_sssdeg_YYYYMM.nc
  - 降水变量通常为 `prec`（降水率 mm/hr）或 `prec_corr`

TPDC 下载需浏览器登录（其 API 为 SPA、FTP 端口从部分网络不可达），
因此本模块假设**文件已由使用者下载到 data/seed/cmfd/**，只负责解析与切片。

用法：
  python -m typhoeus.cmfd --file data/seed/cmfd/prec_CMFD_V0200_B-01_03hr_010deg_202107.nc
  python -m typhoeus.cmfd --selftest        # 用合成数据自测解析逻辑
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SEED = ROOT / "data" / "seed" / "cmfd"
OUT = ROOT / "out"

# 计算域（DEM 重采样后的真实范围）
LON_MIN, LON_MAX = 121.550139, 121.699583
LAT_MIN, LAT_MAX = 29.840417, 29.919861

# 候选降水变量名（不同版本/衍生集命名不同）
PREC_CANDIDATES = ("prec", "prec_corr", "precipitation", "pr", "prec_rate", "rain")


def _pick_var(ds) -> str:
    for name in PREC_CANDIDATES:
        if name in ds.variables:
            return name
    # 退一步：找维度里含 time/lat/lon 且非坐标的变量
    for name, v in ds.variables.items():
        if name in ("time", "lat", "lon", "lat_bnds", "lon_bnds", "time_bnds", "nv"):
            continue
        if {"time", "lat", "lon"} <= set(v.dimensions):
            return name
    raise RuntimeError(
        "找不到降水变量；实际变量："
        + ", ".join(sorted(ds.variables)))


def _units(ds, var: str) -> str:
    """读变量的单位属性。

    xarray 的 Variable 属性在 `.attrs` 里，不是对象属性——用 getattr 会静默读到空串，
    导致"降水率(mm/hr)未×3h"的换算被跳过。这是自测抓出来的真 bug。
    """
    v = ds.variables[var]
    attrs = getattr(v, "attrs", {}) or {}
    for key in ("units", "unit", "Units", "UNITS"):
        if key in attrs:
            return str(attrs[key])
    return ""


def load_month(path: Path, var_candidates: tuple[str, ...] | None = None,
               assume_rate: bool | None = None) -> dict:
    """读取一个网格降水文件，返回域内逐时次面雨量与元数据。

    被 CMFD（3 小时月文件）与 CMPAS（逐小时融合）共用：
    两者都是 time×lat×lon 的 NetCDF 网格，差别只在变量名、时间步长与单位。

    `var_candidates` 覆盖默认候选；`assume_rate` 为 None 时按单位判断
    （mm/hr 视为降水率、需乘步长），显式传 True/False 可强制。
    """
    import xarray as xr

    cands = var_candidates or PREC_CANDIDATES
    ds = xr.open_dataset(path, decode_times=True)
    var = None
    for name in cands:
        if name in ds.variables:
            var = name
            break
    if var is None:
        for name, v in ds.variables.items():
            if name in ("time", "lat", "lon", "lat_bnds", "lon_bnds", "time_bnds", "nv"):
                continue
            if {"time", "lat", "lon"} <= set(v.dimensions):
                var = name
                break
    if var is None:
        raise RuntimeError("找不到降水变量；实际变量：" + ", ".join(sorted(ds.variables)))

    units = _units(ds, var)
    da = ds[var]

    # 统一到 (time, lat, lon)
    lat_name = next((n for n in ("lat", "latitude", "LAT") if n in da.dims), None)
    lon_name = next((n for n in ("lon", "longitude", "LON") if n in da.dims), None)
    if lat_name is None or lon_name is None:
        raise RuntimeError(f"找不到 lat/lon 维度；实际维度：{list(da.dims)}")

    sub = da.sel({lat_name: slice(min(LAT_MIN, LAT_MAX), max(LAT_MIN, LAT_MAX)),
                  lon_name: slice(min(LON_MIN, LON_MAX), max(LON_MIN, LON_MAX))})
    if sub.sizes.get(lat_name, 0) == 0 or sub.sizes.get(lon_name, 0) == 0:
        # 可能经纬度顺序相反（降序）
        sub = da.sel({lat_name: slice(max(LAT_MIN, LAT_MAX), min(LAT_MIN, LAT_MAX)),
                      lon_name: slice(max(LON_MIN, LON_MAX), min(LON_MIN, LON_MAX))})

    vals = np.asarray(sub.values, dtype=float)
    while vals.ndim > 3:
        vals = vals[0]
    if vals.ndim == 2:
        vals = vals[None]

    # 时间步长：取相邻时次中位数（小时）
    dt_h = 3.0
    try:
        t = sub.coords.get("time")
        if t is not None and t.size > 1:
            d = np.diff(np.asarray(t.values).astype("datetime64[m]"))
            dt_h = float(np.median(d.astype("timedelta64[m]").astype(float)) / 60.0)
    except Exception:  # noqa: BLE001
        pass
    dt_h = round(dt_h, 3) if dt_h > 0 else 3.0

    # 单位换算：mm/hr 的降水率 → 每步 mm
    is_rate = assume_rate
    if is_rate is None:
        is_rate = any(k in units.replace(" ", "").lower()
                      for k in ("mm/h", "mmhr", "mm/hr", "rate"))
    per_step_mm = vals * dt_h if is_rate else vals
    face_mean = per_step_mm.mean(axis=(1, 2))

    times = []
    try:
        t = sub.coords.get("time")
        if t is not None:
            times = [str(x)[:19] for x in np.asarray(t.values)]
    except Exception:  # noqa: BLE001
        pass

    return {
        "文件": path.name,
        "变量": var,
        "原始单位": units,
        "步长_h": dt_h,
        "按降水率处理": bool(is_rate),
        "时次数": int(per_step_mm.shape[0]),
        "格点数": [int(per_step_mm.shape[1]), int(per_step_mm.shape[2])],
        "域内面雨量_每步_mm": [round(float(x), 3) for x in face_mean],
        "域内累计_mm": round(float(face_mean.sum()), 2),
        "累计算法": "先对域内空间平均再对时间求和（面雨量口径）",
        "时次": times,
        "时间维单位": str(getattr(ds["time"], "attrs", {}).get("units", "?"))
        if "time" in ds else "?",
    }


def selftest() -> int:
    """用合成 NetCDF 验证解析与切片逻辑（不依赖真实下载）。

    注意：写在工作区内（`data/seed/cmfd/_selftest/`），不用系统临时目录——
    在受限沙箱下系统临时目录不可写，会把自测卡在基础设施上而不是逻辑上。
    """
    import xarray as xr

    # 构造一个 3 小时 × 0.1° 的合成场，域内 2×2 格
    lats = np.arange(29.70, 30.05, 0.1)
    lons = np.arange(121.40, 121.90, 0.1)
    times = np.arange(np.datetime64("2021-07-01T00"), np.datetime64("2021-07-02T00"),
                      np.timedelta64(3, "h"))
    rng = np.random.default_rng(0)
    data = rng.uniform(0.5, 6.0, size=(len(times), len(lats), len(lons))).astype("float32")
    da = xr.DataArray(data, coords={"time": times, "lat": lats, "lon": lons},
                      dims=("time", "lat", "lon"), name="prec",
                      attrs={"units": "mm/hr"})
    td = SEED / "_selftest"
    td.mkdir(parents=True, exist_ok=True)
    p = td / "prec_CMFD_V0200_B-01_03hr_010deg_202107.nc"
    da.to_dataset().to_netcdf(p)
    try:
        r = load_month(p)
        expect_cells = (sum(1 for x in lats if LAT_MIN <= x <= LAT_MAX)
                        * sum(1 for x in lons if LON_MIN <= x <= LON_MAX))
        print("自测结果：")
        print(f"  变量        : {r['变量']}（{r['原始单位']}）")
        print(f"  按降水率处理: {r['按降水率处理']}")
        print(f"  时次数      : {r['时次数']}（应为 8）")
        print(f"  域内格点数  : {r['格点数']}（域内应有 {expect_cells} 格/维组合）")
        print(f"  累计面雨量  : {r['域内累计_mm']} mm")
        ok = (r["时次数"] == 8 and r["按降水率处理"]
              and r["域内累计_mm"] > 0 and min(r["格点数"]) > 0)
        print(f"  结论        : {'PASS' if ok else 'FAIL'}")
        return 0 if ok else 1
    finally:
        p.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="typhoeus.cmfd")
    ap.add_argument("--file", help="CMFD 月文件路径")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--outdir", default="out")
    a = ap.parse_args(argv)

    if a.selftest:
        return selftest()

    if not a.file:
        SEED.mkdir(parents=True, exist_ok=True)
        files = sorted(SEED.glob("*.nc"))
        if not files:
            print(f"未指定 --file，且 {SEED} 下没有 .nc 文件。")
            print("请从 TPDC 下载 CMFD 2.0 降水月文件后放入该目录，例如：")
            print("  prec_CMFD_V0200_B-01_03hr_010deg_202107.nc")
            return 2
        print(f"发现 {len(files)} 个文件，逐个解析：")
        results = []
        for f in files:
            r = load_month(f)
            results.append(r)
            print(f"  {f.name}: {r['时次数']} 时次 · 累计 {r['域内累计_mm']} mm")
        out = Path(a.outdir) / "cmfd_域内降雨.json"
        out.write_text(json.dumps({"文件": results,
                                   "生成时间": datetime.now().isoformat(timespec="seconds")},
                                  ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"→ {out}")
        return 0

    r = load_month(Path(a.file))
    out = Path(a.outdir) / "cmfd_域内降雨.json"
    out.write_text(json.dumps(r, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in r.items() if k not in ("时次",)},
                     ensure_ascii=False, indent=2))
    print(f"→ {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
