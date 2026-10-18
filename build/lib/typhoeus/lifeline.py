"""p13 生命线断供预判。

问题：模型能否在真实断供通报之前，从水深时序上预判"这条生命线要断"？

做法：
  1) 跑一次内核，取每个关注位置的**水深时序** h(t)
  2) 按生命线类别套用**失效阈值**（有国标引用，无国标者标为工程假设）
  3) 求"首次越阈时刻"，与真实通报时刻比较，得提前量
  4) 域外位置与聚合口径（如"全市累计 594 台电梯"）**必须单列**，不参与统计

诚实边界：
  - 域内可逐点核对的断供事件只有 **1 条**（长岛花园），另一个是区级聚合；
    其余 8 条在海曙/镇海/奉化，在本计算域之外。
  - 阈值中"电梯井道进水 10 cm""配电房 30 cm"是工程经验值，无国标，
    已在输出中逐条标注 basis。
  - 17 个涝点不是"断供事件"，只用来回答"若它有生命线，模型何时会判它失效"。

用法：
  python -m typhoeus.lifeline            # 生成 p13
  python -m typhoeus.lifeline --json
"""

from __future__ import annotations

import argparse
import csv
import json
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SEED = ROOT / "data" / "seed"
OUT = ROOT / "out"

# 时间轴：与降雨驱动缓存一致
ANCHOR = "2021-07-25T06:00"
DT_S = 600.0

# 生命线失效阈值（含依据；无国标者为工程假设，必须标注）
THRESHOLDS = {
    "道路封道": {
        "m": 0.15,
        "basis": "GB 51222-2017《城镇内涝防治技术规范》：道路中一条车行道积水深度不超过 15 cm",
    },
    "下穿立交封道": {
        "m": 0.27,
        "basis": "各地防汛预案通用值：下穿立交积水约 27 cm 即封闭",
    },
    "电梯停梯": {
        "m": 0.10,
        "basis": "工程假设：井道/底坑进水约 10 cm 即须停梯（无国标，按电梯维护惯例）",
    },
    "配电停供": {
        "m": 0.30,
        "basis": "工程假设：配电房/环网柜进水 30 cm 量级（公开案例区间 30–50 cm）",
    },
    "人员转移": {
        "m": 0.30,
        "basis": "工程假设：住宅底层进水 30 cm 量级触发转移（无统一国标）",
    },
    "强排作业": {
        "m": 0.20,
        "basis": "工程假设：积水 20 cm 量级需要泵车/移动泵分片强排",
    },
}

# 无法逐点核对的口径
AGGREGATE_KEYS = ("全市累计", "部分小区", "主要道路", "等积水道路")


def _load_csv(p: Path) -> list[dict]:
    with open(p, encoding="utf-8-sig") as f:
        return [{k.lstrip("\ufeff"): v for k, v in r.items()} for r in csv.DictReader(f)]


def _grid_lookup(lon: np.ndarray, lat: np.ndarray, x: float, y: float) -> tuple[int, int]:
    i = int(np.abs(lat - y).argmin())
    j = int(np.abs(lon - x).argmin())
    return i, j


def _inside(lon: np.ndarray, lat: np.ndarray, x: float, y: float) -> bool:
    return bool(lon.min() <= x <= lon.max() and lat.min() <= y <= lat.max())


def _first_cross(ts: np.ndarray, thr: float) -> int | None:
    """首次 h >= thr 的时刻索引；永不越阈返回 None。"""
    hit = np.where(ts >= thr)[0]
    return int(hit[0]) if hit.size else None


def run(outdir: str = "out", verbose: bool = True) -> dict:
    from typhoeus import cli as CLI
    from typhoeus import config as CFG
    from typhoeus import data as D
    from typhoeus import kernel as K
    from typhoeus import observe as OB
    from typhoeus import rainsrc as RS

    cfg = CFG.Config()
    inp = D.load_all(cfg.l2.bbox, cfg.l4.resample)
    g = inp.grid
    lon, lat = np.asarray(g.lon), np.asarray(g.lat)

    rain, _ = RS.get_rainfall(g, stations=OB.load_rain_stations(),
                              use_cache=True, calibrate=cfg.l2.rain_calibrate,
                              verbose=False)
    res = K.run(g, rain, CLI._kernel_params(cfg))
    depth = np.asarray(res.depth)                      # (T, ny, nx)
    nt = depth.shape[0]
    t0 = datetime.fromisoformat(ANCHOR)
    step_h = DT_S / 3600.0

    def times(ts_idx: int) -> str:
        return (t0 + timedelta(hours=ts_idx * step_h)).strftime("%Y-%m-%d %H:%M")

    # ---------- Part A：断供事件 ----------
    outages = _load_csv(SEED / "service_outages_2021_infa.csv")
    rows_a = []
    for r in outages:
        rec = {
            "编号": r["outage_id"], "类别": r["category"], "对象": r["target"],
            "来源": r["source"],
        }
        try:
            x, y = float(r["lon"]), float(r["lat"])
            rec["坐标"] = [x, y]
        except (TypeError, ValueError):
            rec.update({"三态": "BLOCKED", "原因": "无坐标"})
            rows_a.append(rec)
            continue

        agg = any(k in r["target"] for k in AGGREGATE_KEYS)
        inside = _inside(lon, lat, x, y)
        rec["域内"] = inside
        rec["聚合口径"] = agg

        th = THRESHOLDS.get(r["category"])
        if th is None:
            rec.update({"三态": "BLOCKED", "原因": f"类别 {r['category']} 无阈值定义"})
            rows_a.append(rec)
            continue
        rec["阈值_m"] = th["m"]

        if not inside:
            rec.update({"三态": "BLOCKED",
                        "原因": "位置在计算域外（域 121.550–121.700°E / 29.840–29.920°N）"})
            rows_a.append(rec)
            continue

        i, j = _grid_lookup(lon, lat, x, y)
        ts = depth[:, i, j]
        rec["模型峰值_m"] = round(float(ts.max()), 4)
        rec["模型越阈时刻"] = times(_first_cross(ts, th["m"])) if _first_cross(ts, th["m"]) is not None else None

        if agg:
            rec.update({"三态": "BLOCKED",
                        "原因": "聚合口径（跨区/全市），不可逐点核对，坐标仅近似质心"})
            rows_a.append(rec)
            continue

        reported = datetime.strptime(r["start_at"], "%Y-%m-%d %H:%M")
        idx = _first_cross(ts, th["m"])
        if idx is None:
            rec.update({"三态": "FAIL", "原因": "模型全域未越阈（水深不足以判失效）"})
        else:
            cross = t0 + timedelta(hours=idx * step_h)
            lead = (reported - cross).total_seconds() / 3600.0
            rec["真实通报"] = reported.strftime("%Y-%m-%d %H:%M")
            rec["提前量_h"] = round(lead, 2)
            rec["三态"] = "PASS" if lead > 0 else "FAIL"
            rec["原因"] = ("模型早于通报" if lead > 0 else "模型晚于通报")
        rows_a.append(rec)

    # ---------- Part B：涝点的阈越时刻 ----------
    fps = _load_csv(SEED / "flood_points_2021_infa.csv")
    rows_b = []
    for r in fps:
        try:
            x, y = float(r["lon"]), float(r["lat"])
        except (KeyError, TypeError, ValueError):
            continue
        if not _inside(lon, lat, x, y):
            continue
        i, j = _grid_lookup(lon, lat, x, y)
        ts = depth[:, i, j]
        peak = float(ts.max())
        obs = float(r["depth_m"]) if r["depth_m"] else float("nan")
        # 结构类型决定用哪个阈值
        key = "下穿立交封道" if r.get("structure_type") == "下穿立交" else "道路封道"
        thr = THRESHOLDS[key]["m"]
        idx = _first_cross(ts, thr)
        rows_b.append({
            "编号": r["point_id"], "名称": r["name"],
            "结构": r.get("structure_type", ""),
            "观测水深_m": obs, "模型峰值_m": round(peak, 4),
            "判据": key, "阈值_m": thr,
            "模型越阈时刻": times(idx) if idx is not None else None,
            "观测时刻": r.get("observed_at", ""),
            "观测是否越阈": bool(obs >= thr) if np.isfinite(obs) else None,
        })

    # ---------- 汇总 ----------
    comparable = [r for r in rows_a if r.get("三态") in ("PASS", "FAIL")]
    pass_n = sum(1 for r in comparable if r["三态"] == "PASS")
    leads = [r["提前量_h"] for r in comparable if "提前量_h" in r]
    b_cross = sum(1 for r in rows_b if r["模型越阈时刻"])
    b_obs_cross = sum(1 for r in rows_b if r["观测是否越阈"])

    payload = {
        "名称": "生命线断供预判",
        "生成时间": datetime.now().isoformat(timespec="seconds"),
        "时间轴": {"起点": ANCHOR, "步长_min": DT_S / 60, "时次数": int(nt)},
        "问题": "模型能否在真实断供通报之前，从水深时序上预判生命线失效？",
        "断供事件": {
            "总数": len(rows_a),
            "可逐点核对": len(comparable),
            "通过": pass_n,
            "三态": ("PASS" if comparable and pass_n == len(comparable)
                     else ("FAIL" if comparable and pass_n == 0 else
                           ("PARTIAL" if comparable else "BLOCKED"))),
            "提前量_h": {"最小": min(leads) if leads else None,
                       "中位": round(float(np.median(leads)), 2) if leads else None,
                       "最大": max(leads) if leads else None},
            "明细": rows_a,
        },
        "涝点阈越": {
            "域内涝点数": len(rows_b),
            "模型越阈数": b_cross,
            "观测越阈数": b_obs_cross,
            "明细": rows_b,
        },
        "阈值依据": {k: v for k, v in THRESHOLDS.items()},
        "边界": [
            "可逐点核对的断供事件只有 1 条，样本量不足以做统计推断，仅作一致性示例。",
            "8 条断供记录在海曙/镇海/奉化，落在计算域外——这是域覆盖问题，不是模型问题。",
            "2 条为聚合口径（全市累计 594 台电梯、江北鄞州奉化部分小区），不可逐点核对。",
            "电梯/配电/人员转移/强排的阈值为工程假设，无国标；只有道路 15 cm 有 GB 51222-2017 依据。",
            "涝点不是断供事件，其阈越时刻只回答「若该点有生命线，模型何时判它失效」。",
        ],
    }
    p = Path(outdir)
    p.mkdir(parents=True, exist_ok=True)
    (p / "p13_生命线断供预判.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    if verbose:
        print(f"  断供事件 {len(rows_a)} 条：可逐点核对 {len(comparable)}，"
              f"通过 {pass_n}，三态 {payload['断供事件']['三态']}")
        for r in comparable:
            print(f"    {r['编号']} {r['类别']} {r['对象'][:14]}  "
                  f"阈值 {r['阈值_m']} 模型峰值 {r['模型峰值_m']}  "
                  f"提前量 {r.get('提前量_h')} h")
        print(f"  域内涝点 {len(rows_b)} 个，模型越阈 {b_cross} 个，观测越阈 {b_obs_cross} 个")
        print(f"→ {p / 'p13_生命线断供预判.json'}")
    return payload


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="typhoeus.lifeline")
    ap.add_argument("outdir", nargs="?", default="out")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    payload = run(a.outdir, verbose=not a.json)
    if a.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
