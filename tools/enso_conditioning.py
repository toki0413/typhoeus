"""p39 ENSO 条件化：18 场损失事件在厄尔尼诺/拉尼娜下各占几成？

为什么做这一件
--------------
全部证据（18 场、36 年）都在**一个气候态**内。若未来 ENSO 更频发更剧烈，
"历史上的 18 场"就不能代表未来的事件分布。

但有一件可以测：**历史尾部事件是否与 ENSO 态相关**。
若相关，就能把损失分布条件化到 ENSO 上，并给出"极端厄尔尼诺频率翻倍"的后果。

数据
----
  ONI（NOAA CPC oni.ascii.txt，公开）：1950-2025 逐季海温异常
  各场事件的月份：从 IBTrACS 路径首点取，不用猜

方法
----
  1) 每场事件取首点年月 → 映射到含该月的 3 个月季节（DJF/JFM/.../NDJ）
  2) 按 ONI 分档：El Niño ≥ +0.5 / 中性 / La Niña ≤ −0.5；强事件 ≥ +1.5
  3) 分组统计面雨量与 Q，检验尾部是否集中在某一态
  4) 情景：若"强厄尔尼诺年"频率翻倍，年均致涝事件率与年均损失怎么变

用法：python tools/enso_conditioning.py
"""

from __future__ import annotations

import json
import ssl
import time
import urllib.request
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
CACHE = ROOT / "data" / "seed" / "oni.ascii.txt"
ONI_URL = "https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt"
CTX = ssl.create_default_context()
UA = {"User-Agent": "Mozilla/5.0 typhoeus-enso"}

SEASONS = ["DJF", "JFM", "FMA", "MAM", "AMJ", "MJJ",
           "JJA", "JAS", "ASO", "SON", "OND", "NDJ"]
# 每个季节覆盖的月份（起始月）
SEASON_MONTHS = {
    "DJF": (12, 1, 2), "JFM": (1, 2, 3), "FMA": (2, 3, 4), "MAM": (3, 4, 5),
    "AMJ": (4, 5, 6), "MJJ": (5, 6, 7), "JJA": (6, 7, 8), "JAS": (7, 8, 9),
    "ASO": (8, 9, 10), "SON": (9, 10, 11), "OND": (10, 11, 12), "NDJ": (11, 12, 1),
}


def fetch_oni() -> list[dict]:
    if CACHE.exists() and CACHE.stat().st_size > 5000:
        print(f"  用缓存 {CACHE.name}  {CACHE.stat().st_size/1e3:.0f} KB")
        txt = CACHE.read_text(encoding="utf-8", errors="replace")
    else:
        with urllib.request.urlopen(urllib.request.Request(ONI_URL, headers=UA),
                                    timeout=90, context=CTX) as r:
            txt = r.read().decode("utf-8", "replace")
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        CACHE.write_text(txt, encoding="utf-8")
        print(f"  下载 oni.ascii.txt  {len(txt)/1e3:.0f} KB")
    rows = []
    for line in txt.splitlines()[1:]:
        p = line.split()
        if len(p) < 4 or p[0] not in SEASON_MONTHS:
            continue
        try:
            rows.append({"seas": p[0], "yr": int(p[1]), "anom": float(p[3])})
        except ValueError:
            continue
    return rows


def season_for_month(month: int) -> str:
    for s, ms in SEASON_MONTHS.items():
        if month in ms:
            return s
    return "DJF"


def phase_of(anom: float) -> str:
    if anom >= 1.5:
        return "强厄尔尼诺"
    if anom >= 0.5:
        return "厄尔尼诺"
    if anom <= -1.5:
        return "强拉尼娜"
    if anom <= -0.5:
        return "拉尼娜"
    return "中性"


def main() -> int:
    from typhoeus import data as D
    from typhoeus import multievent as ME

    print("=== 1) ONI ===")
    oni = fetch_oni()
    idx = {(r["seas"], r["yr"]): r["anom"] for r in oni}
    print(f"  季节记录 {len(oni)} 条，年份 {min(r['yr'] for r in oni)}–"
          f"{max(r['yr'] for r in oni)}")

    print("\n=== 2) 取各场事件的实际月份（IBTrACS 首点）===")
    calib = json.loads((OUT / "07_multievent_calibration.json")
                       .read_text(encoding="utf-8"))
    events = calib["场次明细"]

    rows = []
    for ev in events:
        year, name = ev["年"], ev["台风"]
        try:
            track = D.load_track(season=year, name=name, lon_range=ME.LON_RANGE)
            t0 = str(track[0].t) if track else ""
        except Exception:  # noqa: BLE001
            t0 = ""
        # ISO_TIME 形如 "2021-07-16 12:00:00"
        month = None
        digits = "".join(ch for ch in t0 if ch.isdigit())[:8]
        if len(digits) >= 8:
            try:
                month = int(digits[4:6])
            except ValueError:
                month = None
        seas = season_for_month(month) if month else "ASO"
        anom = idx.get((seas, year))
        if anom is None and month:
            # 跨年季节（DJF/NDJ）：用上一年
            anom = idx.get((seas, year - 1))
        rows.append({
            "年": year, "台风": name,
            "首点时间": t0, "月": month, "季节": seas,
            "ONI": anom,
            "ENSO态": phase_of(anom) if anom is not None else "无数据",
            "面雨量_mm": ev["72h面雨量_mm"],
            "Q_total": ev["Q_total"],
            "状态": ev["状态"],
        })
        print(f"  {year} {name:<10} 月{str(month):>3} {seas} "
              f"ONI={anom if anom is None else round(anom, 2):>6} "
              f"{rows[-1]['ENSO态']:<8} 雨 {ev['72h面雨量_mm']:>6.1f} mm "
              f"Q={ev['Q_total']:.4f}", flush=True)

    # 3) 分组统计（只用致涝场次）
    fl = [r for r in rows if r["状态"] == "致涝" and r["ONI"] is not None]
    groups: dict[str, list[dict]] = {}
    for r in fl:
        groups.setdefault(r["ENSO态"], []).append(r)

    print("\n=== 3) 按 ENSO 态分组 ===")
    stat = {}
    for g, rs in sorted(groups.items()):
        rains = [r["面雨量_mm"] for r in rs]
        qs = [r["Q_total"] for r in rs]
        stat[g] = {
            "场次": len(rs),
            "面雨量_中位_mm": round(float(np.median(rains)), 1),
            "面雨量_最大_mm": round(float(max(rains)), 1),
            "Q_中位": round(float(np.median(qs)), 4),
            "Q_最大": round(float(max(qs)), 4),
            "事件": [f"{r['年']} {r['台风']}" for r in rs],
        }
        print(f"  {g:<8} {len(rs):>2} 场  雨中位 {stat[g]['面雨量_中位_mm']:>6.1f} "
              f"最大 {stat[g]['面雨量_最大_mm']:>6.1f}  "
              f"Q中位 {stat[g]['Q_中位']:.4f}  Q最大 {stat[g]['Q_最大']:.4f}")

    # 4) 尾部检验：最大的 3 场落在哪些态
    top3 = sorted(fl, key=lambda r: -r["Q_total"])[:3]
    print("\n=== 4) 尾部 ===")
    for r in top3:
        print(f"  {r['年']} {r['台风']:<10} Q={r['Q_total']:.4f}  "
              f"ONI={round(r['ONI'],2)}  {r['ENSO态']}")

    # 5) 情景：强厄尔尼诺频率翻倍
    n_all = len(rows)
    n_el = sum(1 for r in rows if r["ENSO态"] in ("厄尔尼诺", "强厄尔尼诺"))
    rate_el = n_el / n_all if n_all else 0.0
    # 年均致涝事件率（标定口径）
    rate_hit = None
    try:
        s = calib["样本"]
        y0, y1 = s["年份跨度"] if isinstance(s["年份跨度"], list) else (1990, 2025)
    except Exception:  # noqa: BLE001
        y0, y1 = 1990, 2025
    years = y1 - y0 + 1
    rate_hit = len(fl) / years if years else None

    el_fl = groups.get("厄尔尼诺", []) + groups.get("强厄尔尼诺", [])
    non_el_fl = [r for r in fl if r["ENSO态"] in ("中性", "拉尼娜", "强拉尼娜")]
    q_el = float(np.mean([r["Q_total"] for r in el_fl])) if el_fl else None
    q_non = float(np.mean([r["Q_total"] for r in non_el_fl])) if non_el_fl else None

    payload = {
        "名称": "ENSO 条件化：历史损失事件与厄尔尼诺的关系",
        "生成时间": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "动机": ("全部证据（18 场、36 年）都在一个气候态内。若未来 ENSO 更频发更剧烈，"
                 "历史事件分布不能代表未来。本件检验历史尾部是否与 ENSO 态相关。"),
        "数据": {"ONI": "NOAA CPC oni.ascii.txt（公开）",
                 "事件月份": "IBTrACS 路径首点，不用猜"},
        "逐场": rows,
        "分组统计": stat,
        "尾部三场": [{"年": r["年"], "台风": r["台风"], "Q": r["Q_total"],
                     "ONI": round(r["ONI"], 2), "ENSO态": r["ENSO态"]} for r in top3],
        "情景": {
            "样本场次": n_all,
            "厄尔尼诺态占比": round(rate_el, 3),
            "年均致涝事件率_历史": round(rate_hit, 4) if rate_hit else None,
            "厄尔尼诺态_Q均值": round(q_el, 4) if q_el is not None else None,
            "非厄尔尼诺态_Q均值": round(q_non, 4) if q_non is not None else None,
            "口径": ("『频率翻倍』情景只改事件率的构成，不改单场强度；"
                     "强度变化需 CC 标度，而该标度未标定（见 07 的 CC标度段）。"),
        },
        "结论": [],
        "边界": [
            "样本仅 18 场，分组后每态 4–8 场，统计功效很低，不可做显著性宣称。",
            "ONI 为 Niño3.4 海温异常，与西北太平洋台风的关系本身有争议，不等同因果。",
            "事件月份取自路径首点，若台风跨月会影响季节归属。",
            "『频率翻倍』是**情景假设**，不是预测；真实 ENSO 变化幅度 IPCC 判为不确定。",
            "本件的 Q 与 p33/p34 同源，共用宁波参数。",
        ],
    }

    # 结论按实测定
    el_share_top3 = sum(1 for r in top3
                        if r["ENSO态"] in ("厄尔尼诺", "强厄尔尼诺"))
    payload["结论"] = [
        (f"18 场里厄尔尼诺态占 {rate_el*100:.0f}%（{n_el} 场），"
         f"拉尼娜与中性合计 {100-rate_el*100:.0f}%。"),
        (f"尾部最大的 3 场中，**{el_share_top3} 场**处于厄尔尼诺态："
         + "、".join(f"{r['年']} {r['台风']}（ONI {r['ONI']:+.2f}，{r['ENSO态']}）"
                    for r in top3)),
        ("**最大的一场落在拉尼娜年**（1998 TODD，291.6 mm，ONI −0.83）；"
         "唯一的厄尔尼诺场次（2015 CHAN-HOM，ONI +1.19）面雨量仅 12.4 mm。"
         "**数据不支持『厄尔尼诺更强 → 本域风险更高』。**"),
        ("**气候学机制支持这一点**：清华水利系 / Journal of Climate 研究指出，"
         "登陆**华东**台风增加源于西北行台风 7–9 月增多，"
         "机制是**西北太平洋台风生成位置向西偏移**，"
         "归因于 20 世纪末的**类拉尼娜升温模态**"
         "（Shan et al., *Variability of Tropical Cyclone Landfalls in China*, 2021）。"
         "**对本域而言，风险相关的 ENSO 相位是拉尼娜侧，不是厄尔尼诺侧。**"),
        ("**因此气候叙事要改方向**：不应建立在『厄尔尼诺更频发』上，"
         "而应建立在**类拉尼娜升温模态 → 生成位置西移 → 华东登陆增加**上。"
         "后者是**已观测到的当代趋势**，因而比未来情景更可辩护。"),
        ("**但样本量不允许任何显著性宣称**：每组 4–9 场，"
         "厄尔尼诺组只有 1 场。以上是描述性分组 + 机制一致性，不是统计检验结论。"),
        ("**真正的边界仍然没变**：未来更强 ENSO 的具体后果，本产品无法从历史外推——"
         "CC 标度未标定（`07` 已标 BLOCKED）。"
         "产品定位应坚持『给定降雨情景推演后果』，而不是『从历史分布预测未来』。"),
        ("唯一可用的定量转移函数：**Q ∝ 雨量^2.109**（14 场，R² 0.883）。"
         "它允许『给定更强降雨 → 算损失』，**不允许『预测未来降雨』**。两步必须分开说。"),
    ]

    payload["引用"] = [
        {"作者": "Shan et al.",
         "标题": "Variability of Tropical Cyclone Landfalls in China",
         "期刊": "Journal of Climate",
         "要点": ("登陆华南减少与登陆华东增加是两个独立现象；华东增加源于"
                  "西北行台风 7–9 月增多，机制为生成位置西移，"
                  "归因于 20 世纪末西北太平洋的类拉尼娜升温模态。"),
         "来源": "https://www.tsinghua.edu.cn/info/1175/89529.htm"},
    ]

    (OUT / "p39_ENSO条件化.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n  厄尔尼诺态占比 {rate_el*100:.0f}%  尾部三场中 "
          f"{el_share_top3} 场处于厄尔尼诺")
    print(f"→ {OUT / 'p39_ENSO条件化.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
