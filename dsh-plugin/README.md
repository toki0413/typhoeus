# typhoeus-mcp

把提比翁（Typhoeus）城市内涝内核接成 **9 个只读工具**。它不预测明天，只回答一件已经算完的事：这场台风在这片区的损失是多少、先修哪里、这笔钱值不值——每个数字都带可复算指纹。

## 安装

```bash
dsh plugin --profile web add github:<owner>/typhoeus-mcp
```

**前置**：内核是 Python 服务，先装它并准备数据目录。

```bash
pipx install "git+https://github.com/toki0413/typhoeus"
typhoeus-mcp --list-tools      # 应打印 9 个工具、描述 1230/2048 B
```

数据与产物放在 `TYPHOEUS_HOME` 指向的目录下（`data/` 与 `out/`），不设则用 `~/.typhoeus`。
安装时 `prepare.mjs` 会自检这两项，缺什么会直接打印该跑哪条命令。

## 9 个工具

| 工具 | 回答什么 |
|---|---|
| `get_preset_plan` | 汛前在哪布点、几级响应、几组人几台车 |
| `get_recovery_order` | 灾后先修哪条路、比双基线好多少 |
| `get_event_reconciliation` | 损失怎么分解、账闭合不闭合 |
| `get_resilience_pricing` | 减 1% 损失要投多少钱 |
| `get_health_metrics` | 27 条门槛过了几条、哪些缺数据 |
| `get_health_report` | 守恒、正性、峰值水深、caveat |
| `get_multievent_calibration` | 18 场 / 36 年的强度—损失关系 |
| `get_flood_cards` | 28 个涝点逐点读数与可信度 |
| `get_point_depth` | 任意坐标：域内给最近台账点，域外拒答 R1 |

## 边界（先说清）

- 涝点水深命中率 **0.0%**（MAE 0.36 m）：17 个域内点中 12 个模型水深 <0.05 m。
- 面雨量对官方全市口径偏差 **−31%**。
- 27 条门槛：**15 通过 / 5 不达标 / 7 因缺外部数据未验证**。

它支撑的是易涝点分级、损失核算、抢修次序；**不是精确水深预报**。这些数字逐条写在 `out/05_health_metrics.json` 的「根因」字段里。

## 许可

内核代码 MIT；数据许可与署名见项目 `NOTICE.md`。
