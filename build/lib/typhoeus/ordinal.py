"""p25 序数技能检验：模型排得对顺序吗？

背景：模型的点位水深绝对值不可用（17 点命中 0%、12 点恒为 0）。
但产品定位已改为"预警与处置之间的具体化层"，其价值依赖一个未检验的假设：

    **模型能否至少给出正确的排序？**

规划岗要的是"先改哪个"，排序正确即可用；绝对值错误未必致命。

本件做四项检验：
  1) Spearman ρ 与 Kendall τ（17 个域内涝点，模型峰值 vs 观测水深）
  2) 置换检验：ρ 在随机打乱下的分布，给 p 值
  3) top-k 重合：模型的前 k 名与观测前 k 名重合几个
  4) 只看"模型有信号"的子集（5 点）——是否存在局部序数技能

若四项都无技能，则"具体化层"这一定位缺少依据，必须改写。
"""

from __future__ import annotations

import argparse
import csv
import json
from datetime import datetime
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SEED = ROOT / "data" / "seed"
OUT = ROOT / "out"

LON_MIN, LON_MAX = 121.550139, 121.699583
LAT_MIN, LAT_MAX = 29.840417, 29.919861
N_PERM = 5000


def _load(p: Path) -> list[dict]:
    with open(p, encoding="utf-8-sig") as f:
        return [{k.lstrip("\ufeff"): v for k, v in r.items()} for r in csv.DictReader(f)]


def _rank(a: np.ndarray) -> np.ndarray:
    """平均秩（处理并列）。"""
    order = a.argsort()
    ranks = np.empty_like(order, dtype=float)
    ranks[order] = np.arange(1, len(a) + 1, dtype=float)
    # 并列取平均秩
    vals, inv, cnt = np.unique(a, return_inverse=True, return_counts=True)
    for k in np.where(cnt > 1)[0]:
        m = inv == k
        ranks[m] = ranks[m].mean()
    return ranks


def _spearman(x: np.ndarray, y: np.ndarray) -> float:
    rx, ry = _rank(x), _rank(y)
    rx = rx - rx.mean()
    ry = ry - ry.mean()
    d = np.sqrt((rx ** 2).sum() * (ry ** 2).sum())
    return float((rx * ry).sum() / d) if d > 0 else 0.0


def _kendall(x: np.ndarray, y: np.ndarray) -> float:
    n = len(x)
    conc = disc = 0
    for i in range(n):
        for j in range(i + 1, n):
            a = np.sign(x[i] - x[j])
            b = np.sign(y[i] - y[j])
            if a == 0 or b == 0:
                continue
            if a * b > 0:
                conc += 1
            else:
                disc += 1
    tot = conc + disc
    return float((conc - disc) / tot) if tot else 0.0


def build(outdir: str = "out", verbose: bool = True) -> dict:
    from typhoeus import cli as CLI
    from typhoeus import config as CFG
    from typhoeus import data as D
    from typhoeus import kernel as K
    from typhoeus import observe as OB
    from typhoeus import rainsrc as RS

    cfg = CFG.Config()
    inp = D.load_all(cfg.l2.bbox, cfg.l4.resample)
    rain, _ = RS.get_rainfall(inp.grid, stations=OB.load_rain_stations(),
                              use_cache=True, calibrate=cfg.l2.rain_calibrate,
                              verbose=False)
    peak = np.asarray(K.run(inp.grid, rain, CLI._kernel_params(cfg)).depth).max(axis=0)
    lon, lat = np.asarray(inp.grid.lon), np.asarray(inp.grid.lat)

    rows = []
    for r in _load(SEED / "flood_points_2021_infa.csv"):
        try:
            x, y = float(r["lon"]), float(r["lat"])
            obs = float(r["depth_m"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (LON_MIN <= x <= LON_MAX and LAT_MIN <= y <= LAT_MAX):
            continue
        i = int(np.abs(lat - y).argmin())
        j = int(np.abs(lon - x).argmin())
        rows.append({"编号": r["point_id"], "名称": r["name"],
                     "结构": r.get("structure_type", ""),
                     "观测_m": obs, "模型_m": round(float(peak[i, j]), 4)})

    obs = np.array([r["观测_m"] for r in rows])
    mod = np.array([r["模型_m"] for r in rows])
    n = len(rows)

    rho = _spearman(mod, obs)
    tau = _kendall(mod, obs)

    # 置换检验
    rng = np.random.default_rng(20261017)
    null = np.array([_spearman(mod, rng.permutation(obs)) for _ in range(N_PERM)])
    p_two = float((np.abs(null) >= abs(rho)).mean())

    # top-k 重合
    topk = []
    for k in (3, 5, 8):
        if k > n:
            continue
        mo = set(np.argsort(-mod)[:k])
        oo = set(np.argsort(-obs)[:k])
        topk.append({"k": k, "重合数": len(mo & oo), "比例": round(len(mo & oo) / k, 3),
                     "模型TopK": [rows[i]["编号"] for i in sorted(mo)],
                     "观测TopK": [rows[i]["编号"] for i in sorted(oo)]})

    # 有信号子集
    sig = mod > 1e-6
    sub = {"点数": int(sig.sum())}
    if sig.sum() >= 4:
        rho_s = _spearman(mod[sig], obs[sig])
        tau_s = _kendall(mod[sig], obs[sig])
        null_s = np.array([_spearman(mod[sig], rng.permutation(obs[sig]))
                           for _ in range(N_PERM)])
        p_s = float((null_s >= rho_s).mean())        # 单侧：只关心正相关
        sub.update({
            "Spearman": round(rho_s, 4),
            "Kendall": round(tau_s, 4),
            "置换检验_p_单侧": p_s,
            "零分布_95分位": round(float(np.percentile(null_s, 95)), 4),
            "编号": [rows[i]["编号"] for i in np.where(sig)[0]],
            "观测_m": [round(float(obs[i]), 3) for i in np.where(sig)[0]],
            "模型_m": [round(float(mod[i]), 4) for i in np.where(sig)[0]],
        })
    else:
        p_s = None

    # 阈值敏感性：防止"挑一个阈值挑出显著"
    sweep = []
    for thr in (0.0, 1e-6, 1e-4, 1e-3, 5e-3, 1e-2):
        m = mod > thr
        k = int(m.sum())
        if k < 4:
            sweep.append({"阈值_m": thr, "点数": k, "Spearman": None,
                          "p_单侧": None, "说明": "点太少"})
            continue
        r_ = _spearman(mod[m], obs[m])
        ns = np.array([_spearman(mod[m], rng.permutation(obs[m]))
                       for _ in range(2000)])
        sweep.append({"阈值_m": thr, "点数": k,
                      "Spearman": round(r_, 4),
                      "p_单侧": round(float((ns >= r_).mean()), 4),
                      "零分布95分位": round(float(np.percentile(ns, 95)), 4)})

    # 双层判定：全样本 vs 有信号子集
    # 再加一道闸：阈值稳健性。若在**物理上可辨**的阈值（≥1 mm）下不显著，
    # 则"有条件秩技能"不成立——因为它的显著性来自把 0.0001 m 当成信号。
    full_ok = (rho >= 0.4 and p_two < 0.05)
    sub_ok = bool(p_s is not None and p_s < 0.05 and sub["Spearman"] >= 0.4)
    phys = [x for x in sweep if x["阈值_m"] >= 1e-3]
    phys_ok = bool(phys) and all((x["Spearman"] or 0) >= 0.4
                                 and (x["p_单侧"] or 1) < 0.05 for x in phys)

    if full_ok and sub_ok and phys_ok:
        verdict, level = "有秩技能", "两级皆成立且通过阈值稳健性"
    elif sub_ok and phys_ok:
        verdict, level = "有条件秩技能", "仅在有模型信号的子集上成立，且阈值稳健"
    elif sub_ok and not phys_ok:
        verdict, level = "秩技能未确立", (
            "宽松阈值下显著（含大量物理上为零的点），"
            "但在 ≥1 mm 的可辨阈值下不显著——显著性依赖阈值选择")
    elif rho > 0 and p_two < 0.2:
        verdict, level = "弱秩技能", "边缘，不足以支撑优先级建议"
    else:
        verdict, level = "无秩技能", "两级皆不成立"

    payload = {
        "名称": "序数技能检验：模型排得对顺序吗",
        "生成时间": datetime.now().isoformat(timespec="seconds"),
        "问题": "绝对值不可用，那排序可用吗？规划岗要的是排序。",
        "样本": {"域内涝点数": n, "模型有信号点数": int(sig.sum()),
                 "模型恒为零点数": int((~sig).sum())},
        "全样本检验": {
            "Spearman_rho": round(rho, 4), "Kendall_tau": round(tau, 4),
            "置换检验_p_双侧": p_two, "置换次数": N_PERM,
            "零分布_均值": round(float(null.mean()), 4),
            "零分布_95分位": round(float(np.percentile(null, 95)), 4),
        },
        "top_k重合": topk,
        "有信号子集": sub,
        "阈值敏感性": sweep,
        "阈值稳健性": ("各阈值下 Spearman 同号且 p 多小于 0.05，结论不依赖阈值选择"
                     if all((x["Spearman"] or 0) > 0.4 and (x["p_单侧"] or 1) < 0.05
                            for x in sweep if x["Spearman"] is not None)
                     else "结论随阈值变化，存在『挑阈值』风险，须谨慎"),
        "判定": verdict,
        "判定层级": level,
        "含义": {
            "有秩技能": "可支撑『改造优先级排序』，但绝对值仍不可用。",
            "弱秩技能": "排序信号微弱，不足以独立支撑优先级建议，只能作参考。",
            "秩技能未确立": "宽松阈值下看似显著，但在可辨阈值下消失——"
                            "**不足以支撑『排序可用』的产品主张**，只能作为方向性提示。",
            "无秩技能": "连排序都不可用——『具体化层』这一定位缺少依据，须改写。",
        }[verdict],
        "产品含义": {
            "有秩技能": "可按模型排序给出改造优先级。",
            "有条件秩技能": "只在 p17 判为『模型无水』之外的点上给优先级，其余明确拒答。",
            "秩技能未确立": "**不给排序类建议**。优先级仍须由观测/台账决定；"
                            "模型排序只能作为内部参考，不得写入对外材料。",
            "弱秩技能": "排序只作参考，不得作为优先级依据。",
            "无秩技能": "不给排序类建议。",
        }[verdict],
        "逐点": rows,
        "边界": [
            "n=17 且观测水深多为通报口径（不一定同一定义），秩相关的功效很低。",
            "12 个点模型恒为 0，构成大量并列，会压缩 Spearman 的分辨力。",
            "观测水深是不同时刻、不同来源的通报值，不是同一次观测，秩本身有噪声。",
            "本件只检验『排序』，不检验『分型』（分型见 p17）。",
        ],
    }
    p = Path(outdir)
    p.mkdir(parents=True, exist_ok=True)
    (p / "p25_序数技能检验.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    if verbose:
        print(f"  n={n}（模型有信号 {int(sig.sum())}，恒零 {int((~sig).sum())}）")
        print(f"  Spearman ρ = {rho:+.4f}   Kendall τ = {tau:+.4f}")
        print(f"  置换检验：零分布均值 {null.mean():+.4f}，95% 分位 "
              f"{np.percentile(null, 95):+.4f}，p = {p_two:.4f}")
        for t in topk:
            print(f"  top-{t['k']} 重合 {t['重合数']}/{t['k']}")
        if sig.sum() >= 3:
            print(f"  有信号子集（{sub['点数']} 点）：ρ = {sub['Spearman']:+.4f}")
        print(f"  判定：{verdict} —— {payload['含义']}")
        print(f"→ {p / 'p25_序数技能检验.json'}")
    return payload


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="typhoeus.ordinal")
    ap.add_argument("outdir", nargs="?", default="out")
    a = ap.parse_args(argv)
    build(a.outdir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
