"""全量一致性巡检：确认"现有的东西"都还在、还能用、还对得上。

背景：2026-10-17 一天内因工作树覆盖丢失了四样东西
（MCP 工具、G18 口径段、p6 情景矩阵、内核排水乘子），
其中三项**通过了当时的全部测试与门槛**。故需要一件**可重复**的巡检，
而不是再靠人眼。

四段检查
--------
  1 模块可导入（65 个 .py 全部 import）
  2 产物可读（out/ 下全部 JSON 能解析、含必需字段）
  3 服务可调用（8 个 MCP 工具逐个调用，重置调用预算）
  4 文档数字与产物一致（抽查关键引用）

用法：
    python tools/sweep.py           # 全跑
    python tools/sweep.py --fast    # 跳过模块导入（较慢）
"""

from __future__ import annotations

import argparse
import importlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"


def sec(title: str) -> None:
    print("\n" + "=" * 66)
    print(title)
    print("=" * 66)


def sweep_modules() -> list[str]:
    """逐个 import，返回失败清单。"""
    sec("1) 模块可导入")
    mods = sorted(p.stem for p in (ROOT / "typhoeus").glob("*.py"))
    bad = []
    for m in mods:
        if m.startswith("__"):
            continue
        try:
            importlib.import_module(f"typhoeus.{m}")
        except Exception as e:  # noqa: BLE001
            bad.append(f"{m}: {type(e).__name__}: {str(e)[:60]}")
    print(f"  {len(mods)} 个模块，失败 {len(bad)}")
    for b in bad:
        print(f"    ✗ {b}")
    return bad


def sweep_products() -> list[str]:
    """全部产物 JSON 可解析 + 含名称字段。"""
    sec("2) 产物可读")
    files = sorted(list(OUT.glob("p*.json")) + list(OUT.glob("0*.json")))
    bad = []
    for f in files:
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
            if not isinstance(d, dict):
                bad.append(f"{f.name}: 顶层不是对象")
            elif "名称" not in d:
                bad.append(f"{f.name}: 缺『名称』")
        except Exception as e:  # noqa: BLE001
            bad.append(f"{f.name}: {type(e).__name__}")
    html = sorted(list(OUT.glob("p*.html")) + list(OUT.glob("0*.html")))
    print(f"  JSON {len(files)} 个 / HTML {len(html)} 个，异常 {len(bad)}")
    for b in bad:
        print(f"    ✗ {b}")
    return bad


def sweep_tools() -> list[str]:
    """逐个调用 MCP 工具（每个之前重置预算）。"""
    sec("3) 服务可调用")
    from typhoeus import mcp_server as M

    bad = []
    for name, fn in M._TOOL_FNS.items():
        M.reset_call_budget()
        try:
            r = fn()
            if "来源" not in r or "数据" not in r:
                bad.append(f"{name}: 返回缺『来源』或『数据』")
        except Exception as e:  # noqa: BLE001
            bad.append(f"{name}: {type(e).__name__}: {str(e)[:50]}")
    print(f"  {len(M._TOOL_FNS)} 个工具，异常 {len(bad)}")
    print(f"  描述字节 {M.desc_bytes()} / {M.DESC_BUDGET_B}")
    for b in bad:
        print(f"    ✗ {b}")
    return bad


def _load(name: str) -> dict:
    p = OUT / name
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


def sweep_doc_numbers() -> list[str]:
    """抽查文档里引用的关键数字是否仍与产物一致。"""
    sec("4) 文档数字 vs 产物")
    bad = []

    def check(label: str, got, want, tol=0.0):
        ok = (abs(got - want) <= tol) if isinstance(got, (int, float)) else (got == want)
        print(f"    {'✓' if ok else '✗'} {label:<38} 实 {got}  文 {want}")
        if not ok:
            bad.append(f"{label}: 实测 {got} vs 文档 {want}")

    # 产物规模
    # 按 stem 去重：p32_规划决策卡 同时有 .json 与 .html，属**同一件**产物。
    # 按文件计数会把它算两遍（此前巡检器自身就报过错 56 vs 54）。
    stems = {f.stem for f in list(OUT.glob("p*")) + list(OUT.glob("0*"))}
    check("产物总数(去重)", len(stems), 55, 0)

    # 指纹
    from typhoeus import config as CFG
    check("config_hash", CFG.Config().hash(), "e464fea5962b")

    # 门槛
    hm = _load("05_health_metrics.json")
    rows = hm.get("明细") or []
    from collections import Counter
    c = Counter(r["状态"] for r in rows)
    check("门槛总数", len(rows), 27, 0)
    check("PASS", c.get("PASS", 0), 15, 0)
    check("FAIL", c.get("FAIL", 0), 5, 0)
    check("BLOCKED", c.get("BLOCKED", 0), 7, 0)

    # 跨事件
    p33 = _load("p33_跨事件决策矩阵.json")
    mono = p33.get("跨事件单调性") or {}
    rho = mono.get("Spearman_ρ")
    check("跨事件 rho", rho, 0.9945, 1e-3)

    # 四色
    p34 = _load("p34_逐场四色面积.json")
    s34 = p34.get("汇总") or {}
    check("出现红格场次", s34.get("出现过红格的场次"), 8, 0)
    check("实算成功场次", s34.get("实算成功"), 16, 0)

    # 四轴杠杆
    p44 = _load("p44_四轴杠杆对比.json")
    lev = {x["轴"]: x["峰值倍数"] for x in (p44.get("杠杆排序") or [])}
    d_key = next((k for k in lev if "排水" in k), None)
    c_key = next((k for k in lev if "集中度" in k), None)
    a_key = next((k for k in lev if "总量" in k), None)
    s_key = next((k for k in lev if "土壤" in k), None)
    if d_key:
        check("排水杠杆", lev[d_key], 2.813, 1e-2)
    if c_key:
        check("集中度杠杆", lev[c_key], 1.642, 1e-2)
    if a_key:
        check("总量杠杆", lev[a_key], 1.19, 2e-2)
    if s_key:
        check("土壤杠杆", lev[s_key], 1.011, 1e-2)

    # p6 四档与橙格
    p6 = _load("p6_情景矩阵.json")
    sc = p6.get("情景") or []
    check("p6 档数", len(sc), 4, 0)
    if len(sc) >= 2:
        a, b = sc[0], sc[-1]
        ca = (a.get("四色格点数") or {}).get("橙 0.2-0.5m", 0)
        cb = (b.get("四色格点数") or {}).get("橙 0.2-0.5m", 0)
        check("橙格 p50", ca, 1054, 2)
        check("橙格 p95", cb, 1825, 0)

    # 土壤敏感性
    p37 = _load("p37_土层厚度敏感性.json")
    j = p37.get("判读") or {}
    if j.get("600mm_峰值变化_pct") is not None:
        check("土层600mm峰值变化%", j["600mm_峰值变化_pct"], -4.7, 5e-1)

    return bad


def sweep_docs_links() -> list[str]:
    """README / submission 的相对链接是否存在。"""
    sec("5) 文档相对链接")
    import re

    bad = []
    for f in [ROOT / "README.md",
              *sorted((ROOT / "submission").glob("*.md")),
              *sorted((ROOT / "docs").glob("*.md"))]:
        if not f.exists():
            continue
        s = f.read_text(encoding="utf-8")
        links = re.findall(r"\]\((?!http|#)([^)#]+)\)", s)
        miss = []
        for l in links:
            # 本仓库用 `path:24` / `path:24-30` 标注行号，那不是路径的一部分。
            # 不剥掉会误报断链（此前巡检器自身就报过 README.md:21 缺）。
            raw = l
            l = re.sub(r":\d+(-\d+)?$", "", l)
            if not re.fullmatch(r"[^\s]+", l or ""):
                continue
            if not (f.parent / l).resolve().exists():
                miss.append(raw)
        if miss:
            bad.append(f"{f.name}: 缺 {miss[:3]}")
    print(f"  检查 {len(list((ROOT / 'docs').glob('*.md'))) + 5} 个文件，"
          f"断链 {len(bad)} 处")
    for b in bad:
        print(f"    ✗ {b}")
    return bad


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="sweep")
    ap.add_argument("--fast", action="store_true", help="跳过模块导入")
    a = ap.parse_args(argv)

    allbad: dict[str, list[str]] = {}
    if not a.fast:
        allbad["模块"] = sweep_modules()
    allbad["产物"] = sweep_products()
    allbad["工具"] = sweep_tools()
    allbad["数字"] = sweep_doc_numbers()
    allbad["链接"] = sweep_docs_links()

    sec("汇总")
    total = sum(len(v) for v in allbad.values())
    for k, v in allbad.items():
        print(f"  {k:<4} {'OK' if not v else f'{len(v)} 处异常'}")
    print(f"\n  合计异常 {total}")
    return 0 if total == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
