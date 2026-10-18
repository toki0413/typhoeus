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
    ap.add_argument("--compare", nargs=2, type=float, default=None,
                    metavar=("MM_A", "MM_B"),
                    help="对比两个雨量档，标出哪些差异是字面差异、哪些是实质差异")
    ap.add_argument("--rain-series", default=None,
                    help="逐时雨量序列，逗号或空格分隔（每格为该小时 mm）")
    ap.add_argument("--rain-series-file", default=None,
                    help="逐时雨量序列文件（每行一个数，# 为注释）")
    return ap.parse_args(argv)


def _run_map(target_mm: float, hours: float,
             series: list[float] | None = None) -> dict:
    """跑积水场。

    `series` 给了就用它作时间形状（空间均匀），否则按目标总量缩放缓存降雨。
    """
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
    kp = CLI._kernel_params(cfg)
    # 用降雨数组的实际步数，而不是由 max_t_h 反算——两者会差一步
    nt = int(rain.shape[0])
    dt_h = kp.dt_s / 3600.0
    if series is not None:
        prof = _series_to_rate(series, nt, dt_h)
        # 空间均匀：把时间曲线铺到全域
        rain_used = np.broadcast_to(
            prof[:, None, None], rain.shape).copy()
        k = 1.0
    else:
        got = float(rain.mean() * hours)
        k = target_mm / got if got > 0 else 1.0
        rain_used = rain * k
    res = K.run(g, rain_used, kp)
    depth = np.asarray(res.depth)
    peak = depth.max(axis=0)
    curve = depth.max(axis=(1, 2))          # 逐时刻空间最大水深

    lon, lat = np.asarray(g.lon), np.asarray(g.lat)
    rows = []
    for fp in OB.load_flood_points():
        if not (lon.min() <= fp.lon <= lon.max()
                and lat.min() <= fp.lat <= lat.max()):
            continue
        i = int(np.abs(lat - fp.lat).argmin())
        j = int(np.abs(lon - fp.lon).argmin())
        m = float(peak[i, j])
        rows.append({"id": fp.point_id, "name": fp.name, "st": fp.structure_type,
                     "obs": float(fp.depth_m), "raw": m,
                     "cor": round(m + C.BIAS_M, 3),
                     "band": C.BIAS_BAND_M})
    return {"rows": rows, "scale": k, "sec": float(res.mass_resid),
            "t_h": np.asarray(res.t_h), "curve": curve,
            "series": series}


# 这些字段的返回值是散文，字符串相等 != 语义相同
PROSE_FIELDS = ("响应等级", "人员与装备", "布点", "动作要求")


def _semantic_same(field: str, a: str, b: str) -> str:
    """判定两份散文是否**语义相同**。

    返回 "相同" / "不同" / "需人判断"。
    这里刻意只做最保守的规则判断——真正的语义比对必须由语言模型完成，
    本函数的作用是**标出哪些字段不能靠字符串比对**。
    """
    if a == b:
        return "相同"
    # 关键实体：把两串里的数字与"处/组/台"等量词抽出来比
    import re

    def ents(x: str) -> list[str]:
        return re.findall(r"\d+\s*(?:处|组|人|台|次|小时|h)", x)

    ea, eb = ents(a), ents(b)
    if ea and ea == eb:
        return "仅措辞不同"
    # 一方是另一方的子集：很可能是「点没变，只是多/少了一项附带工作」，
    # 但仅凭字符串无法确认那个多出来的量词指的还是不是同一类对象
    # （"12 处 + 7 处走访" 里的两个"处"指的不是同一种东西）。
    if ea and eb and (set(eb) < set(ea) or set(ea) < set(eb)):
        return "规则判不了"
    return "不同"


# 按结构类型的雨前准备动作。
# 这些是通用工程动作，不依赖本地台账；**责任人与物资数量必须由本单位填写**。
PREP_TASKS = {
    "下穿立交": [
        ("挡水板/沙袋到位", 4.0),
        ("泵组试运行并接电", 3.0),
        ("两端警示牌与绕行牌布设", 2.0),
        ("值守人员到位，禁止涉水通行", 1.0),
    ],
    "桥洞": [
        ("限高与积水标尺检查", 3.0),
        ("排水口清掏", 4.0),
        ("警戒线布设", 1.0),
    ],
    "低洼小区": [
        ("地下车库入口挡水", 4.0),
        ("沙袋与移动泵到位", 3.0),
        ("独居老人与行动不便者名单核实", 6.0),
        ("单元口提示张贴", 2.0),
    ],
    "低洼路段": [
        ("雨水口清掏", 6.0),
        ("路缘石排水通道检查", 4.0),
        ("临时禁停与绕行提示", 2.0),
    ],
}


def _load_series(spec: str | None, path: str | None) -> list[float] | None:
    """读逐时雨量序列。返回值单位为「该小时的 mm」。"""
    if path:
        raw = Path(path).read_text(encoding="utf-8-sig")
        vals = []
        for ln in raw.splitlines():
            ln = ln.split("#")[0].replace(",", " ").strip()
            if not ln:
                continue
            vals.extend(float(x) for x in ln.split())
        return vals or None
    if spec:
        txt = spec.replace(",", " ")
        vals = [float(x) for x in txt.split() if x.strip()]
        return vals or None
    return None


def _series_to_rate(series: list[float], nt: int, dt_h: float) -> "object":
    """把逐时 mm 展开成内核步长的 mm/h 序列（长度 nt）。"""
    import numpy as np

    arr = np.asarray(series, dtype=float)
    # 每小时的 mm 数 → mm/h 就是它本身
    per_hour = arr
    steps_per_hour = max(1, int(round(1.0 / dt_h)))
    expanded = np.repeat(per_hour, steps_per_hour)
    if expanded.size < nt:
        expanded = np.concatenate(
            [expanded, np.zeros(nt - expanded.size)])
    return expanded[:nt]


def _first_cross(t_h, curve, th: float) -> float | None:
    """curve 为逐时刻的空间最大水深，返回首次 >= th 的时刻。"""
    for ti, v in zip(t_h, curve):
        if v >= th:
            return float(ti)
    return None


def _compare(mm_a: float, mm_b: float, basis: str) -> int:
    """对比两档：标出字面差异与实质差异。"""
    from typhoeus import scenario as SC

    ra = SC.match(mm_a, basis=basis, hours=DEFAULT_HOURS)
    rb = SC.match(mm_b, basis=basis, hours=DEFAULT_HOURS)

    print(BAR)
    print("两档对比：哪些差异是真的，哪些只是措辞")
    print(BAR)
    print()
    print(f"  A：{mm_a:.1f} mm → {ra['情景档']}")
    print(f"  B：{mm_b:.1f} mm → {rb['情景档']}")
    print()
    print(f"  {'字段':<10}{'字面':<8}{'语义':<10}A 的值 / B 的值")
    print("  " + "-" * 62)
    n_text_only = 0
    n_real = 0
    for f in PROSE_FIELDS:
        va, vb = str(ra.get(f, "")), str(rb.get(f, ""))
        lit = "相同" if va == vb else "变了"
        sem = _semantic_same(f, va, vb)
        if sem == "规则判不了":
            n_text_only += 1
        elif sem == "不同":
            n_real += 1
        print(f"  {f:<10}{lit:<8}{sem:<10}{va[:26]} / {vb[:26]}")
    print()
    print(f"  规则判不了（需语言模型做语义判断）：{n_text_only} 项")
    print(f"  实质不同：{n_real} 项")
    print()
    print("  ★ 看上面标「规则判不了」的那一行：")
    print("    「12 处 + 低洼小区 7 处走访」与「12 处（模型建议布点数）」")
    print("    两个『处』指的不是同一种对象——一个是布点，一个是走访。")
    print("    我的规则分类器当场判不出来，这不是实现 bug，")
    print("    是字符串比较与语义比较的差别。**这正是必须由语言模型做的那一步。**")
    print()
    print("  ★ 为什么返回的不是枚举：这段文字直接进预案，")
    print("    改成『points: 12』这样的枚举，就丢掉了「为什么是这 12 处」。")
    print(BAR)
    return 0


def main(argv: list[str] | None = None) -> int:
    a = _parse(sys.argv[1:] if argv is None else argv)

    from typhoeus import scenario as SC

    if a.compare:
        return _compare(a.compare[0], a.compare[1], a.basis)

    series = _load_series(a.rain_series, a.rain_series_file)
    if series:
        # 有逐时序列时，总量与历时都由序列决定，不再用标量
        a.rain = float(sum(series))
        a.hours = float(len(series))
        # 序列一给，就必须跑积水场——否则"什么时候"无从谈起
        a.map = True

    is_default = (abs(a.rain - DEFAULT_MM) < 1e-9
                  and abs(a.hours - DEFAULT_HOURS) < 1e-9
                  and not series)
    r = SC.match(a.rain, basis=a.basis, hours=a.hours)

    # 口径相容性：分位阈值只对 72 h 历时标定过。
    # 历时不是 72 h 时，档位不可用——必须拦，不能凑一个档出来。
    basis_ok = abs(a.hours - DEFAULT_HOURS) <= 1.0

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
    if basis_ok:
        print(f"  落档　　{r['情景档']}")
    else:
        print(f"  落档　　**不适用**")
        print(f"  └ 分位阈值只对 {DEFAULT_HOURS:.0f} h 历时标定过，"
              f"你给的是 {a.hours:.0f} h。")
        print("     本片区没有该历时的分位，所以不给档——"
              "凑一个档比不给更糟。")
        print("     下面仍可给积水场与越阈时刻（那两项不依赖分位）。")
    if series:
        pk = max(series)
        pk_t = series.index(pk)
        print(f"  时间形状　逐时序列 {len(series)} 个值　"
              f"峰值 {pk:.1f} mm/h @ 第 {pk_t + 1} 小时")
        print(f"  （标量输入时总量相同但形状不同，结论会不同——见第五节）")
    print()
    print(f"  口径适用：{str(r['口径'])[:66]}…")
    print()

    print(SUB)
    print("二、该启动什么")
    print(SUB)
    if not basis_ok:
        print("  无法给出：等级与人员装备由分位档决定，而你的历时没有分位。")
        print("  可选做法：把雨量换算到 72 h 口径后再查，或按本单位预案自行定级。")
    else:
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
        m = _run_map(a.rain, a.hours, series=series)
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

        # 序列输入才谈得上"什么时候"——这是标量答不了的那一问
        t_h = m["t_h"]
        curve = m["curve"]
        print()
        print("  什么时候越阈（空间最大水深首次达到该档）：")
        for th, name in ((0.10, "黄"), (0.20, "橙"), (0.50, "红")):
            t0 = _first_cross(t_h, curve, th)
            if t0 is None:
                print(f"    {name} ≥ {th:.2f} m　本次未达到")
            else:
                print(f"    {name} ≥ {th:.2f} m　第 {t0:5.1f} 小时")
        tp = float(t_h[int(curve.argmax())]) if len(curve) else 0.0
        print(f"    峰值水深 {float(curve.max()):.3f} m　出现在第 {tp:.1f} 小时")
        if a.remaining is not None:
            t_orange = _first_cross(t_h, curve, 0.20)
            if t_orange is not None:
                need = t_orange - a.remaining
                print()
                if need > 0:
                    print(f"  ★ 距橙级还有 {need:.1f} h，"
                          f"比你的提前量 {a.remaining:.1f} h 更宽裕")
                else:
                    print(f"  ★ 橙级将在 {-need:.1f} h 后到来，"
                          f"早于你的提前量 {a.remaining:.1f} h —— 时间不够")
    else:
        print("  未跑积水场。加 --map 给出逐点校正读数（约 90 s）。")
        print("  分级、动作、可行性三项不需要它——由雨量与规则直接决定。")
        print("  逐点校正的样本外误差：留一法 MAE 0.0909 m（基线 0.3593 m）。")
    print()

    # ---------- 四之二：雨前准备清单 ----------
    if a.map and series:
        print(SUB)
        print("五、雨前准备清单（按具名点位）")
        print(SUB)
        t_h = m["t_h"]
        curve = m["curve"]
        t_orange = _first_cross(t_h, curve, 0.20)
        if t_orange is None:
            print("  本次未达橙级，按常规巡查即可。")
        else:
            lead = a.remaining if a.remaining is not None else t_orange
            print(f"  橙级预计第 {t_orange:.1f} 小时到达；"
                  f"你手上的提前量 {lead:.1f} 小时。")
            print("  下表按「必须在越阈前完成」倒排，来源是结构类型 + 越阈时刻。")
            print()
            rows = sorted(m["rows"], key=lambda x: -x["cor"])
            shown = 0
            for x in rows:
                st = x.get("st") if x.get("st") in PREP_TASKS else None
                if st is None:
                    continue
                tasks = PREP_TASKS[st]
                if shown >= 4:
                    break
                shown += 1
                print(f"  ▸ {x['id']} {x['name'][:20]}"
                      f"（{st}）预计水深 {x['cor']:.2f} ± {x['band']:.2f} m")
                for name, need in tasks:
                    slack = lead - need
                    ok = "✓" if slack >= 0 else "✗"
                    print(f"      {ok} {name:<24} 需 {need:>4.1f} h　"
                          f"{'余 ' + format(slack, '.1f') + ' h' if slack >= 0 else '缺 ' + format(-slack, '.1f') + ' h'}")
                print(f"      责任人：＿＿＿　物资数量：＿＿＿（需本单位填写）")
                print()
            print("  ★ 动作是按结构类型的通用工程做法，不是本地台账；"
                  "责任人一栏本产品不知道，故留空。")
        print()

    print(SUB)
    print("六、这条结论的边界")
    print(SUB)
    def _bullets(v) -> str:
        items = v if isinstance(v, (list, tuple)) else [v]
        return "\n          ".join(f"· {str(x)}" for x in items if str(x).strip())

    if not basis_ok:
        print(f"  口径　：本次历时 {a.hours:.0f} h ≠ {DEFAULT_HOURS:.0f} h，"
              "**分位档与响应等级不给**（无该历时的分位）。")
        print("          积水场与越阈时刻不受此限。")
    if series:
        # 序列输入下，"什么时候"从答不了变成答得出；其余限制不变
        cannot = [x for x in (r.get("不能回答") or [])
                  if "什么时候" not in str(x)]
        print("  能回答：· 该量级落在哪一档")
        print("          · 应启动什么等级、配多少人")
        print("          · 还来不来得及")
        print("          · **什么时候越阈**（因为你给了时间形状）")
        print(f"  不能答：{_bullets(cannot)}")
    else:
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
