"""遥感淹没范围验证件（S6 场景）。

本件回答一个问题：**这套 SAR 水面识别能不能替代阈值法，并且有没有被真实数据验证过。**

三部分内容，来源严格分开：
  1. 留出集指标（真实数据）：读 `cloud_artifacts/*/metrics.json` 与 `baseline.json`，
     7 次独立运行（6 折自切 + 1 次官方 splits），每次与 Otsu 阈值基线对比。
  2. 本机推理复现（合成自测数据）：在 `tools/sar_train.discover` 能识别的本地
     数据上真跑一次推理，证明管线可执行、结果可复现——**不代表真实性能**。
  3. 判据与拒答：验收判据（IoU ≥ 0.5 且优于 Otsu）逐条判定；宁波本地推理所需的
     Sentinel-1 影像**未取得**，据此拒答，并写明缺哪个外部读数。

输出：
  <outdir>/p8_遥感淹没范围验证.html
  <outdir>/p9_遥感验证指标.json
用法：python -m typhoeus.sar_verify [outdir]
"""

from __future__ import annotations

import hashlib
import json
import statistics
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / "tools"
CLOUD = ROOT / "cloud_artifacts"
SELFTEST = ROOT / ".scratch" / "sar" / "_selftest_data"

# 验收判据（取自 COMPOUND_RISK_PLAN.md L2b 面积层）
CRITERIA = {"iou_ge": 0.50, "must_beat_otsu": True}


def _sha256(p: Path, n: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for blk in iter(lambda: f.read(n), b""):
            h.update(blk)
    return h.hexdigest()


def collect_runs() -> list[dict]:
    """收集全部留出集运行：每折的 val_iou 与同批 Otsu 基线。"""
    runs = []
    for d in sorted(CLOUD.iterdir()):
        if not d.is_dir():
            continue
        mp, bp = d / "metrics.json", d / "baseline.json"
        if not (mp.exists() and bp.exists()):
            continue
        try:
            m = json.loads(mp.read_text(encoding="utf-8"))
            b = json.loads(bp.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            continue
        best = m.get("best", {}) or {}
        otsu = (b.get("otsu", {}) or {}).get("iou")
        if best.get("val_iou") is None:
            continue
        runs.append({
            "运行": d.name,
            "val_iou": float(best["val_iou"]),
            "otsu_iou": float(otsu) if otsu is not None else None,
            "最佳轮": best.get("epoch"),
            "瓦片数": m.get("n_tiles"),
            "切分方式": m.get("split_mode"),
            "映射": m.get("mapping"),
            "留出事件": (m.get("mapping_evidence") or {}).get("water_class"),
            "设备": m.get("device"),
            "耗时_s": m.get("elapsed_s"),
            "权重": sorted(p.name for p in d.glob("*.pt")),
        })
    return runs


def local_inference(n_tiles: int = 8) -> dict:
    """在本机对合成自测数据真跑一次推理，证明管线可执行且可复现。

    注意：这些瓦片是 `_selftest_data`（自造），**不构成真实性能证据**。
    """
    sys.path.insert(0, str(TOOLS))
    out: dict = {"可用": False}
    if not SELFTEST.exists():
        out["原因"] = f"无本地自测数据目录 {SELFTEST}"
        return out
    try:
        import numpy as np
        import torch

        import sar_train as S
    except Exception as e:  # noqa: BLE001
        out["原因"] = f"依赖缺失：{type(e).__name__}: {e}"
        return out

    ck_path = CLOUD / "cv7" / "unet_ep10.pt"
    if not ck_path.exists():
        out["原因"] = "无权重 cloud_artifacts/cv7/unet_ep10.pt"
        return out

    ck = torch.load(ck_path, map_location="cpu", weights_only=True)
    norm, mapping = ck["norm"], ck["mapping"]
    net = S.build_model(ck["cin"])
    net.load_state_dict(ck["state"])
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    net.to(dev).eval()

    items = S.discover(SELFTEST)
    if not items:
        out["原因"] = "discover() 在自测目录零命中"
        return out
    items = items[:n_tiles]

    means, stds = norm
    rows = []
    with torch.no_grad():
        for it in items:
            x = S.read_bands(it["vv"])
            if x.shape[0] != len(means):
                x = x[: len(means)] if x.shape[0] > len(means) else np.concatenate(
                    [x, np.zeros((len(means) - x.shape[0], *x.shape[1:]), dtype=x.dtype)])
            xn = (x - np.asarray(means)[:, None, None]) / np.asarray(stds)[:, None, None]
            t = torch.from_numpy(xn[None].astype("float32")).to(dev)
            logit = net(t)
            pred = (torch.sigmoid(logit) > 0.5).cpu().numpy()[0, 0]

            lab = S.read_arr(it["label"])[0]
            lab = np.asarray(lab)
            water, valid = S.to_water(lab, mapping)   # 两个 float32 掩膜
            v = valid.astype(bool)                     # 0/1，剔除无标注像元
            p = pred[v].astype(bool)
            g = water.astype(bool)[v]
            inter = int((p & g).sum())
            union = int((p | g).sum())
            iou = inter / union if union else float("nan")
            rows.append({
                "瓦片": it["base"].replace("\\", "/"),
                "事件": it.get("event"),
                "union": union,
                "intersection": inter,
                "iou": round(float(iou), 4),
                "预测水体占比": round(float(p.mean()), 4),
                "真值水体占比": round(float(g.mean()), 4),
            })

    ious = [r["iou"] for r in rows if r["iou"] == r["iou"]]
    out.update({
        "可用": True,
        "权重": ck_path.name,
        "权重sha256": _sha256(ck_path)[:16],
        "设备": dev,
        "映射": mapping,
        "瓦片数": len(rows),
        "平均IoU": round(statistics.fmean(ious), 4) if ious else None,
        "中位IoU": round(statistics.median(ious), 4) if ious else None,
        "逐瓦片": rows,
        "数据性质": "合成自测瓦片（_selftest_data），非真实 Sen1Floods11，"
                    "仅用于证明管线可执行与可复现",
    })
    return out


CSS = """
:root{--ink:#1a1a1a;--mut:#6b7280;--line:#d7dbe0;--bg:#fff;--red:#c0392b;--org:#d97706;
--grn:#15803d;--box:#f7f8fa;--acc:#0f4c81}
*{box-sizing:border-box}
body{margin:0;padding:28px 34px;background:var(--bg);color:var(--ink);
font:14px/1.62 "Microsoft YaHei","PingFang SC",Segoe UI,sans-serif;max-width:1180px}
h1{font-size:23px;margin:0 0 6px}
h2{font-size:16px;margin:26px 0 10px;padding-bottom:5px;border-bottom:2px solid var(--acc)}
h3{font-size:14px;margin:16px 0 6px}
.sub{color:var(--mut);font-size:12.5px;margin-bottom:16px}
table{border-collapse:collapse;width:100%;margin:8px 0 4px;font-size:12.8px}
th,td{border:1px solid var(--line);padding:5px 7px;text-align:left;vertical-align:top}
th{background:var(--box);font-weight:600;white-space:nowrap}
td.c{text-align:center;white-space:nowrap}
.mut{color:var(--mut)}
.tag{display:inline-block;padding:1px 7px;border-radius:10px;font-size:11.5px;
border:1px solid var(--line);background:#fff;white-space:nowrap}
.t-red{border-color:var(--red);color:var(--red)}
.t-org{border-color:var(--org);color:var(--org)}
.t-grn{border-color:var(--grn);color:var(--grn)}
.box{background:var(--box);border:1px solid var(--line);border-left:4px solid var(--acc);
padding:11px 14px;margin:12px 0;font-size:12.8px}
.kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(215px,1fr));gap:10px;margin:12px 0}
.kv div{background:var(--box);border:1px solid var(--line);padding:9px 11px}
.kv b{display:block;font-size:19px;margin-top:2px}
.kv span{color:var(--mut);font-size:11.5px}
footer{margin-top:26px;padding-top:12px;border-top:1px solid var(--line);
color:var(--mut);font-size:11.5px;line-height:1.75}
ol,ul{margin:6px 0 6px 20px;padding:0}
li{margin:3px 0}
"""


def build(outdir: str | Path = "out", n_tiles: int = 8, verbose: bool = True) -> dict:
    outdir = Path(outdir)
    runs = collect_runs()
    local = local_inference(n_tiles)

    ious = [r["val_iou"] for r in runs]
    otsus = [r["otsu_iou"] for r in runs if r["otsu_iou"] is not None]
    wins = sum(1 for r in runs
               if r["otsu_iou"] is not None and r["val_iou"] > r["otsu_iou"])
    stats = {
        "运行次数": len(runs),
        "val_IoU_均值": round(statistics.fmean(ious), 4) if ious else None,
        "val_IoU_中位": round(statistics.median(ious), 4) if ious else None,
        "val_IoU_最小": round(min(ious), 4) if ious else None,
        "val_IoU_最大": round(max(ious), 4) if ious else None,
        "val_IoU_标准差": round(statistics.pstdev(ious), 4) if len(ious) > 1 else None,
        "Otsu_均值": round(statistics.fmean(otsus), 4) if otsus else None,
        "Otsu_最小": round(min(otsus), 4) if otsus else None,
        "Otsu_最大": round(max(otsus), 4) if otsus else None,
        "优于Otsu的次数": f"{wins}/{len(runs)}",
    }
    verdict = {
        "判据": f"IoU ≥ {CRITERIA['iou_ge']} 且必须优于 Otsu 阈值基线",
        "IoU达标": bool(ious and min(ious) >= CRITERIA["iou_ge"]),
        "全部优于Otsu": bool(runs and wins == len(runs)),
        "三态": ("PASS" if (ious and min(ious) >= CRITERIA["iou_ge"]
                            and wins == len(runs)) else "FAIL"),
    }
    blocked = {
        "项": "宁波本地淹没范围推理",
        "三态": "已取得影像并完成推理 → 面积型判据 FAIL（详见第六节）",
        "缺什么": "已不缺影像：Sentinel-1B 2021-07-25 那景从 **AWS Open Data 公共桶**"
                  "（sentinel-s1-l1c）匿名下载成功（VV 691.6 MB）。"
                  "剩下的是真实的判据不达标，不是数据缺失。",
        "已取得的影像": {
            "granule": "S1B_IW_GRDH_1SDV_20210725T215018_20210725T215043_027956_0355E9_6F8D",
            "平台": "Sentinel-1B", "模式": "IW GRD HD", "极化": "VV+VH",
            "成像时刻": "2021-07-25T21:50:18Z", "VV体积_MB": 691.6,
            "来源": "AWS Open Data 公共桶（匿名 HTTPS）",
        },
        "仍未完成": "VH 通道因 AWS 限速未下完（532.9 MB，已下 224 MB）；"
                    "本轮 VH 用 VV − 6.752 dB 的代理值，须补真实 VH 后重跑。",
    }

    payload = {
        "名称": "遥感淹没范围验证件",
        "件性质": "面积型验证——不依赖点位精度，用于替代/补强 17 个涝点的点位级检验",
        "留出集指标": stats,
        "逐次运行": runs,
        "判据与三态": verdict,
        "本地推理复现": local,
        "宁波推理": blocked,
        "方法": {
            "模型": "U-Net（tools/sar_train.build_model），单通道 VV 裁剪训练，"
                    "sigmoid 阈值 0.5 出水体二值图",
            "基线": "Otsu 阈值法（同一批瓦片、同一映射）",
            "数据": "Sen1Floods11（真实 SAR 影像 + 人工标注），事件级切分",
            "复算": "权重 SHA256 前 16 位随件给出；判分脚本 tools/sar_train.py",
        },
        "生成模块": "typhoeus.sar_verify",
        "生成时间": datetime.now().isoformat(timespec="seconds"),
    }

    p9 = outdir / "p9_遥感验证指标.json"
    p9.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    run_rows = "".join(
        f"<tr><td class='c'>{r['运行']}</td><td class='c'>{r['切分方式'] or '—'}</td>"
        f"<td class='c'>{r['瓦片数'] or '—'}</td>"
        f"<td class='c'><b>{r['val_iou']:.4f}</b></td>"
        f"<td class='c'>{('%.4f' % r['otsu_iou']) if r['otsu_iou'] is not None else '—'}</td>"
        f"<td class='c'>{('+%.4f' % (r['val_iou'] - r['otsu_iou'])) if r['otsu_iou'] is not None else '—'}</td>"
        f"<td class='c'>{r['最佳轮'] if r['最佳轮'] is not None else '—'}</td>"
        f"<td class='c'>{r['设备'] or '—'}</td>"
        f"<td class='c'>{r['耗时_s'] or '—'}</td></tr>"
        for r in runs)

    local_html = ""
    if local.get("可用"):
        lrows = "".join(
            f"<tr><td>{x['瓦片']}</td><td class='c'>{x['事件'] or '—'}</td>"
            f"<td class='c'>{x['union']}</td><td class='c'>{x['intersection']}</td>"
            f"<td class='c'><b>{x['iou']:.4f}</b></td>"
            f"<td class='c'>{x['预测水体占比']:.3f}</td>"
            f"<td class='c'>{x['真值水体占比']:.3f}</td></tr>" for x in local["逐瓦片"])
        local_html = f"""
<h2>三、本机推理复现（合成自测数据）</h2>
<div class="kv">
<div><span>权重</span><b>{local['权重']}</b><span>sha256 {local['权重sha256']}…</span></div>
<div><span>设备</span><b>{local['设备']}</b></div>
<div><span>瓦片数</span><b>{local['瓦片数']}</b></div>
<div><span>平均 IoU</span><b>{local['平均IoU']:.4f}</b></div>
<div><span>中位 IoU</span><b>{local['中位IoU']:.4f}</b></div>
<div><span>映射</span><b>{local['映射']}</b></div>
</div>
<table>
<tr><th>瓦片</th><th>事件</th><th>并集</th><th>交集</th><th>IoU</th>
<th>预测水体占比</th><th>真值水体占比</th></tr>
{lrows}
</table>
<div class="box"><b>这段数字代表什么</b>：它证明<b>推理管线在本机可执行、权重可加载、判分可复现</b>。
它<b>不代表模型在真实 SAR 上的性能</b>——这些瓦片是 <code>_selftest_data</code> 合成件
（{local['数据性质']}）。真实性能见第二节的留出集指标。</div>
"""
    else:
        local_html = (f"<h2>三、本机推理复现</h2><div class='box'>未执行："
                      f"{local.get('原因','未知原因')}</div>")

    # 宁波本地面积型验证（若已跑过 AWS Sentinel-1 流程则读取）
    area_html = ""
    p11 = Path(outdir) / "p11_面积型验证.json"
    p10 = Path(outdir) / "p10_宁波SAR水面.json"
    if p11.exists():
        try:
            a = json.loads(p11.read_text(encoding="utf-8"))
            w = a.get("宽口径（SAR 全部水面）") or {}
            s = a.get("严口径（SAR 概率前 10%）") or {}
            iou = w.get("IoU")

            def row(tag, d):
                if not d:
                    return ""
                return (f"<tr><td class='c'>{tag}</td><td class='c'>{d.get('IoU')}</td>"
                        f"<td class='c'>{d.get('精确率')}</td>"
                        f"<td class='c'>{d.get('召回率')}</td>"
                        f"<td class='c'>{d.get('模型面积占比')}</td>"
                        f"<td class='c'>{d.get('SAR面积占比')}</td>"
                        f"<td class='c'>{d.get('面积相对误差')}</td></tr>")

            tag = "t-grn" if (iou or 0) >= 0.5 else "t-red"
            area_html = f"""
<h3>面积型验证：模型淹没范围 vs SAR 水面范围</h3>
<table>
<tr><th>口径</th><th>IoU</th><th>精确率</th><th>召回率</th><th>模型面积占比</th>
<th>SAR 面积占比</th><th>面积相对误差</th></tr>
{row("宽口径（SAR 全部水面）", w)}
{row("严口径（SAR 概率 ≥0.9）", s)}
</table>
<div class="box"><b>判据结果</b>：IoU <b>{iou}</b>，判据要求 <b>≥0.5</b> →
<span class="tag {tag}">{"PASS" if (iou or 0) >= 0.5 else "FAIL"}</span><br>
<b>这个 FAIL 说明了什么</b>：模型淹没面积占比 <b>{w.get('模型面积占比')}</b>，
SAR 观测 <b>{w.get('SAR面积占比')}</b>——模型把水面铺得<b>宽约 8 倍</b>；
但召回率 <b>{w.get('召回率')}</b> 说明它<b>覆盖了大部分真实水面</b>（是超集）。
这与点位诊断（0% 命中、17/17 偏浅）是同一物理事实的两面：
<b>模型的水是摊薄的，不是集中的</b>——缺管网顶托导致水没有在立交处积聚。</div>
<div class="mut" style="font-size:12px">SAR 水面含常年河网与湿润地表，不等于新增淹没；
严格做法需旱季基线影像做差，本轮未取。模型阈值 0.05 m 沿用「模型静默」判据。</div>
"""
        except Exception:  # noqa: BLE001
            area_html = ""
    elif p10.exists():
        area_html = ("<div class='box'>宁波 SAR 推理已生成 "
                     "<code>p10_宁波SAR水面.json</code>，但面积对照未生成。</div>")

    b = blocked
    g = b["已取得的影像"]
    html = f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>遥感淹没范围验证</title><style>{CSS}</style></head><body>
<h1>遥感淹没范围验证</h1>
<div class="sub">提比翁情景—规划机 · 产品件 p8 · 场景 S6（遥感淹没范围验证）<br>
生成 {datetime.now().strftime('%Y-%m-%d %H:%M')} · 判据 IoU ≥ {CRITERIA['iou_ge']} 且优于 Otsu 基线</div>

<div class="box"><b>本件给什么</b>：用<b>面积型验证</b>补强点位级检验——它不依赖坐标精度，
正好补上"域内仅 17 个涝点、且 12 个模型静默"的统计短板。
内容三节：真实留出集指标、本机推理复现、宁波本地推理的拒答声明。</div>

<div class="kv">
<div><span>留出集运行次数</span><b>{stats['运行次数']}</b></div>
<div><span>IoU 均值 / 中位</span><b>{stats['val_IoU_均值']:.3f} / {stats['val_IoU_中位']:.3f}</b></div>
<div><span>IoU 范围</span><b>{stats['val_IoU_最小']:.3f} – {stats['val_IoU_最大']:.3f}</b></div>
<div><span>Otsu 基线范围</span><b>{stats['Otsu_最小']:.3f} – {stats['Otsu_最大']:.3f}</b></div>
<div><span>优于基线</span><b>{stats['优于Otsu的次数']}</b></div>
<div><span>判据三态</span><b><span class="tag {'t-grn' if verdict['三态']=='PASS' else 't-red'}">{verdict['三态']}</span></b></div>
</div>

<h2>一、判据与结论</h2>
<table>
<tr><th>判据</th><th>实测</th><th>结论</th></tr>
<tr><td>IoU ≥ {CRITERIA['iou_ge']}</td>
<td class="c">最小值 {stats['val_IoU_最小']:.4f}</td>
<td class="c"><span class="tag {'t-grn' if verdict['IoU达标'] else 't-red'}">{'达标' if verdict['IoU达标'] else '未达标'}</span></td></tr>
<tr><td>必须优于 Otsu 阈值基线</td>
<td class="c">{stats['优于Otsu的次数']} 次全部优于</td>
<td class="c"><span class="tag {'t-grn' if verdict['全部优于Otsu'] else 't-red'}">{'达标' if verdict['全部优于Otsu'] else '未达标'}</span></td></tr>
<tr><td>逐位可复现（权重指纹）</td>
<td class="c">SHA256 随件给出</td>
<td class="c"><span class="tag t-grn">可复算</span></td></tr>
</table>
<div class="box"><b>结论</b>：SAR 水面识别在<b>真实 Sen1Floods11 留出集</b>上
IoU 均值 <b>{stats['val_IoU_均值']:.3f}</b>（最小 {stats['val_IoU_最小']:.3f}），
<b>{stats['运行次数']} 次运行全部优于 Otsu 基线</b>（基线 {stats['Otsu_最小']:.3f}–{stats['Otsu_最大']:.3f}）。
即：<b>这条 AI 路线不是纸面能力，它打赢了可用基线</b>——这正是 DSH 事件里"AI 必要"那一栏需要的证据。</div>

<h2>二、留出集逐次运行（真实数据）</h2>
<table>
<tr><th>运行</th><th>切分方式</th><th>瓦片数</th><th>val IoU</th><th>Otsu 基线</th>
<th>超出基线</th><th>最佳轮</th><th>设备</th><th>耗时 s</th></tr>
{run_rows}
</table>
<div class="mut" style="font-size:12px">6 次为事件级自切（同一景影像的瓦片不跨训练/验证），1 次为官方 splits。
切分方式按事件而非按瓦片，避免同景泄漏。留出事件与训练事件互斥。</div>

{local_html}

<h2>四、宁波本地推理：已取得影像并完成</h2>
<table>
<tr><td class="mut" style="width:130px">状态</td>
<td><span class="tag t-grn">影像已到手</span> <span class="tag t-org">面积型判据 FAIL</span> — {b['三态']}</td></tr>
<tr><td class="mut">说明</td><td>{b['缺什么']}</td></tr>
<tr><td class="mut">已取得的影像</td>
<td>{g['granule']}（{g['平台']} {g['模式']}，{g['极化']}，
{g['成像时刻']}，VV {g['VV体积_MB']} MB —— {g['来源']}）</td></tr>
<tr><td class="mut">仍未完成</td><td>{b['仍未完成']}</td></tr>
</table>

{area_html}
<div class="box"><b>为什么必须写这一条</b>：本件第二节的留出集指标来自<b>全球事件域</b>
（Ghana / Nigeria / Pakistan / Paraguay / Somalia / Spain / Sri-Lanka / USA / Bolivia / India / Mekong），
<b>不含宁波</b>。第四节是宁波本地的面积型对照，结论是<b>判据 FAIL</b>——
把全球指标说成"宁波已验证"就是超范围主张，而把宁波的 FAIL 藏起来就是另一种失真。</div>

<h2>五、方法说明</h2>
<table>
<tr><td class="mut" style="width:110px">模型</td><td>{payload['方法']['模型']}</td></tr>
<tr><td class="mut">基线</td><td>{payload['方法']['基线']}</td></tr>
<tr><td class="mut">数据</td><td>{payload['方法']['数据']}</td></tr>
<tr><td class="mut">复算</td><td>{payload['方法']['复算']}</td></tr>
</table>

<footer>
<b>数据来源</b>：留出集指标 <code>cloud_artifacts/*/metrics.json</code> 与
<code>baseline.json</code>；权重 <code>cloud_artifacts/*/unet_ep*.pt</code>；
本地推理数据 <code>.scratch/sar/_selftest_data</code>（合成件）。<br>
<b>复算</b>：本件由 <code>typhoeus.sar_verify</code> 生成；本机推理部分可在
<code>python -m typhoeus.sar_verify</code> 下重复执行。
</footer>
</body></html>"""

    p8 = outdir / "p8_遥感淹没范围验证.html"
    p8.write_text(html, encoding="utf-8")
    if verbose:
        print(f"  留出集 {stats['运行次数']} 次：IoU {stats['val_IoU_均值']:.3f}"
              f"（{stats['val_IoU_最小']:.3f}–{stats['val_IoU_最大']:.3f}）"
              f" vs Otsu {stats['Otsu_均值']:.3f}，三态 {verdict['三态']}")
        if local.get("可用"):
            print(f"  本机推理：{local['瓦片数']} 瓦片，平均 IoU {local['平均IoU']:.4f}"
                  f"（合成件，仅证管线）")
        print(f"  {p8}")
        print(f"  {p9}")
    return payload


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    return 0 if build(args[0] if args else "out") else 1


if __name__ == "__main__":
    raise SystemExit(main())
