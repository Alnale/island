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

// ---- 控制台美化(ANSI 24 位真彩渐变 + 球面光晕)----
// Windows 10+ conhost / Windows Terminal 均支持 VT 转义;NO_COLOR 或非
// 终端(stdout 重定向)时自动降级为纯文本,不产生乱码转义。
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
const esc = (code, s) => `\x1b[${code}m${s}\x1b[0m`
const bold = (s) => esc(1, s)
const dim = (s) => esc(2, s)
const green = (s) => esc(32, s)
const yellow = (s) => esc(33, s)
const red = (s) => esc(31, s)
const lerp = (a, b, t) => Math.round(a + (b - a) * t)

/** 主渐变带:青 → 蓝 → 紫 → 粉(横向过渡) */
const GRAD = [
  [34, 211, 238], // 青 #22d3ee
  [96, 165, 250], // 蓝 #60a5fa
  [167, 139, 250], // 紫 #a78bfa
  [232, 121, 249], // 粉 #e879f9
]
/** 渐变带取样(t ∈ [0,1]) */
function gradAt(t) {
  const x = Math.max(0, Math.min(1, t)) * (GRAD.length - 1)
  const i = Math.min(GRAD.length - 2, Math.floor(x))
  return [
    lerp(GRAD[i][0], GRAD[i + 1][0], x - i),
    lerp(GRAD[i][1], GRAD[i + 1][1], x - i),
    lerp(GRAD[i][2], GRAD[i + 1][2], x - i),
  ]
}
const paint = ([r, g, b], s) =>
  useColor ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m` : s

/** 终端显示宽度(全角字符按 2 列,用于对齐) */
function displayWidth(s) {
  let w = 0
  for (const ch of Array.from(s)) {
    w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u3000-\u303F\u2014\u2018\u2019\u201C\u201D\u2026]/.test(ch)
      ? 2
      : 1
  }
  return w
}

/** 逐字符横向渐变(空格跳过染色) */
function gradLine(text, from = 0, to = 1) {
  if (!useColor) return text
  const chars = Array.from(text)
  const n = chars.length
  let out = ''
  for (let i = 0; i < n; i++) {
    const ch = chars[i]
    if (ch === ' ') {
      out += ch
      continue
    }
    const t = n <= 1 ? 0.5 : from + (to - from) * (i / (n - 1))
    out += paint(gradAt(t), ch)
  }
  return out
}

/** 渲染横幅:逐字符横向渐变 + 纵向球面光晕(中间行亮、上下边缘暗) */
function renderBanner(lines) {
  if (!useColor) {
    for (const l of lines) console.log(l)
    return
  }
  const n = lines.length
  const center = (n - 1) / 2
  lines.forEach((line, i) => {
    const chars = Array.from(line)
    const m = chars.length
    const dist = center <= 0 ? 0 : Math.abs(i - center) / center
    const bright = 1 - 0.22 * dist * dist
    let out = ''
    for (let j = 0; j < m; j++) {
      const ch = chars[j]
      if (ch === ' ') {
        out += ch
        continue
      }
      const t = m <= 1 ? 0.5 : j / (m - 1)
      const [r, g, b] = gradAt(t)
      out += `\x1b[38;2;${Math.min(255, Math.round(r * bright))};${Math.min(255, Math.round(g * bright))};${Math.min(255, Math.round(b * bright))}m${ch}\x1b[0m`
    }
    console.log(out)
  })
}

/** 步骤卡片宽度(半角列) */
const CARD_W = 60
/** 开始一个渐变边框的步骤卡片:返回 { line(), end() } */
function beginCard(title) {
  const titleStr = ` ${title} `
  const pad = Math.max(0, CARD_W - 4 - displayWidth(titleStr))
  console.log(gradLine('┌─' + titleStr + '─'.repeat(pad) + '┐'))
  const line = (s) => {
    const body = displayWidth(s) > CARD_W - 4 ? Array.from(s).slice(0, CARD_W - 8).join('') + '…' : s
    console.log(gradLine('│ ' + body + ' '.repeat(Math.max(0, CARD_W - 4 - displayWidth(body))) + ' │'))
  }
  const end = () => console.log(gradLine('└' + '─'.repeat(CARD_W - 2) + '┘'))
  return { line, end }
}

// ------------------------------------------------------------
//  顶部横幅:✦ 星环 + ◇ 标题 + ▸ 副标题(渐变 + 光晕)
// ------------------------------------------------------------
const banner = [
  '  ✦  ✧  ✦  ✧  ✦  ✧  ✦  ✧  ✦  ✧  ✦  ✧  ✦  ✧  ✦  ✧',
  '  ◇  灵 动 岛   ·   Dynamic Island   ◇',
  '  ▸  桌面开发版 · 一键构建 · 启动 · 退出   ◂',
  '  ✦  ✧  ✦  ✧  ✦  ✧  ✦  ✧  ✦  ✧  ✦  ✧  ✦  ✧  ✦  ✧',
]
console.log()
renderBanner(banner)
console.log(`  ${dim('项目目录:')} ${dim(ROOT)}`)
console.log(`  ${dim('退出:托盘退出或关闭挂件窗口 · Ctrl+C 终止本脚本')}`)
console.log()

// PowerShell 过滤条件:只匹配本项目 node_modules 下的 electron.exe。
// 注意:不能只用 '*dynamic-island*'(会误杀 C:\Users\asus\Desktop\
// dynamic-island-official 副本的实例——同一 userData/单实例锁,2026-08-12
// 实测用户日常跑该副本);必须带项目路径限定。
// **路径用通配 \node_modules\*electron**(2026-08-14):pnpm 下 electron.exe
// 真实路径是 node_modules\.pnpm\electron@43.2.0\node_modules\electron\dist\
// ——原条件 \node_modules\electron* 匹配不到,残留实例杀不掉还被误判成
// "official 副本占锁"导致新实例静默退出(实测)。
// 注意必须用 $_.Id——实测本机 PowerShell 5.1 上 $_.ProcessId 为空值,
// Stop-Process -Id 传 null 会抛"参数不能为空"。
const PS_FILTER = `$_.Path -like '*dynamic-island\\node_modules\\*electron*'`

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
      console.error(`${red('[错误]')} 无法启动 ${cmd}:${err.message}`)
      resolve(1)
    })
    child.on('close', (code) => resolve(code ?? 1))
  })
}

// ------------------------------------------------------------
// [1/3] 结束旧实例,并轮询确认全部退出(上限 8s,锁文件随进程退出释放)
// ------------------------------------------------------------
const s1 = beginCard('◉ 步骤 1/3 · 检查并结束旧实例')
await killOldInstances()
let waited = 0
while (waited < 8000) {
  if ((await countAlive()) === 0) break
  await sleep(500)
  waited += 500
}
const leftover = await countAlive()
if (leftover > 0) {
  s1.line(`${yellow('⚠')} 仍有 ${leftover} 个旧实例未退出(可能权限不足,如管理员运行),新实例可能无法启动。`)
} else {
  s1.line(`${green('✓')} 已清理,没有残留实例。`)
}
s1.end()

// 单实例锁冲突检测(2026-08-12):主项目与 C:\Users\asus\Desktop\
// dynamic-island-official 副本同名 → 共享 %APPDATA%/dynamic-island
// 单实例锁。副本实例在跑时,本项目 electron 启动会静默退出(无窗口,
// 实测)。杀实例只按本项目路径过滤(不误杀副本),这里检出副本存活
// 并提示用户手动关闭。
const alienAlive = await new Promise((resolve) => {
  const ps = spawn('powershell', [
    '-NoProfile',
    '-Command',
    `(Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*dynamic-island*' -and $_.Path -notlike '*dynamic-island\\node_modules\\*electron*' }).Count`,
  ], { windowsHide: true })
  let out = ''
  ps.stdout.on('data', (d) => { out += String(d) })
  ps.on('error', () => resolve(0))
  ps.on('close', () => resolve(parseInt(out.trim(), 10) || 0))
})
if (alienAlive > 0) {
  const sw = beginCard('◈ 检测到副本实例')
  sw.line(`${yellow('⚠')} ${alienAlive} 个 dynamic-island-official 副本在运行——两副本共享单实例锁,新实例将静默退出。`)
  sw.line(`${dim('请先手动关闭副本,或用 --user-data-dir 隔离。')}`)
  sw.end()
}

// ------------------------------------------------------------
// [1.5/3] HEVC 补丁自检(2026-08-12):官方 Electron 无 HEVC 解码能力
//       (ffmpeg 无解码器 + media 层门控不放行)→ 对话窗口 HEVC 全黑。
//       C:\electron-hevc-dist 有自编译补丁(与官方 43.2.0 同一 tag 构建,
//       ffmpeg 软解 + media 门控补丁;换装 7 个构建产物,官方全备份可
//       --restore 回退)则自动应用;源不存在时仅提示不阻断(官方版其余
//       功能不受影响)。放在杀实例之后:被运行中 electron 占用会 EBUSY。
// ------------------------------------------------------------
const s15 = beginCard('◉ 步骤 1.5/3 · 检查 HEVC ffmpeg 补丁')
const patchCode = await run('node', ['scripts/apply-hevc-electron.mjs'])
if (patchCode !== 0) {
  s15.line(`${yellow('⚠')} HEVC 补丁未应用(不影响其他功能,HEVC 视频请用 bili convert 转码)`)
} else {
  s15.line(`${green('✓')} HEVC 补丁就绪。`)
}
s15.end()

// ------------------------------------------------------------
// [2/3] 重新构建并启动:dev:widget 已前置 build:electron(esbuild 打包
//       Agent 引擎与 SMTC 桥),再构建挂件页面(dist-widget),最后启动
//       Electron。pnpm 在 Windows 上是 .cmd 壳,必须经 cmd.exe 启动
//       (CreateProcess 无法直接执行 .cmd;spawn 的 shell:true 会触发
//       Node 24 的 DEP0190 弃用警告,故显式走 cmd /d /s /c)。
// ------------------------------------------------------------
const s2 = beginCard('◉ 步骤 2/3 · 重新构建并启动')
s2.line(`${dim('Agent 引擎 + SMTC 桥 + 挂件页面…')}`)
s2.end()
const code = await run('cmd.exe', ['/d', '/s', '/c', 'pnpm dev:widget'])
if (code !== 0) {
  console.error(`\n${red(bold('✗ 构建或启动出错'))},请查看上方日志。`)
  process.exit(code)
}

// ------------------------------------------------------------
// [3/3] 应用正常退出(托盘退出或关闭挂件窗口)
// ------------------------------------------------------------
renderBanner([
  '  ✦  ✧  ✦  ✧  ✦  ✧  ✦  ✧  ✦  ✧  ✦  ✧  ✦  ✧  ✦  ✧',
  `  ◇  ${'灵 动 岛 已 就 绪'}  ·  应用已退出  ◇`,
  '  ✦  ✧  ✦  ✧  ✦  ✧  ✦  ✧  ✦  ✧  ✦  ✧  ✦  ✧  ✦  ✧',
])
console.log(`  ${dim('窗口可随时重新启动。')}`)
