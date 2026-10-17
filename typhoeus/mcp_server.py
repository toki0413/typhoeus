"""提比翁计算内核的 MCP 只读服务。

把六份 L3 编译输出物暴露成六个 MCP 工具。Agent 通过这一层与内核交互，
读到的全部是已落盘、带 schema 版本、带 caveat 的产物。

只读边界（三条，都是硬约束）：

1. **不调 `kernel.run`**。工具只能读 `out/` 里已编译好的 JSON。内核重算
   是 47 s 的确定性计算，不是 Agent 该编排的事——让 Agent 试参数就是在
   把确定性计算变成随机搜索。
2. **不写任何文件**。六个工具全是读，server 启动后对文件系统只做读。
3. **不改参数**。配置由 `typhoeus.cli run`的 config 决定，Agent 无入口。

第四条边界由 `guardrails` 承担：**每次返回都过护栏**，越域、弱基线、
单一口径三类问题直接抛 `RefusalError`，不返回降级答案。护栏放在工具
层而非提示词层，因为提示词约束不住模型，而工具返回是确定性的。

为什么不需要 Code Mode 或惰性加载：六个工具的全量输出是 26 KB，
一次性塞进上下文毫无压力。行业里 MCP token 爆炸的问题（GitHub + Slack +
Sentry 吃掉 71.5% 上下文）来自几十个工具和 MB 级响应，本项目两个条件
都不具备，做折叠或惰性加载是纯过度工程。本 server 的实际瓶颈是磁盘
读取，用进程内缓存解决。

状态缓存：产物文件 mtime + size 作为缓存键。同一批产物被反复问的时候
（Agent 的多轮里这是常态）不重复读盘。产物变了自动失效，不缓存陈旧
结论。
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from .version import KERNEL_VERSION, SCHEMA_VERSION, check_compat
from .guardrails import guard_query, RefusalError

DEFAULT_OUTDIR = Path(__file__).resolve().parent.parent / "out"

# 六个工具 → out/ 里的文件名。键名同时是 MCP 工具名。
_TOOL_FILES = {
    "get_preset_plan": "01_preset_plan",
    "get_recovery_order": "02_recovery_order",
    "get_event_reconciliation": "03_event_reconciliation",
    "get_resilience_pricing": "04_resilience_pricing",
    "get_health_metrics": "05_health_metrics",
    "get_health_report": "06_health_report",
    "get_multievent_calibration": "07_multievent_calibration",
    # 第 8 件：逐点风险卡。最该被 Agent 调用的一件，因为它**自带可信度字段**
    # （trust / trust_why / model_visible / in_domain），
    # 所以"返回一个数让用户误信"的风险在数据层就已处理，不需要靠提示词约束。
    "get_flood_cards": "08_flood_cards",
}


class ArtifactError(RuntimeError):
    """产物缺失或版本不可读。这两类错误对 Agent 的处置方式不同，故单列。"""


class _Cache:
    """产物文件缓存。键是 (path, mtime_ns, size)，产物一改就自动失效。"""

    def __init__(self) -> None:
        self._d: dict[str, tuple[tuple[int, int], dict]] = {}

    def read(self, path: Path) -> dict:
        if not path.exists():
            raise ArtifactError(
                f"产物 {path.name} 不存在。先跑 `python -m typhoeus.cli run` "
                f"生成输出物，本server 只读不重算。")
        st = path.stat()
        key = (st.st_mtime_ns, st.st_size)
        hit = self._d.get(path.name)
        if hit is not None and hit[0] == key:
            return hit[1]
        with open(path, "r", encoding="utf-8") as f:
            payload = json.load(f)
        self._d[path.name] = (key, payload)
        return payload

    def clear(self) -> None:
        self._d.clear()


_CACHE = _Cache()


def _load(outdir: Path, stem: str) -> dict:
    payload = _CACHE.read(outdir / f"{stem}.json")
    verdict = check_compat(payload)
    if not verdict["readable"]:
        # 低于最小可读版本直接拒答，与 `compile.Bundle.write` 写盘前的
        # 行为一致。返回一份标了 `_compat` 的旧产物看起来是"有数据"，
        # Agent 会照着用，而字段含义在那个版本下没有定义——这比拿不到
        # 数据更坏。
        raise ArtifactError(
            f"{stem}.json 版本不可读：{verdict['reason']}。"
            f"重跑 `python -m typhoeus.cli run` 生成本版产物。")
    if not verdict.get("forward_compatible", True):
        payload = dict(payload)
        payload["_compat"] = verdict
    return payload


def _provenance(outdir: Path) -> dict:
    """manifest 里的来源凭据。每个工具的返回都带上它。"""
    mp = outdir / "manifest.json"
    if not mp.exists():
        return {"_degraded": "manifest.json 缺失，无法核验产物来源与配置指纹"}
    m = _CACHE.read(mp)
    out = {
        "内核版本": m.get("kernel_version"),
        "格式版本": m.get("schema_version"),
        "config_hash": m.get("config_hash"),
        "source_hash": m.get("source_hash"),
        "caveat": m.get("caveat"),
    }
    if not out.get("config_hash") or not out.get("source_hash"):
        # 指纹缺失时明说，不让 Agent 把 None 当成一个具体的配置值。
        out["_degraded"] = (
            "manifest 缺 config_hash 或 source_hash，该产物无法与具体"
            "配置绑定，引用前需回查 config.json")
    return out


def _deliver(outdir: Path, stem: str, label: str) -> dict:
    """读产物、过护栏、返回。三步缺一不可，顺序也不能换。"""
    payload = {"产物": label,
               "来源": _provenance(outdir),
               "数据": _load(outdir, stem)}
    return guard_query(payload, outdir)


# 单次对话的工具调用计数。stdio server 进程内的累计值。
# 服务端有进程生命周期，同一次对话对应一批连续调用，所以这个计数
# 对「单次对话」这个概念是够用的近似。真要严格，得由 Agent 侧
# 按会话 ID 传进来——当前没有会话概念，也没必要为一个计数引入它。
_CALL_BUDGET = {"n": 0}


def reset_call_budget() -> None:
    """新一轮对话开始时清零。由 Agent 侧在会话边界调用。"""
    _CALL_BUDGET["n"] = 0


def _deliver_budgeted(outdir: Path, stem: str, label: str) -> dict:
    """带调用预算的交付。超限即拒，不返回部分结果。"""
    from .serving import enforce_call_budget
    enforce_call_budget(_CALL_BUDGET["n"] + 1, "本次对话")
    _CALL_BUDGET["n"] += 1
    return _deliver(outdir, stem, label)


# ---------- 六个只读工具 ----------
# 描述只回答"这个工具回答什么问题"。不写使用方法示例，不写错误处理
# 指南——那是模型该自己从错误返回里学的，写进描述只占context。
# 总量控制在 2 KB 内：六个工具 × 约 300 B。


def get_preset_plan(outdir: str | None = None) -> dict:
    """汛前该在哪里布点、什么时候触发、按什么预案分级。返回预置方案单。"""
    d = Path(outdir) if outdir else DEFAULT_OUTDIR
    return _deliver_budgeted(d, _TOOL_FILES["get_preset_plan"], "预置方案单")


def get_recovery_order(outdir: str | None = None) -> dict:
    """灾后通路抢修按什么顺序做、做对比基线好多少。返回恢复排序单。"""
    d = Path(outdir) if outdir else DEFAULT_OUTDIR
    return _deliver_budgeted(d, _TOOL_FILES["get_recovery_order"], "恢复排序单")


def get_event_reconciliation(outdir: str | None = None) -> dict:
    """一场事件的功能损失怎么分解的、闭合不闭合、实测对不对得上。返回事件对账单。"""
    d = Path(outdir) if outdir else DEFAULT_OUTDIR
    return _deliver_budgeted(d, _TOOL_FILES["get_event_reconciliation"], "事件对账单")


def get_resilience_pricing(outdir: str | None = None) -> dict:
    """减少每1% 功能损失需要多少工程投入，按三档给区间。返回韧性价目表。"""
    d = Path(outdir) if outdir else DEFAULT_OUTDIR
    return _deliver_budgeted(d, _TOOL_FILES["get_resilience_pricing"], "韧性价目表")


def get_health_metrics(outdir: str | None = None) -> dict:
    """这套内核当前有多少条验证指标通过、哪些不达标、哪些缺外部数据未验证。"""
    d = Path(outdir) if outdir else DEFAULT_OUTDIR
    return _deliver_budgeted(d, _TOOL_FILES["get_health_metrics"], "体检指标包")


def get_health_report(outdir: str | None = None) -> dict:
    """一次全链跑下来守恒性、正性、峰值水深、整体结论与数据caveat。"""
    d = Path(outdir) if outdir else DEFAULT_OUTDIR
    return _deliver_budgeted(d, _TOOL_FILES["get_health_report"], "标准体检报告")


def get_multievent_calibration(outdir: str | None = None) -> dict:
    """跨场次的强度—损失关系标了什么、重现期标不出来。返回多事件标定单。"""
    d = Path(outdir) if outdir else DEFAULT_OUTDIR
    return _deliver_budgeted(d, _TOOL_FILES["get_multievent_calibration"],
                "多事件标定单")


def get_flood_cards(outdir: str | None = None) -> dict:
    """某个涝点的积水读数与可信度：实测多少、模型多少、这个读数能不能用。

    不回答单点水深绝对值：28 个点里仅 5 个模型可见，其余点须读该卡的
    trust 与 model_visible 再决定是否引用；看不见的点只能转人工巡查。
    """
    d = Path(outdir) if outdir else DEFAULT_OUTDIR
    return _deliver_budgeted(d, _TOOL_FILES["get_flood_cards"], "逐点风险卡")


_TOOL_FNS = {
    "get_preset_plan": get_preset_plan,
    "get_recovery_order": get_recovery_order,
    "get_event_reconciliation": get_event_reconciliation,
    "get_resilience_pricing": get_resilience_pricing,
    "get_health_metrics": get_health_metrics,
    "get_health_report": get_health_report,
    "get_multievent_calibration": get_multievent_calibration,
    "get_flood_cards": get_flood_cards,
}

#工具描述总字节数。这是本server 的显式预算，不是估计——超了就在
# 自测里FAIL，不靠自觉。
DESC_BUDGET_B = 2048


def tool_descriptors() -> list[dict]:
    """六个工具的 MCP 描述符，供自测与文档共用。"""
    out = []
    for name, fn in _TOOL_FNS.items():
        doc = (fn.__doc__ or "").strip()
        out.append({
            "name": name,
            "description": doc,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "outdir": {
                        "type": "string",
                        "description": "输出物目录，缺省用项目 out/",
                    }
                },
                "required": [],
                "additionalProperties": False,
            },
        })
    return out


def desc_bytes() -> int:
    return sum(len(d["description"].encode("utf-8")) for d in tool_descriptors())


def build_server(outdir: str | None = None):
    """构造 FastMCP server。import 放在函数内，未装 SDK 时模块仍可导入。

    `outdir` 固定后所有工具共用同一个目录，避免 Agent 在参数里猜路径。
    """
    from mcp.server.fastmcp import FastMCP

    fixed = str(Path(outdir) if outdir else DEFAULT_OUTDIR)
    srv = FastMCP(
        "typhoeus",
        instructions=(
            "提比翁城市内涝恢复内核的只读查询服务。回答数值问题用工具，"
            "不要凭常识估计；每个工具返回的『来源』段带 config_hash 与"
            "caveat，引用数字时连同caveat 一起给。降雨量与涝点深度受"
            "再分析分辨率限制，见各产物内的声明段。"
        ),
    )

    for name, fn in _TOOL_FNS.items():
        doc = (fn.__doc__ or "").strip()

        def _make(fn=fn):
            def _tool(outdir: str | None = None) -> dict:
                return fn(outdir or fixed)
            return _tool

        srv.add_tool(_make(), name=name, description=doc)

    return srv


def main(argv=None) -> int:
    import argparse
    ap = argparse.ArgumentParser(prog="typhoeus-mcp")
    ap.add_argument("--outdir", default=None,
                    help="输出物目录，缺省用项目 out/")
    ap.add_argument("--list-tools", action="store_true",
                    help="只打印工具描述与描述总字节数，不启动 server")
    args = ap.parse_args(argv)

    if args.list_tools:
        ds = tool_descriptors()
        for d in ds:
            print(f"{d['name']}  ({len(d['description'].encode('utf-8'))} B)")
            print(f"    {d['description']}")
        n = desc_bytes()
        print(f"\n工具数 {len(ds)}  描述总量 {n} B  预算 {DESC_BUDGET_B} B"
              f"  {'OK' if n <= DESC_BUDGET_B else '超预算'}")
        return 0 if n <= DESC_BUDGET_B else 1

    srv = build_server(args.outdir)
    srv.run()
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())