"""情景矩阵：把 p50–p95 四档面雨量驱动内核各跑一次，取极端值口径的指标。

对应借鉴：CorrDiff 的验证不止看均值，还看小尺度谱能与**极端值分布**。
本模块输出四档情景下的峰值水深、四色面积构成、损失量级与超阈格点数，
用于回答"雨情加严一档，极端情况恶化多少"——均值口径下无法回答这个问题。

输出：
  <outdir>/p6_情景矩阵.json
用法：python -m typhoeus.scenario_matrix [outdir]
"""

from __future__ import annotations

import json
import time
from datetime import datetime
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent

# 与 products.SCENARIOS 同一份分位数（基准 = 事件面雨量）
SCENARIOS = [("p50", 258.4), ("p80", 313.2), ("p90", 338.8), ("p95", 354.1)]
LEVELS = [("绿 <0.1m", 0.0, 0.1), ("黄 0.1-0.2m", 0.1, 0.2),
          ("橙 0.2-0.5m", 0.2, 0.5), ("红 ≥0.5m", 0.5, 1e9)]


def build_rows(inp, base_rain, base_mm, kp, verbose: bool = False) -> list[dict]:
    """跑 p50–p95 四档内核，返回极端值指标行。

    基准档（p50，缩放 ×1.00）与主链同源：若调用方已算过基准场，可由
    `base_rows` 复用（见 `compute(base_rows=...)`），避免重复求解。
    """
    import time

    import numpy as np

    from . import projection as PRJ

    rows = []
    for name, target_mm in SCENARIOS:
        scale = target_mm / base_mm if base_mm else 1.0
        rain = np.asarray(base_rain, dtype=float) * scale
        t0 = time.perf_counter()
        from . import kernel as K
        res = K.run(inp.grid, rain, kp)
        elapsed = time.perf_counter() - t0
        depth = res.depth
        peak = depth.max(axis=0)
        total = peak.size
        counts = {}
        for label, lo, hi in LEVELS:
            counts[label] = int(np.count_nonzero((peak >= lo) & (peak < hi)))
        shares = {k: round(v / total, 6) for k, v in counts.items()}
        over_underpass = int(np.count_nonzero(peak >= 0.25))
        from . import config as CFG
        cfg = CFG.Config()
        proj = PRJ.aggregate(depth, PRJ.ProjectionParams(
            road_capacity={r: dict(v) for r, v in cfg.l3.road_capacity.items()},
            road_mix=dict(cfg.l3.road_mix)))
        rows.append({
            "档": name,
            "面雨量_mm": target_mm,
            "相对基准_倍数": round(scale, 3),
            "峰值水深_m": round(float(peak.max()), 4),
            "水深_p99_m": round(float(np.percentile(peak, 99)), 4),
            "水深_p95_m": round(float(np.percentile(peak, 95)), 4),
            "水深_中位数_m": round(float(np.median(peak)), 5),
            "四色格点数": counts,
            "四色面积占比": shares,
            "超下穿立交中断系数格点_≥0.25m": over_underpass,
            "超阈面积占比_≥0.25m": round(over_underpass / total, 6),
            "峰值功能损失": round(float(proj.get("peak_loss", 0.0)), 4),
            "最低功能_Q": round(float(proj.get("min_Q", 0.0)), 4),
            "求解耗时_s": round(elapsed, 2),
            "来源": "内核求解",
        })
        if verbose:
            print(f"  {name}  {target_mm:.1f} mm  ×{scale:.2f}  "
                  f"峰值 {rows[-1]['峰值水深_m']:.3f} m  "
                  f"≥0.25m 格点 {over_underpass}  {elapsed:.1f}s")
    return rows


def rows_from_depth(depth, target_mm: float, scale: float,
                    elapsed: float = 0.0, source: str = "复用主链求解",
                    name: str = "p50") -> dict:
    """由已算好的水深场（nt, ny, nx）直接出极端值指标行，不重跑内核。"""
    import numpy as np

    from . import config as CFG
    from . import projection as PRJ

    peak = np.asarray(depth).max(axis=0)
    total = peak.size
    counts = {label: int(np.count_nonzero((peak >= lo) & (peak < hi)))
              for label, lo, hi in LEVELS}
    shares = {k: round(v / total, 6) for k, v in counts.items()}
    over = int(np.count_nonzero(peak >= 0.25))
    cfg = CFG.Config()
    proj = PRJ.aggregate(np.asarray(depth), PRJ.ProjectionParams(
        road_capacity={r: dict(v) for r, v in cfg.l3.road_capacity.items()},
        road_mix=dict(cfg.l3.road_mix)))
    return {
        "档": name,
        "面雨量_mm": target_mm,
        "相对基准_倍数": round(scale, 3),
        "峰值水深_m": round(float(peak.max()), 4),
        "水深_p99_m": round(float(np.percentile(peak, 99)), 4),
        "水深_p95_m": round(float(np.percentile(peak, 95)), 4),
        "水深_中位数_m": round(float(np.median(peak)), 5),
        "四色格点数": counts,
        "四色面积占比": shares,
        "超下穿立交中断系数格点_≥0.25m": over,
        "超阈面积占比_≥0.25m": round(over / total, 6),
        "峰值功能损失": round(float(proj.get("peak_loss", 0.0)), 4),
        "最低功能_Q": round(float(proj.get("min_Q", 0.0)), 4),
        "求解耗时_s": round(elapsed, 2),
        "来源": source,
    }


def assemble(rows: list[dict], base_mm: float, rain_driver: str) -> dict:
    """把四档行组装成产物载荷（含相对放大倍数）。"""
    first = rows[0]
    for r in rows:
        r["峰值水深_相对_p50_倍数"] = (
            round(r["峰值水深_m"] / first["峰值水深_m"], 3)
            if first["峰值水深_m"] > 0 else None)
        r["超阈面积_相对_p50_倍数"] = (
            round(r["超阈面积占比_≥0.25m"] / first["超阈面积占比_≥0.25m"], 3)
            if first["超阈面积占比_≥0.25m"] > 0 else None)
    return {
        "名称": "情景矩阵（极端值口径）",
        "事件": "2021 年第 6 号台风「烟花」（In-Fa）· 宁波鄞东南片区",
        "口径": "四档面雨量驱动内核；指标取空间峰值与分位数，非均值",
        "基准面雨量_mm": round(base_mm, 4),
        "降雨驱动": rain_driver,
        "情景": rows,
        "求解来源": {r["档"]: r.get("来源", "内核求解") for r in rows},
        "说明": [
            "只缩放降雨强度，地形、下渗与承灾体系数保持不变。",
            "峰值水深与 p99 是空间统计量，不对应任一具体点位。",
            "「超下穿立交中断系数格点」以 0.25 m（ROAD_CAPACITY 下穿立交 b 值）为参考线。",
            "基准档复用主链求解结果，四档之间保持同一内核参数，可比。",
        ],
        "生成模块": "typhoeus.scenario_matrix",
        "生成时间": datetime.now().isoformat(timespec="seconds"),
    }


def compute(outdir: str | Path = "out", verbose: bool = True,
            base_rows: list[dict] | None = None) -> dict:
    from . import cli as CLI
    from . import config as CFG
    from . import data as D
    from . import kernel as K
    from . import observe as OB
    from . import rainsrc as RS

    outdir = Path(outdir)
    cfg = CFG.Config()
    inp = D.load_all(cfg.l2.bbox, cfg.l4.resample)
    base_rain, rain_report = RS.get_rainfall(
        inp.grid, stations=OB.load_rain_stations(),
        use_cache=True, calibrate=cfg.l2.rain_calibrate, verbose=False)

    preset = outdir / "01_preset_plan.json"
    base_mm = 259.1
    if preset.exists():
        base_mm = float(json.loads(preset.read_text(encoding="utf-8"))
                        ["输入层校验"]["model_mm"])
    if verbose:
        print(f"基准面雨量 {base_mm:.1f} mm（驱动 {rain_report.get('driver')}）")

    kp = CLI._kernel_params(cfg)
    if base_rows:
        rows = list(base_rows)
        if verbose:
            print("  基准档复用主链求解结果，其余档内核求解 ...")
        rest = build_rows(inp, base_rain, base_mm, kp, verbose=verbose)[1:]
        rows += rest
    else:
        rows = build_rows(inp, base_rain, base_mm, kp, verbose=verbose)

    payload = assemble(rows, base_mm, rain_report.get("driver"))
    p = outdir / "p6_情景矩阵.json"
    p.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    if verbose:
        print(f"  {p}")
    return payload


def main(argv: list[str] | None = None) -> int:
    import sys

    args = list(sys.argv[1:] if argv is None else argv)
    compute(args[0] if args else "out")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
