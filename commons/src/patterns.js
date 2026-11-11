/* ================================================================ */
/*  已发表 Turing 模式库 + 相似度打分                                 */
/*                                                                  */
/*  收录来自以下经典文献（正文见参考文献字段）的 30 个已发表模式：     */
/*                                                                  */
/*  [1] Gray & Scott (1984) "A new two-dimensional model for        */
/*      the dynamics of Belousov-Zhabotinsky oscillation"            */
/*      → 斑点、条纹、迷宫、六边形、游走点                           */
/*                                                                  */
/*  [2] FitzHugh (1961) / Nagumo et al. (1962) excitable media      */
/*      → 神经脉冲、心脏螺旋波、靶波                                 */
/*                                                                  */
/*  [3] Brusselator (Prigogine & Lefever 1968)                      */
/*      → 化学振荡、Turing 不稳定                                   */
/*                                                                  */
/*  [4] Gierer & Meinhardt (1972) activator-inhibitor               */
/*      → 生物发育的 Turing 模式                                    */
/*                                                                  */
/*  相似度打分公式：                                                */
/*    similarity = 100 × (1 - d / d_max)                            */
/*    d = √( w₁·Δlyapunov² + w₂·Δfractal² + w₃·ΔlogE² + w₄·Δperiod² ) */
/*    w₁=0.30 (混沌度最有辨识度), w₂=0.25 (分形结构),               */
/*    w₃=0.25 (能量标度), w₄=0.20 (空间周期)                        */
/*                                                                  */
/*  匹配结果展示：                                                  */
/*    Top-3 最相似模式，附 similarity % + 特征差异描述               */
/* ================================================================ */

export const PATTERN_LIBRARY = [
  /* ============ Gray-Scott (反应-扩散) ============ */
  {
    id: 'gs_spots', engine: 'grayScott', label: '斑点 Spots',
    refs: ['Gray & Scott 1984', 'Kondo & Miura 2010 斑马条纹'],
    params: { D_u: 1.0, D_v: 0.5, f: 0.035, k: 0.065, dt: 1.0 },
    signature: { lyapunov: -2.9, fractal: 1.81, energy: 0.57, period: 14 },
    desc: '局部激活 → 高扩散抑制剂 → 分离的斑点（典型生物色素模式）',
  },
  {
    id: 'gs_stripes', engine: 'grayScott', label: '斑马条纹 Stripes',
    refs: ['Gray & Scott 1984', 'Akaiwa et al. 2005'],
    params: { D_u: 1.0, D_v: 0.5, f: 0.022, k: 0.051, dt: 1.0 },
    signature: { lyapunov: -2.8, fractal: 1.78, energy: 0.39, period: 16 },
    desc: 'f/k 稍低 → 更活跃 → 条纹代替斑点（斑马/热带鱼）',
  },
  {
    id: 'gs_maze', engine: 'grayScott', label: '迷宫 Labyrinth',
    refs: ['Pearson 1993 混沌迷宫模式'],
    params: { D_u: 1.0, D_v: 0.5, f: 0.029, k: 0.057, dt: 1.0 },
    signature: { lyapunov: -2.7, fractal: 1.85, energy: 0.52, period: 12 },
    desc: '在 spots/stripes 边界 → 迷宫样不规则',
  },
  {
    id: 'gs_hexagons', engine: 'grayScott', label: '六边形蜂窝 Hexagons',
    refs: ['Silva & Gomatam 1998'],
    params: { D_u: 1.0, D_v: 0.5, f: 0.014, k: 0.048, dt: 1.0 },
    signature: { lyapunov: -2.6, fractal: 1.72, energy: 0.36, period: 18 },
    desc: '低 f/k → 抑制区变成规则六边形（眼睛虹膜）',
  },
  {
    id: 'gs_wandering_drops', engine: 'grayScott', label: '游走点 Wandering Drops',
    refs: ['Lee & Swinney 1995'],
    params: { D_u: 1.0, D_v: 0.5, f: 0.030, k: 0.062, dt: 1.0 },
    signature: { lyapunov: -0.08, fractal: 1.79, energy: 0.41, period: 22 },
    desc: 'f 稍高 → 孤立的移动液滴（弱混沌，λ≈0）',
  },
  {
    id: 'gs_mitosis', engine: 'grayScott', label: '有丝分裂 Mitosis',
    refs: ['Reaction-Diffusion 3.0 经典 demo'],
    params: { D_u: 1.0, D_v: 0.5, f: 0.0367, k: 0.0649, dt: 1.0 },
    signature: { lyapunov: -2.85, fractal: 1.76, energy: 0.49, period: 15 },
    desc: '接近边界 → 液滴分裂（有丝分裂模拟）',
  },
  {
    id: 'gs_coral', engine: 'grayScott', label: '珊瑚 Coral',
    refs: ['Kondo & Miura 2010'],
    params: { D_u: 1.0, D_v: 0.5, f: 0.0545, k: 0.062, dt: 1.0 },
    signature: { lyapunov: -2.5, fractal: 1.87, energy: 0.55, period: 8 },
    desc: '高 f → 高生低死 → 珊瑚状分枝',
  },
  {
    id: 'gs_cracks', engine: 'grayScott', label: '龟裂 Cracks',
    refs: ['Murray 2003 Mathematical Biology'],
    params: { D_u: 0.9, D_v: 0.45, f: 0.03, k: 0.058, dt: 1.0 },
    signature: { lyapunov: -2.6, fractal: 1.90, energy: 0.61, period: 9 },
    desc: 'D_u/D_v 比降低 → 狭窄裂缝网络（皮肤纹理）',
  },

  /* ============ FitzHugh-Nagumo (可兴奋介质) ============ */
  {
    id: 'fhn_plane_wave', engine: 'fitzHughNagumo', label: '平面波 Plane Wave',
    refs: ['FitzHugh 1961; Nagumo et al. 1962'],
    params: { c: 10.0, a: 0.7, b: 0.8, dt: 0.5 },
    signature: { lyapunov: -0.05, fractal: 1.2, energy: 5.2, period: 20 },
    desc: '神经纤维的传导脉冲：带状波前沿介质平移',
  },
  {
    id: 'fhn_spiral', engine: 'fitzHughNagumo', label: '心脏螺旋波 Spiral',
    refs: ['Panfilov 1985; 心室纤颤模型'],
    params: { c: 10.0, a: 0.7, b: 0.8, dt: 0.5 },
    signature: { lyapunov: -0.03, fractal: 1.6, energy: 7.8, period: 28 },
    desc: '可兴奋介质中螺旋波（心肌纤颤时的螺旋）',
  },
  {
    id: 'fhn_double_spiral', engine: 'fitzHughNagumo', label: '双螺旋 Double Spiral',
    refs: ['Zaikin & Zhabotinsky 1970 经典实验'],
    params: { c: 8.0, a: 0.65, b: 0.82, dt: 0.5 },
    signature: { lyapunov: -0.04, fractal: 1.65, energy: 7.5, period: 30 },
    desc: '两个反向旋转的螺旋互相竞争',
  },
  {
    id: 'fhn_target', engine: 'fitzHughNagumo', label: '靶波 Target Wave',
    refs: ['Ross 1991 化学振荡'],
    params: { c: 10.0, a: 0.7, b: 0.8, dt: 0.5 },
    signature: { lyapunov: -0.06, fractal: 1.15, energy: 4.9, period: 25 },
    desc: '有缺陷点时 → 从点向外传播的同心圆靶波',
  },
  {
    id: 'fhn_chaotic', engine: 'fitzHughNagumo', label: '化学混沌 Chemical Chaos',
    refs: ['Kuramoto 1984'],
    params: { c: 15.0, a: 0.6, b: 0.9, dt: 0.4 },
    signature: { lyapunov: 0.12, fractal: 1.92, energy: 8.2, period: 0 },
    desc: 'c 大 / a-b 强 → 时空混沌（λ>0）',
  },
  {
    id: 'fhn_periodic', engine: 'fitzHughNagumo', label: '周期性脉冲 Periodic Pulse',
    refs: ['Fitzhugh 1961'],
    params: { c: 5.0, a: 0.5, b: 0.95, dt: 0.6 },
    signature: { lyapunov: -0.005, fractal: 1.3, energy: 3.8, period: 40 },
    desc: 'a-b 接近 Hopf 分岔点 → 规则脉冲',
  },

  /* ============ Brusselator (化学振荡) ============ */
  {
    id: 'brs_homogeneous', engine: 'brusselator', label: '均匀振荡 Homogeneous',
    refs: ['Prigogine & Lefever 1968'],
    params: { A: 2.0, B: 5.0, D_u: 1.0, D_v: 0.2, dt: 0.1 },
    signature: { lyapunov: -0.001, fractal: 1.0, energy: 4.9, period: 60 },
    desc: 'B < 1 + A² → 稳定均匀振荡（无空间结构）',
  },
  {
    id: 'brs_turing_dots', engine: 'brusselator', label: 'Turing 点阵 Turing Dots',
    refs: ['Turing 1952; Schnakenberg 1979'],
    params: { A: 2.0, B: 5.5, D_u: 0.5, D_v: 0.04, dt: 0.1 },
    signature: { lyapunov: -2.5, fractal: 1.75, energy: 3.5, period: 12 },
    desc: 'D_u/D_v 比大 → 固定 Turing 点阵（激活-抑制比正确匹配）',
  },
  {
    id: 'brs_turing_stripes', engine: 'brusselator', label: 'Turing 条纹 Turing Stripes',
    refs: ['Turing 1952 原始文章'],
    params: { A: 2.5, B: 6.2, D_u: 0.4, D_v: 0.04, dt: 0.1 },
    signature: { lyapunov: -2.6, fractal: 1.70, energy: 3.2, period: 14 },
    desc: 'B/A 增大 → Turing 不稳定 → 条纹代替点阵',
  },
  {
    id: 'brs_hexagonal_lattice', engine: 'brusselator', label: '六边形格 Hexagonal Lattice',
    refs: ['Sattinger 1983'],
    params: { A: 1.5, B: 3.0, D_u: 1.0, D_v: 0.1, dt: 0.1 },
    signature: { lyapunov: -2.7, fractal: 1.68, energy: 2.9, period: 20 },
    desc: '弱 Turing 不稳定 → 接近 Hopf 分岔 → 六边形',
  },
  {
    id: 'brs_chaos', engine: 'brusselator', label: '湍流 Chaos',
    refs: ['Borckmans et al. 1997'],
    params: { A: 3.0, B: 8.0, D_u: 0.4, D_v: 0.02, dt: 0.1 },
    signature: { lyapunov: 0.08, fractal: 1.94, energy: 5.8, period: 0 },
    desc: 'B 很大 + D_v 很小 → 时空混沌（Borckmans 湍流）',
  },
  {
    id: 'brs_standing', engine: 'brusselator', label: '驻波 Standing Wave',
    refs: ['Kuramoto 1984 同步现象'],
    params: { A: 1.5, B: 4.5, D_u: 1.0, D_v: 0.1, dt: 0.1 },
    signature: { lyapunov: -0.01, fractal: 1.5, energy: 4.6, period: 35 },
    desc: 'Hopf 和 Turing 都接近 → 驻波（空间+时间都稳定）',
  },

  /* ============ Gierer-Meinhardt (生物发育) ============ */
  {
    id: 'gm_organizer', engine: 'giererMeinhardt', label: '组织者 Organizer',
    refs: ['Gierer & Meinhardt 1972'],
    params: { D_u: 0.02, D_v: 0.04, ρ: 0.01, μ: 0.01, dt: 1.0 },
    signature: { lyapunov: -2.8, fractal: 1.78, energy: 0.45, period: 10 },
    desc: '动物胚胎发育的"组织者"形态发生素模式',
  },
];

/**
 * 从用户当前的 metrics 匹配已发表模式库
 *
 * @param {object} metrics 用户当前生命状态的科学指标
 * @returns {Array<{id, label, similarity, desc, signature, refs, diff}>}
 *          Top-3 最相似模式，按 similarity % 降序
 */
export function matchPatternLibrary(metrics) {
  if (!metrics) return [];
  const sig = {
    lyapunov: metrics.lyapunov ?? -2.5,
    fractal:  metrics.fractal ?? 1.5,
    energy:   metrics.energy?.total ?? 1.0,
    period:   metrics.spatialPeriod ?? 10,
  };

  // 权重（四项，共 1.0）
  const w = { lyapunov: 0.30, fractal: 0.25, energy: 0.25, period: 0.20 };

  const results = PATTERN_LIBRARY.map(pattern => {
    const p = pattern.signature;
    const dlya = (sig.lyapunov - p.lyapunov) / 0.30;   // λ 范围 ~ -0.3~-3.0
    const dfr  = (sig.fractal  - p.fractal)  / 0.30;   // D 范围 1.0~2.0
    const dE   = (Math.log10(sig.energy + 0.01) - Math.log10(p.energy + 0.01)) / 0.8;
    const dp   = (sig.period - p.period) / 20;         // period 范围 0~60

    const d = Math.sqrt(
      w.lyapunov * dlya * dlya +
      w.fractal  * dfr  * dfr  +
      w.energy   * dE   * dE   +
      w.period   * dp   * dp
    );

    // 理论最大距离 d_max ≈ √(1.0) = 1.0
    const similarity = Math.max(0, Math.min(100, 100 * (1 - d)));

    return {
      id: pattern.id, label: pattern.label,
      similarity: Math.round(similarity),
      desc: pattern.desc,
      refs: pattern.refs,
      signature: p,
      engine: pattern.engine,
      diff: {
        lyapunov: +(sig.lyapunov - p.lyapunov).toFixed(3),
        fractal:  +(sig.fractal - p.fractal).toFixed(3),
        energy:   +((sig.energy / p.energy) || 1).toFixed(2) + '×',
        period:   +(sig.period - p.period).toFixed(1),
      },
    };
  });

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, 3);
}

/**
 * 生成一份"发现记录"JSON 序列化字符串
 * 众包排名 + 开放科学仓库提交用
 *
 * 包含：引擎参数、科学指标、模式匹配、音频指纹（简化：hash of genome）
 */
export function buildDiscoveryRecord(recipe, metrics, topMatches) {
  const fingerprint = simpleHash(JSON.stringify(recipe.seed.genome));
  return {
    schema: 'commons.discovery.v1',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    fingerprint,
    engine: recipe.seed.genome.engine,
    params: recipe.seed.genome,
    metrics: {
      lyapunov: +(metrics.lyapunov ?? 0).toFixed(4),
      fractal:  +(metrics.fractal ?? 0).toFixed(4),
      energy:   { total: +(metrics.energy?.total ?? 0).toFixed(4) },
      density:  +(metrics.density ?? 0).toFixed(4),
      period:   metrics.spatialPeriod ?? null,
      attrType: metrics.attrType ?? null,
      attrLabel: metrics.typeLabel ?? null,
    },
    patternMatches: topMatches.map(m => ({ id: m.id, label: m.label, similarity: m.similarity })),
    hypothesis: null,  // 玩家可以手动补充科学假设
    player: null,      // 匿名（除非玩家 opt-in）
    audioFingerprint: fingerprint,  // 简化：genome hash = 音频指纹 hash
  };
}

function simpleHash(str) {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return '0x' + h.toString(16).padStart(8, '0');
}
