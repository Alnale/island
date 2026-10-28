/**
 * 开发期启动 Electron。
 *
 * 自编译 HEVC 补丁(electron.exe,与 C:\electron-hevc-dist 里那份同一哈希)
 * 从 node_modules\electron\dist 拉起时,会在栈保护检查(exe+0xDB357E,
 * int3;ud2)上退出,码 0x80000003 = 2147483651。pnpm dev:widget 的最后
 * 一步 `electron .` 因此整段失败。同一份文件放在 C:\electron-hevc-dist
 * 下启动则正常(补丁原本就在这个目录里跑)。
 *
 * electron 包支持 ELECTRON_OVERRIDE_DIST_PATH:有补丁目录就指过去,
 * 没有则仍走 node_modules(官方包,其它机器/CI 不受影响)。
 *
 * 用法:node scripts/launch-dev-electron.mjs [传给 electron 的参数...]
 *       无参数时等价于 `electron .`
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const hevcDir = 'C:\\electron-hevc-dist'
const hevcExe = path.join(hevcDir, 'electron.exe')
const env = { ...process.env }
if (fs.existsSync(hevcExe)) {
  env.ELECTRON_OVERRIDE_DIST_PATH = hevcDir
  // 补丁目录的 locales 曾是空目录(2026-10-23 00:33 建出来,里面没有
  // pak)。空目录比「没有目录」更糟:资源束以为语言包在,读不到 pak,
  // 渲染进程以 0xFFFF7003(exit -36861)崩溃重载。重载时 mouseleave
  // 把点击穿透打开,新页面不再收到 mouseenter,长按失效。
  // 没有 zh-CN/en-US.pak 就清掉空目录,把官方 locales 接过来。
  const localesSrc = path.join(root, 'node_modules', 'electron', 'dist', 'locales')
  const localesDst = path.join(hevcDir, 'locales')
  const hasPak = (dir) =>
    fs.existsSync(path.join(dir, 'zh-CN.pak')) || fs.existsSync(path.join(dir, 'en-US.pak'))
  if (fs.existsSync(localesSrc) && !hasPak(localesDst)) {
    try {
      fs.rmSync(localesDst, { recursive: true, force: true })
      fs.symlinkSync(localesSrc, localesDst, 'junction')
      console.log('[launch-electron] 已连接语言包:', localesDst)
    } catch (err) {
      console.warn('[launch-electron] 语言包联接失败:', err.message)
    }
  }
}

const cli = path.join(root, 'node_modules', 'electron', 'cli.js')
const args = process.argv.slice(2)
if (args.length === 0) args.push('.')

const child = spawn(process.execPath, [cli, ...args], {
  cwd: root,
  env,
  stdio: 'inherit',
  windowsHide: false,
})
child.on('error', (err) => {
  console.error(`[launch-electron] 无法启动:${err.message}`)
  process.exit(1)
})
child.on('exit', (code) => {
  process.exit(code ?? 1)
})
