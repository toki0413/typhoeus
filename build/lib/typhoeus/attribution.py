"""p17 归因分解：这场涝，多少怪雨、多少怪管网。

思路：排水能力是内核参数 `drainage_coeff_m_s`。跑三次不同排水能力，
把峰值水深拆成三段，回答"该怪雨还是怪管网"：

    h_无排水    drainage_coeff_m_s = 0        （排水完全失效）
    h_实际      drainage_coeff_m_s = 1.2e-3   （现状）
    h_理想排水  drainage_coeff_m_s = 1.2e-2   （排水能力 ×10）

三段分解（对峰值水深）：
    ① 排水已承担   = h_无排水 − h_实际        ← 现有管网的功劳
    ② 排水不足可再挖 = h_实际 − h_理想排水     ← 加强排水能消掉的
    ③ 雨本身不可消 = h_理想排水               ← 任何排水能力都消不掉的

对每个涝点与全域都算占比，并给出"责任归属"结论。

诚实边界：
  - "排水 ×10" 是反事实假设，不对应任何真实工程；仅用于划出上界。
  - 顶托（drainage_invert_m）保持不变，故这里只估"容量"贡献，不估"顶托"贡献。
  - 三次运行共享同一降雨与地形，差异只来自排水系数，故可归因。

用法：python -m typhoeus.attribution
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
COEFF_REAL = 1.2e-3
COEFF_IDEAL = 1.2e-2          # ×10
COEFF_NONE = 0.0

# 涝点阈值（与 p13 一致）
THRESH = {"下穿立交": 0.27, "低洼小区": 0.15, "低洼路段": 0.15}


def _load(p: Path) -> list[dict]:
    with open(p, encoding="utf-8-sig") as f:
        return [{k.lstrip("\ufeff"): v for k, v in r.items()} for r in csv.DictReader(f)]


def _run(coeff: float):
    """用指定排水系数跑一次内核，返回 (峰值水深场, grid)。"""
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
    kp = CLI._kernel_params(cfg)
    kp.drainage_coeff_m_s = coeff          # 唯一被改变的参数
    res = K.run(inp.grid, rain, kp)
    return np.asarray(res.depth).max(axis=0), inp.grid


def build(outdir: str = "out", verbose: bool = True) -> dict:
    peaks = {}
    for tag, coeff in (("无排水", COEFF_NONE), ("实际", COEFF_REAL),
                       ("理想排水", COEFF_IDEAL)):
        f, grid = _run(coeff)
        peaks[tag] = f
        if verbose:
            print(f"  排水系数 {coeff:.1e}（{tag}）：全域峰值 {f.max():.4f} m  "
                  f">0.05 m 占比 {(f >= 0.05).mean()*100:.2f}%", flush=True)

    h0, hr, hi = peaks["无排水"], peaks["实际"], peaks["理想排水"]
    # 数值保底：理想排水不应超过实际
    hi = np.minimum(hi, hr)
    hr = np.minimum(hr, h0)

    lon, lat = np.asarray(grid.lon), np.asarray(grid.lat)

    def at(x, y):
        return int(np.abs(lat - y).argmin()), int(np.abs(lon - x).argmin())

    rows = []
    for r in _load(SEED / "flood_points_2021_infa.csv"):
        try:
            x, y = float(r["lon"]), float(r["lat"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (LON_MIN <= x <= LON_MAX and LAT_MIN <= y <= LAT_MAX):
            continue
        i, j = at(x, y)
        a, b, c = float(h0[i, j]), float(hr[i, j]), float(hi[i, j])
        tot = a if a > 0 else 0.0
        rows.append({
            "编号": r["point_id"], "名称": r["name"],
            "结构": r.get("structure_type", ""),
            "观测水深_m": float(r["depth_m"]) if r["depth_m"] else None,
            "无排水_m": round(a, 4), "实际_m": round(b, 4), "理想排水_m": round(c, 4),
            "①排水已承担_m": round(max(a - b, 0.0), 4),
            "②排水不足可再挖_m": round(max(b - c, 0.0), 4),
            "③雨本身不可消_m": round(c, 4),
            "①占比": round(max(a - b, 0.0) / tot, 4) if tot > 0 else None,
            "②占比": round(max(b - c, 0.0) / tot, 4) if tot > 0 else None,
            "③占比": round(c / tot, 4) if tot > 0 else None,
        })

    # 全域口径
    def frac(arr, thr=0.05):
        return float((arr >= thr).mean())

    glob = {
        "无排水_峰值_m": round(float(h0.max()), 4),
        "实际_峰值_m": round(float(hr.max()), 4),
        "理想排水_峰值_m": round(float(hi.max()), 4),
        "无排水_湿格占比": round(frac(h0), 6),
        "实际_湿格占比": round(frac(hr), 6),
        "理想排水_湿格占比": round(frac(hi), 6),
        "排水面积削减": round(1 - frac(hr) / max(frac(h0), 1e-9), 4),
    }

    # 分型：不同地点的责任归属差别极大，全局均值会掩盖它
    for r in rows:
        a = r["无排水_m"]
        s1, s2, s3 = r["①占比"], r["②占比"], r["③占比"]
        if a < 0.01:
            r["分型"] = "模型无水"
            r["含义"] = "无排水时也不产水，模型在此处无信号（见已知缺陷）"
        elif s1 is not None and s1 >= 0.80:
            r["分型"] = "排水兜底型"
            r["含义"] = "无排水时水很深、靠排水消掉；排水一旦失效即酿灾"
        elif s2 is not None and s2 >= 0.20:
            r["分型"] = "排水可挖型"
            r["含义"] = "加强排水有明显效果，但存在残余上限"
        elif s3 is not None and s3 >= 0.60:
            r["分型"] = "雨致型"
            r["含义"] = "排水几乎不起作用，积水来自汇水/地形，需调蓄或竖向改造"
        else:
            r["分型"] = "混合型"
            r["含义"] = "三者均不可忽略"

    typ = {}
    for r in rows:
        typ.setdefault(r["分型"], []).append(r["编号"])

    # 域内涝点的整体责任归属（以峰值水深加权）
    w1 = sum(r["①排水已承担_m"] for r in rows)
    w2 = sum(r["②排水不足可再挖_m"] for r in rows)
    w3 = sum(r["③雨本身不可消_m"] for r in rows)
    tw = w1 + w2 + w3
    share = {"排水已承担": round(w1 / tw, 4) if tw else None,
             "排水不足可再挖": round(w2 / tw, 4) if tw else None,
             "雨本身不可消": round(w3 / tw, 4) if tw else None}

    payload = {
        "名称": "归因分解：雨致涝 vs 排水不足致涝",
        "生成时间": datetime.now().isoformat(timespec="seconds"),
        "问题": "这次淹，是雨太大，还是管网不行？",
        "方法": {
            "变量": "只改内核参数 drainage_coeff_m_s，其余（降雨/地形/顶托/入渗）全同",
            "三档": {"无排水": COEFF_NONE, "实际": COEFF_REAL,
                     "理想排水": COEFF_IDEAL},
            "分解": "① h无排水−h实际（已承担） ② h实际−h理想（可再挖） ③ h理想（不可消）",
        },
        "全域": glob,
        "涝点整体责任归属_按峰值加权": share,
        "注意": "加权均值被单点（无排水 3.0 m）主导，不可用于对外表述；"
                "地点间差异才是本件的价值，见「分型汇总」。",
        "分型汇总": {k: {"点数": len(v), "编号": v} for k, v in typ.items()},
        "涝点明细": rows,
        "边界": [
            "『排水 ×10』是反事实上界，不对应任何真实工程方案。",
            "顶托（drainage_invert_m）保持不变，故只估『容量』贡献，不估『顶托』贡献。",
            "三次运行共享同一降雨与地形，差异只来自排水系数——这是归因成立的前提。",
            "涝点坐标精度 ±100 m，单格读数受定位误差影响；看量级不看小数。",
            "本件是模型的自我对照，不是与实测的对照（实测对照见 p4）。",
        ],
    }
    p = Path(outdir)
    p.mkdir(parents=True, exist_ok=True)
    (p / "p17_归因分解.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    if verbose:
        print(f"\n  全域峰值：无排水 {glob['无排水_峰值_m']} / 实际 {glob['实际_峰值_m']} / "
              f"理想 {glob['理想排水_峰值_m']} m")
        print(f"  排水对湿面积的削减：{glob['排水面积削减']*100:.1f}%")
        print(f"  涝点责任归属（峰值加权）：{share}")
        print(f"→ {p / 'p17_归因分解.json'}")
    return payload


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="typhoeus.attribution")
    ap.add_argument("outdir", nargs="?", default="out")
    a = ap.parse_args(argv)
    build(a.outdir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
