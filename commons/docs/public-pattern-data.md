# 公开实验斑图数据源（Commons 调研）

调研日期：2026-11-12
目标：为「解谜」关卡寻找**公开可用**的斑图图像，优先真实实验数据，其次可用于评分校准的合成数据。

---

## 结论先行

**第一版真实关卡建议只用这 4 个，许可清晰、可商用/可再分发：**

| 优先 | 数据 | 斑图类型 | 许可 | 形态 |
|---|---|---|---|---|
| 1 | 斑马鱼成体条纹（PLOS Genetics Fig 6） | 条纹 | CC BY 4.0 | 单张 5.7 MB JPG，带比例尺 |
| 2 | BZ 反应斑图（Wikimedia Commons） | 波/螺旋 | CC BY 4.0 | 1000×998 JPG |
| 3 | 毛囊周期性斑图（PLOS Biology 数据集） | 点阵 | CC BY 4.0 | 图像/时间序列数据集 |
| 4 | CIMA 实验斑图（arXiv 2025 Fig 2） | 斑点+条纹混合 | 论文 CC BY 4.0 | 单张实验快照；原始数据未公开 |

**评分校准仍建议用合成数据**（有隐藏参数真值）：OSF Gray-Scott 7.5 GB 或 CLIP-MMA 244 MB。

---

## A. 许可清晰，可直接接入

### 1. 斑马鱼成体条纹

- 来源：Nagao et al. 2018, *PLOS Genetics*, "Distinct interactions of Sox5 and Sox10…"
- 图：Fig 6，成体斑马鱼 5 条黑色素条纹 + 黄色素间带
- 许可：CC BY 4.0
- 页面：<https://plos.figshare.com/articles/figure/Distinct_interactions_of_Sox5_and_Sox10_in_fate_specification_of_pigment_cells_in_medaka_and_zebrafish_-_Fig_6/6100484>
- 直接下载：<https://plos.figshare.com/ndownloader/files/10999895>
- DOI：<https://doi.org/10.1371/journal.pgen.1007260.g006>
- 注意：图内有多面板、箭头和比例尺，需要裁切纯鱼体区域再做灰度化。

### 2. Danio 条纹与斑点对比

- 来源：McCluskey et al. 2021, *PLOS Genetics*, "A complex genetic architecture in zebrafish relatives Danio quagga and D. kyathit…"
- 图：Fig 1，同一图内同时有条纹型与斑点型
- 许可：CC BY 4.0
- 页面：<https://journals.plos.org/plosgenetics/article?id=10.1371/journal.pgen.1009364>
- 用途：一张图可拆出“条纹”和“斑点”两个目标，适合做难度对照。
- 注意：图内包含细胞类型示意与多物种照片，需人工裁切。

### 3. Belousov–Zhabotinsky（BZ）反应斑图

- 来源：Philip Ball，图像由 Michael C. Rogers 与 Stephen Morris（University of Toronto）提供；原始论文 DOI 10.1098/rstb.2014.0218
- 许可：CC BY 4.0
- 页面：<https://commons.wikimedia.org/wiki/File:Patterns_in_the_Belousov%E2%80%93Zhabotinsky_reaction.jpg>
- 原图：<https://upload.wikimedia.org/wikipedia/commons/1/19/Patterns_in_the_Belousov%E2%80%93Zhabotinsky_reaction.jpg>
- 用途：真实化学波/螺旋目标，与 FHN 的“螺旋/靶波”关卡视觉接近。
- 同类备选：Wikimedia Commons 分类 `Category:Belousov-Zhabotinsky_reaction` 有 18 个文件，但**每个文件许可不同**，必须逐张确认。

### 4. 毛囊周期性斑图（点阵）

- 来源：Glover et al. 2017, *PLOS Biology*, "Hierarchical patterning modes orchestrate hair follicle morphogenesis"
- 数据：PLOS Figshare 数据集（图像/时间序列）
- 许可：CC BY 4.0
- 数据集：<https://plos.figshare.com/articles/dataset/Hierarchical_patterning_modes_orchestrate_hair_follicle_morphogenesis/5195803>
- 论文：<https://doi.org/10.1371/journal.pbio.2002117>
- 用途：真实生物点阵，适合“斑点/六边”类目标。
- 注意：下载后先确认文件是显微图像还是时间序列；若是 movie，需要抽帧。

### 5. CIMA 实验斑图（最贴“真实 Turing 实验”）

- 来源：Kazarnikov et al. 2025, "Statistical parameter identification of mixed-mode patterns from a single experimental snapshot"
- 图：Fig 2，CIMA 反应在双侧开放反应器中的真实 Turing 斑图（斑点与条纹共存）
- 许可：论文 CC BY 4.0
- 论文：<https://arxiv.org/abs/2504.02530>
- 文内第 3.3 节描述了实验装置与图像数据；**原始数据未在正文给出公开仓库**。
- 建议：先用 Fig 2 作为目标图；若要原始快照/时间序列，联系作者（Heidelberg / Brandeis）。
- 这是目前最接近“真实实验 + 可做参数反演”的公开材料。

---

## B. 公开，但许可或格式需要先确认

### 6. 豹纹守宫斑点图（真实生物斑点）

- OSF 项目：Gecko Patterns Data and Code
- 规模：1.9 GB，PNG，已手工裁出身体部位
- 链接：<https://osf.io/zauwe/>
- 许可：**OSF 项目未设置许可证**（`node_license: null`）。
- 结论：图像质量很适合斑点关卡，但**不能直接再分发**；需联系 Tilmann Glimm（glimmt@wwu.edu）确认许可。

### 7. BZ 反应图像序列 / 视频

- 来源：Štys et al. 2016, arXiv:1602.03055
- 内容：200 mm 培养皿中的 BZ 反应图像序列 `BZexperiment` / `BZreshake`，附视频
- 链接：<https://arxiv.org/abs/1602.03055>
- 许可：arXiv 默认非独占许可，**不是 CC BY**。
- 结论：可读、可研究；若要放进产品并再分发，需作者授权。

### 8. 果蝇复眼六边晶格

- Zenodo：<https://zenodo.org/records/6378171>
- 内容：2.2 GB `.mat` 细胞追踪数据 + 模型权重，真实复眼晶格
- 许可：页面未明确展示，需确认。
- 结论：不是原始图片，是坐标数据；若要用于图像关卡，需要自己渲染点阵。

### 9. ZFIN 斑马鱼图像库

- <https://zfin.org/>
- 图像量很大，但版权多归原论文/出版社，**不能默认再分发**。
- 结论：只适合作为内部参考；正式接入应回到 PLOS/CC BY 的原图。

---

## C. 合成数据：用于评分校准与参数真值

真实实验图通常没有唯一参数真值，所以评分校准仍需合成数据。

### 10. OSF Gray-Scott 原始数据

- 项目：Exploring pattern formation in the Gray-Scott model with CNN
- 规模：7.5 GB
- 许可：CC BY 4.0
- 链接：<https://osf.io/byrzm/>（若页面 404，用标题在 OSF 搜索；API 可访问）
- 用途：大量带参数标签的 GS 斑图，可做“隐藏参数”关卡的校准集。

### 11. CLIP-MMA 数据集

- 来源：Hishinuma et al. 2025, *PLOS Computational Biology*
- 规模：244.64 MB；模型选择 1799 张 + Turing 参数估计约 9700 张
- 许可：MIT（数据集页面）
- 数据集：<https://doi.org/10.6084/m9.figshare.27263601.v1>
- 代码：<https://github.com/Hide-Hishi/CLIP-MMA>
- 注意：训练图像是合成模型图；“target_image”可能包含真实生物目标图，但这些第三方图像的版权不一定被 MIT 覆盖，商用前需逐张确认。

### 12. The Well（Gray-Scott 大规模基准）

- 规模：15 TB，合成物理仿真
- 链接：<https://github.com/PolymathicAI/the_well>
- 用途：如果要训练/评估大规模模型，而不是做 4 个关卡，才考虑；对当前产品过重。

---

## 接入 Commons 的建议

### 关卡类型：真实斑图（无参数真值）

不要沿用合成关卡的“隐藏 f/k + 参数揭示”。真实图应改成：

- 目标：用户看到真实斑图，画种子/调参去逼近其**结构统计**（ρ、H_v、L_c、D_box、布局）。
- 通关：只揭示“你与目标的距离”，不宣称恢复真实实验参数。
- UI 标注：`真实实验斑图 · 无唯一参数解` + 来源/许可/作者。
- 评分：结构 60% + 布局 25% + 稳健 15%；去掉“参数正确性”暗示。

### 预处理

1. 裁掉图注、箭头、比例尺、面板标签。
2. 转灰度，必要时反相（深色斑图 vs 浅色背景）。
3. 保持原始长宽比裁成正方形，再缩放到 64×64。
4. 直方图拉伸到 [0,1]；不要做锐化/滤波，保留原始结构。
5. 用现有 `extractPatternFeatures()` 提特征；目标特征只算一次并缓存。
6. 记录来源、作者、许可、URL、裁切坐标、修改说明。

### 许可合规

- CC BY 4.0：可以再分发/修改，但必须署名、给许可链接、注明修改。
- OSF 无许可证：默认保留所有权利，**不要直接用**。
- arXiv 非独占许可：不要直接再分发视频/图像。
- MIT 数据集：只覆盖数据集本身，不自动覆盖其中的第三方图像。

### 建议的 manifest 字段

```json
{
  "id": "zebrafish-stripes-01",
  "type": "real",
  "class": "stripes",
  "file": "zebrafish-stripes-01.jpg",
  "source": "Nagao et al. 2018, PLOS Genetics",
  "doi": "10.1371/journal.pgen.1007260.g006",
  "url": "https://plos.figshare.com/articles/figure/.../6100484",
  "license": "CC BY 4.0",
  "attribution": "Nagao et al., PLOS Genetics, CC BY 4.0; cropped",
  "crop": [0.0, 0.0, 1.0, 1.0],
  "grayscale": true,
  "invert": false,
  "notes": "remove scale bar and panel labels"
}
```

---

## 建议的下一步

1. 先接入 **斑马鱼条纹（PLOS Fig 6）** 做第一个真实关卡：条纹目标、CC BY 清晰、下载直接。
2. 再接 **BZ CC BY 4.0 图** 做波/螺旋关卡。
3. CIMA 图作为“真实 Turing 实验”招牌关卡，但只做结构匹配，不揭示参数。
4. 用 OSF Gray-Scott 或 CLIP-MMA 合成集做评分阈值校准。
5. 联系 Gecko 与 CIMA 作者，争取可再分发的原始序列。

---

## 参考链接

- PLOS Fig 6: <https://plos.figshare.com/articles/figure/Distinct_interactions_of_Sox5_and_Sox10_in_fate_specification_of_pigment_cells_in_medaka_and_zebrafish_-_Fig_6/6100484>
- PLOS Danio stripes/spots: <https://journals.plos.org/plosgenetics/article?id=10.1371/journal.pgen.1009364>
- BZ image: <https://commons.wikimedia.org/wiki/File:Patterns_in_the_Belousov%E2%80%93Zhabotinsky_reaction.jpg>
- BZ category: <https://commons.wikimedia.org/wiki/Category:Belousov-Zhabotinsky_reaction>
- Hair follicle dataset: <https://plos.figshare.com/articles/dataset/Hierarchical_patterning_modes_orchestrate_hair_follicle_morphogenesis/5195803>
- CIMA paper: <https://arxiv.org/abs/2504.02530>
- Gecko OSF: <https://osf.io/zauwe/>
- BZ videos: <https://arxiv.org/abs/1602.03055>
- Drosophila eye: <https://zenodo.org/records/6378171>
- OSF Gray-Scott: <https://osf.io/byrzm/>
- CLIP-MMA: <https://doi.org/10.6084/m9.figshare.27263601.v1>
- Zebrafish review (CC BY 4.0): <https://doi.org/10.1098/rsta.2020.0274>
