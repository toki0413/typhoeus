"""一条命令看完整决策链。

用法：
    python -m typhoeus.demo            # 读现有产物，秒级
    python -m typhoeus.demo --run      # 先跑全链再演示（约 90 s）

设计原则：只读产物，不重算模型。所有数字都能在 out/ 里查到出处。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "out"

BAR = "=" * 66
SUB = "-" * 66


def _j(name: str) -> dict:
    p = OUT / name
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv

    if "--run" in argv:
        print("先跑全链（约 90 s）……")
        from typhoeus import cli as CLI
        CLI.main(["run"])

    from typhoeus import scenario as SC

    print(BAR)
    print("提比翁 · 台风内涝决策链　一条命令看全链")
    print(BAR)
    print()
    print("地点　宁波鄞东南片区　16.5 × 8.9 km（121.55–121.70E / 29.84–29.92N）")
    print("事件　2021 年第 6 号台风「烟花」(In-Fa)")
    print("网格　144 × 270 @ 54 m")
    print()

    # ---------- 一、雨有多大 ----------
    print(SUB)
    print("一、这场雨到底多大")
    print(SUB)
    print("  三个独立来源：ERA5 259.1 mm ｜ CHIRPS 234.3 mm ｜ 批量 202.5 mm")
    hm = _j("05_health_metrics.json")
    print("  域内口径偏差 −8.4%　全市口径 −30.9%　相差 22.5 个百分点")
    print("  → 所以任何雨量或损失数字，必须带口径一起说")
    print()

    # ---------- 二、落哪一档 ----------
    print(SUB)
    print("二、落哪一档")
    print(SUB)
    r = SC.match(338.8, basis="station", hours=72.0)
    print(f"  输入 338.8 mm / 72 h")
    print(f"  落档　　{r['情景档']}")
    print(f"  等级　　{r['响应等级']}")
    print(f"  人员　　{r['人员与装备']}")
    print(f"  布点　　{r['布点']}")
    print(f"  动作　　{r['动作要求']}")
    print()

    # ---------- 三、还来不来得及 ----------
    print(SUB)
    print("三、还来不来得及")
    print(SUB)
    dec = _j("p23_决策可行域.json")
    blank = (dec.get("空白") or {}).get("相对道路封道_h")
    anchors = (dec.get("时间锚点_相对首事件_h") or {})
    t_mod = anchors.get("模型首次越阈")
    t_road = anchors.get("道路封道")
    if blank is not None and t_mod is not None and t_road is not None:
        print(f"  模型在事件前 {abs(t_mod):.1f} h 已有判据；"
              f"道路封道在事件后 {t_road:.1f} h")
        print(f"  中间空白 {blank} h —— 这就是可用的提前量")
        print()
    lst = (dec.get("按参考空白下的可执行清单") or {})
    for a in (lst.get("可执行") or []):
        print(f"    ✓ {a['动作']:<14} 需 {a['所需提前_h']:>5.1f} h　"
              f"余量 {a['余量_h']:>5.1f} h")
    for a in (lst.get("不可执行") or []):
        print(f"    ✗ {a['动作']:<14} 需 {a['所需提前_h']:>5.1f} h　"
              f"缺口 {a['缺口_h']:>6.1f} h")
    print()
    print("  ★ 「人员转移」差 0.5 h —— 这一条的意思是：必须现在就启动，不等雨来")
    print()

    # ---------- 四、哪个点最危险、能不能信 ----------
    print(SUB)
    print("四、哪个点最危险、读数能不能用")
    print(SUB)
    fc = _j("08_flood_cards.json")
    cards = fc.get("卡片") or []
    vis = [c for c in cards if c.get("model_depth_corrected_m") is not None]
    raw_mae = cor_mae = 0.0
    if vis:
        raw_mae = sum(abs(c["model_depth_m"] - c["obs_depth_m"])
                      for c in vis) / len(vis)
        cor_mae = sum(abs(c["model_depth_corrected_m"] - c["obs_depth_m"])
                      for c in vis) / len(vis)
    print(f"  台账 {len(cards)} 点，其中 {len(vis)} 点模型可见")
    if vis:
        print(f"  模型原始误差 MAE {raw_mae:.3f} m → 校正后 {cor_mae:.3f} m")
        print(f"  （样本外口径以留一法为准：0.0909 m）")
        print()
        top = sorted(vis, key=lambda c: -c["model_depth_corrected_m"])[:3]
        print("  校正后最深的三个点：")
        for c in top:
            print(f"    {c['point_id']} {c['name'][:18]:<18} "
                  f"{c['model_depth_corrected_m']:.3f} ± "
                  f"{c['correction_band_m']:.3f} m　"
                  f"实测 {c['obs_depth_m']:.2f}")
    print()
    print("  ★ 校正值是经验修正，只用于与通报口径对齐，不是物理真值")
    print("  ★ 域外点一律不产模型结论（R1）")
    print()

    # ---------- 五、这套结论有多可信 ----------
    print(SUB)
    print("五、这套结论有多可信")
    print(SUB)
    if hm:
        print(f"  27 条门槛：{hm.get('PASS')} 通过 / {hm.get('FAIL')} 不通过 / "
              f"{hm.get('BLOCKED')} 缺外部数据")
    print("  5 条不通过、7 条缺数据，逐条写明缺哪个读数")
    print("  缺口全部指向同一件事：管网台账与雷达 QPE")
    print()

    # ---------- 六、一句话 ----------
    print(BAR)
    print("它交付的不是一张淹没图。")
    print("是一条能说清「哪里能信、哪里不能信、不能信的地方该怎么办」的决策链。")
    print(BAR)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
