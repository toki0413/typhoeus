# 《黄金时间》竞品调研与开源复用备忘

- 日期：2026-11-19
- 范围：应急/防灾/急救类严肃游戏与商业游戏、可复用开源项目、权威标准与数据源
- 用途：为 v0.1 垂直切片的技术选型与定位提供依据

---

## 0. 结论先行

1. **市场空位明确。** 现有产品基本落在三格：灾前社区规划（Stop Disasters）、灾中指挥调度（Emergency 4 / 911 Operator）、单点技能训练（Lifesaver / 消防模拟器）。**"一线响应者 + 种子化战术 + 规划/执行双阶段 + 逐动作证据 + 离线单文件"这一格基本空着。**
2. **玩法对标可拆开借。** 资源调度学 Emergency 4 / 911 Operator，威胁可读与系统性学 MGS，单点决策学 Lifesaver，预算约束学 Stop Disasters。
3. **仿真内核自研，专业模型只做离线标定。** FDS/CFAST/JuPedSim/Cell2Fire 都有价值，但 CFD 太重、GPL/LGPL 不适合直接链进单文件发布。运行时用自研的分区/元胞 + 经验曲线，离线用这些工具标参数。
4. **教育证据要诚实。** 最新 CPR 严肃游戏 meta 分析显示，相比传统训练**没有统计学显著优势**，且不足以证明等效。因此定位必须是"训练入口与情境判断"，不是"替代实操培训"。
5. **评估导出对齐 xAPI。** 自有 DebriefCard + 兼容 IEEE 9274.1.1-2023（xAPI）的 actor-verb-object 语句，便于学校/机构接入，也便于第三方做效果评估。
6. **渲染栈二选一。** PixiJS（生态成熟、粒子/滤镜强）或 LittleJS（极小、MIT、WebGL 批处理 + Canvas2D 回退）。建议各做一次 spike，按 bundle 与 60fps 实测决定。

---

## 1. 竞品矩阵

### 1.1 分类

| 类别 | 代表 | 与我们的关系 |
|---|---|---|
| A 灾前规划 / 社区韧性 | Stop Disasters! | 最接近的教育定位，但阶段相反 |
| B 灾中指挥 / 调度 | Emergency 4、911 Operator | 直接借资源调度手感 |
| C 消防/救援模拟 | Firefighting Simulator: Ignite、Emergency Call 3、Fire Rescue Simulator | 借沉浸与操作反馈，避开其写实 3D 成本 |
| D 单点技能 / 决策叙事 | Lifesaver、Inside the Haiti Earthquake | 借"决策—后果"表达 |
| E 专业训练系统 | Zero Hour、FüSim Digital、HEAT | 借能力项与评估口径，不借其重型技术栈 |
| F 中国官方科普 | 全民消防安全学习云平台、国家应急管理科普库、应急科普场馆 | 权威内容源与潜在合作方，不是玩法竞品 |
| G 研究原型 | Crowd Disaster、Disaster Defenders! | 借方法与评估设计 |

### 1.2 逐项对比

| 产品 | 核心机制 | 强项 | 局限 | 可借鉴 |
|---|---|---|---|---|
| **Stop Disasters!**（UNDRR） | 选一种灾害（海啸/飓风/地震/野火/洪水），有限预算 + 约 10–15 分钟规划，建房屋、医院、学校、加固设施，灾害来袭后结算伤亡与损失；3 档难度，11 种语言 | 公益定位清晰、门槛低、传播强（累计浏览超 200 万）、教师包成熟 | 只做灾前规划，无一线执行；无逐动作证据；无种子化重玩 | 预算约束、规划计时、教师包与课堂落地方式、多语言 |
| **911 Operator / 112 Operator** | 接警、判断事件类型、派警/消/医，管理车辆与人员，事件并发 | 资源稀缺与并发压力的手感极好 | 玩家是指挥台，不进入现场；无技能训练证据 | 事件并发、单位调度、资源覆盖取舍 |
| **Emergency 4 Deluxe** | 事故指挥官，指挥警察/消防/急救/技术救援，最多约 30 种车辆，事故链式升级 | 多部门协同、事故升级的真实感 | RTS 老派操作、门槛高、内容固定 | 多工种协同、事故链式升级 |
| **Firefighting Simulator: Ignite** | 第一/第三人称消防作业，4 人合作，写实火灾与烟 | 现场压迫感、视觉表现 | 3D 写实成本高、硬件门槛高、教育评估弱 | 烟的视觉语言、装备使用反馈 |
| **Emergency Call – The Firefighting Simulation 3** | 24 小时轮班、培训课程、资质认证、出勤 | 把"资质"做成进度系统 | 仍是写实模拟，偏操作训练 | 资质/能力项的组织方式 |
| **Fire Rescue Simulator（移动端）** | 3D 写实，火灾/地震/化工多灾种，第一/第三人称 | 移动端覆盖广 | 操作门槛与硬件要求高，教育性弱 | 多灾种菜单结构 |
| **Lifesaver / e-Lifesaver**（英国复苏委员会） | "游戏化的电影"，4 个情境，第一人称做 CPR 决策；e 版符合 SCORM | 决策—后果表达强、免费、学校可落地 | 只覆盖急救单点；无战术层 | 情境决策节奏、SCORM 接入思路 |
| **Inside the Haiti Earthquake** | 扮演幸存者/记者/救援者，做有实践与伦理后果的选择 | 立场转换、伦理张力 | 线性叙事、无系统模拟 | 多角色视角、伦理取舍 |
| **Zero Hour**（Virtual Heroes） | UE3 的 EMS 训练模拟 | 专业训练级场景 | 重型引擎、成本高 | 训练目标与场景脚本的写法 |
| **FüSim Digital + 火焰扩展**（HPI） | 消防指挥员数字化演练，多起事故并行 | 指挥层训练与复盘 | 面向专业指挥官，非大众 | 复盘/讲评结构 |
| **HEAT**（开源拼装 3D 训练） | 用开源库拼出 Hazard Emergency and Accident Training | 证明开源拼装可行 | 技术栈老旧、体验一般 | 开源组件拼装的工程经验 |
| **全民消防安全学习云平台**（应急管理部消防救援局） | 学习资料、火灾案例、短视频、咨询、练习考试、学习统计、单位管理 | 官方权威、免费、覆盖广 | 以内容和答题为主，无战术模拟 | 内容权威性、单位/班级管理、学习统计口径 |
| **国家应急管理科普库**（应急管理部 + 中国科协） | 汇聚应急科普产品，覆盖自然灾害/事故灾难/生活安全 | 权威内容池、免费 | 不是游戏 | 权威内容合作与引用 |
| **应急科普场馆（线下）** | 地震平台、火灾逃生帐篷、VR、模拟灭火 | 体感真实 | 受地域与开放时间限制 | 体感操作的现实参照 |
| **Disaster Defenders!**（研究） | 面向儿童的网页严肃游戏，开放玩法 + 引导反思 + 课程模块 | 有教学设计与评估 | 儿童向、规模小 | 引导反思环节、课程对齐 |

---

## 2. 空位与差异化

### 2.1 五个空位

1. **阶段空位**：市面产品要么"灾前规划"，要么"灾中调度"，要么"单点技能"，很少把"不计时规划 → 实时执行"做成一条完整时间轴。
2. **证据空位**：多数严肃游戏只给分数，不给"逐动作 → 标准条款"的证据链。
3. **重玩空位**：几乎都靠固定关卡，缺少种子化局势与"同种子重打"的掌握度验证。
4. **硬件空位**：写实模拟普遍吃显卡；离线、单文件、集显可跑的产品很少。
5. **中国语境空位**：官方平台以内容与答题为主，缺少"可玩、可评估、可离线部署"的战术层产品。

### 2.2 我们的差异化主张

> 一款离线、低门槛、种子化的战术应急游戏：玩家每个动作既改变局势，又生成一条可对标权威标准的学习证据。

---

## 3. 开源复用清单

### 3.1 可直接打包进产品（宽松许可）

| 项目 | 用途 | 许可 | 结论 |
|---|---|---|---|
| PixiJS | 2D 渲染（WebGL 批处理） | MIT（以仓库 LICENSE 为准） | 首选之一，粒子/滤镜强 |
| LittleJS | 极小 2D/3D 引擎，WebGL + Canvas2D 回退 | MIT | 首选之一，最贴合 <2MB 预算 |
| Phaser | 完整 2D 框架 | MIT | 功能全但体积偏大，备选 |
| Kaplay（原 Kaboom） | 快速原型 2D 库 | MIT | 适合 spike，不适合长期产品结构 |
| rot.js | FOV、RNG、寻路、回合调度 | BSD-3-Clause | 只取 FOV/调度思路，避免整包引入 |
| seedrandom | 种子化 PRNG | MIT | 可用；也可自研 PCG |
| zod | 运行时数据校验（种子/配置/导出） | MIT | 推荐 |
| Dexie.js | IndexedDB 封装（存档） | Apache-2.0 | 推荐 |
| howler.js | 音频 | MIT | 推荐（默认静音可关） |
| easystar.js / pathfinding | 网格寻路 | MIT | 推荐，或自研 A* |
| Vite | 构建与单文件打包 | MIT | 推荐 |
| Vitest + Playwright | 单测与端到端 | MIT / Apache-2.0 | 推荐 |
| axe-core | 无障碍检查 | MPL-2.0 | 开发期使用 |

**许可原则**：随产品分发的代码只用 MIT / BSD / Apache-2.0。MPL-2.0 仅开发期用。GPL/LGPL 一律不打包。

### 3.2 只做离线标定与验证（不进运行时）

| 项目 | 用途 | 许可 | 用法 |
|---|---|---|---|
| **NIST FDS + Smokeview** | CFD 火灾/烟气 | 公有领域 | 生成少量高保真参考场，校准我们的简化烟气模型 |
| **NIST CFAST** | 分区火灾模型（房间-走廊） | 公有领域 | 最贴合我们的场景粒度，用其多房间质量/能量平衡结果标定参数 |
| **Cell2Fire** | 元胞野火蔓延 | GPL-3.0 | 野火灾种的蔓延参数参考 |
| **ForeFire** | 野火蔓延 | GPL-3.0 | 同上，交叉验证 |
| **FORFIS** | 教学型野火仿真 | 见仓库 | 教学口径参考 |
| **JuPedSim** | 行人动力学/疏散 | LGPL-3.0+ | 标定人群速度—密度曲线、瓶颈流量 |
| **Vadere** | 多行人模型对比 | LGPL | 模型选型参考 |
| **SUMO** | 大规模交通/疏散 | GPL | 仅参考，规模超出需求 |
| **SiCoBioNa** | 社会力模型疏散 | 开源 | 社会力参数参考 |

**关键取舍**：浏览器里跑不动 CFD，也不需要。我们用**分区（房间/走廊/楼梯间）+ 元胞（火线/水面）+ 经验曲线**，把 CFAST/JuPedSim 的输出当作标定靶，而不是运行时依赖。

### 3.3 数据与标准源

| 来源 | 内容 | 许可/可用性 | 注意事项 |
|---|---|---|---|
| **IFRC 国际急救、复苏与教育指南（2020 / 2025）** | CPR、止血、复苏、教育方法 | 免费，非商业使用需署名 | 最适合公益产品的权威锚点 |
| **START 分诊法** | 60 秒内 RPM 评估、红黄绿黑四色 | 公开算法与大量文献 | 用文献与公开指南，不复制付费教材 |
| **国家标准全文公开系统**（openstd.samr.gov.cn） | 强制性国标全文免费；推荐性部分可读/仅题录 | 官方免费 | 逐条核验条款号后再入库 |
| **应急管理部 国家应急管理科普库** | 自然灾害/事故灾难/生活安全 | 官方免费查阅使用 | 二次创作与转载需确认授权 |
| **全民消防安全学习云平台** | 消防知识、案例、题库 | 官方 | 优先合作，不抓取 |
| **NFPA 标准** | 消防规范 | 付费 | 不直接复制条文 |
| **OpenStreetMap / Microsoft Building Footprints** | 建筑轮廓 | ODbL / 开放 | 仅作拓扑参考，产品内不复刻真实社区 |

### 3.4 明确不复用

- Unity / Unreal 的 WebGL 导出：体积与性能不满足 <2MB / 集显 60fps。
- 运行时 3D CFD（FDS）：计算量级不匹配。
- 现成消防/救援游戏的素材与关卡：IP 风险。
- GPL 引擎直接链进单文件分发：许可风险。

---

## 4. 教育证据与风险

### 4.1 证据现状

- **灾害教育严肃游戏系统综述**（132 篇，2007–2025）：数字严肃游戏占绝大多数，洪涝最常被研究；但相当一部分工作只描述游戏、缺少严格效果评估。
- **CPR 严肃游戏 meta 分析**：在按压深度、频率、理论知识与实操技能上，相比传统训练**无统计学显著优势**，且证据不足以证明等效，建议谨慎、不应广泛替代传统训练。
- **灾害护理游戏化教学系统综述**：在理论知识、实操技能、参与度、知识保持、满意度与自我效能上整体为正，但研究异质性大。
- **儿童洪涝网页严肃游戏研究**：开放玩法 + 引导反思 + 课程对齐的组合，比单纯灾害可视化更有效。

### 4.2 对我们的约束

1. 不能宣称"玩完就会急救"或"替代培训"。产品定位写死为**训练入口、情境判断训练、复盘工具**。
2. 成功标准必须以**保持度与迁移**为主，而不是单局分数。
3. 必须内置**前测 / 后测 / 延迟测**的轻量框架，供学校与机构做对照。
4. 与急救/消防机构做**认证衔接**（例如作为 CPR 面授前的预习模块），比自封"有效"更可信。

---

## 5. 对本项目的具体建议

| 设计点 | 建议 | 依据 |
|---|---|---|
| 核心手感 | 资源调度 + 事件并发学 Emergency 4 / 911 Operator | 二者已验证"稀缺资源 + 多事件"的张力 |
| 规划阶段 | 引入"侦察预算"，每次侦察消耗时间/资源 | Stop Disasters 的预算约束是有效教学杠杆 |
| 执行阶段 | 保留 MGS 式"威胁可读 + 可压制"，不做写实 3D | 硬件门槛与开发成本 |
| 单点操作 | 学 Lifesaver 的"决策—即时后果"，但加可重复判定 | 教育需要可量化证据 |
| 复盘 | 学 FüSim 的讲评结构，逐动作对标准 | 专业训练系统的成熟做法 |
| 评估导出 | DebriefCard（JSON）+ xAPI 语句，可选 SCORM 包装 | 便于学校 LMS 与第三方评估 |
| 技术栈 | PixiJS 或 LittleJS + 自研确定性 sim；Vite 单文件 | <2MB / 60fps / 离线 |
| 仿真标定 | CFAST + JuPedSim 离线标定，不打包 | 精度与许可的双重约束 |
| 内容合规 | IFRC 指南署名；国标逐条核验；不复制 NFPA | 公益产品的可信度 |

---

## 6. 待办

1. 渲染栈 spike：PixiJS vs LittleJS，测 bundle 体积、1080p 集显帧率、粒子/烟层表现。
2. 收集垂直切片 10–12 条知识锚点的原始标准文本，登记条款号。
3. 用 CFAST 跑 2–3 个老楼户型，产出烟气分层与温度参考曲线。
4. 用 JuPedSim 标定楼梯间与窄巷的人群流量。
5. 接触 1–2 家机构（消防/红十字/学校）确认专家评审与合作路径。

---

## 7. 来源

- Gamified Disaster Education. A Systematic Review of Serious Games on Dealing with Natural Hazards — https://egusphere.copernicus.org/preprints/2026/egusphere-2026-2372/
- Effectiveness of Gamified Teaching in Disaster Nursing Education: Systematic Review — https://pmc.ncbi.nlm.nih.gov/articles/PMC12266611/
- Enhancing flood disaster education for children through gamified learning — https://www.frontiersin.org/journals/sustainability/articles/10.3389/frsus.2026.1780679/full
- Using serious games for CPR training: meta-analysis and systematic review — https://pmc.ncbi.nlm.nih.gov/articles/PMC12916568/
- Immersive VR Serious Games for Evacuation Training: Systematic Literature Review — https://arxiv.org/pdf/1805.09138
- Stop Disasters Game expands to 11 languages — https://www.undrr.org/news/stop-disasters-game-expands-11-languages-and-new-learning-spaces
- A year in review: The Stop Disasters game travels around the world — https://www.preventionweb.net/news/year-review-stop-disasters-game-travels-around-world
- Stop Disasters Game 机制解析 — https://polylusion.com/blog/stop-disasters-game
- 911 Operator Review — https://www.choicestgames.com/2025/08/911-operator-review.html
- EMERGENCY 4 Deluxe — https://store.steampowered.com/app/757210/E?l=russian
- Firefighting Simulator: Ignite（Steam） — https://store.steampowered.com/app/1669480/_
- Emergency Call – The Firefighting Simulation 3（Steam） — https://store.steampowered.com/app/3447070
- Lifesaver（Resuscitation Council UK） — https://www.resus.org.uk/public-resource/how-we-save-lives/lifesaver-learning/lifesaver
- Lifesaver / e-Lifesaver 说明 — https://www.resus.org.uk/additional-guidance/guidance-cpr
- Inside the Haiti Earthquake — https://insidedisaster.com/awards-response
- Zero Hour: Virtual Heroes Uses Unreal Engine 3 for Real EMS Training — https://www.unrealengine.com/es-ES/blog/zero-hour
- FüSim on Fire: Digital Training for Fire Service Leaders — https://hpi.de/artikel/fuesim-on-fire-digitales-training-fuer-feuerwehr-fuehrungskraefte/
- HEAT: open-source 3D game engine for emergency response training — https://scispace.com/pdf/iterations-of-an-open-source-3d-game-engine-multiplayer-449lkm1dra.pdf
- 全民消防安全学习云平台（应急管理部消防救援局） — https://js.119.gov.cn/202011/eeff7a174ac648a59677986317a74da2_c_1d2a3ec4530f4bf6b47c.html
- 国家应急管理科普库正式上线 — https://www.mem.gov.cn/xw/yjglbgzdt/202606/t20260616_607846.shtml
- NIST FDS and Smokeview — https://www.nist.gov/services-resources/software/fds-and-smokeview
- NIST CFAST（Advanced Fire Modeling） — https://www.nist.gov/programs-projects/advanced-fire-modeling
- Cell2Fire — https://github.com/cell2fire/cell2fire
- ForeFire — https://ost.ecosyste.ms/projects/175588
- JuPedSim — https://www.jupedsim.org/stable/
- Vadere — https://arxiv.org/pdf/1907.09520v1
- rot.js — https://www.npmjs.com/package/rot-js
- PixiJS — https://pixijs.com/guides/basics/what-pixijs-is
- Phaser vs Kaplay vs Excalibur — https://phaser.io/news/2026/04/phaser-vs-kaplay-vs-excalibur-2d-web-game-framework
- LittleJS — https://killedbyapixel.github.io/LittleJS/docs/
- KAPLAY — https://www.npmjs.com/search?q=keywords%3A%22game%20development%22
- xAPI（IEEE 9274.1.1-2023） — https://xapi.com/overview/
- IFRC International First Aid, Resuscitation and Education Guidelines — https://www.ifrc.org/document/international-first-aid-resuscitation-and-education-guidelines
- START Triage — https://www.start-triage.com/start-certification-programs-getting-your-organization-ready/
- METASTART 系统综述 — https://www.cambridge.org/core/services/aop-cambridge-core/content/view/9780160ABB6FD77AAAA941155C4A310E/S1049023X2100131Xa.pdf/metastart_a_systematic_review_and_metaanalysis_of_the_diagnostic_accuracy_of_the_simple_triage_and_rapid_treatment_start_algorithm_for_disaster_triage.pdf
- 国家标准全文公开 — https://openstd.samr.gov.cn/bzgk/gb
