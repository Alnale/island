/**
 * 灵动岛卸载器 —— 主进程
 *
 * 独立自包含卸载程序(与安装器同构):由 scripts/build-uninstaller.mjs
 * 打包为「灵动岛卸载器.exe」(内含 electron 运行时 + resources/app 卸载
 * 向导),安装器安装时复制到安装目录根,系统设置卸载入口(UninstallString)
 * 与安装目录双击都指向它——不依赖主应用,主应用损坏也能卸载。
 *
 * 卸载逻辑:
 * 1. 先 taskkill 主应用 electron.exe(卸载器进程名为「灵动岛卸载器.exe」,
 *    不误杀自身);
 * 2. 删除桌面/开始菜单快捷方式、注册表卸载项与开机自启项;
 * 3. 可选删除个人数据(%APPDATA%\dynamic-island);
 * 4. 完成后延迟删除安装目录(卸载器自身 exe 也在其中,无法立即删除,
 *    交由后台 cmd 等进程退出后整体清除)再退出。
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { spawn, spawnSync } = require('node:child_process')

// userData 可写性兜底(同安装器):打包/受限环境 userData 不可写时回退
// 系统临时目录,避免主进程启动即退出
try {
  const d = app.getPath('userData')
  const probe = path.join(d, '.w')
  fs.mkdirSync(probe, { recursive: true })
  fs.rmSync(probe, { recursive: true, force: true })
} catch {
  const tmp = path.join(os.tmpdir(), 'lingdong-island-uninstaller')
  fs.mkdirSync(tmp, { recursive: true })
  app.setPath('userData', tmp)
}

const APP_NAME = '灵动岛'
const iconPath = path.join(__dirname, 'icon.png')

let win = null

function iconImage(size) {
  try {
    return require('electron').nativeImage.createFromPath(iconPath).resize({ width: size, height: size })
  } catch {
    return require('electron').nativeImage.createEmpty()
  }
}

function emitProgress(p) {
  if (win && !win.isDestroyed()) win.webContents.send('unins:progress', p)
}

/** 安装目录:卸载器 exe 位于 <安装目录>/灵动岛卸载器.exe */
function installDir() {
  return path.dirname(process.execPath)
}

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
    icon: iconImage(256),
    title: `${APP_NAME} · 卸载`,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  })
  win.loadFile(path.join(__dirname, 'uninstall.html'))
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => { win = null })
}

// 卸载信息(界面首屏):应用名/版本/安装目录/个人数据路径与存在性
ipcMain.handle('unins:info', async () => {
  const userDataDir = path.join(process.env.APPDATA || '', 'dynamic-island')
  let dataSizeKB = 0
  if (fs.existsSync(userDataDir)) {
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
      dataSizeKB = Math.round(walk(userDataDir) / 1024)
    } catch { /* 忽略统计失败 */ }
  }
  return {
    appName: APP_NAME,
    version: app.getVersion() || '3.1.0',
    installDir: installDir(),
    userDataDir,
    hasData: fs.existsSync(userDataDir),
    dataSizeKB,
  }
})

// 执行卸载:退主应用 → 删快捷方式 → 删注册表 → 可选删个人数据 → 100%
ipcMain.handle('unins:run', async (_e, opts) => {
  const deleteData = !!(opts && opts.deleteData)
  const dir = installDir()
  const desktopLnk = path.join(process.env.USERPROFILE || '', 'Desktop', `${APP_NAME}.lnk`)
  const startLnk = path.join(
    process.env.APPDATA || '',
    'Microsoft', 'Windows', 'Start Menu', 'Programs',
    `${APP_NAME}.lnk`,
  )
  const userDataDir = path.join(process.env.APPDATA || '', 'dynamic-island')
  try {
    emitProgress({ percent: 0.1, title: '正在退出灵动岛…', stage: '', file: '' })
    // 1. 结束主应用 electron.exe(卸载器进程名不同,不会误杀自身)
    try {
      spawnSync('taskkill.exe', ['/IM', 'electron.exe', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch { /* 忽略 */ }
    // 2. 快捷方式(失败降级,不阻断)
    emitProgress({ percent: 0.35, title: '移除快捷方式…', stage: '', file: '' })
    for (const lnk of [desktopLnk, startLnk]) {
      try { fs.rmSync(lnk, { force: true }) } catch { /* 忽略 */ }
    }
    // 3. 注册表卸载项 + 开机自启项(reg.exe,降级忽略)
    emitProgress({ percent: 0.55, title: '清除注册表项…', stage: '', file: '' })
    const uninsKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + APP_NAME
    const runKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
    try {
      spawnSync('reg.exe', ['delete', uninsKey, '/f'], { windowsHide: true, stdio: 'ignore' })
    } catch { /* 忽略 */ }
    try {
      spawnSync('reg.exe', ['delete', runKey, '/v', APP_NAME, '/f'], { windowsHide: true, stdio: 'ignore' })
    } catch { /* 忽略 */ }
    // 4. 个人数据(可选)
    if (deleteData) {
      emitProgress({ percent: 0.75, title: '删除个人数据…', stage: '', file: '' })
      try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
    }
    emitProgress({ percent: 1, title: '卸载完成', stage: '', file: '' })
    return { ok: true, installDir: dir }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
})

// 完成卸载:延迟删除安装目录(等卸载器自身进程退出后整体清除)再退出
ipcMain.handle('unins:finish', async () => {
  const dir = installDir()
  try {
    const script = `timeout /t 2 /nobreak >nul & rmdir /s /q "${dir}"`
    const child = spawn('cmd.exe', ['/c', script], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
  } catch { /* 忽略 */ }
  app.exit(0)
  return { ok: true }
})

// 取消卸载:直接退出,不删除安装目录
ipcMain.handle('unins:cancel', async () => {
  app.exit(0)
  return { ok: true }
})

ipcMain.on('unins:minimize', () => {
  if (win && !win.isDestroyed()) win.minimize()
})

app.whenReady().then(() => createWindow())
app.on('window-all-closed', () => app.quit())
