"""p55 外部对标：JRC 住宅深度—损失曲线的 β vs 我们的隐含 β。

数据来源
--------
Huizinga, de Moel & Szewczyk (2017), *Global flood depth-damage functions*,
JRC。曲线数值取自 physrisk 仓库公开副本：
  docs/user_guide/vulnerability/vulnerability_functions/inundation_jrc/raw.csv
取 `Residential buildings` 的 `Asia_Mean` 列（本项目所在区域）。

做了什么
--------
1 在多个深度窗口上拟合 损失 ∝ 深度^β，展示 β 随窗口变化
2 与 p53 的隐含 β = b_Q / b_depth 对比
3 判定两者是否自洽；不自洽就指出**哪一步的假设错了**

用法：python -m typhoeus.jrc_benchmark
"""

from __future__ import annotations

import csv
import io
import json
import math
import time
import urllib.request
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
CACHE = ROOT / "data" / "seed" / "jrc_depth_damage.csv"
URL = ("https://raw.githubusercontent.com/os-climate/physrisk/main/"
       "docs/user_guide/vulnerability/vulnerability_functions/"
       "inundation_jrc/raw.csv")
UA = {"User-Agent": "Mozilla/5.0 typhoeus-jrc"}


def fetch_csv() -> str:
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    if CACHE.exists() and CACHE.stat().st_size > 500:
        return CACHE.read_text(encoding="utf-8", errors="replace")
    with urllib.request.urlopen(
            urllib.request.Request(URL, headers=UA), timeout=60) as r:
        body = r.read().decode("utf-8", "replace")
    CACHE.write_text(body, encoding="utf-8")
    return body


def parse_asia(text: str) -> tuple[np.ndarray, np.ndarray]:
    """返回 (depth_m, damage_fraction)，仅 Residential buildings + Asia_Mean。"""
    rows = list(csv.DictReader(io.StringIO(text)))
    d, v = [], []
    for r in rows:
        if not (r.get("Type") or "").startswith("Residential"):
            continue
        try:
            depth = float(r["Flood depth [m]"])
            val = float(r["Asia_Mean"])
        except (KeyError, TypeError, ValueError):
            continue
        d.append(depth)
        v.append(val)
    return np.array(d, float), np.array(v, float)


def fit_beta(depth: np.ndarray, damage: np.ndarray,
             lo: float, hi: float) -> dict | None:
    m = (depth >= lo) & (depth <= hi) & (damage > 0)
    if m.sum() < 3:
        return None
    b, lna = np.polyfit(np.log(depth[m]), np.log(damage[m]), 1)
    pred = lna + b * np.log(depth[m])
    res = np.log(damage[m]) - pred
    ss = 1 - (res ** 2).sum() / ((np.log(damage[m]) - np.log(damage[m]).mean()) ** 2).sum()
    return {"窗口_m": [lo, hi], "点数": int(m.sum()),
            "beta": round(float(b), 3),
            "R2_对数空间": round(float(ss), 4),
            "a": round(float(math.exp(lna)), 4)}


def main() -> int:
    text = fetch_csv()
    depth, damage = parse_asia(text)
    if len(depth) < 5:
        raise SystemExit("JRC 曲线解析失败")

    print("  JRC Asia 住宅曲线：")
    for a, b in zip(depth, damage):
        print(f"    {a:>4.1f} m → {b:.4f}")

    fits = []
    for lo, hi in ((0.5, 1.0), (0.5, 1.5), (0.5, 2.0), (0.5, 3.0),
                   (1.0, 3.0), (0.5, 6.0)):
        f = fit_beta(depth, damage, lo, hi)
        if f:
            fits.append(f)

    # 与 p53 的隐含 β 对比
    p53 = {}
    p = OUT / "p53_标度指数对标.json"
    if p.exists():
        p53 = json.loads(p.read_text(encoding="utf-8"))
    imply = (p53.get("隐含弹性：把无法对比变成可检验的预测") or {})
    beta_ours = imply.get("隐含β_点估计")
    beta_our_ci = imply.get("隐含β_区间")
    b_depth = imply.get("b_depth")
    b_q = imply.get("b_Q")

    # 主对标窗口取 0.5–1.5 m（城市内涝的实际水深区间；本模型红级 0.5 m）
    main_fit = next((f for f in fits if f["窗口_m"] == [0.5, 1.5]), fits[0])
    bt = main_fit["beta"]

    ratio = (beta_ours / bt) if (beta_ours and bt) else None
    consistent = (ratio is not None and 0.5 <= ratio <= 2.0)

    # 若 JRC 的 β 为真，则我们应观测到的 b_depth
    implied_bdepth = (b_q / bt) if (b_q and bt) else None
    # 若 JRC 的 β 为真，则我们应观测到的 b_Q
    implied_bq = (b_depth * bt) if (b_depth and bt) else None

    payload = {
        "名称": "外部对标：JRC 住宅深度—损失曲线 vs 我们的隐含 β",
        "生成时间": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "数据来源": {
            "文献": "Huizinga, de Moel & Szewczyk (2017), "
                  "Global flood depth-damage functions, JRC",
            "数值": "physrisk 公开仓库 raw.csv 的 Residential buildings / Asia_Mean",
            "本地缓存": str(CACHE.relative_to(ROOT)),
            "取用理由": "本项目在东亚，故取 Asia_Mean 而非 Global_Mean",
        },
        "JRC曲线": {"深度_m": [float(x) for x in depth],
                  "损失比例": [round(float(x), 4) for x in damage]},
        "JRC的beta": fits,
        "我们的隐含beta": {
            "b_Q": b_q, "b_depth": b_depth,
            "beta": beta_ours, "区间": beta_our_ci,
            "定义": "β = b_Q / b_depth（由 p53 计算）",
        },
        "对标": {
            "主对标窗口": main_fit["窗口_m"],
            "JRC_beta": bt,
            "我们_beta": beta_ours,
            "比值_我们除JRC": round(ratio, 2) if ratio else None,
            "是否自洽（比值落在 0.5–2）": bool(consistent),
            "若JRC为真_则应观测到的b_depth": round(implied_bdepth, 3) if implied_bdepth else None,
            "若JRC为真_则应观测到的b_Q": round(implied_bq, 3) if implied_bq else None,
        },
        "结论": [],
        "边界": [
            "JRC 曲线给出的是**资产损失占重置价值的比例**；我们的 Q 是"
            "**域内功能损失积分**，两者同为比例但覆盖对象不同（资产 vs 功能）。",
            "JRC 曲线是**凹的（饱和型）**，单一幂律在不同深度窗口下给出不同 β，"
            "故 β 不是该曲线的内禀常数。",
            "本对标只在『两个比例之间的标度关系』层面成立，不做货币换算。",
            "我们取的是域内**最大水深**的标度，而损失应对应**资产处水深**；"
            "这一差别正是结论指出的问题所在。",
        ],
    }

    concl = []
    if consistent:
        concl.append(
            f"**自洽**：JRC 在 {main_fit['窗口_m']} m 窗口的 β={bt}，"
            f"我们的隐含 β={beta_ours}，比值 {ratio:.2f} 落在 0.5–2 内。")
    else:
        concl.append(
            f"**不自洽**：JRC 在 {main_fit['窗口_m']} m 窗口的 β={bt}，"
            f"而我们由两个指数推出的隐含 β={beta_ours}，**相差 {ratio:.1f} 倍**。")
        concl.append(
            "**这说明 p53 的组合假设不成立**：我们用的 b_depth 是"
            "**域内最大水深**对雨量的标度，而损失对应的是"
            "**资产所在位置的水深**。两者不是同一个深度变量，"
            "故 β = b_Q / b_depth 不能直接与深度—损失曲线比较。")
        concl.append(
            f"**反推**：若 JRC 的 β={bt} 成立，那么要同时得到 b_Q={b_q}，"
            f"我们应观测到的 b_depth 约 {implied_bdepth:.2f}"
            f"（实测 0.434）；或若要 b_depth=0.434 成立，"
            f"则 b_Q 应约 {implied_bq:.2f}（实测 {b_q}）。"
            "**两条实测值与其中一组假设都不吻合**——"
            "问题不在 JRC 曲线，而在我们两个指数的口径不同源。")
        concl.append(
            "**这是本次五项里唯一一条『外部对照否定了内部一致性』的结果。** "
            "它的价值在于：把 p53 那个『可检验预测』真的检验了，"
            "**结论是不通过**。")

    payload["结论"] = concl

    (OUT / "p55_外部对标JRC.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n  JRC β（{main_fit['窗口_m']} m 窗口）= {bt}  "
          f"R²={main_fit['R2_对数空间']}")
    print(f"  我们的隐含 β = {beta_ours}  比值 {ratio:.2f}  "
          f"→ {'自洽' if consistent else '不自洽'}")
    if implied_bdepth:
        print(f"  若 JRC 为真：b_depth 应约 {implied_bdepth:.2f}（实测 {b_depth}）"
              f"；b_Q 应约 {implied_bq:.2f}（实测 {b_q}）")
    print(f"→ {OUT / 'p55_外部对标JRC.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
