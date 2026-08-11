// ============================================================
//  灵动岛 · 桌面开发版 一键启动(Node 侧逻辑)
//
//  dev.bat 只是 ASCII 启动壳,真正的流程在这里:
//    [1/3] 结束残留的旧实例 → [2/3] 重新构建并启动 → [3/3] 等待退出
//
//  编码说明:本文件为 UTF-8,Node 原生按 UTF-8 读写,不受 Windows
//  代码页影响;控制台中文输出由 dev.bat 的 chcp 65001 保证正确显示。
//  (不要把这个流程搬回 .bat——cmd 分块读取批处理文件,chcp 切换
//  代码页前已缓冲的中文行会被按旧代码页解码,产生乱码命令,实测。)
// ============================================================

import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// PowerShell 过滤条件:只匹配本项目目录下的 electron.exe
// (路径含 dynamic-island 文件夹名,不影响电脑上其它 Electron 应用)。
// 注意必须用 $_.Id——实测本机 PowerShell 5.1 上 $_.ProcessId 为空值,
// Stop-Process -Id 传 null 会抛"参数不能为空"。
const PS_FILTER = `$_.Path -like '*dynamic-island*'`

/** 结束本项目残留的 electron 实例(单实例锁:不结束则新启动只会唤起旧窗口,加载旧代码) */
function killOldInstances() {
  return new Promise((resolve) => {
    const ps = spawn('powershell', [
      '-NoProfile',
      '-Command',
      `Get-Process electron -ErrorAction SilentlyContinue | Where-Object { ${PS_FILTER} } | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }`,
    ], { windowsHide: true })
    ps.on('error', () => resolve(false))
    ps.on('close', () => resolve(true))
  })
}

/** 统计仍存活的本项目 electron 进程数(输出只有数字,与代码页无关) */
function countAlive() {
  return new Promise((resolve) => {
    const ps = spawn('powershell', [
      '-NoProfile',
      '-Command',
      `(Get-Process electron -ErrorAction SilentlyContinue | Where-Object { ${PS_FILTER} }).Count`,
    ], { windowsHide: true })
    let out = ''
    ps.stdout.on('data', (d) => { out += String(d) })
    ps.on('error', () => resolve(0))
    ps.on('close', () => resolve(parseInt(out.trim(), 10) || 0))
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 运行一条命令,输出透传控制台,返回退出码 */
function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', windowsHide: true })
    child.on('error', (err) => {
      console.error(`[错误] 无法启动 ${cmd}:${err.message}`)
      resolve(1)
    })
    child.on('close', (code) => resolve(code ?? 1))
  })
}

// ------------------------------------------------------------
console.log('=========================================')
console.log('  灵动岛 · 桌面开发版 一键启动')
console.log('=========================================')

// [1/3] 结束旧实例,并轮询确认全部退出(上限 8s,锁文件随进程退出释放)
console.log('[1/3] 检查并结束旧实例...')
await killOldInstances()
let waited = 0
while (waited < 8000) {
  if ((await countAlive()) === 0) break
  await sleep(500)
  waited += 500
}
const leftover = await countAlive()
if (leftover > 0) {
  console.warn(`[提示] 仍有 ${leftover} 个旧实例未退出(可能权限不足,如管理员运行),新实例可能无法启动。`)
} else {
  console.log('      已清理,没有残留实例。')
}

// [2/3] 重新构建并启动:dev:widget 已前置 build:electron(esbuild 打包
//       Agent 引擎与 SMTC 桥),再构建挂件页面(dist-widget),最后启动
//       Electron。pnpm 在 Windows 上是 .cmd 壳,必须经 cmd.exe 启动
//       (CreateProcess 无法直接执行 .cmd;spawn 的 shell:true 会触发
//       Node 24 的 DEP0190 弃用警告,故显式走 cmd /d /s /c)。
console.log('[2/3] 正在重新构建(Agent 引擎 + SMTC 桥 + 挂件页面)...')
const code = await run('cmd.exe', ['/d', '/s', '/c', 'pnpm dev:widget'])
if (code !== 0) {
  console.error('[失败] 构建或启动出错,请查看上方日志。')
  process.exit(code)
}

// [3/3] 应用正常退出(托盘退出或关闭挂件窗口)
console.log('[3/3] 应用已退出。')
