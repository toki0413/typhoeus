import { spawnSync } from 'node:child_process';

/**
 * 音频门禁在无头环境下偶发第一帧没有电平；
 * 失败时重跑一次，仍失败才判定失败。
 */
function runOnce() {
  const result = spawnSync(process.execPath, ['scripts/audio-check.mjs'], {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
  return result.status ?? 1;
}

let code = runOnce();
if (code !== 0) {
  console.log('\n[verify:audio] 首次失败，重试一次……');
  code = runOnce();
}
process.exit(code);
