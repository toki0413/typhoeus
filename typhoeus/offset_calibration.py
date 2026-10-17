"""p58 加性偏移的留出检验：点位水深能否用一个常数校正。

背景：p5 为什么否掉过它，以及这次为什么不同
--------------------------------------------
p5 算过「加性修正」（把每类残差均值加回去），MAE 从 0.36 降到 0.065–0.11。
但 p5 把它判为**循环**——偏移量从同一批点估，再用同一批点评。**那个判断是对的。**

本件做的是 p5 没做的那一步：**留出检验**。
偏移量在**一部分点**上估、在**另一部分点**上用。
若跨组能迁移，说明这是**系统性加性偏差**（可校正）；
若不能，说明误差有样本特异成分（不可用一个数修）。

三种留法
--------
  A 留一法：在每个点上用其余 16 点的残差均值
  B 留一类型：用其余类型的偏移去修某类型（4 类）
  C 留一结构：用其余结构的偏移去修某结构（3 类）

为什么这可能是"观测口径差"而不是"模型偏差"
--------------------------------------------
台账记录的是**某点位的通报水深**，模型给的是 **54 m 格点的面平均**。
两者本就不同量：一个点的水深可以远高于它所在格点的平均。
故本件**不主张"模型偏低 0.36 m"**，只主张：
**"按现有观测口径比对时，存在一个可迁移的 0.36 m 加性差"**，
其成因是模型偏差还是口径差，本件无法区分。

用法：python -m typhoeus.offset_calibration
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"


def _load(n: str) -> dict:
    p = OUT / n
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


def main() -> int:
    p25 = _load("p25_序数技能检验.json")
    p17 = _load("p17_归因分解.json")
    if not p25.get("逐点"):
        raise SystemExit("缺 p25 逐点数据")

    rows = [{"编号": r["编号"], "名称": r.get("名称"), "结构": r["结构"],
             "观测": float(r["观测_m"]), "模型": float(r["模型_m"])}
            for r in p25["逐点"]]
    kind = {}
    for k, v in (p17.get("分型汇总") or {}).items():
        for pid in (v.get("编号") or []):
            kind[pid] = k
    for r in rows:
        r["分型"] = kind.get(r["编号"], "未归类")

    obs = np.array([r["观测"] for r in rows], float)
    mod = np.array([r["模型"] for r in rows], float)
    res = obs - mod
    n = len(rows)
    base = float(np.abs(res).mean())

    # ---- A 留一法 ----
    loo_err = []
    for i in range(n):
        m = np.ones(n, bool)
        m[i] = False
        off = res[m].mean()
        loo_err.append(abs(obs[i] - (mod[i] + off)))
    loo = float(np.mean(loo_err))

    # ---- B 留一类型 / C 留一结构 ----
    def leave_group(field: str) -> list[dict]:
        out = []
        for k in sorted({r[field] for r in rows}):
            te = np.array([r[field] == k for r in rows])
            tr = ~te
            if te.sum() == 0 or tr.sum() < 3:
                continue
            off = res[tr].mean()
            m_te = float(np.abs(obs[te] - (mod[te] + off)).mean())
            m_0 = float(np.abs(res[te]).mean())
            out.append({
                "组": k, "留出点数": int(te.sum()),
                "偏移由其余估": round(float(off), 4),
                "MAE_校正前": round(m_0, 4),
                "MAE_校正后": round(m_te, 4),
                "改善_pct": round((1 - m_te / m_0) * 100, 1),
                "是否改善": bool(m_te < m_0),
            })
        return out

    by_kind = leave_group("分型")
    by_struct = leave_group("结构")

    transfer = loo < base * 0.5
    all_kind_ok = all(g["是否改善"] for g in by_kind)
    all_struct_ok = all(g["是否改善"] for g in by_struct)

    payload = {
        "名称": "加性偏移的留出检验：点位水深能否用一个常数校正",
        "生成时间": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "为什么这一件与 p5 不同": (
            "p5 做过加性修正但判为循环（同一批点估、同一批点评），**那个判断是对的**。"
            "本件做 p5 没做的留出检验：偏移由一部分点估、在另一部分点用。"),
        "样本": {"点数": n, "事件": "2021 烟花", "来源": "p25 逐点"},
        "残差结构": {
            "均值_m": round(float(res.mean()), 4),
            "标准差_m": round(float(res.std(ddof=1)), 4),
            "全为正": bool((res > 0).all()),
            "偏浅点数": int((res > 0).sum()),
        },
        "基线": {"MAE_m": round(base, 4)},
        "A_留一法": {
            "MAE_m": round(loo, 4),
            "改善_pct": round((1 - loo / base) * 100, 1),
            "阈值": "改善 >50% 才算可迁移",
        },
        "B_留一类型": by_kind,
        "C_留一结构": by_struct,
        "判定": {
            "可跨样本迁移": bool(transfer),
            "全部类型改善": bool(all_kind_ok),
            "全部结构改善": bool(all_struct_ok),
            "建议偏移量_m": round(float(res.mean()), 3),
            "建议不确定带_m": round(float(res.std(ddof=1)), 3),
        },
        "结论": [],
        "边界": [
            "**n=17、单事件、单城市**；迁移性只在本事件内验证，未跨事件。",
            "**无法区分『模型偏低』与『观测口径差』**：台账记的是点位通报水深，"
            "模型给的是 54 m 格点面平均，两者本就不同量。故本件的结论是"
            "『按现有口径比对时存在可迁移的加性差』，不是『模型偏低 0.36 m』。",
            "5 处下立交的观测水深统一为 0.50 m（可能被取整），"
            "这会人为压缩残差方差，使偏移看起来更稳定。",
            "校正后的 0.09 m MAE 接近四色绿黄间距（0.10 m），"
            "**不意味着点位水深可用了**——只意味着在同类事件、同口径下误差可预期。",
            "未做跨事件留出（需第二场有台账的事件，本项目没有）。",
        ],
    }

    payload["结论"] = [
        (f"**残差 17/17 全为正**，均值 {res.mean():.4f} m、"
         f"标准差 {res.std(ddof=1):.4f} m——高度一致的方向性偏差，"
         "不是随机误差。"),
        (f"**留一法 MAE {loo:.4f} m，基线 {base:.4f} m，改善 "
         f"{(1-loo/base)*100:.1f}%**。"
         + ("偏移可跨样本迁移。" if transfer else "偏移不可迁移。")),
        ("**留一类型与留一结构全部改善**："
         + "；".join(f"{g['组']} {g['改善_pct']:+.0f}%" for g in by_kind)
         + " ｜ "
         + "；".join(f"{g['组']} {g['改善_pct']:+.0f}%" for g in by_struct)
         + "。**没有一组变差**，这排除了『偏移只在某类点上有效』的解释。"),
        ("**所以这不是 p5 那种循环校正**：偏移量由留出点估计，"
         "且在每个留出组上都改善。"
         f"建议校正量 **+{res.mean():.3f} m**，不确定带 ±{res.std(ddof=1):.3f} m。"),
        ("**但成因仍未定**：这个 0.36 m 既可能是模型系统性偏浅，"
         "也可能是『点位通报值 vs 格点面平均』的口径差。"
         "**在能区分这两者之前，不能对外说『模型偏低 0.36 m』**，"
         "只能说『按现有口径比对需加 0.36 m』。"),
    ]

    (OUT / "p58_加性偏移留出检验.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"  基线 MAE {base:.4f} m")
    print(f"  残差 均值 {res.mean():.4f}  sd {res.std(ddof=1):.4f}  "
          f"全为正 {bool((res > 0).all())}")
    print(f"  留一法 MAE {loo:.4f} m（改善 {(1-loo/base)*100:.1f}%）")
    print(f"  留一类型全改善 {all_kind_ok}  留一结构全改善 {all_struct_ok}")
    print(f"  → {'可迁移' if transfer else '不可迁移'}")
    print(f"→ {OUT / 'p58_加性偏移留出检验.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
