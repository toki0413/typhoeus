"""开箱数据准备：DEM + 台风路径 + （首次运行自动拉的）ERA5 雨量。

只做三件事，缺什么补什么：
  1. data/dem_n29e121.tif   —— Copernicus GLO-30 单瓦片，约 43 MB；
  2. data/ibtracs_wp.csv    —— 只保留 18 场目录台风，约 0.8 MB；
  3. 其余台账已随仓库提供，不下载。

网络不可用时给出明确下一步，不静默降级。
"""
from __future__ import annotations

import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SEED = DATA / "seed"
UA = {"User-Agent": "typhoeus-setup/1.0"}

DEM_TILE = "Copernicus_DSM_COG_10_N29_00_E121_00_DEM"
DEM_URL = f"https://copernicus-dem-30m.s3.amazonaws.com/{DEM_TILE}/{DEM_TILE}.tif"
IB_URL = ("https://www.ncei.noaa.gov/data/international-best-track-archive-for-"
          "climate-stewardship-ibtracs/v04r01/access/csv/ibtracs.WP.list.v04r01.csv")


def _get(url: str, dest: Path, min_mb: float = 0.5) -> bool:
    if dest.exists() and dest.stat().st_size > min_mb * 1e6:
        print(f"  已存在 {dest.name}（{dest.stat().st_size/1e6:.1f} MB）")
        return True
    print(f"  下载 {dest.name} ...", flush=True)
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
            f.write(r.read())
    except Exception as e:  # noqa: BLE001
        print(f"  失败：{type(e).__name__}: {e}")
        if dest.exists():
            dest.unlink()
        return False
    print(f"  完成 {dest.name}（{dest.stat().st_size/1e6:.1f} MB）")
    return True


def main() -> int:
    DATA.mkdir(exist_ok=True)
    SEED.mkdir(exist_ok=True)
    ok = True

    dem = DATA / "dem_n29e121.tif"
    if not _get(DEM_URL, dem, 10):
        ok = False
        print("  → 可手动下载 GLO-30 瓦片 N29E121，改名为 data/dem_n29e121.tif")

    track = DATA / "ibtracs_wp.csv"
    if not track.exists():
        tmp = DATA / "_ibtracs_full.csv"
        if _get(IB_URL, tmp, 5):
            sys.path.insert(0, str(ROOT))
            from typhoeus.multievent import EVENT_CATALOG
            import csv
            keep = {(int(y), n) for y, n, _ in EVENT_CATALOG}
            with open(tmp, encoding="utf-8", newline="") as f, \
                    open(track, "w", encoding="utf-8", newline="") as o:
                r = csv.reader(f)
                w = csv.writer(o, lineterminator="\n")
                head = next(r)
                w.writerow(head)
                iy, iname = head.index("SEASON"), head.index("NAME")
                n = 0
                for row in r:
                    try:
                        y = int(row[iy])
                    except (ValueError, IndexError):
                        continue
                    if (y, row[iname]) in keep:
                        w.writerow(row)
                        n += 1
            tmp.unlink()
            print(f"  已裁切台风路径：{n} 行")
        else:
            ok = False
            print("  → 可手动下载 IBTrACS WP 分片，存为 data/ibtracs_wp.csv")
    else:
        print(f"  已存在 {track.name}")

    print("\n数据就绪" if ok else "\n数据未齐，按上面提示补齐后重跑本脚本")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
