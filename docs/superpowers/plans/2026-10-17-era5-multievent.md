# ERA5 强制多事件批 + 扩目录 实施计划

时间 2026-10-17。前置分析见对话：能走的合成增强 = ERA5 逐事件驱动 × 扩目录。

## 实测确定的参数（E1）

- 放宽风速阈值在原框内几乎不增样本（13→13）；**扩框才是增量**：
  框 ×2（120.4–123.2E / 27.8–31.8N）+ ≥25 m/s → **37 场**（1980–2025）。
- 远距离场次参数化雨场会被 R_FLOOR 截成零（16/18 口径的两个 SKIP 成因），
  **ERA5 再分析恰好能救回这些场次的真实降雨**——扩目录与 ERA5 强制天然配对。

## 任务

- [x] E1 筛选参数实测（本文件上一节）
- [ ] E2 本计划落盘提交
- [ ] E3 `tools/era5_multievent.py` 驱动器（不改任何既有模块）
- [ ] E4 先试跑 2 场（TODD 1998 近 + 一场框×2 新增远处场），核对读数
- [ ] E5 全量 37 场后台批量（约 20–35 min）
- [ ] E6 同口径标定：强度—损失（复用 multievent.fit_intensity_loss /
      check_monotonicity / empirical_levels / fit_return_period，
      构造 EventResult 直接喂）+ 与参数化 07 件并列表
- [ ] E7 `docs/era5-multievent.md` 报告（含尾部天花板的诚实声明）
- [ ] E8 回归：pytest 125 + config/source 指纹不变 + `git status` 干净

## Global Constraints

- 不动 `out/`、不动 `typhoeus/multievent.py`（默认路径与 07 件数字不动）。
- 产物一律落 `out_era5/`；ERA5 缓存 `data/seed/rain_reanalysis_era5_<年名>.npz`
  （沿袭 npz 不入库惯例）。
- 新声称全部三态；GPD 尾部"观测史实的空档不可合成填充"写死。
- 分解四项不批量算（只算 Q 总量），报告写明与 07 件口径差。
