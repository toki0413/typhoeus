"""CMPAS（中国气象局多源融合实况分析）降水读取与域内切片。

CMPAS 是国内权威的多源融合实况产品（雷达 + 卫星 + 地面站），对本项目的价值：
  - **逐小时**（CMFD 是 3 小时，ERA5 缓存是 10 分钟模型步长但非观测）
  - 空间分辨率 **0.05° 或 0.01°**（CMFD 与 IMERG 都是 0.1°）
  - 中国气象局发布，国内网络可直达

取数方式：data.cma.cn 需**实名注册**后下载（数据集代码
`SURF_CLI_CHN_MERGE_CMP_PRE_HOUR_GRID_0.05` / `..._0.01`），
因此本模块假设文件已由使用者下载到 `data/seed/cmpas/`。

常见格式与变量名（随产品版本不同）：
  - 变量：`pre` / `precipitation` / `r` / `PRE`
  - 单位：mm（逐小时累积量）或 mm/hr（降水率）——模块按单位自动判定，
    并通过 `--assume-rate` / `--assume-accum` 可强制覆盖。
  - 时间：NetCDF 的 time 维（逐小时）

用法：
  python -m typhoeus.cmpas                 # 扫描 data/seed/cmpas/ 下所有 .nc
  python -m typhoeus.cmpas --selftest      # 合成数据自测
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path

import numpy as np

from .cmfd import load_month

ROOT = Path(__file__).resolve().parent.parent
SEED = ROOT / "data" / "seed" / "cmpas"

# CMPAS 各版本用过的变量名
CMPAS_VARS = ("pre", "precipitation", "r", "PRE", "precip",
              "prec", "prec_corr", "rain")


def load(path: Path, assume_rate: bool | None = None) -> dict:
    """读一个 CMPAS 文件并按计算域切片（复用 CMFD 的通用网格逻辑）。"""
    r = load_month(path, var_candidates=CMPAS_VARS, assume_rate=assume_rate)
    r["产品"] = "CMPAS（中国气象局多源融合实况分析）"
    r["相对 CMFD 的优势"] = "逐小时（CMFD 为 3 小时）；分辨率 0.05°/0.01°（CMFD 为 0.1°）"
    return r


def selftest() -> int:
    """用逐小时合成场验证：步长识别、单位换算、域内切片。"""
    import xarray as xr

    lats = np.arange(29.70, 30.05, 0.05)      # 0.05° 网格
    lons = np.arange(121.40, 121.90, 0.05)
    times = np.arange(np.datetime64("2021-07-25T00"), np.datetime64("2021-07-25T12"),
                      np.timedelta64(1, "h"))   # 逐小时，共 12 个时次
    rng = np.random.default_rng(1)
    # CMPAS 常见为"逐小时累积量 mm"，这里故意用 mm 验证不换算
    data = rng.uniform(0.1, 8.0, size=(len(times), len(lats), len(lons))).astype("float32")
    da = xr.DataArray(data, coords={"time": times, "lat": lats, "lon": lons},
                      dims=("time", "lat", "lon"), name="pre",
                      attrs={"units": "mm"})
    td = SEED / "_selftest"
    td.mkdir(parents=True, exist_ok=True)
    p = td / "CMPAS_20210725_小时降水.nc"
    da.to_dataset().to_netcdf(p)
    try:
        r = load(p)
        print("自测结果（CMPAS）：")
        print(f"  变量        : {r['变量']}（{r['原始单位']}）")
        print(f"  步长识别    : {r['步长_h']} h（应为 1.0）")
        print(f"  按降水率处理: {r['按降水率处理']}（累积量应为 False）")
        print(f"  时次数      : {r['时次数']}（应为 12）")
        print(f"  域内格点数  : {r['格点数']}")
        print(f"  累计面雨量  : {r['域内累计_mm']} mm")
        ok = (r["时次数"] == 12 and r["步长_h"] == 1.0
              and r["按降水率处理"] is False and min(r["格点数"]) > 0
              and r["域内累计_mm"] > 0)
        print(f"  结论        : {'PASS' if ok else 'FAIL'}")
        return 0 if ok else 1
    finally:
        p.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="typhoeus.cmpas")
    ap.add_argument("--file")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--assume-rate", action="store_true", help="强制按降水率(mm/hr)换算")
    ap.add_argument("--assume-accum", action="store_true", help="强制按累积量(mm)处理")
    ap.add_argument("--outdir", default="out")
    a = ap.parse_args(argv)

    if a.selftest:
        return selftest()

    override = True if a.assume_rate else (False if a.assume_accum else None)

    files = [Path(a.file)] if a.file else sorted(SEED.glob("*.nc"))
    if not files or not files[0].exists():
        print(f"未找到文件。请把 CMPAS 逐小时降水文件放入 {SEED}/ ，例如：")
        print("  CMPAS_20210725_小时降水.nc")
        print("获取方式：data.cma.cn 实名注册 → 数据集 "
              "SURF_CLI_CHN_MERGE_CMP_PRE_HOUR_GRID_0.05")
        return 2

    results = []
    for f in files:
        r = load(f, assume_rate=override)
        results.append(r)
        print(f"  {f.name}: {r['时次数']} 时次 × {r['步长_h']} h · "
              f"累计 {r['域内累计_mm']} mm · 格点 {r['格点数']}")

    out = Path(a.outdir) / "cmpas_域内降雨.json"
    out.write_text(json.dumps(
        {"文件": results, "生成时间": datetime.now().isoformat(timespec="seconds")},
        ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"→ {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
