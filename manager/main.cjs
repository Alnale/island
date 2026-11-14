/**
 * 灵动岛安装管理器 —— 主进程(安装 / 卸载双模式)
 *
 * 单一自包含程序(scripts/build-manager.mjs 打包):双击「灵动岛安装管理器.exe」
 * 默认进入安装向导;检测到已安装(注册表 InstallLocation / 默认安装目录)时
 * 默认进入卸载页,界面右上角可双向切换;带 --uninstall 直接进入卸载页。
 *
 * 启动模式判定:
 * 1. 参数含 --uninstall → 卸载;
 * 2. exe 位于 <安装目录>/uninstaller → 卸载(系统设置卸载入口的固定路径);
 * 3. 注册表/默认目录检测到已安装 → 卸载;
 * 4. 其余 → 安装。
 *
 * 安装逻辑(原有安装器):
 * 1. 源目录 = release/灵动岛(由 scripts/build-release.mjs 产出);
 * 2. 逐文件复制到安装目录(实时进度);
 * 3. 创建桌面 / 开始菜单快捷方式,可选开机自启(HKCU Run);
 * 4. 把本管理器复制到 <安装目录>/uninstaller,并写注册表卸载项
 *    指向 <安装目录>/uninstaller/灵动岛安装管理器.exe(卸载不依赖主应用)。
 *
 * 卸载逻辑(原独立卸载器):
 * 1. 结束安装目录内的主应用 electron.exe(按路径精确匹配,不误杀其它
 *    Electron 应用,也不误杀管理器自身);
 * 2. 删除快捷方式、注册表卸载项与开机自启项;
 * 3. 可选删除个人数据(%APPDATA%\dynamic-island);
 * 4. 延迟删除安装目录(管理器自身在该目录内时需等进程退出,由后台
 *    PowerShell 静默完成)再退出。
 */
const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
// 复制文件必须用 original-fs:Electron 的 fs 会把 .asar 当归档自动解包,
// 导致复制 release 里 electron/resources/default_app.asar 时报 ENOENT
const ofsp = require('original-fs').promises
const { spawn, spawnSync } = require('node:child_process')

// userData 可写性兜底:打包模式/受限环境若默认 userData 不可写,主进程会启动即退出;
// 此时回退到系统临时目录下的固定位置(与 defaultInstallDir 同款策略)。
try {
  const d = app.getPath('userData')
  const probe = path.join(d, '.w')
  fs.mkdirSync(probe, { recursive: true })
  fs.rmSync(probe, { recursive: true, force: true })
} catch {
  const tmp = path.join(os.tmpdir(), 'lingdong-island-manager')
  fs.mkdirSync(tmp, { recursive: true })
  app.setPath('userData', tmp)
}

const APP_NAME = '灵动岛'
const MANAGER_NAME = '灵动岛安装管理器'
const EXE_NAME = `${MANAGER_NAME}.exe`
const APP_VERSION = '3.1.0'
const RELEASE_NAME = '灵动岛'
const UNINSTALL_KEY = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APP_NAME}`
const USER_DATA_DIR = path.join(process.env.APPDATA || '', 'dynamic-island')

// 外部工具元信息(安装时按需勾选;源码 + 编译 exe 已随发布目录整体打入)
const TOOL_META = {
  bili: { name: '哔哩哔哩下载工具', desc: 'B站视频/弹幕/搜索下载(bili-tool.exe + Rust 源码)' },
  docflow: { name: '文档流工具', desc: '文档处理:PDF/Docx/Markdown/思维导图/OCR(server.py + Python 运行时)' },
}

// 源发布目录(打包:resources/app → ../release/灵动岛;开发:manager/ → ../release/灵动岛)
const releaseDir = path.join(__dirname, '..', 'release', RELEASE_NAME)
const iconPath = path.join(__dirname, 'icon.png')

let win = null
let mode = 'install'
let progressListener = null
// 最近一次安装目录(完成页"立即启动"用)
let lastInstallDir = ''

// ---- 辅助:PowerShell 单引号转义 ----
function psQuote(s) {
  return String(s).replace(/'/g, "''")
}

// ---- 辅助:执行 PowerShell(返回 stdout,失败抛错) ----
function runPowershell(script) {
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-Command', script,
  ], { encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || '').trim()
    throw new Error(err || `PowerShell exit ${r.status}`)
  }
  return (r.stdout || '').trim()
}

// ---- 进度上报 ----
function emitInstallProgress(p) {
  if (progressListener && win && !win.isDestroyed()) {
    win.webContents.send('inst:progress', p)
  }
}

function emitUninstallProgress(p) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('unins:progress', p)
  }
}

// ---- 递归收集文件列表(相对路径 + 绝对路径 + 字节) ----
async function collectFiles(root) {
  const out = []
  const walk = async (dir, rel) => {
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name)
      const relPath = rel ? path.join(rel, ent.name) : ent.name
      if (ent.isDirectory()) {
        await walk(abs, relPath)
      } else if (ent.isFile()) {
        let size = 0
        try {
          size = (await ofsp.stat(abs)).size
        } catch { /* 忽略 */ }
        out.push({ rel: relPath, abs, size })
      }
    }
  }
  await walk(root, '')
  return out
}

// ---- 逐文件复制目录(带进度;skipRel = (rel) => boolean 跳过匹配文件) ----
async function copyTree(srcRoot, destRoot, onFile, skipRel) {
  const files = await collectFiles(srcRoot)
  const list = skipRel ? files.filter((f) => !skipRel(f.rel)) : files
  const totalBytes = list.reduce((s, f) => s + f.size, 0)
  let done = 0
  for (const f of list) {
    const dest = path.join(destRoot, f.rel)
    await ofsp.mkdir(path.dirname(dest), { recursive: true })
    await ofsp.copyFile(f.abs, dest)
    done += f.size
    if (onFile) onFile({ done, totalBytes, file: f.rel })
  }
  return list.length
}

// ---- 创建 .lnk 快捷方式(PowerShell WScript.Shell) ----
function createShortcut(lnkPath, targetExe, workDir, args) {
  const script = `
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut('${psQuote(lnkPath)}')
$s.TargetPath = '${psQuote(targetExe)}'
$s.WorkingDirectory = '${psQuote(workDir)}'
$s.IconLocation = '${psQuote(targetExe)},0'
${args ? `$s.Arguments = '${psQuote(args)}'` : ''}
$s.Description = '${APP_NAME}'
$s.Save()
`
  runPowershell(script)
}

// ---- 写入注册表项(HKCU) ----
function regSet(rootPath, values) {
  const lines = [`New-Item -Path '${psQuote(rootPath)}' -Force | Out-Null`]
  for (const [name, value, type] of values) {
    lines.push(
      `Set-ItemProperty -Path '${psQuote(rootPath)}' -Name '${psQuote(name)}' -Value '${psQuote(value)}' ${
        type ? `-Type ${type}` : ''
      }`,
    )
  }
  runPowershell(lines.join('; '))
}

function regQuery(name) {
  try {
    const r = spawnSync('reg.exe', ['query', UNINSTALL_KEY, '/v', name], {
      encoding: 'utf8',
      windowsHide: true,
    })
    if (r.status !== 0) return ''
    const m = new RegExp(`^\\s*${name}\\s+REG_SZ\\s+(.+)$`, 'im').exec(r.stdout || '')
    return m ? m[1].trim() : ''
  } catch {
    return ''
  }
}

// ---- 安装位置判定 ----
function defaultInstallDir() {
  return path.join(process.env.LOCALAPPDATA || process.env.APPDATA || '', 'Programs', APP_NAME)
}

// 启动器把 electron 放到仓库外再拉起。直接双击仓库里的 electron.exe
// 会在窗口出现前以 0x80000003 退出。安装包位置写在运行目录的 manager-home.json。
function readManagerLaunch() {
  try {
    const p = path.join(path.dirname(process.execPath), 'manager-home.json')
    if (!fs.existsSync(p)) return null
    const data = JSON.parse(fs.readFileSync(p, 'utf8'))
    return data && typeof data === 'object' ? data : null
  } catch {
    return null
  }
}

function flagValue(name) {
  const prefix = `--${name}=`
  for (const arg of process.argv) {
    if (typeof arg === 'string' && arg.startsWith(prefix)) return arg.slice(prefix.length)
  }
  return ''
}

function fromB64(name) {
  return fromB64Value(process.env[name] || '')
}

function fromB64Value(v) {
  if (!v) return ''
  try { return Buffer.from(v, 'base64').toString('utf8') } catch { return '' }
}

function managerExecPath() {
  const fromFlag = fromB64Value(flagValue('island-manager-exec-b64'))
  if (fromFlag && fs.existsSync(fromFlag)) return fromFlag
  const fromB = fromB64('ISLAND_MANAGER_EXEC_B64')
  if (fromB && fs.existsSync(fromB)) return fromB
  const fromArg = flagValue('island-manager-exec')
  if (fromArg && fs.existsSync(fromArg)) return fromArg
  const data = readManagerLaunch()
  const fromFile = data && data.exec
  if (fromFile && fs.existsSync(fromFile)) return fromFile
  const fromEnv = process.env.ISLAND_MANAGER_EXEC
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv
  return process.execPath
}

// exe 位于 <安装目录>/uninstaller = 由系统卸载入口启动的已安装副本
function runningFromUninstaller() {
  return path.basename(path.dirname(managerExecPath())).toLowerCase() === 'uninstaller'
}

function installedExe(dir) {
  return path.join(dir, 'electron', 'electron.exe')
}

/** 检测已安装的灵动岛:卸载副本自身目录 → 注册表 InstallLocation → 默认安装目录 */
function detectInstalled() {
  if (runningFromUninstaller()) {
    const dir = path.dirname(path.dirname(managerExecPath()))
    return { installed: fs.existsSync(installedExe(dir)), installDir: dir }
  }
  const candidates = [regQuery('InstallLocation'), defaultInstallDir()]
  for (const dir of candidates) {
    if (!dir) continue
    if (fs.existsSync(installedExe(dir))) return { installed: true, installDir: dir }
  }
  return { installed: false, installDir: '' }
}

/** 管理器自身发行根目录(用于安装时复制一份到 <安装目录>/uninstaller) */
function managerRoot() {
  const fromFlag = fromB64Value(flagValue('island-manager-home-b64'))
  if (fromFlag && fs.existsSync(path.join(fromFlag, EXE_NAME))) return fromFlag
  const fromB = fromB64('ISLAND_MANAGER_HOME_B64')
  if (fromB && fs.existsSync(path.join(fromB, EXE_NAME))) return fromB
  const fromArg = flagValue('island-manager-home')
  if (fromArg && fs.existsSync(path.join(fromArg, EXE_NAME))) return fromArg
  const data = readManagerLaunch()
  const fromFile = data && data.home
  if (fromFile && fs.existsSync(path.join(fromFile, EXE_NAME))) return fromFile
  const fromEnv = process.env.ISLAND_MANAGER_HOME
  if (fromEnv && fs.existsSync(path.join(fromEnv, EXE_NAME))) return fromEnv
  const packaged = path.join(__dirname, '..', '..')
  if (fs.existsSync(path.join(packaged, EXE_NAME))) return packaged
  // 开发模式:使用 build-manager.mjs 的输出
  const built = path.join(__dirname, '..', 'release', MANAGER_NAME)
  if (fs.existsSync(path.join(built, EXE_NAME))) return built
  return ''
}

// ---- 安装卸载器副本(管理器自身) ----
// 复制完整运行时 + 管理器界面,排除安装源(resources/release),使卸载完全
// 独立于主应用(主应用损坏也能卸载);旧版卸载器目录整体清除后再复制。
function installUninstaller(installDir) {
  const srcRoot = managerRoot()
  if (!srcRoot) {
    throw new Error(`安装包缺少 ${EXE_NAME}(需先运行 node scripts/build-manager.mjs)`)
  }
  const targetDir = path.join(installDir, 'uninstaller')
  fs.rmSync(targetDir, { recursive: true, force: true })
  fs.cpSync(srcRoot, targetDir, {
    recursive: true,
    force: true,
    filter: (src) => {
      const rel = path.relative(srcRoot, src).replace(/\\/g, '/')
      if (rel === '') return true
      if (rel === 'resources/release' || rel.startsWith('resources/release/')) return false
      const name = path.basename(src)
      return name !== 'default_app.asar' && !name.endsWith('.official')
    },
  })
  return path.join(targetDir, EXE_NAME)
}

// ---- 执行安装 ----
async function performInstall(opts) {
  const installDir = opts.dir
  if (!installDir || !installDir.trim()) {
    return { ok: false, error: '未指定安装目录' }
  }
  if (!fs.existsSync(releaseDir)) {
    return { ok: false, error: `未找到发布产物 ${releaseDir}\n请先运行: node scripts/build-release.mjs` }
  }

  const exe = path.join(installDir, 'electron', 'electron.exe')
  // 附加项(快捷方式/自启/卸载项)失败降级为警告,不阻断核心安装
  const warnings = []
  const attempt = (label, fn, donePercent, doneTitle) => {
    try {
      fn()
      emitInstallProgress({ percent: donePercent, title: doneTitle, log: `✓ ${label}`, logCls: 'ok' })
    } catch (e) {
      const msg = (e && e.message) || String(e)
      warnings.push(`${label}失败:${msg}`)
      emitInstallProgress({ percent: donePercent, title: doneTitle, log: `⚠ ${label}失败(已跳过):${msg}`, logCls: 'warn' })
    }
  }

  try {
    emitInstallProgress({ percent: 0.02, title: '准备安装…', stage: '校验发布产物', log: `源: ${releaseDir}`, logCls: '' })

    // 1. 复制应用文件(核心,失败则整体失败)
    //    外部工具目录单独按需复制(第 3 步),此处跳过避免带入未选工具
    emitInstallProgress({ percent: 0.05, title: '复制应用文件', stage: '正在写入目标目录…' })
    await fsp.mkdir(installDir, { recursive: true })
    console.log('[inst] 开始复制 →', installDir)
    const toolRoot = path.join(releaseDir, 'electron', 'resources', 'tools')
    const hasTools = fs.existsSync(toolRoot)
    const selectedTools = Array.isArray(opts.tools) ? opts.tools.filter((t) => t && typeof t === 'string') : []
    await copyTree(
      releaseDir,
      installDir,
      (st) => {
        const percent = 0.05 + 0.75 * (st.done / (st.totalBytes || 1))
        emitInstallProgress({
          percent,
          title: '复制应用文件',
          stage: `已复制 ${Math.round(st.done / 1024 / 1024)} / ${Math.round(st.totalBytes / 1024 / 1024)} MB`,
          file: st.file,
        })
      },
      hasTools ? (rel) => rel.startsWith('electron/resources/tools/') : null,
    )
    console.log('[inst] 复制完成')

    // 2. 按需安装外部工具(整体复制 = 源码 + 编译 exe;未选中的不装)
    if (hasTools && selectedTools.length > 0) {
      const toolFiles = []
      for (const t of selectedTools) {
        const src = path.join(toolRoot, t)
        if (!fs.existsSync(src)) {
          warnings.push(`工具 ${t} 未包含在安装包中,已跳过`)
          continue
        }
        const files = await collectFiles(src)
        for (const f of files) toolFiles.push({ tool: t, rel: f.rel, abs: f.abs, size: f.size })
      }
      const totalToolBytes = toolFiles.reduce((s, f) => s + f.size, 0)
      let doneTool = 0
      emitInstallProgress({
        percent: 0.8,
        title: '安装外部工具',
        stage: `共 ${toolFiles.length} 个文件`,
        log: `安装外部工具:${selectedTools.join('、')}`,
        logCls: '',
      })
      for (const f of toolFiles) {
        const dest = path.join(installDir, 'electron', 'resources', 'tools', f.tool, f.rel)
        await ofsp.mkdir(path.dirname(dest), { recursive: true })
        await ofsp.copyFile(f.abs, dest)
        doneTool += f.size
        emitInstallProgress({
          percent: 0.8 + 0.05 * (totalToolBytes ? doneTool / totalToolBytes : 1),
          title: '安装外部工具',
          stage: `正在复制 ${f.tool}…`,
          file: f.rel,
        })
      }
      console.log('[inst] 外部工具安装完成')
    }

    // 3. 校验主程序存在
    if (!fs.existsSync(exe)) {
      return { ok: false, error: `未找到主程序 ${exe}\n发布产物结构不完整` }
    }

    // 4. 快捷方式(附加项,失败降级)
    if (opts.desktop) {
      emitInstallProgress({ percent: 0.9, title: '创建桌面快捷方式', stage: '', file: '' })
      const desktopLnk = path.join(process.env.USERPROFILE || '', 'Desktop', `${APP_NAME}.lnk`)
      attempt('桌面快捷方式', () => createShortcut(desktopLnk, exe, path.dirname(exe)), 0.93, '创建桌面快捷方式')
    }
    if (opts.startMenu) {
      emitInstallProgress({ percent: 0.94, title: '添加到开始菜单', stage: '', file: '' })
      const startDir = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs')
      const startLnk = path.join(startDir, `${APP_NAME}.lnk`)
      attempt('开始菜单入口', () => createShortcut(startLnk, exe, path.dirname(exe)), 0.96, '添加到开始菜单')
    }

    // 4. 开机自启(附加项,失败降级)
    if (opts.autostart) {
      attempt('开机自启', () => {
        regSet('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', [
          [APP_NAME, `"${exe}"`, 'String'],
        ])
      }, 0.97, '设置开机自启')
    }

    // 5. 卸载器副本(管理器自身完整运行时) + 卸载项
    const uninstallerExe = path.join(installDir, 'uninstaller', EXE_NAME)
    attempt('卸载器', () => installUninstaller(installDir), 0.98, '安装卸载器')
    attempt('卸载项', () => {
      regSet(UNINSTALL_KEY, [
        ['DisplayName', APP_NAME, 'String'],
        ['DisplayVersion', APP_VERSION, 'String'],
        ['Publisher', '灵动岛', 'String'],
        ['InstallLocation', installDir, 'String'],
        ['DisplayIcon', exe, 'String'],
        ['UninstallString', `"${uninstallerExe}"`, 'String'],
        ['NoModify', '1', 'DWord'],
        ['NoRepair', '1', 'DWord'],
      ])
    }, 0.99, '写入卸载项')

    emitInstallProgress({ percent: 1, title: '安装完成', stage: '', file: '' })
    console.log('[inst] 安装完成 dir=', installDir, 'warnings=', warnings.length)
    lastInstallDir = installDir
    return { ok: true, dir: installDir, warnings }
  } catch (e) {
    console.error('[inst] 安装异常:', e)
    const msg = (e && e.message) || String(e)
    if (/EPERM|EACCES/i.test(msg)) {
      return { ok: false, error: '安装目录没有写入权限:' + msg + '\n请点击「浏览…」选择其他可写目录后重试' }
    }
    return { ok: false, error: msg }
  }
}

// ---- 创建主窗口 ----
function createWindow() {
  win = new BrowserWindow({
    width: 940,
    height: 660,
    minWidth: 900,
    minHeight: 620,
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#0a0c16',
    icon: iconPath,
    title: MANAGER_NAME,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })

  win.loadFile(path.join(__dirname, mode === 'uninstall' ? 'uninstall.html' : 'installer.html'))
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => { win = null })
}

function switchMode(next) {
  mode = next === 'uninstall' ? 'uninstall' : 'install'
  if (!win || win.isDestroyed()) return
  win.setTitle(mode === 'uninstall' ? `${APP_NAME} · 卸载` : MANAGER_NAME)
  win.loadFile(path.join(__dirname, mode === 'uninstall' ? 'uninstall.html' : 'installer.html'))
}

// ---- 安装模式 IPC ----
ipcMain.handle('inst:info', async () => {
  const detected = detectInstalled()
  const target = detected.installed ? detected.installDir : defaultInstallDir()
  // 默认目录可写性预检:不可写(权限/沙箱限制)时自动回退到系统临时目录
  let dir = target
  let fallback = false
  if (!detected.installed) {
    try {
      const probe = path.join(dir, '.w')
      await fsp.mkdir(probe, { recursive: true })
      await fsp.writeFile(path.join(probe, 't'), 'ok')
      await fsp.rm(probe, { recursive: true, force: true })
    } catch {
      dir = path.join(os.tmpdir(), APP_NAME)
      fallback = true
    }
  }
  return {
    appName: APP_NAME,
    version: APP_VERSION,
    defaultInstallDir: dir,
    defaultDirFallback: fallback,
    hasSource: fs.existsSync(releaseDir),
    installed: detected.installed,
    installedDir: detected.installDir,
  }
})

// 发布包内可选安装的外部工具(由 build-release --tools 决定打包哪些)
ipcMain.handle('inst:tools', async () => {
  const root = path.join(releaseDir, 'electron', 'resources', 'tools')
  if (!fs.existsSync(root)) return []
  const dirs = (await fsp.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory())
  return dirs.map((e) => {
    const meta = TOOL_META[e.name] || { name: e.name, desc: '外部工具' }
    return { id: e.name, name: meta.name, desc: meta.desc }
  })
})

ipcMain.handle('inst:pick-dir', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择安装目录',
    defaultPath: path.join(process.env.LOCALAPPDATA || '', 'Programs'),
    properties: ['openDirectory', 'createDirectory'],
  })
  if (r.canceled || !r.filePaths.length) return null
  // 默认附加应用名子目录,避免直接写入用户选择的根目录
  const base = r.filePaths[0]
  return path.join(base, APP_NAME)
})

ipcMain.handle('inst:run', async (_e, opts) => {
  progressListener = true
  console.log('[inst] inst:run called, opts=', JSON.stringify(opts || {}))
  try {
    const r = await performInstall(opts || {})
    console.log('[inst] inst:run done, ok=', !!(r && r.ok), 'dir=', r && r.dir, 'error=', r && r.error)
    return r
  } finally {
    progressListener = false
  }
})

ipcMain.handle('inst:finish', async (_e, launch) => {
  if (launch && lastInstallDir) {
    // 启动已安装的应用(electron.exe 自动加载同目录 resources/app)
    const target = installedExe(lastInstallDir)
    if (fs.existsSync(target)) {
      spawn(target, [], { detached: true, stdio: 'ignore' }).unref()
    }
  }
  if (win) win.close()
  return { ok: true }
})

ipcMain.on('inst:minimize', () => {
  if (win) win.minimize()
})

ipcMain.on('inst:close', () => {
  if (win) win.close()
})

// ---- 卸载模式 IPC ----
ipcMain.handle('unins:info', async () => {
  const detected = detectInstalled()
  let dataSizeKB = 0
  if (fs.existsSync(USER_DATA_DIR)) {
    try {
      const walk = (dir) => {
        let sum = 0
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, ent.name)
          if (ent.isDirectory()) sum += walk(p)
          else if (ent.isFile()) sum += fs.statSync(p).size
        }
        return sum
      }
      dataSizeKB = Math.round(walk(USER_DATA_DIR) / 1024)
    } catch { /* 忽略统计失败 */ }
  }
  return {
    appName: APP_NAME,
    version: APP_VERSION,
    installed: detected.installed,
    installDir: detected.installDir,
    userDataDir: USER_DATA_DIR,
    hasData: fs.existsSync(USER_DATA_DIR),
    dataSizeKB,
    canSwitchToInstall: !runningFromUninstaller(),
  }
})

// 精确结束安装目录内的主应用(按可执行路径过滤):不误杀其它 Electron 应用,
// 也不误杀管理器自身(打包后进程名为 灵动岛安装管理器.exe)
function stopInstalledApp(installDir) {
  const exe = installedExe(installDir).replace(/'/g, "''")
  try {
    runPowershell(
      `Get-Process -Name electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${exe}' } | Stop-Process -Force -ErrorAction SilentlyContinue`,
    )
  } catch { /* 忽略:进程可能已退出 */ }
}

// 执行卸载:退主应用 → 删快捷方式 → 删注册表 → 可选删个人数据 → 100%
ipcMain.handle('unins:run', async (_e, opts) => {
  const deleteData = !!(opts && opts.deleteData)
  const detected = detectInstalled()
  if (!detected.installed) {
    return { ok: false, error: '未检测到已安装的灵动岛,无需卸载' }
  }
  const dir = detected.installDir
  const desktopLnk = path.join(process.env.USERPROFILE || '', 'Desktop', `${APP_NAME}.lnk`)
  const startLnk = path.join(
    process.env.APPDATA || '',
    'Microsoft', 'Windows', 'Start Menu', 'Programs',
    `${APP_NAME}.lnk`,
  )
  try {
    emitUninstallProgress({ percent: 0.1, title: '正在退出灵动岛…', stage: '', file: '' })
    stopInstalledApp(dir)
    // 2. 快捷方式(失败降级,不阻断)
    emitUninstallProgress({ percent: 0.35, title: '移除快捷方式…', stage: '', file: '' })
    for (const lnk of [desktopLnk, startLnk]) {
      try { fs.rmSync(lnk, { force: true }) } catch { /* 忽略 */ }
    }
    // 3. 注册表卸载项 + 开机自启项(reg.exe,降级忽略)
    emitUninstallProgress({ percent: 0.55, title: '清除注册表项…', stage: '', file: '' })
    const runKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
    try {
      spawnSync('reg.exe', ['delete', UNINSTALL_KEY, '/f'], { windowsHide: true, stdio: 'ignore' })
    } catch { /* 忽略 */ }
    try {
      spawnSync('reg.exe', ['delete', runKey, '/v', APP_NAME, '/f'], { windowsHide: true, stdio: 'ignore' })
    } catch { /* 忽略 */ }
    // 4. 个人数据(可选)
    if (deleteData) {
      emitUninstallProgress({ percent: 0.75, title: '删除个人数据…', stage: '', file: '' })
      try { fs.rmSync(USER_DATA_DIR, { recursive: true, force: true }) } catch { /* 忽略 */ }
    }
    emitUninstallProgress({ percent: 1, title: '卸载完成', stage: '', file: '' })
    return { ok: true, installDir: dir }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
})

// 完成卸载:延迟删除安装目录(等管理器自身进程退出后整体清除)再退出。
// 隐藏窗口(2026-08-18 修复"卸载完成后弹出黑窗口"):cmd.exe + windowsHide 对
// detached 子进程不生效;powershell -WindowStyle Hidden 即使 detached 也静默。
ipcMain.handle('unins:finish', async () => {
  const detected = detectInstalled()
  const dir = detected.installDir
  if (dir) {
    try {
      const safeDir = String(dir).replace(/'/g, "''")
      const script =
        `Start-Sleep -Milliseconds 2000; ` +
        `Remove-Item -LiteralPath '${safeDir}' -Recurse -Force -ErrorAction SilentlyContinue`
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
        {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        },
      )
      child.unref()
    } catch { /* 忽略 */ }
  }
  app.exit(0)
  return { ok: true }
})

// 取消卸载:直接退出,不删除安装目录
ipcMain.handle('unins:cancel', async () => {
  app.exit(0)
  return { ok: true }
})

ipcMain.on('unins:minimize', () => {
  if (win) win.minimize()
})

// ---- 双模式切换 ----
ipcMain.handle('mgr:context', async () => {
  const detected = detectInstalled()
  return {
    mode,
    installed: detected.installed,
    installDir: detected.installDir,
    canSwitchToInstall: !runningFromUninstaller(),
    canSwitchToUninstall: detected.installed,
  }
})

ipcMain.handle('mgr:switch-mode', async (_e, target) => {
  if (target === 'install') {
    if (runningFromUninstaller()) {
      return { ok: false, error: '安装目录内的卸载入口不能覆盖安装,请使用安装管理器重新安装' }
    }
    switchMode('install')
    return { ok: true }
  }
  if (target === 'uninstall') {
    if (!detectInstalled().installed) {
      return { ok: false, error: '未检测到已安装的灵动岛' }
    }
    switchMode('uninstall')
    return { ok: true }
  }
  return { ok: false, error: `未知模式:${String(target)}` }
})

// ---- 启动 ----
function initialMode() {
  if (process.argv.includes('--uninstall') || runningFromUninstaller()) return 'uninstall'
  return detectInstalled().installed ? 'uninstall' : 'install'
}

app.whenReady().then(() => {
  mode = initialMode()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
