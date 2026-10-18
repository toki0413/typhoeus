# NOTICE —— 第三方数据、模型与软件的许可与署名

本仓库的代码与文档采用 MIT（见 LICENSE）。下列第三方材料各自适用其原始许可，
**其条款优先于 MIT 适用于相应材料**。本文件同时覆行各来源的署名义务。

---

## 一、数据

| 数据 | 来源 | 许可 / 署名要求 | 在本仓库中的位置 |
|---|---|---|---|
| **ERA5 再分析降水**（经 Open-Meteo archive-api） | ECMWF / Open-Meteo | **CC BY 4.0**。需署名 `Open-Meteo` 与 `ECMWF ERA5`，并在与数据同时展示处给出 https://open-meteo.com 链接 | `data/seed/rain_reanalysis_era5.npz`（缓存，未入库）；产物 `06_health_report.json` 的「数据来源」段已含署名 |
| **CHIRPS-2.0** 日降水 | Climate Hazards Center, UC Santa Barbara | 公开可用，引用要求见 https://data.chc.ucsb.edu/products/CHIRPS-2.0/ | `data/seed/chirps/domain/*.tif`（域内裁剪，未入库）；汇总见 `data/seed/chirps/domain_rain_summary.json` |
| **Copernicus GLO-30 DEM** | © DLR e.V. 2010-2014 / © Airbus DS GmbH 2014-2018，provided under COPERNICUS by the European Union and ESA | 需保留完整署名与免责声明 | `data/dem_n29e121.tif`（未入库）。**注意：本文件无内嵌来源标签，来源依据为项目自述** |
| **IBTrACS v04r01** 台风路径 | NOAA NCEI / WMO | 可再分发；**官方要求引用 BAMS 论文并标注 DOI 10.25921/82ty-9e16** | `data/ibtracs*.csv`（未入库） |
| **Sen1Floods11** 基准数据 | Cloud to Street / IEEE 等 | 见 https://github.com/cloudtostreet/Sen1Floods11 | 仅用于训练/验证 SAR 模型；原始影像未入库 |
| **Sentinel-1 GRD** | Copernicus / ESA | Copernicus Data Licence | **未取得**（见 `out/p8_遥感淹没范围验证.html` 的 BLOCKED 声明） |
| **涝点台账与气象通报** | 宁波市水利局、央广网、人民日报客户端、人民网浙江等公开通报 | 事实性公开信息可引用；**原始观测权属宁波市水利局** | `data/seed/flood_points_2021_infa.csv`（逐行附来源） |
| **监测点占位数据** | 本项目合成 | `provenance = synthetic`，**不得作为实测坐标使用** | `data/seed/monitor_sites_synthetic.json` |
| **逐小时合成降雨** | 本项目合成 | 锚定到实测站点累计量，**不得作为实测序列使用** | `data/seed/rain_hourly_synthetic.json` |
| **CMFD 2.0 / CMPAS** | 国家青藏高原科学数据中心 / 中国气象局 | 需注册下载；引用见各自 DOI | **未取得**，仅交付读取器（`typhoeus/cmfd.py`、`typhoeus/cmpas.py`） |

---

## 二、模型与代码依赖

| 组件 | 许可 | 用途 |
|---|---|---|
| numpy 2.4.4 | BSD-3-Clause | 全部数值计算 |
| scipy 1.17.1 | BSD-3-Clause | GPD 极值拟合 |
| rasterio 1.5.2 | BSD-3-Clause | DEM 读取与重采样 |
| xarray（可选） | Apache-2.0 | CMFD/CMPAS NetCDF 读取 |
| pytest 9.1.1 | MIT | 回归测试 |
| PyTorch（可选） | BSD-3-Clause | SAR U-Net 推理/训练 |

---

## 三、SAR 验证模型的来源与边界

`tools/sar_train.py` 与 `runs/cloud_artifacts/*/unet_ep*.pt` 为**本项目自行训练**的 U-Net，
训练数据为 Sen1Floods11（事件级切分）。其性能指标见 `out/p8_遥感淹没范围验证.html`。

**边界**：训练事件域为全球（Ghana / Nigeria / Pakistan / Paraguay / Somalia /
Spain / Sri-Lanka / USA / Bolivia / India / Mekong），**不含宁波**；迁移到宁波属
域外应用，未标定。宁波本地推理因缺少 Sentinel-1 影像而判 BLOCKED。

---

## 四、未入库的大体积材料（说明而非遗漏）

- `data/osm/china-260820.osm.pbf`（1.5 GB，ODbL）：**已从工作区删除**。
  若日后重新引入，须以 ODbL 释出派生库并署名 `© OpenStreetMap contributors`。
- `typhoeus_core.tar.gz`（104 MB）：**已删除**。它曾把 Copernicus DEM 与 IBTrACS
  原始数据一并打包，会触发再分发义务。

---

## 五、引用建议

若在论文/报告中引用本仓库，建议同时引用其依赖的原始数据：

```
He, J., Yang, K., Li, X., Tang, W., Shao, C., Jiang, Y., & Ding, B. (2024).
  China meteorological forcing dataset v2.0 (1951-2024).
  National Tibetan Plateau / Third Pole Environment Data Center.
  https://doi.org/10.11888/Atmos.tpdc.302088
Xia, H., & Wang, K. (2025). Hourly, kilometer-scale precipitation merged from
  rain gauge, ground-based radar and satellites over east Asia.
  Journal of Hydrology, 662, 134148. https://doi.org/10.1016/j.jhydrol.2025.134148
Knapp, K. R., et al. IBTrACS. NOAA NCEI. https://doi.org/10.25921/82ty-9e16
```
