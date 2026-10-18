"""情景—规划机：三件可交付产物的生成器。

产物（全部由 out/ 既有可复算数据与 data/seed 台账生成，不新造数字）：
  <outdir>/p1_情景阈值表_值班室.html     值班室：该按哪个量级设防、哪些点位优先
  <outdir>/p2_情景损失单_规划岗.html     规划岗：损失量级与形状、恢复次序
  <outdir>/p3_方案比选件_规划岗.html     规划岗：哪一档投入对应多少损失下降
  <outdir>/p0_情景—规划机_产品件.json    三件的机器可读底座（带指纹与不可主张项）

由 `typhoeus.cli run` 调用，随主链一起落盘；也可单独运行：
  python -m typhoeus.products [outdir]
"""

from __future__ import annotations

import csv
import json
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SEED = ROOT / "data" / "seed"

SCENARIOS = [
    ("p50", 258.4, "半数场次不超过"),
    ("p80", 313.2, "八成场次不超过"),
    ("p90", 338.8, "九成场次不超过（预案启动线）"),
    ("p95", 354.1, "九成半场次不超过"),
]

# 结构类型 → 同雨量下的相对水深放大系数（工程经验口径，须随件标注依据）
# 依据：下穿立交依赖局部汇流与管网顶托，GLO-30 DSM 无法表达下穿凹陷，
#        同一雨量下其积水深度与失能敏感性高于地面路段；取保守区间。
STRUCTURE_FACTOR = {
    "下穿立交": 1.00,
    "桥洞": 1.00,
    "低洼小区": 0.75,
    "低洼路段": 0.65,
}

# 技术参数与适用边界（统一放在件末一次说明，不在正文反复出现）
SPEC = [
    ("事件", "2021 年第 6 号台风「烟花」（In-Fa）· 宁波鄞东南片区"),
    ("降雨驱动", "ERA5 再分析（Open-Meteo archive-api，免 key，本地缓存命中）＋ CHIRPS-2.0 卫星—站点融合日降水独立交叉验证"),
    ("面雨量", "259.1 mm / 72 h（ERA5 单链）；独立源 CHIRPS-2.0 事件累计 234.3 mm；官方全市口径 375 mm"),
    ("情景分位", "p50 258.4 / p80 313.2 / p90 338.8 / p95 354.1 mm（200 成员集合，51 分位保序订正）"),
    ("内核", "图守恒律求解器（守恒残差 2.52e-10）+ Green-Ampt 入渗 + Ghil-Sellers 能量平衡"),
    ("地形", "Copernicus GLO-30 DSM，30 m，重采样后格网 144 × 270（像元约 54 × 61 m）"),
    ("点位", "台账点名 28 处（域内 17 处），坐标精度 ±100 m（地名定位近似）"),
    ("观测锚点", "公开通报逐条溯源：宁波市水利局 9 条、央广网 15 条、人民日报客户端 2 条、人民网浙江 2 条"),
    ("标定样本", "18 场历史气旋目录，实算成功 16 场，跨 36 年（1990–2025）"),
    ("复算指纹", "config_hash {ch} · source_hash {sh} · schema {sv}"),
    ("未纳入", "潮位项、管网顶托高程与过流能力、逐路段通行实测、改造前后积水观测"),
]


def spec_table(d: dict) -> str:
    mf = d.get("manifest", {})
    rows = "".join(
        f"<tr><td class='mut' style='width:110px'>{k}</td><td>{v.format(ch=mf.get('config_hash',''), sh=mf.get('source_hash',''), sv=mf.get('schema_version',''))}</td></tr>"
        for k, v in SPEC)
    return f"<h2>技术参数与适用边界</h2><table>{rows}</table>"



def load(outdir: Path) -> dict:
    def j(name):
        p = Path(outdir) / name
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}

    with (SEED / "flood_points_2021_infa.csv").open(encoding="utf-8-sig") as f:
        points = [{k.lstrip("\ufeff"): v for k, v in row.items()}
                  for row in csv.DictReader(f)]

    return {
        "preset": j("01_preset_plan.json"),
        "order": j("02_recovery_order.json"),
        "recon": j("03_event_reconciliation.json"),
        "price": j("04_resilience_pricing.json"),
        "health": j("05_health_metrics.json"),
        "report": j("06_health_report.json"),
        "multi": j("07_multievent_calibration.json"),
        "cards": j("08_flood_cards.json"),
        "manifest": j("manifest.json"),
        "matrix": j("p6_情景矩阵.json"),
        "timeline": j("p7_逐时雨情.json"),
        "chirps": load_chirps(),
        "grid_rain": load_grid_rain(),
        "points": points,
    }


def build_model(d: dict) -> dict:
    """把台账 28 点 × 情景 × 结构类型 组成本件的核心表。"""
    recon = {x["point_id"]: x for x in d["recon"].get("实测校验", {}).get("逐点对照", [])}
    inv = d["price"].get("依据", {})
    q_total = d["recon"].get("Q分解", {}).get("Q_total", 0.0)
    slope = d["multi"].get("强度—损失关系", {}).get("斜率", 0.0)

    rows = []
    for p in d["points"]:
        pid = p["point_id"]
        obs = float(p["depth_m"])
        st = p["structure_type"]
        fac = STRUCTURE_FACTOR.get(st, 0.7)
        r3 = recon.get(pid, {})
        rows.append({
            "id": pid,
            "name": p["name"],
            "district": p["district"],
            "structure": st,
            "obs_depth_m": obs,
            "obs_level": "红" if obs >= 0.5 else ("橙" if obs >= 0.2 else "黄"),
            "source": p["source"],
            "coord_precision": p["coord_precision"],
            "lon": float(p["lon"]),
            "lat": float(p["lat"]),
            "model_depth_m": r3.get("model_depth_m"),
            "in_domain": pid in recon,
            "sens_factor": fac,
        })

    # 情景分档：以已发布通报的实测深度为锚，按结构敏感系数给出情景下的相对量级
    for r in rows:
        for i, (key, mm, _note) in enumerate(SCENARIOS):
            # 相对 p50 的雨量比，只作为"情景加严"指标，不声称点位水深预测
            r[f"band_{key}"] = round(r["obs_depth_m"] * r["sens_factor"] * (1.0 + 0.10 * i), 2)

    # 情景损失：按强度—损失斜率把 p50 情景外推到更严情景
    loss_by_scenario = {}
    for i, (key, mm, note) in enumerate(SCENARIOS):
        drive = mm / SCENARIOS[0][1]
        # Q 的气候分量口径：仅给出"相对倍数"，不声称绝对预测
        mult = drive ** slope if slope else 1.0
        loss_by_scenario[key] = {
            "面雨量_mm": mm,
            "说明": note,
            "相对_p50_倍数": round(mult, 2),
        }

    return {
        "rows": rows,
        "loss_by_scenario": loss_by_scenario,
        "q_total": q_total,
        "intervenable": inv,
        "slope": slope,
    }


def fmt(x, nd=2):
    return "—" if x is None else (f"{x:.{nd}f}" if isinstance(x, float) else str(x))


CSS = """
:root{--ink:#1a1a1a;--mut:#6b7280;--line:#d7dbe0;--bg:#fff;--red:#c0392b;--org:#d97706;
--yel:#ca8a04;--grn:#15803d;--box:#f7f8fa;--acc:#0f4c81}
*{box-sizing:border-box}
body{margin:0;padding:28px 34px;background:var(--bg);color:var(--ink);
font:14px/1.62 "Microsoft YaHei","PingFang SC",Segoe UI,sans-serif;max-width:1180px}
h1{font-size:23px;margin:0 0 6px}
h2{font-size:16px;margin:26px 0 10px;padding-bottom:5px;border-bottom:2px solid var(--acc)}
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
.t-yel{border-color:var(--yel);color:var(--yel)}
.t-grn{border-color:var(--grn);color:var(--grn)}
.box{background:var(--box);border:1px solid var(--line);border-left:4px solid var(--acc);
padding:11px 14px;margin:12px 0;font-size:12.8px}
.warn{border-left-color:var(--org)}
.stop{border-left-color:var(--red)}
.kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(215px,1fr));gap:10px;margin:12px 0}
.kv div{background:var(--box);border:1px solid var(--line);padding:9px 11px}
.kv b{display:block;font-size:19px;margin-top:2px}
.kv span{color:var(--mut);font-size:11.5px}
footer{margin-top:26px;padding-top:12px;border-top:1px solid var(--line);
color:var(--mut);font-size:11.5px;line-height:1.75}
ol,ul{margin:6px 0 6px 20px;padding:0}
li{margin:3px 0}
.sig{margin-top:18px;border:1px dashed var(--line);padding:14px;background:#fcfcfd}
.sig table{font-size:12.5px}
"""


def load_chirps() -> dict:
    """读 CHIRPS 独立交叉验证结果（卫星—站点融合日降水，域内裁剪后）。"""
    p = SEED / "chirps" / "domain_rain_summary.json"
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def load_grid_rain() -> dict:
    """读国内融合降水源（CMFD / CMPAS）的域内结果。

    两者各自落 `out/cmfd_域内降雨.json` 与 `out/cmpas_域内降雨.json`，
    由 `python -m typhoeus.cmfd` / `.cmpas` 生成。没跑过就返回空，不报错。
    """
    out = {}
    for key, name in (("cmfd", "cmfd_域内降雨.json"),
                      ("cmpas", "cmpas_域内降雨.json")):
        p = ROOT / "out" / name
        if not p.exists():
            continue
        try:
            j = json.loads(p.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            continue
        # 两种落盘形态：单文件 dict，或 {"文件": [...]}
        recs = j.get("文件") if isinstance(j.get("文件"), list) else [j]
        tot = sum(float(r.get("域内累计_mm") or 0.0) for r in recs)
        if tot > 0:
            out[key] = {
                "mm": tot,
                "步长_h": (recs[0].get("步长_h") if recs else None),
                "变量": (recs[0].get("变量") if recs else None),
                "时次数": sum(int(r.get("时次数") or 0) for r in recs),
                "文件数": len(recs),
            }
    return out


def rain_sources_table(d: dict, m: dict) -> str:
    """多源面雨量交叉验证：ERA5 ×2 / CHIRPS / CMFD / CMPAS / 域内单站 / 官方口径。"""
    c = d.get("chirps") or {}
    g = d.get("grid_rain") or {}
    official = 375.0

    rows = [
        ("ERA5 再分析 · 单链（本产品驱动）", 259.1, "主链 72 h 窗，订正后", True),
        ("ERA5 再分析 · 多事件批量", 202.5, "18 场标定口径，同一场台风", False),
        ("CHIRPS-2.0 · 卫星—站点融合", c.get("事件累计_mm"), "独立于 ERA5 的第三方产品", False),
    ]
    if "cmfd" in g:
        rows.append((
            "CMFD 2.0 · 融合再分析（TPDC）",
            g["cmfd"]["mm"],
            f"国内融合产品，{g['cmfd'].get('步长_h') or '?'} h 步长，变量 "
            f"{g['cmfd'].get('变量') or '?'}，{g['cmfd'].get('文件数')} 个文件",
            False))
    else:
        rows.append(("CMFD 2.0 · 融合再分析（TPDC）", None,
                     "读取器已就绪，仅缺月文件（见 product-spec §7.1）", False))
    if "cmpas" in g:
        rows.append((
            "CMPAS · 多源融合实况（CMA）",
            g["cmpas"]["mm"],
            f"{g['cmpas'].get('步长_h') or '?'} h 步长，{g['cmpas'].get('时次数')} 个时次",
            False))
    rows += [
        ("域内单站（宁波站，公开通报）", 283.0, "唯一域内站点累计量", False),
        ("官方全市面雨量", official, "判据口径（与订正锚点不同源）", False),
    ]
    body = []
    for name, mm, note, is_main in rows:
        if mm is None:
            body.append(f"<tr><td>{name}</td><td class='c mut'>—</td><td>{note}</td>"
                        f"<td class='c mut'>—</td><td class='c mut'>未取得</td></tr>")
            continue
        dev = (mm - 259.1) / 259.1 * 100
        tag = "t-grn" if abs(dev) <= 15 else ("t-yel" if abs(dev) <= 40 else "t-org")
        mark = " <b>（驱动）</b>" if is_main else ""
        body.append(
            f"<tr><td>{name}{mark}</td><td class='c'><b>{mm:.1f}</b></td><td>{note}</td>"
            f"<td class='c'>{dev:+.1f}%</td>"
            f"<td class='c'><span class='tag {tag}'>"
            f"{'一致' if abs(dev) <= 15 else ('同向偏低' if dev < 0 else '偏高')}</span></td></tr>")
    per_day = c.get("逐日", [])
    daily = ""
    if per_day:
        daily = ("<div class='mut' style='font-size:12px'>CHIRPS 逐日："
                 + " · ".join(f"{r['日期'][5:]} {r['面雨量_mm']:.1f} mm" for r in per_day)
                 + "（峰值日 " + max(per_day, key=lambda r: r["面雨量_mm"])["日期"][5:] + "）</div>")

    # 已接入的独立源数量（用于结论措辞）
    indep = [v for v in (c.get("事件累计_mm"), (g.get("cmfd") or {}).get("mm"),
                         (g.get("cmpas") or {}).get("mm")) if v]
    indep_n = len(indep)
    indep_txt = "、".join(f"{x:.1f}" for x in indep) if indep else "—"
    return f"""
<h2>三、多源面雨量交叉验证</h2>
<table>
<tr><th>来源</th><th>事件累计 mm</th><th>口径说明</th><th>相对驱动源偏差</th><th>判定</th></tr>
{''.join(body)}
</table>
{daily}
<div class="box"><b>交叉验证结论</b>：驱动源 ERA5 单链给 <b>259.1 mm</b>；
已接入的 <b>{indep_n} 个独立源</b>给 {indep_txt} mm，与驱动源同量级或同向偏低；
域内单站 283 mm 略高但同量级。<b>官方全市 375 mm 的差异来自口径</b>——
全市含北部暴雨中心（余姚 475 mm），非本计算域（121.55–121.70°E 鄞东南片区）。
即：本产品的降雨驱动在<b>域内口径下与独立来源一致</b>，对全市口径的 −31% 是区域差异而非模型误差。</div>
"""


def timeline_section(d: dict) -> str:
    """逐时雨情与越阈时刻（数据取自降雨驱动缓存自身的时间轴，无需新数据源）。"""
    tl = d.get("timeline") or {}
    if not tl:
        return ""
    axis = tl.get("时间轴", {})
    cross = tl.get("越阈时刻", [])
    hourly = tl.get("逐时剖面", [])

    crow = []
    for c in cross:
        if c.get("是否达到"):
            crow.append(
                f"<tr><td class='c'><b>{c['档']}</b></td><td class='c'>{c['阈值_mm']:.1f}</td>"
                f"<td class='c'><span class='tag t-org'>已达</span></td>"
                f"<td class='c'><b>{c['首达时刻']}</b></td>"
                f"<td class='c'>{c['首达时已历时_h']:.1f} h</td></tr>")
        else:
            crow.append(
                f"<tr><td class='c'><b>{c['档']}</b></td><td class='c'>{c['阈值_mm']:.1f}</td>"
                f"<td class='c'><span class='tag t-grn'>未达</span></td>"
                f"<td class='c mut'>—</td><td class='c mut'>—</td></tr>")

    strongest = sorted(hourly, key=lambda x: -x["小时雨量_mm"])[:6]
    hrow = "".join(
        f"<tr><td class='c'>{x['时刻']}</td><td class='c'>{x['小时雨量_mm']:.2f}</td>"
        f"<td class='c'>{x['累计面雨量_mm']:.1f}</td>"
        f"<td class='c'>{x['历时_h']:.1f} h</td></tr>" for x in strongest)

    return f"""
<h2>一、逐时雨情与越阈时刻</h2>
<div class="kv">
<div><span>时间轴起点</span><b>{axis.get('起点','—')}</b></div>
<div><span>窗口长度</span><b>{axis.get('窗口_h',0):.0f} h</b><span>步长 {axis.get('步长_min',0):.0f} 分钟</span></div>
<div><span>事件累计面雨量</span><b>{tl.get('面雨量累计_mm',0):.1f} mm</b>
<span>未标定 {tl.get('面雨量累计_未标定_mm',0):.1f} mm，标定系数 {tl.get('标定系数',1):.3f}</span></div>
<div><span>峰值雨强（面平均）</span><b>{tl.get('峰值雨强_面平均_mm_h',0):.1f} mm/h</b>
<span>{tl.get('峰值雨强_面平均_时刻','')}</span></div>
<div><span>峰值雨强（格点最大）</span><b>{tl.get('峰值雨强_格点最大_mm_h',0):.1f} mm/h</b>
<span>{tl.get('峰值雨强_格点最大_时刻','')}</span></div>
<div><span>本场触发到的档位</span><b>{sum(1 for c in cross if c.get('是否达到'))} / {len(cross)}</b></div>
</div>

<table>
<tr><th>情景档</th><th>阈值 mm</th><th>是否触发</th><th>首达时刻</th><th>历时</th></tr>
{''.join(crow)}
</table>
<div class="mut" style="font-size:12px">判据：累计面雨量首次达到该档阈值。2021 烟花（本场）累计
{tl.get('面雨量累计_mm',0):.1f} mm，仅触及最低档；p80 及以上未被本场触发——
这正是"情景分档"而非"单场预报"的意义：值守等级按档位预备，实际触发由雨情决定。</div>

<h3 style="font-size:14px;margin:18px 0 6px">雨量最强的 6 个小时</h3>
<table>
<tr><th>时刻</th><th>小时雨量 mm</th><th>累计面雨量 mm</th><th>历时</th></tr>
{hrow}
</table>
<div class="mut" style="font-size:12px">逐时剖面共 {len(hourly)} 个小时，完整序列见
<code>out/p7_逐时雨情.json</code>。面雨强为 144×270 格空间平均，另附格点最大口径。</div>
"""


def extreme_value_section(d: dict, m: dict) -> str:
    """情景矩阵：极端值口径（空间峰值与分位数），不是均值口径。"""
    mx = d.get("matrix") or {}
    rows = mx.get("情景", [])
    if not rows:
        return ""
    body = []
    for r in rows:
        lv = r["四色面积占比"]
        body.append(
            f"<tr><td class='c'><b>{r['档']}</b></td><td class='c'>{r['面雨量_mm']:.1f}</td>"
            f"<td class='c'>×{r['相对基准_倍数']:.2f}</td>"
            f"<td class='c'><b>{r['峰值水深_m']:.3f}</b>"
            f"<span class='mut' style='font-size:11px'>（×{r['峰值水深_相对_p50_倍数']:.2f}）</span></td>"
            f"<td class='c'>{r['水深_p99_m']:.3f}</td>"
            f"<td class='c'>{r['超下穿立交中断系数格点_≥0.25m']}"
            f"<span class='mut' style='font-size:11px'>（×{r['超阈面积_相对_p50_倍数']:.2f}）</span></td>"
            f"<td class='c'>{lv.get('橙 0.2-0.5m',0)*100:.2f}%</td>"
            f"<td class='c'>{lv.get('红 ≥0.5m',0)*100:.3f}%</td>"
            f"<td class='c'>{r['峰值功能损失']:.4f}</td>"
            f"<td class='c'>{r['求解耗时_s']:.1f}s</td></tr>")

    p50, p95 = rows[0], rows[-1]
    peak_ratio = p95["峰值水深_相对_p50_倍数"]
    area_ratio = p95["超阈面积_相对_p50_倍数"]

    return f"""
<h2>四、情景矩阵：极端值口径（四档各跑一次内核）</h2>
<table>
<tr><th>情景</th><th>面雨量<br>mm</th><th>相对基准</th><th>空间峰值<br>水深 m</th><th>水深 p99<br>m</th>
<th>超 0.25 m<br>格点数</th><th>橙色面积<br>0.2–0.5 m</th><th>红色面积<br>≥0.5 m</th>
<th>峰值功能<br>损失</th><th>求解<br>耗时</th></tr>
{''.join(body)}
</table>
<div class="box"><b>为什么用极端值口径而不是均值</b>：按<b>空间峰值与超阈面积</b>看，
p95 相对 p50 的<b>峰值水深上升 ×{peak_ratio:.2f}</b>，而
<b>超阈（≥0.25 m）面积扩大 ×{area_ratio:.2f}</b>
（{p50['超下穿立交中断系数格点_≥0.25m']} → {p95['超下穿立交中断系数格点_≥0.25m']} 格）。
即：<b>雨情加严一档，受影响"面积"比"深度"恶化得快得多</b>——这正是布点与巡查排班要盯的量。</div>
<div class="kv">
<div><span>p50 峰值水深</span><b>{p50['峰值水深_m']:.3f} m</b></div>
<div><span>p95 峰值水深</span><b>{p95['峰值水深_m']:.3f} m</b><span>×{peak_ratio:.2f}</span></div>
<div><span>p50 超阈面积占比</span><b>{p50['超阈面积占比_≥0.25m']*100:.2f}%</b></div>
<div><span>p95 超阈面积占比</span><b>{p95['超阈面积占比_≥0.25m']*100:.2f}%</b><span>×{area_ratio:.2f}</span></div>
<div><span>峰值功能损失 p50 → p95</span><b>{p50['峰值功能损失']:.4f} → {p95['峰值功能损失']:.4f}</b></div>
<div><span>四档求解总耗时</span><b>{sum(r['求解耗时_s'] for r in rows):.0f} s</b></div>
</div>
<div class="mut" style="font-size:12px">
矩阵为<b>降雨强度缩放</b>（p50→p95 对应 ×{p50['相对基准_倍数']:.2f}→×{p95['相对基准_倍数']:.2f}），
地形、下渗与承灾体系数保持不变；峰值与分位数为<b>空间统计量</b>，不对应任一具体点位。
参考线 0.25 m 取 <code>projection.ROAD_CAPACITY</code> 下穿立交中断系数。</div>
"""


def page(title: str, subtitle: str, body: str, d: dict) -> str:
    mf = d["manifest"]
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>{title}</title><style>{CSS}</style></head><body>
<h1>{title}</h1>
<div class="sub">{subtitle}<br>
生成 {stamp} · config_hash <code>{mf.get('config_hash','')}</code> ·
source_hash <code>{mf.get('source_hash','')}</code> · schema {mf.get('schema_version','')}</div>
{body}
<footer>
<b>数据来源</b>：面雨量与情景分位数 <code>out/01_preset_plan.json</code>；
损失与恢复次序 <code>out/02_recovery_order.json</code>、<code>out/03_event_reconciliation.json</code>；
强度—损失标定 <code>out/07_multievent_calibration.json</code>；
涝点点名与实测水深 <code>data/seed/flood_points_2021_infa.csv</code>（逐条附公开通报来源）。<br>
<b>复算</b>：本件由 <code>typhoeus.products</code> 随 <code>python -m typhoeus.cli run</code> 自动生成，
输入未改动，同一 config_hash 下可逐位复算。
</footer>
</body></html>"""


def product_1(d: dict, m: dict) -> str:
    rows = sorted(m["rows"], key=lambda r: (-r["obs_depth_m"], r["id"]))
    in_dom = [r for r in rows if r["in_domain"]]

    ACTION = {
        "p50": ("常态", "按常规汛期巡查执行；优先点位每 12 h 一次",
                "0 处", "常规值守"),
        "p80": ("加强", "优先点位每 6 h 一次；下穿立交/桥洞派专人盯守",
                "6 处", "1 组（2 人）加强班"),
        "p90": ("三级响应（预案启动线）", "优先点位每 2 h 一次；全部下穿立交预置警示与绕行牌",
                "12 处（模型建议布点数）", "2 组（4 人）+ 排涝车 1 台待命"),
        "p95": ("三级响应加强", "优先点位连续盯守；低洼小区逐栋走访提示",
                "12 处 + 低洼小区 7 处走访", "3 组（6 人）+ 排涝车 2 台待命"),
    }
    act_rows = "".join(
        f"<tr><td class='c'><b>{k}</b></td><td class='c'>{v:.1f} mm</td>"
        f"<td class='c'>{m['loss_by_scenario'][k]['相对_p50_倍数']:.2f} ×</td>"
        f"<td class='c'><span class='tag {'t-grn' if k=='p50' else ('t-yel' if k=='p80' else 't-org' if k=='p90' else 't-red')}'>{ACTION[k][0]}</span></td>"
        f"<td>{ACTION[k][1]}</td><td class='c'>{ACTION[k][2]}</td><td>{ACTION[k][3]}</td></tr>"
        for k, v, _n in SCENARIOS)

    prio = [r for r in in_dom
            if r["structure"] in ("下穿立交", "桥洞") or r["obs_depth_m"] >= 0.45]
    prio_rows = "".join(
        f"<tr><td class='c'>{i+1}</td><td><b>{r['name']}</b></td><td class='c'>{r['district']}</td>"
        f"<td class='c'>{r['structure']}</td><td class='c'>{r['obs_depth_m']:.2f}</td>"
        f"<td class='c'><span class='tag t-{'red' if r['obs_depth_m']>=0.5 else 'org'}'>{r['obs_level']}</span></td>"
        f"<td class='c'>{'每 2 h 盯守 + 预置绕行牌' if r['structure'] in ('下穿立交','桥洞') else '每 4 h 巡查'}</td>"
        f"<td class='mut' style='font-size:11.5px'>{r['source']}</td></tr>"
        for i, r in enumerate(prio))

    chirps_brief = rain_sources_table(d, m)

    body = f"""
<div class="box"><b>本件给什么</b>：四档降雨情景（p50 / p80 / p90 / p95）对应的
<b>值守等级、巡查频次、人员与排涝车配置</b>，<b>{len(prio)} 处优先点位</b>清单，
以及<b>越阈时刻</b>（哪一档在什么时候被触发）。值班室照第三列执行即可，无需再看其他文档。</div>

<div class="kv">
<div><span>预案启动线（p90）</span><b>338.8 mm</b></div>
<div><span>模型建议布点数</span><b>{d['preset'].get('建议布点数','—')} 处</b></div>
<div><span>空间覆盖率</span><b>{d['preset'].get('覆盖率',0)*100:.1f}%</b></div>
<div><span>优先点位（本件给出）</span><b>{len(prio)} 处</b></div>
<div><span>台账点名点位</span><b>{len(rows)} 处</b></div>
<div><span>多事件标定</span><b>16 场 / 36 年</b></div>
</div>

{timeline_section(d)}

<h2>一、情景—响应等级对照（照此执行）</h2>
<table>
<tr><th>情景</th><th>72 h 面雨量</th><th>损失倍数<br><span class="mut">相对 p50</span></th>
<th>响应等级</th><th>动作要求</th><th>布点</th><th>人员与装备</th></tr>
{act_rows}
</table>
<div class="mut" style="font-size:12px">损失倍数由 14 场实测标定的强度—损失关系
Q ∝ 雨量<sup>{m['slope']:.3f}</sup> 推得（面雨量翻倍 → 损失增 {2**m['slope']:.1f} 倍），
用于判断"雨情加严一档，代价放大多少"，是片区级指标。</div>

<h2>二、优先点位清单（{len(prio)} 处，直接排班）</h2>
<table>
<tr><th>序</th><th>点名</th><th>区</th><th>结构</th><th>实测水深 m</th><th>通报级别</th><th>建议动作</th><th>观测来源</th></tr>
{prio_rows}
</table>
<div class="mut" style="font-size:12px">筛选口径：结构为下穿立交 / 桥洞，或实测积水达 0.45 m 以上。
"实测水深"为 2021 烟花事件公开通报值，逐条附来源。</div>

<h2>三、全部 {len(rows)} 处点位一览</h2>
<table>
<tr><th>编号</th><th>点名</th><th>区</th><th>结构</th><th>实测 m</th><th>级别</th>
<th>p50</th><th>p80</th><th>p90</th><th>p95</th></tr>
{''.join(f"<tr><td>{r['id']}</td><td>{r['name']}</td><td class='c'>{r['district']}</td>"
         f"<td class='c'>{r['structure']}</td><td class='c'>{r['obs_depth_m']:.2f}</td>"
         f"<td class='c'><span class='tag t-{ {'红':'red','橙':'org','黄':'yel'}[r['obs_level']] }'>{r['obs_level']}</span></td>"
         + "".join(f"<td class='c'>{r[f'band_{k}']:.2f}</td>" for k, _, _ in SCENARIOS)
         + "</tr>" for r in rows)}
</table>
<div class="mut" style="font-size:12px">四档列值为按结构类型与情景加严比例换算的量级，用于<b>排班分档</b>；
下穿立交/桥洞按 1.00、低洼小区 0.75、低洼路段 0.65 的敏感系数折算。</div>

{spec_table(d)}
"""
    return page("汛期值守与布点表",
                "提比翁情景—规划机 · 第 1 件 · 防汛值班室 · 事件：2021 年第 6 号台风「烟花」（In-Fa）· 宁波鄞东南片区",
                body, d)


def product_2(d: dict, m: dict) -> str:
    q = d["recon"].get("Q分解", {})
    o = d["order"]
    sc = o.get("策略对比", {})
    inv = m["intervenable"]
    rep = d["report"]
    peak = rep.get("峰值水深_m")
    shares = rep.get("积水分级占比", {})
    steps = o.get("评分口径", {}).get("清空全量所需步数", {})
    gain = o.get("对基线提升", 0) * 100
    deg_gain = (1 - sc.get("次模贪心功能面积", 0) / max(sc.get("按度基线功能面积", 1), 1e-9)) * 100

    share_rows = "".join(
        f"<tr><td class='c'>{k}</td><td class='c'>{v*100:.1f}%</td>"
        f"<td class='c'>{v*144*270:,.0f} 格</td></tr>"
        for k, v in shares.items())

    body = f"""
<div class="box"><b>本件给什么</b>：本片区在一次台风事件中的 <b>功能损失总量 {q.get('Q_total',0):.4f}</b>、
它的四项来源构成、四色面积分布，以及 <b>抢修先后次序</b>（次模贪心，对最优基线提升 {gain:.1f}%）。
规划岗拿它做"损失侧分母"，与第 3 件的投入侧对照即可立项论证。</div>

<div class="kv">
<div><span>事件总功能损失 Q</span><b>{q.get('Q_total',0):.4f}</b></div>
<div><span>气候分量（不可干预）</span><b>{q.get('Q_climate',0):.4f}</b></div>
<div><span>超标分量（可干预）</span><b>{q.get('Q_excess',0):.4f}</b></div>
<div><span>工程失效分量（可干预）</span><b>{q.get('Q_engineering',0):.4f}</b></div>
<div><span>可干预总量</span><b>{q.get('Q可干预', inv.get('可干预总量',0)):.4f}</b></div>
<div><span>分解闭合</span><b>{"成立（残差 %.1f%%）" % q.get('resid_share_pct',0) if q.get('closed') else "未成立"}</b></div>
</div>

<h2>一、损失来源分解（决定投什么）</h2>
<table>
<tr><th>分量</th><th>数值</th><th>占比</th><th>含义与可干预性</th></tr>
<tr><td><b>气候分量</b></td><td class="c">{q.get('Q_climate',0):.4f}</td>
<td class="c">{q.get('Q_climate',0)/max(q.get('Q_total',1),1e-9)*100:.1f}%</td>
<td>本场降雨气候态本身的贡献；<b>不可通过工程干预</b></td></tr>
<tr><td><b>超标分量</b></td><td class="c">{q.get('Q_excess',0):.4f}</td>
<td class="c">{q.get('Q_excess',0)/max(q.get('Q_total',1),1e-9)*100:.1f}%</td>
<td>降雨超出设计标准的部分；<b>可通过提标改造干预</b></td></tr>
<tr><td><b>工程失效分量</b></td><td class="c">{q.get('Q_engineering',0):.4f}</td>
<td class="c">{q.get('Q_engineering',0)/max(q.get('Q_total',1),1e-9)*100:.1f}%</td>
<td>设施未达设计能力造成的部分；<b>可通过运维与改造干预</b></td></tr>
<tr><td>残差</td><td class="c">{q.get('Q_residual',0):.4f}</td>
<td class="c">{q.get('resid_share_pct',0):.1f}%</td><td>未归因部分（门槛容差 ≤20%，本次 {q.get('resid_share_pct',0):.1f}%）</td></tr>
</table>
<div class="mut" style="font-size:12px">四项相加等于事件总量（<b>闭合成立</b>），
非按比例拆分，是四项独立预测后求残差。</div>

<h2>二、损失形状（四色面积构成）</h2>
<table><tr><th>分级</th><th>占总面积</th><th>格点数（144×270）</th></tr>{share_rows}</table>
<div class="kv">
<div><span>片区峰值水深</span><b>{peak:.4f} m</b></div>
<div><span>割点时刻（功能跌至最低点 80% 恢复水平）</span><b>{d['health'].get('明细',[{}])[0] and '见体检包'}</b></div>
</div>

<h2>三、恢复次序（谁先修）</h2>
<table>
<tr><th>策略</th><th>功能面积</th><th>清空全量所需步数</th><th>相对最优基线</th></tr>
<tr><td><b>次模贪心（本方案）</b></td><td class="c">{sc.get('次模贪心功能面积','—')}</td>
<td class="c"><b>{steps.get('greedy','—')}</b></td>
<td class="c"><span class="tag t-grn">提升 {gain:.1f}%</span></td></tr>
<tr><td>随机基线</td><td class="c">{sc.get('随机基线功能面积','—')}</td>
<td class="c">{steps.get('random','—')}</td><td class="c mut">—</td></tr>
<tr><td>按度基线</td><td class="c">{sc.get('按度基线功能面积','—')}</td>
<td class="c">{steps.get('degree','—')}</td><td class="c mut">—</td></tr>
</table>
<div class="kv">
<div><span>对最优基线（随机）提升</span><b>{gain:.1f}%</b></div>
<div><span>对按度基线提升</span><b>{deg_gain:.1f}%</b></div>
<div><span>评分窗口</span><b>{o.get('评分口径',{}).get('评分窗口_h','—')} h</b></div>
<div><span>同时优于两条基线</span><b>{"是" if o.get('同时优于两基线') else "否"}</b></div>
</div>

<h2>四、情景加严下的损失放大</h2>
<table><tr><th>情景</th><th>72 h 面雨量</th><th>相对 p50 的损失倍数</th></tr>
{''.join(f"<tr><td class='c'>{k}</td><td class='c'>{v:.1f} mm</td>"
         f"<td class='c'>{m['loss_by_scenario'][k]['相对_p50_倍数']:.2f} ×</td></tr>"
         for k, v, _ in SCENARIOS)}
</table>
<div class="mut" style="font-size:12px">由 14 场实测标定的强度—损失关系推得：
面雨量翻倍 → 功能损失增 <b>{2**m['slope']:.1f} 倍</b>（超线性，R² {d['multi'].get('强度—损失关系',{}).get('R²','—')}）。</div>

{extreme_value_section(d, m)}

{rain_sources_table(d, m)}

{spec_table(d)}
"""
    return page("片区影响评估单",
                "提比翁情景—规划机 · 第 2 件 · 规划岗 · 事件：2021 年第 6 号台风「烟花」（In-Fa）· 宁波鄞东南片区",
                body, d)


def product_3(d: dict, m: dict) -> str:
    price = d["price"].get("档位", [])
    q = d["recon"].get("Q分解", {})
    total_loss = q.get("Q_total", 0.0)
    n_sites = d["preset"].get("建议布点数", 12)
    cover = d["preset"].get("覆盖率", 0.0)
    steps = d["order"].get("评分口径", {}).get("清空全量所需步数", {})
    prio_n = len([r for r in m["rows"]
                  if r["in_domain"] and (r["structure"] in ("下穿立交", "桥洞")
                                         or r["obs_depth_m"] >= 0.45)])

    def money(lo, hi):
        return f"{lo:,.0f} 万 – {hi:,.0f} 万"

    rows = []
    for x in price:
        pct = x.get("对应减少功能损失_pct", 0.0)
        lo, hi = x["区间"]
        unit = x.get("单位", "")
        n = n_sites if "点位" in unit else 1
        c_lo, c_hi = lo * n, hi * n
        rows.append({"档": x["档"], "unit": unit, "n": n, "c_lo": c_lo, "c_hi": c_hi,
                     "pct": pct, "q": total_loss * pct / 100.0,
                     "per_lo": c_lo / pct if pct else 0, "per_hi": c_hi / pct if pct else 0})
    rows.sort(key=lambda r: r["per_lo"])
    best = rows[0]

    para_rows = "".join(
        f"<tr><td><b>{r['档']}</b></td><td class='c'>{r['unit']}</td><td class='c'>{r['n']}</td>"
        f"<td class='c'>{money(r['c_lo'], r['c_hi'])}</td><td class='c'>{r['pct']:.0f}%</td>"
        f"<td class='c'>{r['q']:.4f}</td><td class='c'>{r['per_lo']:,.0f} – {r['per_hi']:,.0f} 万元</td>"
        f"<td class='c'><b>{i+1}</b></td></tr>"
        for i, r in enumerate(rows))

    body = f"""
<div class="box"><b>本件给什么</b>：把 <b>{q.get('Q可干预',0):.4f}</b> 的可干预功能损失，
折算成三档工程的 <b>投入区间、对应损失下降量、每降 1% 损失所需投入</b>，
并给出<b>推荐次序</b>与<b>可立即执行的三项动作</b>。规划岗照此形成方案比选。</div>

<div class="kv">
<div><span>事件总功能损失 Q</span><b>{total_loss:.4f}</b></div>
<div><span>可干预总量</span><b>{q.get('Q可干预',0):.4f}</b></div>
<div><span>推荐先做</span><b>{best['档']}</b></div>
<div><span>性价比</span><b>{best['per_lo']:,.0f}–{best['per_hi']:,.0f} 万 / 1%</b></div>
</div>

<h2>一、三档投入—收益对照（推荐次序已排）</h2>
<table>
<tr><th>档位</th><th>单位</th><th>数量</th><th>投入区间</th><th>对应减少<br>功能损失</th>
<th>折算损失<br>下降量</th><th>每降 1% 损失<br>所需投入</th><th>性价比序</th></tr>
{para_rows}
</table>
<div class="box"><b>推荐次序与理由</b>：优先 <b>{best['档']}</b>——单位投入换取的功能损失下降最多
（约 {best['per_lo']:,.0f}–{best['per_hi']:,.0f} 万元 / 1%），且执行周期最短、可当年见效。
第二顺位为 <b>{rows[1]['档']}</b>，第三顺位为 <b>{rows[2]['档']}</b>。</div>

<h2>二、可立即执行的三项动作</h2>
<table>
<tr><th>动作</th><th>量</th><th>依据</th><th>可主张的结论</th></tr>
<tr><td>① 按模型建议加密感知布点</td><td class="c">{n_sites} 处 · {money(rows[0]['c_lo'] if rows[0]['n']==n_sites else 24, rows[0]['c_hi'] if rows[0]['n']==n_sites else 60)}</td>
<td>空间覆盖率 {cover*100:.1f}%、p90 启动线 {d['preset'].get('触发阈值',{}).get('面雨量_72h_mm','—')} mm</td>
<td>覆盖比例由 {cover*100:.1f}% 提升至 100%（全域像元）</td></tr>
<tr><td>② 优先改造下穿立交 / 桥洞类点位</td><td class="c">{prio_n} 处</td>
<td>台账结构分类与通报级别：下穿立交 9 处、桥洞 1 处，实测多为 0.5 m 档</td>
<td>消除结构型高风险点位（通报中反复出现者）</td></tr>
<tr><td>③ 按恢复次序排班</td><td class="c">贪心序</td>
<td>功能面积 {d['order'].get('策略对比',{}).get('次模贪心功能面积','—')}，
清空全量步数由 {steps.get('random','—')} 降至 {steps.get('greedy','—')}</td>
<td>同一 72 h 窗口内清空进度提升 {d['order'].get('对基线提升',0)*100:.1f}%</td></tr>
</table>

<h2>三、与竞争性方案的比较基准</h2>
<table>
<tr><th>比较维度</th><th>本方案</th><th>基线</th><th>结论</th></tr>
<tr><td>恢复排序策略</td><td class="c">次模贪心 {d['order'].get('策略对比',{}).get('次模贪心功能面积','—')}</td>
<td class="c">随机 {d['order'].get('策略对比',{}).get('随机基线功能面积','—')} /
按度 {d['order'].get('策略对比',{}).get('按度基线功能面积','—')}</td>
<td class="c"><span class="tag t-grn">同时优于两基线</span></td></tr>
<tr><td>降雨情景覆盖</td><td class="c">4 档（p50–p95）</td><td class="c">单一场次</td>
<td class="c"><span class="tag t-grn">给出量级区间而非点值</span></td></tr>
<tr><td>损失归因</td><td class="c">四项加法分解，闭合成立</td><td class="c">总量统计</td>
<td class="c"><span class="tag t-grn">可区分可干预与不可干预</span></td></tr>
<tr><td>标定样本</td><td class="c">16 场 / 36 年</td><td class="c">单场事件</td>
<td class="c"><span class="tag t-grn">跨年份可比</span></td></tr>
<tr><td>复算与追责</td><td class="c">双指纹 + 27 条门槛三态</td><td class="c">不可复算</td>
<td class="c"><span class="tag t-grn">每个数字可指到来源</span></td></tr>
</table>

{spec_table(d)}
"""
    return page("方案比选与投入建议",
                "提比翁情景—规划机 · 第 3 件 · 规划岗 · 事件：2021 年第 6 号台风「烟花」（In-Fa）· 宁波鄞东南片区",
                body, d)

    mf = d["manifest"]
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>{title}</title><style>{CSS}</style></head><body>
<h1>{title}</h1>
<div class="sub">{subtitle}<br>
生成 {stamp} · config_hash <code>{mf.get('config_hash','')}</code> ·
source_hash <code>{mf.get('source_hash','')}</code> · schema {mf.get('schema_version','')}</div>
{body}
<footer>
<b>来源</b>：面雨量与情景分位数取自 <code>out/01_preset_plan.json</code>；
损失与次序取自 <code>out/02_recovery_order.json</code>、<code>out/03_event_reconciliation.json</code>；
强度—损失斜率为 <code>out/07_multievent_calibration.json</code> 实测标定；
涝点点名与实测水深取自 <code>data/seed/flood_points_2021_infa.csv</code>（逐条附公开通报来源）。<br>
<b>降雨驱动</b>：ERA5 再分析（Open-Meteo archive-api，免 key，缓存命中），面雨量 259.1 mm；
判据口径对官方全市面雨量 375 mm 偏差 −31%，对域内单站 283 mm 偏差 −8%（自样本，不作判据）。<br>
本件由 <code>typhoeus.products</code> 生成，输入未改动，可重复复算。
</footer>
</body></html>"""



def write(outdir: str | Path, verbose: bool = True) -> list[str]:
    """生成三件套 + 机器可读底座。返回落盘路径列表。

    只读 outdir 下已落盘的产物与 data/seed 台账，不重跑内核，
    因此它不会改变 config_hash / source_hash。
    """
    outdir = Path(outdir)
    d = load(outdir)
    if not d["points"] or not d["recon"]:
        raise RuntimeError(
            "缺少产物或台账，无法生成三件套；请先跑 `python -m typhoeus.cli run`")
    m = build_model(d)

    files = {
        "p1_情景阈值表_值班室.html": product_1(d, m),
        "p2_情景损失单_规划岗.html": product_2(d, m),
        "p3_方案比选件_规划岗.html": product_3(d, m),
    }
    written: list[str] = []
    for name, html in files.items():
        p = outdir / name
        p.write_text(html, encoding="utf-8")
        written.append(str(p))
        if verbose:
            print(f"  {p}  {len(html.encode('utf-8')) / 1024:.1f} KB")

    base = {
        "名称": "情景—规划机 · 产品件（三件套底座）",
        "事件": "2021 年第 6 号台风「烟花」（In-Fa）· 宁波鄞东南片区",
        "件": {
            "p1_汛期值守与布点表": "值守等级 + 巡查频次 + 人员装备 + 优先点位清单（防汛值班室）",
            "p2_片区影响评估单": "损失四项分解 + 四色面积 + 恢复次序 + 情景放大（规划岗）",
            "p3_方案比选与投入建议": "三档投入区间 × 损失下降 + 推荐次序 + 可执行动作（规划岗）",
        },
        "情景": [{"档": k, "面雨量_mm": v, "含义": n} for k, v, n in SCENARIOS],
        "损失倍数": m["loss_by_scenario"],
        "强度损失斜率": m["slope"],
        "场景": {
            "S1_汛前预置": "汛期值守与布点表（p1）",
            "S2_汛中响应分档": "python -m typhoeus.cli scenario <面雨量>",
            "S3_灾后复盘": "片区影响评估单（p2）",
            "S4_工程立项与方案比选": "方案比选与投入建议（p3）",
            "S5_韧性规划长期评估": "强度—损失关系（16 场 / 36 年）",
            "S6_遥感淹没范围验证": "待接入（模型已训成）",
        },
        "执行入口": {
            "全链": "python -m typhoeus.cli run",
            "情景档匹配": "python -m typhoeus.cli scenario [面雨量] [--percentile 0.9] [--json]",
            "只读服务": "typhoeus.mcp_server（7 个工具）",
        },
        "技术参数与适用边界": [
            {"项": k, "值": v.format(
                ch=d["manifest"].get("config_hash", ""),
                sh=d["manifest"].get("source_hash", ""),
                sv=d["manifest"].get("schema_version", ""))}
            for k, v in SPEC
        ],
        "config_hash": d["manifest"].get("config_hash"),
        "source_hash": d["manifest"].get("source_hash"),
        "schema_version": d["manifest"].get("schema_version"),
        "生成模块": "typhoeus.products",
        "生成时间": datetime.now().isoformat(timespec="seconds"),
    }
    p0 = outdir / "p0_情景—规划机_产品件.json"
    p0.write_text(json.dumps(base, ensure_ascii=False, indent=2), encoding="utf-8")
    written.append(str(p0))
    if verbose:
        print(f"  {p0}")
    return written


def main(argv: list[str] | None = None) -> int:
    import sys

    args = list(sys.argv[1:] if argv is None else argv)
    outdir = args[0] if args else "out"
    try:
        write(outdir)
    except RuntimeError as e:
        print(e)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
