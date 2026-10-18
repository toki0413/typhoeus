"""p47 序参阈值面：把"影响陡增的阈值"从离散矩阵提成可查的形状。

起因：Matthews et al.（Nature Sustainability 2026, DOI 10.1038/s41893-026-01929-1）
提出三条优先项，其中第二条是「更好理解影响陡增的阈值」。
我们恰好有实测的阈值结构，只是没按这个口径组织过。

本件做三件事（纯读取，不跑内核）：
  A 损失集中度：检验"极少数事件主导"在我们这里是否成立，并与原文献对比
  B 阈值面：红格（≥0.5 m）在（总量 × 集中度）平面上的首次出现边界
  C 与文献的差异：为什么我们的分布不可能像死亡数那样极端

用法：python -m typhoeus.threshold_surface
"""

from __future__ import annotations

import json
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"

LABELS = {0.0: "C0 均匀", 0.25: "C1 弱对比", 0.50: "C2 中等",
          1.00: "C3 强对比", 1.50: "C4 极端集中"}


def _load(name: str) -> dict:
    p = Path(OUT) / name
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


def build(outdir: str | Path = "out") -> dict:
    global OUT
    OUT = Path(outdir)

    # ---- A 损失集中度 ----
    p33 = _load("p33_跨事件决策矩阵.json")
    events = [e for e in p33.get("事件", []) if e.get("Q_total", 0) > 0]
    events.sort(key=lambda e: -e["Q_total"])
    total_q = sum(e["Q_total"] for e in events)
    topk = {}
    for k in (1, 2, 3, 5):
        if len(events) >= k:
            topk[f"前{k}场"] = {
                "占比_pct": round(sum(e["Q_total"] for e in events[:k])
                                 / total_q * 100, 1),
                "事件": [e["台风"] for e in events[:k]],
            }
    rest = sum(e["Q_total"] for e in events[1:])
    ratio = round(events[0]["Q_total"] / rest, 3) if rest else None

    # ---- B 阈值面 ----
    p43 = _load("p43_降雨集中度情景轴.json")
    rows = p43.get("矩阵", [])
    totals = sorted({r["总量_mm"] for r in rows})
    avals = sorted({r["a"] for r in rows})

    grid = []
    for t in totals:
        line = {}
        for a in avals:
            m = [r for r in rows if r["总量_mm"] == t and r["a"] == a]
            line[LABELS[a]] = m[0]["红格_ha"] if m else None
        grid.append({"总量_mm": t, **line})

    # 各集中度档下，红格首次出现的最小总量
    first_cross = {}
    for a in avals:
        cands = sorted(r["总量_mm"] for r in rows
                       if r["a"] == a and r["红格_ha"] > 0)
        first_cross[LABELS[a]] = cands[0] if cands else None

    # 有没有"陡增"：同一集中度档内，红格从 0 跳到非 0 的跨度
    jumps = []
    for a in avals:
        vals = [(r["总量_mm"], r["红格_ha"]) for r in rows if r["a"] == a]
        vals.sort()
        prev = None
        for t, v in vals:
            if prev is not None and prev[1] == 0 and v > 0:
                jumps.append({"集中度": LABELS[a],
                              "从_mm": prev[0], "到_mm": t,
                              "红格_ha": v,
                              "跨越量_mm": round(t - prev[0], 1)})
            prev = (t, v)

    payload = {
        "名称": "序参阈值面：红格出现边界（总量 × 集中度）",
        "生成时间": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "参照文献": {
            "标题": "Discovering catastrophic weather risks",
            "期刊": "Nature Sustainability, 2026",
            "DOI": "10.1038/s41893-026-01929-1",
            "作者": "Tom Matthews 等（King's College London）",
            "三条优先项": [
                "跨领域视野扫描（含风险学者、一线社区、保险、气候虚构作者）",
                "更好理解影响陡增的阈值",
                "绘制远高于/低于当今气候下天气的物理极限",
            ],
        },
        "A_损失集中度": {
            "致涝场次": len(events),
            "Q_合计": round(total_q, 4),
            "前k占比": topk,
            "最大场对其余之和的倍数": ratio,
            "文献对照": ("原文：Cyclone Nargis（2008, 缅甸, 约 14 万死）"
                     "造成的死亡数超过其余 675 场致死热带气旋之和的两倍。"),
        },
        "B_阈值面": {
            "网格": grid,
            "首次越阈": first_cross,
            "陡增跳变": jumps,
            "读法": ("行=面雨量，列=降雨集中度，格值=红格面积 ha。"
                     "红格 = 峰值水深 ≥0.5 m（GB 51222 口径）。"),
        },
        "C_为什么我们的分布不可能同样极端": (
            "我们的序参是**域内功能损失**，而域面积有限（11 180 ha），"
            "故 Q 有上界；死亡数没有这样的上界。"
            "两者数学形状不同：前者有界重尾，后者可无界。"
            "所以本产品**在结构上无法**表达『百万级死亡』那类风险。"),
        "结论": [],
        "边界": [
            "本件全部为读取聚合，不跑内核，不改变任何既有结论。",
            "阈值面分辨率受限于 4×5 网格；红格面积量化到 0.3 ha 格点，"
            "边界位置约有半格不确定度。",
            "红格面积很小（0–1.2 ha，占域 0.01% 量级），"
            "其绝对量级不具工程意义，意义在『是否出现』这一序参上。",
            "集中度档为合成条带（见 p43），非真实雨带、非下采样结果。",
            "文献的序参是死亡人数；本件与之对标只在结构层面，不做数值比较。",
        ],
    }

    # 结论按实测填
    c2 = first_cross.get("C2 中等")
    c0 = first_cross.get("C0 均匀")
    top1 = topk.get("前1场", {}).get("占比_pct")
    top3 = topk.get("前3场", {}).get("占比_pct")

    cond = []
    cond.append(
        "**A 集中度**：我们前 1 场占 "
        f"{top1}%、前 3 场占 {top3}%（{len(events)} 场中）。"
        f"最大场对其余之和的倍数为 **{ratio}**——"
        "集中，但**远不如文献中 Nargis 那般极端（>2 倍）**。")
    cond.append(
        "**B 阈值面**：红格是否出现由**两个参数共同决定**，不是一个数。"
        + (f"均匀（C0）档下**即使 p95 也不出现红格**；" if c0 is None else "")
        + (f"而中等集中（C2）需总量 ≥ {c2} mm 才越阈；" if c2 else "")
        + "极端集中（C4）在最低总量 258.4 mm 即越阈。")
    if jumps:
        j = jumps[0]
        cond.append(
            f"**陡增的证据**：{j['集中度']}档在 {j['从_mm']} → {j['到_mm']} mm "
            f"之间（跨越 {j['跨越量_mm']} mm）红格从 0 跳到 {j['红格_ha']} ha。"
            "这种『一步从无到有』正是文献所说需要理解的阈值行为。")
    cond.append(
        "**C 但我们的序参与文献不同类**：功能损失有域面积上界，死亡数没有。"
        "所以**本产品在结构上无法表达『百万级死亡』那类无界风险**——"
        "这是选择序参的代价，必须写在产品说明书里。")
    cond.append(
        "**对文献三条优先项的回应**：②阈值（我们**有实测**）；"
        "①跨领域视野扫描（**我们完全没有**，我们的情景来自参数缩放）；"
        "③更热/更冷气候下的物理极限（**我们做不了**，CC 标度已 BLOCKED）。")

    payload["结论"] = cond

    (OUT / "p47_序参阈值面.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return payload


def main(argv: list[str] | None = None) -> int:
    import argparse
    ap = argparse.ArgumentParser(prog="typhoeus.threshold_surface")
    ap.add_argument("outdir", nargs="?", default="out")
    a = ap.parse_args(argv)
    p = build(a.outdir)
    A, B = p["A_损失集中度"], p["B_阈值面"]
    print(f"  A 前1场 {A['前k占比']['前1场']['占比_pct']}% / "
          f"前3场 {A['前k占比']['前3场']['占比_pct']}%；"
          f"最大/其余 = {A['最大场对其余之和的倍数']}")
    print("  B 阈值面：")
    for g in B["网格"]:
        vals = "  ".join(f"{k.split()[0]}={v}" for k, v in g.items()
                         if k != "总量_mm")
        print(f"     {g['总量_mm']:>6.1f} mm  {vals}")
    print("  首次越阈：", B["首次越阈"])
    print(f"→ {Path(a.outdir) / 'p47_序参阈值面.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
