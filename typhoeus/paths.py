"""数据与产物目录的解析（可移植）。

源码树里跑：`data/`、`out/` 就在包旁边，行为与以前逐位一致。
装成包以后跑（pip/pipx）：包旁边没有数据，于是按下面顺序找：

1. `TYPHOEUS_HOME` —— 一个目录，里面放 `data/` 与 `out/`
2. `TYPHOEUS_DATA` / `TYPHOEUS_OUTDIR` —— 分别指定
3. `~/.typhoeus/data`、`~/.typhoeus/out`

这样插件 patch 里不需要任何绝对路径：装好包、设一个环境变量即可。
"""
from __future__ import annotations

import os
from pathlib import Path

PKG_ROOT = Path(__file__).resolve().parent.parent


def _home() -> Path | None:
    v = os.environ.get("TYPHOEUS_HOME")
    return Path(v) if v else None


def data_dir() -> Path:
    v = os.environ.get("TYPHOEUS_DATA")
    if v:
        return Path(v)
    h = _home()
    if h:
        return h / "data"
    if (PKG_ROOT / "data").is_dir():
        return PKG_ROOT / "data"
    return Path.home() / ".typhoeus" / "data"


def out_dir() -> Path:
    v = os.environ.get("TYPHOEUS_OUTDIR")
    if v:
        return Path(v)
    h = _home()
    if h:
        return h / "out"
    if (PKG_ROOT / "out").is_dir():
        return PKG_ROOT / "out"
    return Path.home() / ".typhoeus" / "out"
