
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
  dialog,
  shell,
} = require('electron')
const path = require('node:path')
const fs = require('node:fs')

// Agent 引擎(由 scripts/build-electron.mjs 打包):DeepSeek Responses API
// provider + 工具系统,主进程内运行(纯异步网络/文件 IO,无阻塞点)
const agentEngineModule = require('./agent.cjs')

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
// 模式(音乐播放器 ↔ Agent)
// ---------------------------------------------------------------------------

function currentMode() {
  return loadSettings().mode === 'agent' ? 'agent' : 'music'
}

function setWidgetMode(mode, source = 'user') {
  const next = mode === 'agent' ? 'agent' : 'music'
  saveSettings({ mode: next })
  // source:切换来源——'tool' = Agent 的 switch_to_music 工具(属于对话
  // 流程,渲染端据此**不中止**正在运行的本轮,回复正常落定);
  // 'user' = 托盘/手势(用户主动离开,中止当前轮)
  win?.webContents.send('widget:set-mode', { mode: next, source })
  // 托盘 radio 选中态同步:菜单 checked 是构建时一次性设置的,
  // 代码路径切换(Agent 工具 switch_to_music)不会自动更新——
  // 必须重建菜单(rebuildTrayMenu 同时更新 tooltip),否则托盘
  // 仍显示旧的模式选中
  rebuildTrayMenu()
}

// ---------------------------------------------------------------------------
// Agent 引擎(懒加载单例;配置与持久化走 settings.json 的 agent 段)
// ---------------------------------------------------------------------------

// 默认技能扫描源:Claude Code / Codex / opencode 的技能目录(存在才加入,
// 目录内需含 SKILL.md 约定)+ 挂件自有技能目录(userData/skills,
// 加载时不存在也不报错,用户可放置自制技能)。用户可在 Agent 设置里
// 增删任意目录
const DEFAULT_SKILLS_DIRS = (() => {
  const home = process.env.USERPROFILE || process.env.HOME || 'C:/Users'
  const candidates = [
    path.join(home, '.claude', 'skills'), // Claude Code
    path.join(home, '.codex', 'skills'), // Codex
    path.join(home, '.config', 'opencode', 'skills'), // opencode CLI
    path.join(home, '.config', 'opencode', 'plugins', 'skills'), // opencode plugins 形态
  ]
  const dirs = candidates.filter((d) => fs.existsSync(d))
  dirs.push(path.join(app.getPath('userData'), 'skills')) // 挂件自有技能目录
  return dirs
})()

const AGENT_CONFIG_DEFAULTS = {
  apiKey: '',
  baseURL: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
  systemPrompt:
    '你是运行在桌面灵动岛挂件里的个人助手,名叫「岛灵」。' +
    '你可以调用本机工具(执行命令、读写文件、联网搜索、发通知等),' +
    '根据用户自然语言直接完成操作,无需沙箱限制。' +
    '回答简洁自然,使用与用户相同的语言;执行工具时先说明意图。',
  reasoningEffort: 'high',
  /** MCP 服务列表(每个服务暴露 mcp_<服务>_<工具> 工具) */
  mcpServers: [],
  /** 技能目录列表(扫描 SKILL.md,每个技能暴露 skill_<名字> 工具) */
  skillsDirs: DEFAULT_SKILLS_DIRS,
  /** 已排除技能(扫描跳过;LLM 对话 / 设置界面移除) */
  excludedSkills: [],
  /** 已禁用工具名(工具列表视图禁用;内置/MCP/技能一律生效) */
  excludedTools: [],
}

let agentEngine = null

// 记忆系统:独立文件 userData/memory.json(与 settings.json 分离——
// 记忆高频变更,独立文件不污染配置;损坏不影响配置)。主进程持有
// store 单例(记忆工具与进化 harness 共用),渲染端经 IPC 编辑
let memoryStore = null

function getMemoryStore() {
  if (memoryStore) return memoryStore
  memoryStore = agentEngineModule.createMemoryStore(() =>
    path.join(app.getPath('userData'), 'memory.json'),
  )
  return memoryStore
}

// 自我进化 harness(懒加载单例):评审 → 改进 → 复评 → 棘轮(严格更高分
// 才提交,否则回滚快照),日志 evolution.json,设置界面可回滚
let evolutionHandle = null

function getEvolution() {
  if (evolutionHandle) return evolutionHandle
  evolutionHandle = agentEngineModule.createEvolution({
    getConfig: () => ({ ...AGENT_CONFIG_DEFAULTS, ...(loadSettings().agent ?? {}) }),
    getStore: () => getMemoryStore(),
    getMemoryDir: () => app.getPath('userData'),
    onEvent: (event) => win?.webContents.send('agent:event', event),
  })
  return evolutionHandle
}

/** LLM 自我配置补丁 → settings.json(与 agent:config-set 同款校验) */
function applyAgentConfigPatch(patch) {
  const current = loadSettings().agent ?? {}
  const next = { ...current }
  for (const key of ['apiKey', 'baseURL', 'model', 'systemPrompt', 'reasoningEffort']) {
    const value = patch?.[key]
    if (typeof value === 'string') {
      next[key] = value.slice(0, 20000)
    }
  }
  if (Array.isArray(patch?.skillsDirs)) {
    const dirs = []
    for (const d of patch.skillsDirs) {
      if (typeof d !== 'string') continue
      const t = d.trim().slice(0, 1000)
      if (t && !dirs.includes(t)) dirs.push(t)
    }
    next.skillsDirs = dirs.slice(0, 50)
  }
  // 已排除技能(slug 字符串数组,去空去重)
  if (Array.isArray(patch?.excludedSkills)) {
    const ex = []
    for (const s of patch.excludedSkills) {
      if (typeof s !== 'string') continue
      const t = s.trim().replace(/^skill_/, '').slice(0, 100)
      if (t && !ex.includes(t)) ex.push(t)
    }
    next.excludedSkills = ex.slice(0, 100)
  }
  // 已禁用工具(工具名字符串数组,去空去重)
  if (Array.isArray(patch?.excludedTools)) {
    const ex = []
    for (const s of patch.excludedTools) {
      if (typeof s !== 'string') continue
      const t = s.trim().slice(0, 100)
      if (t && !ex.includes(t)) ex.push(t)
    }
    next.excludedTools = ex.slice(0, 200)
  }
  if (Array.isArray(patch?.mcpServers)) {
    const servers = []
    for (const s of patch.mcpServers) {
      if (!s || typeof s !== 'object') continue
      const name = String(s.name ?? '').trim().slice(0, 100)
      if (!name) continue
      // sse 服务:url 必填;stdio 服务:command 必填
      const type = s.type === 'sse' ? 'sse' : 'stdio'
      if (type === 'sse') {
        const url = String(s.url ?? '').trim().slice(0, 2000)
        if (!url) continue
        const headers = {}
        if (s.headers && typeof s.headers === 'object') {
          for (const [k, v] of Object.entries(s.headers)) {
            if (typeof v === 'string') headers[k.slice(0, 200)] = v.slice(0, 2000)
          }
        }
        servers.push({ name, type: 'sse', command: url, url, headers })
        continue
      }
      const command = String(s.command ?? '').trim().slice(0, 500)
      if (!command) continue
      const args = Array.isArray(s.args)
        ? s.args.filter((a) => typeof a === 'string').map((a) => a.slice(0, 500)).slice(0, 50)
        : []
      const env = {}
      if (s.env && typeof s.env === 'object') {
        for (const [k, v] of Object.entries(s.env)) {
          if (typeof v === 'string') env[k.slice(0, 200)] = v.slice(0, 2000)
        }
      }
      servers.push({ name, type: 'stdio', command, args, env })
    }
    next.mcpServers = servers.slice(0, 20)
  }
  saveSettings({ agent: next })
  return next
}

function getAgentEngine() {
  if (agentEngine) return agentEngine
  agentEngine = agentEngineModule.createAgentEngine({
    getConfig: () => ({ ...AGENT_CONFIG_DEFAULTS, ...(loadSettings().agent ?? {}) }),
    onEvent: (event) => {
      // 后台任务完成通知(background-done)只在 Agent 模式转发:
      // 渲染端收到会**自动触发一轮对话**(LLM 主动告知结果)——音乐
      // 模式下自动对话没有意义,还会污染历史
      if (event.type === 'background-done' && currentMode() !== 'agent') return
      win?.webContents.send('agent:event', event)
    },
    onSwitchToMusic: () => setWidgetMode('music', 'tool'),
    // 记忆系统(引擎记忆工具 + 系统提示记忆块)
    getMemoryStore: () => getMemoryStore(),
    // 自我进化 harness(evolve_memory 工具 + 系统提示状态注入)
    getEvolution: () => getEvolution(),
    // LLM 自我配置(mcp_config / skills_config 工具写 settings.json)
    updateAgentConfig: (patch) => applyAgentConfigPatch(patch),
    // 技能创建写入目录(userData/skills,默认扫描源之一)
    getSkillDir: () => path.join(app.getPath('userData'), 'skills'),
    // 灵动岛设置工具(主题色/缩放/字体/背景图库,应用后即时生效)
    runIslandSettings,
  })
  return agentEngine
}

// ---------------------------------------------------------------------------
// 灵动岛设置工具:调渲染端设置桥(LLM 改主题色/缩放/字体/背景图,即时生效)
// ---------------------------------------------------------------------------

// 引擎设置工具(electron/agent/settingsTools.ts)经此回调执行渲染端操作:
// executeJavaScript 在页面上下文调用 window.__islandSettings(挂件版
// WidgetApp 注册的 src/settingsBridge.ts)——桥写 localStorage/IndexedDB
// 后派发 island-settings-changed 事件,UI 监听重读 → 即时生效。
// 桥的错误统一转 {error} 结构,这里抛出(引擎按"工具执行失败"回填,
// LLM 可自纠);executeJavaScript 会 await 桥方法返回的 Promise
async function runIslandSettings(op, args) {
  if (!win || win.isDestroyed()) throw new Error('挂件窗口不可用')
  const argJson = (args ?? []).map((a) => JSON.stringify(a)).join(', ')
  const result = await win.webContents.executeJavaScript(
    `(async () => {
      const fn = window.__islandSettings ? window.__islandSettings[${JSON.stringify(op)}] : null
      if (typeof fn !== 'function') return { error: '设置桥未就绪(稍后重试)' }
      try {
        return await fn(${argJson})
      } catch (err) {
        return { error: (err && err.message) ? String(err.message) : String(err) }
      }
    })()`,
  )
  if (result && typeof result === 'object' && typeof result.error === 'string') {
    throw new Error(result.error)
  }
  return result
}

// 独立的总结后台 Sub Agent(懒加载单例):与主对话引擎零共享——
// 对话的发送/中止/清空都不会打断总结,总结失败也不外溢到对话
let summaryAgent = null

function getSummaryAgent() {
  if (summaryAgent) return summaryAgent
  summaryAgent = agentEngineModule.createSummaryAgent({
    getConfig: () => ({ ...AGENT_CONFIG_DEFAULTS, ...(loadSettings().agent ?? {}) }),
  })
  return summaryAgent
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
  // 加载完成后广播当前模式(渲染端启动时也走 getMode 兜底)
  win.webContents.once('did-finish-load', () => {
    win?.webContents.send('widget:set-mode', { mode: currentMode(), source: 'user' })
    // 初次安装:settings.json 不存在 → 落盘首启标记并自动打开帮助手册
    // (教学引导;文件存在后下次启动不再弹出)
    if (!fs.existsSync(settingsPath())) {
      saveSettings({ firstRun: true })
      setTimeout(() => win?.webContents.send('widget:open-help'), 800)
    }
  })

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
            // 综合交互测试(全视图巡检):长按展开 → 托盘设置 → 主题色(应用/恢复)
            // → 字体 → 字体库 → 背景 → 帮助 → 逐级返回收起(设置类视图只能经返回键退出)
            const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
            const expanded = await win.webContents.executeJavaScript(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const island = document.querySelector('.island-demo')
              const r = island.getBoundingClientRect()
              const x = r.left + r.width / 2
              const y = r.top + r.height / 2
              island.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 }))
              setTimeout(() => island.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 })), 600)
              await sleep(1100)
              return island.classList.contains('expanded')
            })()`)
            console.log('[widget] test expanded:', expanded)
            // 歌词开关提示:默认已开,先关再开,播放键下方显示来源提示
            const lyricHint = await win.webContents.executeJavaScript(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const btn = document.querySelector('.island-ctl--lyric')
              if (!btn) return false
              btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(150)
              btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(150)
              const hintEl = document.querySelector('.island-hint-play')
              return !!hintEl && hintEl.textContent.includes('网易云')
            })()`)
            console.log('[widget] test lyricHint:', lyricHint)
            // 托盘"设置"入口:展开并切换到设置视图(渲染端 requestSettingsSeq)
            win.webContents.send('widget:open-settings')
            await sleep(600)
            const result = await win.webContents.executeJavaScript(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const out = {}
              const island = document.querySelector('.island-demo')
              const settingsItem = (text) =>
                [...document.querySelectorAll('.island-settings-item')].find((s) => s.textContent.includes(text))
              // 1. 设置视图
              out.settingsShown = !!document.querySelector('.island-settings-items')
              // 2. 主题色视图:取色器渲染 + 应用/恢复
              settingsItem('主题色').dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.pickerShown = !!document.querySelector('.island-theme-view .island-font-sv')
              const swatch = [...document.querySelectorAll('.island-theme-swatch')].find((s) => s.title === '#f87171')
              swatch.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.themeApplied = island.style.getPropertyValue('--state-color') === '#f87171'
              document.querySelector('.island-theme-swatch--follow').dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.themeReset = island.style.getPropertyValue('--state-color') !== '#f87171'
              document.querySelector('.island-theme-view .island-bg-back').dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.backToSettings = !!document.querySelector('.island-settings-items')
              // 3. 字体视图 → 字体库 → 返回
              settingsItem('字体').dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.fontShown = !!document.querySelector('.island-font-view')
              const libBtn = [...document.querySelectorAll('.island-font-actions .island-ctl')].find((s) => s.textContent.includes('字体库'))
              libBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.fontLibraryShown = !!document.querySelector('.island-lib-view .island-lib-search')
              document.querySelector('.island-lib-foot .island-ctl--back').dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.backToFont = !!document.querySelector('.island-font-view')
              document.querySelector('.island-font-foot .island-bg-back').dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.backToSettings2 = !!document.querySelector('.island-settings-items')
              // 4. 背景视图 → 不透明度按形态独立(紧凑态改滑杆,展开态不受影响)→ 返回
              settingsItem('自定义图片背景').dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.bgShown = !!document.querySelector('.island-panel-bg')
              out.bgSegShown = !!document.querySelector('.island-bg-seg')
              const opSlider = () => document.querySelectorAll('.island-bg-slider input[type=range]')[1]
              const segBtn = (text) => [...document.querySelectorAll('.island-bg-seg button')].find((b) => b.textContent.includes(text))
              if (opSlider()) {
                const setVal = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
                const dragTo = async (v) => {
                  setVal.call(opSlider(), v)
                  opSlider().dispatchEvent(new Event('input', { bubbles: true }))
                  opSlider().dispatchEvent(new Event('change', { bubbles: true }))
                  await sleep(300)
                }
                // 展开态改 40
                await dragTo('40')
                const expandedA = opSlider().value
                // 切紧凑态:滑杆应显示紧凑态原值(≠ 40,不受展开态改动影响)
                segBtn('紧凑态').dispatchEvent(new MouseEvent('click', { bubbles: true }))
                await sleep(300)
                const compactShown = opSlider().value
                // 紧凑态改 70
                await dragTo('70')
                const compactB = opSlider().value
                // 切回展开态:应仍为 40(紧凑态的改动不生效于展开态)
                segBtn('展开态').dispatchEvent(new MouseEvent('click', { bubbles: true }))
                await sleep(300)
                const expandedB = opSlider().value
                out.opacityIndependent =
                  compactShown !== expandedA && compactB === '70' && expandedB === expandedA
                out.opacityDebug = JSON.stringify({ expandedA, compactShown, compactB, expandedB })
              } else {
                out.opacityIndependent = 'n/a (无背景图时无滑杆)'
              }
              document.querySelector('.island-panel-bg .island-bg-back').dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.backToSettings3 = !!document.querySelector('.island-settings-items')
              // 5. 帮助视图 → 返回
              settingsItem('帮助手册').dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.helpShown = !!document.querySelector('.island-help-items')
              document.querySelector('.island-panel-list:has(.island-help-items) .island-bg-back').dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.backToSettings4 = !!document.querySelector('.island-settings-items')
              // 6. 设置 → 返回收起(设置视图只能经返回键退出)
              document.querySelector('.island-panel-list:has(.island-settings-items) .island-bg-back').dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(900)
              out.collapsed = !island.classList.contains('expanded')
              return JSON.stringify(out)
            })()`)
            console.log('[widget] test:', result)
          }
          if (process.env.WIDGET_SCREENSHOT_MODE === 'agent') {
            // Agent 功能巡检(严格 UI 测试):托盘设置 → Agent 设置视图 →
            // 表单/MCP 双传输编辑/测试连接/技能目录/记忆增删/进化/保存。
            // 分两段:段 1 进入 agent-settings 视图停留(主进程截图),
            // 段 2 逐项交互断言(React 受控输入用原生 value setter)。
            // env WIDGET_MOCK_SERVER = mock MCP stdio 服务器路径(测试命令
            // 先以保活 stdin 方式启动;command 用 node,由 PATH 解析)
            const mockServer = process.env.WIDGET_MOCK_SERVER || ''
            // 巡检会点击"保存配置"(表单状态写回 settings.json)——备份
            // 用户配置,巡检结束恢复(实测:巡检保存覆盖了用户 siyuan 配置)
            const settingsFile = settingsPath()
            let settingsBackup = null
            try {
              settingsBackup = fs.readFileSync(settingsFile, 'utf8')
            } catch {
              // 无配置可备份
            }
            // 托盘"设置"入口:展开并切换到设置视图(与 test 模式一致)
            win.webContents.send('widget:open-settings')
            await new Promise((r) => setTimeout(r, 800))
            // 段 0:歌词 API 接入点(设置 → 歌词 API:预设厂家选择 + 保存)
            const lyricApiResult = await win.webContents.executeJavaScript(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const out = {}
              const settingsItem = (text) =>
                [...document.querySelectorAll('.island-settings-item')].find((s) => s.textContent.includes(text))
              out.lyricApiEntry = !!settingsItem('歌词 API')
              settingsItem('歌词 API')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              const view = document.querySelector('.island-lyric-api')
              out.lyricApiViewShown = !!view
              out.presetCount = view?.querySelectorAll('.island-lyric-provider').length ?? 0
              // 选 QQ音乐 → 保存 → localStorage 校验。
              // 注意:保存后 React 重渲染可能替换节点,每次操作**实时查询**
              // (缓存引用会失效,与 MCP 填表同问题)
              const providerBtn = (text) =>
                [...(document.querySelectorAll('.island-lyric-provider') ?? [])].find((b) => b.textContent.includes(text))
              const saveBtn = () =>
                [...(document.querySelectorAll('.island-lyric-api button') ?? [])].find((b) => b.textContent.includes('保存歌词 API'))
              providerBtn('QQ音乐')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(200)
              saveBtn()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(300)
              out.savedProvider = localStorage.getItem('widget-lyric-provider') ?? '(无)'
              out.savedQq = (localStorage.getItem('widget-lyric-provider') ?? '').includes('qq')
              // 恢复默认(网易云)并返回设置(返回键也实时查询)
              providerBtn('网易云')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(200)
              saveBtn()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(300)
              out.restoredProvider = localStorage.getItem('widget-lyric-provider') ?? '(无)'
              // 自动切换开关:默认开启 → 点击关闭 → localStorage 校验 → 恢复开启
              const toggle = document.querySelector('.island-lyric-api .island-toggle')
              out.toggleShown = !!toggle
              out.toggleDefaultOn = toggle?.classList.contains('on') ?? false
              out.autoDefault = localStorage.getItem('widget-lyric-auto') ?? '(未设置=默认开)'
              toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(300)
              out.autoAfterOff = localStorage.getItem('widget-lyric-auto') ?? '(无)'
              toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(300)
              out.autoRestored = localStorage.getItem('widget-lyric-auto') ?? '(无)'
              // 返回键在 .island-panel-list 根部(BackFoot 在 .island-lyric-api 外)
              const backBtn = document.querySelector('.island-panel-list:has(.island-lyric-api) .island-bg-back')
              out.backBtnFound = !!backBtn
              out.backBtnText = backBtn?.textContent ?? '(无)'
              backBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.backToSettings = !!document.querySelector('.island-settings-items')
              out.lyricApiStillShown = !!document.querySelector('.island-lyric-api')
              return JSON.stringify(out)
            })()`)
            console.log('[widget] agent-lyric-api:', lyricApiResult)
            // 段 1:展开 → 设置视图 → Agent 设置视图
            const enterResult = await win.webContents.executeJavaScript(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const out = {}
              const island = document.querySelector('.island-demo')
              const settingsItem = (text) =>
                [...document.querySelectorAll('.island-settings-item')].find((s) => s.textContent.includes(text))
              out.openSettings = !!document.querySelector('.island-settings-items')
              const agentEntry = settingsItem('Agent 设置')
              out.agentEntryShown = !!agentEntry
              agentEntry?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(500)
              const view = document.querySelector('.island-agent-settings')
              out.agentSettingsShown = !!view
              if (view) {
                const form = view.querySelector('.island-agent-form')
                out.formShown = !!form
                out.apiKeyInput = !!form?.querySelector('input[placeholder*="sk-"]')
                // Base URL 输入无 placeholder,按输入框数量与顺序断言
                const formInputs = form?.querySelectorAll('input') ?? []
                out.baseUrlInput = formInputs.length >= 4
                out.modelInput = !!form?.querySelector('input[value="deepseek-v4-flash"]')
                out.promptTextarea = !!form?.querySelector('textarea')
                out.sectionTitles = [...view.querySelectorAll('.island-agent-section-title')].map((s) => s.textContent)
                out.scaleBtns = [...form.querySelectorAll('.island-agent-scale-btn')].filter((b) => b.textContent.includes('%')).length
              // 配置刷新验证:LLM 对话中写进 settings.json 的 MCP 服务,
              // 打开设置视图时应立即可见(useAgent 挂载时只读一次配置,
              // AgentSettingsView 挂载时 onRefresh 重新拉取)
              const mcpCards = view.querySelectorAll('.island-mcp-card')
              out.mcpCardCount = mcpCards.length
              // input 的 value 不在 textContent 里,检查服务名输入框的值
              out.mcpCardInputs = [...mcpCards].map((c) =>
                [...c.querySelectorAll('input')].map((i) => i.value).join('|'),
              )
              out.mcpPreconfiguredShown = [...mcpCards].some(
                (c) => c.querySelector('input[placeholder="如 filesystem"]')?.value === 'preconfigured',
              )
              }
              out.expanded = island.classList.contains('expanded')
              return JSON.stringify(out)
            })()`)
            console.log('[widget] agent-enter:', enterResult)
            console.log('[widget] window size at agent-settings:', win.getSize())
            // 截图 1:agent-settings 视图(独立文件名,避免被末尾通用截图覆盖)
            {
              const image = await win.webContents.capturePage()
              fs.writeFileSync(process.env.WIDGET_SCREENSHOT + '.agent1.png', image.toPNG())
              console.log('[widget] screenshot(agent-settings) saved')
            }
            // 段 2:交互断言
            const interactResult = await win.webContents.executeJavaScript(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const out = {}
              const view = document.querySelector('.island-agent-settings')
              const form = view?.querySelector('.island-agent-form')
              if (!view || !form) return JSON.stringify({ fatal: 'agent-settings 视图未打开' })
              // React 受控输入赋值(原生 setter + input 事件);元素不存在时
              // 记录并跳过(选择器与 DOM 不匹配时报错不如继续断言)
              const setInput = (el, value) => {
                if (!el) return false
                const proto = el.tagName === 'TEXTAREA'
                  ? window.HTMLTextAreaElement.prototype
                  : window.HTMLInputElement.prototype
                const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
                setter.call(el, value)
                el.dispatchEvent(new Event('input', { bubbles: true }))
                return true
              }
              const scrollInto = async (el) => {
                el?.scrollIntoView({ block: 'center' })
                await sleep(150)
              }
              const btnByText = (text) => [...view.querySelectorAll('.island-agent-scale-btn, .island-ctl')].find((b) => b.textContent.includes(text))

              // ---- MCP 服务编辑 ----
              const addBtn = btnByText('添加服务')
              await scrollInto(addBtn)
              addBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(200)
              // 取**最后一张**卡(刚添加的)——第一张可能是用户已有配置
              // (实测:填写时误改已有 siyuan 卡,覆盖了用户配置!)
              const cards = view.querySelectorAll('.island-mcp-card')
              const card = cards[cards.length - 1]
              out.mcpCardShown = !!card
              out.mcpCardCountBefore = cards.length
              // 类型切换:stdio → sse(sse 显示 URL/请求头,隐藏 command)
              const sseBtn = [...card.querySelectorAll('.island-mcp-type-row button')].find((b) => b.textContent.includes('sse'))
              sseBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(200)
              const urlInput = card.querySelector('input[placeholder*="https://"]')
              out.mcpSseUrlShown = !!urlInput
              out.mcpSseCommandHidden = ![...card.querySelectorAll('.island-agent-field span')].some((s) => s.textContent.includes('启动命令'))
              // 切回 stdio 并填入 mock 配置(只操作新添加的卡)
              const stdioBtn = [...card.querySelectorAll('.island-mcp-type-row button')].find((b) => b.textContent.includes('stdio'))
              stdioBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(200)
              // 填表:每次填写后等 React 渲染并**重新查询 DOM**——受控输入
              // 触发重渲染可能替换节点,旧引用的事件不再冒泡(实测:旧引用
              // 只生效第一个字段,其余丢失)
              const fillCard = async (selector, value) => {
                const cardNow = (() => {
                  const cs = view.querySelectorAll('.island-mcp-card')
                  return cs[cs.length - 1]
                })()
                const input = cardNow.querySelector(selector)
                await scrollInto(input)
                setInput(input, value)
                await sleep(200)
              }
              await fillCard('input[placeholder="如 filesystem"]', 'ui-mock')
              await fillCard('input[placeholder*="npx"]', 'node')
              await fillCard('textarea', ${JSON.stringify(mockServer)})
              // 测试连接(真实连 mock stdio 服务器,断言 6 个工具)
              // 重新查询当前卡片(React 重渲染可能替换 DOM)后点击测试
              const freshCard = (() => {
                const cs = view.querySelectorAll('.island-mcp-card')
                return cs[cs.length - 1]
              })()
              const freshTestBtn = [...freshCard.querySelectorAll('.island-mcp-actions button')].find((b) => b.textContent.includes('测试'))
              out.testBtnDisabled = freshTestBtn?.disabled ?? 'n/a'
              await scrollInto(freshTestBtn)
              freshTestBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(3000)
              const testResultEl = freshCard.querySelector('.island-mcp-test-result')
              out.mcpTestText = testResultEl?.textContent ?? '(无结果)'
              out.mcpTestOk = (testResultEl?.textContent ?? '').includes('连接成功')

              // ---- 技能目录 ----
              const skillsSection = [...view.querySelectorAll('.island-agent-section')].find((s) => s.textContent.includes('技能目录'))
              const skillsRows = skillsSection?.querySelectorAll('.island-skills-dir-row') ?? []
              out.skillsDirRows = [...skillsRows].map((r) => r.textContent.trim().slice(0, 60))
              out.skillsDefaultScanned = [...skillsRows].some((r) => r.textContent.includes('.claude'))
              // 已注册技能预览(全部技能目录扫描结果,不截断)
              const regRows = skillsSection?.querySelectorAll('.island-skills-reg-row') ?? []
              out.skillsRegisteredCount = regRows.length
              out.skillsRegisteredShown = regRows.length >= 8
              out.skillsRegisteredSample = [...regRows].slice(0, 3).map((r) => r.textContent.trim().slice(0, 40))
              // 技能移除/恢复:点第一行的"移除" → 行消失 + 已排除区出现 → 恢复。
              // 注意:已排除区也复用 .island-skills-reg-row 类,限定直接子行
              const skillRows = () => [
                ...(skillsSection?.querySelectorAll('.island-skills-registered > .island-skills-reg-row') ?? []),
              ]
              const firstRm = skillRows()[0]?.querySelector('.island-skills-reg-rm')
              const firstSlug = skillRows()[0]?.querySelector('.island-skills-reg-name')?.textContent
              await scrollInto(firstRm)
              firstRm?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.skillRemoved = skillRows().length === regRows.length - 1
              out.excludedSectionShown = !!skillsSection?.querySelector('.island-skills-excluded')
              out.excludedSlug = skillsSection?.querySelector('.island-skills-excluded .island-skills-reg-name')?.textContent
              // 分区断言:扫描到的区(用户无自建技能时"自己创建"区不存在)
              const regCounts = [...(skillsSection?.querySelectorAll('.island-skills-reg-count') ?? [])].map(
                (c) => c.textContent,
              )
              out.skillPartition = regCounts
              out.scannedPartitionShown = regCounts.some((c) => c.includes('扫描到的'))
              out.ownPartitionShown = regCounts.some((c) => c.includes('自己创建'))
              // 恢复(已排除区第一行的"恢复")
              const restoreBtn = skillsSection?.querySelector('.island-skills-excluded .island-agent-scale-btn')
              await scrollInto(restoreBtn)
              restoreBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.skillRestored = skillRows().length === regRows.length
              out.skillRestoredSlug = firstSlug ?? ''

              // ---- 记忆管理器(添加按钮按文本匹配——记忆条目的"改/删"
              // 按钮也在区里,querySelector 第一个会选错) ----
              const memSection = [...view.querySelectorAll('.island-agent-section')].find((s) => s.textContent.includes('长期记忆'))
              const memDraftInput = memSection?.querySelector('input[placeholder*="我喜欢"]')
              const memAddBtn = [...(memSection?.querySelectorAll('.island-agent-scale-btn') ?? [])].find((b) => b.textContent === '添加')
              out.memAddBtnText = memAddBtn?.textContent ?? '(无)'
              out.memBtnAll = [...(memSection?.querySelectorAll('.island-agent-scale-btn') ?? [])].map((b) => b.textContent)
              await scrollInto(memDraftInput)
              const memInputSet = setInput(memDraftInput, 'UI 测试记忆条目')
              out.memInputFound = memInputSet
              await sleep(250) // 等 React 提交输入(立即点击会读到旧 state 空内容)
              memAddBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.memErrorText = memSection?.querySelector('.island-mcp-test-result.fail')?.textContent ?? '(无错误)'
              const memRows = memSection?.querySelectorAll('.island-memory-row') ?? []
              out.memoryAdded = [...memRows].some((r) => r.textContent.includes('UI 测试记忆条目'))
              out.memoryCount = memRows.length
              // 删除刚添加的条目
              const addedRow = [...memRows].find((r) => r.textContent.includes('UI 测试记忆条目'))
              const delBtn = addedRow?.querySelector('.island-mcp-remove')
              await scrollInto(delBtn)
              delBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              const memRows2 = memSection?.querySelectorAll('.island-memory-row') ?? []
              out.memoryRemoved = ![...memRows2].some((r) => r.textContent.includes('UI 测试记忆条目'))

              // ---- 记忆类型按钮滚轮切换(本体直接滚动,逐格循环;保留下拉) ----
              // 合成 WheelEvent(deltaY 与 DOM 一致:正向 = 下一项)即可驱动
              // React onWheel,无需 sendInputEvent;步间冷却 100ms < 等待 250ms。
              // 按钮 key={tick} 每格重挂载——每次操作后**重新查询 DOM**
              // (旧引用指向已卸载节点,派发/读取都失效,实测)
              const queryTypeBtn = () => document.querySelector('.island-memory-type-btn')
              // 读 .island-wheel-swap-in 层的徽标(交换动画的旧层仍在 DOM)
              const typeLabel = (btn) =>
                btn?.querySelector('.island-wheel-swap-in .island-memory-type')?.textContent?.trim() ??
                '(无)'
              let typeBtn = queryTypeBtn()
              await scrollInto(typeBtn)
              out.typeBtnShown = !!typeBtn
              out.typeDefault = typeLabel(typeBtn)
              if (typeBtn) {
                // 正向一格(草稿初始 type=fact → 工作流)
                typeBtn.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 120 }))
                await sleep(250)
                typeBtn = queryTypeBtn()
                out.typeFwd = typeLabel(typeBtn)
                out.typeFwdOk = typeLabel(typeBtn) === '工作流'
                out.typeTickClass = typeBtn?.classList.contains('tick') ?? false
                // 反向一格(工作流 → 事实)
                typeBtn?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -120 }))
                await sleep(250)
                typeBtn = queryTypeBtn()
                out.typeBwd = typeLabel(typeBtn)
                out.typeBwdOk = typeLabel(typeBtn) === '事实'
                // 下拉菜单保留:点击展开 → 4 个选项 → 点外关闭
                typeBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                await sleep(300)
                out.typePopShown = !!document.querySelector('.island-memory-type-pop')
                out.typeOptCount = document.querySelectorAll('.island-memory-type-opt').length
                document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
                await sleep(400)
                out.typePopClosed = !document.querySelector('.island-memory-type-pop')
              }

              // ---- 自我进化区(按标题元素匹配——记忆区提示文本也含"自我进化") ----
              const evoSection = [...view.querySelectorAll('.island-agent-section')].find(
                (s) => s.querySelector('.island-agent-section-title')?.textContent.includes('自我进化'),
              )
              out.evoSectionShown = !!evoSection
              out.evoSectionText = evoSection?.textContent?.slice(0, 60) ?? '(无)'
              out.evoBtns = [...(evoSection?.querySelectorAll('button') ?? [])].map((b) => b.textContent)
              const evolveBtn = [...(evoSection?.querySelectorAll('.island-agent-scale-btn') ?? [])].find((b) => b.textContent.includes('运行记忆进化'))
              out.evolveBtnShown = !!evolveBtn
              // 新功能:导入技能按钮 + 清除所有版本按钮 + 空态初始化提示
              out.importBtnShown = [...view.querySelectorAll('button')].some((b) => b.textContent.includes('导入技能'))
              out.resetBtnShown = [...(evoSection?.querySelectorAll('button') ?? [])].some((b) => b.textContent.includes('清除所有版本'))
              out.initialStateShown = (evoSection?.textContent ?? '').includes('暂无进化记录')
              const rollbackBtn = [...(evoSection?.querySelectorAll('.island-agent-scale-btn') ?? [])].find((b) => b.textContent.includes('回滚'))
              out.rollbackBtnShown = !!rollbackBtn
              // 触发进化(无 API Key → 后台失败通知,按钮变"进化中…"后恢复)
              await scrollInto(evolveBtn)
              evolveBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(300)
              out.evolveClicked = (evolveBtn?.textContent ?? '').includes('进化中') || (evoSection?.querySelector('.island-mcp-test-result')?.textContent ?? '').includes('已开始')

              // ---- 保存 ----
              const saveBtn = btnByText('保存配置')
              await scrollInto(saveBtn)
              saveBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.saved = (view.querySelector('.island-agent-saved')?.textContent ?? '').includes('已保存')

              // ---- 返回 → 设置 → 收起 ----
              const backBtn = view.querySelector('.island-bg-back')
              backBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.backToSettings = !!document.querySelector('.island-settings-items')
              document.querySelector('.island-panel-list:has(.island-settings-items) .island-bg-back')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(900)
              out.collapsed = !document.querySelector('.island-demo').classList.contains('expanded')
              return JSON.stringify(out)
            })()`)
            console.log('[widget] agent-interact:', interactResult)
            // 段 2.5:技能同步与三区——模拟 LLM 创建(无标记 → 灵动岛创建区)
            // 与手动导入(带 .island-imported 标记 → 手动导入区),重进设置立即可见
            const syncSkillDir = path.join(app.getPath('userData'), 'skills', 'ui-sync-test')
            const impSkillDir = path.join(app.getPath('userData'), 'skills', 'ui-import-test')
            try {
              fs.mkdirSync(syncSkillDir, { recursive: true })
              fs.writeFileSync(
                path.join(syncSkillDir, 'SKILL.md'),
                '---\nname: ui-sync-test\ndescription: UI 同步验证技能\n---\n\n# Sync Test\n\n步骤 1\n',
                'utf8',
              )
              fs.mkdirSync(impSkillDir, { recursive: true })
              fs.writeFileSync(
                path.join(impSkillDir, 'SKILL.md'),
                '---\nname: ui-import-test\ndescription: UI 导入验证技能\n---\n\n# Import Test\n\n步骤 1\n',
                'utf8',
              )
              fs.writeFileSync(path.join(impSkillDir, '.island-imported'), 'imported by user\n')
            } catch (err) {
              console.error('[widget] sync skill write failed:', err)
            }
            // 收起 → 重新打开设置 → Agent 设置
            win.webContents.send('widget:open-settings')
            await new Promise((r) => setTimeout(r, 800))
            const syncResult = await win.webContents.executeJavaScript(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const settingsItem = (text) =>
                [...document.querySelectorAll('.island-settings-item')].find((s) => s.textContent.includes(text))
              settingsItem('Agent 设置')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(600)
              const rows = [...document.querySelectorAll('.island-skills-registered > .island-skills-reg-row')]
              const out = { skillRows: rows.length }
              out.syncSkillShown = rows.some((r) => r.textContent.includes('ui-sync-test'))
              // 分区:自己创建的技能进入"自己创建"区(不在"扫描到的"区)
              const regCounts = [...document.querySelectorAll('.island-skills-reg-count')].map((c) => c.textContent)
              out.createdCount = regCounts.find((c) => c.includes('灵动岛创建')) ?? '(无创建区)'
              out.importedCount = regCounts.find((c) => c.includes('手动导入')) ?? '(无导入区)'
              out.scannedCount = regCounts.find((c) => c.includes('扫描到的')) ?? '(无扫描区)'
              out.createdRowShown = !!document.querySelector('.island-skills-registered > .island-skills-reg-row')
                ?.textContent.includes('ui-sync-test')
              out.importedRowShown = [...document.querySelectorAll('.island-skills-registered > .island-skills-reg-row')]
                .some((r) => r.textContent.includes('ui-import-test'))
              // 收起:当前在 agent-settings 视图(设置类,屏蔽长按)→
              // 先返回设置视图,再返回收起(否则段 3 长按被屏蔽,输入框找不到)
              document
                .querySelector('.island-agent-settings .island-bg-back')
                ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              document
                .querySelector('.island-panel-list:has(.island-settings-items) .island-bg-back')
                ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(900)
              return JSON.stringify(out)
            })()`)
            console.log('[widget] agent-skill-sync:', syncResult)
            // 删除测试技能文件(用户数据零残留)
            try {
              fs.rmSync(path.join(app.getPath('userData'), 'skills', 'ui-sync-test'), { recursive: true, force: true })
              fs.rmSync(path.join(app.getPath('userData'), 'skills', 'ui-import-test'), { recursive: true, force: true })
            } catch {
              // 忽略
            }
            // 段 3:聊天输入框的 / 与 @ 候选列表(切 Agent 模式 → 长按展开
            // → 输入前缀 → 断言技能/MCP 候选、过滤、Enter 选中、Esc 关闭)
            win.webContents.send('widget:set-mode', { mode: 'agent', source: 'user' })
            await new Promise((r) => setTimeout(r, 600))
            const suggestResult = await win.webContents.executeJavaScript(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const out = {}
              const island = document.querySelector('.island-demo')
              // 长按展开(Agent 模式紧凑态长按展开)
              const r = island.getBoundingClientRect()
              const x = r.left + r.width / 2
              const y = r.top + r.height / 2
              island.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 }))
              setTimeout(() => island.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 })), 600)
              await sleep(1100)
              out.expanded = island.classList.contains('expanded')
              const ta = document.querySelector('.island-agent-input textarea')
              out.inputShown = !!ta
              // 调试:展开后面板实际视图
              out.settingsShown = !!document.querySelector('.island-settings-items')
              out.agentViewShown = !!document.querySelector('.island-agent-view')
              out.panelHtml = document.querySelector('.island-panel')?.className ?? '(无面板)'
              out.panelContent = (document.querySelector('.island-panel')?.innerHTML ?? '').replace(/<[^>]+>/g, ' ').trim().slice(0, 120)
              if (!ta) return JSON.stringify(out)
              const setVal = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
              const type = async (v) => {
                setVal.call(ta, v)
                ta.dispatchEvent(new Event('input', { bubbles: true }))
                await sleep(250)
              }
              // 输入 '/':候选列表应列出**全部**技能(不截断;用户技能
              // 远多于 6 个,超高滚动)
              await type('/')
              const items = () => [...document.querySelectorAll('.island-agent-suggest-item')]
              const suggestBox = () => document.querySelector('.island-agent-suggest')
              out.suggestSlashCount = items().length
              out.suggestSlashTexts = items().map((i) => i.querySelector('.island-agent-suggest-cmd')?.textContent).slice(0, 4)
              out.skillListed = items().some((i) => i.textContent.includes('skill_'))
              out.skillsAllListed = items().length >= 8
              // 候选列表高度跟随岛体:200px 岛体时列表可视高应远小于
              // 全展开(~192px),且超高可滚动
              if (suggestBox()) {
                out.suggestBoxH = suggestBox().clientHeight
                out.suggestScrollable = suggestBox().scrollHeight > suggestBox().clientHeight + 2
              }
              // 输入 '/darwin':过滤出 darwin 技能
              await type('/darwin')
              const filtered = items()
              out.suggestFiltered = filtered.length
              out.filterMatches = filtered.length > 0 && filtered.every((i) => i.textContent.includes('darwin'))
              // 输入 '@':MCP 候选(siyuan 服务若连接成功;内置 mcp_config 应排除)
              await type('@')
              const atItems = items()
              out.suggestAtCount = atItems.length
              out.atTexts = atItems.map((i) => i.querySelector('.island-agent-suggest-cmd')?.textContent).slice(0, 4)
              out.mcpConfigExcluded = !atItems.some((i) => i.textContent.includes('@mcp_config'))
              // Enter 选中第一个候选(不发送)
              const firstCmd = atItems[0]?.querySelector('.island-agent-suggest-cmd')?.textContent ?? ''
              ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
              await sleep(250)
              out.afterEnter = ta.value.slice(0, 50)
              out.enterApplied = ta.value === firstCmd
              // Esc 关闭候选(收起动画:160 + 卡片数×30ms 后卸载,等足)
              await type('/darwin')
              ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
              await sleep(200)
              out.escClosing = document.querySelector('.island-agent-suggest.closing') !== null
              await sleep(700)
              out.escClosed = items().length === 0
              return JSON.stringify(out)
            })()`)
            console.log('[widget] agent-suggest:', suggestResult)
            // 段 4:工具列表预览框(岛体高度由聊天驱动,列表滚动)
            const toolsResult = await win.webContents.executeJavaScript(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const out = {}
              const island = document.querySelector('.island-demo')
              const panel = document.querySelector('.island-agent-view')
              out.islandHBefore = island?.offsetHeight ?? 0
              // 清空输入框(候选测试残留),打开 ⋯ 菜单 → 工具列表
              const ta = document.querySelector('.island-agent-input textarea')
              if (ta) {
                const setVal = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
                setVal.call(ta, '')
                ta.dispatchEvent(new Event('input', { bubbles: true }))
              }
              await sleep(200)
              const menuBtn = document.querySelector('.island-agent-menu .island-agent-ctl')
              menuBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(250)
              const toolsItem = [...document.querySelectorAll('.island-agent-menu-item')].find((b) => b.textContent.includes('工具列表'))
              toolsItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(500)
              const list = document.querySelector('.island-agent-history-list')
              out.toolsListShown = !!list
              out.islandHAfter = island?.offsetHeight ?? 0
              // 高度未撑大:进入 tools 前后岛体高度基本一致(聊天高度驱动)
              out.heightStable = Math.abs((island?.offsetHeight ?? 0) - out.islandHBefore) < 40
              if (list) {
                out.listScrollable = list.scrollHeight > list.clientHeight + 4
                out.listClientH = list.clientHeight
                out.listScrollH = list.scrollHeight
                // 滚动生效:滚到底再回顶
                list.scrollTop = list.scrollHeight
                await sleep(150)
                out.scrolledDown = list.scrollTop > 0
                list.scrollTop = 0
              }
              // 返回对话(切回 chat 应重测高度)
              document.querySelector('.island-agent-history-back')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(500)
              out.backToChat = !!document.querySelector('.island-agent-input textarea')
              // 对话历史视图:与工具列表相同设计(岛体高度保持,列表滚动)
              const hBefore = island?.offsetHeight ?? 0
              const menuBtn2 = document.querySelector('.island-agent-menu .island-agent-ctl')
              menuBtn2?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(250)
              const histItem = [...document.querySelectorAll('.island-agent-menu-item')].find((b) => b.textContent.includes('对话历史'))
              histItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(500)
              const hList = document.querySelector('.island-agent-history-list')
              out.historyListShown = !!hList
              out.historyHeightStable = Math.abs((island?.offsetHeight ?? 0) - hBefore) < 40
              out.historyScrollable = hList ? hList.scrollHeight > hList.clientHeight + 4 : false
              return JSON.stringify(out)
            })()`)
            console.log('[widget] agent-tools-preview:', toolsResult)
            // 段 4.5:快捷切换按钮(悬浮 ⋯ 时左侧浮现,默认"收起面板";
            // 滚轮逐格切换;单击跳转;横移过间隙不消失)。
            // 合成 MouseEvent 不触发 CSS :hover,须 sendInputEvent 注入
            // 真实鼠标事件(悬停/滚轮/点击)驱动
            {
              // 段 4 末停在对话历史视图:先返回聊天视图(快捷按钮与后续
              // 段 5 的自动回复都需聊天视图;历史视图无 ⋯ 菜单)
              await win.webContents.executeJavaScript(`(() => {
                document.querySelector('.island-agent-history-back')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              })()`)
              await new Promise((r) => setTimeout(r, 500))
              const qe = (sel) =>
                win.webContents.executeJavaScript(`(() => {
                  const el = document.querySelector(${JSON.stringify(sel)})
                  if (!el) return null
                  const r = el.getBoundingClientRect()
                  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
                })()`)
              const quickProbe = () =>
                win.webContents.executeJavaScript(`(() => {
                  const zone = document.querySelector('.island-agent-quick')
                  const btn = zone?.querySelector('.island-agent-quick-btn')
                  const br = btn?.getBoundingClientRect()
                  // 读 .island-wheel-swap-in 层:交换动画的旧内容层(透明度
                  // 0)仍在 DOM,btn.textContent 会拼出两个标签
                  const label =
                    btn?.querySelector('.island-wheel-swap-in')?.textContent?.trim() ??
                    btn?.textContent ??
                    '(无)'
                  return {
                    zoneVisible: zone ? getComputedStyle(zone).opacity !== '0' : false,
                    label,
                    pos: br ? { x: Math.round(br.left + br.width / 2), y: Math.round(br.top + br.height / 2) } : null,
                  }
                })()`)
              const q0 = await quickProbe()
              console.log('[widget] agent-quick-init:', JSON.stringify(q0))
              const dotPos = await qe('.island-agent-menu .island-agent-ctl')
              if (dotPos) {
                // 悬浮 ⋯:快捷按钮浮现,默认显示"收起面板"
                win.webContents.sendInputEvent({ type: 'mouseMove', x: dotPos.x, y: dotPos.y })
                await new Promise((r) => setTimeout(r, 450))
                const q1 = await quickProbe()
                console.log('[widget] agent-quick-hover:', JSON.stringify(q1))
                // 截图:悬浮态(快捷按钮 + ⋯ 并存)
                const quickImg = await win.webContents.capturePage()
                fs.writeFileSync(process.env.WIDGET_SCREENSHOT + '.agent-quick.png', quickImg.toPNG())
                console.log('[widget] screenshot(agent-quick hover) saved')
                if (q1?.pos) {
                  // 横移到快捷按钮(途经间隙中点):按钮必须保持可见
                  win.webContents.sendInputEvent({
                    type: 'mouseMove',
                    x: Math.round((dotPos.x + q1.pos.x) / 2),
                    y: dotPos.y,
                  })
                  await new Promise((r) => setTimeout(r, 300))
                  const q2 = await quickProbe()
                  console.log('[widget] agent-quick-midgap:', JSON.stringify(q2))
                  // 移到快捷按钮上,滚轮切换。先从 DOM 推断当前菜单项构成
                  // (与引擎 busy/messages 一致),据此计算期望步进序列:
                  // 默认"收起面板"(末项),正向滚轮 = 下一项,反向 = 上一项。
                  // 注意:sendInputEvent 的 deltaY 符号与 DOM wheel 事件相反
                  // (实测 +120 → 反向一步),故"正向"注入 -120、"反向"注入
                  // +120;一次注入 = 一步(引擎步间冷却 100ms < 注入间隔 250ms)
                  win.webContents.sendInputEvent({ type: 'mouseMove', x: q1.pos.x, y: q1.pos.y })
                  await new Promise((r) => setTimeout(r, 250))
                  const listState = await win.webContents.executeJavaScript(`(() => ({
                    userMsgs: document.querySelectorAll('.island-agent-msg-user').length,
                    busy: !!document.querySelector('.island-agent-stop') || !!document.querySelector('.island-agent-dot.thinking'),
                  }))()`)
                  const items = []
                  if (listState.busy) items.push('停止生成')
                  if (listState.userMsgs > 0) items.push('新对话')
                  items.push('对话历史', '工具列表', '设置', '收起面板')
                  const nItems = items.length
                  const defIdx = nItems - 1
                  const fwdStep = (defIdx + 1) % nItems
                  const toHistory = (items.indexOf('对话历史') - defIdx + nItems) % nItems
                  console.log(
                    '[widget] agent-quick-expect:',
                    JSON.stringify({ items, fwd: items[fwdStep], toHistory }),
                  )
                  const sendWheel = async (deltaY) => {
                    win.webContents.sendInputEvent({
                      type: 'mouseWheel',
                      x: q1.pos.x,
                      y: q1.pos.y,
                      deltaX: 0,
                      deltaY,
                    })
                    await new Promise((r) => setTimeout(r, 250))
                    return quickProbe()
                  }
                  // 正向一步:收起面板 → 下一项
                  const s1 = await sendWheel(-120)
                  console.log(
                    '[widget] agent-quick-fwd:',
                    JSON.stringify({ ...s1, expect: items[fwdStep], ok: s1?.label === items[fwdStep] }),
                  )
                  // 反向一步:回到收起面板
                  const s2 = await sendWheel(120)
                  console.log(
                    '[widget] agent-quick-bwd:',
                    JSON.stringify({ ...s2, expect: items[defIdx], ok: s2?.label === items[defIdx] }),
                  )
                  // 正向 toHistory 步:收起面板 → 对话历史
                  let s3 = s2
                  for (let i = 0; i < toHistory; i++) s3 = await sendWheel(-120)
                  console.log(
                    '[widget] agent-quick-to-history:',
                    JSON.stringify({ ...s3, expect: '对话历史', ok: s3?.label === '对话历史' }),
                  )
                  // 单击 → 跳转(选中"对话历史"应进入历史视图;若步进未按
                  // 预期则跳过点击,不误触其他项)
                  if (s3?.label === '对话历史') {
                    win.webContents.sendInputEvent({
                      type: 'mouseDown',
                      x: q1.pos.x,
                      y: q1.pos.y,
                      button: 'left',
                      clickCount: 1,
                    })
                    win.webContents.sendInputEvent({
                      type: 'mouseUp',
                      x: q1.pos.x,
                      y: q1.pos.y,
                      button: 'left',
                      clickCount: 1,
                    })
                    await new Promise((r) => setTimeout(r, 700))
                    const q5 = await win.webContents.executeJavaScript(`(() => ({
                      historyShown: !!document.querySelector('.island-agent-history-list'),
                      backBtn: !!document.querySelector('.island-agent-history-back'),
                      chatGone: !document.querySelector('.island-agent-input textarea'),
                    }))()`)
                    console.log('[widget] agent-quick-click:', JSON.stringify(q5))
                  } else {
                    console.log('[widget] agent-quick-click: skipped(滚轮步进未达预期)')
                  }
                  // 返回对话(后续段 5 需要聊天视图)
                  await win.webContents.executeJavaScript(`(() => {
                    document.querySelector('.island-agent-history-back')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                  })()`)
                  await new Promise((r) => setTimeout(r, 500))
                }
              }
            }
            // 段 4.6:工具列表视图(搜索 / 禁用 / 禁用区 / 恢复,动画)。
            // 从聊天视图 ⋯ 菜单进工具列表,合成事件驱动(React 受控输入
            // 用原生 value setter;禁用/恢复先播离场动画再提交,等足 300ms)
            {
              const toolsResult = await win.webContents.executeJavaScript(`(async () => {
                const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
                const out = {}
                const menuBtn = document.querySelector('.island-agent-menu .island-agent-ctl')
                menuBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                await sleep(250)
                const toolsItem = [...document.querySelectorAll('.island-agent-menu-item')].find((b) => b.textContent.includes('工具列表'))
                toolsItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                await sleep(500)
                const list = document.querySelector('.island-agent-history-list')
                out.toolsShown = !!list
                // 搜索框:输入过滤(受控输入原生 setter + input 事件)
                const search = document.querySelector('.island-tools-search input')
                out.searchShown = !!search
                const rows = () => [...(list?.querySelectorAll('.island-agent-tools-item') ?? [])]
                out.rowsBefore = rows().length
                if (search) {
                  const setVal = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
                  const target = rows()[0]?.querySelector('.island-agent-tools-name')?.textContent ?? ''
                  setVal.call(search, target.slice(0, Math.max(1, Math.floor(target.length / 2))))
                  search.dispatchEvent(new Event('input', { bubbles: true }))
                  await sleep(300)
                  out.rowsAfterFilter = rows().length
                  out.filterWorked = rows().length > 0 && rows().length <= out.rowsBefore
                  setVal.call(search, '')
                  search.dispatchEvent(new Event('input', { bubbles: true }))
                  await sleep(200)
                }
                // 禁用第一个工具:离场动画(0.24s)+ 移入禁用区(入场动画)
                const first = rows()[0]
                const firstName = first?.querySelector('.island-agent-tools-name')?.textContent ?? ''
                const disableBtn = first?.querySelector('.island-tools-disable')
                await sleep(200)
                disableBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
                await sleep(120)
                out.disableLeaving = !!first?.classList.contains('island-ui-leave')
                await sleep(400)
                const excludedRows = () => [...(list?.querySelectorAll('.island-tools-excluded-row') ?? [])]
                const excludedNames = excludedRows().map((r) => r.querySelector('.island-tools-excluded-name')?.textContent)
                out.excludedSection = !!list?.querySelector('.island-tools-excluded')
                out.disabledName = excludedNames[0] ?? '(无)'
                out.disableMoved = excludedNames.includes(firstName)
                out.enteringInExcluded = excludedRows()[0]?.classList.contains('island-ui-enter') ?? false
                // 恢复:同样先离场再回到可用区
                const restoreBtn = excludedRows()[0]?.querySelector('.island-tools-restore')
                await sleep(200)
                restoreBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
                await sleep(400)
                out.restoreBack = rows().some((r) => r.querySelector('.island-agent-tools-name')?.textContent === firstName)
                out.excludedEmpty = excludedRows().length === 0
                return JSON.stringify(out)
              })()`)
              console.log('[widget] agent-tools-actions:', toolsResult)
              // 返回对话(后续段 5 需要聊天视图)
              await win.webContents.executeJavaScript(`(() => {
                document.querySelector('.island-agent-history-back')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              })()`)
              await new Promise((r) => setTimeout(r, 500))
            }
            // 段 4.7:灵动岛设置工具端到端(设置桥 → 存储 → 事件 → UI 即时生效)。
            // 直接调主进程 runIslandSettings(与引擎设置工具同一条链路,绕开
            // LLM 调度保证确定性):主题色 / 缩放 / 背景导入+改名 / 字体导入
            // +改名,断言 UI 即时生效(--state-color / 岛宽比例 / 库条目)。
            // 前后状态备份,结束后恢复(不残留用户数据);IndexedDB 背景槽位
            // 用原生事务读写(桥未暴露槽位读取)
            {
              const js = (code) => win.webContents.executeJavaScript(code)
              const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
              const out = {}
              // IndexedDB 背景库槽位读写('island-background' v2,store 'bg';
              // put null = 清空槽位,加载器按 typeof string 判定)
              const bgSlotJs = (slot, op, value) => `(async () => {
                const db = await new Promise((res, rej) => {
                  const r = indexedDB.open('island-background', 2)
                  r.onsuccess = () => res(r.result)
                  r.onerror = () => rej(r.error)
                })
                return await new Promise((res) => {
                  const tx = db.transaction('bg', '${op === 'get' ? 'readonly' : 'readwrite'}')
                  const req = ${op === 'get'
                    ? `tx.objectStore('bg').get(${JSON.stringify(slot)})`
                    : `tx.objectStore('bg').put(${JSON.stringify(value)}, ${JSON.stringify(slot)})`}
                  req.onsuccess = () => res(typeof req.result === 'string' ? req.result : null)
                  req.onerror = () => res(null)
                })
              })()`
              // 备份:localStorage 设置项 + 背景双槽位图片(恢复时写回)
              const backup = {
                theme: await js(`localStorage.getItem('widget-theme-color')`),
                scale: await js(`localStorage.getItem('widget-agent-scale')`),
                bgParams: await js(`localStorage.getItem('widget-background')`),
                fontSettings: await js(`localStorage.getItem('widget-font')`),
                bgExpanded: await js(bgSlotJs('expanded', 'get')),
                bgCompact: await js(bgSlotJs('compact', 'get')),
              }
              const TEST_PNG =
                'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
              try {
                // 1. 主题色:写存储 → 事件 → --state-color 即时生效
                await runIslandSettings('setThemeColor', ['#f87171'])
                await sleep(500)
                out.themeApplied = await js(
                  `document.querySelector('.island-demo').style.getPropertyValue('--state-color') === '#f87171'`,
                )
                // 2. 缩放:岛宽按比例即时变化(当前缩放 A → 150)
                const scaleBefore = Number((await js(`localStorage.getItem('widget-agent-scale')`)) ?? '200') || 200
                const widthBefore = await js(`document.querySelector('.island-demo').offsetWidth`)
                await runIslandSettings('setAgentScale', [150])
                await sleep(500)
                const scaleAfter = await js(`localStorage.getItem('widget-agent-scale')`)
                const widthAfter = await js(`document.querySelector('.island-demo').offsetWidth`)
                out.scaleStored = scaleAfter
                out.scaleRatioOk =
                  Math.abs(widthAfter - Math.round((widthBefore * 150) / scaleBefore)) < 10
                out.scaleDebug = JSON.stringify({ scaleBefore, widthBefore, widthAfter })
                // 3. 背景导入 + 改名:导入(双槽位应用 + 入库)→ 改名 → 断言
                const imgRes = await runIslandSettings('importBackground', [TEST_PNG, '巡检测试背景'])
                await sleep(500)
                // --bg-img-e 设置在 .island-bg-image 子元素上(背景层),
                // 不在 .island-demo 主元素(实测断言选择器踩坑)
                const bgVar = await js(
                  `document.querySelector('.island-bg-image')?.style.getPropertyValue('--bg-img-e') ?? '(无背景层)'`,
                )
                out.bgApplied = typeof bgVar === 'string' && bgVar.startsWith('url("data:image/png')
                const imgs = (await runIslandSettings('listLibraryImages', [])) ?? []
                out.bgInLibrary = imgs.some((i) => i.id === imgRes.id && i.name === '巡检测试背景')
                await runIslandSettings('renameLibraryImage', [imgRes.id, '巡检测试背景-改名'])
                await sleep(300)
                const imgs2 = (await runIslandSettings('listLibraryImages', [])) ?? []
                out.bgRenamed = imgs2.some((i) => i.id === imgRes.id && i.name === '巡检测试背景-改名')
                // 4. 字体导入 + 改名:入库并应用为当前字体
                const fontRes = await runIslandSettings('importFont', [
                  'data:font/ttf;base64,QUFBQUFBQUE=',
                  '巡检测试字体',
                ])
                await sleep(400)
                const fontSettings = await js(`localStorage.getItem('widget-font')`)
                out.fontApplied = typeof fontSettings === 'string' && fontSettings.includes(fontRes.id)
                const fonts = (await runIslandSettings('listFonts', [])) ?? []
                out.fontInLibrary = fonts.some((f) => f.id === fontRes.id)
                await runIslandSettings('renameFont', [fontRes.id, '巡检测试字体-改名'])
                await sleep(300)
                const fonts2 = (await runIslandSettings('listFonts', [])) ?? []
                out.fontRenamed = fonts2.some((f) => f.id === fontRes.id && f.name === '巡检测试字体-改名')
                // 5. 非法操作拒绝:不存在的图片 id 改名应报错
                let renamedError = ''
                try {
                  await runIslandSettings('renameLibraryImage', ['i-not-exist', 'x'])
                } catch (err) {
                  renamedError = (err && err.message) || String(err)
                }
                out.renameInvalidRejected = renamedError.includes('图片不存在')
              } catch (err) {
                out.error = String((err && err.stack) || err)
                console.error('[widget] agent-settings-tools failed:', err)
              } finally {
                // 恢复用户数据:localStorage 设置项(缺失的 removeItem)
                const setOrRemove = (key, value) =>
                  value === null
                    ? js(`localStorage.removeItem(${JSON.stringify(key)})`)
                    : js(`localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`)
                await setOrRemove('widget-theme-color', backup.theme)
                await setOrRemove('widget-agent-scale', backup.scale)
                await setOrRemove('widget-background', backup.bgParams)
                await setOrRemove('widget-font', backup.fontSettings)
                // 背景槽位恢复原图(原无则清空)
                await js(bgSlotJs('expanded', 'put', backup.bgExpanded))
                await js(bgSlotJs('compact', 'put', backup.bgCompact))
                // 删除测试入库条目(图片/字体;按「巡检测试」名前缀定位)
                const imgs3 = (await runIslandSettings('listLibraryImages', []).catch(() => [])) ?? []
                for (const img of imgs3) {
                  if (String(img.name).startsWith('巡检测试')) {
                    await runIslandSettings('deleteLibraryImage', [img.id]).catch(() => {})
                  }
                }
                const fonts3 = (await runIslandSettings('listFonts', []).catch(() => [])) ?? []
                for (const f of fonts3) {
                  if (String(f.name).startsWith('巡检测试')) {
                    await runIslandSettings('deleteFontItem', [f.id]).catch(() => {})
                  }
                }
                // 恢复后的存储重读(恢复走原生 js 写,未触发桥事件;手动补发)
                await js(
                  `window.dispatchEvent(new CustomEvent('island-settings-changed', { detail: { scopes: ['theme','scale','font','background','imageLibrary'] } }))`,
                )
                await sleep(400)
              }
              console.log('[widget] agent-settings-tools:', JSON.stringify(out))
            }
            // 渲染端自动 send → LLM 主动回复,真实 API)
            await win.webContents.executeJavaScript(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const before = document.querySelectorAll('.island-agent-msg-assistant').length
              return JSON.stringify({ before })
            })()`)
            win.webContents.send('agent:event', {
              type: 'background-done',
              title: 'B站下载完成',
              message: '视频《测试视频》已完成,输出目录 C:/test/downloads',
            })
            await new Promise((r) => setTimeout(r, 4000))
            const eventDebug = await win.webContents.executeJavaScript(`(() => {
              return JSON.stringify({
                userCount: document.querySelectorAll('.island-agent-msg-user').length,
                errorText: document.querySelector('.island-agent-error')?.textContent ?? '(无错误)',
                statusText: document.querySelector('.island-agent-head')?.textContent?.slice(0, 40) ?? '(无头部)',
              })
            })()`)
            console.log('[widget] agent-auto-reply-debug:', eventDebug)
            // 轮询:LLM 应自动回复(存在文本非空的助手消息;刚初始化可能
            // 只有 1 条回复,不能按"数量增长"判断——debug 已确认回复
            // 数秒内完成,此时轮询才启动,startCount 早已是 1)
            const autoReply = await win.webContents.executeJavaScript(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const deadline = Date.now() + 60000
              while (Date.now() < deadline) {
                const msgs = document.querySelectorAll('.island-agent-msg-assistant')
                const last = msgs[msgs.length - 1]
                const text = last?.textContent ?? ''
                if (text.length > 10 && !text.includes('正在思考') && !text.includes('【系统通知】')) {
                  return JSON.stringify({ replied: true, count: msgs.length, text: text.slice(0, 120) })
                }
                await sleep(2000)
              }
              return JSON.stringify({ replied: false, count: document.querySelectorAll('.island-agent-msg-assistant').length })
            })()`)
            console.log('[widget] agent-auto-reply:', autoReply)
            // 恢复用户配置(巡检的"保存配置"把表单状态写回了 settings.json;
            // 测试服务(ui-mock 等)不残留,用户原配置原样恢复)
            if (settingsBackup !== null) {
              try {
                fs.writeFileSync(settingsFile, settingsBackup, 'utf8')
                console.log('[widget] settings restored')
              } catch (err) {
                console.error('[widget] settings restore failed:', err)
              }
            }
          }
          const image = await win.webContents.capturePage()
          fs.writeFileSync(process.env.WIDGET_SCREENSHOT, image.toPNG())
          console.log('[widget] screenshot saved')
          // WIDGET_SCREENSHOT_QUIT=1:截图/巡检完成后优雅退出(不走托盘
          // 常驻;避免测试命令强杀进程树导致 renderer gone: crashed 假象)
          if (process.env.WIDGET_SCREENSHOT_QUIT === '1') {
            quitting = true
            setTimeout(() => app.quit(), 300)
          }
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

// 消息气泡链接:系统浏览器打开(仅 http/https,防协议注入;
// 渲染端 Markdown 渲染器也只把 http(s) 渲染为可点击链接)
ipcMain.on('app:open-external', (_event, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) void shell.openExternal(url)
})

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

// 调整窗口尺寸(Agent 面板缩放:宽高按岛体视觉尺寸 + 余量;
// 其余视图由 set-height 保持 520 宽)。合理范围钳制,防脏数据
ipcMain.on('widget:set-size', (_event, width, height) => {
  if (!win) return
  const w = Number(width)
  const h = Number(height)
  if (!Number.isFinite(w) || !Number.isFinite(h)) return
  const cw = Math.max(400, Math.min(1600, Math.round(w)))
  const ch = Math.max(200, Math.min(2000, Math.round(h)))
  win.setSize(cw, ch)
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
// IPC:Agent 模式(渲染端 → 引擎)
// ---------------------------------------------------------------------------

// 发送一轮对话:引擎无状态,history 为渲染端回传的完整历史
ipcMain.on('agent:send', (_event, text, history) => {
  if (typeof text !== 'string') return
  getAgentEngine().send(text, Array.isArray(history) ? history : [])
})

ipcMain.on('agent:abort', () => {
  getAgentEngine().abort()
})

// 配置读取/写入(API Key / Base URL / 模型 / 系统提示词,存 settings.json)
ipcMain.handle('agent:config-get', () => ({
  ...AGENT_CONFIG_DEFAULTS,
  ...(loadSettings().agent ?? {}),
}))

ipcMain.handle('agent:config-set', (_event, patch) => applyAgentConfigPatch(patch))

// 记忆读写(设置界面记忆管理器;条目数组整体替换,主进程校验)
ipcMain.handle('agent:memory-get', async () => {
  try {
    return await getMemoryStore().list()
  } catch {
    return []
  }
})

// 导出记忆:保存对话框 → 写 memory.json 的完整内容(JSON 结构同
// memory.json,将来可再导入;取消/失败返回 {canceled: true})
ipcMain.handle('agent:memory-export', async () => {
  try {
    const memoryPath = path.join(app.getPath('userData'), 'memory.json')
    const raw = await fs.promises.readFile(memoryPath, 'utf8')
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: '导出长期记忆',
      defaultPath: path.join(app.getPath('documents'), `island-memory-${new Date().toISOString().slice(0, 10)}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (canceled || !filePath) return { canceled: true }
    await fs.promises.writeFile(filePath, raw, 'utf8')
    return { canceled: false, path: filePath, bytes: raw.length }
  } catch (err) {
    return { canceled: false, error: (err && err.message) || String(err) }
  }
})

// 导入记忆:打开对话框选导出的记忆文件(结构同 memory.json 的
// {entries:[...]},兼容纯数组)→ 规范化后合并进现有记忆
// (store.importEntries:按 id/内容去重、超 200 截断、新导入置顶)。
// 返回 {imported, skipped} 计数供 UI 展示
ipcMain.handle('agent:memory-import', async () => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: '导入长期记忆(选择导出的记忆文件)',
      properties: ['openFile'],
      filters: [{ name: '记忆文件', extensions: ['json'] }],
    })
    if (canceled || filePaths.length === 0) return { canceled: true }
    const raw = await fs.promises.readFile(filePaths[0], 'utf8')
    const data = JSON.parse(raw)
    const list = Array.isArray(data) ? data : data?.entries
    if (!Array.isArray(list)) {
      return { canceled: false, error: '文件格式不正确:缺少 entries 列表' }
    }
    // 规范化:id/类型/内容(截 500)/时间戳兜底;来源保留文件里的值
    // (updatedAt 由 store.importEntries 置为当前 → 列表置顶可见)
    const normalized = list
      .filter((e) => e && typeof e === 'object' && typeof e.content === 'string')
      .map((e, i) => ({
        id: typeof e.id === 'string' && e.id ? e.id : `imp-${Date.now()}-${i}`,
        type: ['preference', 'fact', 'workflow', 'lesson'].includes(e.type) ? e.type : 'fact',
        content: String(e.content).trim().slice(0, 500),
        source: e.source ?? 'manual',
        createdAt: typeof e.createdAt === 'number' ? e.createdAt : Date.now(),
        updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : Date.now(),
      }))
      .filter((e) => e.content)
    const result = await getMemoryStore().importEntries(normalized)
    return { canceled: false, imported: result.imported, skipped: result.skipped }
  } catch (err) {
    return { canceled: false, error: (err && err.message) || String(err) }
  }
})

ipcMain.handle('agent:memory-set', async (_event, patch) => {
  const store = getMemoryStore()
  try {
    // patch 支持:add {content,type} / remove {key} / update {id,content,type}
    // / replaceAll {entries};返回最新列表
    if (patch?.add) {
      const type = ['preference', 'fact', 'workflow', 'lesson'].includes(patch.add.type)
        ? patch.add.type
        : 'fact'
      await store.add({
        content: String(patch.add.content ?? ''),
        type,
        source: 'manual',
      })
    } else if (patch?.remove) {
      await store.remove(String(patch.remove ?? ''))
    } else if (patch?.update) {
      await store.update(String(patch.update.id ?? ''), {
        content: patch.update.content ? String(patch.update.content) : undefined,
        type: patch.update.type ?? undefined,
      })
    } else if (Array.isArray(patch?.replaceAll)) {
      await store.replaceAll(
        patch.replaceAll
          .filter((e) => e && typeof e === 'object' && typeof e.content === 'string')
          .map((e, i) => ({
            id: typeof e.id === 'string' && e.id ? e.id : `m-${Date.now()}-${i}`,
            type: ['preference', 'fact', 'workflow', 'lesson'].includes(e.type) ? e.type : 'fact',
            content: String(e.content).slice(0, 500),
            source: e.source ?? 'manual',
            createdAt: typeof e.createdAt === 'number' ? e.createdAt : Date.now(),
            updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : Date.now(),
          })),
      )
    }
    return await store.list()
  } catch (err) {
    return { error: err.message || String(err) }
  }
})

// 自我进化:触发(后台)/ 日志 / 回滚(设置界面)
ipcMain.handle('agent:evolve', (_event, focus) => getEvolution().requestEvolve(typeof focus === 'string' ? focus : undefined))
ipcMain.handle('agent:evolution-log', async () => {
  try {
    return getEvolution().getLog()
  } catch {
    return []
  }
})
ipcMain.handle('agent:evolution-rollback', async () => getEvolution().rollback())
ipcMain.handle('agent:evolution-reset', async () => getEvolution().resetAll())

/** 从 SKILL.md 文本提取 frontmatter 的 name(导入技能命名用) */
function skillNameFromMd(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) return ''
  for (const line of m[1].split('\n')) {
    if (line.trim().toLowerCase().startsWith('name:')) {
      return line.slice(line.indexOf(':') + 1).trim().replace(/^["']|["']$/g, '')
    }
  }
  return ''
}

// 导入技能:选择**技能包文件夹**(含 SKILL.md 与脚本等资源,整目录复制)
// 或**单个 .md 技能文件** → 复制到 userData/skills(默认扫描源)→ 重进设置可见
ipcMain.handle('agent:skill-import', async () => {
  const targetRoot = path.join(app.getPath('userData'), 'skills')
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: '导入技能(选择技能文件夹或 SKILL.md 文件)',
      properties: ['openDirectory', 'openFile'],
      filters: [{ name: '技能文件', extensions: ['md'] }],
    })
    if (canceled || filePaths.length === 0) return { canceled: true }
    const imported = []
    const skipped = []
    for (const src of filePaths) {
      try {
        const stat = fs.statSync(src)
        let name = ''
        if (stat.isDirectory()) {
          // 技能包:目录(内含 SKILL.md 与脚本等)→ 整目录复制
          const mdPath = path.join(src, 'SKILL.md')
          if (!fs.existsSync(mdPath)) {
            skipped.push(`${path.basename(src)}(目录内无 SKILL.md)`)
            continue
          }
          name = skillNameFromMd(fs.readFileSync(mdPath, 'utf8')) || path.basename(src)
        } else {
          name = skillNameFromMd(fs.readFileSync(src, 'utf8')) || path.basename(src, '.md')
        }
        const slug =
          name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'skill'
        const target = path.join(targetRoot, slug)
        if (fs.existsSync(path.join(target, 'SKILL.md'))) {
          skipped.push(`${slug}(已存在同名技能)`)
          continue
        }
        fs.mkdirSync(target, { recursive: true })
        if (stat.isDirectory()) {
          // 整包复制(脚本/资源/引用文件全带);排除版本控制目录
          fs.cpSync(src, target, { recursive: true, filter: (f) => !f.includes(`${path.sep}.git${path.sep}`) })
        } else {
          fs.copyFileSync(src, path.join(target, 'SKILL.md'))
        }
        // 导入标记:设置界面据此归入"手动导入区"(区分灵动岛创建)
        fs.writeFileSync(path.join(target, '.island-imported'), 'imported by user\n')
        imported.push(`${slug} → ${target}`)
      } catch (err) {
        skipped.push(`${path.basename(src)}(${err.message || String(err)})`)
      }
    }
    return { canceled: false, imported, skipped }
  } catch (err) {
    return { canceled: false, error: err.message || String(err) }
  }
})

// 渲染端启动时询问当前模式(与 tray 切换保持一致)
ipcMain.handle('widget:get-mode', () => currentMode())

// 渲染端请求切换模式(Agent 文字区滑动手势退出 → 音乐;复用托盘同款
// setWidgetMode:持久化 + 通知渲染端 + 重建托盘菜单)
ipcMain.on('widget:set-mode', (_event, mode) => {
  if (mode === 'agent' || mode === 'music') setWidgetMode(mode)
})

// Agent 工具清单(名称/描述/参数 schema,供 UI 工具列表视图展示)。
// 异步:内置工具 + MCP 服务工具(未连接的服务启动失败即跳过)+ 技能
ipcMain.handle('agent:tools', async () => getAgentEngine().listAllTools())

// 测试 MCP 服务连通性(独立连接 → 列工具 → 销毁;Agent 设置界面"测试"按钮)
ipcMain.handle('agent:mcp-test', async (_event, server) => {
  if (!server || typeof server !== 'object') return { ok: false, error: '无效的服务配置' }
  try {
    return await getAgentEngine().testMCP(server)
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) }
  }
})

// 静默总结对话标题(新对话入历史时后台生成,不打扰用户);
// 走独立的总结 Sub Agent(与主对话引擎隔离)
ipcMain.handle('agent:summarize', (_event, messages) =>
  getSummaryAgent().summarize(Array.isArray(messages) ? messages : []),
)

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
  const mode = settings.mode === 'agent' ? 'agent' : 'music'
  tray.setToolTip(`灵动岛挂件${mode === 'agent' ? '(Agent)' : ''}`)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示 / 隐藏灵动岛',
        click: () => toggleWindow(),
      },
      { type: 'separator' },
      {
        label: '设置…',
        click: () => {
          // 入口在托盘,设置面板在灵动岛内打开(渲染端展开并切换到设置视图,
          // 内含自定义图片背景 / 帮助手册 / 主题色 / Agent 设置入口)
          showWindow()
          win?.webContents.send('widget:open-settings')
        },
      },
      {
        // 模式切换:音乐播放器 ↔ Agent(对话 + 本机工具执行)
        label: '模式',
        submenu: [
          {
            label: '音乐模式',
            type: 'radio',
            checked: mode === 'music',
            click: () => setWidgetMode('music'),
          },
          {
            label: 'Agent 模式',
            type: 'radio',
            checked: mode === 'agent',
            click: () => setWidgetMode('agent'),
          },
        ],
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
    // 关闭 MCP 服务子进程(agentEngine 懒加载:未用过则不会创建,
    // 无资源泄漏;已使用过则连进程树一起清理)
    if (agentEngine) {
      try {
        agentEngine.dispose()
      } catch {
        // already gone
      }
    }
  })

  // 挂件常驻:所有窗口关闭也不退出(托盘退出除外)
  app.on('window-all-closed', () => {})
}
