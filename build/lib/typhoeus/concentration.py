"""p43 降雨集中度：独立情景轴。

为什么要有这一条轴
------------------
现有情景轴（p50/p80/p90/p95）只动**总量**。但 p42 实测：
域平均逐时不变、只改空间对比度时，极端集中档使峰值水深从 0.4928 翻到
1.0268 m、红格从 0 到 10.9 ha、格局相关降到 0.93。

**即"雨落得集中"与"雨下得大"是两条独立的放大器**，必须分开摆。

设计（确定性，可复算）
----------------------
乘子场用解析条带，不用随机场——否则不可复算：

    m(x, y) = exp(a · sin(2πx/λ)) / mean(m)

  a     对比度振幅（本轴的唯一参数）
  λ     条带波长，取 0.35 域宽（约 5.8 km，落在雨带尺度内）

a=0 时 m≡1（均匀），a 增大则对比度增大、恒正、平滑。

轴档：a ∈ {0, 0.25, 0.50, 1.00, 1.50}
     对应相对空间标准差与"有效覆盖面积"在产物里逐档给出。

总量轴：沿用 p6 的四档（258.4 / 313.2 / 338.8 / 354.1 mm），
        用缩放基线的时程达到目标面雨量。

输出：out/p43_降雨集中度情景轴.json
用法：python -m typhoeus.concentration
"""

from __future__ import annotations

import argparse
import json
import time
from datetime import datetime
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"

# 对比度振幅档
A_LEVELS = [
    (0.00, "C0 均匀（理论下限）"),
    (0.25, "C1 弱对比（≈现状插值场）"),
    (0.50, "C2 中等对比"),
    (1.00, "C3 强对比"),
    (1.50, "C4 极端集中"),
]
LAMBDA_FRAC = 0.35          # 条带波长 = 0.35 域宽 ≈ 5.8 km
TOTALS_MM = [258.4, 313.2, 338.8, 354.1]   # p50/p80/p90/p95


def multiplier(a: float, ny: int, nx: int) -> np.ndarray:
    """确定性条带乘子场，域平均为 1。a=0 时恒为 1。"""
    if a <= 0:
        return np.ones((ny, nx), dtype="float64")
    x = np.linspace(0.0, 1.0, nx)[None, :]
    m = np.exp(a * np.sin(2.0 * np.pi * x / LAMBDA_FRAC))
    m = np.repeat(m, ny, axis=0)
    return m / float(m.mean())


def describe(m: np.ndarray) -> dict:
    """相对空间标准差 + 有效覆盖面积（≥1.5 倍均值的面积占比）。"""
    return {
        "相对空间标准差_pct": round(float(m.std() / m.mean() * 100), 2),
        "最大最小比": round(float(m.max() / max(m.min(), 1e-12)), 2),
        "有效覆盖_ge1.5倍_pct": round(float((m >= 1.5 * m.mean()).mean() * 100), 1),
        "有效覆盖_ge2倍_pct": round(float((m >= 2.0 * m.mean()).mean() * 100), 1),
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="typhoeus.concentration")
    ap.add_argument("outdir", nargs="?", default="out")
    a = ap.parse_args(argv)

    from typhoeus import cli as CLI
    from typhoeus import config as CFG
    from typhoeus import data as D
    from typhoeus import kernel as K
    from typhoeus import observe as OB
    from typhoeus import rainsrc as RS

    cfg = CFG.Config()
    inp = D.load_all(cfg.l2.bbox, cfg.l4.resample)
    g = inp.grid
    ny, nx = g.elev.shape
    base_rain, _ = RS.get_rainfall(g, stations=OB.load_rain_stations(),
                                   use_cache=True, calibrate=cfg.l2.rain_calibrate,
                                   verbose=False)
    base = np.asarray(base_rain, dtype=np.float64)
    kp = CLI._kernel_params(cfg)
    ha = (float(g.cell_m) ** 2) / 1e4
    dt_h = kp.dt_s / 3600.0

    # 基线面雨量
    base_total = float(base.mean(axis=(1, 2)).sum() * dt_h)
    print(f"  基线面雨量 {base_total:.1f} mm；总量轴 {TOTALS_MM}")

    # 乘子场与其描述
    mfields = {}
    for av, label in A_LEVELS:
        m = multiplier(av, ny, nx)
        mfields[av] = m
        d = describe(m)
        print(f"  {label:<22} a={av:<5} 相对std {d['相对空间标准差_pct']:>6.2f}%  "
              f"max/min {d['最大最小比']:>6.2f}  ≥2倍覆盖 {d['有效覆盖_ge2倍_pct']:>5.1f}%")

    # 二维矩阵
    rows = []
    for total in TOTALS_MM:
        scale = total / max(base_total, 1e-9)
        prof = base.mean(axis=(1, 2)) * scale          # (nt,) 目标面雨量时程
        for av, label in A_LEVELS:
            m = mfields[av]
            rain = (prof[:, None, None] * m[None, :, :]).astype(np.float32)
            # 逐时重归一，保证域平均严格等于目标时程
            cur = rain.mean(axis=(1, 2))
            tgt = prof
            corr = np.divide(tgt, cur, out=np.ones_like(cur), where=cur > 1e-9)
            rain = (rain * corr[:, None, None]).astype(np.float32)
            t0 = time.perf_counter()
            res = K.run(g, rain, kp)
            el = time.perf_counter() - t0
            peak = np.asarray(res.depth).max(axis=0)
            rows.append({
                "总量_mm": total, "档": label, "a": av,
                "峰值水深_m": round(float(peak.max()), 4),
                "湿格_ha": round(float((peak >= 0.05).sum()) * ha, 1),
                "橙格_ha": round(float(((peak >= 0.2) & (peak < 0.5)).sum()) * ha, 1),
                "红格_ha": round(float((peak >= 0.5).sum()) * ha, 1),
                "守恒残差": float(res.mass_resid),
                "内核_s": round(el, 1),
            })
            print(f"    总量 {total:5.1f} × {label:<22} 峰 {rows[-1]['峰值水深_m']:.4f} "
                  f"橙 {rows[-1]['橙格_ha']:>7.1f} 红 {rows[-1]['红格_ha']:>6.1f}", flush=True)

    # 两条轴的敏感度对比：各自"跨档变化"与"最弱→最强"
    def span_over(key: str, fixed_total=None, fixed_a=None) -> dict:
        sel = [r for r in rows
               if (fixed_total is None or r["总量_mm"] == fixed_total)
               and (fixed_a is None or r["a"] == fixed_a)]
        if not sel:
            return {}
        v = [r[key] for r in sel]
        lo, hi = min(v), max(v)
        return {"min": lo, "max": hi,
                "跨度": round(hi - lo, 4),
                "倍数": round(hi / max(lo, 1e-9), 3) if lo > 0 else None}

    total_axis = span_over("峰值水深_m", fixed_a=0.0)      # 只动总量（均匀）
    conc_axis = span_over("峰值水深_m", fixed_total=TOTALS_MM[0])  # 只动集中度（最小总量）
    conc_axis_hi = span_over("峰值水深_m", fixed_total=TOTALS_MM[-1])

    payload = {
        "名称": "降雨集中度：独立情景轴",
        "生成时间": datetime.now().isoformat(timespec="seconds"),
        "为什么独立于总量": (
            "p42 实测：域平均逐时不变、只改空间对比度时，极端集中档使峰值水深"
            "从 0.4928 翻到 1.0268 m。故『雨落得集中』与『雨下得大』是两条独立放大器。"),
        "设计": {
            "乘子场": "m = exp(a·sin(2πx/λ)) 归一化（确定性解析式，不用随机场）",
            "λ": f"{LAMBDA_FRAC} 域宽 ≈ 5.8 km（落在雨带尺度 1–10 km 内）",
            "a_档": [{"a": av, "档": lb, **describe(mfields[av])} for av, lb in A_LEVELS],
            "总量轴": TOTALS_MM,
            "受控方式": "逐时重归一，使域平均雨强严格等于目标时程——只改空间分布",
        },
        "矩阵": rows,
        "两条轴的敏感度": {
            "只动总量（a=0 均匀）": total_axis,
            "只动集中度（总量 p50）": conc_axis,
            "只动集中度（总量 p95）": conc_axis_hi,
            "判读": "",
        },
        "分级翻转": [],
        "结论": [],
        "边界": [
            "集中度为**合成条带**，非真实雨带，也不是下采样结果——"
            "本轴只回答『若雨集中在更小面积上会怎样』。",
            "条带方向固定沿 x 轴；真实雨带的走向、移动未建模。",
            "总量轴沿用 p6 四档（p50–p95），集中度轴为新设，两者非正交独立。",
            "共用宁波参数，无本地验证。",
            "本件不进本次提交材料（技术冻结），是下一版的情景维度。",
        ],
    }

    # 分级翻转：以功能损失无关，用红格是否出现作为判据
    flips = []
    for total in TOTALS_MM:
        sel = [r for r in rows if r["总量_mm"] == total]
        red0 = sel[0]["红格_ha"]
        redmax = max(r["红格_ha"] for r in sel)
        if (red0 == 0) != (redmax == 0):
            flips.append({"总量_mm": total,
                          "均匀时红格_ha": red0, "最强集中时红格_ha": redmax,
                          "翻转": "无红格 → 出现红格"})
    payload["分级翻转"] = flips

    t_mult = total_axis.get("倍数")
    c_mult = conc_axis.get("倍数")
    payload["两条轴的敏感度"]["判读"] = (
        f"只动总量：峰值 {total_axis.get('min')}→{total_axis.get('max')} m"
        f"（×{t_mult}）；"
        f"只动集中度：{conc_axis.get('min')}→{conc_axis.get('max')} m"
        f"（×{c_mult}）。"
        + ("**集中度的杠杆大于总量**。" if (t_mult and c_mult and c_mult > t_mult)
           else "**总量的杠杆大于集中度**。"))

    payload["结论"] = [
        ("这是第一条**不依赖总量**的情景轴。它的物理含义是"
         "『这场雨落在多大的面积上』，而不是『这场雨有多大』。"),
        (f"只动总量（p50→p95，+37%）：峰值 {total_axis.get('min')}→"
         f"{total_axis.get('max')} m。"
         f"只动集中度（C0→C4）：峰值 {conc_axis.get('min')}→"
         f"{conc_axis.get('max')} m。"),
        ("**分级翻转**：" + (
            "；".join(f"总量 {f['总量_mm']} mm 时，均匀无红格、最强集中出现红格"
                     for f in flips) if flips else "各总量档下红格状态均未翻转"),
        ),
        ("**对值班室的含义**：现在可以问两个独立的问题——"
         "『雨会下多大』（总量轴）与『雨会下多集中』（集中度轴）。"
         "后者是雷达/短临才能回答的，前者是模式预报能回答的。"),
        ("**诚实限定**：集中度档是合成的，不是从数据里下采样出来的。"
         "它的用处是**把『我们知道自己缺什么』变成一个可操作的敏感性维度**，"
         "而不是声称已解决雨型问题。"),
    ]

    p = Path(a.outdir)
    p.mkdir(parents=True, exist_ok=True)
    (p / "p43_降雨集中度情景轴.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n  只动总量 ×{t_mult}；只动集中度 ×{c_mult}")
    print(f"  分级翻转 {len(flips)} 处")
    print(f"→ {p / 'p43_降雨集中度情景轴.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
