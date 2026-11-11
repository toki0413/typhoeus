/* ================================================================ */
/*  众包排名 + 开放科学仓库提交                                       */
/*                                                                  */
/*  本地存储：                                                       */
/*    localStorage['commons.leaderboard.v1'] = JSON array of         */
/*      { fingerprint, params, metrics, matches, timestamp, likes } */
/*                                                                  */
/*  开放科学仓库（无后端 —— 用 GitHub Issues 作为公共看板）：          */
/*    每个发现记录可以格式化为一个 GitHub Issue 标题 + body，         */
/*    玩家复制 → 粘贴 → 提交到 commons-discoveries 仓库             */
/*    所有发现公开可见，可 star，可 issue 互动                      */
/*                                                                  */
/*  未来后端（可选）：                                               */
/*    POST /api/discoveries 上传记录                                 */
/*    GET  /api/discoveries?sort=energy 公开排名                    */
/* ================================================================ */

import { buildDiscoveryRecord } from './patterns.js';

const LB_KEY = 'commons.leaderboard.v1';
const OSR_REPO_URL = 'https://github.com/commons-org/discoveries/issues/new';

/**
 * 读取本地 leaderboard
 */
export function loadLeaderboard() {
  try {
    const raw = localStorage.getItem(LB_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/**
 * 保存（合并 + 去重，按 fingerprint）
 */
export function saveDiscovery(record) {
  const lb = loadLeaderboard();
  const idx = lb.findIndex(r => r.fingerprint === record.fingerprint);
  if (idx >= 0) lb[idx] = record;  // 覆盖更新
  else lb.unshift(record);         // 新的放最前
  // 最多保留 200 条
  while (lb.length > 200) lb.pop();
  localStorage.setItem(LB_KEY, JSON.stringify(lb));
  return lb;
}

/**
 * 删除一条
 */
export function deleteDiscovery(fingerprint) {
  const lb = loadLeaderboard().filter(r => r.fingerprint !== fingerprint);
  localStorage.setItem(LB_KEY, JSON.stringify(lb));
  return lb;
}

/**
 * 清空
 */
export function clearLeaderboard() {
  localStorage.removeItem(LB_KEY);
}

/**
 * 排序 leaderboard
 * sortBy: 'similarity' | 'energy' | 'fractal' | 'lyapunov' | 'recent'
 * 返回排序后的新数组（不修改原 leaderboard）
 */
export function rankDiscoveries(lb, sortBy = 'similarity') {
  const items = [...lb];
  switch (sortBy) {
    case 'energy':
      items.sort((a, b) => (a.metrics?.energy?.total ?? Infinity) - (b.metrics?.energy?.total ?? Infinity));
      break;
    case 'fractal':
      items.sort((a, b) => (b.metrics?.fractal ?? 0) - (a.metrics?.fractal ?? 0));
      break;
    case 'lyapunov':
      items.sort((a, b) => (b.metrics?.lyapunov ?? 0) - (a.metrics?.lyapunov ?? 0));
      break;
    case 'similarity':
      items.sort((a, b) => {
        const sa = a.patternMatches?.[0]?.similarity ?? 0;
        const sb = b.patternMatches?.[0]?.similarity ?? 0;
        return sb - sa;
      });
      break;
    case 'recent':
    default:
      items.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  }
  return items;
}

/**
 * 用 recipe + metrics + patternMatches 一键保存到 leaderboard
 * 返回保存后的 leaderboard 条目（含 fingerprint）
 */
export function saveAsDiscovery(recipe, metrics, topMatches) {
  const record = buildDiscoveryRecord(recipe, metrics, topMatches);
  saveDiscovery(record);
  return record;
}

/**
 * 导入 JSON 字符串到 leaderboard（支持单条或数组）
 */
export function importDiscoveries(jsonStr) {
  let data;
  try { data = JSON.parse(jsonStr); } catch { return { ok: false, error: 'JSON 解析失败' }; }
  if (!Array.isArray(data)) data = [data];
  const lb = loadLeaderboard();
  let added = 0, updated = 0;
  for (const r of data) {
    if (!r.fingerprint) continue;
    const idx = lb.findIndex(x => x.fingerprint === r.fingerprint);
    if (idx >= 0) { lb[idx] = r; updated++; }
    else { lb.unshift(r); added++; }
  }
  localStorage.setItem(LB_KEY, JSON.stringify(lb));
  return { ok: true, added, updated, total: lb.length };
}

/**
 * 导出 leaderboard 为 JSON 字符串（可粘贴到 GitHub issue）
 */
export function exportLeaderboard(lb) {
  return JSON.stringify(lb, null, 2);
}

/**
 * 生成 GitHub issue body（开放科学仓库提交用）
 * 返回 { url, title, body }
 * 玩家在 UI 点"提交到开放科学" → 复制 body → 打开 url → 粘贴 → 提交
 */
export function buildOpenScienceIssue(record, opts = {}) {
  const matched = record.patternMatches?.[0];
  const similarity = matched ? matched.similarity + '%' : 'N/A';
  const attrLabel = record.metrics?.attrLabel ?? '未知';

  const title = `[发现] ${record.engine} · ${attrLabel} · 相似度 ${similarity}`;

  const body = `## 我的发现

| 项目 | 值 |
|------|-----|
| **指纹** | \`${record.fingerprint}\` |
| **引擎** | ${record.engine} |
| **吸引子类型** | ${attrLabel} |
| **时间** | ${record.timestamp} |

### 科学指标

| 指标 | 值 | 范围 |
|------|-----|------|
| Lyapunov λ | ${record.metrics?.lyapunov?.toFixed(4) ?? '—'} | -0.3 ~ +0.3 |
| 分形维数 D | ${record.metrics?.fractal?.toFixed(3) ?? '—'} | 1.0 ~ 2.0 |
| 自由能 E | ${record.metrics?.energy?.total?.toFixed(4) ?? '—'} | 0.2 ~ 8.0 |
| 密度 | ${((record.metrics?.density ?? 0) * 100).toFixed(1)}% | |
| 空间周期 | ${record.metrics?.period ?? '—'} 格 | |

### 已发表模式匹配

${(record.patternMatches || []).map((m, i) =>
  `${i + 1}. **${m.label}** — 相似度 ${m.similarity}%  \n   > ${m.engine}`
).join('\n\n') || '_无匹配_'}

### 科学参数

\`\`\`json
${JSON.stringify(record.params, null, 2)}
\`\`\`

### 假设（可选）

${opts.hypothesis || '_我觉得这种形态可能是因为..._'}

---
*提交自 Commons v2.0 反应-扩散引擎 · 开放科学模式*
`;

  // 构造 GitHub issue URL（预填 title + body，玩家仍需手动粘贴）
  const url = `${OSR_REPO_URL}?title=${encodeURIComponent(title)}`;

  return { url, title, body };
}
