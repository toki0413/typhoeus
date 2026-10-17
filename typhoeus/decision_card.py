"""p32 规划决策卡：把已有产物压成"每点一行、四列即决策"。

规划岗真正要的不是"这个点会淹多深"，而是三句话：
    ① 这个点属于哪一型  → 该用什么手段
    ② 这个结论稳不稳    → 阈值是否落在翻转带内
    ③ 要达到目标需多少  → 排水/降雨的反解门槛

本件把下列已有产物合并，逐点成行（不跑新内核）：
    p13 涝点明细   → 观测水深、模型峰值
    p17 归因分解   → ①排水已承担 / ②可再挖 / ③雨不可消 的占比与分型
    p19-p20        → 四档峰值、决策翻转带、带内阈值
    p31 排水异质性 → 下穿立交的"排水受限型 / 无汇流型"二分辨

输出：out/p32_规划决策卡.json 与 out/p32_规划决策卡.html
用法：python -m typhoeus.decision_card
"""

from __future__ import annotations

import argparse
import csv
import json
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SEED = ROOT / "data" / "seed"
OUT = ROOT / "out"

# 分型 → 建议手段（与 p17 的机制解释一一对应）
ADVICE = {
    "排水兜底型": "泵站双电源、汛前清淤、专人值守（保住排水在运行）",
    "排水可挖型": "雨污分流 / 加大管径（有明确投资回报）",
    "雨致型": "调蓄池 / 下沉式绿地 / 竖向改造（加排水无效）",
    "模型无水型": "不得据此决策；需实测或提高分辨率",
    "无汇流型": "补局部容器几何（下穿竖向剖面）或提到 30 m 分辨率",
    "排水受限型": "按结构类型下调该处排水能力至全域均值 ~10%（已验证）",
}
# 可信度排序：越靠前越不可信
CONFIDENCE = {
    "不可信-域外或未判定": 0,
    "不可信-模型无信号": 1,
    "不可信-结论随情景翻转": 2,
    "可参考-结论稳定": 3,
}


def _norm_kind(k: str | None) -> str:
    """归一化分型名。

    p17 输出的是「模型无水」「排水兜底型」这类**没有统一后缀**的字符串，
    p31 输出的是「无汇流型」「排水受限型」。不归一化会静默漏判
    （实测：FP015/017/020/024 因此被误标为『可参考』）。
    """
    if not k:
        return "未判定"
    base = k.rstrip("型")
    return {"模型无水": "模型无水型"}.get(base, base + "型" if base in
                                       ("排水兜底", "排水可挖", "雨致",
                                        "无汇流", "排水受限") else k)





def _load(p: Path) -> list[dict]:
    with open(p, encoding="utf-8-sig") as f:
        return [{k.lstrip("\ufeff"): v for k, v in r.items()}
                for r in csv.DictReader(f)]


def _read_json(name: str) -> dict:
    p = OUT / name
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


def build(outdir: str = "out", verbose: bool = True) -> dict:
    base = {}
    for r in _load(SEED / "flood_points_2021_infa.csv"):
        base[r["point_id"]] = r

    p13 = _read_json("p13_生命线断供预判.json")
    p17 = _read_json("p17_归因分解.json")
    p20 = _read_json("p19-p20_代价排序与决策稳定性.json")
    p31 = _read_json("p31_排水异质性.json")

    # 索引
    idx = {}
    for r in p13.get("涝点阈越", {}).get("明细", []):
        idx.setdefault(r["编号"], {}).update({
            "观测_m": r.get("观测水深_m"), "模型峰值_m": r.get("模型峰值_m")})
    for r in p17.get("涝点明细", []):
        idx.setdefault(r["编号"], {}).update({
            "p17分型": r.get("分型"),
            "①排水已承担": r.get("①占比"),
            "②排水可再挖": r.get("②占比"),
            "③雨不可消": r.get("③占比"),
            "无排水时_m": r.get("无排水_m"),
        })
    for r in p20.get("P20_决策稳定性", {}).get("明细", []):
        idx.setdefault(r["编号"], {}).update({
            "翻转带": r.get("翻转带_h"), "带内阈值": r.get("带内阈值"),
            "不稳定": r.get("不稳定"), "四档峰值": r.get("四档峰值_m")})
    for r in p31.get("逐点", []):
        idx.setdefault(r["编号"], {}).update({
            "p31诊断": r.get("诊断"), "p31最大_m": r.get("最大模型值_m"),
            "p31对应乘子": r.get("对应乘子")})

    rows = []
    for pid, b in sorted(base.items()):
        info = idx.get(pid, {})
        # 分型：下穿立交优先用 p31 的二分辨，其余用 p17 四型
        struct = b.get("structure_type", "")
        if struct == "下穿立交" and info.get("p31诊断"):
            kind = _norm_kind(info["p31诊断"])
        else:
            kind = _norm_kind(info.get("p17分型"))

        has_signal = (info.get("模型峰值_m") or 0) > 1e-6
        unstable = bool(info.get("不稳定"))
        # 「无汇流型 / 模型无水型」意味着模型那里没有水进来，
        # 即使数值上 >0（如 FP005 的 0.094 m）也不能当作可用信号。
        no_signal_kind = kind in ("无汇流型", "模型无水型")
        if kind == "未判定":
            conf = "不可信-域外或未判定"
        elif no_signal_kind or not has_signal:
            conf = "不可信-模型无信号"
        elif unstable:
            conf = "不可信-结论随情景翻转"
        else:
            conf = "可参考-结论稳定"

        rows.append({
            "编号": pid, "名称": b["name"], "结构": struct,
            "观测水深_m": float(b["depth_m"]) if b.get("depth_m") else None,
            "模型峰值_m": info.get("模型峰值_m"),
            "分型": kind,
            "翻转带_m": info.get("翻转带"),
            "带内阈值_m": info.get("带内阈值") or [],
            "①排水已承担": info.get("①排水已承担"),
            "②排水可再挖": info.get("②排水可再挖"),
            "③雨不可消": info.get("③雨不可消"),
            "建议手段": ADVICE.get(kind, "未判定，暂不建议"),
            "可信度": conf,
            "可信度序": CONFIDENCE[conf],
        })

    rows.sort(key=lambda r: (r["可信度序"], -(r["观测水深_m"] or 0)))
    from collections import Counter
    cnt = Counter(r["分型"] for r in rows)
    ccnt = Counter(r["可信度"] for r in rows)
    usable = [r for r in rows if r["可信度"] == "可参考-结论稳定"]

    payload = {
        "名称": "规划决策卡",
        "生成时间": datetime.now().isoformat(timespec="seconds"),
        "用途": "每点一行：分型决定手段，翻转带决定可信度，占比决定该投哪一侧",
        "数据来源": ["p13 涝点明细", "p17 归因分解", "p19-p20 决策稳定性",
                 "p31 排水异质性"],
        "汇总": {
            "点位数": len(rows),
            "分型分布": dict(cnt),
            "可信度分布": dict(ccnt),
            "可直接用于规划决策的点数": len(usable),
            "说明": "只有『可参考-结论稳定』的点可直接进入规划建议；"
                    "其余须先补实测或提高分辨率。",
        },
        "决策卡": rows,
        "读法": [
            "① 分型 → 决定手段：排水兜底型保运行、可挖型加管径、"
            "雨致型做调蓄、无汇流型补几何/提分辨率。",
            "② 翻转带 → 决定可信度：若你的决策阈值落在带内，"
            "结论随情景改变，不能单情景下结论。",
            "③ ①/②/③ 占比 → 决定投入方向：②高做排水，③高做调蓄。",
        ],
        "边界": [
            "观测水深为公开通报口径，5 处下立交统一 0.50 m，可能被取整。",
            "『可信度』只反映模型内部的自洽性与稳定性，不代表与实况一致。",
            "分型由 p17 的模型自对照得出，不是实测归因。",
            "本卡不覆盖计算域外的 11 个涝点与 8 条域外断供记录。",
            "任何一行都不应单独作为投资依据，须与现场核查合并使用。",
        ],
    }
    p = Path(outdir)
    p.mkdir(parents=True, exist_ok=True)
    (p / "p32_规划决策卡.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    # 一页 HTML（可直接打印给规划岗）
    def fmt(v, nd=2):
        return "—" if v is None else (f"{v:.{nd}f}" if isinstance(v, float) else str(v))

    trs = []
    for r in rows:
        band = ("—" if not r["翻转带_m"]
                else f"[{r['翻转带_m'][0]:.2f}, {r['翻转带_m'][1]:.2f}]")
        thr = "、".join(f"{t:.2f}" for t in r["带内阈值_m"]) or "—"
        flag = "✅" if r["可信度"] == "可参考-结论稳定" else "⚠️"
        trs.append(
            f"<tr><td>{r['编号']}</td><td>{r['名称']}</td><td>{r['结构']}</td>"
            f"<td class='c'>{fmt(r['观测水深_m'])}</td>"
            f"<td class='c'>{fmt(r['模型峰值_m'], 3)}</td>"
            f"<td><b>{r['分型']}</b></td>"
            f"<td class='c'>{band}</td><td class='c'>{thr}</td>"
            f"<td>{r['建议手段']}</td><td class='c'>{flag} {r['可信度'].split('-')[1]}</td></tr>")

    html = f"""<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>规划决策卡</title>
<style>
body{{font-family:-apple-system,"Microsoft YaHei",sans-serif;margin:24px;color:#222;font-size:13px}}
h1{{font-size:20px;margin:0 0 4px}} .sub{{color:#666;font-size:12px;margin-bottom:14px}}
table{{border-collapse:collapse;width:100%}}
th,td{{border:1px solid #d8d8d8;padding:5px 7px;vertical-align:top}}
th{{background:#f4f4f4;text-align:left;font-weight:600}}
td.c{{text-align:center}} tr:nth-child(even){{background:#fbfbfb}}
.box{{background:#f7f9fc;border-left:3px solid #4a7ab5;padding:10px 12px;margin:14px 0}}
.mut{{color:#666;font-size:12px}}
</style></head><body>
<h1>规划决策卡</h1>
<div class="sub">生成 {payload['生成时间']} · 共 {len(rows)} 个点位 ·
可直接决策 {len(usable)} 个 · 数据来源：p13 / p17 / p19-p20 / p31</div>
<div class="box"><b>读法</b><br>
① <b>分型</b>决定手段：排水兜底型保运行、可挖型加管径、雨致型做调蓄、无汇流型补几何或提分辨率。<br>
② <b>翻转带</b>决定可信度：决策阈值若落在带内，结论随情景改变，不能单情景下结论。<br>
③ <b>①②③占比</b>决定投入方向：②高做排水，③高做调蓄。</div>
<table>
<tr><th>编号</th><th>名称</th><th>结构</th><th>观测 m</th><th>模型 m</th><th>分型</th>
<th>翻转带 m</th><th>带内阈值</th><th>建议手段</th><th>可信度</th></tr>
{''.join(trs)}
</table>
<div class="mut" style="margin-top:14px">
边界：观测水深为公开通报口径（5 处下立交统一 0.50 m）；可信度只反映模型内部自洽性，
不代表与实况一致；分型来自模型自对照而非实测归因；不覆盖域外 11 个涝点与 8 条域外断供记录。
任何一行都不应单独作为投资依据，须与现场核查合并使用。
</div></body></html>"""
    (p / "p32_规划决策卡.html").write_text(html, encoding="utf-8")

    if verbose:
        print(f"  {len(rows)} 个点位；分型 {dict(cnt)}")
        print(f"  可信度 {dict(ccnt)}")
        print(f"  可直接决策 {len(usable)} 个："
              f"{', '.join(r['编号'] for r in usable)}")
        for r in rows[:6]:
            print(f"    {r['编号']} {r['名称'][:14]:<16} {r['分型']:<6} "
                  f"{r['可信度']:<18} {r['建议手段'][:22]}")
        print(f"→ {p / 'p32_规划决策卡.html'}")
    return payload


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="typhoeus.decision_card")
    ap.add_argument("outdir", nargs="?", default="out")
    a = ap.parse_args(argv)
    build(a.outdir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
