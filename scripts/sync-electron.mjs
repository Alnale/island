// Electron 源码树同步脚本(2026-08-11):gclient sync 自动重试循环。
// 网络不稳时 sync 中断——gclient 会清理未完成镜像,重试从零再拉(21G 的
// Chromium 主仓库是最大头),所以单轮超时要给足(90 分钟),重试次数少而精。
// 用法:node scripts/sync-electron.mjs <max-attempts> [log-file]
import { spawn } from 'node:child_process'
import { writeFileSync, appendFileSync } from 'node:fs'

const maxAttempts = Number(process.argv[2] || 4)
const logFile = process.argv[3] || 'C:\\electron-gn\\sync.log'
const proxy = 'http://127.0.0.1:7897'
const env = {
  ...process.env,
  https_proxy: proxy,
  http_proxy: proxy,
  GIT_CACHE_PATH: 'C:\\electron-gn\\git-cache', // 关键:让 gclient 从本地镜像克隆
  PATH: 'C:\\depot_tools;' + process.env.PATH,
}
appendFileSync(logFile, `\n===== sync loop start ${new Date().toISOString()} =====\n`)

for (let i = 1; i <= maxAttempts; i++) {
  const started = Date.now()
  const msg = `\n=== sync attempt ${i}/${maxAttempts} @ ${new Date().toISOString()} ===\n`
  appendFileSync(logFile, msg)
  console.log(msg.trim())

  const r = await new Promise((resolve) => {
    const child = spawn(
      'C:\\depot_tools\\.cipd_bin\\vpython3.exe',
      ['C:\\depot_tools\\gclient.py', 'sync', '--with_branch_heads', '--with_tags', '--nohooks'],
      { cwd: 'C:\\electron-gn', env, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let out = ''
    child.stdout.on('data', (d) => {
      out += d.toString()
      appendFileSync(logFile, d.toString())
    })
    child.stderr.on('data', (d) => appendFileSync(logFile, d.toString()))
    const timer = setTimeout(() => {
      appendFileSync(logFile, '\n[attempt timeout 90min, killing]\n')
      child.kill()
    }, 90 * 60 * 1000)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out })
    })
  })

  const mins = ((Date.now() - started) / 60000).toFixed(1)
  const tail = r.out.split('\n').slice(-30).join('\n')
  if (r.code === 0) {
    appendFileSync(logFile, `\n=== SYNC OK after ${mins} min ===\n`)
    console.log(`=== SYNC OK after ${mins} min ===`)
    console.log(tail)
    process.exit(0)
  }
  appendFileSync(logFile, `\n=== attempt ${i} failed (code ${r.code}) after ${mins} min ===\n`)
  console.log(`=== attempt ${i} failed (code ${r.code}) after ${mins} min, retrying... ===`)
}
console.log('MAX ATTEMPTS EXHAUSTED')
process.exit(1)
