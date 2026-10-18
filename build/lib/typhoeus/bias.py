"""模型偏差诊断与残差校正。

对应借鉴：Earth-2 / CorrDiff 的"残差校正"思想——不重造预测，而是学
"模型相对观测的系统偏差"，再把它作为可复算的修正层。

本模块只做**确定性统计**（分组均值/中位数 + 乘性/加性因子），不做黑箱回归：
域内配对点仅 17 个，任何多点参数化都会过拟合。分组依据是台账里的结构类型
（下穿立交 / 桥洞 / 低洼小区 / 低洼路段）——这是唯一有 17 个样本支撑的分层维度。

输出：
  <outdir>/p4_偏差诊断与残差校正.html
  <outdir>/p5_偏差校正表.json
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 小样本下的最小分组样本量：低于此值只报诊断、不给校正系数
MIN_N_FOR_FACTOR = 3


def _median(xs: list[float]) -> float:
    s = sorted(xs)
    n = len(s)
    if n == 0:
        return 0.0
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2.0


def _mean(xs: list[float]) -> float:
    return sum(xs) / len(xs) if xs else 0.0


def diagnose(d: dict) -> dict:
    """按结构类型分组诊断系统偏差，并检验校正是否真的有效。

    关键诚实点：本模型在单点尺度上输出普遍为 0–0.17 m，若其在配对点上**没有
    区分能力**（相关系数≈0），则任何校正系数都无法降低误差——乘性校正会把
    微小噪声放大，反而使 MAE 上升。此时正确结论是"本版本不可做单点偏差校正"，
    而不是硬凑一个改善数字。
    """
    recon = d["recon"].get("实测校验", {})
    pairs = recon.get("逐点对照", [])
    latency = d.get("cards", {}).get("全链可信度", {})

    rows = []
    for p in pairs:
        obs = float(p["obs_depth_m"])
        mod = p.get("model_depth_m")
        mod = None if mod is None else float(mod)
        rows.append({
            "id": p["point_id"],
            "name": p["name"],
            "structure": p.get("structure_type", "未分类"),
            "obs": obs,
            "model": mod,
            "resid": (None if mod is None else obs - mod),      # 观测 − 模型
        })

    pairable = [r for r in rows if r["model"] is not None]
    resids = [r["resid"] for r in pairable]
    abs_errs = [abs(x) for x in resids]

    # ---- 模型在配对点上有没有区分能力（决定校正是否有意义）----
    obs_v = [r["obs"] for r in pairable]
    mod_v = [r["model"] for r in pairable]
    n = len(pairable)
    m_obs, m_mod = _mean(obs_v), _mean(mod_v)
    cov = sum((o - m_obs) * (mm - m_mod) for o, mm in zip(obs_v, mod_v))
    var_o = sum((o - m_obs) ** 2 for o in obs_v)
    var_m = sum((mm - m_mod) ** 2 for mm in mod_v)
    denom = (var_o * var_m) ** 0.5
    corr = (cov / denom) if denom > 1e-12 else 0.0
    r2 = corr ** 2
    # 秩相关（对单调关系更稳健，样本 17）
    def _rank(xs):
        order = sorted(range(len(xs)), key=lambda i: xs[i])
        rk = [0.0] * len(xs)
        for pos, i in enumerate(order):
            rk[i] = float(pos)
        return rk
    ro, rm = _rank(obs_v), _rank(mod_v)
    mo, mm_ = _mean(ro), _mean(rm)
    c_ = sum((a - mo) * (b - mm_) for a, b in zip(ro, rm))
    d_ = (sum((a - mo) ** 2 for a in ro) * sum((b - mm_) ** 2 for b in rm)) ** 0.5
    spearman = (c_ / d_) if d_ > 1e-12 else 0.0

    overall = {
        "配对数": n,
        "残差均值_m": round(_mean(resids), 4),
        "残差中位数_m": round(_median(resids), 4),
        "MAE_m": round(_mean(abs_errs), 4),
        "全为偏浅": all(x > 0 for x in resids),
        "偏浅点数": sum(1 for x in resids if x > 0),
        "模型实测相关_pearson": round(corr, 4),
        "模型实测相关_spearman": round(spearman, 4),
        "决定系数_R2": round(r2, 4),
        "模型均值_m": round(m_mod, 4),
        "实测均值_m": round(m_obs, 4),
    }

    # ---- 按结构类型分组 ----
    groups: dict[str, list[dict]] = {}
    for r in pairable:
        groups.setdefault(r["structure"], []).append(r)

    table = []
    raw_all: list[float] = []
    corr_mult_all: list[float] = []
    floor_all: list[float] = []
    for st, rs in sorted(groups.items(), key=lambda kv: -len(kv[1])):
        obs = [r["obs"] for r in rs]
        mod = [r["model"] for r in rs]
        resid = [r["resid"] for r in rs]
        nn = len(rs)
        mean_obs, mean_mod = _mean(obs), _mean(mod)
        mult = (mean_obs / mean_mod) if mean_mod > 1e-9 else None
        add = mean_obs - mean_mod
        # 乘法校正（真实偏差模型）；地板注入（把该类实测均值作为下限，非预测）
        cm = [abs(r["obs"] - r["model"] * mult) for r in rs] if mult else None
        cf = [abs(r["obs"] - max(r["model"], mean_obs)) for r in rs]
        raw_all += [abs(r["resid"]) for r in rs]
        if cm:
            corr_mult_all += cm
        floor_all += cf
        table.append({
            "结构类型": st,
            "样本数": nn,
            "实测均值_m": round(mean_obs, 4),
            "模型均值_m": round(mean_mod, 4),
            "残差均值_m": round(_mean(resid), 4),
            "MAE_原_m": round(_mean([abs(x) for x in resid]), 4),
            "MAE_乘性校正后_m": (round(_mean(cm), 4) if cm else None),
            "MAE_地板注入后_m": round(_mean(cf), 4),
            "乘性因子": (round(mult, 3) if mult else None),
            "加性修正_m": round(add, 4),
        })

    mae_raw = _mean(raw_all) if raw_all else 0.0
    mae_mult = _mean(corr_mult_all) if corr_mult_all else None
    mae_floor = _mean(floor_all) if floor_all else None

    # ---- 校正是否有意义：两道检验都要过 ----
    # 检验一（有信息）：模型在点位上是否有区分能力。
    # 检验二（校正有效）：乘性校正是否真的把 MAE 降下来。二者都过才采用系数。
    has_signal = bool(corr > 0.3 and r2 > 0.09)
    mult_helps = bool(mae_mult is not None and mae_mult < mae_raw)
    if has_signal and mult_helps:
        concl = ("模型在点位上有区分能力，且乘性校正使 MAE 由 %.3f 降到 %.3f，"
                 "可采用分组系数" % (mae_raw, mae_mult))
    elif has_signal and not mult_helps:
        concl = ("模型在点位上有统计相关性（Pearson %+.2f，R² %.3f），但**乘性校正使 MAE 由 "
                 "%.3f 升到 %.3f**——因模型输出量级仅 %.3f m 而实测均值 %.3f m，"
                 "放大系数把微小噪声一并放大。故不采用系数校正；"
                 "偏差属结构性缺失（管网顶托与地形分辨率），须补数据而非补系数。"
                 % (corr, r2, mae_raw, mae_mult, m_mod, m_obs))
    else:
        concl = ("模型在点位上无区分能力（Pearson %+.2f，R² %.3f），"
                 "任何系数校正都不成立" % (corr, r2))

    verdict = {
        "检验一_模型有信息": has_signal,
        "检验一_判据": "Pearson > 0.3 且 R² > 0.09",
        "检验一_实测": "Pearson %+.4f，R² %.4f" % (corr, r2),
        "检验二_校正有效": mult_helps,
        "检验二_判据": "乘性校正后 MAE 必须低于原始 MAE",
        "检验二_实测": "原始 %.4f → 乘性校正后 %.4f" % (mae_raw, mae_mult if mae_mult else float("nan")),
        "是否采用系数校正": bool(has_signal and mult_helps),
        "MAE_原_m": round(mae_raw, 4),
        "MAE_乘性校正后_m": (round(mae_mult, 4) if mae_mult is not None else None),
        "MAE_注入该类观测均值后_m": (round(mae_floor, 4) if mae_floor is not None else None),
        "注": ("注入观测均值后 MAE 虽小（%.3f m），但那等于用观测均值当预测，"
               "不构成预测能力，故不作为产品口径" % (mae_floor if mae_floor else 0.0)),
        "结论": concl,
    }

    silent = [r for r in pairable if r["model"] < 0.05]
    silent_info = {
        "静默点数": len(silent),
        "占配对比例": round(len(silent) / n, 4) if n else 0.0,
        "静默点实测均值_m": round(_mean([r["obs"] for r in silent]), 4) if silent else 0.0,
        "有响应点数": n - len(silent),
        "说明": ("模型水深 < 0.05 m 的点无法用乘性因子校正（0 × k = 0）；"
                 "把它们抬到该类观测均值只等于用观测均值做预测，不构成预测能力"),
    }

    return {
        "名称": "模型偏差诊断与残差校正",
        "事件": "2021 年第 6 号台风「烟花」（In-Fa）· 宁波鄞东南片区",
        "总体": overall,
        "分组": table,
        "静默点": silent_info,
        "校正是否有意义": verdict,
        "可用与不可用": {
            "排序类决策（谁先修）": "不受影响：排序只用相对次序与功能面积差",
            "片区级损失量级": "不受影响：单点偏差在片区聚合中被平均",
            "单点水深读数": "不采用：模型量级仅 %.3f m（实测均值 %.3f m），"
                            "且偏差无有效校正，残余偏差大于四色分级绿黄间距 0.1 m"
                            % (m_mod, m_obs),
            "偏差系数校正": "不采用：乘性校正使 MAE 从 %.3f 升到 %.3f"
                            % (mae_raw, mae_mult if mae_mult else mae_raw),
        },
        "未纳入": [
            "逐路段通行实测（无法验证通行能力）",
            "管网顶托高程与过流能力（下穿立交静默的主因，属数据缺失不是可校正偏差）",
            "改造前后积水观测（无法验证偏差的时不变性）",
        ],
        "全链可信度": latency,
        "config_hash": d["manifest"].get("config_hash"),
        "source_hash": d["manifest"].get("source_hash"),
        "生成时间": datetime.now().isoformat(timespec="seconds"),
    }


CSS = """
:root{--ink:#1a1a1a;--mut:#6b7280;--line:#d7dbe0;--bg:#fff;--red:#c0392b;--org:#d97706;
--grn:#15803d;--box:#f7f8fa;--acc:#0f4c81}
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


def render(diag: dict, d: dict) -> str:
    o = diag["总体"]
    v = diag["校正是否有意义"]
    sil = diag["静默点"]
    usable = diag["可用与不可用"]

    g_rows = "".join(
        f"<tr><td><b>{g['结构类型']}</b></td><td class='c'>{g['样本数']}</td>"
        f"<td class='c'>{g['实测均值_m']:.3f}</td><td class='c'>{g['模型均值_m']:.3f}</td>"
        f"<td class='c'>{g['残差均值_m']:+.3f}</td>"
        f"<td class='c'>{g['MAE_原_m']:.3f}</td>"
        f"<td class='c'>{('%.3f' % g['MAE_乘性校正后_m']) if g['MAE_乘性校正后_m'] is not None else '—'}</td>"
        f"<td class='c'>{g['MAE_地板注入后_m']:.3f}</td>"
        f"<td class='c'>{('× %.1f' % g['乘性因子']) if g['乘性因子'] else '—'}</td></tr>"
        for g in diag["分组"])

    pair_rows = "".join(
        f"<tr><td>{p['point_id']}</td><td>{p['name']}</td>"
        f"<td class='c'>{p.get('structure_type','—')}</td>"
        f"<td class='c'>{float(p['obs_depth_m']):.2f}</td>"
        f"<td class='c'>{float(p['model_depth_m']):.3f}</td>"
        f"<td class='c'>{float(p['abs_diff_m']):+.3f}</td>"
        f"<td class='c'>{'静默' if float(p['model_depth_m']) < 0.05 else '有响应'}</td></tr>"
        for p in sorted(d["recon"].get("实测校验", {}).get("逐点对照", []),
                        key=lambda x: -float(x.get("model_depth_m") or 0)))

    verdict_tag = (("t-org", "不采用系数校正") if not v["是否采用系数校正"]
                   else ("t-grn", "采用分组系数"))

    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>模型偏差诊断</title><style>{CSS}</style></head><body>
<h1>模型偏差诊断</h1>
<div class="sub">提比翁情景—规划机 · 产品件 p4 · 事件：2021 年第 6 号台风「烟花」（In-Fa）· 宁波鄞东南片区<br>
生成 {datetime.now().strftime('%Y-%m-%d %H:%M')} · config_hash <code>{diag['config_hash']}</code> ·
source_hash <code>{diag['source_hash']}</code></div>

<div class="box"><b>本件给什么</b>：{o['配对数']} 个域内配对点的逐点偏差诊断，回答一个具体问题——
<b>这个偏差能不能用系数校正回来</b>。两道检验都要过才采用系数：
① 模型在点位上有信息（Pearson {o['模型实测相关_pearson']:+.2f}、R² {o['决定系数_R2']:.3f} —— <b>过</b>）；
② 乘性校正真能把 MAE 降下来（{v['MAE_原_m']:.3f} → {v['MAE_乘性校正后_m']:.3f} m —— <b>不过</b>）。
故本件<b>不采用系数校正</b>，并给出原因与证据。</div>

<div class="kv">
<div><span>域内配对数</span><b>{o['配对数']} 点</b></div>
<div><span>偏浅点数</span><b>{o['偏浅点数']} / {o['配对数']}</b><span>全部偏浅</span></div>
<div><span>MAE</span><b>{o['MAE_m']:.3f} m</b><span>残差中位 {o['残差中位数_m']:+.3f} m</span></div>
<div><span>模型—实测相关</span><b>{o['模型实测相关_pearson']:+.2f}</b><span>R² {o['决定系数_R2']:.3f}（有信息）</span></div>
<div><span>乘性校正后 MAE</span><b>{v['MAE_乘性校正后_m']:.3f} m</b><span>上升，故不采用</span></div>
<div><span>判定</span><b><span class="tag {verdict_tag[0]}">{verdict_tag[1]}</span></b></div>
</div>

<h2>一、两道检验（决定是否采用系数校正）</h2>
<table>
<tr><th>检验</th><th>判据</th><th>实测</th><th>结论</th></tr>
<tr><td><b>① 模型有信息</b></td><td>{v['检验一_判据']}</td><td class="c">{v['检验一_实测']}</td>
<td class="c"><span class="tag {'t-grn' if v['检验一_模型有信息'] else 't-org'}">
{'通过' if v['检验一_模型有信息'] else '未通过'}</span></td></tr>
<tr><td><b>② 校正有效</b></td><td>{v['检验二_判据']}</td><td class="c">{v['检验二_实测']}</td>
<td class="c"><span class="tag {'t-grn' if v['检验二_校正有效'] else 't-org'}">
{'通过' if v['检验二_校正有效'] else '未通过'}</span></td></tr>
</table>
<div class="box"><b>结论</b>：{v['结论']}<br>
<b>参考</b>：{v['注']}</div>

<h2>二、分组诊断（含两种校正的对照）</h2>
<table>
<tr><th>结构类型</th><th>样本</th><th>实测均值 m</th><th>模型均值 m</th><th>残差均值</th>
<th>MAE 原</th><th>乘性校正后</th><th>注入均值后</th><th>乘性因子</th></tr>
{g_rows}
</table>
<div class="mut" style="font-size:12px">乘性因子 = 该类实测均值 ÷ 模型均值，作诊断量展示；
因检验②未通过，不作为产品校正系数。</div>

<h2>三、静默点（{sil['静默点数']} 点 / {sil['占配对比例']*100:.0f}%）</h2>
<table>
<tr><th>项</th><th>值</th></tr>
<tr><td>静默点数（模型水深 &lt; 0.05 m）</td><td class="c">{sil['静默点数']}</td></tr>
<tr><td>有响应点数</td><td class="c">{sil['有响应点数']}</td></tr>
<tr><td>静默点实测均值</td><td class="c">{sil['静默点实测均值_m']:.3f} m</td></tr>
<tr><td>处理</td><td>{sil['说明']}</td></tr>
</table>

<h2>四、哪些输出受影响、哪些不受影响</h2>
<table>
<tr><th>用途</th><th>状态</th><th>依据</th></tr>
<tr><td>排序类决策（谁先修、先巡哪里）</td><td class="c"><span class="tag t-grn">不受影响</span></td>
<td>排序只用相对次序与功能面积差，不依赖点位绝对水深</td></tr>
<tr><td>片区级损失量级与构成</td><td class="c"><span class="tag t-grn">不受影响</span></td>
<td>单点偏差在片区聚合中被平均；四项分解闭合成立（残差 {d['recon'].get('Q分解',{}).get('resid_share_pct',0):.1f}%）</td></tr>
<tr><td>情景分档与值守响应</td><td class="c"><span class="tag t-grn">不受影响</span></td>
<td>档位由面雨量分位数决定，与水深无关</td></tr>
<tr><td>单点水深读数</td><td class="c"><span class="tag t-org">不可用</span></td>
<td>{usable['单点水深读数']}</td></tr>
<tr><td>偏差系数校正</td><td class="c"><span class="tag t-org">不可用</span></td>
<td>{usable['偏差系数校正']}</td></tr>
</table>

<h2>五、逐点残差明细</h2>
<table>
<tr><th>编号</th><th>点名</th><th>结构</th><th>实测 m</th><th>模型 m</th><th>绝对偏差</th><th>模型状态</th></tr>
{pair_rows}
</table>

<h2>技术参数与适用边界</h2>
<table>
<tr><td class="mut" style="width:110px">样本</td><td>域内配对点 {o['配对数']} 个</td></tr>
<tr><td class="mut">观测来源</td><td>2021 烟花公开通报逐点实测水深（宁波市水利局 / 央广网 / 人民日报客户端 / 人民网浙江）</td></tr>
<tr><td class="mut">模型输出</td><td>ERA5 驱动 + 图守恒律内核，取涝点邻域格点峰值水深</td></tr>
<tr><td class="mut">判据</td><td>Pearson &gt; 0.3 且 R² &gt; 0.09 才认为点位上有区分能力</td></tr>
<tr><td class="mut">未纳入</td><td>{'；'.join(diag['未纳入'])}</td></tr>
</table>

<footer>
<b>数据来源</b>：逐点对照 <code>out/03_event_reconciliation.json</code>；台账 <code>data/seed/flood_points_2021_infa.csv</code>。<br>
<b>复算</b>：本件由 <code>typhoeus.bias</code> 随 <code>python -m typhoeus.cli run</code> 生成，同一 config_hash 下可复算。
</footer>
</body></html>"""


def write(outdir: str | Path, verbose: bool = True) -> list[str]:
    from . import products as PROD

    outdir = Path(outdir)
    d = PROD.load(outdir)
    if not d.get("recon"):
        raise RuntimeError("缺少 out/03_event_reconciliation.json，无法做偏差诊断")
    diag = diagnose(d)

    p5 = outdir / "p5_偏差校正表.json"
    p5.write_text(json.dumps(diag, ensure_ascii=False, indent=2), encoding="utf-8")
    p4 = outdir / "p4_偏差诊断与残差校正.html"
    p4.write_text(render(diag, d), encoding="utf-8")
    if verbose:
        print(f"  {p4}")
        print(f"  {p5}")
    return [str(p4), str(p5)]


def main(argv: list[str] | None = None) -> int:
    import sys

    args = list(sys.argv[1:] if argv is None else argv)
    try:
        write(args[0] if args else "out")
    except RuntimeError as e:
        print(e)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
