"""自检闭合：能检测到自己的退步吗？

为什么这一件先于任何"自我改进"
------------------------------
RSI（递归自我改进）的第一必要条件不是"能改自己"，而是
**能检测到自己变差了**。否则改进无法保留、退步无法发现。

今晚出了三处**静默退步**，全部通过了 130 条测试与 5/5 门槛：

  1. `get_flood_cards` 工具消失 → 8 个工具变 7 个
  2. `_CALIBER_SECTIONS` 退回 2 项 → G18 分母 5→4，**仍显示 100% PASS**
  3. `cli.py` 情景矩阵阶段消失 → p6 只剩 p50，而材料引用四档

三处都不抛异常、不改结论，只是**覆盖面缩小**。这就是可检测性缺口。

本件的设计原则
--------------
**每个判据都同时报告分子与分母**，不只报比率。
因为"缩小分母换来的 100%"是本项目真实发生过的失效模式：
G18 曾以 4 份为分母报 100%，而正确覆盖是 5 份。

所以 score 不是简单通过率，而是：
    score = Σ(通过项权重) / Σ(全部项权重)
且每项都带 `覆盖` 字段，缩小覆盖会被判为不通过。

用法：
    python -m typhoeus.selfcheck          # 打印分数与逐项
    python -m typhoeus.selfcheck --json   # 机器可读
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"

# 基准值：体系"完整"时应有的规模。缩小即判退步。
EXPECT = {
    "mcp_tools": 8,
    "g18_covered_docs": 5,
    "p6_scenarios": 4,
    "gate_total": 27,
    "test_functions": 130,
    "min_products": 53,      # p* + 0*
}


def _load(name: str) -> dict:
    p = Path(OUT) / name
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def measure(outdir: str | Path = "out") -> dict:
    global OUT
    OUT = Path(outdir)
    checks: list[dict] = []

    def add(name: str, ok: bool, got, want, note: str, weight: float = 1.0):
        checks.append({"判据": name, "通过": bool(ok), "实测": got,
                       "应为": want, "说明": note, "权重": weight})

    # ① 指纹三方一致：manifest / config.json / 运行时
    try:
        from typhoeus import config as CFG
        rt = CFG.Config().hash()
        man = _load("manifest.json").get("config_hash")
        cfgj = _load("config.json").get("config_hash")
        add("指纹三方一致", rt == man == cfgj and bool(rt),
            {"运行时": rt, "manifest": man, "config.json": cfgj},
            "三者相同", "指纹漂移会让『同 hash 可复算』失效", 3.0)
    except Exception as e:  # noqa: BLE001
        add("指纹三方一致", False, f"{type(e).__name__}", "三者相同",
            "读取失败", 3.0)

    # ② MCP 工具数
    try:
        from typhoeus import mcp_server as M
        n = len(M.tool_descriptors())
        add("MCP 工具数", n == EXPECT["mcp_tools"], n, EXPECT["mcp_tools"],
            "少于基准说明工具有静默丢失（曾发生 8→7）", 2.0)
        add("MCP 描述预算", M.desc_bytes() <= M.DESC_BUDGET_B,
            M.desc_bytes(), f"≤ {M.DESC_BUDGET_B}", "超出会挤占上下文", 1.0)
    except Exception as e:  # noqa: BLE001
        add("MCP 工具数", False, f"{type(e).__name__}", EXPECT["mcp_tools"],
            "读取失败", 2.0)

    # ③ G18 覆盖份数（**分母**，不是比率）
    try:
        from typhoeus import agent_gates as AG
        rate, n, _ = AG.measure_g18()
        add("G18 覆盖份数", n == EXPECT["g18_covered_docs"], n,
            EXPECT["g18_covered_docs"],
            "分母缩小会让 100% 变成假绿（曾发生 5→4 且仍报 PASS）", 3.0)
        res = AG.run_all()
        npass = sum(1 for g in res if g["status"] == "PASS")
        add("Agent 门槛全绿", npass == len(res), f"{npass}/{len(res)}",
            f"{len(res)}/{len(res)}", "G16–G20", 2.0)
    except Exception as e:  # noqa: BLE001
        add("G18 覆盖份数", False, f"{type(e).__name__}",
            EXPECT["g18_covered_docs"], "读取失败", 3.0)

    # ④ p6 四档情景
    p6 = _load("p6_情景矩阵.json")
    n6 = len(p6.get("情景") or [])
    add("p6 四档情景", n6 == EXPECT["p6_scenarios"], n6,
        EXPECT["p6_scenarios"],
        "cli 曾丢失矩阵阶段，p6 只剩 p50 而材料仍引用四档", 2.0)

    # ⑤ 主门槛总数与结论
    hm = _load("05_health_metrics.json")
    rows = hm.get("明细") or []
    add("主门槛总数", len(rows) == EXPECT["gate_total"], len(rows),
        EXPECT["gate_total"], "门槛被删减会导致体检失真", 2.0)

    # ⑥ 产物规模
    nprod = (len(list(Path(OUT).glob("p*")))
             + len(list(Path(OUT).glob("0*"))))
    add("产物规模", nprod >= EXPECT["min_products"], nprod,
        f"≥ {EXPECT['min_products']}", "产物被删会静默缩小交付面", 1.5)

    # ⑦ 集成件在位且含五步
    br = _load("p46_集成研判单.json")
    steps = [k for k in br if k.startswith(("①", "②", "③", "④", "⑤"))]
    add("集成研判单在位", len(steps) == 5, len(steps), 5,
        "单一入口若丢失，53 件产物又变回散件", 1.5)

    # ⑧ 测试条数
    tp = ROOT / "typhoeus" / "tests.py"
    ntest = 0
    if tp.exists():
        ntest = sum(1 for ln in tp.read_text(encoding="utf-8").splitlines()
                    if ln.startswith("def test_"))
    add("回归测试条数", ntest >= EXPECT["test_functions"], ntest,
        f"≥ {EXPECT['test_functions']}", "测试被删=检测能力下降", 1.0)

    total_w = sum(c["权重"] for c in checks)
    got_w = sum(c["权重"] for c in checks if c["通过"])
    score = round(got_w / total_w, 4) if total_w else 0.0

    # 覆盖索引：本次检查覆盖了哪些失效模式
    coverage = {
        "静默丢工具": "MCP 工具数",
        "静默缩分母": "G18 覆盖份数",
        "静默丢产物阶段": "p6 四档情景",
        "指纹漂移": "指纹三方一致",
        "交付面缩小": "产物规模",
    }

    return {
        "名称": "自检闭合",
        "score": score,
        "通过": f"{sum(1 for c in checks if c['通过'])}/{len(checks)}",
        "加权得分": f"{got_w:.1f}/{total_w:.1f}",
        "逐项": checks,
        "失效模式覆盖": coverage,
        "设计原则": ("每项同时报分子与分母。"
                     "『缩小分母换来的 100%』是本项目真实发生过的失效模式，"
                     "故覆盖数本身是判据，不只是比率。"),
        "定位": ("本件是任何递归自我改进的前置条件："
                 "先能检测自己的退步，才谈得上改进的保留。"),
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="typhoeus.selfcheck")
    ap.add_argument("outdir", nargs="?", default="out")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    r = measure(a.outdir)
    if a.json:
        print(json.dumps(r, ensure_ascii=False, indent=2))
    else:
        print(f"  自检 score = {r['score']}  （{r['通过']}，加权 {r['加权得分']}）")
        for c in r["逐项"]:
            mark = "PASS" if c["通过"] else "FAIL"
            print(f"    [{mark}] {c['判据']:<14} 实测 {str(c['实测'])[:44]:<46} "
                  f"应为 {c['应为']}")
            if not c["通过"]:
                print(f"           ↳ {c['说明']}")
        print(f"\n  覆盖的失效模式：{', '.join(r['失效模式覆盖'])}")
    return 0 if r["score"] == 1.0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
