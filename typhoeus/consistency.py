"""提比翁 —— G21 跨输出物一致性。

对应《AGENT_POSITIONING_REPORT》第 5.4 节优先级表里的「跨输出物一致性
校验闸」。理由是研究证据：验证闸的位置比验证本身更重要——ICML 2026
FAGEN Workshop《The Hallucination Snowball》报四 Agent 管线注入 346 处
幻觉，GPT-4o 检出率从第一阶段 72.0% 掉到第四阶段 50.9%；在交接处设
boundary gate 把存活率从 58.4% 降到 16.2%，而只在末端检查只带来 2.3 个
百分点改善。

同一逻辑在这里：六份产物各自编译，但读者会跨产物引用数字。校验必须
在**编译期**做，不能等到有人拿两份产物对比时才发现对不上。

**为什么这条门槛不是形式主义。** 首轮实测就抓到一个真问题：事件对账单
的 Q 分解按 2 位小数落盘（Q_climate = 0.44），韧性价目表的依据段存全
精度（0.44471512）。同一份 run 里的同一个量，两份产物给两个值。读者
拿 0.4447 去核对 0.44 会得到"不一致"的结论，而实际上它们来自同一次
计算。精度差不是数值差，但它制造了看起来像数值差的假象。

同类已核对且一致的量（作为对照，说明闸门不是把所有东西都比一遍）：
  面雨量 259.1 mm —— 体检包输入层校验 / 体检报告面雨量 / 体检报告
  水量收支「降雨」259.1 mm，三处同值
  对基线提升 0.2961 —— 恢复排序单 / 体检包门槛 6 实测值 29.6%
  守恒残差 3.80e-09 —— 体检包门槛 7 与体检报告同源
"""
from __future__ import annotations

import json
from pathlib import Path

# 跨产物必须一致的量：(说明, 产物A 的取值路径, 产物B 的取值路径, 容差)
# 容差按"落盘精度"给：产物A 存 2 位时，容差取末位的一半。
CONSISTENCY_PAIRS = (
    ("面雨量",
     ("05_health_metrics", "输入层校验", "model_mm"),
     ("06_health_report", "面雨量_mm"),
     0.05),
    ("面雨量 vs 水量收支降雨",
     ("05_health_metrics", "输入层校验", "model_mm"),
     ("06_health_report", "守恒性", "水量收支_mm", "降雨"),
     0.05),
    ("Q 分解·气候分量",
     ("03_event_reconciliation", "Q分解", "Q_climate"),
     ("04_resilience_pricing", "依据", "气候分量_Q"),
     0.005),
    ("Q 分解·超标分量",
     ("03_event_reconciliation", "Q分解", "Q_excess"),
     ("04_resilience_pricing", "依据", "超标分量_Q"),
     0.005),
    ("Q 分解·工程失效分量",
     ("03_event_reconciliation", "Q分解", "Q_engineering"),
     ("04_resilience_pricing", "依据", "工程失效分量_Q"),
     0.005),
    ("可干预总量 = 超标 + 工程失效",
     ("04_resilience_pricing", "依据", "可干预总量"),
     ("03_event_reconciliation", "Q分解", "Q可干预"),
     0.0005),
    ("对基线提升",
     ("02_recovery_order", "对基线提升"),
     ("05_health_metrics", "门槛6提升"),
     0.0005),
    # 入渗量在 06 内部出现两次：守恒性段按 2 位落盘，入渗与能量段按
    # 4 位落盘。同一份产物里同一个量给两个精度，读起来像两个值。
    # 这不是数值差，但它制造了看起来像数值差的假象——与本模块
    # docstring 记录的首轮实测同一类问题。容差取落盘精度差 0.005。
    ("入渗量·守恒段 vs 能量段",
     ("06_health_report", "守恒性", "水量收支_mm", "下渗"),
     ("06_health_report", "入渗与能量", "下渗_mm"),
     0.005),
)


def _get(obj, path):
    cur = obj
    for p in path:
        if not isinstance(cur, dict) or p not in cur:
            return None, f"路径 {'/'.join(path)} 不存在"
        cur = cur[p]
    return cur, ""


def _load(outdir: Path, stem: str) -> dict | None:
    p = outdir / f"{stem}.json"
    if not p.exists():
        return None
    with open(p, "r", encoding="utf-8") as f:
        return json.load(f)


def check(outdir: Path | None = None) -> dict:
    """逐对核对跨产物数字。不一致即FAIL，路径缺失报BLOCKED。"""
    d = Path(outdir) if outdir else Path(__file__).resolve().parent.parent / "out"
    results = []
    for label, pa, pb, tol in CONSISTENCY_PAIRS:
        a_doc, b_doc = _load(d, pa[0]), _load(d, pb[0])
        if a_doc is None or b_doc is None:
            results.append({"label": label, "status": "BLOCKED",
                            "detail": f"产物缺失：{pa[0] if a_doc is None else pb[0]}"})
            continue
        va, ea = _get(a_doc, list(pa[1:]))
        vb, eb = _get(b_doc, list(pb[1:]))
        if va is None or vb is None:
            results.append({"label": label, "status": "BLOCKED",
                            "detail": (ea or eb or "取值为空")})
            continue
        if isinstance(va, (int, float)) and isinstance(vb, (int, float)):
            diff = abs(float(va) - float(vb))
            ok = diff <= tol
            detail = (f"{va} vs {vb}，差 {diff:.2e}"
                      f"（容差 {tol:g}）")
            results.append({"label": label,
                            "status": "PASS" if ok else "FAIL",
                            "diff": diff, "detail": detail})
        else:
            ok = str(va) == str(vb)
            results.append({"label": label, "status": "PASS" if ok else "FAIL",
                            "detail": f"{va} vs {vb}"})

    n_pass = sum(1 for r in results if r["status"] == "PASS")
    n_fail = sum(1 for r in results if r["status"] == "FAIL")
    n_block = sum(1 for r in results if r["status"] == "BLOCKED")
    return {"n_pairs": len(results), "n_pass": n_pass, "n_fail": n_fail,
            "n_blocked": n_block,
            "rate": round(n_pass / len(results), 4) if results else 0.0,
            "results": results,
            "passed": n_fail == 0}


def as_gate(outdir: Path | None = None) -> dict:
    """转成门槛字典，格式与 `gates._g` 一致。"""
    r = check(outdir)
    if r["n_fail"]:
        status = "FAIL"
    elif r["n_blocked"]:
        status = "BLOCKED"
    else:
        status = "PASS"
    bad = [x for x in r["results"] if x["status"] != "PASS"]
    note = "；".join(f"{x['label']}：{x['detail']}" for x in bad) \
        or f"{r['n_pairs']} 对跨产物引用全部一致"
    if r["n_fail"]:
        note = ("不一致：" + note +
                "。同一份 run 的同一个量在两份产物里给两个值，"
                "读者跨产物核对时会得到假阳性")
    return {
        "id": 21, "content": "跨产物一致性",
        "value": f"{r['n_pass']}/{r['n_pairs']} 对一致",
        "threshold": "不一致率 0", "status": status, "note": note,
        "stage": "revival", "cover": "official",
    }


if __name__ == "__main__":
    rep = check()
    for x in rep["results"]:
        mark = {"PASS": "OK  ", "FAIL": "FAIL", "BLOCKED": "SKIP"}[x["status"]]
        print(f"[{mark}] {x['label']:24s} {x['detail']}")
    g = as_gate()
    print(f"\nG21 {g['value']}门槛 {g['threshold']}  {g['status']}")
    print(f"    {g['note']}")