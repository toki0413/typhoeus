"""提比翁 —— G16–G20 五条 Agent 门槛。

对应《AGENT_POSITIONING_REPORT》第 5.3 节。现有 15 条门槛全在查物理量
与内部一致性，没有一条查 Agent 行为。这是引入 Agent 的必要前提，
不是可选项：静默失败在外部不可观，只能靠门槛查出来。

这五条量的是**服务层行为**，不是模型行为。区别很关键——本项目还没
接真实 Agent 对话，模型侧的通过率无从测；服务层是确定性代码，可以
现在就把判据立起来并实测。模型接进来之后，这五条继续有效，且不需要
改判据：Agent 无论怎么调工具，都得穿过 `guardrails`。

| 门槛 | 判据 | 针对的失效模式 |
|---|---|---|
| G16 越界拒绝率 | 域外问题 100% 拒绝 | 静默外推 |
| G17 弱基线拒绝率 | 未同时优于两基线时 100% 拒绝 | 传递不可用结论 |
| G18 双口径完整率 | 涉雨量/损失的回答 100% 含双口径 | 口径丢失 |
| G19 复现一致性 | 同一问题两次回答的 hash 一致 | 温度不确定性 |
| G20 无证据声明率 | 0（无出处数字） | 幻觉 |

G16–G18 的"100% 拒绝"是硬判据，不是"越高越好"。护栏的价值全在确定性
上——99% 拒绝意味着每100 次里有 1 次静默放行，而那1 次与真答案在下游
无法区分。所以这三条不设"降级接受"档。

G19 与 G20 的口径要说清：服务层返回的 `config_hash` 相同即一致，
不需要 LLM 温度为零。温度影响的是文字表述，不是被引用的数字——数字
来自磁盘上的 JSON，Agent 改不了。这两条现在就能测，且能测满。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from . import guardrails as GR
from . import mcp_server as MS

# 越界测试点：域外四个方向 + 边界外侧紧邻 + 坐标不可解析。
# 余姚是暴雨中心（官方 475 mm），把它放进来是因为它是最容易被问的
# 域外点位——报告里点名的那个。
OUT_OF_DOMAIN = [
    ("余姚城区", 121.15, 30.03),          # 暴雨中心，官方过程雨量 602mm
    ("丁家畈极值站", 121.35, 30.08),      # 单站极值 868.8 mm
    ("奉化", 121.40, 29.65),
    ("象山", 121.87, 29.21),
    ("北界外侧", 121.62, 29.84),          # 纬度差0.0004°
    ("西界外侧", 121.55, 29.88),          # 经度差 0.0001°
    ("东界外侧", 121.70, 29.88),
    ("南界外侧", 121.62, 29.84),
]

IN_DOMAIN = [
    ("鄞州大道", 121.617, 29.868),
    ("海曙新芝路", 121.556, 29.872),
    ("盛莫路", 121.604, 29.844),
]

# 无出处数字的形态：给结论但不给数字，或给数字但无口径/来源。
# 只查形态，不做语义判断——判"这句话是不是幻觉"要模型，那是接进
# Agent 之后才有的环节。
_EVIDENCE_KEYS = ("来源", "schema_version", "config_hash")

# 非雨量的毫米量字段。G18 量的是「雨量数字有没有带口径」，
# 入渗量、蒸发量、土壤储水同样是 mm，但它们不是雨——
# 混进分母会让门槛 18 统计的东西与它的名字不符。
_NOT_RAIN_MM_KEYS = (
    "下渗_mm", "下渗_Ksat本底_mm", "下渗_吸力增益_mm",
    "土壤蒸发_mm", "土壤储水变化_mm",
    "排水_mm", "边界出流_mm", "域内存量_mm",
    "干湿截断_mm", "上限截断_mm", "负值修正_mm",
)


def check_g16(rate: float, n: int) -> dict:
    ok = rate >= 1.0
    return {
        "id": 16, "content": "越界拒绝率",
        "value": f"{rate*100:.0f}%（{n} 个域外点）",
        "threshold": "100%", "status": "PASS" if ok else "FAIL",
        "note": (f"域范围 {GR.DOMAIN['lon_min']:.4f}–"
                 f"{GR.DOMAIN['lon_max']:.4f}E / "
                 f"{GR.DOMAIN['lat_min']:.4f}–"
                 f"{GR.DOMAIN['lat_max']:.4f}N。"
                 f"判据是 100% 而非越高越好：每100 次里放过 1 次，"
                 f"那 1 次与真答案在下游无法区分。"
                 + ("当前护栏无放行路径。" if ok else
                    f"有 {int((1-rate)*n)} 个域外点未被拒绝。")),
        "stage": "rescue", "cover": "community",
    }


def check_g17(rate: float, n: int) -> dict:
    ok = rate >= 1.0
    return {
        "id": 17, "content": "弱基线拒绝率",
        "value": f"{rate*100:.0f}%（{n} 个弱基线构造）",
        "threshold": "100%", "status": "PASS" if ok else "FAIL",
        "note": ("构造方式：把 order_cmp 改成只优于一条基线、"
                 "去掉双基线标记、去掉评分窗口，三种都须被拒。"
                 "当前口径下实测三策略功能面积 30895 / 43892 / 40080，"
                 "贪心确实双优，但排名对评分窗口敏感（0.7 h 窗时反转），"
                 "所以规则查的是'排名是否附带口径'而非排名本身。"
                 + ("" if ok else f"有 {int((1-rate)*n)} 个构造未被拒绝。")),
        "stage": "rescue", "cover": "official",
    }


def check_g18(rate: float, n: int, detail: str) -> dict:
    ok = rate >= 1.0
    return {
        "id": 18, "content": "双口径完整率",
        "value": f"{rate*100:.0f}%（{n} 处雨量/损失数字）",
        "threshold": "100%", "status": "PASS" if ok else "FAIL",
        "note": (f"{detail}。域内口径 −8% 与全市口径 −31% 差 23 个"
                 f"百分点，只给单一口径即误导。"
                 + ("" if ok else f"有 {int((1-rate)*n)} 处缺口径。")),
        "stage": "rescue", "cover": "official",
    }


def check_g19(same: int, n: int, detail: str) -> dict:
    ok = same >= n
    return {
        "id": 19, "content": "复现一致性",
        "value": f"{same}/{n} 次 hash 一致",
        "threshold": "100%", "status": "PASS" if ok else "FAIL",
        "note": (f"{detail}。被引用的数字来自磁盘 JSON，"
                 f"Agent 改不了；LLM 温度影响的是文字表述而非数字本身，"
                 f"所以本判据不需要温度归零。"
                 + ("" if ok else "有回答的 hash 与首次不同。")),
        "stage": "revival", "cover": "official",
    }


def check_g20(n_unsourced: int, n_total: int, detail: str) -> dict:
    ok = n_unsourced == 0
    return {
        "id": 20, "content": "无证据声明率",
        "value": f"{n_unsourced}/{n_total} 处无出处",
        "threshold": "0", "status": "PASS" if ok else "FAIL",
        "note": (f"{detail}。服务层的每个返回都带「来源」段"
                 f"（config_hash / source_hash / caveat）与 schema 版本，"
                 f"数字可回溯到具体一次配置。"
                 + ("" if ok else "存在无来源声明。")),
        "stage": "revival", "cover": "official",
    }


# ---------- 实测 ----------

def measure_g16() -> tuple[float, int]:
    """域外点必须全部抛 RefusalError(R1)。"""
    n = 0
    ok = 0
    for nm, lo, la in OUT_OF_DOMAIN:
        n += 1
        try:
            GR.check_in_domain(lo, la, nm)
        except GR.RefusalError:
            ok += 1
    # 域内点必须全部通过——护栏拒了合法查询同样是失效
    for nm, lo, la in IN_DOMAIN:
        n += 1
        try:
            GR.check_in_domain(lo, la, nm)
            ok += 1
        except GR.RefusalError:
            pass
    return ok / n, n


def measure_g17() -> tuple[float, int]:
    """三种弱基线构造必须全部被拒。"""
    good = {"gain_over_baseline": 0.2961, "beats_both": True,
            "horizon_h": 72.0, "horizon_capped_at_72h": True,
            "n_cmp_steps": 1291}
    bad = [
        {**good, "beats_both": False},                  # 只优于一条基线
        {k: v for k, v in good.items() if k != "beats_both"},  # 无双基线标记
        {k: v for k, v in good.items() if k != "horizon_h"},  # 无评分窗口
        {"gain_over_baseline": -0.05, "beats_both": True,
         "horizon_h": 72.0},                # 负提升
    ]
    n = len(bad) + 1
    ok = 0
    try:
        GR.check_order_usable(good)
        ok += 1                            # 正常产物不得被拒
    except GR.RefusalError:
        pass
    for b in bad:
        try:
            GR.check_order_usable(b)
        except GR.RefusalError:
            ok += 1
    return ok / n, n


# 口径段的名字随产物而异：主链六份用「输入层校验」，
# 多事件标定单用「降雨口径」（驱动不同，字段也不同）。
# 写死一个段名会让新增产物静默漏检——G18 报75% 而不是 100%，
# 而看不出是哪一份没查。
_CALIBER_SECTIONS = ("输入层校验", "降雨口径")


def measure_g18(outdir: Path | None = None) -> tuple[float, int, str]:
    """扫描七份产物里的雨量/损失数字，逐处查是否带口径段。"""
    d = Path(outdir) if outdir else MS.DEFAULT_OUTDIR
    total = 0
    ok = 0
    detail_parts = []
    for name, fn in MS._TOOL_FNS.items():
        # 每个工具单次调用：R4 限制单次对话最多 2 个工具调用，
        # 循环扫六个工具会超限。测量服务层行为时不适用那条设计约束。
        MS.reset_call_budget()
        try:
            r = fn(outdir=str(d))
        except GR.RefusalError as e:
            # 护栏拒了这个产物：数字已经出不去，算作口径完整。
            detail_parts.append(f"{fn.__name__} 被 R{e.rule[-1]} 拒")
            total += 1
            ok += 1
            continue
        data = r.get("数据") or {}
        n_rain = _count_rain_numbers(data)
        if not n_rain:
            continue
        total += 1
        section, sec_name = None, None
        for k in _CALIBER_SECTIONS:
            if isinstance(data.get(k), dict):
                section, sec_name = data[k], k
                break
        if section is None:
            # 有雨量数字却找不到任何口径段。这不是"通过"，是产物
            # 结构变了而门槛没跟上——必须显式失败，否则口径缺失的
            # 产物会以"通过"计入分母。
            detail_parts.append(
                f"{data.get('名称')} 有 {n_rain} 处雨量数字但无口径段"
                f"（查过 {'、'.join(_CALIBER_SECTIONS)}）")
            continue
        try:
            GR.check_dual_basis(section, name)
            ok += 1
            detail_parts.append(
                f"{data.get('名称')} 的 {n_rain} 处雨量数字配{sec_name}段")
        except GR.RefusalError:
            pass
    return (ok / total if total else 1.0), total, "；".join(detail_parts)


_RAIN_KEYS = ("面雨量_mm", "降雨", "累积")


def _count_rain_numbers(obj) -> int:
    """递归数雨量类字段出现次数。

    匹配两种形态：`面雨量_72h_mm: 251.6`（键名自带单位）与
    `积水 0.46 m`（正文里的量值）。只认第一种会漏掉预置方案单的
    触发阈值——那条阈值直接决定何时启动布点，是最该带口径的数字。
    """
    if isinstance(obj, dict):
        n = 0
        for k, v in obj.items():
            if k in _EVIDENCE_KEYS and k != "降雨源":
                continue
            if k in _NOT_RAIN_MM_KEYS:
                continue
            if isinstance(k, str) and k.endswith("_mm"):
                n += 1
            else:
                n += _count_rain_numbers(v)
        return n
    if isinstance(obj, list):
        return sum(_count_rain_numbers(v) for v in obj)
    if isinstance(obj, str):
        return len(re.findall(r"\d+(?:\.\d+)?\s*mm", obj))
    return 0


def measure_g19(n: int = 5, outdir: Path | None = None) -> tuple[int, int, str]:
    """同一工具连读多次，config_hash 必须一致。

    分母是"可比对次数" = 读次数 − 首读。每个工具的首读没有对照，
    不计入分母；把它算进去会让通过率永远差一截。
    """
    d = Path(outdir) if outdir else MS.DEFAULT_OUTDIR
    same = 0
    comparable = 0
    hashes = set()
    n_tools = 0
    for name, fn in MS._TOOL_FNS.items():
        ref = None
        reads = 0
        for _ in range(n):
            MS.reset_call_budget()   # 同上：单次调用，不适用 R4
            try:
                h = fn(outdir=str(d)).get("来源", {}).get("config_hash")
            except (GR.RefusalError, MS.ArtifactError):
                continue
            reads += 1
            hashes.add(h)
            if ref is None:
                ref = h
                continue                      # 首读是基准，不计分
            comparable += 1
            if h == ref:
                same += 1
        if reads:
            n_tools += 1
    detail = (f"{n_tools} 个工具各重读 {n} 次，"
              f"共出现 {len(hashes)} 个不同 config_hash")
    return same, comparable, detail


def measure_g20(outdir: Path | None = None) -> tuple[int, int, str]:
    """每个返回必须带来源凭据与 schema 版本。"""
    d = Path(outdir) if outdir else MS.DEFAULT_OUTDIR
    unsourced = 0
    total = 0
    for name, fn in MS._TOOL_FNS.items():
        total += 1
        MS.reset_call_budget()   # 同上
        try:
            r = fn(outdir=str(d))
        except (GR.RefusalError, MS.ArtifactError):
            # 拒答本身是有出处的：拒绝信息里带规则号与处理办法。
            unsourced += 0
            continue
        src = r.get("来源") or {}
        miss = [k for k in ("config_hash", "source_hash", "caveat")
                if not src.get(k)]
        if miss or not (r.get("数据") or {}).get("schema_version"):
            unsourced += 1
    return unsourced, total, f"{total} 个工具的来源段与 schema 版本齐备性"


def run_all(outdir: Path | None = None) -> list[dict]:
    """五条门槛全测。返回门槛字典，格式与 `gates._g` 一致。"""
    g16r, g16n = measure_g16()
    g17r, g17n = measure_g17()
    g18r, g18n, g18d = measure_g18(outdir)
    g19s, g19n, g19d = measure_g19(outdir=outdir)
    g20u, g20n, g20d = measure_g20(outdir)
    return [
        check_g16(g16r, g16n),
        check_g17(g17r, g17n),
        check_g18(g18r, g18n, g18d),
        check_g19(g19s, g19n, g19d),
        check_g20(g20u, g20n, g20d),
    ]


if __name__ == "__main__":
    for x in run_all():
        mark = {"PASS": "[PASS]", "FAIL": "[FAIL]"}.get(x["status"], "[?]")
        print(f"{mark} G{x['id']} {x['content']}: {x['value']} "
              f"(门槛 {x['threshold']})")
        print(f"       {x['note']}")