"""p24 官方响应时间线 vs 事件 vs 披露：信息不对称到底在哪一环。

此前 p23 用"模型提前量 − 报道滞后"得到一个"净可用 5.96 h"，
但那把三件不同的事混成了一个数。取到官方的应急响应时刻后，真相是：

    官方响应 早于 事件 约 27–52 小时（不是晚了，而是很早就到位）
    但"具体哪个街区会淹多深"的披露，晚于事件约 13 小时

即：**信息不对称不在"预警晚"，而在"预警泛"**。
政府早就进入最高级别响应，但"集士港广蔺社区会淹 90 cm"这个可处置的信息，
是在水已经淹了之后才公开的。

本件把三类时刻分开列出，并算出各自的提前/滞后量。

数据来源（逐条标注，全部为公开可核）：
    中国气象局 / 浙江省应急管理厅 / 宁波市应急管理局 / 央广网 / 澎湃新闻 / Sentinel-1B

用法：python -m typhoeus.timeline
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"

# (时刻, 类别, 事件, 来源)
TIMELINE = [
    ("2021-07-20 00:00", "官方准备", "鄞州百丈街道召开防台防汛部署会",
     "浙江省应急管理厅（转宁波市应急管理局）"),
    ("2021-07-22 00:00", "官方准备", "街道启动隐患排查与 24 小时值班",
     "浙江省应急管理厅（转宁波市应急管理局）"),
    ("2021-07-23 08:20", "官方响应", "宁波市气象局台风应急响应升至 Ⅱ 级；已发布台风黄色预警信号",
     "中国气象局"),
    ("2021-07-23 16:00", "官方行动", "辖区 3 个建筑工地 822 名工人全部转移完成",
     "浙江省应急管理厅（转宁波市应急管理局）"),
    ("2021-07-24 09:00", "官方响应", "宁波市防指将防台风应急响应提升至 Ⅰ 级（最高级）",
     "浙江省应急管理厅（转宁波市应急管理局）"),
    ("2021-07-25 06:00", "模型", "本产品内核时间轴起点（早于此无模型输出）", "本项目"),
    ("2021-07-25 12:00", "断供事件", "首条断供通报：电梯停梯 / 配电停供",
     "宁波市应急管理局 07-25 通报"),
    ("2021-07-25 21:00", "断供事件", "海曙洞桥镇 5 万人转移启动", "央广网 07-26 通报"),
    ("2021-07-25 22:00", "断供事件", "古林、集士港道路封道；集士港镇区转移启动", "澎湃新闻 07-26 报道"),
    ("2021-07-26 04:00", "断供事件", "集士港 11 台排水泵分片强排", "澎湃新闻 07-26 报道"),
    ("2021-07-26 05:50", "观测", "Sentinel-1B 过境（模型提前量的参照时刻）", "AWS Sentinel-1B"),
    ("2021-07-27 12:00", "官方响应", "防台风应急响应由 Ⅰ 级调整为 Ⅱ 级", "央广网 07-27 报道"),
    ("2021-07-28 11:22", "具体披露", "广蔺社区幸福里小区积水 90 cm 首次见报",
     "央广网 07-28 报道"),
]

# 三个时间量（各自相对于"首个断供事件" 07-25 12:00）
FIRST_EVENT = "2021-07-25 12:00"


def _dt(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%d %H:%M")


def build(outdir: str = "out", verbose: bool = True) -> dict:
    ev = _dt(FIRST_EVENT)
    rows = []
    for t, kind, desc, src in TIMELINE:
        d = _dt(t)
        rows.append({
            "时刻": t, "类别": kind, "事件": desc, "来源": src,
            "相对首事件_h": round((d - ev).total_seconds() / 3600.0, 2),
        })

    def lead(ts: str) -> float:
        return round((ev - _dt(ts)).total_seconds() / 3600.0, 2)

    # 三类时刻的提前/滞后量（都相对首个断供事件）
    official_2 = lead("2021-07-23 08:20")     # Ⅱ级
    official_1 = lead("2021-07-24 09:00")     # Ⅰ级
    model_start = lead("2021-07-25 06:00")    # 模型轴起点
    disclose = round((_dt("2021-07-28 11:22") - ev).total_seconds() / 3600.0, 2)
    sar = lead("2021-07-26 05:50")

    # 模型首次越阈：由 p18 的提前量反推（SAR 过境 − 提前量）
    # 注意 lead() 的约定是「正=在事件之前」，SAR 在事件后 17.83 h 故 lead=−17.83；
    # 模型比 SAR 早 19.33 h ⇒ lead 加回 19.33，得 +1.50（即在事件前 1.5 h）。
    MODEL_LEAD_OVER_SAR = 19.33               # p18 提前量中位
    model_cross = round(sar + MODEL_LEAD_OVER_SAR, 2)
    road_close = 10.0                          # 07-25 22:00（事件后 10 h）
    pumping = 16.0                             # 07-26 04:00（事件后 16 h）

    # 配对对比：模型 vs 官方宏观预警；模型 vs 官方具体处置
    # 约定统一为「正数 = 前者更早」
    pairing = {
        "官方Ⅰ级响应": {"相对首事件_h": official_1},
        "模型越阈": {"相对首事件_h": model_cross,
                   "来源": "p18 提前量 19.33 h 反推（SAR 过境 lead=−17.83 h）"},
        "官方相对模型更早_h": round(official_1 - model_cross, 2),
        "道路封道": {"相对首事件_h": road_close,
                   "模型相对其更早_h": round(road_close - model_cross, 2)},
        "强排作业": {"相对首事件_h": pumping,
                   "模型相对其更早_h": round(pumping - model_cross, 2)},
    }

    payload = {
        "名称": "官方响应时间线 vs 事件 vs 披露",
        "生成时间": datetime.now().isoformat(timespec="seconds"),
        "问题": "信息不对称，到底是不对称在哪一环？",
        "基准": {"首个断供事件": FIRST_EVENT},
        "时间线": rows,
        "三个时间量": {
            "官方Ⅱ级响应_提前_h": official_2,
            "官方Ⅰ级响应_提前_h": official_1,
            "模型时间轴起点_提前_h": model_start,
            "模型首次越阈_提前_h": model_cross,
            "SAR过境_提前_h": sar,
            "具体信息披露_滞后_h": disclose,
        },
        "配对对比_同一场事件的三个层面": pairing,
        "核心判断": {
            "结论": "预警层面官方赢，处置层面模型赢；两者不是替代关系。",
            "依据": [
                f"官方 Ⅰ 级响应在首事件前 {official_1:.1f} h，"
                f"而模型越阈在 {model_cross:+.1f} h——**官方比模型早 "
                f"{round(official_1 - model_cross, 1):.1f} h**。",
                f"但官方的具体处置动作晚：道路封道 {road_close:+.1f} h、"
                f"强排作业 {pumping:+.1f} h，"
                f"而模型在 {model_cross:+.1f} h 已给出该处会积水的判据——"
                f"**模型比封道早 {round(road_close - model_cross, 1):.1f} h、"
                f"比强排早 {round(pumping - model_cross, 1):.1f} h**。",
                "所以缺的不是预警时间（官方已很充足），"
                "而是**从『全域最高级响应』到『这条街派泵车』之间的具体化环节**。",
            ],
            "对产品的含义":
                "本产品的定位应是『**预警与处置之间的具体化层**』——"
                "把 Ⅰ 级响应转化成逐街区的动作清单，而不是替代或提前官方预警。",
        },
        "对 p23 的修正": {
            "原表述": "净可用预警 = 模型提前量 19.33 h − 报道滞后 13.37 h = 5.96 h",
            "问题": "把『新闻报道时刻』当成『信息可用时刻』。新闻报道是**事后记录**，"
                    "不是预警渠道；拿它当参照会得到虚假的『净可用』。"
                    "官方 Ⅰ 级响应远早于模型时间轴起点，模型不可能提供更早的宏观预警。",
            "修正后": "以**官方处置动作**（封道 +10 h、强排 +16 h）为参照，"
                      f"模型越阈 {model_cross:+.1f} h，故模型对处置的提前量为 "
                      f"{round(road_close - model_cross, 1):.1f}–"
                      f"{round(pumping - model_cross, 1):.1f} h。"
                      "p23 的 5.96 h 应作废，改用本节的配对值。",
        },
        "边界": [
            "官方时刻取自公开通报，分钟级；街道级部署会仅有日期无时刻，按 00:00 近似。",
            "模型越阈时刻由 p18 的**中位**提前量反推，不是本事件某具体格点的实测越阈时刻。",
            "封道与强排是**类别级**动作时刻（该类别首条记录），非某个特定涝点的动作时刻。",
            "未取得宁波市气象台台风预警信号的逐次发布记录（黄/橙/红），故预警层次不完整。",
            "『具体信息披露滞后』只有广蔺社区一例，样本量 1。",
        ],
    }
    p = Path(outdir)
    p.mkdir(parents=True, exist_ok=True)
    (p / "p24_官方响应时间线.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    if verbose:
        print(f"  基准：首个断供事件 {FIRST_EVENT}")
        for r in rows:
            mark = "◀" if abs(r["相对首事件_h"]) < 0.1 else ""
            print(f"    {r['时刻']}  {r['相对首事件_h']:>+8.2f} h  "
                  f"[{r['类别']:<6}] {r['事件'][:34]} {mark}")
        print(f"\n  官方 Ⅱ 级提前 {official_2:.1f} h；Ⅰ 级提前 {official_1:.1f} h")
        print(f"  模型轴起点在 Ⅰ 级之后 {abs(model_start):.1f} h")
        print(f"  具体信息披露滞后 {disclose:.1f} h")
        print(f"→ {p / 'p24_官方响应时间线.json'}")
    return payload


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="typhoeus.timeline")
    ap.add_argument("outdir", nargs="?", default="out")
    a = ap.parse_args(argv)
    build(a.outdir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
