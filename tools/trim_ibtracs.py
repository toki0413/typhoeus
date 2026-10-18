"""把 IBTrACS 西太分片裁成"本包需要的场次"，随安装包发布。

为什么不整份 110 MB 放进去：包只要跑主链（2021 IN-FA）与多事件标定
（EVENT_CATALOG 的 18 场）。`data.load_all` 的 source_hash 只由
DEM 文件 + 网格形状 + 路径点 (`t:lat:lon`) 决定，不看 CSV 字节——
所以裁完只要 IN-FA 的路径点逐点相同，source_hash 就与仓库一致。

用法：
    python tools/trim_ibtracs.py <输出 csv 路径>
"""
from __future__ import annotations

import csv
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from typhoeus.multievent import EVENT_CATALOG  # noqa: E402

SRC = ROOT / "data" / "ibtracs_wp.csv"


def main(argv: list[str]) -> int:
    dest = Path(argv[1]) if len(argv) > 1 else ROOT / "dist" / "ibtracs_wp.csv"
    keep = {(int(y), n) for y, n, _ in EVENT_CATALOG}
    dest.parent.mkdir(parents=True, exist_ok=True)
    with open(SRC, encoding="utf-8", newline="") as f, \
            open(dest, "w", encoding="utf-8", newline="") as o:
        r = csv.reader(f)
        w = csv.writer(o, lineterminator="\n")
        header = next(r)
        w.writerow(header)
        iy, iname = header.index("SEASON"), header.index("NAME")
        n = 0
        for row in r:
            try:
                y = int(row[iy])
            except (ValueError, IndexError):
                continue
            if (y, row[iname]) not in keep:
                continue
            w.writerow(row)
            n += 1
    print(f"{dest}  {n} 行  {dest.stat().st_size / 1e6:.1f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
