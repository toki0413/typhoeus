"""逐时雨情剖面与越阈时刻。

关键事实：降雨驱动的缓存本身就是**逐时（10 分钟步长）**序列，时间轴为
2021-07-25T06:00 起 72 h（`rainsrc` 缓存的 notes：step_per_hour=6, anchor）。
因此"越阈时刻"这一类逐时指标**不需要接入任何新数据源**即可计算。

输出：
  <outdir>/p7_逐时雨情.json
用法：python -m typhoeus.rain_timeline [outdir]
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SCENARIOS = [("p50", 258.4), ("p80", 313.2), ("p90", 338.8), ("p95", 354.1)]


def _domain_series() -> tuple[np.ndarray, np.ndarray, dict]:
    """返回 (面雨强 mm/h 逐 10 分钟, 面雨量累计 mm, meta)。

    口径说明（重要）：
    - 缓存里的是**未标定**的 ERA5 原始场，其域内累计为 144.8 mm；
    - 主链用的是**分位数标定后**的场，域内累计 259.1 mm（产物 01/06 同值）；
    - 两者之比即本场的标定系数（约 1.79）。越阈时刻必须在**标定后**口径上算，
      否则会低估累积雨量、把越阈时刻推后甚至判为"未达到"。
    """
    import sys

    sys.path.insert(0, str(ROOT))
    from typhoeus import rainsrc as RS

    f = RS.load_cache("era5")
    if f is None:
        raise RuntimeError("无 ERA5 缓存；请先跑 `python -m typhoeus.cli run`")
    arr = np.asarray(f.rain_mm_h, dtype=float)
    notes = dict(getattr(f, "notes", {}) or {})
    step_per_hour = float(notes.get("step_per_hour", 6) or 6)
    anchor = str(notes.get("anchor", "")) or "2021-07-25T06:00"

    series_mm_h = arr.mean(axis=(1, 2))                  # 面平均雨强
    gridmax_mm_h = arr.max(axis=(1, 2))                  # 格点最大雨强（另一口径）
    step_h = 1.0 / step_per_hour
    cum_raw = np.cumsum(series_mm_h * step_h)

    # 标定后累计以产物为准（与主链同源）
    calibrated_total = None
    preset = ROOT / "out" / "01_preset_plan.json"
    if preset.exists():
        try:
            calibrated_total = float(json.loads(
                preset.read_text(encoding="utf-8"))["输入层校验"]["model_mm"])
        except Exception:  # noqa: BLE001
            calibrated_total = None
    raw_total = float(cum_raw[-1]) if len(cum_raw) else 0.0
    factor = (calibrated_total / raw_total) if (calibrated_total and raw_total > 0) else 1.0
    cum = cum_raw * factor

    return series_mm_h, cum, {
        "anchor": anchor, "step_per_hour": step_per_hour,
        "step_h": step_h, "n_steps": int(arr.shape[0]),
        "grid_shape": list(arr.shape[1:]),
        "raw_total_mm": round(raw_total, 2),
        "calibrated_total_mm": (round(calibrated_total, 2) if calibrated_total else None),
        "calibration_factor": round(factor, 4),
        "gridmax_mm_h": float(gridmax_mm_h.max()),
        "gridmax_series": gridmax_mm_h,
    }


def compute(outdir: str | Path = "out", verbose: bool = True) -> dict:
    outdir = Path(outdir)
    series, cum, meta = _domain_series()
    t0 = datetime.fromisoformat(meta["anchor"])
    n = len(series)

    def at(step: int) -> str:
        return (t0 + timedelta(hours=step * meta["step_h"])).strftime("%m-%d %H:%M")

    total = float(cum[-1])
    peak_step = int(np.argmax(series))
    gmax_series = meta.pop("gridmax_series")
    peak_grid_step = int(np.argmax(gmax_series))

    # 越阈时刻：累计面雨量首次达到各档阈值
    crossings = []
    for name, thr in SCENARIOS:
        idx = np.argmax(cum >= thr) if (cum >= thr).any() else -1
        crossings.append({
            "档": name,
            "阈值_mm": thr,
            "是否达到": bool(idx >= 0),
            "首达步": int(idx) if idx >= 0 else None,
            "首达时刻": at(int(idx)) if idx >= 0 else None,
            "首达时已历时_h": round(float(idx) * meta["step_h"], 2) if idx >= 0 else None,
        })

    # 逐时聚合剖面
    per_hour = int(meta["step_per_hour"])
    hourly = []
    for i in range(0, n, per_hour):
        blk = cum[i:i + per_hour]
        inten = series[i:i + per_hour]
        if not len(blk):
            continue
        hourly.append({
            "时刻": at(i),
            "历时_h": round(i * meta["step_h"], 1),
            "小时雨量_mm": round(float(inten.sum() * meta["step_h"]), 2),
            "累计面雨量_mm": round(float(blk[-1]), 1),
        })

    # 峰值强度窗口（前后各 30 分钟）
    lo = max(0, peak_step - 3)
    hi = min(n, peak_step + 4)

    payload = {
        "名称": "逐时雨情剖面与越阈时刻",
        "事件": "2021 年第 6 号台风「烟花」（In-Fa）· 宁波鄞东南片区",
        "时间轴": {
            "起点": meta["anchor"], "步长_min": round(meta["step_h"] * 60, 1),
            "步数": meta["n_steps"], "窗口_h": round(n * meta["step_h"], 1),
            "格网": meta["grid_shape"],
        },
        "面雨量累计_mm": round(total, 2),
        "面雨量累计_未标定_mm": meta["raw_total_mm"],
        "标定系数": meta["calibration_factor"],
        "峰值雨强_面平均_mm_h": round(float(series[peak_step]), 3),
        "峰值雨强_面平均_时刻": at(peak_step),
        "峰值雨强_格点最大_mm_h": round(float(gmax_series.max()), 3),
        "峰值雨强_格点最大_时刻": at(peak_grid_step),
        "峰值窗口": {"起": at(lo), "止": at(hi),
                     "窗内面平均_mm_h": round(float(series[lo:hi].mean()), 3)},
        "越阈时刻": crossings,
        "逐时剖面": hourly,
        "口径": [
            "面雨强为空间面平均（144×270 格）；另有格点最大口径，两者并列给出。",
            "越阈判据为累计面雨量首次达到已标定分位档；不改写任何已发布等级。",
            "累计量按本场标定系数对齐到主链口径（未标定 %.1f mm → 标定 %.1f mm）。" 
            % (meta["raw_total_mm"], total),
            "时间轴取自降雨驱动缓存自身的时间戳（anchor + step_per_hour），未重跑内核。",
        ],
        "生成模块": "typhoeus.rain_timeline",
        "生成时间": datetime.now().isoformat(timespec="seconds"),
    }
    p = outdir / "p7_逐时雨情.json"
    p.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    if verbose:
        print(f"时间轴 {meta['anchor']} 起 {n * meta['step_h']:.0f} h，"
              f"步长 {meta['step_h']*60:.0f} min，累计 {total:.1f} mm")
        for c in crossings:
            if c["是否达到"]:
                print(f"  {c['档']}（{c['阈值_mm']} mm）首达 {c['首达时刻']}"
                      f"（历时 {c['首达时已历时_h']} h）")
            else:
                print(f"  {c['档']}（{c['阈值_mm']} mm）未达到")
        print(f"  峰值雨强（面平均）{payload['峰值雨强_面平均_mm_h']} mm/h"
              f" @ {payload['峰值雨强_面平均_时刻']}；"
              f"（格点最大）{payload['峰值雨强_格点最大_mm_h']} mm/h"
              f" @ {payload['峰值雨强_格点最大_时刻']}")
        print(f"  {p}")
    return payload


def main(argv: list[str] | None = None) -> int:
    import sys

    args = list(sys.argv[1:] if argv is None else argv)
    compute(args[0] if args else "out")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
