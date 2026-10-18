"""p18 预警信息增益曲线。

问题：如果当时有本模型，能在卫星看到水之前多少小时给出预警？

真值：SAR 水面掩膜（2021-07-25 21:50 UTC 过境，p10）
模型：逐立场水深场 h(x,t)，10 分钟步长，起点 2021-07-25T06:00

做法：
  对每个 SAR 判为水面的格点，求模型在该格点**首次达到 5 cm** 的时刻，
  与 SAR 过境时刻相减 = 提前量。统计提前量的分布与"可提前 L 小时"的比例。

  这条曲线回答：把预警门槛定在 5 cm、要求提前 L 小时，
  能覆盖多少真实水面格点（召回），以及会多报多少（误报）。

诚实边界：
  - SAR 是瞬时快照，不是"首次积水"时刻；模型可能早于或晚于卫星。
  - 提前量为负说明模型比卫星晚（漏报或滞后）。
  - 5 cm 阈值沿用"模型静默"判据，非业务标准。
  - 模型在大量格点上无信号（已知缺陷），曲线左端会偏低。

用法：python -m typhoeus.earlywarning
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
S1 = ROOT / "data" / "seed" / "sentinel1"
OUT = ROOT / "out"

ANCHOR = "2021-07-25T06:00"
DT_S = 600.0
THRESH_M = 0.05
PAD_DEG, RES = 0.05, 0.0005
LON_MIN, LON_MAX = 121.550139, 121.699583
LAT_MIN, LAT_MAX = 29.840417, 29.919861
# SAR 过境：2021-07-25T21:50:18Z = 当地 2021-07-26 05:50；模型时间轴为当地时间
SAR_LOCAL = datetime(2021, 7, 26, 5, 50)
LEADS = [0, 3, 6, 12, 24, 48]


def build(outdir: str = "out", verbose: bool = True) -> dict | None:
    prob_p = S1 / "water_prob.npy"
    if not prob_p.exists():
        if verbose:
            print("  [跳过] 缺 water_prob.npy")
        return None

    from typhoeus import cli as CLI
    from typhoeus import config as CFG
    from typhoeus import data as D
    from typhoeus import kernel as K
    from typhoeus import observe as OB
    from typhoeus import rainsrc as RS

    cfg = CFG.Config()
    inp = D.load_all(cfg.l2.bbox, cfg.l4.resample)
    rain, _ = RS.get_rainfall(inp.grid, stations=OB.load_rain_stations(),
                              use_cache=True, calibrate=cfg.l2.rain_calibrate,
                              verbose=False)
    res = K.run(inp.grid, rain, CLI._kernel_params(cfg))
    depth = np.asarray(res.depth)                      # (T, ny, nx)
    nt = depth.shape[0]

    # SAR 水面掩膜对齐到模型网格
    prob = np.load(prob_p).astype("float32")
    iy0 = int(PAD_DEG / RES)
    iy1 = int((PAD_DEG + (LAT_MAX - LAT_MIN)) / RES)
    ix1 = int((PAD_DEG + (LON_MAX - LON_MIN)) / RES)
    sar = prob[iy0:iy1, iy0:ix1] > 0.5
    ny, nx = depth.shape[1], depth.shape[2]

    # 把 SAR 掩膜尺寸映射到模型网格（最近邻）
    ys = (np.arange(ny) * sar.shape[0] / ny).astype(int).clip(0, sar.shape[0] - 1)
    xs = (np.arange(nx) * sar.shape[1] / nx).astype(int).clip(0, sar.shape[1] - 1)
    sar_g = sar[np.ix_(ys, xs)]
    n_water = int(sar_g.sum())

    # 每格首次达到阈值的步号
    crossed = depth >= THRESH_M
    first = np.where(crossed.any(axis=0),
                     crossed.argmax(axis=0),
                     -1)                                    # -1 = 从未越阈
    t0 = datetime.fromisoformat(ANCHOR)
    step_h = DT_S / 3600.0
    sar_steps = (SAR_LOCAL - t0).total_seconds() / 3600.0 / step_h

    lead_h = np.full((ny, nx), np.nan)
    m = sar_g
    has = first >= 0
    lead_h[m & has] = (sar_steps - first[m & has]) * step_h
    # 未越阈的：视为提前量极负（无法预警）
    no_sig = m & ~has

    vals = lead_h[np.isfinite(lead_h)]
    curve = []
    for L in LEADS:
        covered = int((vals >= L).sum())
        curve.append({
            "要求提前_h": L,
            "覆盖水面格点数": covered,
            "占全部水面格点": round(covered / max(n_water, 1), 4),
            "占模型有信号格点": round(covered / max(len(vals), 1), 4),
        })

    payload = {
        "名称": "预警信息增益曲线",
        "生成时间": datetime.now().isoformat(timespec="seconds"),
        "问题": "若有本模型，能在卫星看到水之前多少小时预警？",
        "真值": {"来源": "SAR 水面（AWS Sentinel-1B）", "过境_当地": SAR_LOCAL.strftime("%Y-%m-%d %H:%M"),
                 "水面格点数": n_water},
        "模型": {"阈值_m": THRESH_M, "时间轴起点": ANCHOR,
                 "步长_min": DT_S / 60, "时次数": int(nt)},
        "信号覆盖": {
            "水面格点中模型有信号": int(len(vals)),
            "水面格点中模型无信号": int(no_sig.sum()),
            "无信号占比": round(float(no_sig.sum()) / max(n_water, 1), 4),
        },
        "提前量分布_h": {
            "最小": round(float(np.nanmin(vals)), 2) if len(vals) else None,
            "p25": round(float(np.nanpercentile(vals, 25)), 2) if len(vals) else None,
            "中位": round(float(np.nanmedian(vals)), 2) if len(vals) else None,
            "p75": round(float(np.nanpercentile(vals, 75)), 2) if len(vals) else None,
            "最大": round(float(np.nanmax(vals)), 2) if len(vals) else None,
            "为正的比例": round(float((vals >= 0).mean()), 4) if len(vals) else None,
        },
        "增益曲线": curve,
        "边界": [
            "SAR 是瞬时快照，不代表『首次积水』时刻；提前量为负即模型晚于卫星。",
            "5 cm 阈值为『模型静默』判据，非业务标准。",
            "模型在部分水面格点无信号（已知缺陷），按『无法预警』处理。",
            "SAR 掩膜由 U-Net 反演，VH 为代理值；水面含常年河网（见 p14）。",
        ],
    }
    p = Path(outdir)
    p.mkdir(parents=True, exist_ok=True)
    (p / "p18_预警信息增益.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    if verbose:
        s = payload["信号覆盖"]
        d = payload["提前量分布_h"]
        print(f"  SAR 水面 {n_water} 格；模型有信号 {s['水面格点中模型有信号']}"
              f"（无信号 {s['无信号占比']:.1%}）")
        print(f"  提前量：中位 {d['中位']} h  p25 {d['p25']}  p75 {d['p75']}  "
              f"为正 {(d['为正的比例'] or 0):.1%}")
        for c in curve:
            print(f"    提前 ≥{c['要求提前_h']:>2} h：覆盖 {c['覆盖水面格点数']:>4} 格 "
                  f"（{c['占全部水面格点']:.1%}）")
        print(f"→ {p / 'p18_预警信息增益.json'}")
    return payload


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="typhoeus.earlywarning")
    ap.add_argument("outdir", nargs="?", default="out")
    a = ap.parse_args(argv)
    build(a.outdir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
