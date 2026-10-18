"""p26 观测同化可行性：用观测插值 vs 用模型，谁更接近观测？

背景（见 docs/breakthrough-assessment.md）：
    宁波市大数据局 + 市水利局 运营着 **149 个内涝监测点**的物联网实时监测，
    提供红橙黄三色（≥0.5 / 0.2 / 0.1 m）与水深变化曲线。
    本项目的 149 点文件正是这批点的**占位版**（坐标不公开，故标 synthetic）。

因此产品的正确定位不是"把模型算准"，而是"**接入观测、做空间外推与时间外推**"。
本件检验这条路是否成立：

    留一法：拿 16 个点的观测，用反距离加权（IDW）插值出第 17 个点，
    与"模型在该点的输出"比较 MAE。

若 IDW 优于模型，则"接观测"是正确的产品方向——即使点很稀疏。
若模型优于 IDW，则说明 17 个点太稀疏，插值无意义，必须靠模型/更多点。

用法：python -m typhoeus.assimilation
"""

from __future__ import annotations

import argparse
import csv
import json
from datetime import datetime
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SEED = ROOT / "data" / "seed"
OUT = ROOT / "out"

LON_MIN, LON_MAX = 121.550139, 121.699583
LAT_MIN, LAT_MAX = 29.840417, 29.919861
IDW_POWERS = [1.0, 2.0, 3.0]
IDW_RADII_KM = [None, 5.0, 10.0]


def _load(p: Path) -> list[dict]:
    with open(p, encoding="utf-8-sig") as f:
        return [{k.lstrip("\ufeff"): v for k, v in r.items()} for r in csv.DictReader(f)]


def _haversine_km(lon1, lat1, lon2, lat2):
    r = 6371.0
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dp = p2 - p1
    dl = np.radians(lon2 - lon1)
    a = np.sin(dp / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * r * np.arcsin(np.sqrt(a))


def idw(lon: np.ndarray, lat: np.ndarray, val: np.ndarray,
        x: float, y: float, power: float, radius_km: float | None) -> float:
    d = _haversine_km(x, y, lon, lat)
    m = d > 1e-9
    if radius_km is not None:
        m &= d <= radius_km
    if not m.any():
        return float(np.mean(val))
    w = 1.0 / np.power(d[m], power)
    return float((w * val[m]).sum() / w.sum())


def build(outdir: str = "out", verbose: bool = True) -> dict:
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
    peak = np.asarray(K.run(inp.grid, rain, CLI._kernel_params(cfg)).depth).max(axis=0)
    lon_g, lat_g = np.asarray(inp.grid.lon), np.asarray(inp.grid.lat)

    pts = []
    for r in _load(SEED / "flood_points_2021_infa.csv"):
        try:
            x, y, obs = float(r["lon"]), float(r["lat"]), float(r["depth_m"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (LON_MIN <= x <= LON_MAX and LAT_MIN <= y <= LAT_MAX):
            continue
        i = int(np.abs(lat_g - y).argmin())
        j = int(np.abs(lon_g - x).argmin())
        pts.append({"编号": r["point_id"], "名称": r["name"],
                    "lon": x, "lat": y, "obs": obs, "model": float(peak[i, j])})

    n = len(pts)
    lon = np.array([p["lon"] for p in pts])
    lat = np.array([p["lat"] for p in pts])
    obs = np.array([p["obs"] for p in pts])
    mod = np.array([p["model"] for p in pts])
    # IDW 用对数深度插值更合理（深度跨一个量级）
    obs_log = np.log10(obs + 1e-3)

    # 模型基线
    mae_model = float(np.abs(mod - obs).mean())
    rmse_model = float(np.sqrt(((mod - obs) ** 2).mean()))

    # 关键对照：留一均值基线（不含任何空间信息）
    # 若它能与 IDW 打平或更好，则 IDW 的优势来自"观测水平"而非"空间插值技能"。
    preds_mean = []
    for k in range(n):
        m = np.ones(n, bool)
        m[k] = False
        preds_mean.append(float(obs[m].mean()))
    preds_mean = np.array(preds_mean)
    mae_mean = float(np.abs(preds_mean - obs).mean())
    rmse_mean = float(np.sqrt(((preds_mean - obs) ** 2).mean()))
    mae_const = float(np.abs(obs.mean() - obs).mean())   # 全域常数（无留一）

    results = []
    for power in IDW_POWERS:
        for radius in IDW_RADII_KM:
            preds = []
            for k in range(n):
                m = np.ones(n, bool)
                m[k] = False
                v = idw(lon[m], lat[m], obs_log[m], lon[k], lat[k], power, radius)
                preds.append(10 ** v - 1e-3)
            preds = np.clip(np.array(preds), 0.0, None)
            mae = float(np.abs(preds - obs).mean())
            rmse = float(np.sqrt(((preds - obs) ** 2).mean()))
            results.append({
                "IDW幂": power,
                "半径_km": radius if radius else "无",
                "MAE_m": round(mae, 4),
                "RMSE_m": round(rmse, 4),
                "相对模型MAE": round(mae / mae_model, 3) if mae_model else None,
                "优于模型": bool(mae < mae_model),
            })

    best = min(results, key=lambda x: x["MAE_m"])
    # 判定必须与"留一均值基线"比，而不是只与模型比
    beats_model = best["MAE_m"] < mae_model
    beats_mean = best["MAE_m"] < mae_mean
    spatial_skill = bool(beats_mean)

    payload = {
        "名称": "观测同化可行性：IDW 插值 vs 模型 vs 留一均值",
        "生成时间": datetime.now().isoformat(timespec="seconds"),
        "问题": "用观测插值外推到未观测点，能否优于模型？优势来自哪里？",
        "方法": {
            "验证": "留一法（LOOCV）：用其余 16 点插值被留出的 1 点",
            "插值对象": "log10(水深+0.001)，避免深度跨量级时被大值主导",
            "模型基线": "内核峰值水深（与主链同源）",
            "关键对照": "留一均值（其余 16 点算术平均，不含任何空间信息）——"
                        "若 IDW 赢不了它，则插值的优势来自观测『水平』而非『空间结构』",
        },
        "样本": {"点数": n},
        "三个基线": {
            "模型": {"MAE_m": round(mae_model, 4), "RMSE_m": round(rmse_model, 4)},
            "留一均值（无空间信息）": {"MAE_m": round(mae_mean, 4),
                                  "RMSE_m": round(rmse_mean, 4)},
            "全域常数": {"MAE_m": round(mae_const, 4)},
            "最优IDW": {"MAE_m": best["MAE_m"], "RMSE_m": best["RMSE_m"],
                       "配置": {"幂": best["IDW幂"], "半径": best["半径_km"]}},
        },
        "IDW各配置": results,
        "最优配置": best,
        "判定": {
            "优于模型": bool(beats_model),
            "优于留一均值": bool(beats_mean),
            "存在空间插值技能": spatial_skill,
        },
        "含义": (
            "IDW 同时优于模型与留一均值 → **存在空间插值技能**，"
            "接观测能同时改善水平与空间格局。"
            if (beats_model and spatial_skill) else
            ("IDW 优于模型但不优于留一均值 → **优势来自观测的『水平』而非『空间结构』**。"
             "即：接观测能校正系统的整体偏低（17/17 偏浅），"
             "但不能改善空间格局——17 个点太稀，撑不起空间插值。"
             "接入 149 点后空间技能可能出现，但本件无法证明。"
             if beats_model else
             "IDW 连模型都不如 → 观测太稀，插值不可用。")
        ),
        "边界": [
            "n=17，且观测水深来自不同时刻、不同来源的通报，本身不是同一次观测场。",
            "留一法在极稀疏点上会低估插值能力（邻居距离过大）。",
            "模型与 IDW 比较的是『谁更接近通报值』，不是『谁更接近真实水深』。",
            "149 点约为此处 17 点的 8.6 倍密度，本结论不能直接外推到 149 点。",
        ],
        "逐点": [{"编号": p["编号"], "观测_m": p["obs"],
                  "模型_m": round(p["model"], 4)} for p in pts],
    }
    p = Path(outdir)
    p.mkdir(parents=True, exist_ok=True)
    (p / "p26_观测同化可行性.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    if verbose:
        print(f"  n={n}  模型 MAE {mae_model:.4f} m  RMSE {rmse_model:.4f} m")
        print(f"  {'幂':>4} {'半径':>8} {'MAE':>8} {'RMSE':>8} {'相对模型':>8}")
        for r in results:
            print(f"  {r['IDW幂']:>4} {str(r['半径_km']):>8} {r['MAE_m']:>8.4f} "
                  f"{r['RMSE_m']:>8.4f} {r['相对模型MAE']:>8.3f}")
        print(f"  最优：幂 {best['IDW幂']} 半径 {best['半径_km']} → MAE {best['MAE_m']}")
        print(f"  判定：{payload['判定']}")
        print(f"→ {p / 'p26_观测同化可行性.json'}")
    return payload


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="typhoeus.assimilation")
    ap.add_argument("outdir", nargs="?", default="out")
    a = ap.parse_args(argv)
    build(a.outdir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
