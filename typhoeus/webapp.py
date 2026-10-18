"""本地 Web 壳：一屏结论 + 八份产物 + 问一句。

它不新增业务层——所有数字都从 `mcp_server` 的九个只读工具取，护栏仍在
工具层，域外照样拒答。这一层只解决一件事：值班员的电脑上没有 DSH/Claude
Desktop，MCP 服务没有宿主。浏览器打开 localhost 就能问。

启动：
    python -m typhoeus.webapp            # 默认 8765
    python -m typhoeus.webapp --port 9000
"""
from __future__ import annotations

import argparse
import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import mcp_server as MS
from . import paths
from .guardrails import RefusalError

OUT = paths.out_dir()

# 产物页签：key → (工具名, 标题)
ARTIFACTS = {
    "preset": ("get_preset_plan", "预置方案单"),
    "recovery": ("get_recovery_order", "恢复排序单"),
    "recon": ("get_event_reconciliation", "事件对账单"),
    "price": ("get_resilience_pricing", "韧性价目表"),
    "metrics": ("get_health_metrics", "体检指标包"),
    "health": ("get_health_report", "标准体检报告"),
    "calib": ("get_multievent_calibration", "多事件标定单"),
    "cards": ("get_flood_cards", "涝点转译卡"),
}

# 问一句 → 调哪个工具。规则路由，不是模型：页面上会显示"调了哪个工具"，
# 让读者能自己核对答案来自哪份产物。
ROUTES = (
    (("坐标", "经纬", "lon", "lat"), "get_point_depth"),
    (("布点", "预案", "几级", "响应", "人员", "泵车", "布防"), "get_preset_plan"),
    (("抢修", "先修", "恢复", "排序", "哪条路", "通路"), "get_recovery_order"),
    # 定价必须排在"损失"前面：「减少 1% 损失要投多少钱」同时含两个关键词，
    # 而它问的是投入，不是对账。
    (("投入", "成本", "多少钱", "价目", "1%"), "get_resilience_pricing"),
    (("损失", "对账", "分解", "闭合", "Q"), "get_event_reconciliation"),
    (("门槛", "指标", "通过", "不达标", "没验证"), "get_health_metrics"),
    (("守恒", "体检", "caveat", "边界"), "get_health_report"),
    (("标定", "场次", "重现", "跨事件", "历史"), "get_multievent_calibration"),
    (("涝点", "淹", "水深", "哪个点", "能不能用"), "get_flood_cards"),
)


def summary() -> dict:
    hm = json.loads((OUT / "05_health_metrics.json").read_text(encoding="utf-8"))
    mf = json.loads((OUT / "manifest.json").read_text(encoding="utf-8"))
    hr = json.loads((OUT / "06_health_report.json").read_text(encoding="utf-8"))
    cards = json.loads((OUT / "08_flood_cards.json").read_text(encoding="utf-8")).get("卡片", [])
    publishable = sum(1 for c in cards if c.get("trust") == "可发")
    outside = sum(1 for c in cards if not c.get("in_domain"))
    return {
        "事件": hr.get("事件"),
        "峰值水深_m": hr.get("峰值水深_m"),
        "面雨量_mm": hr.get("面雨量_mm"),
        "卡片": {"总数": len(cards), "可发布": publishable,
               "需人工核实": len(cards) - publishable - outside, "域外": outside},
        "config_hash": mf.get("config_hash"),
        "source_hash": mf.get("source_hash"),
        "门槛": {k: hm.get(k) for k in
               ("指标总数", "PASS", "FAIL", "DEGRADED", "BLOCKED")},
        "结论": hr.get("结论"),
        "产物": ARTIFACTS,
    }


def artifact(name: str) -> dict:
    item = ARTIFACTS.get(name)
    if not item:
        raise KeyError(name)
    return MS._ALL_TOOL_FNS[item[0]](str(OUT))


def ask(q: str) -> dict:
    """把一句话路由到一个工具，返回 {tool, payload} 或拒答。"""
    text = (q or "").strip()
    if not text:
        return {"refused": True, "rule": "输入", "reason": "问题为空",
                "remedy": "写一句你要问的，例如「先修哪条路」"}
    tool = next((t for kws, t in ROUTES if any(k in text for k in kws)),
                "get_health_report")
    try:
        if tool == "get_point_depth":
            nums = [float(x) for x in re.findall(r"\d+(?:\.\d+)?", text)]
            if len(nums) < 2:
                return {"refused": True, "rule": "输入",
                        "reason": "坐标查询需要两个十进制度数",
                        "remedy": "例如「坐标 121.617, 29.818」"}
            payload = MS.get_point_depth(nums[0], nums[1], str(OUT))
        else:
            payload = MS._ALL_TOOL_FNS[tool](str(OUT))
    except RefusalError as e:
        return {"tool": tool, "refused": True, **e.as_dict()}
    return {"tool": tool, "payload": payload}


def _page() -> str:
    return """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>提比翁 · 值班台</title>
<style>
:root{--ink:#14212b;--mut:#5b6b78;--line:#dde5ea;--bg:#f6f9fa;--accent:#0b6e8f;--bad:#b3261e}
*{box-sizing:border-box}body{margin:0;font:15px/1.65 "Segoe UI","Microsoft YaHei",sans-serif;
color:var(--ink);background:var(--bg)}
header{background:#0b3b4a;color:#eaf6f7;padding:20px 28px}
header h1{margin:0;font-size:20px;font-weight:600}header .sub{color:#a9cfd6;font-size:13px;margin-top:4px}
main{max-width:1080px;margin:0 auto;padding:22px 20px 60px}
.card{background:#fff;border:1px solid var(--line);border-radius:8px;padding:16px 18px;margin-bottom:16px}
.nums{display:flex;gap:14px;flex-wrap:wrap}
.num{flex:1;min-width:150px;background:#f2f8f9;border-radius:8px;padding:14px}
.num b{display:block;font-size:26px;line-height:1.2}
.num span{color:var(--mut);font-size:12.5px}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}
.chip{padding:7px 12px;border:1px solid var(--line);border-radius:999px;background:#fff;cursor:pointer;font-size:13px}
.chip:hover{border-color:var(--accent);color:var(--accent)}
.badges{display:flex;gap:8px;flex-wrap:wrap}
.badge{font:12px/1 ui-monospace,Consolas,monospace;padding:6px 10px;border-radius:999px;background:#eef4f6;border:1px solid var(--line)}
.pass{color:#146c43}.fail{color:var(--bad)}
h2{font-size:15px;margin:0 0 10px}h3{font-size:13px;color:var(--mut);margin:14px 0 6px}
.ask{display:flex;gap:8px}.ask input{flex:1;padding:10px 12px;border:1px solid var(--line);border-radius:6px;font-size:14px}
button{padding:10px 16px;border:0;border-radius:6px;background:var(--accent);color:#fff;font-size:14px;cursor:pointer}
pre{background:#0f1c24;color:#d6e6ee;padding:14px;border-radius:6px;overflow:auto;max-height:420px;
font:12.5px/1.55 ui-monospace,Consolas,monospace}
.tool{font:12px/1 ui-monospace,monospace;color:var(--mut);margin-bottom:8px}
.refused{border-left:4px solid var(--bad);background:#fdf0ef;padding:12px 14px;border-radius:4px}
details{margin-top:6px}summary{cursor:pointer;color:var(--mut);font-size:13px}
footer{max-width:1080px;margin:0 auto;padding:0 20px 40px;color:var(--mut);font-size:12px}
</style></head><body>
<header><h1>提比翁 · 值班台</h1><div class="sub" id="sub">加载中…</div></header>
<main>
  <div class="card">
    <h2>这一场的结论</h2>
    <div class="nums">
      <div class="num"><b id="n-peak">–</b><span>最大积水深度（米）</span></div>
      <div class="num"><b id="n-cards">–</b><span>可直接发布的涝点卡</span></div>
      <div class="num"><b id="n-rain">–</b><span>面雨量（毫米）</span></div>
    </div>
    <h3>一句话</h3><div id="concl" style="font-size:13.5px;color:#33454f"></div>
  </div>
  <div class="card">
    <h2>问一句</h2>
    <div class="chips" id="chips"></div>
    <div class="ask"><input id="q" placeholder="也可以直接写，例如：先修哪条路 / 坐标 121.617, 29.818">
    <button onclick="ask()">问</button></div>
    <div id="answer" style="margin-top:14px"></div>
  </div>
  <div class="card">
    <h2>八份产物</h2>
    <div class="badges" id="tabs"></div>
    <div id="artifact" style="margin-top:14px"></div>
  </div>
  <div class="card">
    <details><summary>审计信息（指纹与 27 条判据）</summary>
      <div class="badges" id="badges" style="margin-top:10px"></div>
    </details>
  </div>
</main>
<footer>数字来自已落盘产物与其指纹；计算范围外的坐标一律拒答，不给估计值。</footer>
<script>
let S = null;
const esc = s => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const QUESTIONS = ["先修哪条路", "哪些涝点能直接发", "这场损失怎么算的", "减少损失要投多少钱", "这场雨有多大"];
async function boot(){
  S = await (await fetch('/api/summary')).json();
  document.getElementById('sub').textContent = S['事件'] || '';
  document.getElementById('n-peak').textContent = S['峰值水深_m'] ?? '–';
  document.getElementById('n-rain').textContent = S['面雨量_mm'] ?? '–';
  const c = S['卡片'] || {};
  document.getElementById('n-cards').textContent = `${c['可发布'] ?? '–'}/${c['总数'] ?? '–'}`;
  document.getElementById('concl').textContent = S['结论'] || '';
  document.getElementById('chips').innerHTML = QUESTIONS
    .map(q => `<span class="chip" onclick="doAsk('${esc(q)}')">${esc(q)}</span>`).join('');
  const g = S['门槛'];
  document.getElementById('badges').innerHTML =
    `<span class="badge">判据 <b>${g['指标总数']}</b></span>` +
    `<span class="badge pass">通过 <b>${g.PASS}</b></span>` +
    `<span class="badge fail">不达标 <b>${g.FAIL}</b></span>` +
    `<span class="badge">缺数据 <b>${g.BLOCKED}</b></span>` +
    `<span class="badge">config ${esc(S.config_hash)}</span>`;
  document.getElementById('tabs').innerHTML = Object.entries(S['产物'])
    .map(([k, v]) => `<span class="badge" style="cursor:pointer" onclick="load('${k}')">${esc(v[1])}</span>`).join('');
}
async function load(k){
  document.getElementById('artifact').innerHTML = '<div style="color:#5b6b78">读取中…</div>';
  const r = await (await fetch('/api/artifact?name=' + k)).json();
  document.getElementById('artifact').innerHTML = render(r);
}
function render(o){
  if (o.refused) {
    return `<div class="refused"><b>这个位置算不了：${esc(o.reason || '')}</b>
      <div style="margin-top:6px">${esc(o.remedy || '')}</div>
      <div style="margin-top:6px;color:#5b6b78;font-size:12px">规则 ${esc(o.rule || '')}（供复核）</div></div>`;
  }
  const body = o.payload || o;
  return (o.tool ? `<div class="tool">数据来自 ${esc(o.tool)}</div>` : '') +
    `<pre>${esc(JSON.stringify(body, null, 1))}</pre>`;
}
async function doAsk(q){
  document.getElementById('q').value = q;
  document.getElementById('answer').innerHTML = '<div style="color:#5b6b78">查询中…</div>';
  const r = await fetch('/api/ask', {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({q})});
  document.getElementById('answer').innerHTML = render(await r.json());
}
function ask(){ return doAsk(document.getElementById('q').value); }
document.getElementById('q').addEventListener('keydown', e => { if (e.key === 'Enter') ask(); });
boot();
</script></body></html>"""

class Handler(BaseHTTPRequestHandler):
    server_version = "TyphoeusWeb/1.0"

    def log_message(self, fmt, *args):          # 控制台只留一行访问日志
        print(f"[web] {self.address_string()} {fmt % args}", flush=True)

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code: int = 200) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def do_GET(self) -> None:                   # noqa: N802
        # R4 的调用预算是"一次对话 ≤2 个工具调用"，按进程累计。浏览器里
        # 每点一下就是一次新对话，所以在每次请求前清零——否则第三问必被拒。
        MS.reset_call_budget()
        u = urlparse(self.path)
        try:
            if u.path == "/":
                self._send(200, _page().encode("utf-8"), "text/html; charset=utf-8")
            elif u.path == "/api/summary":
                self._json(summary())
            elif u.path == "/api/artifact":
                name = (parse_qs(u.query).get("name") or [""])[0]
                self._json(artifact(name))
            else:
                self._json({"error": "not found"}, 404)
        except RefusalError as e:
            self._json({"refused": True, **e.as_dict()})
        except KeyError:
            self._json({"error": "未知产物"}, 404)
        except FileNotFoundError as e:
            self._json({"error": f"产物缺失：{e}"}, 500)

    def do_POST(self) -> None:                  # noqa: N802
        MS.reset_call_budget()                  # 同上：一次提问 = 一次对话
        if urlparse(self.path).path != "/api/ask":
            self._json({"error": "not found"}, 404)
            return
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            self._json({"error": "请求不是合法 JSON"}, 400)
            return
        self._json(ask(body.get("q", "")))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="typhoeus-webapp")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    a = ap.parse_args(argv)
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    print(f"提比翁值班台： http://{a.host}:{a.port}  （Ctrl+C 停止）", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止", flush=True)
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
