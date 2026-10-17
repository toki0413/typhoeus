"""提比翁 Demo —— 转译层：把落盘产物编译成市民与街道各自能用的信息。

对应 `提比翁_项目陈述_AI4Climate赛道五_V4.docx`：
  第三章表 2 —— 社区居民的系统动作＝涝点查询 / 避险路线 / 对账单阅读 / 影像上传
  第四章表 3 —— "你来出题"代入视图 → 科普交互与观测入口 → 移动端实时界面
  §4.3      —— 封路与步行通行数据未接入时"只给涝点避让"，不产出路线

三条纪律（与 `guardrails.py` 同源，是代码不是提示词）：
  A1 每条结论必须带出处指针（产物文件 + 记录号 + 台账出处），无出处的数字不得出现；
  A2 雨量类数字必须同时给两个来源，单给一个即整段不出现；
  A3 模型看不见的点位（预测水深 < 0.05 m 而实测有积水）不得据模型出结论，
     改为提示按台账人工巡查——这类点位恰恰历史上淹得最深。

「责任方 / 到达时限 / 台班数量」属预置方案单字段（V4 §7.3），其数据源在
V4 §4.2 标注为"甲方提供"、当前未取得，因此本层不产出这些字段。

只读已落盘的编译输出，不调用内核、不改任何参数。
"""
from __future__ import annotations

import json
from bisect import bisect_right
from pathlib import Path

from . import config as CFG
from . import observe as OB
from . import projection as PRJ

# ---- 加性偏移校正（p58 留出验证；p59 排除了口径差的大半）----
# 17 点残差全为正，均值 0.3593 m、标准差 0.1034 m。
# 留一法 MAE 0.3593 -> 0.0909（改善 74.7%），四型三结构全部改善。
# **成因未完全分离**：p59 实测四种空间聚合最多解释 22.6%，
# 故这 0.359 m 主要是模型系统性偏浅，不是"点位值 vs 格点面平均"的口径差。
# 用法约束：只作与通报口径对齐的经验修正，**不当作物理水深真值**。
BIAS_M = 0.359
BIAS_BAND_M = 0.103
BIAS_NOTE = (
    "经验校正：+0.359 m（带宽 ±0.103 m）。来自 17 点残差的留出验证，"
    "MAE 0.3593→0.0909。只用它与通报口径对齐，不作物理真值。"
    "原值见 model_depth_m。"
)

MODEL_SILENT_M = 0.05      # 低于此预测水深视为"模型看不见"
LEVEL_BOUNDS = PRJ.DEPTH_LEVELS          # (0.10, 0.20, 0.50) 宁波官方四色
LEVEL_NAMES = PRJ.LEVEL_NAMES

SILENT_ACTION = ("该点本轮模型未产出积水，建议按台账人工巡查一次并回报实况")


def level_of(depth_m: float) -> int:
    """水深 → 四色档（0 绿 … 3 红）。下界归入高档：0.10 m 为黄。"""
    return bisect_right(LEVEL_BOUNDS, depth_m + 1e-12)


def _read_json(outdir: Path, name: str) -> dict:
    p = outdir / name
    if not p.exists():
        return {}
    return json.loads(p.read_text(encoding="utf-8"))


def _points(rec: dict) -> dict:
    """取对账单里的逐点对照，按 point_id 建索引。

    实测校验段的历史写法有两种：list 直接给，或包在 {"逐点对照": [...]} 里。
    这里两种都收，但取不到就返回空——空即所有点标"未验证"，不做猜测。
    """
    src = rec.get("实测校验") or {}
    rows = src.get("逐点对照", []) if isinstance(src, dict) else src
    out = {}
    for d in rows or []:
        if isinstance(d, dict) and d.get("point_id"):
            out[d["point_id"]] = d
    return out


def build(outdir: str | Path) -> dict:
    out = Path(outdir)
    rec = _read_json(out, "03_event_reconciliation.json")
    pre = _read_json(out, "01_preset_plan.json")
    hm = _read_json(out, "05_health_metrics.json")

    bb = CFG.Config().l2.bbox

    def in_domain(fp) -> bool:
        return (bb["lon_min"] <= fp.lon <= bb["lon_max"]
                and bb["lat_min"] <= fp.lat <= bb["lat_max"])

    per_point = _points(rec)
    gates = {g["编号"]: g for g in hm.get("明细", [])}
    g14, g2 = gates.get(14, {}), gates.get(2, {})
    rc = (pre.get("输入层校验") or {})
    bbox = rc.get("domain_basis") or ""

    # A2：两个来源齐备才允许出现雨量，否则整段不出现
    rain_pair = None
    if rc.get("model_mm") is not None and rc.get("allcity_mm") is not None:
        rain_pair = {
            "model_mm": round(rc["model_mm"], 1),
            "obs_domain_mm": rc.get("obs_mm"),
            "obs_allcity_mm": rc.get("allcity_mm"),
            "rel_err_domain_pct": round((rc.get("rel_err") or 0) * 100, 1),
            "rel_err_allcity_pct": round((rc.get("rel_err_allcity") or 0) * 100, 1),
            "in_sample": bool(rc.get("in_sample")),
            "basis_note": rc.get("sampling_bias", ""),
            # 下面四个键是 G18（双口径完整率）的契约字段名。
            # 本件把「输入层校验」重命名成「降雨双来源」时会丢掉原名，
            # 导致 G18 认不出这一段——实测 G18 因此报 80% FAIL（见 agent_gates
            # 的 _PAIR_RULES）。值与上面的 _pct 字段同源，只是保留契约名，
            # 不改任何数值。
            "rel_err_verdict": rc.get("rel_err"),
            "rel_err_allcity": rc.get("rel_err_allcity"),
            "verdict_basis": "域内站（判据口径）",
            "domain_basis": bbox,
        }

    cards = []
    for fp in OB.load_flood_points():
        d = per_point.get(fp.point_id)
        model_m = (d or {}).get("model_depth_m")
        obs_m = float(fp.depth_m)
        lv_obs = level_of(obs_m)
        lv_mod = level_of(model_m) if model_m is not None else None
        visible = model_m is not None and model_m >= MODEL_SILENT_M
        vis_dom = in_domain(fp)
        if not vis_dom:
            # R1 越域：计算域外的点不产出任何模型结论，只转述台账记录
            trust, why = "域外未计算", (
                f"该点坐标不在计算域内（{bb['lon_min']}–{bb['lon_max']}E / "
                f"{bb['lat_min']}–{bb['lat_max']}N），模型未覆盖，以下均为台账记录")
        elif d is None:
            trust, why = "未验证", "该点不在本次事件对账单的逐点对照里"
        elif not visible:
            trust, why = "不采信模型", (
                f"预测水深 {model_m:.3f} m < {MODEL_SILENT_M} m，"
                f"而实测 {obs_m:.2f} m；历史上这类点恰是深积水点")
        else:
            trust, why = "可发", f"预测 {model_m:.2f} m 对实测 {obs_m:.2f} m"
        lvl = LEVEL_NAMES[lv_obs].split(" ")[0]
        cards.append({
            "point_id": fp.point_id, "name": fp.name, "district": fp.district,
            "lon": fp.lon, "lat": fp.lat,
            "structure_type": fp.structure_type,
            "obs_depth_m": obs_m, "obs_level": LEVEL_NAMES[lv_obs],
            "model_depth_m": model_m,
            "model_level": LEVEL_NAMES[lv_mod] if lv_mod is not None else None,
            "model_visible": visible,
            "in_domain": vis_dom,
            # 校正读数：仅在有模型值时给；**不参与 trust 判定**（见文件头约束 2）
            "model_depth_corrected_m": (
                round(model_m + BIAS_M, 3) if model_m is not None else None),
            "correction_band_m": BIAS_BAND_M if model_m is not None else None,
            "model_level_corrected": (
                LEVEL_NAMES[level_of(model_m + BIAS_M)] if model_m is not None
                else None),
            "correction_note": BIAS_NOTE if model_m is not None else None,
            "trust": trust, "trust_why": why,
            "查询": (f"{fp.district} {fp.name}｜{fp.structure_type}｜"
                     f"实测积水 {obs_m:.2f} m（{LEVEL_NAMES[lv_obs]}）｜"
                     f"实测时间 {fp.observed_at}"),
            "避险": (f"{lvl}级，建议绕开该点通行" if lv_obs >= 2
                     else f"{lvl}级，通行受阻风险上升"),
            "对账": (f"该点在本次事件对账单中的记录号 {fp.point_id}，"
                     f"模型读数 {'无记录' if model_m is None else f'{model_m:.3f} m'}"),
            "人工处置": None if visible else SILENT_ACTION,
            "source": {"file": "03_event_reconciliation.json",
                       "record": fp.point_id,
                       "point_provenance": fp.provenance,
                       "observed_at": fp.observed_at},
        })

    n_vis = sum(1 for c in cards if c["model_visible"])
    return {
        "名称": "涝点转译卡（查询 / 避险 / 对账三轨）",
        "事件": rec.get("事件", ""),
        "schema_version": rec.get("schema_version", ""),
        "可信度总则": (f"本批 {len(cards)} 张卡中，模型看见 {n_vis} 个、"
                        f"看不见 {len(cards) - n_vis} 个；看不见的点一律给人工巡查，"
                        "不据模型出结论。"),
        "全链可信度": {
            "门槛2_涝点覆盖": f"{g2.get('实测值', '?')}"
                              f"（门槛 {g2.get('门槛', '?')}，状态 {g2.get('状态', '?')}）",
            "门槛14_水深命中": f"{g14.get('实测值', '?')}"
                               f"（状态 {g14.get('状态', '?')}）",
        },
        "降雨双来源": rain_pair,
        "计算域": bbox,
        # 读数规则随每次返回一起走。写在 payload 里而不是只写进工具描述，
        # 是因为本项目的一贯判据是"护栏放工具层、不放提示词层"——
        # 描述是给模型看的建议，这段是数据自带的约束，会跟着返回进入上下文。
        "读数规则": [
            "引用任何 model_depth_m 时，必须同时引用该卡的 trust 与 model_visible。",
            "model_visible=false 时不得报出模型水深，只能报实测值与 trust_why。",
            "model_depth_m=null 表示模型未覆盖（域外），不得以 0 代替。",
            "引用 model_depth_corrected_m 时，必须同时报 correction_band_m 与 correction_note；不得只报校正值而不报带宽。",
            "校正值不改变 trust 与 model_visible——那两项只由未校正的 model_depth_m 决定，以免循环论证。",
            "本批 28 个点中仅 5 个 model_visible=true；其余点一律转人工巡查。",
        ],
        "卡片": cards,
    }


def render_html(doc: dict) -> str:
    """自包含页面：不引外部脚本与地图库，离线可开。"""
    payload = json.dumps(doc, ensure_ascii=False).replace("</", "<\\/")
    return """<!doctype html><html lang="zh"><meta charset="utf-8">
<title>涝点转译卡</title>
<style>
body{font:14px/1.6 "Microsoft YaHei",sans-serif;margin:0;background:#101418;color:#e8eef4}
header{padding:14px 20px;background:#161c22;border-bottom:1px solid #2a3440}
h1{font-size:16px;margin:0}.sub{color:#9fb0c0;font-size:12px;margin-top:4px}
main{display:flex;gap:16px;padding:16px;align-items:flex-start}
#map{background:#1a2129;border:1px solid #2a3440;border-radius:6px;flex:0 0 auto}
.dot{cursor:pointer}.panel{flex:1;min-width:320px;background:#161c22;border:1px solid #2a3440;border-radius:6px;padding:14px}
.lbl{color:#9fb0c0;font-size:12px}.t-ok{color:#5ad17a}.t-no{color:#ff7b72}.t-nv{color:#e3b341}
.row{display:flex;gap:8px;flex-wrap:wrap;margin:6px 0}
.chip{border:1px solid #2a3440;border-radius:4px;padding:2px 8px;font-size:12px}
ul{list-style:none;padding:0;margin:8px 0;max-height:340px;overflow:auto}
li{padding:5px 8px;border-bottom:1px solid #202832;cursor:pointer}
li:hover,li.sel{background:#1d2630}
</style>
<header><h1>涝点转译卡 · 查询 / 避险 / 对账</h1><div class="sub" id="top"></div></header>
<main><svg id="map" width="420" height="420"></svg>
<div class="panel"><div id="detail"></div><div class="lbl">点击点位或列表切换</div>
<ul id="list"></ul></div></main>
<script id="d" type="application/json">__PAYLOAD__</script>
<script>
const doc=JSON.parse(document.getElementById('d').textContent);
const cs=doc.卡片;
const lon=cs.map(c=>c.lon),lat=cs.map(c=>c.lat);
const x0=Math.min.apply(null,lon),x1=Math.max.apply(null,lon);
const y0=Math.min.apply(null,lat),y1=Math.max.apply(null,lat);
const sx=v=>24+(v-x0)/((x1-x0)||1)*372,sy=v=>396-(v-y0)/((y1-y0)||1)*372;
const COL={'绿':'#5ad17a','黄':'#e3b341','橙':'#ff9f4d','红':'#ff7b72'};
const TC={'可发':'t-ok','不采信模型':'t-no','未验证':'t-nv'};
document.getElementById('map').innerHTML=
 '<rect x="20" y="20" width="380" height="380" fill="#141a20" stroke="#2a3440"/>'
 +cs.map((c,i)=>{const col=COL[c.obs_level[0]]||'#8899aa';
   return '<circle class="dot" data-i="'+i+'" cx="'+sx(c.lon).toFixed(1)+'" cy="'+sy(c.lat).toFixed(1)
     +'" r="'+(c.model_visible?6:8)+'" fill="'+(c.model_visible?col:'none')
     +'" stroke="'+col+'" stroke-width="2"/>'}).join('');
document.getElementById('list').innerHTML=cs.map((c,i)=>
 '<li data-i="'+i+'"><b>'+c.district+' '+c.name+'</b> <span class="lbl">'+c.structure_type
 +'</span> 实测 '+c.obs_depth_m+' m <span class="'+TC[c.trust]+'">'+c.trust+'</span></li>').join('');
function show(i){const c=cs[i];
 document.getElementById('detail').innerHTML=
  '<h3>'+c.district+' '+c.name+'</h3>'
  +'<div class="row"><span class="chip">'+c.structure_type+'</span>'
  +'<span class="chip">模型 '+(c.model_depth_m===null?'无记录':c.model_depth_m+' m · '+(c.model_level||''))+'</span></div>'
  +'<p><b>涝点查询：</b>'+c['查询']+'</p><p><b>避险：</b>'+c['避险']+'</p>'
  +'<p><b>对账单：</b>'+c['对账']+'</p>'
  +(c['人工处置']?'<p><b>人工处置：</b>'+c['人工处置']+'</p>':'')
  +'<p class="'+TC[c.trust]+'"><b>可信度：'+c.trust+'</b>（'+c.trust_why+'）</p>'
  +'<p class="lbl">出处：'+c.source.file+' · '+c.source.record+' · 台账 '+c.source.point_provenance+'</p>';}
document.getElementById('map').addEventListener('click',e=>{if(e.target.dataset.i!==undefined)show(+e.target.dataset.i)});
document.getElementById('list').addEventListener('click',e=>{if(e.target.dataset.i!==undefined)show(+e.target.dataset.i)});
document.getElementById('top').textContent=doc.事件+' ｜ '+doc.可信度总则
 +' ｜ 门槛实测：'+doc.全链可信度['门槛2_涝点覆盖']+'；'+doc.全链可信度['门槛14_水深命中'];
show(0);
</script></html>""".replace("__PAYLOAD__", payload)


def write(outdir: str | Path) -> dict:
    out = Path(outdir)
    doc = build(outdir)
    j = out / "08_flood_cards.json"
    j.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
    h = out / "citizen.html"
    h.write_text(render_html(doc), encoding="utf-8")
    return {"json": str(j), "html": str(h), "n": len(doc["卡片"]), "doc": doc}
