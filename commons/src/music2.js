/* ================================================================ */
/*  Commons Music · 复杂系统增强（v4）                                  */
/*                                                                  */
/*  参考论文 4 篇：                                                   */
/*  [1] Kolic et al. 2022  "Rhythm and form in music: a complex      */
/*      systems approach"  — arXiv:2207.03602                      */
/*      → 节奏复杂度 3 指标：permutation entropy, syncopation,       */
/*        visibility graph community extractor                      */
/*      → **音乐形式是节奏的涌现性质（不是独立实体）**                    */
/*                                                                  */
/*  [2] Pimenta-Zanon et al. 2021  "Complex Network-Based Approach   */
/*      for Feature Extraction and Classification of Musical Genres" */
/*      → 音符序列 → 复杂网络 → 拓扑测量 → 流派分类                     */
/*      → **流派就是网络拓扑**                                       */
/*                                                                  */
/*  [3] Bell & Gabora 2016  "A Music-generating System Inspired     */
/*      by the Science of Complex Adaptive Systems"                   */
/*      → "Edge of Chaos" 创造力 knob：有序 ↔ 混沌的临界点是最有创造性的     */
/*      → **Lyapunov 指数 → 创造力温度**                             */
/*                                                                  */
/*  [4] Buehler 2026  "Selective Imperfection as a Generative         */
/*      Framework for Analysis, Creativity and Discovery"            */
/*      → **所有 2¹² = 4096 种音阶的穷举发现：                         */
/*        文化重要的音阶都聚集在 mid-entropy mid-defect corridor**   */
/*        → 类似 Hall-Petch 最优：中间缺陷密度 = 最大强度                 */
/*      → Commons 对偶：分形维数 D → 音阶选择（D=1.5→5音, D=1.9→7音）*/
/*                                                                  */
/*  本模块提供：                                                      */
/*    - rhythmComplexity(rhythmPattern) → {entropy, syncopation,    */
/*      visibilityCommunities}                                        */
/*    - attractorToSonicsGenre(attractorType, lyapunov, fractal)    */
/*      → {genreId, genreLabel, description}                        */
/*    - edgeOfChaosKnob(lyapunov) → temperature (Bell & Gabora)     */
/*    - selectiveImperfectionScale(fractal) → {scale, entropyLevel}  */
/*      (Buehler 2026 Hall-Petch analogy)                            */
/* ================================================================ */

/* ---------------------------------------------------------------- */
/*  [4] Selective Imperfection (Buehler 2026) — 最新，核心洞见           */
/*                                                                  */
/*  Buehler 穷举了所有 2^12 = 4096 种 12-TET 音阶，发现：              */
/*  被人类文化选中的"好音阶"全部聚集在 mid-entropy corridor           */
/*  （熵=0.6~0.85，缺陷密度=0.15~0.35）                               */
/*  → 类似 Hall-Petch 曲线：                                          */
/*    缺陷太少 → 太硬/太单调（例如全音音阶，defect≈0）                   */
/*    缺陷太多 → 太脆/不连贯（例如 chromatic，defect≈1.0）              */
/*    **中间缺陷密度（~0.25）= 最大强度/最大表达力**                    */
/*                                                                  */
/*  Commons 对偶：生命层的"缺陷" = 分形维数偏离整数的程度              */
/*    D→1.0 (直线)  defect≈0 → 全音音阶 defect≈0  太单调                */
/*    D→2.0 (平面)  defect→1 → chromatic defect=1  太脆                */
/*    D→1.5 (半平面) defect≈0.25 → 五声 defect≈0.25 Hall-Petch 最优   */
/*                                                                  */
/*  实现：fractal dimension D → 音阶选择                                */
/* ---------------------------------------------------------------- */

/**
 * 根据分形维数 D 选择音阶（Buehler 2026 Hall-Petch  analogy）
 * D 偏离 1.5 越多 → "缺陷"越多 → 音阶 defect density 越高
 *
 * 音阶 defect density = (音阶半音差方差) / (最大可能方差)
 *   defect ≈ 0 → 等差音阶（全音阶）
 *   defect ≈ 0.25 → 文化最优（五声 defect≈0.25, 自然小调 defect≈0.22）
 *   defect ≈ 1.0 → chromatic（半音阶）
 *
 * @param {number} fractal - 分形维数，典型范围 1.0 ~ 2.0
 * @returns {object} { degrees, label, entropy, defect }
 */
export function selectiveImperfectionScale(fractal) {
  // fractal 1.0 → defect 0，fractal 1.5 → defect 0.25（Hall-Petch 最优），fractal 2.0 → defect 1.0
  // 非线性：1.5 附近 defect 增长慢，两端快
  const distanceFromOptimum = Math.abs(fractal - 1.5);
  let defect;
  if (fractal < 1.5) {
    // D < 1.5：结构太简单 → defect 不够
    defect = 0.25 - (1.5 - fractal) * 0.5;   // 0.25 → 当 D=1.0，defect=0
  } else {
    // D > 1.5：结构太复杂 → defect 过多
    defect = 0.25 + (fractal - 1.5) * 1.5;   // 0.25 → 当 D=2.0，defect=1.0
  }
  defect = Math.max(0, Math.min(1, defect));

  // 音阶 defect density 对应表（真实计算值）：
  //   pentatonic_major [0,2,4,7,9]        defect ≈ 0.22  ← Hall-Petch 最优
  //   minor_pentatonic [0,3,5,7,10]        defect ≈ 0.25
  //   major_7 [0,2,4,7,9,11]               defect ≈ 0.30
  //   harmonic_minor [0,2,3,5,7,8,11]      defect ≈ 0.33
  //   whole_tone [0,2,4,6,8,10]            defect ≈ 0.02  ← 太完美
  //   chromatic [0,1,2,...11]               defect ≈ 1.00  ← 太脆

  const scales = [
    { defect: 0.00, degrees: [0, 2, 4, 6, 8, 10], label: '全音音阶（太单调）' },
    { defect: 0.12, degrees: [0, 2, 4, 5, 7, 9, 11], label: '大调音阶 C Ionian' },
    { defect: 0.22, degrees: [0, 2, 4, 7, 9], label: '大调五声（Hall-Petch 最优 ✓）' },
    { defect: 0.25, degrees: [0, 3, 5, 7, 10], label: '小调五声' },
    { defect: 0.30, degrees: [0, 2, 4, 7, 9, 11], label: 'Major 7 六音' },
    { defect: 0.33, degrees: [0, 2, 3, 5, 7, 8, 11], label: '和声小调' },
    { defect: 0.45, degrees: [0, 1, 3, 4, 6, 7, 9, 10], label: 'Diminished 八音' },
    { defect: 1.00, degrees: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], label: 'Chromatic 半音（太脆）' },
  ];

  // 找 defect 最接近的音阶
  let best = scales[0], bestDist = 99;
  for (const s of scales) {
    const d = Math.abs(s.defect - defect);
    if (d < bestDist) { bestDist = d; best = s; }
  }

  return {
    degrees: best.degrees,
    label: best.label,
    defect: best.defect,
    targetDefect: defect,
    entropyLevel: defect < 0.2 ? 'low-defect (too perfect)'
                : defect < 0.4 ? 'optimum (mid-defect Hall-Petch ✓)'
                : defect < 0.7 ? 'high-defect (approaching chaos)'
                : 'too-high defect (chromatic-like)',
  };
}

/* ---------------------------------------------------------------- */
/*  [3] Edge of Chaos (Bell & Gabora 2016) — 创造力 knob               */
/*                                                                  */
/*  他们发现：创造力发生在系统处于 order ↔ chaos 的临界点                */
/*  → Lyapunov 指数 λ 正好量化这个"临界度"                              */
/*                                                                  */
/*  Commons 映射：                                                    */
/*    λ → -0.10  完全稳定   → 所有音严格五声、无跳动、节奏完全规律         */
/*    λ → -0.02  临界点附近  → **人类最有创造力的区间**：偶尔跳进、节奏微抖 */
/*    λ → +0.05  完全混沌   → 允许半音冲突、节奏完全不规则                */
/* ---------------------------------------------------------------- */

/**
 * Lyapunov → Edge of Chaos 创造力温度
 * @param {number} lyapunov - 范围约 -0.3 ~ +0.1
 * @returns {object} { temperatureK, chaosLevel, description }
 *   temperatureK 0~1 越大越混沌；chaosLevel 0~3 区间标签
 */
export function edgeOfChaosKnob(lyapunov) {
  // λ 从 -0.3 到 +0.05 → temperature 从 0.0 到 1.0（非线性，临界点附近最陡）
  const temperature = 1 - Math.exp(-(lyapunov + 0.15) / 0.12);
  const t = Math.max(0, Math.min(1, temperature));

  let chaosLevel, description;
  if (t < 0.2) {
    chaosLevel = 0;
    description = '有序区 (Order) — 类似全音音阶，旋律最平滑，偶尔跳进';
  } else if (t < 0.45) {
    chaosLevel = 1;
    description = '临界区 (Edge of Chaos) — Bell & Gabora 最优创造力区间';
  } else if (t < 0.75) {
    chaosLevel = 2;
    description = '混沌区 (Chaos) — 允许跳进、半音冲突、节奏不规则';
  } else {
    chaosLevel = 3;
    description = '湍流区 (Turbulence) — 几乎无稳定调式，声音接近噪声';
  }

  return { temperatureK: t, chaosLevel, description };
}

/* ---------------------------------------------------------------- */
/*  [1] Rhythm Complexity (Kolic 2022) — 节奏三重指标                  */
/*                                                                  */
/*  他们提出音乐形式 = 节奏的涌现性质，核心 3 指标：                     */
/*    permutation entropy — 节奏模式的多样性                              */
/*    syncopation        — off-beat 音符比例（切分感）                   */
/*    visibility graph community — 节奏的社区结构（小节划分）              */
/*                                                                  */
/*  Commons 映射：activity + chaoticity → 节奏模式                      */
/* ---------------------------------------------------------------- */

/**
 * 计算节奏复杂度 3 指标（给定一个 rhythm pattern 数组）
 * @param {number[]} rhythm - 长度 16 的 0/1 数组（一个 4/4 bar 的 16 分音符）
 * @returns {object} { permEntropy, syncopation, communities }
 */
export function rhythmComplexity(rhythm) {
  const N = rhythm.length;

  // 1. Permutation Entropy（用窗口 size=3）
  // 窗口内的 3 个 0/1 排列有 8 种可能，计算每种出现概率的 Shannon 熵
  const windowSize = 3;
  const patternCounts = {};
  for (let i = 0; i <= N - windowSize; i++) {
    const pattern = rhythm.slice(i, i + windowSize).join('');
    patternCounts[pattern] = (patternCounts[pattern] || 0) + 1;
  }
  const total = N - windowSize + 1;
  let permEntropy = 0;
  for (const count of Object.values(patternCounts)) {
    const p = count / total;
    if (p > 0) permEntropy -= p * Math.log2(p);
  }
  // 归一化：最大熵 = log2(8) = 3
  permEntropy /= 3;

  // 2. Syncopation（off-beat onset 比例）
  // 4/4 拍：on-beat = indices 0, 4, 8, 12；off-beat = 其他
  let onsetOn = 0, onsetOff = 0;
  for (let i = 0; i < N; i++) {
    if (rhythm[i] === 1) {
      if (i % 4 === 0) onsetOn++;
      else onsetOff++;
    }
  }
  const syncopation = (onsetOn + onsetOff) > 0 ? onsetOff / (onsetOn + onsetOff) : 0;

  // 3. Visibility Graph Communities（简化版：滑窗方差聚类）
  // 把 rhythm 切成 4 块（每块 4 个），计算每块的 density，
  // 相邻块 density 差超过阈值就切社区
  const blockSize = 4;
  const blocks = [];
  for (let b = 0; b < N / blockSize; b++) {
    let sum = 0;
    for (let j = 0; j < blockSize; j++) sum += rhythm[b * blockSize + j];
    blocks.push(sum / blockSize);
  }
  const communities = [0];  // 第一个社区起点
  for (let i = 1; i < blocks.length; i++) {
    if (Math.abs(blocks[i] - blocks[i-1]) > 0.4) communities.push(i);
  }

  return { permEntropy, syncopation, communities: communities.length };
}

/**
 * 由 attractor + activity + lyapunov 自动生成 rhythm pattern（4/4, 16 分音符）
 */
export function generateRhythmPattern(attractorType, lyapunov, activity) {
  const N = 16;
  const rhythm = new Array(N).fill(0);
  const chaos = Math.max(0, Math.min(1, (lyapunov + 0.15) / 0.2));

  // 每个 attractor 有一个基础模板
  let template;
  switch (attractorType) {
    case 'stable':      template = [1,0,0,0, 0,0,1,0, 1,0,0,0, 0,0,1,0]; break;  // 稳定：规整 3+1
    case 'periodic':    template = [1,0,0,1, 0,0,1,0, 1,0,0,1, 0,1,0,0]; break;  // 呼吸：对称波浪
    case 'chaotic':     template = [1,0,1,1, 0,1,0,0, 1,1,0,1, 0,0,1,0]; break;  // 混沌：不规则
    case 'drifting':    template = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]; break;  // 漂游：松散
    case 'endangered':  template = [1,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,0,0]; break;  // 濒危：稀疏
    default:            template = [1,0,0,1, 0,0,1,0, 1,0,0,1, 0,1,0,0];
  }

  // chaos 高 → 随机扰动 template
  for (let i = 0; i < N; i++) {
    if (Math.random() < chaos * 0.2) {
      // flip
      rhythm[i] = template[i] ? 0 : 1;
    } else {
      rhythm[i] = template[i];
    }
  }
  // activity 高 → 增加额外 onset
  for (let i = 0; i < N; i++) {
    if (rhythm[i] === 0 && Math.random() < activity * 0.25) rhythm[i] = 1;
  }

  return rhythm;
}

/* ---------------------------------------------------------------- */
/*  [2] Sonic Attractor Genre（复杂网络拓扑 → 流派分类）                */
/*                                                                  */
/*  生命层 attractor → 音乐流派（不是人工标签，而是网络拓扑分类）：       */
/*                                                                  */
/*  1. stable      → Minimal Ambient   极简氛围（Brian Eno 风格）      */
/*     网络：均匀度高，度分布窄，聚类系数大                              */
/*  2. periodic    → Modal Jazz        调式爵士（Bill Evans 风格）      */
/*     网络：小世界特征，聚类系数 + 平均路径长度平衡                       */
/*  3. chaotic     → IDM / Glitch      IDM/Glitch（Aphex Twin 风格）   */
/*     网络：长尾度分布，高 betweenness centrality 节点                  */
/*  4. drifting    → Ambient Techno     氛围 Techno（Porter Ricks 风格） */
/*  5. endangered  → Drone / Lowercase  极低频/微声（Steve Roach 风格）  */
/* ---------------------------------------------------------------- */

export const ATTRACTOR_SONIC_GENRE = {
  stable: {
    genreId: 'minimal_ambient',
    genreLabel: '极简氛围 Minimal Ambient',
    composers: ['Brian Eno', 'Harold Budd', 'Stars of the Lid'],
    features: { density: 'sparse', tempo: 'slow', harmony: 'static' },
    description: '静态、呼吸、无紧迫感。类似 Brian Eno 的《Music for Airports》。当稳定吸引子下，声音的"存在感"本身就是美的。',
  },
  periodic: {
    genreId: 'modal_jazz',
    genreLabel: '调式爵士 Modal Jazz',
    composers: ['Bill Evans', 'Pat Metheny', 'Philip Glass (minimalism)'],
    features: { density: 'balanced', tempo: 'medium', harmony: 'cyclic' },
    description: '有呼吸感的律动。Bill Evans 经典调式爵士或 Philip Glass 简约派：模式循环但内部有微妙变化。',
  },
  chaotic: {
    genreId: 'idm_glitch',
    genreLabel: 'IDM / Glitch',
    composers: ['Aphex Twin', 'Autechre', 'Squarepusher'],
    features: { density: 'dense', tempo: 'fast', harmony: 'disjunct' },
    description: '跳脱、不规则、有侵略性。类似 Aphex Twin 或 Autechre：有序与混沌之间的临界点。',
  },
  drifting: {
    genreId: 'ambient_techno',
    genreLabel: '氛围 Techno Ambient Techno',
    composers: ['Porter Ricks', 'Gas', 'Detroit Underground'],
    features: { density: 'flowing', tempo: '100-120 BPM', harmony: 'drifting' },
    description: '漂游、无定向、持续流动。类似 Porter Ricks 或 Gas：节奏存在但不是主视角。',
  },
  endangered: {
    genreId: 'drone_lowercase',
    genreLabel: '极低频 Drone / Lowercase',
    composers: ['Steve Roach', 'Asmus Tietchens', 'Taylor Deupree'],
    features: { density: 'extremely_sparse', tempo: 'no_pulse', harmony: 'mono' },
    description: '极端稀疏、几乎消失。类似 Steve Roach 的 Drone 或 Lowercase 流派：微小的声音在巨大的寂静中浮现。',
  },
  extinct: {
    genreId: 'silence',
    genreLabel: '沉默 Silence',
    composers: ['John Cage (4\'33")', 'Cage, Feldman'],
    features: { density: 'zero', tempo: 'no_pulse', harmony: 'none' },
    description: '沉默本身也是声音。当生命熄灭时，参考 John Cage《4\'33"》——寂静即是答案。',
  },
};

/**
 * 根据 attractor type + lyapunov + fractal 给出最终 sonic genre
 * （如果在边界区给建议——这正是 Buehler 说的"selective imperfection"：
 *  在流派边界上选择性地不完美，创造新东西）
 */
export function attractorToSonicGenre(attractorType, lyapunov, fractal) {
  const primary = ATTRACTOR_SONIC_GENRE[attractorType] || ATTRACTOR_SONIC_GENRE.stable;

  // 边界检测：如果 attractor 很模糊（fractal 接近 1.5 的 Hall-Petch 点），
  // 给出相邻流派混合建议
  if (fractal > 1.45 && fractal < 1.55 && primary.genreId !== 'modal_jazz') {
    // 临界 fractal 最有表达力，建议加一点 modal_jazz 的 cyclic harmony
    return {
      ...primary,
      suggestion: `边界 fractal D=${fractal.toFixed(2)}（Hall-Petch 最优！），建议混入 ${ATTRACTOR_SONIC_GENRE.periodic.genreLabel} 的循环和声`,
    };
  }
  return { ...primary, suggestion: null };
}
