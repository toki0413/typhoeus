"""提比翁 Demo —— 渲染层：把六份 JSON 编译成人读视图。

对应文档第四章「产品形态」的五视图。文档承诺的导出格式是
PDF 签章版 / Excel / 公开网页版 / 体检填报接口，其中**人读渲染**是
唯一能在不引入外部依赖的前提下补齐的一项。本模块只做渲染，
不新增计算——所有数值来自 `out/*.json`，与机器 JSON 逐字段同源。

三条纪律：

1. **同源不同源不得混用**。渲染层读 JSON，不重跑内核。一旦渲染层
   自己算一遍，界面上的数和 `manifest.json` 里的 hash 就对不上，
   审计链断在这里。
2. **caveat 必须随视图走**。降雨为合成驱动这一条写进 `manifest.json`
   的 `caveat` 字段，但读者看的是页面不是 manifest。渲染层把它
   放在页脚常驻，不是折叠在角落。
3. **像元索引必须反解为经纬度**。`01_preset_plan.json` 里的
   布点坐标是 `[row, col]` 像元索引（如 `[202, 69]`），值班长无法
   据此派工。渲染层按 DEM 的经纬度轴反解，给出可读的经纬度与
   四色分级下的积水等级。

输出：`out/dashboard.html`（单文件，无外部依赖，可直接双击打开）。
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from . import projection as PRJ

# 积水分级配色，与 `projection.LEVEL_NAMES` 的顺序一致。
# 用色遵循宁波官方四色分级（绿/黄/橙/红），不自造色阶——
# 自造色阶会让读者与本地既有认知错位。
LEVEL_COLORS = {
    "绿 <0.1m": "#2e9e5b",
    "黄 0.1-0.2m": "#d9c530",
    "橙 0.2-0.5m": "#dd7a2a",
    "红 ≥0.5m": "#c2352c",
}

STATUS_COLORS = {"PASS": "#2e9e5b", "FAIL": "#c2352c",
                 "BLOCKED": "#8a8f98", "DEGRADED": "#d9a520"}


def _level_of(depth: float) -> str:
    """按宁波四色分级给出等级名。"""
    for i, lv in enumerate(PRJ.DEPTH_LEVELS):
        if depth < lv:
            return PRJ.LEVEL_NAMES[i]
    return PRJ.LEVEL_NAMES[-1]


def _pixels_to_lonlat(grid, rows_cols: list) -> list[dict]:
    """像元索引 [row, col] -> 经纬度 + 积水等级。

    `data.Grid` 的 lat/lon 是像元中心的经纬度轴，形状与 elev 一致。
    越界的索引按最近边界处理，避免渲染层抛错掩盖数据问题。
    """
    out = []
    ny, nx = grid.elev.shape
    for rc in rows_cols:
        r, c = int(rc[0]), int(rc[1])
        r = min(max(r, 0), ny - 1)
        c = min(max(c, 0), nx - 1)
        lat = float(grid.lat[r])
        lon = float(grid.lon[c])
        out.append({"row": r, "col": c, "lat": lat, "lon": lon})
    return out


def _load(outdir: Path) -> dict:
    data = {}
    for name in ("01_preset_plan", "02_recovery_order", "03_event_reconciliation",
                 "04_resilience_pricing", "05_health_metrics", "06_health_report"):
        p = outdir / f"{name}.json"
        if p.exists():
            data[name[:2]] = json.loads(p.read_text(encoding="utf-8"))
    p = outdir / "manifest.json"
    if p.exists():
        data["mf"] = json.loads(p.read_text(encoding="utf-8"))
    return data


def render_dashboard(outdir: str = "out", grid=None) -> str:
    """渲染五视图驾驶舱，返回 HTML 路径。

    grid: `data.Grid`，用于像元索引反解。缺省时布点表只显示像元索引
    并标注"未接网格"，不伪造坐标。
    """
    d = Path(outdir)
    data = _load(d)
    if "06" not in data:
        raise FileNotFoundError(f"{d} 下没有输出物，先跑 python -m typhoeus.cli run")

    mf = data.get("mf", {})
    hr = data["06"]
    hm = data.get("05", {})
    pp = data.get("01", {})
    ro = data.get("02", {})
    rec = data.get("03", {})
    price = data.get("04", {})

    pts = []
    if grid is not None and pp.get("布点坐标像元"):
        pts = _pixels_to_lonlat(grid, pp["布点坐标像元"])

    body = [
        _sec_status(hr, hm, mf),
        _sec_preset(pp, pts, grid),
        _sec_recovery(ro, hr),
        _sec_recon(rec, hr),
        _sec_price(price, hm),
        _sec_health(hm, hr),
    ]
    caveat = hr.get("caveat", "")
    html = _PAGE.format(
        title=f"提比翁 · 韧性驾驶舱 · {hr.get('事件', '')}",
        event=hr.get("事件", ""),
        kh=mf.get("config_hash", ""),
        sh=mf.get("source_hash", ""),
        kv=mf.get("kernel_version", ""),
        sv=mf.get("schema_version", ""),
        body="\n".join(body),
        caveat=caveat,
    )
    out = d / "dashboard.html"
    out.write_text(html, encoding="utf-8")
    return str(out)


# ---------- 各视图 ----------

def _sec_status(hr: dict, hm: dict, mf: dict) -> str:
    """首屏：三条物理底线 + 溯源指纹。任何视图之前先给结论。"""
    cons = hr.get("守恒性", {})
    lvl = hr.get("积水分级占比", {})
    n = hm.get("指标总数", 0)
    p = hm.get("PASS", 0)
    f = hm.get("FAIL", 0)
    b = hm.get("BLOCKED", 0)
    bars = "".join(
        f'<div class="lv"><span class="dot" style="background:{LEVEL_COLORS[k]}">'
        f'</span><span class="lvn">{k}</span>'
        f'<span class="lvp">{v*100:.1f}%</span></div>'
        for k, v in lvl.items())
    return f"""
<section class="card">
  <h2>运行状态</h2>
  <div class="grid4">
    <div class="kpi"><div class="kv">{'PASS' if cons.get('通过') else 'FAIL'}</div>
      <div class="kl">守恒残差 {cons.get('相对残差', 0):.2e}<br>
      容差 {cons.get('容差', 0):.0e}</div></div>
    <div class="kpi"><div class="kv">{'通过' if hr.get('正性',{}).get('通过') else '未通过'}</div>
      <div class="kl">正性校验</div></div>
    <div class="kpi"><div class="kv">{hr.get('峰值水深_m', 0):.3f} m</div>
      <div class="kl">峰值水深 @ {hr.get('峰值时刻_h', 0):.1f} h</div></div>
    <div class="kpi"><div class="kv">{n} 条</div>
      <div class="kl">门槛 {p} 通过 / {f} 不达标 / {b} 未验证</div></div>
  </div>
  <div class="levels">{bars}</div>
  <div class="fp">config_hash <code>{mf.get('config_hash','')}</code>
    &nbsp;·&nbsp; source_hash <code>{mf.get('source_hash','')}</code>
    &nbsp;·&nbsp; kernel <code>{mf.get('kernel_version','')}</code>
    &nbsp;·&nbsp; schema <code>{mf.get('schema_version','')}</code></div>
</section>"""


def _sec_preset(pp: dict, pts: list, grid) -> str:
    """预置视图：地图坐标 + 资源台账。文档承诺这一视图导出预置方案单。"""
    if not pp:
        return ""
    mu = pp.get("台风测度", {})
    thr = pp.get("触发阈值", {})
    rows = []
    for i, x in enumerate(pts or [], 1):
        rows.append(f"<tr><td>{i}</td><td>{x['lat']:.4f}°N</td>"
                    f"<td>{x['lon']:.4f}°E</td><td>[{x['row']}, {x['col']}]</td></tr>")
    if not rows:
        rc = pp.get("布点坐标像元", [])
        rows = [f"<tr><td>{i}</td><td colspan='3'>"
                f"像元 [{r}, {c}]（未接网格，坐标待反解）</td></tr>"
                for i, (r, c) in enumerate(rc, 1)]
    quants = "".join(
        f'<span class="chip">p{k[1:]} {v:.0f} mm</span>'
        for k, v in mu.items() if k.startswith("p"))
    return f"""
<section class="card">
  <h2>预置视图 <span class="sub">汛前预置布点与巡查排班</span></h2>
  <div class="row">
    <div class="col">
      <div class="kv2">建议布点 {pp.get('建议布点数','—')} 个</div>
      <div class="kl2">风险场前 20% 区覆盖率 {pp.get('覆盖率',0)*100:.1f}%</div>
      <div class="chips">{quants}</div>
    </div>
    <div class="col">
      <div class="kv2">触发阈值</div>
      <div class="kl2">面雨量 72h ≥ {thr.get('面雨量_72h_mm',0):.0f} mm
        或最大风速 ≥ {thr.get('最大风速_ms',0):.1f} m/s</div>
      <div class="kl2">处置：{pp.get('处置','')}</div>
    </div>
  </div>
  <table><thead><tr><th>#</th><th>纬度</th><th>经度</th><th>像元</th></tr></thead>
  <tbody>{''.join(rows)}</tbody></table>
  <div class="note">对象锚定（设施 ID、到达时限、责任人）待设施台账接入。
    当前给出的是空间位置，不足以直接派工。</div>
</section>"""


def _sec_recovery(ro: dict, hr: dict) -> str:
    """恢复视图：作业顺序 + 功能曲线读数。"""
    if not ro:
        return ""
    cmp_ = ro.get("策略对比", {})
    bars = "".join(
        f'<div class="b"><span class="bl">{k}</span>'
        f'<span class="bbar"><i style="width:{v/max(cmp_.values())*100:.1f}%"></i></span>'
        f'<span class="bv">{v:.0f}</span></div>'
        for k, v in cmp_.items())
    gain = ro.get("对基线提升", 0)
    return f"""
<section class="card">
  <h2>恢复视图 <span class="sub">灾后通路抢修排序</span></h2>
  <div class="grid3">
    <div class="kpi"><div class="kv">{gain*100:.1f}%</div>
      <div class="kl">次模贪心对基线提升</div></div>
    <div class="kpi"><div class="kv">{len(ro.get('贪心前10序',[]))}</div>
      <div class="kl">给出前 10 序</div></div>
    <div class="kpi"><div class="kv">{hr.get('峰值水深_m',0):.3f} m</div>
      <div class="kl">峰值水深（恢复起点）</div></div>
  </div>
  <div class="bars">{bars}</div>
  <div class="note">{ro.get('声明','')}。
    当前恢复顺序不含时间维与资源约束，
    回答不了"72 小时能恢复多少"。</div>
</section>"""


def _sec_recon(rec: dict, hr: dict) -> str:
    """对账视图：四项链式分解 + 溯源。"""
    if not rec:
        return ""
    q = rec.get("Q分解", {})
    items = [("气候", q.get("Q_climate", 0)), ("超标", q.get("Q_excess", 0)),
             ("工程失效", q.get("Q_engineering", 0)), ("残差", q.get("Q_residual", 0))]
    tot = abs(q.get("Q_total", 1)) or 1
    bars = "".join(
        f'<div class="b"><span class="bl">{k}</span>'
        f'<span class="bbar"><i style="width:{abs(v)/tot*100:.1f}%"></i></span>'
        f'<span class="bv">{v:.4f}</span></div>' for k, v in items)
    cv = rec.get("实测校验", {})
    chk = ""
    if cv:
        chk = (f'<div class="grid3">'
               f'<div class="kpi"><div class="kv">{cv.get("命中率",0)*100:.1f}%</div>'
               f'<div class="kl">涝点覆盖 {cv.get("命中数")}/{cv.get("涝点总数")}</div></div>'
               f'<div class="kpi"><div class="kv">{cv.get("水位MAE_m",0):.3f} m</div>'
               f'<div class="kl">水位 MAE</div></div>'
               f'<div class="kpi"><div class="kv">{cv.get("水位最大偏差_m",0):.2f} m</div>'
               f'<div class="kl">最大偏差</div></div></div>')
    return f"""
<section class="card">
  <h2>对账视图 <span class="sub">功能损失加法分解</span></h2>
  <div class="grid2">
    <div class="kpi"><div class="kv">{q.get('Q_total',0):.4f}</div>
      <div class="kl">事件总损失（功能·小时）</div></div>
    <div class="kpi"><div class="kv">{q.get('resid_share_pct',0):.1f}%</div>
      <div class="kl">残差占比（门槛 8 线 ≤20%）</div></div>
  </div>
  <div class="bars">{bars}</div>
  {chk}
  <div class="note">闭合判定：{q.get('closed','')}。
    气候标度 CC 当前为 {q.get('cc_mid_pct_per_K',0)} %/K，
    单场事件里它与雨区移动、抽排能力、暴露度完全共线，
    <b>该数字不具备统计意义，不可写入对外材料</b>。</div>
</section>"""


def _sec_price(price: dict, hm: dict) -> str:
    """价目表视图：档位 + 灵敏度。"""
    if not price:
        return ""
    rows = "".join(
        f"<tr><td>{d.get('档位','')}</td><td>{d.get('区间','')}</td>"
        f"<td class='r'>{d.get('note','')}</td></tr>"
        for d in price.get("档位", []))
    bs = price.get("依据", {})
    return f"""
<section class="card">
  <h2>价目表视图 <span class="sub">改造投入与功能损失</span></h2>
  <div class="kl2">{price.get('口径','')}</div>
  <table><thead><tr><th>档位</th><th>投入区间</th><th>说明</th></tr></thead>
  <tbody>{rows}</tbody></table>
  <div class="grid4">
    <div class="kpi"><div class="kv">{bs.get('气候分量_Q',0):.4f}</div><div class="kl">气候分量</div></div>
    <div class="kpi"><div class="kv">{bs.get('超标分量_Q',0):.4f}</div><div class="kl">超标分量</div></div>
    <div class="kpi"><div class="kv">{bs.get('工程失效分量_Q',0):.4f}</div><div class="kl">工程失效分量</div></div>
    <div class="kpi"><div class="kv">{bs.get('可干预总量',0):.3f}</div><div class="kl">可干预总量</div></div>
  </div>
  <div class="note">{price.get('声明','')}。伴生灵敏度相对误差中位数
    {hm.get('明细',[{}])[6].get('实测值','—') if len(hm.get('明细',[]))>6 else '—'}。</div>
</section>"""


def _sec_health(hm: dict, hr: dict) -> str:
    """体检视图：15 条门槛 + 四阶段五维覆盖矩阵。"""
    if not hm:
        return ""
    rows = "".join(
        "<tr><td class='c'>{}</td><td>{}</td>"
        "<td class='c'>{}</td><td class='c'>{}</td>"
        "<td><span class='st' style='background:{}'>{}</span></td>"
        "<td class='rt'>{}</td>"
        "<td class='c sm'>{}</td>"
        "<td class='c sm'>{}</td></tr>".format(
            x.get("编号"), x.get("验证内容", ""), x.get("实测值", ""),
            x.get("门槛", ""),
            STATUS_COLORS.get(x.get("状态", ""), "#888"), x.get("状态", ""),
            x.get("根因", ""), x.get("阶段", ""), x.get("维度", ""))
        for x in hm.get("明细", []))
    mat = hm.get("覆盖矩阵", {}).get("matrix", {})
    mrows = ""
    if mat:
        from .gates import DIMENSIONS, STAGES
        cn = {"community": "社区人口", "official": "政府管理",
              "housing": "住房设施", "economy": "经济发展",
              "environment": "环境文化"}
        head = "".join(f"<th>{cn.get(d, d)}</th>" for d in DIMENSIONS)
        body = ""
        for s in STAGES:
            cells = "".join(
                f"<td class='c'>{(mat.get(s, {}).get(d) or []) and len(mat[s][d]) or '—'}</td>"
                for d in DIMENSIONS)
            body += f"<tr><th>{s}</th>{cells}</tr>"
        mrows = (f"<h3>四阶段 × 五维度覆盖矩阵</h3>"
                 f"<table class='mx'><thead><tr><th></th>{head}</tr></thead>"
                 f"<tbody>{body}</tbody></table>"
                 f"<div class='note'>数字为该格覆盖的门槛条数，— 表示无覆盖。"
                 f"recovery 时间维与规划评估模块补上后，避难期与复兴期才填得上。</div>")
    return f"""
<section class="card">
  <h2>体检视图 <span class="sub">{hm.get('指标总数',0)} 条门槛</span></h2>
  <div class="grid4">
    <div class="kpi"><div class="kv" style="color:{STATUS_COLORS['PASS']}">{hm.get('PASS',0)}</div><div class="kl">PASS</div></div>
    <div class="kpi"><div class="kv" style="color:{STATUS_COLORS['FAIL']}">{hm.get('FAIL',0)}</div><div class="kl">FAIL</div></div>
    <div class="kpi"><div class="kv" style="color:{STATUS_COLORS['BLOCKED']}">{hm.get('BLOCKED',0)}</div><div class="kl">BLOCKED</div></div>
    <div class="kpi"><div class="kv">{len(hm.get('覆盖矩阵',{}).get('empty_cells',[]))}</div><div class="kl">矩阵空格</div></div>
  </div>
  <table class="gt"><thead><tr><th>#</th><th>验证内容</th><th>实测值</th><th>门槛</th>
  <th>状态</th><th>根因</th><th>阶段</th><th>维度</th></tr></thead>
  <tbody>{rows}</tbody></table>
  {mrows}
</section>"""


_PAGE = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<style>
:root {{
  --bg:#f6f7f9; --card:#fff; --fg:#1c2024; --mut:#6b7280;
  --line:#e3e6ea; --acc:#1f5f8b; --warn:#c2352c;
}}
* {{ box-sizing:border-box; }}
body {{ margin:0; background:var(--bg); color:var(--fg);
  font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }}
header {{ background:var(--acc); color:#fff; padding:18px 24px; }}
header h1 {{ margin:0; font-size:19px; font-weight:600; }}
header .sub {{ opacity:.85; font-size:13px; }}
main {{ max-width:1180px; margin:0 auto; padding:20px 16px 60px; }}
.card {{ background:var(--card); border:1px solid var(--line);
  border-radius:8px; padding:18px 20px; margin:0 0 16px; }}
h2 {{ margin:0 0 14px; font-size:16px; font-weight:600;
  border-left:3px solid var(--acc); padding-left:9px; }}
h2 .sub {{ font-weight:400; font-size:12px; color:var(--mut);
  margin-left:8px; }}
h3 {{ margin:20px 0 8px; font-size:14px; color:var(--mut); }}
.grid2,.grid3,.grid4 {{ display:grid; gap:12px; margin-bottom:14px; }}
.grid2 {{ grid-template-columns:repeat(2,1fr); }}
.grid3 {{ grid-template-columns:repeat(3,1fr); }}
.grid4 {{ grid-template-columns:repeat(4,1fr); }}
.kpi {{ background:#fafbfc; border:1px solid var(--line);
  border-radius:6px; padding:12px 14px; }}
.kv {{ font-size:22px; font-weight:600; color:var(--acc); }}
.kl {{ font-size:12px; color:var(--mut); margin-top:4px; }}
.kv2 {{ font-size:17px; font-weight:600; }}
.kl2 {{ font-size:12.5px; color:var(--mut); }}
.row {{ display:grid; grid-template-columns:1fr 1fr; gap:16px;
  margin-bottom:12px; }}
.col {{ background:#fafbfc; border:1px solid var(--line);
  border-radius:6px; padding:12px 14px; }}
.chips {{ margin-top:8px; }}
.chip {{ display:inline-block; background:#eaf1f6; color:var(--acc);
  border-radius:4px; padding:2px 8px; margin:3px 4px 0 0; font-size:12px; }}
table {{ width:100%; border-collapse:collapse; margin:8px 0; font-size:13px; }}
th,td {{ border:1px solid var(--line); padding:6px 9px;
  text-align:left; vertical-align:top; }}
th {{ background:#f0f2f5; font-weight:600; }}
td.c,th.c {{ text-align:center; }}
td.sm {{ font-size:11.5px; color:var(--mut); }}
td.rt {{ font-size:12px; color:var(--mut); max-width:380px; }}
.st {{ display:inline-block; color:#fff; border-radius:3px;
  padding:1px 7px; font-size:11.5px; }}
.levels {{ display:flex; gap:14px; flex-wrap:wrap; margin-top:6px; }}
.lv {{ display:flex; align-items:center; gap:6px; font-size:12.5px; }}
.dot {{ width:11px; height:11px; border-radius:50%; display:inline-block; }}
.lvn {{ color:var(--mut); }}
.lvp {{ font-weight:600; }}
.fp {{ margin-top:14px; font-size:11.5px; color:var(--mut); }}
code {{ background:#eef0f3; padding:1px 5px; border-radius:3px;
  font-size:11.5px; }}
.bars {{ margin:8px 0; }}
.b {{ display:flex; align-items:center; gap:9px; margin:5px 0; }}
.bl {{ width:62px; font-size:12.5px; color:var(--mut); }}
.bbar {{ flex:1; background:#eef0f3; height:15px; border-radius:3px; }}
.bbar i {{ display:block; height:100%; background:var(--acc);
  border-radius:3px; }}
.bv {{ width:76px; text-align:right; font-size:12px;
  font-variant-numeric:tabular-nums; }}
.note {{ margin-top:12px; padding:9px 12px; background:#fdf6ec;
  border-left:3px solid #d9a520; font-size:12.5px; color:#5c4a20;
  border-radius:0 4px 4px 0; }}
footer {{ max-width:1180px; margin:0 auto; padding:0 16px 40px; }}
.caveat {{ background:#fdeceb; border:1px solid #f0b8b4;
  border-radius:6px; padding:12px 14px; font-size:12.5px; color:#7a2c26; }}
@media (max-width:820px) {{
  .grid2,.grid3,.grid4,.row {{ grid-template-columns:1fr; }}
}}
</style></head><body>
<header><h1>{title}</h1>
<div class="sub">{event}</div></header>
<main>
{body}
</main>
<footer><div class="caveat"><b>使用边界</b>：{caveat}</div></footer>
</body></html>"""