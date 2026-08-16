/**
 * 灵动岛安装向导 —— 主进程
 *
 * 自绘安装器(零 UI 框架):创建无边框窗口加载 installer.html,
 * 渲染端经 preload(installer/preload.cjs)发起安装请求。
 *
 * 安装逻辑:
 * 1. 源目录 = release/灵动岛(由 scripts/build-release.mjs 产出:
 *    electron/ 运行时 + resources/app/ 应用文件,绿色版结构);
 * 2. 复制到用户选择/默认的安装目录(逐文件复制 + 实时进度);
 * 3. 创建桌面 / 开始菜单快捷方式(指向 安装目录/electron/electron.exe);
 * 4. 可选开机自启(注册表 Run);写入卸载项并生成 uninstall.cmd。
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
  const tmp = path.join(os.tmpdir(), 'lingdong-island-installer')
  fs.mkdirSync(tmp, { recursive: true })
  app.setPath('userData', tmp)
}

const APP_NAME = '灵动岛'
const APP_VERSION = '1.0.0'
const RELEASE_NAME = '灵动岛'

// 外部工具元信息(安装时按需勾选;源码 + 编译 exe 已随发布目录整体打入)
const TOOL_META = {
  bili: { name: '哔哩哔哩下载工具', desc: 'B站视频/弹幕/搜索下载(bili-tool.exe + Rust 源码)' },
  docflow: { name: '文档流工具', desc: '文档处理:PDF/Docx/Markdown/思维导图/OCR(server.py + Python 运行时)' },
}

// 源发布目录(相对本文件 ../release/灵动岛)
const releaseDir = path.join(__dirname, '..', 'release', RELEASE_NAME)
// 安装器图标(原始图标 installer/icon.png,与界面 logo 保持一致)
const iconPath = path.join(__dirname, 'icon.png')

let mainWindow = null
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
function emitProgress(p) {
  if (progressListener && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('inst:progress', p)
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

// ---- 安装卸载器 ----
// 把发行包里的独立卸载器 exe(release/灵动岛/灵动岛卸载器.exe,由
// scripts/build-uninstaller.mjs 产出)复制到安装目录根;系统设置卸载入口
// (UninstallString)与安装目录双击都指向它。卸载器自包含 electron 运行时,
// 不依赖主应用(主应用损坏也能卸载)。
function installUninstaller(installDir) {
  const src = path.join(releaseDir, '灵动岛卸载器.exe')
  if (!fs.existsSync(src)) {
    throw new Error('发行包缺少 灵动岛卸载器.exe(需先运行 node scripts/build-uninstaller.mjs)')
  }
  fs.copyFileSync(src, path.join(installDir, '灵动岛卸载器.exe'))
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
      emitProgress({ percent: donePercent, title: doneTitle, log: `✓ ${label}`, logCls: 'ok' })
    } catch (e) {
      const msg = (e && e.message) || String(e)
      warnings.push(`${label}失败:${msg}`)
      emitProgress({ percent: donePercent, title: doneTitle, log: `⚠ ${label}失败(已跳过):${msg}`, logCls: 'warn' })
    }
  }

  try {
    emitProgress({ percent: 0.02, title: '准备安装…', stage: '校验发布产物', log: `源: ${releaseDir}`, logCls: '' })

    // 1. 复制应用文件(核心,失败则整体失败)
    //    外部工具目录单独按需复制(第 3 步),此处跳过避免带入未选工具
    emitProgress({ percent: 0.05, title: '复制应用文件', stage: '正在写入目标目录…' })
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
        emitProgress({
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
      emitProgress({
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
        emitProgress({
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
      emitProgress({ percent: 0.9, title: '创建桌面快捷方式', stage: '', file: '' })
      const desktopLnk = path.join(process.env.USERPROFILE || '', 'Desktop', `${APP_NAME}.lnk`)
      attempt('桌面快捷方式', () => createShortcut(desktopLnk, exe, path.dirname(exe)), 0.93, '创建桌面快捷方式')
    }
    if (opts.startMenu) {
      emitProgress({ percent: 0.94, title: '添加到开始菜单', stage: '', file: '' })
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

    // 5. 卸载器 + 卸载项(卸载器 exe 复制到安装目录根,核心;注册表项降级)
    attempt('卸载器', () => installUninstaller(installDir), 0.98, '安装卸载器')
    attempt('卸载项', () => {
      regSet('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + APP_NAME, [
        ['DisplayName', APP_NAME, 'String'],
        ['DisplayVersion', APP_VERSION, 'String'],
        ['Publisher', '灵动岛', 'String'],
        ['InstallLocation', installDir, 'String'],
        ['DisplayIcon', exe, 'String'],
        ['UninstallString', `"${path.join(installDir, '灵动岛卸载器.exe')}"`, 'String'],
        ['NoModify', '1', 'DWord'],
        ['NoRepair', '1', 'DWord'],
      ])
    }, 0.99, '写入卸载项')

    emitProgress({ percent: 1, title: '安装完成', stage: '', file: '' })
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
  mainWindow = new BrowserWindow({
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
    title: APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })

  mainWindow.loadFile(path.join(__dirname, 'installer.html'))
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('closed', () => { mainWindow = null })
}

// ---- IPC ----
ipcMain.handle('inst:info', async () => {
  const defaultDir = path.join(process.env.LOCALAPPDATA || process.env.APPDATA || '', 'Programs', APP_NAME)
  // 默认目录可写性预检:不可写(权限/沙箱限制)时自动回退到系统临时目录,保证"浏览/直接安装"可用
  let dir = defaultDir
  let fallback = false
  try {
    const probe = path.join(defaultDir, '.w')
    await fsp.mkdir(probe, { recursive: true })
    await fsp.writeFile(path.join(probe, 't'), 'ok')
    await fsp.rm(probe, { recursive: true, force: true })
  } catch {
    dir = path.join(os.tmpdir(), APP_NAME)
    fallback = true
  }
  return {
    appName: APP_NAME,
    version: APP_VERSION,
    defaultInstallDir: dir,
    defaultDirFallback: fallback,
    hasSource: fs.existsSync(releaseDir),
  }
})

// 发布包内可选安装的外部工具(由 build-release --tools 决定打包哪些;
// 每个工具目录 = 源码 + 编译 exe 一并安装,便于后续修改迭代)
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
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '选择安装目录',
    defaultPath: path.join(process.env.LOCALAPPDATA || '', 'Programs'),
    properties: ['openDirectory', 'createDirectory'],
  })
  if (r.canceled || !r.filePaths.length) return null
  // 默认附加应用名子目录,避免直接写入用户选择的根目录
  const base = r.filePaths[0]
  const appDir = path.join(base, APP_NAME)
  return appDir
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
    const target = path.join(lastInstallDir, 'electron', 'electron.exe')
    if (fs.existsSync(target)) {
      spawn(target, [], { detached: true, stdio: 'ignore' }).unref()
    }
  }
  if (mainWindow) mainWindow.close()
  return { ok: true }
})

ipcMain.on('inst:minimize', () => {
  if (mainWindow) mainWindow.minimize()
})

ipcMain.on('inst:close', () => {
  if (mainWindow) mainWindow.close()
})

// ---- 启动 ----
app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
