# Commons 公地 · 复现清单

版本 2026.11。目标：在本地重跑四张模型生命卡，核对结构签名与行为指纹，并重建评审材料。
所有分数都来自服务端按模型卡固定参数与种子重跑，不调用神经代理打分。

## 0. 交付物

| 文件 | 用途 |
| --- | --- |
| `Commons-评审一页纸.pdf / .png` | 评审一页纸，含入口二维码 |
| `Commons-模型生命卡-合集.pdf` | 四张 A5 模型生命卡，可直接打印 |
| `card-model-*.pdf / .png` | 四张单卡，便于单独取用 |
| `sound/01–03*.wav / .mp3` | 三段声音对照 |
| `Commons-声音对照说明.pdf / .png` | 听法、映射与重渲染说明 |
| `assets/model-data.json` | 四张卡的线上快照，构建材料的输入 |

## 1. 环境

- Node.js ≥ 20
- Chrome / Chromium（PDF、PNG 与离线音频渲染；用 `CHROME_PATH` 指定）
- poppler-utils：`pdftoppm`、`pdfunite`
- ffmpeg / ffprobe
- 字体：Noto Serif CJK SC、Noto Sans CJK SC、Noto Sans Mono

```bash
cd /workspace/commons && npm install
```

## 2. 启动服务

```bash
cd /workspace/commons
PORT=4200 node server/server.mjs
# 期望： [commons] research server on http://0.0.0.0:4200
```

`COMMONS_STORE_URL` 未配置时，榜单写入进程内存，重启即清空；这属于预期行为，不影响模型复现分数。

## 3. 核对四张模型生命卡

```bash
curl -sS http://127.0.0.1:4200/api/research/model-lives | jq -r '.models[].id'
# model-gs-spots
# model-gs-maze
# model-gs-hex
# model-le-stripes
```

逐张重跑：

```bash
for id in model-gs-spots model-gs-maze model-gs-hex model-le-stripes; do
  curl -sS -X POST http://127.0.0.1:4200/api/research/replicate \
    -H 'content-type: application/json' \
    -d "{\"modelId\":\"$id\"}" \
  | jq -r '[.model.id,.model.steps,.score,.behavior.pattern,.behavior.stabilizeSteps,.behavior.activity,.behavior.flipRate,.behavior.growthRate,.passed]|@tsv'
done
```

期望输出（数值应逐位一致）：

| modelId | steps | score | pattern | stabilize | activity | flipRate | growthRate | passed |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |
| model-gs-spots | 480 | 100 | spots | 480 | 0.0500 | 0.0549 | 0.16 | true |
| model-gs-maze | 480 | 100 | spots | 480 | 0.1158 | 0.1297 | 0.38 | true |
| model-gs-hex | 480 | 61.7 | spots | 480 | 0.1070 | 0.1128 | 0.49 | true |
| model-le-stripes | 12000 | 38.7 | stripes | 12000 | 0.0038 | 0.0058 | -0.03 | true |

说明：`model-gs-hex` 与 `model-le-stripes` 分数偏低是预期的，分别对应“六边形目标用 GS 拟合”和“真实 CIMA 条纹无唯一参数解”。这不是失败，卡片上如实标注。

## 4. 确定性检查

同一 `modelId` 连跑两次，比较分数、结构特征与行为指纹；`persisted` 等运行时字段不参与比较。

```bash
node --input-type=module -e '
const base = "http://127.0.0.1:4200";
const ids = ["model-gs-spots","model-gs-maze","model-gs-hex","model-le-stripes"];
for (const id of ids) {
  const run = async () => {
    const r = await fetch(base + "/api/research/replicate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelId: id }),
    });
    const j = await r.json();
    return { score: j.score, features: j.features, behavior: j.behavior };
  };
  const a = await run(), b = await run();
  console.log(id, JSON.stringify(a) === JSON.stringify(b) ? "deterministic" : "DIFF");
}
'
# 期望四行均为 deterministic
```

## 5. 重建评审材料

```bash
cd /workspace/commons-materials
node build-materials.mjs
# 期望： MATERIALS_OK
```

脚本会重写一页纸、四张卡与声音说明的 `.html / .pdf / .png`，并用 `pdfunite` 合成 `Commons-模型生命卡-合集.pdf`。

刷新线上快照（可选，需要本地服务已启动）：

```bash
cd /workspace/commons-materials
node --input-type=module -e '
import fs from "node:fs";
const base = "http://127.0.0.1:4200";
const lives = await (await fetch(base + "/api/research/model-lives")).json();
const out = [];
for (const m of lives.models) {
  const j = await (await fetch(base + "/api/research/replicate", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ modelId: m.id }),
  })).json();
  out.push({ model: j.model, result: j });
}
fs.writeFileSync("assets/model-data.json", JSON.stringify(out, null, 2));
console.log("model-data.json", out.length, "entries");
'
```

注意：`build-materials.mjs` 顶部的 `CHROME` 路径与 `createRequire('/workspace/commons/package.json')` 按本机写死；换机器时改这两处。

## 6. 声音对照包复现

```bash
cd /workspace/commons
node tools/audio-pack.cjs http://127.0.0.1:4200   # 01 双耳、02 突变、03 映射
npm run audio:render                              # 03 的 30s 源预览
```

再统一响度并编码 MP3：

```bash
cd /workspace/commons-materials/sound
for f in 01-binaural-same-seed 02-mutation-before-after 03-mapping-and-events; do
  ffmpeg -y -i "$f.wav" -af loudnorm=I=-16:TP=-1.5:LRA=11 -ar 44100 -ac 2 -c:a pcm_s16le "tmp-$f.wav"
  mv "tmp-$f.wav" "$f.wav"
  ffmpeg -y -i "$f.wav" -codec:a libmp3lame -b:a 192k "$f.mp3"
done
```

核对时长、峰值与左右差异：

```bash
for f in 01-binaural-same-seed 02-mutation-before-after 03-mapping-and-events; do
  printf "%s\t" "$f"
  ffprobe -v error -show_entries format=duration -of csv=p=0 "$f.wav"
done
# 期望约 30.0 / 29.5 / 30.0 秒

ffmpeg -i 01-binaural-same-seed.wav -af astats=metadata=1:reset=0 -f null - 2>&1 | grep "Peak level dB"
# 期望峰值低于 0 dBFS（本包约 -4 至 -6 dB）
```

`01` 的左右声道是同一 genome、同一 seed=42，只有环境不同（左 `soup` / 右 `glider`）；`02` 在 15 秒处从 Conway 切到 HighLife；`03` 与演示视频环境音轨同源。

## 7. 已知边界

- 评分是结构统计相似，不是参数反演；不宣称恢复真实生物参数。
- 四张卡里两张满分、两张低分，均保留，低分同样展示目标与复现的差距。
- 神经代理只用于候选排序，最终分数由确定性重跑确认；代理本身的误差不进入卡片分数。
- 公开体验站点的榜单存储为公共 JSON 存储，约 100 请求/小时，读改写存在并发覆盖风险；不用于严肃数据收集。
