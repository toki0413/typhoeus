"""提比翁计算内核的 MCP 只读服务。

把八份 L3 编译输出物暴露成八个 MCP 工具，外加一个坐标查询视图
（`get_point_depth`）——它是 R1 越域拒绝的唯一入口。Agent 通过这一层
与内核交互，读到的全部是已落盘、带 schema 版本、带 caveat 的产物。

只读边界（三条，都是硬约束）：

1. **不调 `kernel.run`**。工具只能读 `out/` 里已编译好的 JSON。内核重算
   是 47 s 的确定性计算，不是 Agent 该编排的事——让 Agent 试参数就是在
   把确定性计算变成随机搜索。
2. **不写任何文件**。九个工具全是读，server 启动后对文件系统只做读。
3. **不改参数**。配置由 `typhoeus.cli run`的 config 决定，Agent 无入口。

第四条边界由 `guardrails` 承担：**每次返回都过护栏**，越域、弱基线、
单一口径三类问题直接抛 `RefusalError`，不返回降级答案。护栏放在工具
层而非提示词层，因为提示词约束不住模型，而工具返回是确定性的。

为什么不需要 Code Mode 或惰性加载：九个工具的全量输出约 90 KB，
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
import math
import os
from pathlib import Path
from typing import Any

from typing import Annotated, Any

from .version import KERNEL_VERSION, SCHEMA_VERSION, check_compat
from .guardrails import guard_query, check_in_domain, RefusalError

# 参数描述只有走 pydantic Field 才进得了 JSON Schema——`Annotated[float, "…"]`
# 会被 FastMCP 1.29 整条丢掉（实测：字符串元数据不进 properties.description）。
# pydantic 是 mcp SDK 的依赖，但本模块要求"未装 SDK 时仍可 import"，
# 故降级成裸 float：没有 mcp 就没有 server，Schema 也就无从谈起。
_LON_DESC = "经度（十进制度），如 121.617"
_LAT_DESC = "纬度（十进制度），如 29.818"
try:  # pragma: no cover - 取决于环境里有没有 mcp/pydantic
    from pydantic import Field as _Field

    _LON_ARG: Any = Annotated[float, _Field(description=_LON_DESC)]
    _LAT_ARG: Any = Annotated[float, _Field(description=_LAT_DESC)]
except Exception:  # noqa: BLE001
    _LON_ARG = float
    _LAT_ARG = float

from . import paths as _paths

DEFAULT_OUTDIR = _paths.out_dir()

# 八个产物工具 → out/ 里的文件名。键名同时是 MCP 工具名。
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
    # "返回一个数让用户误信"的风险在数据层就已处理，不需靠提示词兜。
    # 注：本项曾在一次工作树覆盖中丢失（mcp_server.py 被旧版本整体替换），此处恢复。
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
    # 同一句 caveat 不在一次回答里说两遍。manifest 与产物各带一份，
    # 逐字相同时来源段只留指针——边界要少而硬，不是多而软：
    # 重复的话读者会跳过去，跳过去的边界等于没有边界。
    src_cav = payload["来源"].get("caveat")
    dat_cav = (payload["数据"] or {}).get("caveat")
    if (isinstance(src_cav, str) and isinstance(dat_cav, str)
            and src_cav.strip() == dat_cav.strip()):
        payload["来源"]["caveat"] = "同『数据.caveat』（与 manifest 逐字相同）"
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


# ---------- 八份产物 → 八个只读工具 ----------
# 描述只回答"这个工具回答什么问题"。不写使用方法示例，不写错误处理
# 指南——那是模型该自己从错误返回里学的，写进描述只占context。
# 总量控制在 2 KB 内：九个工具 × 约 120 B。


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


# ---------- 第九个工具：坐标查询（R1 越域的唯一入口） ----------
# 它不读新产物，是 08 涝点卡在坐标上的视图。**不并入 `_TOOL_FNS`**：
# 那张表被 G18/G19/G20 当成「八份产物各一个工具」逐份扫，混进一个视图
# 工具会让分母失真，也会让 test_mcp_tools_match_artifacts_exactly 的
# 「一份产物一个工具」断掉。故另立一张表，两者在 build_server 里合并。

# 1 km：28 个台账点在 0.15°×0.08° 的域内平均间距 1–3 km。取 1 km 是
# 「最近的台账点还算同一个位置」的上界；超过就不给数，只说没有。
_NEAR_RADIUS_M = 1000.0


def _haversine_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    """两点球面距离。

    用球面公式而不是度差：1 度纬度 ≈ 111 km，1 度经度在 29.9°N ≈ 96 km，
    两者不等，按度差取最近点会系统性偏向东西方向。
    """
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = (math.sin(dp / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2)
    return 2 * r * math.asin(math.sqrt(a))


def get_point_depth(lon: _LON_ARG, lat: _LAT_ARG,
                    outdir: str | None = None) -> dict:
    """这个坐标淹多深、模型覆盖没覆盖。域外一律拒答（R1），不降级外推。

    域内只给最近的涝点台账读数，不插值：模型水深只在 28 个台账点上有
    定义，任意坐标的水深要重跑内核，本服务只读不重算。
    """
    if outdir:
        d = Path(outdir)
    elif Path("out").exists():
        d = Path("out")
    else:
        d = DEFAULT_OUTDIR
    # 主域之外先看有没有跑过的外域结果（out/cities/<城>/），有就答该城，
    # 没有就给出可算路径——不再把坐标一概拒掉。
    try:
        q = check_in_domain(lon, lat, "查询点")
    except RefusalError:
        hit = None
        for p in sorted((d / "cities").glob("*/city.json")) if (d / "cities").exists() else []:
            try:
                o = json.loads(p.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            c = o.get("中心坐标") or []
            if len(c) == 2 and abs(c[0] - lon) <= 0.08 and abs(c[1] - lat) <= 0.05:
                hit = (p.parent.name, o)
                break
        if hit is None:
            names = [p.parent.name for p in (d / "cities").glob("*/city.json")] \
                if (d / "cities").exists() else []
            return {"已算外域": names,
                    "说明": (f"({lon:.4f}, {lat:.4f}) 不在已算范围内。"
                           "可用 `typhoeus city --name <城> --lon <经度> --lat <纬度>` "
                           "先算一片再查。")}
        name, o = hit
        return {"城": name, "中心坐标": o.get("中心坐标"),
                "面雨量_mm": (o.get("降雨") or {}).get("面雨量_mm"),
                "峰值水深_m": (o.get("结果") or {}).get("峰值水深_m"),
                "峰值位置": (o.get("结果") or {}).get("峰值位置"),
                "分级面积占比": (o.get("结果") or {}).get("分级面积占比"),
                "说明": "该点在外域结果覆盖范围内；参数未按本城重标，只给结构与量级。"}
    cards = _load(d, _TOOL_FILES["get_flood_cards"]).get("卡片") or []

    best: dict | None = None
    best_m: float | None = None
    for c in cards:
        if c.get("lon") is None or c.get("lat") is None:
            continue
        m = _haversine_m(q["lon"], q["lat"], c["lon"], c["lat"])
        if best_m is None or m < best_m:
            best, best_m = c, m

    near = best is not None and best_m is not None and best_m <= _NEAR_RADIUS_M
    if near:
        readout = {
            "point_id": best.get("point_id"),
            "name": best.get("name"),
            "district": best.get("district"),
            "structure_type": best.get("structure_type"),
            "obs_depth_m": best.get("obs_depth_m"),
            "obs_level": best.get("obs_level"),
            "model_depth_m": best.get("model_depth_m"),
            "model_level": best.get("model_level"),
            "model_visible": best.get("model_visible"),
            "trust": best.get("trust"),
            "trust_why": best.get("trust_why"),
            "model_depth_corrected_m": best.get("model_depth_corrected_m"),
            "correction_band_m": best.get("correction_band_m"),
            "correction_note": best.get("correction_note"),
            "人工处置": best.get("人工处置"),
            "读数时间": (best.get("source") or {}).get("observed_at"),
        }
        note = (
            f"这是距离该坐标 {best_m:.0f} m 的台账点 {best.get('point_id')} "
            f"的读数，**不是该坐标的水深**。模型水深只在这 28 个台账点上"
            f"有定义，坐标间不插值。引用 model_depth_m 时须同时引用该点的 "
            f"trust 与 model_visible；model_visible=false 时不得报模型水深。")
    else:
        readout = None
        note = (
            f"该坐标 {_NEAR_RADIUS_M:.0f} m 内没有涝点台账记录"
            + (f"（最近的 {best.get('point_id')} 距 "
               f"{best_m:.0f} m）" if best is not None and best_m is not None
               else "")
            + "。本内核的模型水深只在 28 个台账点上有定义，任意坐标的水深"
              "要重跑内核——本服务只读，不重算，因此这里不给数。"
              "请改用台账点坐标再问。")

    payload: dict[str, Any] = {
        "产物": "点位水深查询",
        "来源": _provenance(d),
        "查询": {
            "lon": q["lon"],
            "lat": q["lat"],
            "in_domain": True,
            "搜索半径_m": _NEAR_RADIUS_M,
            "最近台账点": (f"{best.get('point_id')} {best.get('name')}"
                        if best is not None else None),
            "距离_m": round(best_m, 1) if best_m is not None else None,
        },
        "数据": {
            "名称": "点位水深查询",
            "schema_version": SCHEMA_VERSION,
            "坐标": {"lon": q["lon"], "lat": q["lat"]},
            "可回答": bool(near),
            "读数": readout,
            "说明": note,
        },
    }
    return guard_query(payload, d, r1_checked=True)


def get_city_scenario(city: str = "", outdir: str | None = None) -> dict:
    """外域推演结果：列出已跑过的城市，或读某一城的峰值水深与出处。

    这些城市不在标定域内，参数未按当地重标，只给结构与量级结论。
    """
    d = Path(outdir) if outdir else DEFAULT_OUTDIR
    root = d / "cities"
    if not root.exists():
        return {"城市": [], "说明": "还没有外域结果，先跑 `typhoeus city`。"}
    items = []
    for p in sorted(root.glob("*/city.json")):
        try:
            o = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        items.append({
            "城市": p.parent.name,
            "中心坐标": o.get("中心坐标"),
            "面雨量_mm": (o.get("降雨") or {}).get("面雨量_mm"),
            "峰值水深_m": (o.get("结果") or {}).get("峰值水深_m"),
            "峰值时刻_h": (o.get("结果") or {}).get("峰值时刻_h"),
            "产物": (o.get("产物") or {}).get("峰值水深栅格"),
        })
    if not city:
        return {"城市": items, "说明": "参数未按当地重标，只给结构与量级结论。"}
    hit = next((x for x in items if x["城市"] == city), None)
    if hit is None:
        return {"城市": items, "说明": f"没有名为 {city} 的外域结果。"}
    full = json.loads((root / city / "city.json").read_text(encoding="utf-8"))
    return {"城市": hit, "明细": full}


_POINT_TOOL_FNS = {"get_point_depth": get_point_depth}
_CITY_TOOL_FNS = {"get_city_scenario": get_city_scenario}
_ALL_TOOL_FNS = {**_TOOL_FNS, **_POINT_TOOL_FNS, **_CITY_TOOL_FNS}

#工具描述总字节数。这是本server 的显式预算，不是估计——超了就在
# 自测里FAIL，不靠自觉。
DESC_BUDGET_B = 2048


def _no_arg_schema() -> dict:
    """产物工具不收任何参数。

    2026-10-18 之前这里带一个 `outdir` 参数。它让「固定目录」只是默认值
    而不是约束——模型可以传别的路径去读别处的 JSON，只读边界还在，但
    审计口径会漂。现在目录由 `--outdir` 一次性钉死在 server 进程里，
    参数表里不再出现它。
    """
    return {"type": "object", "properties": {}, "required": [],
            "additionalProperties": False}


def _coord_schema() -> dict:
    return {
        "type": "object",
        "properties": {
            "lon": {"type": "number", "description": _LON_DESC},
            "lat": {"type": "number", "description": _LAT_DESC},
        },
        "required": ["lon", "lat"],
        "additionalProperties": False,
    }


def _city_schema() -> dict:
    return {
        "type": "object",
        "properties": {
            "city": {"type": "string",
                     "description": "城市名，例如「台州」。留空则列出全部已跑城市。"},
        },
        "required": [],
        "additionalProperties": False,
    }


def tool_descriptors() -> list[dict]:
    """十个工具的 MCP 描述符，供自测与文档共用。"""
    out = []
    for name, fn in _ALL_TOOL_FNS.items():
        doc = (fn.__doc__ or "").strip()
        if name in _POINT_TOOL_FNS:
            schema = _coord_schema()
        elif name in _CITY_TOOL_FNS:
            schema = _city_schema()
        else:
            schema = _no_arg_schema()
        out.append({"name": name, "description": doc, "inputSchema": schema})
    return out


def desc_bytes() -> int:
    return sum(len(d["description"].encode("utf-8")) for d in tool_descriptors())


def build_server(outdir: str | None = None):
    """构造 FastMCP server。import 放在函数内，未装 SDK 时模块仍可导入。

    `outdir` 钉死后所有工具共用同一个目录，**且参数表里不暴露它**——
    Agent 猜不到路径，也改不了口径。
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

    for name, fn in _ALL_TOOL_FNS.items():
        doc = (fn.__doc__ or "").strip()

        if name in _POINT_TOOL_FNS:
            def _make_point(fn=fn):
                # 注解必须挂在这个 wrapper 上：注册给 MCP 的是它，不是
                # `get_point_depth` 本身，Schema 也只从它推。
                def _tool(lon: _LON_ARG, lat: _LAT_ARG) -> dict:
                    return fn(lon, lat, fixed)
                return _tool

            srv.add_tool(_make_point(), name=name, description=doc)
            continue

        def _make(fn=fn):
            def _tool() -> dict:
                return fn(fixed)
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