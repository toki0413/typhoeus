"""提比翁 Demo —— L0 观察同化层。

对应文档 6.1 的"影像反演写回 μ_t 与 T_θ"与第八节门槛 1/2/3/5。

本模块把 `data/seed/` 下的种子数据读成可核验的比对结果。
三条硬约束：

1. **provenance 必检**。每条记录带 `provenance` 字段，标 `synthetic` 的
   一律不参与门槛判定，只能做接口连通性验证。拿合成数据当实测报 PASS，
   是这个模块存在的意义最容易被绕过的地方。
2. **坐标精度必声明**。涝点台账的坐标是地名定位近似（±100 m），
   门槛 1 的验收线是 1 个边长（54 m），因此该门槛在当前坐标精度下
   **不可能 PASS**，只能报出位移量供后续换真实坐标后复算。
3. **覆盖域过滤**。台账里含计算域外的点（象山、余姚），必须在同一
   bbox 下比对，否则覆盖率虚高。
"""
from __future__ import annotations

import csv
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from . import projection as PRJ

SEED_DIR = Path(__file__).resolve().parent.parent / "data" / "seed"

SYNTHETIC = "synthetic"


@dataclass
class FloodPoint:
    point_id: str
    name: str
    district: str
    lon: float
    lat: float
    depth_m: float
    observed_at: str
    structure_type: str
    provenance: str

    @property
    def is_synthetic(self) -> bool:
        return self.provenance.startswith(SYNTHETIC)


def load_flood_points() -> list[FloodPoint]:
    """读历史涝点台账。读不到时返回空列表，门槛判定退 BLOCKED。"""
    p = SEED_DIR / "flood_points_2021_infa.csv"
    if not p.exists():
        return []
    out: list[FloodPoint] = []
    with open(p, encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            try:
                out.append(FloodPoint(
                    point_id=r["point_id"], name=r["name"],
                    district=r["district"],
                    lon=float(r["lon"]), lat=float(r["lat"]),
                    depth_m=float(r["depth_m"]),
                    observed_at=r["observed_at"],
                    structure_type=r["structure_type"],
                    provenance=r["provenance"]))
            except (KeyError, ValueError):
                continue
    return out


def load_monitor_sites() -> dict:
    """读 149 个监测点的占位数据。返回 spec 与 sites。"""
    p = SEED_DIR / "monitor_sites_synthetic.json"
    if not p.exists():
        return {"spec": None, "sites": []}
    return json.loads(p.read_text(encoding="utf-8"))


def load_service_outages() -> list[dict]:
    p = SEED_DIR / "service_outages_2021_infa.csv"
    if not p.exists():
        return []
    with open(p, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def load_rain_stations() -> list[dict]:
    p = SEED_DIR / "rain_stations_2021_infa.csv"
    if not p.exists():
        return []
    with open(p, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


# ---------- 门槛 2：涝点覆盖率 ----------

def coverage(risk: np.ndarray, pts: list[FloodPoint], grid,
             bbox: dict | None = None,
             res_depth: np.ndarray | None = None) -> dict:
    """推前风险场前 20% 分位区对实测涝点的覆盖率。

    risk: (ny, nx) 归一化风险场（峰值水深归一化）
    res_depth: (nt, ny, nx) 水深时序，用于给落选点位附上模型水深，
              区分"模型判错了"与"模型在该点根本没积水"。
    返回命中率、落选点位明细（含模型水深）、被排除的点。

    与旧实现的两点差别：
    - 按 bbox 过滤掉计算域外的点（旧实现把象山、余姚的点也算进来）
    - 只用非合成来源的点（当前台账全部为实测通报，此过滤为将来合成点
      混入时预留）
    """
    if not pts:
        return {"rate": None, "n_total": 0, "n_hit": 0,
                "excluded": [], "reason": "无涝点台账"}

    if bbox:
        inside = [q for q in pts
                  if bbox["lon_min"] <= q.lon <= bbox["lon_max"]
                  and bbox["lat_min"] <= q.lat <= bbox["lat_max"]]
        excluded = [q.point_id for q in pts if q not in inside]
    else:
        inside, excluded = list(pts), []

    inside = [q for q in inside if not q.is_synthetic]
    if not inside:
        return {"rate": None, "n_total": 0, "n_hit": 0,
                "excluded": excluded,
                "reason": "域内涝点全部为合成来源，不参与判定"}

    peak = (np.asarray(res_depth).max(axis=0)
            if res_depth is not None else np.zeros_like(risk))
    thr = np.quantile(risk, 0.80)
    mask = risk >= thr
    hit, miss = 0, []
    for q in inside:
        j = int(np.argmin(np.abs(grid.lon - q.lon)))
        i = int(np.argmin(np.abs(grid.lat - q.lat)))
        if mask[i, j]:
            hit += 1
        else:
            miss.append({"point_id": q.point_id, "name": q.name,
                         "depth_m": q.depth_m,
                         "model_depth_m": round(float(peak[i, j]), 3),
                         "structure_type": q.structure_type})
    return {
        "rate": hit / len(inside),
        "n_total": len(inside),
        "n_hit": hit,
        "excluded": excluded,
        "missed": miss,
        "risk_threshold": float(thr),
    }


# ---------- 门槛 1：锋面位置 ----------

def front_offset(res_depth: np.ndarray, pts: list[FloodPoint], grid,
                 bbox: dict | None = None) -> dict:
    """锋面位置偏差：实测涝点落在计算水深场的哪一档。

    返回每个涝点对应的模型水深、反算的模型最大水深、以及两者的差。
    与"平均位移"的区别：公开台账只有积水深度、没有水锋面时刻，
    因此无法直接算位移，只能做水深档位对照。
    """
    if not pts or res_depth.size == 0:
        return {"n": 0, "mean_abs_diff_m": None, "items": []}

    peak = res_depth.max(axis=0)
    items = []
    for q in pts:
        if bbox and not (bbox["lon_min"] <= q.lon <= bbox["lon_max"]
                         and bbox["lat_min"] <= q.lat <= bbox["lat_max"]):
            continue
        j = int(np.argmin(np.abs(grid.lon - q.lon)))
        i = int(np.argmin(np.abs(grid.lat - q.lat)))
        model = float(peak[i, j])
        items.append({
            "point_id": q.point_id, "name": q.name,
            "obs_depth_m": q.depth_m, "model_depth_m": round(model, 3),
            "abs_diff_m": round(abs(model - q.depth_m), 3),
            "structure_type": q.structure_type,
        })
    if not items:
        return {"n": 0, "mean_abs_diff_m": None, "items": []}
    mae = float(np.mean([x["abs_diff_m"] for x in items]))
    return {
        "n": len(items),
        "mean_abs_diff_m": round(mae, 3),
        "max_abs_diff_m": round(max(x["abs_diff_m"] for x in items), 3),
        "items": items,
    }


# ---------- 门槛 5：结构死穴 ----------

def dead_spot(res_depth: np.ndarray, outages: list[dict], grid,
              top_frac: float = 0.10,
              bbox: dict | None = None) -> dict:
    """结构死穴重合率：模型损失前 10% 的像元里有多少含已报中断点。

    中断点来自公开通报的电梯停梯、停电、封道记录。
    只统计有量化影响量的记录（594 台电梯这类总量型通报不做点定位）。
    """
    pts = load_flood_points()
    if not outages or not pts:
        return {"rate": None, "n_top": 0, "n_hit": 0,
                "reason": "缺中断台账或涝点台账"}

    by_name = {q.name: q for q in pts}
    loss = res_depth.max(axis=0)
    thr = np.quantile(loss, 1.0 - top_frac)
    mask = loss >= thr

    hit, n_loc, miss = 0, 0, []
    for r in outages:
        lo, la = r.get("lon"), r.get("lat")
        if not lo or not la:
            continue
        lo, la = float(lo), float(la)
        if bbox and not (bbox["lon_min"] <= lo <= bbox["lon_max"]
                         and bbox["lat_min"] <= la <= bbox["lat_max"]):
            continue
        n_loc += 1
        j = int(np.argmin(np.abs(grid.lon - lo)))
        i = int(np.argmin(np.abs(grid.lat - la)))
        if mask[i, j]:
            hit += 1
        else:
            miss.append({"target": r["target"], "category": r["category"],
                         "magnitude": r.get("magnitude")})
    if n_loc == 0:
        return {"rate": None, "n_top": 0, "n_hit": 0,
                "reason": "中断台账无带坐标的记录"}
    return {
        "rate": hit / n_loc,
        "n_top": n_loc,
        "n_hit": hit,
        "loss_threshold": float(thr),
        "missed": miss,
        "matched_names": sorted(by_name)[:0],   # 预留：地名到坐标的映射
    }


# ---------- 门槛 9：气候标度可标定性 ----------

def cc_identifiability(stations: list[dict], events: int = 1) -> dict:
    """气候标度能否标定：需要多事件 + 多年份锚点。

    当前只有 2021 一场事件，气候标度 CC 无法与事件强度解耦——
    单场里 CC 与雨区移动、抽排能力、暴露度完全共线。
    """
    n = len(stations)
    return {
        "identifiable": bool(events >= 15 and n >= 5),
        "n_events": events,
        "n_station_anchors": n,
        "required_events": 15,
        "reason": ("单场事件里 CC 与雨区移动、抽排能力、暴露度共线，"
                   "标不出 CC；需 ≥15 场跨年份事件序列"),
    }


# ---------- 门槛 14：涝点水深命中率 ----------

def depth_accuracy(res_depth: np.ndarray, pts: list[FloodPoint], grid,
                   bbox: dict | None = None) -> dict:
    """模型水深与实测水深的定量精度对照。

    与 `coverage()` 的分工：coverage 判的是**空间排序能力**（实测涝点是否
    落在模型风险场的高分区），depth_accuracy 判的是**定量精度**（水深差多少）。
    两者可以一个 PASS 一个 FAIL——排序对而深度错是常见情形，合并会掩盖它。

    命中率口径：模型水深与实测水深落在同一积水分级即算命中。
    分级用 `projection.DEPTH_LEVELS`（0.1/0.2/0.5 m，对齐宁波官方四色分级），
    不用绝对误差阈值——0.15 m 这样的线会随结构类型变化（下穿立交 0.3 m
    已属严重，低洼路段 0.3 m 才刚到橙色），分级口径对不同结构更公平。

    分母是**域内非合成点数**，口径必须显式声明：台账共28 条，
    域内 17 条，余11 条在计算域外（象山、余姚），把域外点计入分母
    会让命中率的分母虚高且分子恒为 0。
    """
    if not pts:
        return {"n": 0, "reason": "无涝点台账"}

    if bbox:
        inside = [q for q in pts
                  if bbox["lon_min"] <= q.lon <= bbox["lon_max"]
                  and bbox["lat_min"] <= q.lat <= bbox["lat_max"]]
    else:
        inside = list(pts)
    inside = [q for q in inside if not q.is_synthetic]

    if not inside:
        return {"n": 0, "reason": "域内涝点全部为合成来源，不参与判定"}

    # 宁波官方四色分级边界，末级为开区间
    levels = PRJ.DEPTH_LEVELS  # (0.10, 0.20, 0.50)

    def level_of(x: float) -> int:
        for i, lv in enumerate(levels):
            if x < lv:
                return i
        return len(levels)

    peak = np.asarray(res_depth).max(axis=0)
    items, n_same, abs_diffs = [], 0, []
    by_type: dict[str, dict] = {}
    for q in inside:
        j = int(np.argmin(np.abs(grid.lon - q.lon)))
        i = int(np.argmin(np.abs(grid.lat - q.lat)))
        model = float(peak[i, j])
        diff = abs(model - q.depth_m)
        lo, ho = level_of(q.depth_m), level_of(model)
        same = (lo == ho)
        n_same += int(same)
        abs_diffs.append(diff)
        items.append({
            "point_id": q.point_id, "name": q.name,
            "structure_type": q.structure_type,
            "obs_depth_m": q.depth_m, "model_depth_m": round(model, 3),
            "abs_diff_m": round(diff, 3),
            "obs_level": PRJ.LEVEL_NAMES[lo], "model_level": PRJ.LEVEL_NAMES[ho],
            "same_level": same,
        })
        t = by_type.setdefault(q.structure_type, {"n": 0, "n_same": 0,
                                                  "sum_abs": 0.0})
        t["n"] += 1
        t["n_same"] += int(same)
        t["sum_abs"] += diff

    type_txt = "、".join(
        f"{k} {v['n_same']}/{v['n']}"
        for k, v in sorted(by_type.items(), key=lambda kv: -kv[1]["n"]))
    return {
        "n": len(items),
        "n_same_level": n_same,
        "rate": round(n_same / len(items), 4),
        "mae_m": round(float(np.mean(abs_diffs)), 3),
        "max_abs_diff_m": round(float(max(abs_diffs)), 3),
        "by_type": type_txt,
        "by_type_detail": {k: {"n": v["n"], "n_same": v["n_same"],
                               "hit_rate": round(v["n_same"] / v["n"], 4)}
                           for k, v in by_type.items()},
        "items": items,
        "criterion": "同积水分级（0.1/0.2/0.5 m）即算命中，分母为域内非合成点数",
    }


# ---------- 门槛 15：降雨总量相对误差 ----------

# 2021 烟花宁波市气象局评估的全市面雨量（mm）。
# 来源：宁波市气候公报与台风"烟花"气象灾害评估报告，2021-07-28。
OBS_EVENT_RAIN_MM = 375.0


def rain_check(model_rain_mm: float, stations: list[dict],
               bbox: dict | None = None, grid=None,
               calibrated: bool = False) -> dict:
    """模型面雨量对实测面雨量的相对误差。

    这条是**输入层**校验。此前全部门槛都在查末端（涝点命中、功能曲线）
    或查内部一致性（守恒、分解闭合），没有任何一条查输入本身——
    而所有输出物的准确性都继承输入的准确性。

    观测侧口径的取舍：**优先取域内站的算术均值，退回全市官方面雨量**。

    域内判定给 `grid` 时用 `grid.lon/lat` 的实际范围，否则退回 `bbox`。
    两者不是同一件事：`bbox` 是配置里的请求框（121.55-121.70 /
    29.84-29.92），`grid.lon/lat` 是 DEM 重采样后格网的真实覆盖
    （121.550139-121.699583）。海曙站 lon=121.55 落在请求框内但在格网
    范围外——它测的点在计算域外，插值权重没有定义。`rainsrc.calibrate`
    按格网范围取订正锚点，这里若按请求框取，校验用的站和订正用的站
    就不是同一批，偏差数字失去意义。调用方应传 `grid`。

    采样偏倚（当前 8 站里 2 站在计算域内，经度几乎相同、仅0.01° 之差，
    都不覆盖北部余姚这个暴雨中心，官方面雨量 475 mm）：用域内站均值
    作锚点会系统性低估观测侧，使模型相对偏差看起来比实际小。两个口径
    都写进返回值（`rel_err` 与 `rel_err_allcity`），偏倚方向在
    `sampling_bias` 里点明。

    `calibrated=True` 表示模型面雨量已经用这些域内站做过分位数订正。
    此时 `rel_err` 是**自样本**数字：订正把模型分布映射到观测分布上，
    再拿同一批站去比，得到的偏差在构造上就接近零，不构成对模型的
    独立检验。域内站只剩1 个时更没有留出集可用。判据因此落到
    `rel_err_allcity`（官方面雨量，与订正锚点不同源），并在
    `verdict_basis` 里写明用的是哪个口径。数字都留着，读的人自己
    判断该信哪个。
    """
    inside, outside = [], []
    for r in stations:
        try:
            lon, lat = float(r["lon"]), float(r["lat"])
            mm = float(r["accum_mm"])
        except (KeyError, TypeError, ValueError):
            continue
        rec = (r.get("station", "?"), mm)
        if grid is not None:
            ok = (float(grid.lon.min()) <= lon <= float(grid.lon.max())
                  and float(grid.lat.min()) <= lat <= float(grid.lat.max()))
        elif bbox:
            ok = (bbox["lon_min"] <= lon <= bbox["lon_max"]
                  and bbox["lat_min"] <= lat <= bbox["lat_max"])
        else:
            ok = True
        (inside if ok else outside).append(rec)

    n_in = len(inside)
    if n_in:
        obs_mm = sum(mm for _, mm in inside) / n_in
        basis = f"域内实测站算术均值（{n_in} 站：" + "、".join(
            f"{s} {mm:.0f}" for s, mm in inside) + "）"
    else:
        obs_mm = OBS_EVENT_RAIN_MM
        basis = "宁波市气象局 2021 烟花评估全市面雨量（域内站为空时回退）"

    rel = (model_rain_mm - obs_mm) / obs_mm if obs_mm else 0.0
    rel_all = ((model_rain_mm - OBS_EVENT_RAIN_MM) / OBS_EVENT_RAIN_MM
               if OBS_EVENT_RAIN_MM else 0.0)
    in_sample = bool(calibrated and n_in)
    if in_sample:
        basis_verdict = ("官方全市面雨量（与订正锚点不同源）")
        rel_verdict = rel_all
    else:
        basis_verdict = ("域内实测站算术均值" if n_in else "官方全市面雨量")
        rel_verdict = rel if n_in else rel_all
    return {
        "model_mm": round(float(model_rain_mm), 1),
        "obs_mm": round(float(obs_mm), 1),
        "rel_err": round(float(rel), 4),
        "rel_err_allcity": round(float(rel_all), 4),
        "obs_basis": basis,
        "domain_basis": ("grid.lon/lat 实际范围" if grid is not None
                         else("config.l2.bbox 请求框" if bbox else "未过滤（全站）")),
        "in_sample": in_sample,
        "verdict_basis": basis_verdict,
        "rel_err_verdict": round(float(rel_verdict), 4),
        "n_stations": n_in,
        "n_stations_total": len(inside) + len(outside),
        "n_outside": len(outside),
        "allcity_mm": OBS_EVENT_RAIN_MM,
        "sampling_bias": (
            f"域内仅 {n_in} 站且集中于南部，均值不含北部暴雨中心余姚"
            f"（官方 475 mm），观测侧偏低，故 rel_err 偏乐观；"
            f"对全市口径的偏差为 {rel_all*100:+.0f}%"
        ) if n_in else "无采样偏倚（用全市口径）",
        "criterion": "≤15%",
    }
