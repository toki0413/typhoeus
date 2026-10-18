#!/usr/bin/env node
/**
 * 安装时自检：`typhoeus-mcp` 在 PATH 上吗？数据目录够不够。
 *
 * 这一步不阻断安装（退出码恒为 0）——插件装上了但依赖缺失时，
 * 用户需要看到的是"该装什么"，不是一条 npm 失败。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const isWin = process.platform === 'win32'
const cmd = isWin ? 'typhoeus-mcp.exe' : 'typhoeus-mcp'
const r = spawnSync(cmd, ['--list-tools'], { encoding: 'utf8' })

if (r.error || r.status !== 0) {
  console.warn('\n[typhoeus] 没有找到 `typhoeus-mcp`。先装内核：')
  console.warn('  pip install "git+https://github.com/toki0413/typhoeus"')
  console.warn('  typhoeus-mcp --list-tools    # 应打印 9 个工具')
} else {
  const line = (r.stdout || '').trim().split('\n').pop()
  console.log(`[typhoeus] ${line}`)
}

const home = process.env.TYPHOEUS_HOME || join(homedir(), '.typhoeus')
const out = join(home, 'out')
if (!existsSync(out)) {
  console.warn(`\n[typhoeus] 产物目录不存在：${out}`)
  console.warn('  把 out/（8 份产物）放到 TYPHOEUS_HOME 下，或用 typhoeus run 生成。')
}
