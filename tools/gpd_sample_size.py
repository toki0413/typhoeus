"""GPD 形状参数的样本量需求实验。

重现期标定失败时，需要回答的问题是"要多少样本才能标出来"。这个数不能
引经验值——得实测。本脚本跑一遍合成实验，输出 `_SAMPLE_REQ` 那张表。

**合成对照的无偏性先要验。** 第一版实验用自写逆变换
    x = β/ξ · ((1-u)^(-ξ) - 1)
抽样，发现 n=1000 时 MLE 仍把 ξ 收在 0.636（真值 0.2），n=150 时
|ξ|<0.5 的占比反而比 n=50 低。那不是小样本方差，是我的 β→scale 换算
与 genextreme 的参数化不一致。改用 scipy 原生 `genextreme.rvs(c=-ξ)`
抽样后，n=50 的ξ 中位数 0.223、n=500 为 0.209、n=5000 为 0.195，
无偏性确认，实验才立得住。

先验无偏性再跑样本量曲线——顺序反了会得出「样本量没用」的假结论。

运行：`python tools/gpd_sample_size.py`
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from scipy.stats import genextreme

TRUE_XI = 0.2
TRUE_BETA = 50.0
SIZES = (7, 14, 20, 30, 50, 80, 150)
REPEATS = 80
TOL = 0.5          # 降水量极值分布 ξ 的合理范围


def verify_unbiased(n: int = 200, repeats: int = 30) -> dict:
    """先验 MLE 的无偏性。不通过就说明抽样或参数化错了。"""
    out = []
    for s in range(repeats):
        rng = np.random.default_rng(s * 13 + n)
        x = genextreme.rvs(c=-TRUE_XI, loc=10.0, scale=TRUE_BETA,
                           size=n, random_state=int(rng.integers(1e9)))
        c, _, _ = genextreme.fit(x)
        out.append(-c)
    a = np.array(out)
    return {"n": n, "median_xi": float(np.median(a)),
            "true_xi": TRUE_XI, "bias": float(np.median(a) - TRUE_XI)}


def curve() -> dict:
    res = {}
    for n in SIZES:
        out = []
        for s in range(REPEATS):
            rng = np.random.default_rng(s * 131 + n)
            x = genextreme.rvs(c=-TRUE_XI, loc=10.0, scale=TRUE_BETA,
                               size=n, random_state=int(rng.integers(1e9)))
            c, _, _ = genextreme.fit(x)
            out.append(-c)
        a = np.array(out)
        res[n] = {
            "median_xi": float(np.median(a)),
            "q25": float(np.percentile(a, 25)),
            "q75": float(np.percentile(a, 75)),
            "p_in_tol": float(np.mean(np.abs(a) <= TOL)),
            "p_near_true": float(np.mean(np.abs(a - TRUE_XI) < 0.2)),
        }
    return res


def main() -> int:
    print(f"真值 GPD(ξ={TRUE_XI}, β={TRUE_BETA})，每档 {REPEATS} 次重复，"
          f"scipy.stats.genextreme.fit 做 MLE\n")
    print("— 步骤 1：无偏性检查（必须先过这一步） —")
    ok = True
    for n in (50, 200, 1000):
        u = verify_unbiased(n)
        bias = u["bias"]
        good = abs(bias) < 0.1
        ok = ok and good
        print(f"  n={n:5d}  ξ_hat 中位={u['median_xi']:6.3f}  "
              f"偏差={bias:+6.3f}  {'OK' if good else '不通过'}")
    if not ok:
        print("\n  无偏性不通过，样本量曲线无意义，先修抽样或参数化。")
        return 1

    print(f"\n— 步骤 2：样本量曲线（ξ 落在 ±{TOL} 内的比例） —")
    cur = curve()
    for n, r in cur.items():
        print(f"  n={n:4d}  ξ 中位={r['median_xi']:6.3f}  "
              f"IQR=[{r['q25']:6.2f},{r['q75']:6.2f}]  "
              f"±{TOL} 内={r['p_in_tol']*100:5.1f}%  "
              f"±0.2 内={r['p_near_true']*100:5.1f}%")

    from typhoeus import multievent as ME
    live = ME._SAMPLE_REQ["curve"]
    print("\n— 步骤 3：与 multievent._SAMPLE_REQ 对账 —")
    bad = []
    for n, r in cur.items():
        got = live.get(str(n))
        if got is None:
            bad.append(f"n={n} 代码里缺该档")
        elif abs(got - r["p_in_tol"]) > 0.02:
            bad.append(f"n={n} 代码 {got:.3f} vs 实测 {r['p_in_tol']:.3f}")
        else:
            print(f"  n={n:4d}  {got:.3f} == {r['p_in_tol']:.3f}  OK")
    if bad:
        print("\n  不一致：")
        for b in bad:
            print(f"    {b}")
        return 1
    print("\n  全部一致。")
    return 0


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    sys.exit(main())
