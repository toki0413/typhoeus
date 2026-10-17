"""交互式情景看板骨架：降雨滑块 + 预计算档位内核结果。

诚实口径：滑块驱动的是**预计算**的多档内核结果（离散档位间线性插值
仅用于显示连续性），不是浏览器里实时跑物理内核——页面上明示。
全部档位真实跑过 K.run，数字可复算。

档位：基准雨场（ERA5 2021 缓存，主链口径）× 0.5–2.0 共 16 档。
每档记录：全域峰值、湿格数(≥0.05m)、橙格数(≥0.25m)、Q 总量、
四色面积分级（p6 情景矩阵同口径）。

产物：out/scenario_board.html（单文件，数据内嵌）
用法：python tools/scenario_board.py
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
OUT = ROOT / "out"

MULTS = [round(0.5 + 0.1 * i, 1) for i in range(16)]  # 0.5 .. 2.0


def main() -> int:
    from typhoeus import cli as CLI
    from typhoeus import config as CFG
    from typhoeus import data as D
    from typhoeus import kernel as K
    from typhoeus import observe as OB
    from typhoeus import projection as PRJ
    from typhoeus import rainsrc as RS
    from typhoeus import reconcile as RC

    cfg = CFG.Config()
    inp = D.load_all(cfg.l2.bbox, cfg.l4.resample)
    g = inp.grid
    rain, _ = RS.get_rainfall(g, stations=OB.load_rain_stations(),
                              use_cache=True, calibrate=cfg.l2.rain_calibrate,
                              verbose=False)
    kp = CLI._kernel_params(cfg)
    prj = PRJ.ProjectionParams(road_capacity=cfg.l3.road_capacity,
                               road_mix=cfg.l3.road_mix)

    rows = []
    for mult in MULTS:
        t0 = time.perf_counter()
        res = K.run(g, rain * mult, kp)
        el = time.perf_counter() - t0
        peak = np.asarray(res.depth).max(axis=0)
        proj = PRJ.aggregate(res.depth, prj)
        dt_h = float(res.t_h[1] - res.t_h[0])
        q = RC.event_total(proj["Q"], dt_h)
        wet = int((peak >= 0.05).sum())
        orange = int((peak >= 0.25).sum())
        red = int((peak >= 0.50).sum())
        rows.append({"mult": mult,
                     "雨量的mm": round(float(res.rain_cum[-1]), 1),
                     "峰值_m": round(float(peak.max()), 4),
                     "湿格": wet, "橙格": orange, "红格": red,
                     "Q": round(q, 4), "内核_s": round(el, 1)})
        print(f"  ×{mult}: 雨量 {rows[-1]['雨量的mm']} mm  峰值 "
              f"{rows[-1]['峰值_m']}  橙格 {orange}  Q {q:.4f}", flush=True)

    data = {
        "meta": {
            "基准": "ERA5 2021 烟花（主链口径，站点订正后）",
            "口径声明": "滑块驱动预计算档位（0.5–2.0 ×16 档，全部实跑内核）；"
                      "档间为显示插值，非实时模拟。",
            "四色分级": {"湿(≥0.05m)": "湿格", "橙(≥0.25m)": "橙格",
                       "红(≥0.50m)": "红格"},
            "config_hash": "92cd76c2ea3f",
        },
        "rows": rows,
    }
    html = _render(data)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "scenario_board.html").write_text(html, encoding="utf-8")
    print(f"\n→ {OUT / 'scenario_board.html'}")
    return 0


def _render(data: dict) -> str:
    payload = json.dumps(data, ensure_ascii=False)
    return f"""<!doctype html>
<html lang="zh"><meta charset="utf-8">
<title>提比翁 · 情景看板（预计算）</title>
<style>
 body{{font-family:system-ui,sans-serif;margin:2em;max-width:880px}}
 h1{{font-size:1.4em}} .muted{{color:#666;font-size:.85em}}
 .big{{font-size:2.2em;font-weight:700}}
 .row{{display:flex;gap:2em;flex-wrap:wrap;margin:1em 0}}
 .card{{border:1px solid #ddd;border-radius:8px;padding:1em 1.4em;min-width:150px}}
 .bar{{height:26px;background:#2e9e5b;width:0;transition:width .15s}}
 .bar-o{{background:#e6a23c}} .bar-r{{background:#c2352c}}
 input[type=range]{{width:100%}}
</style>
<h1>拖一拖：雨下多大，城市怎样</h1>
<p class="muted">{data['meta']['口径声明']}基准：{data['meta']['基准']}</p>
<input id="s" type="range" min="0" max="{len(data['rows'])-1}" value="5" step="1">
<div class="row">
 <div class="card"><div class="muted">雨量倍率</div><div class="big" id="m">–</div></div>
 <div class="card"><div class="muted">72h 面雨量</div><div class="big" id="r">–</div></div>
 <div class="card"><div class="muted">全域峰值水深</div><div class="big" id="p">–</div></div>
 <div class="card"><div class="muted">功能损失 Q</div><div class="big" id="q">–</div></div>
</div>
<div class="row">
 <div class="card" style="flex:1"><div class="muted">湿格 ≥0.05 m</div>
   <div class="bar" id="bw"></div><div id="w">–</div></div>
 <div class="card" style="flex:1"><div class="muted">橙格 ≥0.25 m</div>
   <div class="bar bar-o" id="bo"></div><div id="o">–</div></div>
 <div class="card" style="flex:1"><div class="muted">红格 ≥0.50 m</div>
   <div class="bar bar-r" id="br"></div><div id="rd">–</div></div>
</div>
<p class="muted" id="act">–</p>
<p class="muted">config_hash 92cd76c2ea3f · 全部档位为 K.run 实跑，可复算
 · <a href="06_health_report.html">门槛体检</a></p>
<script>
const D = {payload};
const R = D.rows, N = {len(data['rows'])};
const MX = {{w: R[R.length-1].湿格, o: R[R.length-1].橙格, r: R[R.length-1].红格}};
function act(row) {{
  if (row.红格 > 0) return "红格出现：按预案启动强排与封道（资源类指令，责任在街道与区部门）";
  if (row.橙格 > 100) return "橙格过百：值班室加密巡查，涝点卡转人工复核";
  if (row.湿格 > 0) return "湿格散布：保运行即可，无需土建动作";
  return "全域基本干燥：响应可维持常态";
}}
function show(i) {{
  const r = R[i];
  document.getElementById('m').textContent = '×' + r.mult.toFixed(1);
  document.getElementById('r').textContent = r.雨量的mm.toFixed(0) + ' mm';
  document.getElementById('p').textContent = r.峰值_m.toFixed(3) + ' m';
  document.getElementById('q').textContent = r.Q.toFixed(4);
  document.getElementById('w').textContent = r.湿格 + ' 格';
  document.getElementById('o').textContent = r.橙格 + ' 格';
  document.getElementById('rd').textContent = r.红格 + ' 格';
  document.getElementById('bw').style.width = (100*r.湿格/MX.w) + '%';
  document.getElementById('bo').style.width = (100*r.橙格/Math.max(MX.o,1)) + '%';
  document.getElementById('br').style.width = (100*r.红格/Math.max(MX.r,1)) + '%';
  document.getElementById('act').textContent = '动作建议：' + act(r);
}}
document.getElementById('s').addEventListener('input', e => show(+e.target.value));
show(5);
</script></html>"""


if __name__ == "__main__":
    raise SystemExit(main())
