/* 生成评审材料：一页纸、四张模型生命卡、声音对照说明。
 * 数据全部来自线上 /api/research/model-lives 与 /api/research/replicate。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire('/workspace/commons/package.json');
const puppeteer = require('puppeteer-core');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ASSETS = path.join(HERE, 'assets');
const CHROME = process.env.CHROME_PATH
  || '/root/.cache/puppeteer/chrome/linux-155.0.8059.39/chrome-linux64/chrome';
const URL = 'https://37jalf2ykndtrfn6iou.traesite.cn';
const DEPLOY = 'dep_6af73eb2f7d7881f2f484d05';
const DATA = JSON.parse(fs.readFileSync(path.join(ASSETS, 'model-data.json'), 'utf8'));

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = (v, d = 1) => `${(Number(v) * 100).toFixed(d)}%`;
const num = (v, d = 2) => Number(v).toFixed(d);
const img = (id) => `assets/${id}.png`;
const targetImg = (id) => `assets/${id}.png`;

const PATTERN_CN = { spots: '斑点', stripes: '条纹', mixed: '混合', blank: '空白' };
const ENGINE_CN = { grayScott: 'GRAY–SCOTT', lengyelEpstein: 'LENGYEL–EPSTEIN' };
const CHECK_CN = {
  pattern: '模式', density: '密度', anisotropyMax: '各向异性上限',
  anisotropyMin: '各向异性下限', stabilize: '稳定步数', score: '分数',
};

function scoreClass(score) {
  if (score >= 90) return 'high';
  if (score >= 50) return 'mid';
  return 'low';
}

function sparkline(samples) {
  if (!samples?.length) return '';
  const maxD = Math.max(...samples.map((s) => s.density), 0.01);
  const x = (i) => (i / (samples.length - 1)) * 100;
  const yD = (v) => 26 - (v / maxD) * 22;
  const yA = (v) => 26 - Math.min(1, v) * 22;
  const pd = samples.map((s, i) => `${x(i).toFixed(2)},${yD(s.density).toFixed(2)}`).join(' ');
  const pa = samples.map((s, i) => `${x(i).toFixed(2)},${yA(s.anisotropy).toFixed(2)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
    <line x1="0" y1="26" x2="100" y2="26" stroke="rgba(23,21,18,.18)" stroke-width=".5"/>
    <line x1="0" y1="15" x2="100" y2="15" stroke="rgba(23,21,18,.08)" stroke-width=".5"/>
    <polyline points="${pd}" fill="none" stroke="#b7362a" stroke-width="1.4" vector-effect="non-scaling-stroke"/>
    <polyline points="${pa}" fill="none" stroke="#6b6a4f" stroke-width=".9" stroke-dasharray="2 2" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

function checkBadge(c) {
  const actual = c.key === 'density' || c.key === 'anisotropyMax' || c.key === 'anisotropyMin'
    ? pct(c.actual, c.actual < 0.01 ? 2 : 1)
    : c.key === 'score' ? `${Number(c.actual).toFixed(1)}` : String(c.actual);
  return `<span class="check ${c.ok ? 'ok' : 'bad'}">${c.ok ? '✓' : '×'} ${CHECK_CN[c.key] || c.key} ${esc(actual)}</span>`;
}

function paramRows(model) {
  const p = model.params || {};
  const keys = ['f', 'k', 'D_u', 'D_v', 'a', 'b', 'sigma', 'dt'];
  const labels = { f: 'f', k: 'k', D_u: 'D_u', D_v: 'D_v', a: 'a', b: 'b', sigma: 'σ', dt: 'dt' };
  return keys.filter((k) => p[k] !== undefined)
    .map((k) => `<div class="kv"><span>${labels[k]}</span><b>${esc(p[k])}</b></div>`).join('');
}

function onePager() {
  const cards = DATA.map(({ model, result }, i) => `
    <figure class="pat">
      <img src="${targetImg(model.targetId)}" alt="${esc(model.short)}">
      <figcaption><b>0${i + 1} · ${esc(model.short)}</b><span>${Number(result.score).toFixed(1)} / 100 · ${PATTERN_CN[result.behavior?.pattern] || result.behavior?.pattern || '—'}</span></figcaption>
    </figure>`).join('');
  const rows = DATA.map(({ model, result }) => `
    <tr><td>${esc(model.short)}</td><td class="mono">${Number(result.score).toFixed(1)}</td><td>${PATTERN_CN[result.behavior?.pattern] || '—'}</td><td class="mono">${result.behavior?.stabilizeSteps ?? '—'}</td></tr>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  @page{size:A4;margin:0}
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;background:#f4efe5;color:#171512}
  body{font-family:"Noto Sans CJK SC","Noto Sans CJK",sans-serif;font-size:8.2pt;line-height:1.55}
  .page{width:210mm;height:297mm;padding:12mm 14mm 9mm;display:flex;flex-direction:column;gap:5mm;overflow:hidden;position:relative}
  .page:before{content:"";position:absolute;left:0;top:0;width:100%;height:2.4mm;background:#b7362a}
  .hero{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:1.4pt solid #171512;padding-bottom:4mm}
  .kicker{font-family:"Noto Sans Mono","DejaVu Sans Mono",monospace;font-size:6.8pt;letter-spacing:.18em;text-transform:uppercase;color:#6b6a4f;margin-bottom:3mm}
  h1{font-family:"Noto Serif CJK SC","Noto Serif CJK",serif;font-size:31pt;line-height:1.06;margin:0 0 3mm;letter-spacing:-.6pt;font-weight:600}
  h1 em{font-style:normal;color:#b7362a}
  .lede{margin:0;max-width:122mm;font-size:8.4pt;line-height:1.65;color:#3d3a33}
  .hero-meta{display:flex;gap:2mm;margin-top:3.5mm;flex-wrap:wrap}
  .hero-meta span{border:.6pt solid #171512;padding:1mm 2.2mm;font-family:"Noto Sans Mono",monospace;font-size:6.4pt;letter-spacing:.06em}
  .qr{text-align:center;flex:0 0 31mm}
  .qr img{width:29mm;height:29mm;display:block;margin:0 auto 1.5mm;border:.6pt solid #171512;background:#f4efe5}
  .qr div{font-size:6.2pt;line-height:1.4;color:#4a463d}
  .qr b{display:block;font-family:"Noto Sans Mono",monospace;font-size:5.5pt;font-weight:500;word-break:break-all}
  .patterns{display:grid;grid-template-columns:repeat(4,1fr);gap:3mm}
  .pat{margin:0;border:.7pt solid #171512;background:#171512;overflow:hidden}
  .pat img{width:100%;aspect-ratio:1;object-fit:cover;display:block;filter:contrast(1.02)}
  .pat figcaption{background:#f4efe5;padding:1.8mm 2mm;display:flex;justify-content:space-between;gap:2mm;align-items:baseline}
  .pat figcaption b{font-size:7pt;font-weight:600}
  .pat figcaption span{font-family:"Noto Sans Mono",monospace;font-size:5.8pt;color:#6b6a4f;white-space:nowrap}
  .cols{display:grid;grid-template-columns:1.06fr .98fr 1.08fr;border-top:1pt solid #171512;border-bottom:1pt solid #171512}
  .col{padding:4mm 4.5mm;border-right:.6pt solid rgba(23,21,18,.22)}
  .col:last-child{border-right:0}
  .col h2{font-family:"Noto Serif CJK SC",serif;font-size:12.2pt;line-height:1.25;margin:0 0 1.5mm;font-weight:600}
  .col h2 span{font-family:"Noto Sans Mono",monospace;font-size:6.2pt;color:#b7362a;letter-spacing:.12em;margin-right:1.5mm}
  .col p{margin:0 0 2.2mm;color:#3d3a33;font-size:7.6pt}
  .row{display:flex;gap:2mm;margin:0 0 1.5mm;font-size:7.5pt}
  .row i{font-style:normal;font-family:"Noto Sans Mono",monospace;font-size:5.9pt;color:#b7362a;padding-top:.5mm;min-width:5mm}
  .chips{display:flex;flex-wrap:wrap;gap:1.2mm;margin-top:2mm}
  .chips span{border:.5pt solid #171512;padding:.8mm 1.8mm;font-size:6.6pt;background:rgba(255,255,255,.25)}
  .map{display:grid;grid-template-columns:1fr 1fr;gap:1.2mm 2mm;margin:1mm 0 2mm}
  .map div{border-bottom:.5pt solid rgba(23,21,18,.16);padding-bottom:1mm;font-size:7.2pt}
  .map b{color:#b7362a;font-weight:600}
  .quote{margin:2mm 0 0;padding:2mm 2.5mm;border-left:2pt solid #b7362a;background:rgba(183,54,42,.06);font-size:7.2pt;line-height:1.55;color:#3d3a33}
  table{width:100%;border-collapse:collapse;margin:1mm 0 2mm;font-size:7pt}
  th,td{text-align:left;border-bottom:.5pt solid rgba(23,21,18,.16);padding:1.25mm 0}
  th{font-family:"Noto Sans Mono",monospace;font-size:5.8pt;color:#6b6a4f;font-weight:500;text-transform:uppercase}
  td.mono,th.mono{font-family:"Noto Sans Mono",monospace}
  .code{font-family:"Noto Sans Mono",monospace;font-size:6.2pt;line-height:1.55;background:rgba(23,21,18,.055);border:.5pt solid rgba(23,21,18,.14);padding:2mm;word-break:break-all}
  .code b{color:#b7362a;font-weight:500}
  .bottom{display:grid;grid-template-columns:1.18fr 1fr;gap:7mm;margin-top:auto}
  .route{display:flex;align-items:center;gap:2.2mm;flex-wrap:wrap;border-top:.6pt solid rgba(23,21,18,.25);border-bottom:.6pt solid rgba(23,21,18,.25);padding:1.6mm 0;font-size:6.7pt;color:#3d3a33}
  .route b{font-family:"Noto Sans Mono",monospace;font-size:5.8pt;letter-spacing:.12em;color:#b7362a;text-transform:uppercase;margin-right:1mm}
  .route span{white-space:nowrap}
  .route span:not(:last-child):after{content:"→";color:#b7362a;margin-left:2.2mm}
  .bottom h3{font-family:"Noto Sans Mono",monospace;font-size:6.2pt;letter-spacing:.14em;color:#6b6a4f;text-transform:uppercase;margin:0 0 1.5mm;font-weight:500}
  .bottom p{margin:0 0 1.2mm;font-size:7.2pt;color:#3d3a33}
  .bottom b{color:#171512}
  footer{display:flex;justify-content:space-between;align-items:baseline;border-top:.8pt solid #171512;padding-top:2mm;font-family:"Noto Sans Mono",monospace;font-size:5.8pt;color:#6b6a4f}
  .accent{color:#b7362a}
  </style></head><body><main class="page">
  <header class="hero">
    <div class="hero-copy">
      <div class="kicker">COMMONS 公地 · 人工生命生成系统 · 评审材料 · 2026.11</div>
      <h1>让涌现<br><em>可见、可听、可复现</em></h1>
      <p class="lede">康威生命游戏、Lenia 与反应扩散，三种规则系统在同一个培育台里生长。系统持续识别滑翔、振荡、合并、分裂、出生与死亡潮，把它们转译成声音事件；配方由基因、环境与种子固定，同一配方生成同一段演化。</p>
      <div class="hero-meta"><span>WEB 应用</span><span>无需登录</span><span>HTTPS 公开</span><span>桌面 Chrome / Edge</span></div>
    </div>
    <div class="qr"><img src="assets/commons-qr.png" alt="体验入口二维码"><div>扫码进入<br><b>${URL.replace('https://', '')}</b></div></div>
  </header>

  <section class="patterns">${cards}</section>

  <section class="cols">
    <div class="col">
      <h2><span>01</span>三种规则，同一件事</h2>
      <p>复杂结构不必被直接设计，它可以从局部规则里长出来。</p>
      <div class="row"><i>CA</i><div>康威生命游戏：滑翔机、振荡器、稳定块。</div></div>
      <div class="row"><i>CF</i><div>Lenia 连续场：边界更柔和，群落会呼吸。</div></div>
      <div class="row"><i>RD</i><div>反应扩散：斑点、条纹与螺旋自行生成。</div></div>
      <div class="chips"><span>培育台</span><span>挑战</span><span>花园</span><span>家谱</span></div>
      <p style="margin-top:2mm">一个生命，两种玩法：培育是主线，挑战给出目标形态，作为模式练习。</p>
    </div>
    <div class="col">
      <h2><span>02</span>声音是观测通道</h2>
      <div class="map">
        <div><b>密度</b> → 音量</div><div><b>熵</b> → 音色亮度</div>
        <div><b>活跃度</b> → 节奏</div><div><b>周期性</b> → 节拍规律</div>
      </div>
      <p>五声音阶量化，把连续状态收进可听音集；十一个声部可单独换音色、调声像、加混响。</p>
      <p>双耳对比：同一颗种子放进两个环境，左右耳各听一个，其余条件固定，差异直接显现。</p>
      <div class="quote">声音不是配乐，是把结构变化转成可听事件；参与者据此比较不同环境下的演化。</div>
    </div>
    <div class="col">
      <h2><span>03</span>可复现，才可比较</h2>
      <table><thead><tr><th>模型生命</th><th class="mono">分数</th><th>行为</th><th class="mono">稳定</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="code"><b>GET</b> /api/research/model-lives<br><b>POST</b> /api/research/replicate<br>{"modelId":"model-gs-spots"}</div>
      <p style="margin-top:2mm">服务端按模型卡固定参数与种子重跑；神经代理只排序，最终分数由重跑确认。</p>
      <p>榜单写入外部存储，实例重启不丢；未配置时如实返回 <span class="mono">ephemeral</span>。</p>
    </div>
  </section>

  <div class="route"><b>3 分钟路线</b><span>首页听声音</span><span>随机孵化</span><span>分裂</span><span>存入花园</span><span>挑战</span><span>模型复现</span><span>家谱</span></div>

  <section class="bottom">
    <div>
      <h3>Honest boundary · 诚实边界</h3>
      <p><b>评分是结构统计相似，不是参数反演。</b>不宣称恢复真实生物参数，也不宣称复现实验的全部动力学。</p>
      <p>模型卡只描述结构统计与行为指纹；代理不是裁判，隐藏测试集 Top-3 召回 95%（GS）/ 98.5%（LE）。</p>
    </div>
    <div>
      <h3>Stack · 技术栈</h3>
      <p>Canvas 2D · Web Audio API · Node.js 20 · 确定性种子 · 外部 JSON 存储 · 降阶 MLP 代理 · Node test runner</p>
      <p><b>测试 43/43</b> · 构建 442.7 KB · 部署 <span class="mono">${DEPLOY}</span></p>
    </div>
  </section>

  <footer><span>COMMONS 公地 · 让涌现成为可观察、可分类、可比较的具体现象</span><span>${URL}</span></footer>
  </main></body></html>`;
}

function cardPage({ model, result }, index) {
  const score = Number(result.score).toFixed(1);
  const behavior = result.behavior || {};
  const checks = (result.checks || []).map(checkBadge).join('');
  const samples = behavior.samples || [];
  const targetLabel = model.target?.label || model.targetId;
  const tf = result.targetFeatures || {};
  const cf = result.features || {};
  const cnt = (v) => Math.round((v || 0) * model.target?.w * model.target?.h || (v || 0) * 64 * 64);
  const per = (v) => (v ? String(v) : '—');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  @page{size:A5;margin:0}
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;background:#f4efe5;color:#171512}
  body{font-family:"Noto Sans CJK SC","Noto Sans CJK",sans-serif;font-size:8.2pt;line-height:1.55}
  .card{width:148mm;height:210mm;padding:10mm 10.5mm 8mm;display:flex;flex-direction:column;gap:3.2mm;background:#f4efe5;position:relative;overflow:hidden}
  .card:before{content:"";position:absolute;left:0;top:0;width:3mm;height:100%;background:#b7362a}
  header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:1.2pt solid #171512;padding-bottom:2.5mm;padding-left:2mm}
  .no{font-family:"Noto Sans Mono",monospace;font-size:6.2pt;letter-spacing:.14em;color:#6b6a4f}
  .engine{font-family:"Noto Sans Mono",monospace;font-size:6.2pt;border:.5pt solid #171512;padding:.8mm 1.8mm;margin-top:1.5mm}
  .score{font-family:"Noto Serif CJK SC",serif;font-size:27pt;line-height:1;font-weight:600;text-align:right}
  .score small{font-family:"Noto Sans Mono",monospace;font-size:7pt;color:#6b6a4f;font-weight:400}
  .score.high{color:#2f6b45}.score.mid{color:#9a6a1f}.score.low{color:#b7362a}
  h2{font-family:"Noto Serif CJK SC",serif;font-size:19pt;line-height:1.15;margin:0;padding-left:2mm;font-weight:600}
  .desc{margin:0;padding-left:2mm;font-size:7.8pt;color:#3d3a33;min-height:9mm}
  .body{display:grid;grid-template-columns:62mm 1fr;gap:4mm;padding-left:2mm;flex:1}
  figure{margin:0}
  figure img{width:62mm;height:62mm;object-fit:cover;display:block;border:.7pt solid #171512;background:#171512}
  figcaption{font-size:5.8pt;color:#6b6a4f;line-height:1.35;margin-top:1mm}
  .read{font-size:6.1pt;line-height:1.45;color:#5a554a;margin:1.5mm 0 0}
  .read b{color:#171512;font-family:"Noto Sans Mono",monospace;font-size:5.4pt;letter-spacing:.08em;text-transform:uppercase}
  .params{display:grid;grid-template-columns:1fr 1fr;gap:.5mm 3mm;margin-bottom:2mm}
  .kv{display:flex;justify-content:space-between;border-bottom:.4pt solid rgba(23,21,18,.16);padding:.7mm 0;font-family:"Noto Sans Mono",monospace;font-size:6.2pt}
  .kv span{color:#6b6a4f}.kv b{font-weight:500}
  .behavior{border:.6pt solid rgba(23,21,18,.28);padding:2mm;margin-top:1mm}
  .behavior .bh{display:flex;justify-content:space-between;align-items:baseline;font-size:6.2pt;color:#6b6a4f;font-family:"Noto Sans Mono",monospace;margin-bottom:1mm}
  .behavior .bh b{color:#171512;font-family:"Noto Sans CJK SC",sans-serif;font-size:7.6pt}
  .metrics{display:grid;grid-template-columns:1fr 1fr;gap:.6mm 3mm;font-size:6.2pt;margin-bottom:1mm}
  .metrics div{display:flex;justify-content:space-between;border-bottom:.4pt solid rgba(23,21,18,.1);padding:.5mm 0}
  .metrics span{color:#6b6a4f}.metrics b{font-family:"Noto Sans Mono",monospace;font-weight:500}
  .spark{width:100%;height:13mm;display:block;margin-top:1mm}
  .checks{display:flex;flex-wrap:wrap;gap:1mm;padding-left:2mm}
  .signature{display:grid;grid-template-columns:repeat(5,1fr);gap:2mm;margin-left:2mm;border-top:.6pt solid rgba(23,21,18,.3);border-bottom:.6pt solid rgba(23,21,18,.3);padding:2mm 0}
  .sig-title{grid-column:1/-1;font-family:"Noto Sans Mono",monospace;font-size:5.4pt;color:#6b6a4f;letter-spacing:.1em;text-transform:uppercase;margin-bottom:.5mm}
  .sig .k{display:block;font-family:"Noto Sans Mono",monospace;font-size:5.2pt;color:#6b6a4f;margin-bottom:.4mm}
  .sig .v{font-family:"Noto Sans Mono",monospace;font-size:7pt;line-height:1.3}
  .sig .v b{color:#b7362a;font-weight:500}.sig .v span{color:#3d3a33}
  .check{font-family:"Noto Sans Mono",monospace;font-size:5.7pt;border:.45pt solid;padding:.6mm 1.3mm;white-space:nowrap}
  .check.ok{border-color:#2f6b45;color:#245235;background:rgba(47,107,69,.06)}
  .check.bad{border-color:#b7362a;color:#8e2a21;background:rgba(183,54,42,.06)}
  .provenance{padding-left:2mm;font-size:5.9pt;color:#5a554a;line-height:1.45}
  .provenance b{color:#171512;font-weight:600}
  .repro{margin-left:2mm;font-family:"Noto Sans Mono",monospace;font-size:5.5pt;background:rgba(23,21,18,.055);border:.45pt solid rgba(23,21,18,.15);padding:1.6mm 2mm;word-break:break-all;line-height:1.45}
  .repro b{color:#b7362a;font-weight:500}
  footer{display:flex;justify-content:space-between;align-items:flex-end;border-top:.7pt solid #171512;padding-top:1.6mm;padding-left:2mm;font-family:"Noto Sans Mono",monospace;font-size:5.4pt;color:#6b6a4f}
  .qr2{width:16mm;height:16mm;display:block;border:.4pt solid #171512;background:#f4efe5}
  </style></head><body><main class="card">
  <header><div><div class="no">MODEL LIFE · ${String(index + 1).padStart(2, '0')} / 04</div><div class="engine">${ENGINE_CN[model.engine] || model.engine}</div></div><div class="score ${scoreClass(result.score)}">${score}<small>/100</small></div></header>
  <h2>${esc(model.short)}</h2>
  <p class="desc">${esc(model.description)}</p>
  <div class="body">
    <figure><img src="${targetImg(model.targetId)}" alt="${esc(targetLabel)}"><figcaption>目标 · ${esc(targetLabel)}<br>${esc(model.steps)} 步 · ${esc(model.seedPolicy)}</figcaption>
      <p class="read"><b>读法</b> 目标与复现的密度、各向异性、相关长度、斑块数与边界密度逐项对齐；分数来自这五项的距离。</p>
    </figure>
    <div>
      <div class="params">${paramRows(model)}<div class="kv"><span>steps</span><b>${esc(model.steps)}</b></div></div>
      <div class="behavior">
        <div class="bh"><b>行为指纹 · ${PATTERN_CN[behavior.pattern] || behavior.pattern || '—'}</b><span>密度 <i style="color:#b7362a">红</i> / 各向异性 <i style="color:#6b6a4f">绿</i></span></div>
        ${sparkline(samples)}
        <div class="metrics">
          <div><span>稳定步数</span><b>${behavior.stabilizeSteps ?? '—'}</b></div>
          <div><span>活跃度</span><b>${num(behavior.activity ?? 0, 4)}</b></div>
          <div><span>翻转率</span><b>${num(behavior.flipRate ?? 0, 4)}</b></div>
          <div><span>增长 / 1000 步</span><b>${num(behavior.growthRate ?? 0, 2)}</b></div>
        </div>
      </div>
      <p class="read"><b>复现</b> 服务端按模型卡固定参数与种子重跑 ${esc(model.steps)} 步；行为指纹取自 12 个采样点。</p>
    </div>
  </div>
  <div class="signature">
    <div class="sig-title">结构签名 · 目标 / 复现</div>
    <div class="sig"><span class="k">密度 ρ</span><div class="v"><b>${pct(tf.density)}</b> <span>/ ${pct(cf.density)}</span></div></div>
    <div class="sig"><span class="k">各向异性 A</span><div class="v"><b>${num(tf.anisotropy || 0)}</b> <span>/ ${num(cf.anisotropy || 0)}</span></div></div>
    <div class="sig"><span class="k">相关长度 L_c</span><div class="v"><b>${per(tf.period)}</b> <span>/ ${per(cf.period)}</span></div></div>
    <div class="sig"><span class="k">斑块数 N</span><div class="v"><b>${cnt(tf.components)}</b> <span>/ ${cnt(cf.components)}</span></div></div>
    <div class="sig"><span class="k">边界密度 P</span><div class="v"><b>${num(tf.perimeter || 0)}</b> <span>/ ${num(cf.perimeter || 0)}</span></div></div>
  </div>
  <div class="checks">${checks}</div>
  <div class="provenance"><b>来源</b> ${esc(model.provenance?.source)}<br><b>许可</b> ${esc(model.provenance?.license)}<br><b>不变量</b> ${(model.invariants || []).map(esc).join(' · ')}</div>
  <div class="repro"><b>curl</b> -sS -X POST ${URL}/api/research/replicate -H 'content-type: application/json' -d '{"modelId":"${model.id}"}'</div>
  <footer><div>COMMONS 公地 · 模型生命卡 · 2026.11<br>${URL.replace('https://', '')}</div><img class="qr2" src="assets/commons-qr.png" alt="入口二维码"></footer>
  </main></body></html>`;
}

function soundGuide() {
  const clips = [
    ['01', '同一颗种子，两个环境', 'binaural', '30s', '左耳 · 随机汤 / 右耳 · 滑翔群；同一 genome、同一 seed=42，只有环境不同。'],
    ['02', '突变前后', 'mutation', '29.5s', '前 15 秒 Conway，后 15 秒 HighLife；同一环境、同一 seed，听密度、音色与节奏的变化。'],
    ['03', '指标到声音', 'mapping', '30s', '完整混音：密度→音量、熵→音色亮度、活跃度→节奏、周期性→节拍规律。'],
  ];
  const cards = clips.map(([n, title, key, dur, desc]) => `
    <div class="clip">
      <div class="clip-head"><span class="n">${n}</span><div><b>${title}</b><p>${desc}</p></div><span class="dur">${dur}</span></div>
      <img src="assets/${key === 'binaural' ? '01-binaural-same-seed' : key === 'mutation' ? '02-mutation-before-after' : '03-mapping-and-events'}-wave.png" alt="${title} 波形">
      <div class="file">sound/${n === '01' ? '01-binaural-same-seed' : n === '02' ? '02-mutation-before-after' : '03-mapping-and-events'}.wav · .mp3</div>
    </div>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  @page{size:A4;margin:0}
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;background:#f4efe5;color:#171512}
  body{font-family:"Noto Sans CJK SC","Noto Sans CJK",sans-serif;font-size:8.6pt;line-height:1.6}
  .page{width:210mm;height:297mm;padding:13mm 15mm 10mm;display:flex;flex-direction:column;gap:4mm;position:relative;overflow:hidden}
  .page:before{content:"";position:absolute;left:0;top:0;width:100%;height:2.4mm;background:#b7362a}
  .kicker{font-family:"Noto Sans Mono",monospace;font-size:6.8pt;letter-spacing:.18em;color:#6b6a4f;text-transform:uppercase;margin-bottom:2mm}
  h1{font-family:"Noto Serif CJK SC",serif;font-size:26pt;line-height:1.1;margin:0 0 2mm;font-weight:600}
  h1 em{font-style:normal;color:#b7362a}
  .lede{max-width:150mm;margin:0 0 3mm;color:#3d3a33}
  .clip{border-top:1pt solid #171512;padding:2.5mm 0 2mm;display:flex;flex-direction:column;gap:1.2mm}
  .clip-head{display:flex;gap:3mm;align-items:flex-start}
  .n{font-family:"Noto Sans Mono",monospace;font-size:15pt;color:#b7362a;line-height:1;min-width:10mm}
  .clip-head b{font-family:"Noto Serif CJK SC",serif;font-size:11pt;font-weight:600}
  .clip-head p{margin:.5mm 0 0;font-size:7.8pt;color:#3d3a33}
  .dur{margin-left:auto;font-family:"Noto Sans Mono",monospace;font-size:6.4pt;color:#6b6a4f;white-space:nowrap}
  .clip img{width:100%;height:16mm;object-fit:cover;background:#171512;border:.5pt solid #171512}
  .file{font-family:"Noto Sans Mono",monospace;font-size:5.8pt;color:#6b6a4f}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:7mm;border-top:1pt solid #171512;padding-top:3mm}
  h2{font-family:"Noto Sans Mono",monospace;font-size:6.4pt;letter-spacing:.14em;color:#6b6a4f;text-transform:uppercase;margin:0 0 1.5mm;font-weight:500}
  .map{display:grid;grid-template-columns:1fr 1fr;gap:1mm 3mm;font-size:7.4pt}
  .map div{border-bottom:.4pt solid rgba(23,21,18,.14);padding:.8mm 0}
  .map b{color:#b7362a}
  .note{font-size:7.2pt;color:#3d3a33;margin:0 0 1.5mm}
  .note b{color:#171512}
  .render{border-top:1pt solid #171512;padding-top:3mm}
  .render .cmd{font-family:"Noto Sans Mono",monospace;font-size:6.4pt;color:#3d3a33;background:rgba(23,21,18,.05);border-left:1.2mm solid #b7362a;padding:1.2mm 2mm;margin:0 0 1.2mm}
  footer{margin-top:auto;display:flex;justify-content:space-between;align-items:flex-end;border-top:.8pt solid #171512;padding-top:2mm;font-family:"Noto Sans Mono",monospace;font-size:5.8pt;color:#6b6a4f}
  .qr{width:19mm;height:19mm;border:.4pt solid #171512;background:#f4efe5}
  </style></head><body><main class="page">
  <div class="kicker">COMMONS 公地 · 声音对照包 · 评审材料</div>
  <h1>先听，再看：<em>结构如何变成声音</em></h1>
  <p class="lede">三段 30 秒左右的音频，全部由页面里的 AudioEngine 离线渲染，不是另外合成的配乐。建议戴耳机；先听左右差异，再对照波形与页面里的行为指纹。</p>
  ${cards}
  <div class="cols">
    <div>
      <h2>How to listen · 听什么</h2>
      <p class="note"><b>01 双耳：</b>左耳与右耳是同一颗种子、同一套基因，只有环境不同。不要找“哪边更好听”，听两边的事件密度、音色和节奏是否不同。</p>
      <p class="note"><b>02 突变：</b>0–15 秒 Conway，15–29.5 秒 HighLife；同一环境、同一 seed，规则变了，声音跟着变。</p>
      <p class="note"><b>03 映射：</b>密度推音量，熵推音色亮度，活跃度推节奏；结构事件触发短音，不是循环鼓点。</p>
    </div>
    <div>
      <h2>Mapping · 映射</h2>
      <div class="map"><div><b>密度</b> → 音量</div><div><b>熵</b> → 音色亮度</div><div><b>活跃度</b> → 节奏</div><div><b>周期性</b> → 节拍规律</div></div>
      <p class="note" style="margin-top:2mm"><b>诚实边界：</b>声音是观测通道，不是科学声化标准；它把结构变化转成可听事件，便于比较，不宣称可听出真实生物参数。</p>
      <p class="note"><b>文件：</b>每段含 WAV（保真）与 MP3（分享）；03 也用于演示视频的环境音轨。</p>
    </div>
  </div>
  <div class="render">
    <h2>Render · 怎么重渲染</h2>
    <div class="cmd">node tools/audio-pack.cjs http://127.0.0.1:4200</div>
    <p class="note">页面里的 AudioEngine 通过 OfflineAudioContext 离线渲染，44100 Hz 双声道；每段先写 WAV，再用 <b>loudnorm=I=-16:TP=-1.5:LRA=11</b> 统一响度，最后编码 MP3 192 kbps。波形图只作视觉索引，判断以听感为准。</p>
    <p class="note"><b>核对：</b>01 左/右声道相关系数约 0.20；02 在 15 秒处规则切换；03 与演示视频环境音轨同源。时长与峰值见 <b>sound/render-meta.json</b>。</p>
  </div>
  <footer><span>COMMONS 公地 · 声音对照包 · 2026.11 · ${URL.replace('https://', '')}</span><img class="qr" src="assets/commons-qr.png" alt="入口二维码"></footer>
  </main></body></html>`;
}

async function main() {
  fs.writeFileSync(path.join(HERE, 'Commons-评审一页纸.html'), onePager());
  fs.writeFileSync(path.join(HERE, 'Commons-声音对照说明.html'), soundGuide());

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
  });
  const page = await browser.newPage();

  async function load(file) {
    await page.goto('file://' + file, { waitUntil: 'networkidle0' });
    await page.evaluate(async () => { if (document.fonts?.ready) await document.fonts.ready; });
  }

  async function pdf(file, out, format) {
    await load(file);
    await page.pdf({ path: out, format, printBackground: true, preferCSSPageSize: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  }

  function pdfToPng(pdfPath, outPng) {
    execFileSync('pdftoppm', ['-png', '-r', '150', '-f', '1', '-singlefile', pdfPath, outPng.replace(/\.png$/, '')]);
  }

  const one = path.join(HERE, 'Commons-评审一页纸.html');
  const onePdf = path.join(HERE, 'Commons-评审一页纸.pdf');
  await pdf(one, onePdf, 'A4');
  pdfToPng(onePdf, path.join(HERE, 'Commons-评审一页纸.png'));

  const guide = path.join(HERE, 'Commons-声音对照说明.html');
  const guidePdf = path.join(HERE, 'Commons-声音对照说明.pdf');
  await pdf(guide, guidePdf, 'A4');
  pdfToPng(guidePdf, path.join(HERE, 'Commons-声音对照说明.png'));

  /* 单张卡：单独 HTML，便于 PNG 与单页 PDF */
  const cardPdfs = [];
  for (let i = 0; i < DATA.length; i++) {
    const html = cardPage(DATA[i], i);
    const file = path.join(HERE, `card-${DATA[i].model.id}.html`);
    fs.writeFileSync(file, html);
    const cardPdf = path.join(HERE, `card-${DATA[i].model.id}.pdf`);
    cardPdfs.push(cardPdf);
    await pdf(file, cardPdf, 'A5');
    pdfToPng(cardPdf, path.join(HERE, `card-${DATA[i].model.id}.png`));
  }
  execFileSync('pdfunite', [...cardPdfs, path.join(HERE, 'Commons-模型生命卡-合集.pdf')]);

  await browser.close();
  console.log('MATERIALS_OK');
}

main().catch((e) => { console.error('MATERIALS_FAIL', e); process.exit(1); });
