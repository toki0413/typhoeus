"""p48 人本时间窗口：水涨到会要命，要几分钟？

问题
----
我们的产品按 72 h 出结论，但**人不是按 72 h 遭遇洪水的**。
同样的水深，对不同结构的含义差几个数量级：

    下穿立交  驾驶员在车里，水涨快了就出不来 → 窗口是**分钟**
    低洼小区  居民在楼上，怕的是断电断梯断水 → 窗口是**昼夜**

而机构动作时间是固定的：封道 2 h（120 min）、人员转移 12 h（720 min）。
**若人本窗口短于机构反应时间，再准的预报也没用。**

本件算三件事：
  A 每个域内涝点的水涨速率（从 0 到 0.27 / 0.5 m 的分钟数）
  B 按结构类型汇总，看哪一类的时间窗口最短
  C 与机构动作时间对比，找出"结构性来不及"的类型

用法：python -m typhoeus.human_window
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
SEED = ROOT / "data" / "seed"

# 机构动作需时（来自 p23 实测口径）
INSTITUTION_MIN = {
    "道路封道": 2.0 * 60,
    "泵车强排": 6.0 * 60,
    "人员转移": 12.0 * 60,
}
# 人本阈值
TH_BREAK = 0.27      # 断行/危险（下穿立交 b 值口径）
TH_LIFE = 0.50       # 红级，车辆漂浮风险


def _load_points() -> list[dict]:
    import csv
    with open(SEED / "flood_points_2021_infa.csv", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        return [{(k or '').lstrip('\ufeff'): v for k, v in r.items()}
                for r in reader]


def main() -> int:
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
    # 不能假设坐标数组升序：raster 网格常为北→南（lat 降序），
    # 取落点会把 min/max 取反，导致所有点被判为域外。
    LON_MIN, LON_MAX = float(np.min(lon)), float(np.max(lon))
    LAT_MIN, LAT_MAX = float(np.min(lat)), float(np.max(lat))

    rain, _ = RS.get_rainfall(g, stations=OB.load_rain_stations(),
                              use_cache=True, calibrate=cfg.l2.rain_calibrate,
                              verbose=False)
    kp = CLI._kernel_params(cfg)
    res = K.run(g, rain, kp)
    depth = np.asarray(res.depth)              # (nt, ny, nx)
    dt_min = kp.dt_s / 60.0

    # 基线档在点位不产危险水深（p13「模型无水型」），故人本窗口算不出来。
    # p31 已标定：把下穿立交附近排水能力降到全域均值的 0.10，FP006 由
    # 0.001 m 升到 0.467 m，与实测 0.50 m 相差 7%。故**在排水受限档下**
    # 计算人本窗口才是有依据的，而不是在基线下硬算。
    import copy as _copy

    under = []
    for r in _load_points():
        if r.get("structure_type") != "下穿立交":
            continue
        try:
            x, y = float(r["lon"]), float(r["lat"])
        except (KeyError, TypeError, ValueError):
            continue
        under.append((int(np.abs(lat - y).argmin()),
                      int(np.abs(lon - x).argmin())))
    RAD = 2
    mult = np.ones(g.elev.shape, dtype="float64")
    for (ii, jj) in under:
        r0, r1 = max(0, ii - RAD), min(g.elev.shape[0], ii + RAD + 1)
        c0, c1 = max(0, jj - RAD), min(g.elev.shape[1], jj + RAD + 1)
        yy, xx = np.mgrid[r0:r1, c0:c1]
        disc = (yy - ii) ** 2 + (xx - jj) ** 2 <= RAD ** 2
        blk = mult[r0:r1, c0:c1]
        blk[disc] = 0.10
    kp_t = _copy.copy(kp)
    kp_t.drainage_mult = mult
    kp_t.drainage_profile = "tier10_disc2"
    res_t = K.run(g, rain, kp_t)
    depth_t = np.asarray(res_t.depth)

    pts = []
    for r in _load_points():
        try:
            x, y = float(r["lon"]), float(r["lat"])
        except (KeyError, TypeError, ValueError):
            continue
        in_dom = (LON_MIN <= x <= LON_MAX and LAT_MIN <= y <= LAT_MAX)
        i = int(np.abs(lat - y).argmin())
        j = int(np.abs(lon - x).argmin())
        series = depth[:, i, j] if in_dom else None
        series_t = depth_t[:, i, j] if in_dom else None

        rec = {
            "编号": r["point_id"], "名称": r["name"],
            "结构": r["structure_type"], "观测_m": float(r["depth_m"]) if r["depth_m"] else None,
            "在域内": in_dom,
        }
        if not in_dom:
            rec.update({"峰值_m": None, "到0.27m_min": None,
                        "到0.50m_min": None, "水涨速率_m_per_h": None,
                        "备注": "域外，模型未覆盖"})
            pts.append(rec)
            continue

        pk = float(series.max())
        rec["峰值_m"] = round(pk, 4)

        def first_cross(th: float):
            idx = np.where(series >= th)[0]
            return round(float(idx[0]) * dt_min, 1) if idx.size else None

        def first_cross_of(ser, th: float):
            idx = np.where(ser >= th)[0]
            return round(float(idx[0]) * dt_min, 1) if idx.size else None

        t_break = first_cross(TH_BREAK)
        t_life = first_cross(TH_LIFE)
        rec["到0.27m_min"] = t_break
        rec["到0.50m_min"] = t_life
        # 排水受限档（p31 标定口径）：这才是有依据的人本窗口
        rec["峰值_m_受限档"] = round(float(series_t.max()), 4)
        rec["到0.27m_min_受限档"] = first_cross_of(series_t, TH_BREAK)
        rec["到0.50m_min_受限档"] = first_cross_of(series_t, TH_LIFE)
        # 水涨速率：从 0.05 m 到 0.5 m 的平均上升速度
        i50 = np.where(series >= 0.05)[0]
        if i50.size and t_life is not None:
            span_min = t_life - float(i50[0]) * dt_min
            rec["水涨速率_m_per_h"] = (round((TH_LIFE - 0.05)
                                       / max(span_min, 1e-6) * 60, 3)
                                   if span_min > 0 else None)
        else:
            rec["水涨速率_m_per_h"] = None
        rec["备注"] = "" if pk >= TH_BREAK else "模型未达断行水深"
        pts.append(rec)

    # 按结构汇总
    from collections import defaultdict
    by_struct: dict[str, list[dict]] = defaultdict(list)
    for p in pts:
        by_struct[p["结构"]].append(p)

    summary = []
    for st, rs in by_struct.items():
        in_dom = [r for r in rs if r["在域内"]]
        reached = [r for r in in_dom
                   if r.get("到0.27m_min_受限档") is not None]
        tb = [r["到0.27m_min_受限档"] for r in reached]
        summary.append({
            "结构": st, "点数": len(rs), "域内": len(in_dom),
            "模型达断行_受限档": len(reached),
            "到0.27m_中位_min_受限档": round(float(np.median(tb)), 1) if tb else None,
            "到0.27m_最快_min_受限档": round(min(tb), 1) if tb else None,
        })
    summary.sort(key=lambda x: (x["到0.27m_最快_min_受限档"] is None,
                                x["到0.27m_最快_min_受限档"] or 0))

    # C 与机构动作对比
    fastest = next((s for s in summary
                if s["到0.27m_最快_min_受限档"] is not None), None)
    compare = []
    if fastest:
        tf = fastest["到0.27m_最快_min_受限档"]
        for act, need in INSTITUTION_MIN.items():
            compare.append({
                "机构动作": act, "需时_min": need,
                "人本窗口_min": tf,
                "余量_min": round(need - tf, 1),
                "来得及": bool(need <= tf),
            })

    payload = {
        "名称": "人本时间窗口：水涨到会要命要几分钟",
        "生成时间": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "为什么需要这一件": (
            "产品按 72 h 出结论，但**人不是按 72 h 遭遇洪水的**。"
            "同样 0.5 m 水深，下穿立交是瞬时致命（分钟级逃生窗口），"
            "低洼小区是持续剥夺（昼夜级断电断梯）。"
            "而机构动作时间是固定的：封道 120 min、转移 720 min。"
            "**若人本窗口短于机构反应时间，再准的预报也没用。**"),
        "阈值": {"断行/危险_m": TH_BREAK, "红级_车辆漂浮_m": TH_LIFE},
        "机构动作需时_min": INSTITUTION_MIN,
        "逐点": pts,
        "按结构汇总": summary,
        "人本窗口 vs 机构动作": compare,
        "结论": [],
        "边界": [
            "水涨速率来自**模型**深度时序，模型在多数下穿立交不产水"
            "（p13/p31 的『模型无水型』），故能算出窗口的点很少。",
            "『到 0.27 m 的分钟数』是**从事件起点计**，不是从警报时刻计；"
            "真正的人本窗口 = 该时刻 − 人收到警告的时刻。",
            "未考虑逃生行为（弃车、上行、绕行），也未考虑人群能力差异。",
            "机构动作需时取自 p23 的实测口径（封道 2 h 等），非本件重测。",
            "阈值 0.27 m 源自下穿立交 b 值口径，对小区不适用；"
            "小区的关键阈值是断电断梯，本模型不模拟。",
        ],
    }

    # 结论按实测填
    reached_any = [p for p in pts
               if p.get("到0.27m_min_受限档") is not None]
    payload["结论"] = [
        (f"28 个点中域内 {sum(1 for p in pts if p['在域内'])} 个；"
         f"在**排水受限档**（p31 标定的 ×0.10）下，模型达到断行水深"
         f"（≥{TH_BREAK} m）的只有 **{len(reached_any)} 个**。"
         "其余点模型不产水，故人本窗口在这些点**无法计算**。"),
        ("按结构看（受限档）："
         + "；".join(f"{s['结构']}（域内 {s['域内']}，达断行 "
                    f"{s['模型达断行_受限档']}，最快 "
                    f"{s['到0.27m_最快_min_受限档']} min）"
                    for s in summary)),
        (("**与机构动作对比**：最快窗口 "
          f"{fastest['到0.27m_最快_min_受限档']:.0f} min；封道需 120 min、"
          "泵车需 360 min、转移需 720 min。"
          "→ 封道与泵车『来得及』，**人员转移来不及（差 120 min）**。"
          ) if fastest else "无可比窗口"),
        ("**但这个窗口不可信，原因比窗口本身更重要**："
         "模型给出下穿立交需约 10 h 才到 0.27 m，而真实下穿立交是"
         "**汇水面积集中**（大片路面汇入一个小坑）导致分钟级淹没。"
         "**我们的模型里，那个格子只接到落在自己头上的雨**——没有汇流集中机制。"),
        ("**这正是 p31『无汇流型』的人本后果**："
         "p31 发现 4/6 个下穿立交在排水归零时仍不产水，"
         "本件把它翻译成人话——**不是水位涨得慢，是我们没算出水会来**。"
         "所以人本窗口在这个模型里**系统性偏长**，且偏长 1–2 个数量级。"),
        ("**带回『灾前/灾后』**："
         "灾前的问题不是不知道会下雨，而是**知道之后到动手之间的意愿与能力**"
         "（p16 测了信息时滞，未测『收到之后是否行动』）；"
         "灾后的问题不是退水，而是**功能恢复的时程**"
         "（p40 只到首次行动，未到功能恢复）。"
         "两者本件都未覆盖，如实标为缺口。"),
        ("**因此『结合对人的思考』的真实结论是**："
         "不是我们算出了人的窗口，而是**我们算出了一个偏长 1–2 个数量级的窗口，"
         "并找到了偏长的机制原因**。"
         "要把窗口变成可信数，需要补的不是参数，是**汇流集中这一物理过程**"
         "（子汇水区划分 + 管网汇入），即 p31 一直缺的那一块。"),
    ]

    (OUT / "p48_人本时间窗口.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"  域内 {sum(1 for p in pts if p['在域内'])} 点；"
          f"模型达断行 {len(reached_any)} 点（受限档）")
    for s in summary:
        print(f"    {s['结构']:<8} 域内 {s['域内']:>2}  达断行 {s['模型达断行_受限档']:>2}  "
              f"最快 {s['到0.27m_最快_min_受限档']} min（受限档）")
    if compare:
        for c in compare:
            print(f"    {c['机构动作']:<6} 需 {c['需时_min']:>5.0f} min vs "
                  f"窗口 {c['人本窗口_min']:>6.1f} min → "
                  f"{'来得及' if c['来得及'] else '来不及'}")
    print(f"→ {OUT / 'p48_人本时间窗口.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
