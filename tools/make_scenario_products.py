"""兼容入口：情景—规划机三件套的生成已提升为包内模块。

正式位置：`typhoeus.products`（由 `python -m typhoeus.cli run` 自动调用）。
保留本文件是为了让既有调用方与文档里的路径继续可用。

用法：python tools/make_scenario_products.py [outdir]
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from typhoeus import products as PROD  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(PROD.main(sys.argv[1:]))
