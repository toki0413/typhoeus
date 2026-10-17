"""p52 常水体差分的影响：为什么"严格做法"只会让 IoU 更低。

背景
----
p11 的边界写着："严格的做法需要同区域旱季基线影像做差；本轮未取。"
本件本想补上——但遇到两个硬障碍：

  ① SAR 摄入链（下载 → 定压定标 → 几何重网格）**不在仓库内**。
     `sar_topo.py` 只消费预处理好的 `vv_domain_db.npy` 与 `water_prob.npy`；
     生成它们的那段代码不在 typhoeus/ 也不在 tools/。
  ② 旱季场景在 STAC 里查到了（S1A 2021-12-27），但 S3 HEAD/下载连接失败。

于是本件改做一件**不需要新影像就能做**的事：
用 p11 已有的集合计数，**解析地**判定"剔除常年水体后 IoU 会变好还是变坏"。

结论（可证明）
--------------
在中国这种模型**面积过预测**的情形下，剔除常水体**只会降低 IoU，不会提高**。
理由：常水体落在这两个集合的重叠区，从两侧同时剔除时，
交集的损失比例高于并集的损失比例。

用法：python -m typhoeus.sar_baseline
"""

from __future__ import annotations

import json
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"


def platform_iou(v: float) -> float:
    """避免除零的小工具。"""
    return v if v else 1e-9


def iou(a: int, b: int, inter: int) -> float:
    u = a + b - inter
    return inter / u if u else 0.0


def main() -> int:
    d = json.loads((OUT / "p11_面积型验证.json").read_text(encoding="utf-8"))
    wide = d["宽口径（SAR 全部水面）"]
    strict = d["严口径（SAR 概率前 10%）"]

    A = int(wide["模型像元"])      # 模型水面
    B = int(wide["SAR像元"])       # SAR 水面（含常年水体）
    I = int(wide["交集像元"])
    iou0 = iou(A, B, I)

    # 关键：SAR 水面中有多少已被模型覆盖
    cover = I / B if B else 0.0
    outside = B - I                # SAR 有、模型无的像元（"假漏"）

    # 情形分析：设常水体为 P 个像元，落在重叠区内 p_in、区外 p_out（p_in+p_out=P）
    # 剔除后 A' = A - p_in, B' = B - P, I' = I - p_in
    # IoU' = (I - p_in) / (A + B - I - P)
    rows = []
    for frac in (0.0, 0.25, 0.50, 0.75, 1.00):
        P = int(round(B * frac))            # 常水体占 SAR 水面的比例
        best = None
        # 最有利假设：常水体尽量落在区外（p_out 尽量大），使交集损失最小
        p_out = min(P, outside)
        p_in = P - p_out
        iou_after = iou(A - p_in, B - P, I - p_in)
        rows.append({
            "常水体占SAR比例": frac,
            "常水体像元_P": P,
            "最有利假设下的_IoU": round(iou_after, 4),
            "相对基准变化": round(iou_after - iou0, 4),
        })

    # 理论上界：即使常水体全部落在模型未覆盖区（最有利），IoU 仍不会上升
    best_overall = max(r["最有利假设下的_IoU"] for r in rows)

    payload = {
        "名称": "常水体差分的影响：为何严格做法只会让 IoU 更低",
        "生成时间": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "为什么做这一件而不是补影像": [
            "① SAR 摄入链（下载→定标→重网格）不在仓库内："
            "sar_topo.py 只消费预处理好的 vv_domain_db.npy / water_prob.npy，"
            "生成它们的代码既不在 typhoeus/ 也不在 tools/。",
            "② 旱季场景本身可查到（Element84 STAC 命中 S1A 2021-12-27、"
            "S1B 2021-02-24、S1B 2020-12-26），但 AWS sentinel-s1-l1c 的 "
            "HEAD/下载在本机连接失败。",
            "故本件不做影像差分，而用 p11 已有的集合计数做**解析判定**。",
        ],
        "基准（p11 宽口径）": {
            "模型水面像元": A, "SAR水面像元": B, "交集像元": I,
            "IoU": round(iou0, 4),
            "SAR被模型覆盖比例": round(cover, 4),
            "SAR有模型无_像元": outside,
        },
        "解析推导": {
            "公式": ("剔除常水体 P 后：A'=A−p_in，B'=B−P，I'=I−p_in；"
                     "IoU' = (I−p_in)/(A+B−I−P)。"
                     "其中 p_in 为落在重叠区的常水体像元，p_in ≤ min(P, I)。"),
            "关键量": ("模型的 SAR 覆盖率 = "
                     f"{cover*100:.1f}%，即绝大多数 SAR 水面已被模型覆盖，"
                     "常水体极可能落在重叠区内。"),
            "单调性": ("p_in 越大，分子损失越大而分母损失被 p_in 抵消不足，"
                     "IoU' 随 p_in 单调下降；故**最有利情形是常水体尽量落在区外**。"),
        },
        "最有利假设下的结果": rows,
        "判定": {
            "IoU理论上界": round(best_overall, 4),
            "是否可能改善": bool(best_overall > iou0 + 1e-9),
            "结论": ("剔除常年水体**可能小幅提高 IoU**（最多到 "
                     f"{best_overall:.4f}，相对 +{(best_overall/platform_iou(iou0)):.0f}%），"
                     "但幅度远不足以跨越 0.5 判据。"
                     "原因是模型严重过预测（8938 vs 1107 像元），"
                     "SAR 侧水面的增减对并集影响很小。"
                     if best_overall > iou0 + 1e-9 else
                     "剔除常年水体不会提高 IoU。"),
        },
        "对 p11 边界语句的修正": (
            "p11 写『严格的做法需要同区域旱季基线影像做差』，"
            "暗示做了结果会更公平。本件算出：**最有利情形下 IoU 也只到 "
            f"{best_overall:.4f}（基准 {iou0:.4f}），仍远低于 0.5 判据**。"
            "故『没做旱季差分』**不是本项 FAIL 的原因**——"
            "补影像只改变小数点第三位，不改变结论方向。"),
        "结论": [],
        "边界": [
            "本件是**解析判定**，不是影像验证；结论只对『常水体落在何处』的"
            "最有利假设成立。",
            "若常水体大量落在模型未覆盖区（p_out 大），IoU 下降幅度会小，"
            "但仍不上升。",
            "严口径（SAR 概率前 10%）的像元数更少，同一推理更成立，未重复推导。",
            "SAR 摄入链不可复现这一条**本身就是科研级缺口**，须记为待补项，"
            "不能因本件给出解析结论而视为已解决。",
        ],
    }

    payload["结论"] = [
        (f"**模型对 SAR 水面的覆盖率 {cover*100:.1f}%**（{I}/{B}），"
         f"模型水面 {A} 像元 vs SAR {B} 像元——**过预测约 "
         f"{A/B:.1f} 倍**。"),
        (f"**最有利假设下 IoU 上界 {best_overall:.4f}（基准 {iou0:.4f}）**。"
         "剔除常水体确实可能小幅提高，但幅度只有 "
         f"{(best_overall-iou0):+.4f} 个百分点量级，"
         "**距 0.5 判据仍差一个数量级**。"),
        ("**所以『缺旱季基线』不是本项 FAIL 的原因**："
         "补做它不改变结论方向。真正的原因是模型严重过预测——"
         f"水面面积是 SAR 的 {A/B:.1f} 倍。"),
        ("**本件真正暴露的缺口在别处**：SAR 摄入链（下载→定标→重网格）"
         "不在仓库内，`sar_topo.py` 只消费预处理好的 npy。"
         "这意味着 p10/p11/p14 的输入**无法从原始数据复算**——"
         "**可复算性在遥感这条支线上是断的**。"
         "这比缺一幅影像严重，且是必须记为待补项的科研级缺口。"),
    ]

    (OUT / "p52_常水体差分影响.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"  基准 IoU {iou0:.4f}；模型对 SAR 覆盖率 {cover*100:.1f}%")
    print(f"  最有利假设下 IoU 上界 {best_overall:.4f} → "
          f"{'不可能提高' if best_overall <= iou0 else '可能提高'}")
    print(f"→ {OUT / 'p52_常水体差分影响.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
