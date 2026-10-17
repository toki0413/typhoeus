"""MCP server 自测：100 次调用的通过率。

方法学照 Digital Applied 2026 年 2-4 月对 100 个生产 MCP server 的
约 12,000 次试验：中位通过率 71%，最佳十分位 ≥95%，最大单一失败类是
schema 不匹配（占 38%）。判据取 95%，对应最佳十分位。

"通过"的定义要严：返回了 JSON、产物名对、来源凭据齐、schema 版本
过兼容性检查、关键字段非空。返回了 `null` 不算通过——那是没答出来。

随机化工具选择与重复次数，避免测出的是缓存命中率而不是稳定性。
"""
from __future__ import annotations

import json
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from typhoeus import mcp_server as MS          # noqa: E402
from typhoeus import guardrails as GR          # noqa: E402
from typhoeus.version import check_compat      # noqa: E402

N_TRIALS = 100
PASS_THRESHOLD = 0.95

REQUIRED_PROVENANCE = ("内核版本", "格式版本", "config_hash",
                       "source_hash", "caveat")
REQUIRED_GUARD = ("R1_越域", "R2_弱基线", "R3_单口径")


def _one_call(fn, name) -> tuple[bool, str]:
    try:
        r = fn()
    except (MS.ArtifactError, GR.RefusalError) as e:
        #拒答不是失败，是护栏在按设计工作。但拒答必须带规则号与
        # 处理办法，否则下游无从处置——那种拒答才计入失败。
        d = e.as_dict() if isinstance(e, GR.RefusalError) else {}
        if isinstance(e, GR.RefusalError):
            if not (d.get("rule") and d.get("reason") and d.get("remedy")):
                return False, "拒答缺规则号或处理办法"
            return True, ""
        return False, str(e)
    try:
        if not isinstance(r, dict):
            return False, f"返回类型 {type(r).__name__}，应为 dict"
        if not r.get("产物"):
            return False, "缺产物名"
        prov = r.get("来源") or {}
        miss = [k for k in REQUIRED_PROVENANCE if not prov.get(k)]
        if miss:
            return False, f"来源缺 {miss}"
        guard = r.get("护栏") or {}
        gmiss = [k for k in REQUIRED_GUARD if k not in guard]
        if gmiss:
            return False, f"护栏回执缺 {gmiss}"
        data = r.get("数据")
        if not isinstance(data, dict):
            return False, "数据段不是 dict"
        if not data.get("名称"):
            return False, "数据段缺名称"
        v = check_compat(data)
        if not v["readable"]:
            return False, f"schema 不可读：{v['reason']}"
        if "_compat" not in data and not v.get("forward_compatible", True):
            return False, "向前兼容告警未透出"
    except Exception as e:                # noqa: BLE001
        return False, f"校验时 {type(e).__name__}: {e}"
    return True, ""


def run_faults() -> dict:
    """故障注入。只跑 happy path 的通过率没有信息量——数字会是 100%。

    按 Cascade-Bench 的做法在关键环节制造故障，看 server 是把问题
    透出来还是吞掉。吞掉的比报错的更糟：Agent 拿到一个看起来正常的
    空结果，会当成"没有积水"或"没有超标的门槛"。
    """
    import shutil
    import tempfile

    from typhoeus.version import MIN_READABLE_SCHEMA

    cases: list[dict] = []

    def _case(name, expect, fn):
        MS.reset_call_budget()
        try:
            r = fn()
            got = "ok"
            detail = ""
            if expect == "raise":
                cases.append({"case": name, "expect": expect, "got": got,
                              "ok": False, "detail": "未抛错"})
                return
            detail = json.dumps(r, ensure_ascii=False)[:80]
            cases.append({"case": name, "expect": expect, "got": got,
                          "ok": True, "detail": detail})
        except Exception as e:                     # noqa: BLE001
            got = f"{type(e).__name__}"
            ok = (expect == "raise")
            cases.append({"case": name, "expect": expect, "got": got,
                          "ok": ok,
                          "detail": str(e)[:160]})

    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)

        # 1目录不存在 -> 必须抛错，且错里含可执行动作
        _case("目录不存在", "raise",
              lambda: MS.get_health_report(outdir=str(tmp / "nope")))

        # 2 单份产物缺失 -> 抛错，不返回半份
        d1 = tmp / "d1"
        shutil.copytree(MS.DEFAULT_OUTDIR, d1)
        (d1 / "05_health_metrics.json").unlink()
        _case("单份产物缺失", "raise",
              lambda: MS.get_health_metrics(outdir=str(d1)))

        # 3 JSON 语法损坏 -> 抛错而不是返回空
        d2 = tmp / "d2"
        shutil.copytree(MS.DEFAULT_OUTDIR, d2)
        (d2 / "01_preset_plan.json").write_text("{ 名称: ", encoding="utf-8")
        _case("JSON 损坏", "raise",
              lambda: MS.get_preset_plan(outdir=str(d2)))

        # 4 schema 低于最小可读版本 -> 必须拒答。返回一份字段含义
        # 未定义的旧产物比拿不到数据更坏。
        d3 = tmp / "d3"
        shutil.copytree(MS.DEFAULT_OUTDIR, d3)
        p = d3 / "06_health_report.json"
        o = json.loads(p.read_text(encoding="utf-8"))
        o["schema_version"] = "2.9.0"
        p.write_text(json.dumps(o, ensure_ascii=False), encoding="utf-8")
        _case("schema 过旧拒答", "raise",
              lambda: MS.get_health_report(outdir=str(d3)))

        # 5 schema 高于本内核 -> 仍返回，但带 _compat 告警
        d4 = tmp / "d4"
        shutil.copytree(MS.DEFAULT_OUTDIR, d4)
        p4 = d4 / "06_health_report.json"
        o4 = json.loads(p4.read_text(encoding="utf-8"))
        o4["schema_version"] = "99.0.0"
        p4.write_text(json.dumps(o4, ensure_ascii=False), encoding="utf-8")
        _case("schema 过新告警", "ok", lambda: MS.get_health_report(outdir=str(d4)))

        # 6 manifest 缺失 -> 来源段退化为标注缺失，不崩
        d5 = tmp / "d5"
        shutil.copytree(MS.DEFAULT_OUTDIR, d5)
        (d5 / "manifest.json").unlink()
        _case("manifest 缺失", "ok", lambda: MS.get_health_report(outdir=str(d5)))

        # 7 manifest 存在但字段空 -> 来源段不得凭空造值
        d6 = tmp / "d6"
        shutil.copytree(MS.DEFAULT_OUTDIR, d6)
        (d6 / "manifest.json").write_text(
            json.dumps({"schema_version": MIN_READABLE_SCHEMA},
                       ensure_ascii=False), encoding="utf-8")
        _case("manifest 字段空", "ok", lambda: MS.get_health_report(outdir=str(d6)))

        # 8 护栏被绕过：抽掉双基线标记，工具必须拒答而不是照常返回
        d7 = tmp / "d7"
        shutil.copytree(MS.DEFAULT_OUTDIR, d7)
        p7 = d7 / "02_recovery_order.json"
        o7 = json.loads(p7.read_text(encoding="utf-8"))
        o7["同时优于两基线"] = False
        p7.write_text(json.dumps(o7, ensure_ascii=False), encoding="utf-8")
        _case("护栏R2 弱基线", "raise",
              lambda: MS.get_recovery_order(outdir=str(d7)))

        # 9 护栏被绕过：剥掉双口径段，只留单一口径
        d8 = tmp / "d8"
        shutil.copytree(MS.DEFAULT_OUTDIR, d8)
        p8 = d8 / "05_health_metrics.json"
        o8 = json.loads(p8.read_text(encoding="utf-8"))
        o8["输入层校验"].pop("rel_err_allcity", None)
        p8.write_text(json.dumps(o8, ensure_ascii=False), encoding="utf-8")
        _case("护栏 R3 单口径", "raise",
              lambda: MS.get_health_metrics(outdir=str(d8)))

        # 10 护栏被绕过：抽掉预置方案单的输入层校验，触发阈值失去口径
        d9 = tmp / "d9"
        shutil.copytree(MS.DEFAULT_OUTDIR, d9)
        p9 = d9 / "01_preset_plan.json"
        o9 = json.loads(p9.read_text(encoding="utf-8"))
        o9.pop("输入层校验", None)
        p9.write_text(json.dumps(o9, ensure_ascii=False), encoding="utf-8")
        _case("护栏 R3 阈值缺口径", "raise",
              lambda: MS.get_preset_plan(outdir=str(d9)))

    n_ok = sum(1 for c in cases if c["ok"])
    return {
        "n_cases": len(cases),
        "n_ok": n_ok,
        "rate": round(n_ok / len(cases), 4),
        "cases": cases,
    }


def run(n=N_TRIALS, seed=20210725) -> dict:
    rng = random.Random(seed)
    names = list(MS._TOOL_FNS)
    fails: list[tuple[str, str]] = []
    lat: list[float] = []
    per_tool: dict[str, list[bool]] = {k: [] for k in names}

    for _ in range(n):
        name = rng.choice(names)
        MS.reset_call_budget()   # R4 限制单次对话 2 个调用，自测是批量
        t0 = time.perf_counter()
        ok, why = _one_call(MS._TOOL_FNS[name], name)
        lat.append(time.perf_counter() - t0)
        per_tool[name].append(ok)
        if not ok:
            fails.append((name, why))

    rate = 1.0 - len(fails) / n
    lat.sort()
    return {
        "n": n,
        "pass_rate": round(rate, 4),
        "threshold": PASS_THRESHOLD,
        "passed": rate >= PASS_THRESHOLD,
        "n_fail": len(fails),
        "fails": fails[:10],
        "latency_ms": {
            "p50": round(lat[len(lat) // 2] * 1000, 3),
            "p95": round(lat[int(len(lat) * 0.95)] * 1000, 3),
            "max": round(lat[-1] * 1000, 3),
        },
        "per_tool": {k: f"{sum(v)}/{len(v)}" for k, v in per_tool.items()},
        "desc_bytes": MS.desc_bytes(),
        "desc_budget_b": MS.DESC_BUDGET_B,
    }


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    rep = run()
    print(json.dumps(rep, ensure_ascii=False, indent=2))
    for k in MS._TOOL_FNS:
        print(f"  {k:28s} {rep['per_tool'][k]}")
    print(f"\n通过率 {rep['pass_rate']*100:.0f}%（{rep['n']} 次，"
          f"判据 ≥{rep['threshold']*100:.0f}%）  "
          f"{'PASS' if rep['passed'] else 'FAIL'}")
    print(f"延迟 p50 {rep['latency_ms']['p50']:.2f} ms  "
          f"p95 {rep['latency_ms']['p95']:.2f} ms")

    fr = run_faults()
    print(f"\n--- 故障注入 {fr['n_ok']}/{fr['n_cases']} ---")
    for c in fr["cases"]:
        mark = "OK  " if c["ok"] else "MISS"
        print(f"  [{mark}] {c['case']:14s} 期望 {c['expect']:5s} "
              f"实得 {c['got']:20s} {c['detail']}")

    ok = rep["passed"] and fr["rate"] >= 1.0
    sys.exit(0 if ok else 1)