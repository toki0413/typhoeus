"""p46 集成研判单：把五步链压成一个对象。

为什么要这一件
--------------
体系已有 53 件产物，但**"一个产品"应该只有一个入口**。
评审、值班员、规划岗都不该被迫在 53 个文件里找答案。

本件**不重算任何模型**，只聚合已有产物（纯读取），因此：
  · 零风险——不碰内核、不碰参数、不改变任何既有结论
  · 可复算——只依赖 out/ 下已落盘且有指纹的件
  · 单一入口——一页给出：分级 + 动作 + 病因 + 手段 + 门槛 + 可信度 + 四轴

结构对齐**五步链**（这是产品叙事的骨架）：
  ① 分级  ② 病因分型  ③ 手段  ④ 门槛反解  ⑤ 可信度
外加两组上下文：四轴杠杆（该往哪投资）与跨事件证据（结论有多稳）。

用法：python -m typhoeus.briefing
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"


def _load(name: str) -> dict:
    p = OUT / name
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def build(outdir: str | Path = "out") -> dict:
    global OUT
    OUT = Path(outdir)

    preset = _load("01_preset_plan.json")
    matrix = _load("p6_情景矩阵.json")
    attr = _load("p17_归因分解.json")
    inv = _load("p21-p22_反问题.json")
    card = _load("p32_规划决策卡.json")
    axes = _load("p44_四轴杠杆对比.json")
    cross = _load("p33_跨事件决策矩阵.json")
    area = _load("p34_逐场四色面积.json")
    health = _load("05_health_metrics.json")
    feas = _load("p23_决策可行域.json")
    serv = _load("p40_服务恢复时间分解.json")
    man = _load("manifest.json")

    # ① 分级：从情景矩阵拿四档，从 01 拿动作
    scen = []
    for s in (matrix.get("情景") or []):
        scen.append({
            "档": s.get("档"),
            "面雨量_mm": s.get("面雨量_mm"),
            "峰值水深_m": s.get("峰值水深_m"),
            "四色": s.get("四色格点数") or s.get("四色占比"),
        })

    # ② 病因分型
    kinds = attr.get("分型汇总") or {}

    # ③ 手段：从决策卡的分型→建议映射里取计数
    cards = card.get("决策卡") or []
    from collections import Counter
    card_kind = Counter(c.get("分型") for c in cards)
    card_conf = Counter(c.get("可信度") for c in cards)
    usable = [c["编号"] for c in cards
              if str(c.get("可信度", "")).startswith("可参考")]

    # ④ 门槛反解
    inv_res = inv.get("结果") or {}
    # ⑤ 可信度：门槛体检 + 决策卡可信度分布

    # 四轴
    lev = axes.get("杠杆排序") or []

    # 跨事件
    cs = cross.get("跨事件统计") or {}
    mono = cross.get("跨事件单调性") or {}

    payload = {
        "名称": "集成研判单",
        "生成时间": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "一句话": ("给定面雨量，输出分型、手段、门槛与可信度；"
                   "并标明哪条情景轴最值得投资。"),
        "指纹": {
            "config_hash": man.get("config_hash"),
            "source_hash": man.get("source_hash"),
            "schema_version": man.get("schema_version"),
        },
        "① 分级": {
            "四档情景": scen,
            "动作口径": {
                "建议布点数": preset.get("建议布点数"),
                "覆盖率": preset.get("覆盖率"),
                "触发阈值": preset.get("触发阈值"),
            },
            "来源": "01_preset_plan.json · p6_情景矩阵.json",
        },
        "② 病因分型": {
            "分型汇总": kinds,
            "涝点整体归因": attr.get("涝点整体责任归属_按峰值加权"),
            "来源": "p17_归因分解.json",
        },
        "③ 手段": {
            "按分型计数": dict(card_kind),
            "建议手段": _advice_of(cards),
            "来源": "p32_规划决策卡.json",
        },
        "④ 门槛反解": {
            "结果": inv_res,
            "来源": "p21-p22_反问题.json",
        },
        "⑤ 可信度": {
            "门槛体检": {
                "指标总数": health.get("指标总数"),
                "PASS": health.get("PASS"),
                "FAIL": health.get("FAIL"),
                "BLOCKED": health.get("BLOCKED"),
            },
            "决策卡可信度分布": dict(card_conf),
            "可承载建议的点": {"数量": len(usable), "编号": usable},
            "来源": "05_health_metrics.json · p32_规划决策卡.json",
        },
        "四轴杠杆（该往哪投资）": [
            {"轴": r.get("轴"), "峰值倍数": r.get("峰值倍数"),
             "红格翻转": r.get("红格翻转")} for r in lev],
        "跨事件稳健性": {
            "场次": cs.get("场次"), "致涝": cs.get("致涝"),
            "年份跨度": cs.get("年份跨度"),
            "Spearman_ρ": mono.get("Spearman_ρ"),
            "严格单调违背": mono.get("严格单调违背"),
            "出现过红格的场次": (area.get("汇总") or {}).get("出现过红格的场次"),
            "实算成功": (area.get("汇总") or {}).get("实算成功"),
        },
        "时间尺度": {
            "信息—行动空白": (feas.get("空白") or {}),
            "服务恢复时间": (serv.get("端到端") or {}),
        },
        "怎么读": [
            "① 分级回答『该启动几级、派多少人』。",
            "② 病因分型回答『为什么淹』（排水兜底/可挖/雨致/无汇流）。",
            "③ 手段按分型映射；**不要跨型套用**。",
            "④ 门槛反解回答『雨涨多少会淹』『排水要加多少』。",
            "⑤ 可信度回答『这个结论能不能用』——不可用的点必须转人工。",
            "四轴杠杆回答『先投哪条轴』：排水 ×2.81 >> 集中度 ×1.64 > 总量 ×1.19 > 土壤 ×1.01。",
        ],
        "边界": [
            "本件是**聚合件**，不重算模型；每个数字都能追到其来源产物。",
            "聚合不改变任何既有结论，也不消除其边界——各源的边界仍分别有效。",
            "『可承载建议的点』= 决策卡中可信度为『可参考-结论稳定』者，"
            "在 28 点中仅 4 个，不可外推。",
            "本件不进本次提交材料（技术冻结），定位为单一入口的雏形。",
        ],
    }
    (OUT / "p46_集成研判单.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return payload


def _advice_of(cards: list[dict]) -> dict:
    """按分型聚合建议手段（取每型第一条），避免重复。"""
    seen: dict[str, str] = {}
    for c in cards:
        k, a = c.get("分型"), c.get("建议手段")
        if k and a and k not in seen:
            seen[k] = a
    return seen


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="typhoeus.briefing")
    ap.add_argument("outdir", nargs="?", default="out")
    a = ap.parse_args(argv)
    p = build(a.outdir)

    print(f"  指纹 {p['指纹']['config_hash']} / {p['指纹']['source_hash']}")
    print(f"  ① 分级：{len(p['① 分级']['四档情景'])} 档；布点 {p['① 分级']['动作口径']['建议布点数']}")
    print(f"  ② 分型：{p['② 病因分型']['分型汇总']}")
    print(f"  ③ 手段：{len(p['③ 手段']['按分型计数'])} 型")
    print(f"  ④ 门槛反解：{list(p['④ 门槛反解']['结果'])[:4]}")
    t = p["⑤ 可信度"]["门槛体检"]
    print(f"  ⑤ 可信度：{t['PASS']} PASS / {t['FAIL']} FAIL / {t['BLOCKED']} BLOCKED；"
          f"可承载建议 {p['⑤ 可信度']['可承载建议的点']['数量']} 点")
    print(f"  四轴：{' > '.join(x['轴'] for x in p['四轴杠杆（该往哪投资）'])}")
    cs = p["跨事件稳健性"]
    print(f"  跨事件：{cs['场次']} 场 / ρ={cs['Spearman_ρ']} / 红格 {(cs['出现过红格的场次'])}场")
    print(f"→ {Path(a.outdir) / 'p46_集成研判单.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
