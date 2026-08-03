/**
 * 灵动岛桌面挂件 —— Electron 主进程
 *
 * 窗口特性:
 * - 无边框 + 全透明:只有灵动岛本体可见,像浮在桌面上的挂件
 * - 置顶 + 跳过任务栏:不打扰其他窗口
 * - 点击穿透:岛体之外的透明区域鼠标直接穿透给下层窗口,
 *   鼠标移入岛体时才接收点击(渲染端通过 IPC 切换)
 * - 右键长按拖拽移动挂件(位置自由,不限制在屏幕内)
 * - 托盘常驻:显示/隐藏、置顶、开机自启、退出
 *
 * 系统媒体桥接:以 utilityProcess 启动 esbuild 打包后的
 * system-media-bridge.cjs(独立进程,崩溃自动重启),负责 SMTC 监听。
 */
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  utilityProcess,
  screen,
} = require('electron')
const path = require('node:path')
const fs = require('node:fs')

// 透明窗口在 Windows GPU 合成下,叠在其他应用上方时半透明区域
// (岛体背景)的 alpha 偶发突变(闪全黑/全透明)。
// 禁用硬件加速走软件渲染:小窗口 60fps 无压力,合成稳定
app.disableHardwareAcceleration()

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const WINDOW_W = 520
// 高度容纳:岛体展开 260(挂件版面板加高)+ 上边距 8 + 余量
const WINDOW_H = 280
/** 桥接进程 10 秒内连续崩溃达到该次数则放弃重启(如端口被占用) */
const BRIDGE_RESTART_WINDOW_MS = 10_000
const BRIDGE_MAX_RESTARTS = 3

let win = null
let tray = null
let bridgeProc = null
let bridgeRestartCount = 0
let bridgeFirstCrashAt = 0
/** 显式退出标记:close 事件据此决定 hide 还是真关 */
let quitting = false

// ---------------------------------------------------------------------------
// 配置持久化(userData/settings.json)
// ---------------------------------------------------------------------------

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
  } catch {
    return {}
  }
}

function saveSettings(patch) {
  try {
    const next = { ...loadSettings(), ...patch }
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2))
  } catch (err) {
    console.error('[widget] save settings failed:', err)
  }
}

// ---------------------------------------------------------------------------
// 图标
// ---------------------------------------------------------------------------

function iconImage(size) {
  try {
    return nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({
      width: size,
      height: size,
    })
  } catch {
    return nativeImage.createEmpty()
  }
}

// ---------------------------------------------------------------------------
// 系统媒体桥接(utilityProcess)
// ---------------------------------------------------------------------------

/** bridge.cjs 由 scripts/build-electron.mjs 用 esbuild 打包生成 */
function bridgeModulePath() {
  return path.join(__dirname, 'bridge.cjs')
}

/** SMTC 读取脚本:打包后放在 resources/bridge/,开发时在 electron/ 下 */
function readerScriptPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'bridge', 'smtc-reader.ps1')
  return path.join(__dirname, 'smtc-reader.ps1')
}

function startBridge() {
  try {
    bridgeProc = utilityProcess.fork(bridgeModulePath(), [], {
      env: { ...process.env, SMTC_READER_PATH: readerScriptPath() },
      stdio: 'pipe',
    })
    bridgeProc.stdout?.on('data', (chunk) => process.stdout.write(`[bridge] ${chunk}`))
    bridgeProc.stderr?.on('data', (chunk) => process.stderr.write(`[bridge] ${chunk}`))
    bridgeProc.on('exit', (code) => {
      const now = Date.now()
      if (now - bridgeFirstCrashAt > BRIDGE_RESTART_WINDOW_MS) {
        bridgeRestartCount = 0
        bridgeFirstCrashAt = now
      }
      bridgeProc = null
      if (quitting) return
      if (code === 0) return // 正常退出(如端口冲突主动退出)不重启
      bridgeRestartCount += 1
      if (bridgeRestartCount > BRIDGE_MAX_RESTARTS) {
        console.error('[widget] bridge keeps crashing, giving up restarting')
        return
      }
      console.error(`[widget] bridge exited (${code}), restarting in 2s...`)
      setTimeout(startBridge, 2000)
    })
  } catch (err) {
    console.error('[widget] failed to start bridge:', err)
  }
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

function defaultBounds() {
  const { workArea } = screen.getPrimaryDisplay()
  return {
    x: Math.round(workArea.x + (workArea.width - WINDOW_W) / 2),
    y: workArea.y + 6,
    width: WINDOW_W,
    height: WINDOW_H,
  }
}

function createWindow() {
  const settings = loadSettings()
  // 每次启动都从桌面顶部居中出现(不恢复上次位置)
  const bounds = defaultBounds()

  win = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    show: false,
    icon: iconImage(32),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })

  win.setAlwaysOnTop(settings.alwaysOnTop !== false, 'screen-saver')
  // 默认点击穿透;渲染端鼠标进入岛体后经 IPC 切换为可点击
  win.setIgnoreMouseEvents(true, { forward: true })

  // 加载挂件页面:开发时可用 WIDGET_DEV_URL 指向 vite dev server
  const devUrl = process.env.WIDGET_DEV_URL
  if (devUrl) {
    win.loadURL(devUrl)
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist-widget', 'widget', 'widget.html'))
  }

  win.once('ready-to-show', () => win.show())

  // 关闭 = 隐藏(挂件常驻托盘),托盘"退出"才真正结束
  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      win.hide()
    }
  })

  // 渲染进程异常诊断(卡死/崩溃排查)
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[widget] renderer gone:', details.reason)
  })

  // 调试:设置 WIDGET_SCREENSHOT=<path> 时,页面加载后截一张窗口图用于验证。
  // 可选 WIDGET_SCREENSHOT_MODE=expanded:先模拟长按展开面板再截图。
  if (process.env.WIDGET_SCREENSHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          if (process.env.WIDGET_SCREENSHOT_MODE === 'expanded' || process.env.WIDGET_SCREENSHOT_MODE === 'layout') {
            await win.webContents.executeJavaScript(`(async () => {
              const island = document.querySelector('.island-demo')
              if (!island) return 'no island'
              const r = island.getBoundingClientRect()
              const x = r.left + r.width / 2
              const y = r.top + r.height / 2
              const down = new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 })
              const up = new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 })
              island.dispatchEvent(down)
              await new Promise((res) => setTimeout(res, 600))
              island.dispatchEvent(up)
              await new Promise((res) => setTimeout(res, 800))
              return 'expanded=' + island.classList.contains('expanded')
            })()`)
          }
          if (process.env.WIDGET_SCREENSHOT_MODE === 'layout') {
            // 布局诊断:输出展开面板各区域的位置
            const layout = await win.webContents.executeJavaScript(`(() => {
              const q = (sel) => {
                const el = document.querySelector(sel)
                if (!el) return null
                const r = el.getBoundingClientRect()
                return { top: Math.round(r.top), height: Math.round(r.height), bottom: Math.round(r.bottom) }
              }
              return JSON.stringify({
                panel: q('.island-panel'),
                head: q('.island-panel-head'),
                lyric: q('.island-panel-lyric-inline'),
                progressRow: q('.island-panel-progress-row'),
                controls: q('.island-panel-controls'),
                island: q('.island-demo'),
              })
            })()`)
            console.log('[widget] layout:', layout)
          }
          if (process.env.WIDGET_SCREENSHOT_MODE === 'theme') {
            // 展开 + 打开取色面板(视觉验证)
            await win.webContents.executeJavaScript(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const island = document.querySelector('.island-demo')
              const r = island.getBoundingClientRect()
              const x = r.left + r.width / 2
              const y = r.top + r.height / 2
              island.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 }))
              setTimeout(() => island.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 })), 600)
              await sleep(1100)
              document.querySelector('.island-ctl--theme')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(500)
              return 'theme view open: ' + !!document.querySelector('.island-panel-theme')
            })()`)
          }
          if (process.env.WIDGET_SCREENSHOT_MODE === 'stress') {
            // 压力测试:10 轮 展开→操作→收起,采样动画帧间隔,检测卡死/卡顿
            const result = await win.webContents.executeJavaScript(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const out = { rounds: [] }
              const island = document.querySelector('.island-demo')
              const r = island.getBoundingClientRect()
              const x = r.left + r.width / 2
              const y = r.top + r.height / 2
              const pressIsland = () => {
                island.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 }))
                setTimeout(() => island.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 })), 600)
              }
              // 采样 RAF 间隔(动画流畅度)
              const sampleFps = (ms) => new Promise((res) => {
                const gaps = []
                let last = performance.now()
                const tick = (now) => {
                  gaps.push(now - last)
                  last = now
                  if (performance.now() - start < ms) requestAnimationFrame(tick)
                  else res(Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length))
                }
                const start = performance.now()
                requestAnimationFrame(tick)
              })
              let slowFrames = 0
              for (let i = 0; i < 10; i++) {
                const t0 = performance.now()
                pressIsland()
                await sleep(1000)
                const mid = await sampleFps(600)
                // 展开中点模式按钮
                document.querySelector('.island-ctl--mode')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                await sleep(200)
                // 点面板外收起
                document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 60, pointerId: 2, isPrimary: true, button: 0 }))
                await sleep(900)
                const collapsed = !island.classList.contains('expanded')
                const dt = Math.round(performance.now() - t0)
                if (mid > 80) slowFrames++
                out.rounds.push({ i, collapsed, avgFrameMs: mid, roundMs: dt })
                await sleep(200)
              }
              out.slowFrames = slowFrames
              out.rendererAlive = true
              return JSON.stringify(out)
            })()`)
            console.log('[widget] stress:', result)
          }
          if (process.env.WIDGET_SCREENSHOT_MODE === 'test') {
            // 综合交互测试:展开 → 取色面板 → 应用主题色 → 收起
            const result = await win.webContents.executeJavaScript(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const out = {}
              const island = document.querySelector('.island-demo')
              const r = island.getBoundingClientRect()
              const x = r.left + r.width / 2
              const y = r.top + r.height / 2
              const press = (t) => {
                island.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 }))
                setTimeout(() => island.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 })), t)
              }
              // 1. 长按展开
              press(600)
              await sleep(1100)
              out.expanded = island.classList.contains('expanded')
              // 2. 主题色按钮存在
              const themeBtn = document.querySelector('.island-ctl--theme')
              out.themeButton = !!themeBtn
              // 3. 点击切换到主题色视图
              themeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.pickerShown = !!document.querySelector('.island-panel-theme')
              // 4. 点击红色预设,主题色生效
              const swatch = [...document.querySelectorAll('.island-theme-swatch')].find((s) => s.title === '#f87171')
              swatch.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.themeApplied = island.style.getPropertyValue('--state-color') === '#f87171'
              // 5. 恢复默认(跟随播放模式色块)
              document.querySelector('.island-theme-swatch--follow').dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.themeReset = island.style.getPropertyValue('--state-color') !== '#f87171'
              // 6. 点击岛体收起(模拟点击面板外空白)
              document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 60, pointerId: 2, isPrimary: true, button: 0 }))
              await sleep(900)
              out.collapsed = !island.classList.contains('expanded')
              return JSON.stringify(out)
            })()`)
            console.log('[widget] test:', result)
          }
          const image = await win.webContents.capturePage()
          fs.writeFileSync(process.env.WIDGET_SCREENSHOT, image.toPNG())
          console.log('[widget] screenshot saved')
        } catch (err) {
          console.error('[widget] screenshot failed:', err)
        }
      }, 3000)
    })
  }

  // 每次启动固定顶部居中,不持久化位置
  win.on('closed', () => {
    win = null
  })
}

function showWindow() {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function toggleWindow() {
  if (win && win.isVisible()) win.hide()
  else showWindow()
}

// ---------------------------------------------------------------------------
// IPC:渲染端(挂件页面) → 主进程
// ---------------------------------------------------------------------------

ipcMain.on('widget:pointer', (_event, active) => {
  if (!win) return
  // 点击穿透开关:true = 鼠标在岛上,正常接收事件;false = 穿透给下层窗口
  win.setIgnoreMouseEvents(!active, { forward: !active })
})

ipcMain.on('widget:hide', () => win?.hide())
ipcMain.on('widget:quit', () => {
  quitting = true
  app.quit()
})
ipcMain.on('widget:topmost', (_event, on) => {
  win?.setAlwaysOnTop(Boolean(on), 'screen-saver')
  saveSettings({ alwaysOnTop: Boolean(on) })
})

// 调整窗口高度:背景编辑器视图需要更高空间,离开视图回落常规高度
ipcMain.on('widget:set-height', (_event, height) => {
  if (!win) return
  const h = Number(height)
  if (!Number.isFinite(h)) return
  const clamped = Math.max(200, Math.min(2000, Math.round(h)))
  win.setSize(WINDOW_W, clamped)
})

// 右键长按拖拽移动挂件。
// 用"绝对定位"而非"相对位移":窗口位置 = 鼠标当前位置 - 按下时鼠标相对
// 窗口的偏移。窗口移动后 Chromium 会合成新的指针事件(指针相对窗口位置
// 变了),若用相对位移计算会形成正反馈(窗口移一点→合成事件→再移→循环),
// 表现为"鼠标没动窗口自己平移"。绝对定位只依赖当前坐标,不累积误差。
let dragState = null
// 屏幕坐标合理范围:真实光标/窗口位置不会超出(多显示器 + 拖出屏幕
// 也远够余量);超出说明数据异常(如 getPosition 返回异常值污染偏移),
// 直接丢弃,绝不传给 setPosition——其 int32 参数转换对超界有限值
// (|v| ≥ 2^31)会抛未捕获异常
const SANE_POS_LIMIT = 100000

ipcMain.on('widget:drag-start', (_event, sx, sy) => {
  if (!win) return
  if (!Number.isFinite(sx) || !Number.isFinite(sy)) return
  const [wx, wy] = win.getPosition()
  // 窗口位置异常时拒绝进入拖拽状态,避免污染按下偏移
  if (
    !Number.isFinite(wx) ||
    !Number.isFinite(wy) ||
    Math.abs(wx) > SANE_POS_LIMIT ||
    Math.abs(wy) > SANE_POS_LIMIT
  ) {
    return
  }
  // 按下瞬间鼠标相对窗口左上角的偏移(拖动期间保持恒定)
  const pressOffsetX = sx - wx
  const pressOffsetY = sy - wy
  if (!Number.isFinite(pressOffsetX) || !Number.isFinite(pressOffsetY)) return
  dragState = { pressOffsetX, pressOffsetY }
})

ipcMain.on('widget:drag-move', (_event, sx, sy) => {
  if (!win || !dragState) return
  if (!Number.isFinite(sx) || !Number.isFinite(sy)) return
  // 位置自由:窗口 = 鼠标 - 按下偏移,不限制在屏幕内。
  // 计算后校验:非有限值或超出合理范围(异常输入/偏移被污染)一律丢弃
  const x = Math.round(sx - dragState.pressOffsetX)
  const y = Math.round(sy - dragState.pressOffsetY)
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    Math.abs(x) > SANE_POS_LIMIT ||
    Math.abs(y) > SANE_POS_LIMIT
  ) {
    console.error('[widget] drag-move rejected (invalid position):', x, y, 'cursor:', sx, sy)
    return
  }
  // setPosition 的 int32 参数转换在极端值下仍可能抛异常(防御纵深):
  // 任何转换失败都被捕获并记录真实值,拖拽不会崩主进程
  try {
    win.setPosition(x, y)
  } catch (err) {
    console.error(
      '[widget] drag-move setPosition failed:',
      JSON.stringify(x),
      JSON.stringify(y),
      'cursor:',
      JSON.stringify(sx),
      JSON.stringify(sy),
      err,
    )
    return
  }
  // 自校正:窗口实际落点与目标不一致(OS 取整等)时重算偏移,
  // 保证下一次移动继续"跟手",不累积相对偏移;异常落点不采信
  const [ax, ay] = win.getPosition()
  if (
    Number.isFinite(ax) &&
    Number.isFinite(ay) &&
    Math.abs(ax) <= SANE_POS_LIMIT &&
    Math.abs(ay) <= SANE_POS_LIMIT &&
    (ax !== x || ay !== y)
  ) {
    dragState.pressOffsetX = sx - ax
    dragState.pressOffsetY = sy - ay
  }
})

ipcMain.on('widget:drag-end', () => {
  dragState = null
})

// ---------------------------------------------------------------------------
// 托盘
// ---------------------------------------------------------------------------

function setAlwaysOnTop(on) {
  win?.setAlwaysOnTop(Boolean(on), 'screen-saver')
  saveSettings({ alwaysOnTop: Boolean(on) })
}

function setLoginAtStartup(on) {
  app.setLoginItemSettings({
    openAtLogin: Boolean(on),
    path: process.execPath,
    args: [],
  })
}

function rebuildTrayMenu() {
  if (!tray) return
  const settings = loadSettings()
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示 / 隐藏灵动岛',
        click: () => toggleWindow(),
      },
      { type: 'separator' },
      {
        label: '自定义背景…',
        click: () => {
          // 入口在托盘,编辑界面在灵动岛内打开(渲染端切换到背景视图)
          showWindow()
          win?.webContents.send('widget:open-background-editor')
        },
      },
      { type: 'separator' },
      {
        label: '总在最前',
        type: 'checkbox',
        checked: settings.alwaysOnTop !== false,
        click: (item) => setAlwaysOnTop(item.checked),
      },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => setLoginAtStartup(item.checked),
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true
          app.quit()
        },
      },
    ]),
  )
}

function createTray() {
  // 32px 源图在高 DPI 托盘下更清晰(Windows 自动缩放到显示尺寸)
  tray = new Tray(iconImage(32))
  tray.setToolTip('灵动岛挂件')
  rebuildTrayMenu()
  tray.on('click', () => toggleWindow())
  tray.on('right-click', () => tray.popUpContextMenu())
}

// ---------------------------------------------------------------------------
// 应用生命周期
// ---------------------------------------------------------------------------

// 单实例:重复启动时唤起已有挂件
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())

  app.whenReady().then(() => {
    createWindow()
    createTray()
    startBridge()
  })

  app.on('before-quit', () => {
    quitting = true
    try {
      bridgeProc?.kill()
    } catch {
      // already gone
    }
  })

  // 挂件常驻:所有窗口关闭也不退出(托盘退出除外)
  app.on('window-all-closed', () => {})
}
