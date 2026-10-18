"""p49 集合展望：不再让用户手填一个雨量，而是用集合预报回答"要准备几级"。

为什么必须做这一件
------------------
原接口是 `scenario <mm>`：**让用户输入 72 h 面雨量**。
但那个数**没人事先知道**——预报天然是分布，不是单值。
实测 Open-Meteo 的 GFS 集合给出 **31 个成员**，72 h 面雨量可以跨数倍。

所以正确的问法不是「若下 338.8 mm 怎么办」，
而是「**按现在的预报，我该准备几级、准备不足的概率多大**」。

本件做的事
----------
  1 拉集合预报（GFS，31 成员，免注册）
  2 每个成员算 72 h 面雨量
  3 每个成员跑既有的 `scenario.match()` 落档
  4 输出**响应等级的概率分布**，以及"只按中位数准备会漏掉多少"

不跑内核：落档是对面雨量的查表，与内核无关，故秒级完成。

用法：
    python -m typhoeus.outlook                # 默认域中心
    python -m typhoeus.outlook --lat 29.88 --lon 121.625
"""

from __future__ import annotations

import argparse
import json
import ssl
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
CTX = ssl.create_default_context()
UA = {"User-Agent": "Mozilla/5.0 typhoeus-outlook"}

ENSEMBLE = "https://ensemble-api.open-meteo.com/v1/ensemble"
MODELS = ["gfs025", "gfs_seamless"]


def fetch_ensemble(lat: float, lon: float, days: int = 4) -> dict:
    """取集合预报逐时降水，返回 {成员键: [逐时 mm]}。"""
    last = ""
    for model in MODELS:
        url = (f"{ENSEMBLE}?latitude={lat}&longitude={lon}"
               f"&hourly=precipitation&forecast_days={days}"
               f"&timezone=UTC&models={model}")
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA),
                                        timeout=90, context=CTX) as r:
                j = json.loads(r.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}"
            continue
        except Exception as e:  # noqa: BLE001
            last = f"{type(e).__name__}: {str(e)[:50]}"
            continue
        h = j.get("hourly") or {}
        keys = [k for k in h if k.startswith("precipitation")]
        if not keys:
            last = "无集合成员"
            continue
        members = {}
        for k in keys:
            v = [float(x or 0.0) for x in (h.get(k) or [])]
            if v:
                members[k] = v
        return {"模型": model, "成员": members, "lat": lat, "lon": lon}
    raise RuntimeError(f"集合预报取数失败：{last}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="typhoeus.outlook")
    ap.add_argument("outdir", nargs="?", default="out")
    ap.add_argument("--lat", type=float, default=29.880)
    ap.add_argument("--lon", type=float, default=121.625)
    ap.add_argument("--days", type=int, default=4)
    a = ap.parse_args(argv)

    from typhoeus import scenario as SC

    data = fetch_ensemble(a.lat, a.lon, a.days)
    members = data["成员"]
    model = data["模型"]

    # 每个成员算 72 h 面雨量
    totals = {}
    for k, v in members.items():
        totals[k] = round(sum(v[:72]), 1)
    vals = sorted(totals.values())
    n = len(vals)

    def q(p: float) -> float:
        return vals[min(n - 1, max(0, int(round(p * (n - 1)))))]

    # 每个成员落档。**必须声明 basis="forecast"**：集合给的是格点预报值，
    # 而阈值是在「148 站插值」口径下标定的（实测单场差约 0.73 倍）。
    # 不声明就会假装两者同源，把落档概率算得系统性偏低。
    levels = {}
    match_warns: list[str] = []
    for k, mm in totals.items():
        try:
            m = SC.match(mm, basis="forecast")
            lv = m.get("情景档") if isinstance(m, dict) else str(m)
            if isinstance(m, dict) and m.get("告警") and not match_warns:
                match_warns = list(m["告警"])[:1]
        except Exception:  # noqa: BLE001
            lv = "无法落档"
        levels[lv] = levels.get(lv, 0) + 1
    from collections import Counter
    lv_sorted = Counter(levels).most_common()

    # 响应等级（从 scenario 模块的映射取；取不到则直接用档名）
    resp = {}
    for k, mm in totals.items():
        try:
            m = SC.match(mm)
            r = (m.get("响应等级") if isinstance(m, dict) else None) or "未给"
        except Exception:  # noqa: BLE001
            r = "未给"
        resp[r] = resp.get(r, 0) + 1
    resp_sorted = Counter(resp).most_common()

    # 关键指标：只按中位数准备会漏掉多少
    med = q(0.5)
    try:
        med_lv = SC.match(med)
        med_level = (med_lv.get("情景档") if isinstance(med_lv, dict) else None)
    except Exception:  # noqa: BLE001
        med_level = None
    order = ["p50", "p80", "p90", "p95"]
    under = 0
    if med_level in order:
        mi = order.index(med_level)
        for k, mm in totals.items():
            try:
                lv = SC.match(mm)
                l = lv.get("情景档") if isinstance(lv, dict) else None
            except Exception:  # noqa: BLE001
                continue
            if l in order and order.index(l) > mi:
                under += 1

    payload = {
        "名称": "集合展望：按预报我该准备几级",
        "生成时间": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "为什么不是『给定一场雨』": (
            "原接口要求输入 72 h 面雨量，而那个数没人事先知道——"
            "预报天然是分布。本件改用集合预报，输出**响应等级的概率**，"
            "回答『该准备几级、准备不足的概率多大』，而不是『若下 X mm 怎么办』。"),
        "取数": {"模型": model, "成员数": n, "位置": [a.lat, a.lon],
                 "来源": "Open-Meteo ensemble-api（免注册）"},
        "72h面雨量分布_mm": {
            "最小": vals[0], "p10": q(0.1), "p25": q(0.25),
            "中位": q(0.5), "p75": q(0.75), "p90": q(0.9), "最大": vals[-1],
            "极差": round(vals[-1] - vals[0], 1),
        },
        "落档分布": [{"落档": k, "成员数": v,
                   "占比_pct": round(v / n * 100, 1)} for k, v in lv_sorted],
        # 落档用的阈值是在「148 站插值」口径下标定的，而集合给的是格点预报值
        # （实测单场差约 0.73 倍）。不把这条写进产物，概率会被读成绝对值。
        "口径告警": match_warns,
        "口径落差说明": (
            "集合成员是格点预报值（GFS 0.25°），阈值却是在『148 站插值 + 标定』"
            "口径下标定的；实测单场约为站插的 0.73 倍（189.9/259.1，样本 1）。"
            "故本件的落档概率**系统性偏低**，偏低的量级未标定，不可当绝对值引用。"),
        "响应等级分布": [{"等级": k, "成员数": v,
                    "占比_pct": round(v / n * 100, 1)} for k, v in resp_sorted],
        "按中位数准备会漏掉": {
            "中位数_mm": med, "中位数落档": med_level,
            "落档高于中位的成员数": under,
            "占比_pct": round(under / n * 100, 1) if n else None,
        },
        "口径说明": (
            "落档用既有的 `scenario.match()`，面雨量分位仍是 p50/p80/p90/p95"
            "（258.4/313.2/338.8/354.1 mm）。本件**不跑内核**，"
            "只做落档统计，故秒级完成。"),
        "结论": [],
        "边界": [
            "集合成员是**点尺度**（GFS 0.25°，约 25 km），"
            "大于计算域（16.5×8.9 km），故近似当作域平均，但不是真域平均。",
            "集合离散度≠真实不确定性：模式集合常低估极值（详见 convective 评估）。",
            "落档阈值来自历史事件的四档面雨量，不是气候态分位。",
            "GFS 集合对台风路径与强度的不确定性**未纳入**（只取了单点降水）。",
            "本篇不改变任何既有产物的结论；它只是把输入从标量换成分布。",
        ],
    }

    payload["结论"] = [
        (f"**{model} 集合 {n} 个成员**，72 h 面雨量从 {vals[0]} 到 {vals[-1]} mm"
         f"（极差 {payload['72h面雨量分布_mm']['极差']} mm，"
         f"中位 {med} mm，p90 {q(0.9)} mm）。"
         "**这就是为什么『给定一场雨』不现实：同一时次，答案本身就是分布。**"),
        ("按成员落档："
         + "；".join(f"{k} {v} 个（{v/n*100:.0f}%）" for k, v in lv_sorted)
         + "。"),
        ("**最关键的一句**：若只按中位数（"
         f"{med} mm → {med_level}）准备，有 **{under} 个成员（{under/n*100:.0f}%）"
         "落档高于它**——即准备不足。"
         "单值接口**在结构上无法表达这句话**，这就是它不现实的根源。"),
        ("**对使用者的意义**：值班室要的不是『若下 X mm 怎么办』，"
         "而是『按现在的预报，我有多少概率需要更高一级的准备』。"
         "后者才对应真实的调度决策。"),
        ("**但规划岗仍然可以用单值**：设计暴雨本就是给定量"
         "（50 年/100 年一遇），四档 p50–p95 就是它的一个版本。"
         "**所以不是接口错了，是我们把两个用户混用了一个接口。**"),
    ]

    p = Path(a.outdir)
    p.mkdir(parents=True, exist_ok=True)
    (p / "p49_集合展望.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    d = payload["72h面雨量分布_mm"]
    print(f"  模型 {model}  成员 {n}")
    print(f"  72h 面雨量 {d['最小']} / p10 {d['p10']} / 中位 {d['中位']} / "
          f"p90 {d['p90']} / 最大 {d['最大']} mm")
    print("  落档分布：" + "；".join(f"{k} {v}（{v/n*100:.0f}%）"
                                for k, v in lv_sorted))
    print(f"  只按中位准备会漏掉 {under}/{n}（{under/n*100:.0f}%）")
    print(f"→ {p / 'p49_集合展望.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
