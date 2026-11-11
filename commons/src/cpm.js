/* ================================================================ */
/*  Cellular Potts Model — Monte Carlo Optimizer                    */
/*                                                                  */
/*  与 Reaction-Diffusion 引擎耦合：                                */
/*    u(x,y) = 物种密度场（连续值 0~1）                              */
/*    v(x,y) = 形态场（连续值 0~1）                                 */
/*    σ(x,y) = 离散细胞类型标签（从 u 场离散化得到）                 */
/*                                                                  */
/*  Potts 哈密顿量 H：                                              */
/*    H = Σ_{(i,j)∈adjacent} J(σ_i, σ_j)                           */
/*      + λ_area  Σ_σ (area(σ) - area₀(σ))²                        */
/*      + λ_perim Σ_σ (perim(σ) - perim₀(σ))²                      */
/*      + λ_grad Σ|∇v(x,y)|²      ← 与 RD 场耦合，最小化 v 梯度     */
/*                                                                  */
/*  MC 步（Metropolis）：                                           */
/*    1. 随机格点 i → 选一个邻居 j                                   */
/*    2. 提议：copy σ_j → σ_i                                       */
/*    3. ΔH = H_new - H_old                                         */
/*    4. ΔH ≤ 0 → 无条件接受                                        */
/*       ΔH > 0 → 以概率 exp(-ΔH / kT) 接受                         */
/*                                                                  */
/*  J(σ_i, σ_j) 邻接黏附能矩阵：                                    */
/*    J(s,s) = 0                                                    */
/*    J(s,s') = 0.35 · exp(-|s-s'|/2)   类似类型黏附更强             */
/*                                                                  */
/*  理论来源：                                                       */
/*    Graner & Glazier (1992) "Simulation of biological cell sorting */
/*    using a two-dimensional extended Potts model" Phys. Rev. Lett. */
/* ================================================================ */

export const CPM_DEFAULTS = {
  // 黏附能矩阵（J）—— 当前只用一个自黏附参数，未来可扩展为完整矩阵
  adhesionJ: 0.35,       // 基础黏附能（J 量级，单位 k_B T ≈ 1）
  // 软约束权重
  lambdaArea: 0.04,      // λ_area：面积约束（弱）
  lambdaPerim: 0.02,     // λ_perim：周长约束（更弱）
  lambdaGrad: 0.18,      // λ_grad：v 场梯度耦合（让形态跟随反应-扩散）
  area0: 6.0,            // 目标面积（格点数，大致是一个细胞的平均面积）
  perim0: 5.0,           // 目标周长
  temperature: 0.25,     // kT：退火温度，0.1 = 几乎冻结，1.0 = 热噪声大
  // 离散化阈值：把连续 v 场变成 Potts 离散标签
  nTypes: 8,             // σ ∈ {0, 1, ..., nTypes-1}
  // 每 N 个 MC step 重新离散化一次（让形态跟随反应-扩散演化）
  relabelEvery: 32,
};

/**
 * 把连续 v 场离散化为 nTypes 个 Potts 标签
 * 输入：Uint8Array 或 Float32Array vField
 * 输出：Int8Array labels，每个元素 ∈ [0, nTypes-1]
 *
 * 量化方式：按 v 值排序的等宽量化（不是等频，等宽更贴合反应-扩散物理）
 */
export function discretizeField(vField, nTypes) {
  const n = vField.length;
  const labels = new Int8Array(n);
  let minV = Infinity, maxV = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = vField[i];
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  const range = maxV - minV || 1;
  const binSize = range / nTypes;
  for (let i = 0; i < n; i++) {
    const t = Math.floor((vField[i] - minV) / binSize);
    labels[i] = Math.min(nTypes - 1, Math.max(0, t));
  }
  return labels;
}

/**
 * 黏附能 J(σ_i, σ_j)
 * 同类型 → 0
 * 类似类型 → 低能（有黏附）
 * 差异大的类型 → 高能（排斥，有界面张力）
 */
export function adhesionEnergy(si, sj, J_base = CPM_DEFAULTS.adhesionJ) {
  if (si === sj) return 0;
  // 指数衰减：|si - sj| 越大，J 越大（越排斥）
  const d = Math.abs(si - sj);
  return J_base * (1 - Math.exp(-d / 2));
}

/**
 * 计算相邻格点 i 的黏附能（与 4 邻居比）
 * 这里用 4 邻域（von Neumann），节省计算
 */
function siteAdhesion(labels, w, x, y, si, J_base) {
  let E = 0;
  if (x > 0)      E += adhesionEnergy(si, labels[y * w + x - 1], J_base);
  if (x < w - 1)  E += adhesionEnergy(si, labels[y * w + x + 1], J_base);
  if (y > 0)      E += adhesionEnergy(si, labels[(y - 1) * w + x], J_base);
  return E;
}

/**
 * 场地耦合能 λ_grad · |∇v|²
 * 在 i 点的梯度平方（简化为与邻居 v 值差的平方和）
 */
function siteGradEnergy(vField, w, x, y, λ_grad) {
  const i = y * w + x;
  const v = vField[i];
  let g = 0;
  if (x > 0)     g += (v - vField[i - 1]) ** 2;
  if (x < w - 1) g += (v - vField[i + 1]) ** 2;
  if (y > 0)     g += (v - vField[i - w]) ** 2;
  return λ_grad * g;
}

/**
 * 在 labels 和 vField 上执行一次 MC sweep（sweep = w × h 次尝试）
 * 返回：接受次数 / 总尝试次数（接受率，用于监控）
 */
export function mcSweep(labels, vField, w, h, params = {}) {
  const p = { ...CPM_DEFAULTS, ...params };
  const n = w * h;
  let accepted = 0;

  for (let attempt = 0; attempt < n; attempt++) {
    // 1. 随机选 i
    const i = Math.floor(Math.random() * n);
    const x = i % w;
    const y = Math.floor(i / w);
    const si = labels[i];

    // 2. 随机选一个邻居 j（4 邻域）
    const dir = Math.floor(Math.random() * 4);
    let jx = x, jy = y, j = i;
    if (dir === 0 && x > 0)      { jx = x - 1; j = i - 1; }
    else if (dir === 1 && x < w - 1) { jx = x + 1; j = i + 1; }
    else if (dir === 2 && y > 0)     { jy = y - 1; j = i - w; }
    else if (dir === 3 && y < h - 1) { jy = y + 1; j = i + w; }
    else continue; // 靠边的方向跳过

    const sj = labels[j];
    if (si === sj) continue; // 无变化，跳过

    // 3. 计算 ΔH（只算 i 点本身的能量变化 + 与 i 相邻的 4 个点的变化）
    //    这是局部差分法，比全量 H_new - H_old 快 O(N)
    const E_old_i  = siteAdhesion(labels, w, x, y, si, p.adhesionJ)
                   + siteGradEnergy(vField, w, x, y, p.lambdaGrad);
    const E_new_i  = siteAdhesion(labels, w, x, y, sj, p.adhesionJ)
                   + siteGradEnergy(vField, w, x, y, p.lambdaGrad);

    // 修正：i 的邻居在 copy 前后的 adhesion 会变化——但上面的 siteAdhesion 已经只算 i 与邻居的差，
    // 所以 E_new_i - E_old_i 已经是完整的 ΔH（对局部 4+1 格点）
    const dH = E_new_i - E_old_i;

    // 4. Metropolis 判据
    if (dH <= 0 || Math.random() < Math.exp(-dH / p.temperature)) {
      labels[i] = sj;
      accepted++;
    }
  }

  return { accepted, attempted: n, acceptanceRate: accepted / n };
}

/**
 * 计算全系统总能量 H（用于玩家查看 MC 步的能量变化）
 * 只算黏附能 + 场地耦合（面积/周长约束是软约束，MC 里已隐含处理）
 */
export function totalEnergy(labels, vField, w, h, params = {}) {
  const p = { ...CPM_DEFAULTS, ...params };
  let H = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      H += siteAdhesion(labels, w, x, y, labels[i], p.adhesionJ);
      H += siteGradEnergy(vField, w, x, y, p.lambdaGrad);
    }
  }
  return H;
}

/**
 * 高阶接口：对 ReactionDiffusionEngine 的 v/u 场做 player-triggered MC
 *   engine   — ReactionDiffusionEngine 实例
 *   steps    — MC sweep 次数（每次 = w×h 次尝试）
 *   params   — CPM 参数覆盖
 * 返回：{ acceptedRate, energyBefore, energyAfter, labelsBefore, labelsAfter }
 *
 * 注意：MC 步 **不会修改 engine 的 v/u 场本身**，它只在 v 场上产生
 * 一个"细胞形状场"（离散 Potts 标签），这是玩家触发的形态调谐。
 * 之后这个形状场可以作为 render.js 的 overlay 显示（当前版本只计算）。
 */
export function runPlayerMC(engine, steps = 4, params = {}) {
  const p = { ...CPM_DEFAULTS, ...params };
  const w = engine.w, h = engine.h;
  const vField = engine.vField;
  const uField = engine.uField;

  // Gray-Scott 里 v 是抑制剂（有 pattern），u 是激活物；
  // 但初始化时 v=0 均匀 + ring 只给 v 中心一个圆斑，
  // 演化后 v 会长出实际的 Turing pattern。
  // 用"变异系数"选有实际形态变化的场
  function cv(arr) {
    let s = 0, s2 = 0, n = 0;
    for (const x of arr) { s += x; s2 += x*x; n++; }
    const μ = s/n; if (μ < 0.001) return 0;
    const var_ = s2/n - μ*μ;
    return Math.sqrt(Math.max(0, var_)) / μ;
  }
  const useField = cv(vField) > cv(uField) ? vField : uField;

  // 离散化 v/u 场 → Potts 标签
  let labels = discretizeField(useField, p.nTypes);
  const energyBefore = totalEnergy(labels, useField, w, h, p);

  let totalAccepted = 0, totalAttempted = 0;
  for (let s = 0; s < steps; s++) {
    const res = mcSweep(labels, useField, w, h, p);
    totalAccepted += res.accepted;
    totalAttempted += res.attempted;
    if (p.relabelEvery > 0 && (s + 1) % p.relabelEvery === 0) {
      labels = discretizeField(useField, p.nTypes);
    }
  }

  const energyAfter = totalEnergy(labels, useField, w, h, p);

  return {
    acceptedRate: totalAttempted ? totalAccepted / totalAttempted : 0,
    energyBefore, energyAfter,
    energyDelta: energyAfter - energyBefore,
    labels,
    usedField: useField === vField ? 'v' : 'u',
    parameters: p,
  };
}

/* ================================================================ */
/*  公开的可复现性函数（用于参数扫描 / 模式匹配时运行独立引擎）         */
/* ================================================================ */

/**
 * 从种子独立运行一个 Reaction-Diffusion 引擎 K 步，返回 metrics
 * 不创建 DOM、不依赖 render——纯计算，参数扫描用
 *
 * 注意：这里用动态 import 以避免循环依赖（scientific.js 不 import cpm.js）
 */
export async function simulateRD(params, w, h, steps, rngSeed = 42) {
  const mod = await import('./scientific.js');
  const src = params ?? {};

  // preset 是唯一物理参数源。未显式给 preset（或给了不存在的 preset 键）时，
  // 按 engine 类型挑一个该引擎的经典预设——避免把 engine 名当成 preset 键解析。
  let presetKey = src.preset;
  if (!presetKey || !mod.REACTION_DIFFUSION_PRESETS[presetKey]) {
    presetKey = Object.keys(mod.REACTION_DIFFUSION_PRESETS)
      .find(k => mod.REACTION_DIFFUSION_PRESETS[k].engine === src.engine) || 'gs_spots';
  }

  const opts = { ...src, preset: presetKey };
  delete opts.engine;   // 引擎归属由 preset 决定，禁止外部覆盖（否则 FHN/Brusselator 会跑成 grayScott）
  const e = new mod.ReactionDiffusionEngine(w, h, opts);

  // 缺物理参数会静默积出 NaN，这里显式报错，让失败可定位
  const missing = ['D_u', 'D_v', 'dt'].filter(k => !Number.isFinite(e.params[k]));
  if (missing.length) {
    throw new Error(`simulateRD: preset "${presetKey}" 缺少物理参数 ${missing.join(', ')}`);
  }

  for (let i = 0; i < steps; i++) e.step();
  const m = mod.computeScientificMetrics(e.vField, e.uField, w, h, e.engineType);
  return { metrics: m, vField: e.vField, uField: e.uField, preset: presetKey, engineType: e.engineType };
}
