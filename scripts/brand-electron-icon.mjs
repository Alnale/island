/**
 * 把项目图标烙进自编译 HEVC Electron 的 exe 资源(2026-08-13,用户实测
 * "右下角弹窗图标分辨率太低 + 进程没有(正确)图标"):
 *
 * 自编译 exe(C:\electron-hevc-dist\electron.exe)只有构建自带的 32×32
 * 默认图标——① 托盘气泡/系统弹窗按 exe 图标归属显示,32 源放大 = 糊;
 * ② 任务管理器/弹窗归属显示的是默认图标而非岛灵图标。
 *
 * 本脚本用 rcedit(devDependency,node_modules/rcedit/bin/rcedit-x64.exe)
 * 把 electron/icon.ico(make-icon.cjs 生成的多尺寸 16-256 PNG-in-ICO,
 * pnpm build:electron 时自动产出)写入**源目录** exe——apply-hevc-
 * electron.mjs 按哈希从源目录换装,烙源后 apply 自然携带,重新安装
 * node_modules / dev.bat 自动重应用都不丢。注意:重新编译 Electron
 * (C:\electron-gn 构建覆盖 C:\electron-hevc-dist)后需重跑本脚本。
 *
 * 用法:
 *   node scripts/brand-electron-icon.mjs          # 烙图标(需先 build:electron 生成 icon.ico)
 *   node scripts/brand-electron-icon.mjs --check  # 只报告 exe 图标状态
 */
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ICO = path.join(ROOT, 'electron', 'icon.ico')
const EXE = 'C:\\electron-hevc-dist\\electron.exe'
const RCEDIT = path.join(ROOT, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe')

const mode = process.argv[2] === '--check' ? 'check' : 'apply'

if (!existsSync(EXE)) {
  console.error(`[brand-icon] 源 exe 不存在:${EXE}(先准备自编译 HEVC 产物)`)
  process.exit(1)
}
if (!existsSync(ICO)) {
  console.error('[brand-icon] electron/icon.ico 不存在——先跑 pnpm build:electron(或 pnpm exec electron scripts/make-icon.cjs)')
  process.exit(1)
}

if (mode === 'check') {
  const exe = readFileSync(EXE)
  // 粗查:exe 里是否含 256×256 PNG 的 IHDR(rcedit 原样嵌入 ico 数据;
  // PNG 签名 + 宽高 00 00 01 00 ×2 = 256×256)
  const png256Ihdr = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00,
  ])
  const branded = exe.includes(png256Ihdr)
  console.log(`[brand-icon] ${EXE} ${branded ? '已烙图标' : '未烙(默认构建图标)'}`)
  process.exit(branded ? 0 : 1)
}

if (!existsSync(RCEDIT)) {
  console.error('[brand-icon] rcedit 缺失——先 pnpm add -D rcedit')
  process.exit(1)
}

const r = spawnSync(RCEDIT, [EXE, '--set-icon', ICO], { stdio: 'inherit', windowsHide: true })
if (r.status !== 0) {
  console.error(`[brand-icon] rcedit 失败(退出码 ${r.status})`)
  process.exit(1)
}
console.log('[brand-icon] 已烙入多尺寸图标(16-256)→ 再跑 node scripts/apply-hevc-electron.mjs 换装到 node_modules')
