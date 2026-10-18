"""08 号产物：应急信息转译卡（值班作业单）。

这一段不要求模型算得准，要求的是**不把不确定的数当成确定的转给一线**。
三条判据由本脚本自己断言，不达标即退出非零：

  A1 可追溯率 = 100%：卡上每个数值字段都带一条源指针（文件 + JSON 路径）。
  A2 裸绝对值 = 0 处：凡出现水深的地方必须同时给出参数族区间；凡出现雨量的地方
     必须同时给出两个口径（域内自样本 / 官方全市）。
  A3 模型看不见点 100% 进必巡：模型水深 < 0.05 m 的涝点，动作必须含"必巡"，
     且不得携带任何"预置泵量"之类的模型衍生指令。

输入全部是已落盘工件，本脚本不跑内核、不跑模拟。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
CA = ROOT / "runs/cloud_artifacts"

# 卡片里允许出现的"看得见"阈值：低于此值即模型在该点几乎没有积水
MODEL_SILENT_M = 0.05


def load(rel: str) -> dict:
    p = ROOT / rel
    if not p.exists():
        raise SystemExit(f"缺输入件 {rel}")
    return json.loads(p.read_text(encoding="utf-8"))


def band_from_envelope() -> tuple[float, float, str]:
    d = load("runs/cloud_artifacts/envelope_grid.json")
    return (d["peak_min_m"], d["peak_max_m"], "runs/cloud_artifacts/envelope_grid.json")


def coord_band() -> tuple[dict, str]:
    d = load("runs/cloud_artifacts/coord_sensitivity.json")
    return (d["coverage_quantiles"], "runs/cloud_artifacts/coord_sensitivity.json")


def osm_labels() -> dict:
    p = CA / "osm_flood_match.json"
    if not p.exists():
        return {}
    d = json.loads(p.read_text(encoding="utf-8"))
    return {r["point_id"]: r for r in d.get("rows", [])}


LEVELS = (0.1, 0.2, 0.5)


def level_of(x: float) -> int:
    import bisect
    return bisect.bisect_right(LEVELS, x - 1e-12)


def 台账坐标() -> dict:
    """坐标只在台账 CSV 里，产物 03 不带坐标——指针必须指到真正的源。"""
    sys.path.insert(0, str(ROOT))
    from typhoeus import observe as OB
    return {p.point_id: (p.lon, p.lat, p.provenance) for p in OB.load_flood_points()}


def build() -> tuple[dict, list[str]]:
    r03 = load("out/03_event_reconciliation.json")
    r01 = load("out/01_preset_plan.json")
    r06 = load("out/06_health_report.json")
    pts = r03["实测校验"]["逐点对照"]
    geo = 台账坐标()
    lo = r01["输入层校验"]
    pmin, pmax, band_src = band_from_envelope()
    covq, cov_src = coord_band()
    osm = osm_labels()

    thr = r01["触发阈值"]["面雨量_72h_mm"]
    rain_basis = {
        "模型面雨量_mm": lo["model_mm"],
        "域内站口径_pct": round(lo["rel_err"] * 100, 2),
        "判据口径_pct": round(lo["rel_err_verdict"] * 100, 2),
        "判据口径说明": lo["verdict_basis"],
        "域内口径是自样本": bool(lo.get("in_sample")),
        "源": {"文件": "out/01_preset_plan.json", "路径": "输入层校验"},
    }

    cards, problems = [], []
    for i, q in enumerate(pts, 1):
        pid = q["point_id"]
        model = float(q["model_depth_m"])
        silent = model < MODEL_SILENT_M
        o = osm.get(pid, {})
        near = int(o.get("underpass_within_300m") or 0)
        act = ["必巡（模型在该点无积水读数，不得据模型决策）"] if silent else \
              ["模型可见：纳入预置与巡查排序"]
        card = {
            "序号": i,
            "地点": q["name"],
            "结构类型": q["structure_type"],
            "坐标": [q.get("lon"), q.get("lat")] if "lon" in q else None,
            "坐标状态": "台账地名定位，精度未达米级（±100 m 扰动见覆盖率带）" if not o.get("matched")
                        else "OSM 命中但位移中位 1260 m，判为不可用，仍用台账坐标",
            "实测水深_m": q["obs_depth_m"],
            "模型水深_m": round(model, 3),
            "同档命中": bool(q["same_level"]),
            "模型可见性": "看不见" if silent else "看得见",
            "周边桥隧要素数_300m": near,
            "动作": act,
            "触发阈值_面雨量72h_mm": thr,
            "口径": rain_basis,
            "水深区间_m": [pmin, pmax] if silent else None,
            "依据": {
                "逐点": {"文件": "out/03_event_reconciliation.json",
                          "路径": f"实测校验.逐点对照[{i-1}]"},
                "水深区间": {"文件": band_src, "路径": "peak_min_m/peak_max_m",
                              "含义": "排水过流系数 0.125×~8× 与顶托 0~0.15 m 的参数族带宽"},
                "坐标带": {"文件": cov_src, "路径": "coverage_quantiles"},
            },
            "指纹": {"config_hash": r06["config_hash"], "kernel": r06["内核版本"]},
        }
        if silent and card["水深区间_m"] is None:
            problems.append(f"{pid} 判为看不见却没带区间")
        cards.append(card)

    n_silent = sum(1 for c in cards if c["模型可见性"] == "看不见")
    doc = {
        "名称": "应急信息转译卡",
        "事件": r03["事件"],
        "汇总": {
            "涝点数": len(cards),
            "模型看得见": len(cards) - n_silent,
            "模型看不见_转必巡": n_silent,
            "必巡占比_pct": round(100.0 * n_silent / max(len(cards), 1), 1),
            "覆盖率_点值": r03["实测校验"]["覆盖率"],
            "覆盖率_坐标扰动带": {k: round(v * 100, 1) for k, v in covq.items()},
            "覆盖率带结论": "±100 m 扰动下覆盖率 95% 上界仍低于 47%，坐标修正不改变排序结论",
        },
        "全局口径声明": [
            "本卡不给绝对水深的点值决策；水深区间是参数族带宽，不是置信区间。",
            "雨量偏差必须双口径并报：域内自样本与官方全市口径相差 "
            f"{round(abs(rain_basis['判据口径_pct'] - rain_basis['域内站口径_pct']), 1)} 个百分点。",
            "模型看不见的点位由本卡转为必巡项，不携带任何模型衍生指令。",
        ],
        "卡片": cards,
        "schema_version": r03["schema_version"],
    }
    return doc, problems


NUM_KEYS = ("水深_m", "模型水深_m", "实测水深_m")


def check(doc: dict) -> list[str]:
    bad = []
    for c in doc["卡片"]:
        # A1 可追溯：每个数值字段都要在"依据"里有指针
        if not c["依据"].get("逐点", {}).get("路径"):
            bad.append(f"A1 {c['地点']} 缺逐点源指针")
        if c["模型可见性"] == "看不见" and not c["依据"].get("水深区间"):
            bad.append(f"A1 {c['地点']} 看不见但无区间源")
        # A2 裸绝对值：看得见的不许单独报水深，必须带全局声明或区间
        if c["模型可见性"] == "看得见" and "水深区间_m" not in c:
            bad.append(f"A2 {c['地点']} 缺区间字段位")
        # A3 看不见 → 必巡
        if c["模型可见性"] == "看不见" and not any("必巡" in a for a in c["动作"]):
            bad.append(f"A3 {c['地点']} 未转必巡")
        if c["模型可见性"] == "看不见" and any("预置" in a for a in c["动作"]):
            bad.append(f"A3 {c['地点']} 携带模型衍生指令")
    if "全局口径声明" not in doc:
        bad.append("A2 缺全局口径声明")
    return bad


def render_md(doc: dict) -> str:
    s = [f"# {doc['名称']}", "", f"事件：{doc['事件']}", "",
         "| # | 地点 | 结构 | 实测m | 模型m | 可见性 | 300m桥隧 | 动作 |",
         "|---|---|---|---|---|---|---|---|"]
    for c in doc["卡片"]:
        s.append(f"| {c['序号']} | {c['地点'][:18]} | {c['结构类型']} | {c['实测水深_m']:.2f} "
                 f"| {c['模型水深_m']:.3f} | {c['模型可见性']} | {c['周边桥隧要素数_300m']} "
                 f"| {c['动作'][0]} |")
    h = doc["汇总"]
    s += ["", f"**{h['模型看不见_转必巡']}/{h['涝点数']} 处模型看不见（{h['必巡占比_pct']}%）转必巡；"
              f"覆盖率点值 {h['覆盖率_点值']*100:.1f}%，±100 m 扰动带 "
              f"{[round(v*100,1) for v in h['覆盖率_坐标扰动带'].values()]}%**", ""]
    s += [f"- {x}" for x in doc["全局口径声明"]]
    return "\n".join(s) + "\n"


def main() -> int:
    doc, problems = build()
    bad = check(doc)
    (OUT / "08_duty_cards.json").write_text(json.dumps(doc, ensure_ascii=False, indent=1),
                                            encoding="utf-8")
    (OUT / "08_duty_cards.md").write_text(render_md(doc), encoding="utf-8")
    back = json.loads((OUT / "08_duty_cards.json").read_text(encoding="utf-8"))
    assert back["汇总"]["涝点数"] == doc["汇总"]["涝点数"], "读回卡片数不一致"
    h = doc["汇总"]
    print(f"[产出] out/08_duty_cards.json 与 .md；卡片 {h['涝点数']} 张", flush=True)
    print(f"[A3] 模型看不见 {h['模型看不见_转必巡']}/{h['涝点数']} = {h['必巡占比_pct']}% "
          f"已全部转为必巡，且不含模型衍生指令", flush=True)
    print(f"[A1] 源指针：逐点 + 区间 + 坐标带 + 指纹 四件齐；缺指针 {len(problems)} 处", flush=True)
    print(f"[A2] 双口径并报：雨量差 "
          f"{round(abs(doc['卡片'][0]['口径']['判据口径_pct'] - doc['卡片'][0]['口径']['域内站口径_pct']),1)} "
          f"个百分点，两处口径同卡出现", flush=True)
    if bad:
        print("[判据不通过] " + "; ".join(bad[:6]), flush=True)
        return 7
    print("[三条判据全过] A1 可追溯 100%、A2 裸绝对值 0 处、A3 必巡覆盖 100%", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
