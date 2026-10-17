"""梅花 2022 全链深挖驱动器。

复用烟花主链的纯函数（内核/投影/对账/测度/降雨源），不改任何既有模块
的默认行为。产物落 `out_muifa/`，与 `out/`（烟花）同构、可逐列对比。

双口径：
  parameterized —— K.rainfall_field 由 IBTrACS 路径合成（与 18 场批量同口径）
  era5           —— RS.get_rainfall(cache_name="era5_muifa2022")，
                    窗 2022-09-13..09-17、锚 2022-09-14T12:00（路径最近点）

诚实边界（写死在每个产物里）：
  - 梅花无 28 点级实测台账（通报为镇级/村级精度），点级对照大面积域外；
  - 全域读数可主张"链条跑通"，不主张"精度迁移"。

用法：
  python tools/muifa_deep_dive.py attribution   # m17
  python tools/muifa_deep_dive.py decisions     # m19-m20 情景翻转带
  python tools/muifa_deep_dive.py inverse       # m21-m22 反解门槛
  python tools/muifa_deep_dive.py card          # m32 规划决策卡
  python tools/muifa_deep_dive.py all
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from datetime import datetime
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

SEED = ROOT / "data" / "seed"
OUT = ROOT / "out_muifa"

# 与 attribution.py 同一组域界（grid 实际范围，非请求框）
LON_MIN, LON_MAX = 121.550139, 121.699583
LAT_MIN, LAT_MAX = 29.840417, 29.919861

COEFF_REAL = 1.2e-3
COEFF_IDEAL = 1.2e-2
COEFF_NONE = 0.0

SCENARIO_MULT = [0.75, 1.0, 1.5, 2.0]

# 候选致灾阈值（GB 51222-2017 内涝防治设计重现期对应的积水深度判据，
# 与 p19-p20 同口径引用；梅花版只做"阈值是否落入翻转带"的判定）
GB51222_CM = 0.15

BOUNDS = [
    "梅花无 28 点级实测台账：通报点位为镇级/村级精度（±1000–2000 m），"
    "且多数在计算域（鄞东南 15×9 km）之外；点级读数只作存在性对照。",
    "双口径雨场量级差 4 倍以上（参数化 40.7 mm vs ERA5 约 171 mm），"
    "全部结论按口径分列，不合并。",
    "本件是模型的自我对照 + 公开通报的存在性对照，不是精度验收。",
    "可主张：五步决策链在第二场事件上端到端跑通（链条可迁移）；"
    "不主张：精度迁移。",
]


def _load_csv(p: Path) -> list[dict]:
    with open(p, encoding="utf-8-sig") as f:
        return [{k.lstrip("\ufeff"): v for k, v in r.items()}
                for r in csv.DictReader(f)]


# ---------- 公共装配 ----------

def _ctx():
    """(grid, kcfg, prj_params, cfg, track_param, track_era5 共用的 track)。"""
    from typhoeus import cli as CLI
    from typhoeus import config as CFG
    from typhoeus import data as D
    from typhoeus import projection as PRJ

    cfg = CFG.Config()
    inp = D.load_all(cfg.l2.bbox, cfg.l4.resample)
    kcfg = CLI._kernel_params(cfg)
    prj = PRJ.ProjectionParams(
        road_capacity=cfg.l3.road_capacity, road_mix=cfg.l3.road_mix)
    track = D.load_track(season=2022, name="MUIFA",
                         lon_range=(115.0, 135.0))
    return inp.grid, kcfg, prj, cfg, track


def _rain(grid, kcfg, track, source: str):
    """双口径雨场。返回 (rain_mm_h, 来源报告)。"""
    from typhoeus import kernel as K
    from typhoeus import rainsrc as RS

    if source == "parameterized":
        rain = K.rainfall_field(track, grid, kcfg)
        return rain, {"driver": "parametric",
                      "72h面雨量_mm": round(float(rain.mean(axis=(1, 2)).sum()
                                                  * 600.0 / 3600.0), 1)}
    rain, rep = RS.get_rainfall(grid, stations=None, use_cache=True,
                                calibrate=False, verbose=False,
                                cache_name="era5_muifa2022")
    rep["72h面雨量_mm"] = rep.get("grid_accum_mm_before")
    return rain, rep


def _kernel(grid, rain, kcfg, coeff: float):
    """跑一次内核，返回 (峰值水深场, 完整结果)。"""
    from typhoeus import kernel as K

    kp = K.KernelParams(**{**kcfg.__dict__, "drainage_coeff_m_s": coeff})
    res = K.run(grid, rain, kp)
    return np.asarray(res.depth).max(axis=0), res


def _q_total(res, prj_params):
    """功能损失总量 Q（与 multievent.run_event 同函数链）。"""
    from typhoeus import projection as PRJ
    from typhoeus import reconcile as RC

    proj = PRJ.aggregate(res.depth, prj_params)
    dt_h = float(res.t_h[1] - res.t_h[0])
    return RC.event_total(proj["Q"], dt_h), proj


def _points() -> list[dict]:
    """梅花通报涝点，标注域内外。"""
    rows = []
    for r in _load_csv(SEED / "flood_points_2022_muifa.csv"):
        try:
            x, y = float(r["lon"]), float(r["lat"])
        except (KeyError, TypeError, ValueError):
            rows.append({**r, "域判定": "坐标缺失"})
            continue
        inside = (LON_MIN <= x <= LON_MAX and LAT_MIN <= y <= LAT_MAX)
        rows.append({**r, "域判定": "域内" if inside else "域外"})
    return rows


# ---------- m17 归因 ----------

def build_attribution(verbose: bool = True) -> dict:
    grid, kcfg, prj, cfg, track = _ctx()
    out = {"名称": "m17 归因分解（梅花 2022）",
           "生成时间": datetime.now().isoformat(timespec="seconds"),
           "方法": "同一雨场跑三次内核（排水 0 / 1.2e-3 / 1.2e-2），"
                   "峰值水深三段分解；双口径并排列。",
           "口径": {}, "全域": {}, "涝点明细": [], "边界": BOUNDS}
    for source in ("parameterized", "era5"):
        rain, rep = _rain(grid, kcfg, track, source)
        peaks = {}
        for tag, coeff in (("无排水", COEFF_NONE), ("实际", COEFF_REAL),
                           ("理想排水", COEFF_IDEAL)):
            f, res = _kernel(grid, rain, kcfg, coeff)
            peaks[tag] = f
            if verbose:
                print(f"  [{source}] 排水 {coeff:.1e}（{tag}）："
                      f"全域峰值 {f.max():.4f} m", flush=True)
        h0, hr, hi = peaks["无排水"], peaks["实际"], peaks["理想排水"]
        hi = np.minimum(hi, hr)
        hr = np.minimum(hr, h0)
        q, _ = _q_total(res, prj)  # res 是理想排水那次；Q 用"实际"排水重算
        _, res_real = _kernel(grid, rain, kcfg, COEFF_REAL)
        q, _ = _q_total(res_real, prj)
        lon, lat = np.asarray(grid.lon), np.asarray(grid.lat)

        rows = []
        for r in _points():
            if r.get("域判定") != "域内":
                continue
            i = int(np.abs(lat - float(r["lat"])).argmin())
            j = int(np.abs(lon - float(r["lon"])).argmin())
            a, b, c = float(h0[i, j]), float(hr[i, j]), float(hi[i, j])
            tot = a if a > 0 else 0.0
            rows.append({
                "编号": r["point_id"], "名称": r["name"],
                "结构": r.get("structure_type", ""),
                "无排水_m": round(a, 4), "实际_m": round(b, 4),
                "理想排水_m": round(c, 4),
                "①排水已承担": round(max(a - b, 0.0), 4),
                "②排水可再挖": round(max(b - c, 0.0), 4),
                "③雨不可消": round(c, 4),
                "通报水深_m": (float(r["depth_m"]) if r.get("depth_m")
                               else None),
                "坐标精度": r.get("coord_precision", ""),
            })
        for r in rows:
            a = r["无排水_m"]
            if a < 0.01:
                r["分型"] = "模型无水"
            elif a - r["实际_m"] >= 0.8 * a:
                r["分型"] = "排水兜底型"
            elif r["②排水可再挖"] >= 0.2 * max(a, 1e-9):
                r["分型"] = "排水可挖型"
            elif r["③雨不可消"] >= 0.6 * a:
                r["分型"] = "雨致型"
            else:
                r["分型"] = "混合型"

        out["口径"][source] = rep
        out["全域"][source] = {
            "无排水峰值_m": round(float(h0.max()), 4),
            "实际峰值_m": round(float(hr.max()), 4),
            "理想排水峰值_m": round(float(hi.max()), 4),
            "Q_total": round(q, 4),
        }
        out["涝点明细"].extend([{**r, "口径": source} for r in rows])

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "m17_归因分解.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    if verbose:
        print(f"→ {OUT / 'm17_归因分解.json'}")
    return out


# ---------- m19-m20 情景翻转带 ----------

def build_decisions(verbose: bool = True) -> dict:
    grid, kcfg, prj, cfg, track = _ctx()
    out = {"名称": "m19-m20 代价排序与决策稳定性（梅花 2022）",
           "生成时间": datetime.now().isoformat(timespec="seconds"),
           "方法": "以该口径 72h 面雨量为基准 ×{0.75,1.0,1.5,2.0} 四档强度"
                   "阶梯（依据：18 场目录面雨量跨 130 倍离散，倍数档在样本"
                   "覆盖内）；每档一次内核取逐点峰值，min–max 即翻转带。"
                   "强度阶梯 ≠ 事件分位，性质写明。",
           "口径": {}, "边界": BOUNDS}
    for source in ("parameterized", "era5"):
        rain, rep = _rain(grid, kcfg, track, source)
        base_mm = rep["72h面雨量_mm"]
        peaks_by_mult = []
        for mult in SCENARIO_MULT:
            f, _ = _kernel(grid, rain * mult, kcfg, COEFF_REAL)
            peaks_by_mult.append((mult, f))
            if verbose:
                print(f"  [{source}] ×{mult}: 全域峰值 {f.max():.4f} m",
                      flush=True)
        lo = np.minimum.reduce([f for _, f in peaks_by_mult])
        hi = np.maximum.reduce([f for _, f in peaks_by_mult])
        # 逐格判定：某格的峰值区间 [min,max] 跨过 15 cm 判据，
        # 意味着该格的"是否越阈"结论随强度档翻转
        gb_cells = int(np.count_nonzero(
            (lo <= GB51222_CM) & (hi >= GB51222_CM)))
        gb_in = gb_cells > 0
        out["口径"][source] = {
            **rep,
            "基准面雨量_mm": base_mm,
            "各档全域峰值_m": {str(m): round(float(f.max()), 4)
                              for m, f in peaks_by_mult},
            "翻转带": {"全域逐格带宽_m": round(float((hi - lo).max()), 4),
                     "跨15cm判据的格数": gb_cells},
            "结论稳定性": (f"不稳定——{gb_cells} 格的越阈结论随强度档翻转"
                        "（含/不含 GB 51222 的 15 cm 判据点）" if gb_in else
                        "稳定——无格子的越阈结论翻转"),
        }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "m19-m20_决策稳定性.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    if verbose:
        print(f"→ {OUT / 'm19-m20_决策稳定性.json'}")
    return out


# ---------- m21-m22 反解 ----------

def build_inverse(verbose: bool = True) -> dict:
    grid, kcfg, prj, cfg, track = _ctx()
    out = {"名称": "m21-m22 反问题（梅花 2022）",
           "生成时间": datetime.now().isoformat(timespec="seconds"),
           "方法": "p21 二分排水系数使全域峰值回到目标带；p22 扫雨量倍数。"
                   "梅花无域内涝点台账，目标带取全域峰值口径，写明与烟花"
                   "（FP018 点口径）不同。",
           "口径": {}, "边界": BOUNDS}
    for source in ("parameterized", "era5"):
        rain, rep = _rain(grid, kcfg, track, source)
        # p21：排水能力降到全域峰值 0.5 m 所需的系数
        lo, hi = 1e-5, COEFF_REAL
        for _ in range(18):
            mid = 0.5 * (lo + hi)
            f, _ = _kernel(grid, rain, kcfg, mid)
            if f.max() >= 0.5:
                lo = mid
            else:
                hi = mid
        coeff_05 = round(hi, 6)
        # p22：雨量翻倍后峰值
        f2, _ = _kernel(grid, rain * 2.0, kcfg, COEFF_REAL)
        out["口径"][source] = {
            **rep,
            "p21_峰值0.5m所需排水系数": coeff_05,
            "p21_相对现状倍率": round(coeff_05 / COEFF_REAL, 4),
            "p22_雨量翻倍_全域峰值_m": round(float(f2.max()), 4),
        }
        if verbose:
            print(f"  [{source}] 峰值 0.5 m 需排水系数 {coeff_05}"
                  f"（现状的 {coeff_05 / COEFF_REAL:.3f} 倍）；"
                  f"雨量翻倍峰值 {f2.max():.4f} m", flush=True)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "m21-m22_反问题.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    if verbose:
        print(f"→ {OUT / 'm21-m22_反问题.json'}")
    return out


# ---------- m32 决策卡 ----------

def build_card(verbose: bool = True) -> dict:
    m17 = json.loads((OUT / "m17_归因分解.json").read_text(encoding="utf-8"))
    m20 = json.loads((OUT / "m19-m20_决策稳定性.json").read_text(encoding="utf-8"))
    m22 = json.loads((OUT / "m21-m22_反问题.json").read_text(encoding="utf-8"))

    rows = []
    for r in m17["涝点明细"]:
        src = r["口径"]
        rows.append({
            "编号": f'{r["编号"]}({src})', "名称": r["名称"],
            "结构": r["结构"],
            "分型": r["分型"],
            "建议手段": {"排水兜底型": "保住现有排水在运行",
                       "排水可挖型": "加管径/提标",
                       "雨致型": "调蓄或竖向改造",
                       "模型无水": "补容器几何后复测",
                       "混合型": "组合手段"}[r["分型"]],
            "翻转带结论": m20["口径"][src]["结论稳定性"],
            "反解": (f'峰值0.5m需排水 {m22["口径"][src]["p21_相对现状倍率"]}×'
                     f'现状'),
            "通报水深_m": r["通报水深_m"],
            "可信度": "未验证（坐标 ±1000 m 以上，且模型点读数不主张）",
        })
    if not rows:
        rows.append({
            "编号": "-", "名称": "全域口径（梅花无域内可对照涝点）",
            "结构": "-", "分型": "见 m17 全域读数",
            "建议手段": "全域读数不构成逐点建议",
            "翻转带结论": m20["口径"]["era5"]["结论稳定性"],
            "反解": "见 m21-m22", "通报水深_m": None,
            "可信度": "BLOCKED（缺域内实测台账）",
        })

    payload = {
        "名称": "m32 规划决策卡（梅花 2022）",
        "生成时间": datetime.now().isoformat(timespec="seconds"),
        "每点一行": rows,
        "全域双口径": m17["全域"],
        "边界": BOUNDS,
    }
    (OUT / "m32_规划决策卡.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    # 极简 HTML，与 p32 同风格（单表）
    trs = "".join(
        "<tr>" + "".join(f"<td>{v if v is not None else ''}</td>"
                         for v in (r["编号"], r["名称"], r["分型"],
                                   r["建议手段"], r["翻转带结论"],
                                   r["反解"], r["可信度"])) + "</tr>"
        for r in rows)
    html = ("<!doctype html><meta charset='utf-8'><title>m32 梅花决策卡</title>"
            "<style>body{font-family:sans-serif;margin:2em}"
            "table{border-collapse:collapse}td,th{border:1px solid #999;"
            "padding:6px 10px;font-size:14px}</style>"
            "<h1>m32 规划决策卡（梅花 2022）</h1>"
            "<p>口径：双口径并列举全域读数；点级一律不主张精度。"
            "边界见 JSON 件。</p>"
            "<table><tr><th>编号</th><th>名称</th><th>分型</th><th>建议手段</th>"
            "<th>翻转带</th><th>反解</th><th>可信度</th></tr>"
            f"{trs}</table>")
    (OUT / "m32_规划决策卡.html").write_text(html, encoding="utf-8")
    if verbose:
        print(f"→ {OUT / 'm32_规划决策卡.json'} / .html")
    return payload


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="muifa_deep_dive")
    ap.add_argument("cmd", choices=["attribution", "decisions", "inverse",
                                    "card", "all"])
    a = ap.parse_args(argv)
    if a.cmd in ("attribution", "all"):
        build_attribution()
    if a.cmd in ("decisions", "all"):
        build_decisions()
    if a.cmd in ("inverse", "all"):
        build_inverse()
    if a.cmd in ("card", "all"):
        build_card()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
