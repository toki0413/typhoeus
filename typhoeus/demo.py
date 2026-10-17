"""一条命令：给它你的数，它给你只属于这个数的答案。

用法：
    python -m typhoeus.cli demo                          # 用 2021 烟花作示例
    python -m typhoeus.cli demo --rain 320               # 换成你的雨量（秒级）
    python -m typhoeus.cli demo --rain 320 --remaining 8 # 再给你的剩余时间
    python -m typhoeus.cli demo --rain 320 --map         # 再跑积水场（约 90 s）

为什么拆两条路径：
    分级、动作、时间可行性是**规则层**，不需要算积水，秒级。
    积水场要跑内核，约 90 秒。默认只跑规则层，`--map` 才跑内核。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "out"
BAR = "=" * 66
SUB = "-" * 66

DEFAULT_MM = 259.1      # 2021 烟花，ERA5 域内口径
DEFAULT_HOURS = 72.0


def _j(name: str) -> dict:
    p = OUT / name
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def _parse(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="typhoeus demo")
    ap.add_argument("--rain", type=float, default=DEFAULT_MM,
                    help=f"面雨量 mm（缺省 {DEFAULT_MM}，即 2021 烟花）")
    ap.add_argument("--hours", type=float, default=DEFAULT_HOURS,
                    help=f"历时 h（缺省 {DEFAULT_HOURS}）")
    ap.add_argument("--basis", default="station",
                    help="雨量口径（缺省 station）")
    ap.add_argument("--remaining", type=float, default=None,
                    help="从现在到首个险情还剩几小时")
    ap.add_argument("--map", action="store_true",
                    help="同时跑积水场（约 90 s）")
    return ap.parse_args(argv)


def _run_map(target_mm: float, hours: float) -> dict:
    """按目标总量缩放缓存降雨后重跑内核，返回逐点校正读数。"""
    import numpy as np

    from typhoeus import cards as C
    from typhoeus import cli as CLI
    from typhoeus import config as CFG
    from typhoeus import data as D
    from typhoeus import kernel as K
    from typhoeus import observe as OB
    from typhoeus import rainsrc as RS

    cfg = CFG.Config()
    inp = D.load_all(cfg.l2.bbox, cfg.l4.resample)
    g = inp.grid
    rain, _ = RS.get_rainfall(g, stations=OB.load_rain_stations(),
                              use_cache=True, calibrate=cfg.l2.rain_calibrate,
                              verbose=False)
    rain = np.asarray(rain, float)
    got = float(rain.mean() * hours)
    k = target_mm / got if got > 0 else 1.0
    kp = CLI._kernel_params(cfg)
    res = K.run(g, rain * k, kp)
    peak = np.asarray(res.depth).max(axis=0)

    lon, lat = np.asarray(g.lon), np.asarray(g.lat)
    rows = []
    for fp in OB.load_flood_points():
        if not (lon.min() <= fp.lon <= lon.max()
                and lat.min() <= fp.lat <= lat.max()):
            continue
        i = int(np.abs(lat - fp.lat).argmin())
        j = int(np.abs(lon - fp.lon).argmin())
        m = float(peak[i, j])
        rows.append({"id": fp.point_id, "name": fp.name,
                     "obs": float(fp.depth_m), "raw": m,
                     "cor": round(m + C.BIAS_M, 3),
                     "band": C.BIAS_BAND_M})
    return {"rows": rows, "scale": k, "sec": float(res.mass_resid)}


def main(argv: list[str] | None = None) -> int:
    a = _parse(sys.argv[1:] if argv is None else argv)

    from typhoeus import scenario as SC

    is_default = (abs(a.rain - DEFAULT_MM) < 1e-9
                  and abs(a.hours - DEFAULT_HOURS) < 1e-9)
    r = SC.match(a.rain, basis=a.basis, hours=a.hours)

    print(BAR)
    print("提比翁 · 台风内涝决策链")
    if is_default:
        print("（未给参数，用 2021 年台风「烟花」作示例；--rain 换成你的数）")
    print(BAR)
    print()

    print(SUB)
    print("一、你的输入")
    print(SUB)
    print(f"  面雨量　{a.rain:.1f} mm / {a.hours:.0f} h")
    print(f"  口径　　{a.basis}")
    print(f"  落档　　{r['情景档']}")
    print()
    print(f"  口径适用：{str(r['口径'])[:66]}…")
    print()

    print(SUB)
    print("二、该启动什么")
    print(SUB)
    print(f"  响应等级　{r['响应等级']}")
    print(f"  人员装备　{r['人员与装备']}")
    print(f"  布点　　　{r['布点']}")
    print(f"  动作要求　{r['动作要求']}")
    print()

    print(SUB)
    print("三、来不来得及")
    print(SUB)
    from typhoeus import decision as DC

    gap = a.remaining
    if gap is None:
        dec = _j("p23_决策可行域.json")
        gap = ((dec.get("空白") or {}).get("相对道路封道_h"))
        if gap is not None:
            print(f"  （未给 --remaining，用本片区实测空白 {gap:.1f} h）")
            print()
    if gap is None:
        print("  无法判定：需要 --remaining（从现在到首个险情还剩几小时）")
    else:
        print(f"  可用提前量　{gap:.1f} h")
        print()
        # ACTIONS 是 (名称, 所需提前_h, 依据类型, 依据) 的元组列表
        acts = [a for a in getattr(DC, "ACTIONS", []) if len(a) >= 2]
        for name, need, *_ in acts:
            left = gap - need
            ok = "✓" if left >= 0 else "✗"
            tail = (f"余量 {left:>6.1f} h" if left >= 0
                    else f"缺口 {-left:>6.1f} h")
            print(f"    {ok} {name:<14} 需 {need:>6.1f} h　{tail}")
        print()
        tight = [name for name, need, *_ in acts if need > gap]
        if tight:
            print(f"  ★ 来不及的：{'、'.join(tight)}")
            print("    这几条要现在就启动，或者接受做不到")
        else:
            print("  ★ 全部动作都来得及")
    print()

    print(SUB)
    print("四、逐点积水（校正读数）")
    print(SUB)
    if a.map:
        print("  正在跑积水场……（约 90 s）")
        m = _run_map(a.rain, a.hours)
        rows = m["rows"]
        print(f"  降雨缩放系数 {m['scale']:.3f}　守恒残差 {m['sec']:.1e}")
        raw_mae = sum(abs(x["raw"] - x["obs"]) for x in rows) / len(rows)
        cor_mae = sum(abs(x["cor"] - x["obs"]) for x in rows) / len(rows)
        print(f"  {len(rows)} 个域内点：原始 MAE {raw_mae:.3f} → "
              f"校正 {cor_mae:.3f} m")
        print()
        for x in sorted(rows, key=lambda y: -y["cor"])[:5]:
            print(f"    {x['id']} {x['name'][:18]:<18} "
                  f"校正 {x['cor']:.3f} ± {x['band']:.3f} m　"
                  f"实测 {x['obs']:.2f}")
        print()
        print("  ★ 校正为经验值（留一法 MAE 0.0909），只作口径对齐，非物理真值")
    else:
        print("  未跑积水场。加 --map 给出逐点校正读数（约 90 s）。")
        print("  分级、动作、可行性三项不需要它——由雨量与规则直接决定。")
        print("  逐点校正的样本外误差：留一法 MAE 0.0909 m（基线 0.3593 m）。")
    print()

    print(SUB)
    print("五、这条结论的边界")
    print(SUB)
    def _bullets(v) -> str:
        items = v if isinstance(v, (list, tuple)) else [v]
        return "\n          ".join(f"· {str(x)}" for x in items if str(x).strip())

    print(f"  能回答：{_bullets(r.get('能回答'))}")
    print(f"  不能答：{_bullets(r.get('不能回答'))}")
    hm = _j("05_health_metrics.json")
    if hm:
        print(f"  门槛　：{hm.get('PASS')} 通过 / {hm.get('FAIL')} 不通过 / "
              f"{hm.get('BLOCKED')} 缺外部数据")
    print()

    print(BAR)
    print("给它一个数，它给一个只属于这个数的答案。")
    print(BAR)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
