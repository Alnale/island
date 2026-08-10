
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
  safeStorage,
  Notification,
  protocol,
} = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const fsPromises = require('node:fs/promises')
const { Readable } = require('node:stream')

// Agent 引擎(由 scripts/build-electron.mjs 打包):DeepSeek Responses API
// provider + 工具系统,主进程内运行(纯异步网络/文件 IO,无阻塞点)。
// 产物不入库(dev:widget 已前置构建);fresh clone 直接运行给出明确指引
// 而非崩在 require
if (!fs.existsSync(path.join(__dirname, 'agent.cjs'))) {
  console.error('[main] electron/agent.cjs 不存在——请先运行 pnpm build:electron(dev:widget 已自动前置)')
  process.exit(1)
}
const agentEngineModule = require('./agent.cjs')

// settings.json 持久化(原子写/损坏恢复/apiKey 加密/防抖,可单测)
const { createSettingsStore } = require('./settings-store.cjs')

// 截图/巡检测试模式(仅 WIDGET_SCREENSHOT env 时激活;依赖注入,见文件头)
const { runScreenshotTests } = require('./screenshot-tests.cjs')

// 透明窗口在 Windows GPU 合成下,叠在其他应用上方时半透明区域
// (岛体背景)的 alpha 偶发突变(闪全黑/全透明)。
// 禁用硬件加速走软件渲染:小窗口 60fps 无压力,合成稳定
app.disableHardwareAcceleration()
// HEVC(H.265)硬解(2026-08-08,用户下载视频"无法播放该文件"):
// Chromium 默认不支持 HEVC;系统装有「HEVC 视频扩展」(Win11 常见)
// 时经 Media Foundation 硬解,对话窗口内即可播放 HEVC mp4——
// 无扩展时此开关静默无效(仍走格式提示 + 系统播放器降级)
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport')
// 允许无手势自动播放(2026-08-10 修复"LLM 找歌来听没自动播放"):媒体
// 自动播放发生在工具执行完成后(异步,脱离用户手势链)——Electron 默认
// autoplay 策略(document-user-activation-required)对异步链路可能拦截
// (实测音频自动播放被静默拒绝)。桌面个人助手语义:页面全部媒体播放
// 都经代码控制(当次对话标记才自动播),放开策略无副作用
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// 未捕获异常兜底:退出/销毁竞态下窗口 IPC handler 抛异常时,Electron
// 默认弹错误框甚至退进程——记录日志继续运行(挂件托盘常驻语义;
// 具体竞态点已用 isDestroyed 防护,这里是最后防线)
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err)
})
process.on('unhandledRejection', (err) => {
  console.error('[main] unhandledRejection:', err)
})

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
// 架构(2026-08-06):内存缓存 + 原子写 + 防抖——原实现每次读盘 + 直接写
// 目标文件:强杀/断电会截断 JSON,下次保存以 {} 为基底覆盖写回(apiKey/
// mode/agent 配置整份丢失);loadSettings 在 agent 每轮被调用数十次(同步
// readFileSync 压主进程事件循环)
// ---------------------------------------------------------------------------

// settings.json 持久化(2026-08-07 抽 electron/settings-store.cjs,审计
// P1:原子写 + 损坏恢复 + apiKey 加密 + 防抖合帧首次可单元测试)。
// 函数名保持不变(薄包装),main.cjs 全部既有引用零改动;测试经工厂
// 注入内存 stub 直测 store
const settingsStore = createSettingsStore({
  safeStorage,
  getUserDataPath: () => app.getPath('userData'),
})
function settingsPath() {
  return settingsStore.path()
}
function loadSettings() {
  return settingsStore.load()
}
function saveSettings(patch) {
  return settingsStore.save(patch)
}
function flushSettings() {
  return settingsStore.flush()
}
/** 丢弃内存缓存(巡检恢复磁盘文件后调用:flush 对 null 缓存是 no-op,
 * 磁盘恢复即生效,不会被退出时的旧缓存 flush 覆盖,审计 P0) */
function resetSettingsCache() {
  return settingsStore.resetCache()
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
  // exec_command 确认门:默认关闭(现行为);开启后每轮首个命令需渲染端确认
  confirmExec: false,
  systemPrompt:
    '你是运行在桌面灵动岛挂件里的个人助手,名叫「岛灵」。' +
    '你可以调用本机工具(执行命令、读写文件、联网搜索、发通知等),' +
    '根据用户自然语言直接完成操作,无需沙箱限制。' +
    '回答简洁自然,使用与用户相同的语言;执行工具时先说明意图。',
  reasoningEffort: 'high',
  /** 主对话输出预算(2026-08-08):缺省 8192(预算只是上限,LLM 任务
   * 巨大时经 set_output_budget 按需调大),persist=true 写 settings.json */
  maxOutputTokens: 8192,
  /** MCP 服务列表(每个服务暴露 mcp_<服务>_<工具> 工具) */
  mcpServers: [],
  /** 技能目录列表(扫描 SKILL.md,每个技能暴露 skill_<名字> 工具) */
  skillsDirs: DEFAULT_SKILLS_DIRS,
  /** 已排除技能(扫描跳过;LLM 对话 / 设置界面移除) */
  excludedSkills: [],
  /** 已禁用工具名(工具列表视图禁用;内置/MCP/技能一律生效) */
  excludedTools: [],
  /**
   * 主动陪伴(2026-08-07):用户无操作满 proactiveInterval × 单位,
   * 由总结 Sub Agent 判断语境是否需要主动开口,是则主 Agent 完整回合
   * 主动回复(默认开启)
   */
  proactiveEnabled: true,
  /** 主动陪伴间隔数值(钳制 5–480;用户发送或主动回复后重新计时;
   * 2026-08-08 用户要求默认 15,单位分钟) */
  proactiveInterval: 15,
  /** 主动陪伴间隔单位(s=秒 / m=分钟(默认)/ h=小时) */
  proactiveIntervalUnit: 'm',
  /** 总结标题文风(Sub Agent 设置:预设 id 或自定义 ≤100 字;空 = 默认) */
  summaryStyle: '',
  /** 心理揣测人格(Sub Agent 设置:预设 id 或自定义 ≤100 字;空 = 默认) */
  mindPersona: '',
}

let agentEngine = null

/**
 * 当前 Agent 配置(统一入口:defaults 合并 + 旧版迁移)。
 * 2026-08-07 单位选择:旧 proactiveIntervalMinutes(数值,分钟)迁移为
 * {proactiveInterval: 同值, proactiveIntervalUnit: 'm'}——数值不变,
 * 单位语义 = 分钟,与"切换单位数值不变"的用户约定一致
 */
function currentAgentConfig() {
  const agent = { ...(loadSettings().agent ?? {}) }
  if (typeof agent.proactiveIntervalMinutes === 'number' && typeof agent.proactiveInterval !== 'number') {
    agent.proactiveInterval = agent.proactiveIntervalMinutes
    agent.proactiveIntervalUnit = 'm'
  }
  delete agent.proactiveIntervalMinutes
  return { ...AGENT_CONFIG_DEFAULTS, ...agent }
}

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
    getConfig: () => (currentAgentConfig()),
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
  // Sub Agent 设置(2026-08-07):文风/人格,预设 id 或自定义 ≤100 字
  for (const key of ['summaryStyle', 'mindPersona']) {
    const value = patch?.[key]
    if (typeof value === 'string') {
      next[key] = value.trim().slice(0, 100)
    }
  }
  // 布尔开关(确认门 / 主动陪伴)
  if (typeof patch?.confirmExec === 'boolean') {
    next.confirmExec = patch.confirmExec
  }
  if (typeof patch?.proactiveEnabled === 'boolean') {
    next.proactiveEnabled = patch.proactiveEnabled
  }
  // 主动陪伴间隔(2026-08-07 单位选择:数值 5–480 取整,单位 s/m/h 枚举)。
  // 兼容旧 proactiveIntervalMinutes:patch 带旧字段而新字段缺失时迁移
  // (数值不变,单位 = 分钟);写回统一清旧字段防脏
  // 主对话输出预算(2026-08-08):数字字段,钳制 4096–262144(官方
  // 上限 384K 留余量);LLM set_output_budget persist=true 走这里
  if (typeof patch?.maxOutputTokens === 'number' && Number.isFinite(patch.maxOutputTokens)) {
    next.maxOutputTokens = Math.min(262144, Math.max(4096, Math.round(patch.maxOutputTokens)))
  }
  if (typeof patch?.proactiveInterval === 'number' && Number.isFinite(patch.proactiveInterval)) {
    next.proactiveInterval = Math.min(480, Math.max(5, Math.round(patch.proactiveInterval)))
  } else if (
    typeof patch?.proactiveIntervalMinutes === 'number' &&
    Number.isFinite(patch.proactiveIntervalMinutes)
  ) {
    next.proactiveInterval = Math.min(480, Math.max(5, Math.round(patch.proactiveIntervalMinutes)))
    next.proactiveIntervalUnit = 'm'
  }
  if (patch?.proactiveIntervalUnit === 's' || patch?.proactiveIntervalUnit === 'm' || patch?.proactiveIntervalUnit === 'h') {
    next.proactiveIntervalUnit = patch.proactiveIntervalUnit
  }
  delete next.proactiveIntervalMinutes
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

// exec_command 确认门 pending(引擎 confirmCommand 持此 promise,
// 渲染端经 agent:tool-confirm IPC 回用户选择)
let pendingCommandConfirm = null

/** 安全转发事件到挂件窗口(审计 P2-5):win 存在但 webContents 已销毁的
 * 竞态窗口 send 会抛原生异常,依赖全局 uncaughtException 兜底不可靠 */
function sendToWidget(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

/**
 * 主动陪伴:主动回合消息落定后,主进程跑心理揣测 → ① **Windows 系统
 * 通知**展示(用户要求的"系统消息"展示揣测)② mind-proactive 事件送
 * 渲染端更新紧凑态文字区——与通知同一句,两处一致、不重复调用 LLM。
 * 抽成具名函数:onEvent 钩子与巡检(deps 注入 runProactiveGuess,绕开
 * LLM 调度的确定性测试,同 runIslandSettings 模式)共用。
 * getMindAgent 是独立 Sub Agent 单例(事件静默),guess 失败返回空串
 * → 不通知,可接受
 */
function runProactiveGuess(message) {
  return getMindAgent()
    .guess([message])
    .then((g) => {
      if (!g) return null
      new Notification({ title: '岛灵 · 心理揣测', body: g }).show()
      sendToWidget('agent:event', {
        type: 'mind-proactive',
        messageId: message.id,
        guess: g,
      })
      return g
    })
    .catch(() => null)
}

function getAgentEngine() {
  if (agentEngine) return agentEngine
  agentEngine = agentEngineModule.createAgentEngine({
    getConfig: () => (currentAgentConfig()),
    onEvent: (event) => {
      // 后台任务完成通知(background-done)只在 Agent 模式转发:
      // 渲染端收到会**自动触发一轮对话**(LLM 主动告知结果)——音乐
      // 模式下自动对话没有意义,还会污染历史
      if (event.type === 'background-done' && currentMode() !== 'agent') return
      sendToWidget('agent:event', event)
      // 主动陪伴(2026-08-07):主动回合消息落定 → 心理揣测系统通知 +
      // mind-proactive 事件(见 runProactiveGuess)
      if (event.type === 'message' && event.message?.proactive) {
        void runProactiveGuess(event.message)
      }
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
    // exec_command 确认门:发确认请求给渲染端,等用户选择(超时拒绝)。
    // **并行确认互斥**(2026-08-07 审计 P0):LLM 一轮内并行多个
    // exec_command(executeToolBatch 是 Promise.all)时,新请求到达立即
    // 以"拒绝"落定旧请求(引擎结构化回填,LLM 可自纠)——否则旧 promise
    // 永挂(其定时器触发时槽已指向新请求,无人 resolve),整轮冻结,
    // agent:abort 也解不开;定时器只处理**自己那次**(=== slot)
    confirmCommand: (command) =>
      new Promise((resolve) => {
        if (pendingCommandConfirm) {
          clearTimeout(pendingCommandConfirm.timer)
          pendingCommandConfirm.resolve(false)
        }
        const slot = { resolve, timer: null }
        slot.timer = setTimeout(() => {
          if (pendingCommandConfirm === slot) {
            pendingCommandConfirm = null
            resolve(false)
          }
        }, 120000)
        pendingCommandConfirm = slot
        sendToWidget('agent:event', {
          type: 'tool-confirm-request',
          command: String(command ?? '').slice(0, 400),
        })
      }),
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
// 操作白名单(审计 P2):只放行 settingsTools.ts 注册的操作名(IslandSettingsOp),
// 防 constructor/__proto__ 等原型链键命中被调用;新增操作时两端同步,
// 漏加 = 安全侧失败(工具报"未知操作",LLM 可自纠)
const ISLAND_SETTINGS_OPS = new Set([
  'getSettings', 'setThemeColor', 'setAgentScale', 'importFont', 'listFonts',
  'renameFont', 'importBackground', 'listLibraryImages', 'renameLibraryImage',
  'setFontColor', 'setBackgroundOpacity', 'deleteFontItem', 'deleteLibraryImage',
  // 媒体窗口/多媒体库(2026-08-10 补:settingsTools.ts 已注册但白名单漏加,
  // LLM 调用报"未知的设置操作"——实测 import_audio_library 等全部不可用)
  'setMediaWindowSize', 'listAudioLibrary', 'importAudioLibrary',
  'renameAudioLibrary', 'removeAudioLibrary', 'listVideoLibrary',
  'importVideoLibrary', 'renameVideoLibrary', 'removeVideoLibrary',
  'playLibraryVideo',
  // 视频播放设置(2026-08-10,set_video_config 工具)
  'getVideoPrefs', 'setVideoPrefs', 'setFullscreen',
  // 对话窗口媒体清单(2026-08-10,list_conversation_media 工具)
  'getConversationMedia',
])
async function runIslandSettings(op, args) {
  if (!ISLAND_SETTINGS_OPS.has(op)) throw new Error(`未知的设置操作:${String(op)}`)
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
    getConfig: () => (currentAgentConfig()),
    // 主动陪伴判断(judgeProactive)需要同源上下文:记忆块/进化状态进
    // 判断系统提示,否则判断不知道助手"记得什么、在忙什么"
    getMemoryStore: () => getMemoryStore(),
    getEvolution: () => getEvolution(),
  })
  return summaryAgent
}

// 独立的心理揣测后台 Sub Agent(懒加载单例):与总结标题/主对话引擎
// 均零共享,失败返回空串(渲染端回退标题/回复预览);
// 注入记忆/进化依赖——揣测的系统提示与主引擎同源(自定义提示词 +
// 长期记忆块 + 进化状态 + 后台任务状态),否则心理是猜的空气
let mindAgent = null

function getMindAgent() {
  if (mindAgent) return mindAgent
  mindAgent = agentEngineModule.createMindAgent({
    getConfig: () => (currentAgentConfig()),
    // 与主引擎同款记忆/进化单例(记忆块进系统提示,揣测知道助手记得什么)
    getMemoryStore: () => getMemoryStore(),
    getEvolution: () => getEvolution(),
  })
  return mindAgent
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
      // 安全项显式声明(2026-08-06 架构审计):sandbox/webSecurity 依赖
      // Electron 默认值会随版本漂移,显式声明防静默降级
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  })
  // 禁止窗口内新开浏览器窗口(渲染端链接一律走 app:open-external 系统
  // 浏览器,经 http/https 白名单;防 window.open 弹出裸窗口)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  // 灵动岛默认悬浮在所有程序顶部(2026-08-09 用户要求恢复:始终置顶,
  // 不再沉底)——托盘"总在最前"可关
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
  // 全屏尺寸锁定恢复(2026-08-09 三轮修复,用户实测"全屏拖拽窗口越来
  // 越大"):set-size 零调用日志证明非 IPC 泄漏——Electron 透明窗口 +
  // DOM 全屏 + 窗口移动时 Chromium 自行改窗口尺寸;全屏期间任何 resize
  // 立即恢复到锁定尺寸(位置保持当前,防递归:恢复到锁定值不再触发)
  win.on('resize', () => {
    if (!widgetFullscreen || !fsLockedSize || win.isDestroyed()) return
    const [w, h] = win.getSize()
    // 2px 容差(2026-08-10:Windows 透明无边框窗口实际尺寸比请求值
    // 大 ~1-2px(实测 1709 vs 1708),无容差会"纠正 → 取整 → 再纠正"
    // 循环;用户"越来越大"是几十 px 级,2px 内不纠正)
    if (
      Math.abs(w - fsLockedSize[0]) <= 2 &&
      Math.abs(h - fsLockedSize[1]) <= 2
    ) {
      return
    }
    const [x, y] = win.getPosition()
    console.log(
      '[widget] fullscreen resize corrected:',
      w, h,
      '→',
      fsLockedSize[0], fsLockedSize[1],
    )
    win.setBounds({ x, y, width: fsLockedSize[0], height: fsLockedSize[1] })
  })
  // 加载完成后广播当前模式(渲染端启动时也走 getMode 兜底)
  win.webContents.once('did-finish-load', () => {
    sendToWidget('widget:set-mode', { mode: currentMode(), source: 'user' })
    // 初次安装:settings.json 不存在 → 落盘首启标记(帮助手册引导已移除
    // 2026-08-10 用户要求,仅保留 firstRun 标记)
    if (!fs.existsSync(settingsPath())) {
      saveSettings({ firstRun: true })
    }
  })

  // 关闭 = 隐藏(挂件常驻托盘),托盘"退出"才真正结束
  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      win.hide()
    }
  })

  // 渲染进程异常诊断(卡死/崩溃排查);崩溃(crashed/oom)自动重载——
  // 否则挂件白屏必须手动重启应用(内存压力/IDB 大图等场景常见)
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[widget] renderer gone:', details.reason)
    if (details.reason === 'crashed' || details.reason === 'oom') {
      setTimeout(() => {
        if (win && !win.isDestroyed() && !quitting) win.webContents.reload()
      }, 500)
    }
  })

  // 调试:设置 WIDGET_SCREENSHOT=<path> 时,页面加载后截一张窗口图用于验证。
  // 截图/巡检模式(设置 WIDGET_SCREENSHOT=<path> 时):逻辑抽在
  // electron/screenshot-tests.cjs(2026-08-06 架构优化,原内嵌 ~1160 行),
  // 依赖经 deps 注入,不参与正常运行路径
  if (process.env.WIDGET_SCREENSHOT) {
    runScreenshotTests({
      win,
      app,
      fs,
      path,
      settingsPath,
      runIslandSettings,
      resetSettingsCache,
      // 主动陪伴:主动消息 → 心理揣测 + 系统通知 + mind-proactive 事件
      // (巡检直接调主进程函数,绕开 LLM 调度的确定性测试)
      runProactiveGuess,
      // 主动陪伴完整回合(引擎 proactiveTurn;巡检端到端验证真实回合
      // 流式落定 → 主进程钩子 → 揣测通知的完整链路)
      startProactiveTurn: (history, opts) => getAgentEngine().proactiveTurn(history, opts),
      // 主动陪伴 tick 最近结果(巡检轮询:判定调度器按 10s 真实触发,
      // 不依赖 judge 结果——judge-no 也证明调度链路通了)
      getLastProactiveTick,
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
  // 窗口销毁竞态(托盘退出/重启瞬间渲染端仍有在途 IPC):isDestroyed 检查
  // 防原生层抛异常(实测退出瞬间 drag-move 的 setPosition 抛过
  // "conversion failure",win 已销毁时调用任何窗口方法都会抛)
  if (!win || win.isDestroyed()) return
  // 穿透切换时间戳(2026-08-10 诊断:复现"清除数据后悬浮延迟"时核对
  // 恢复时序——mouseleave 开穿透与轮询校正回接收的间隔即恢复延迟)
  console.log('[pointer]', Date.now(), 'active:', active)
  // 点击穿透开关:true = 鼠标在岛上,正常接收事件;false = 穿透给下层窗口
  win.setIgnoreMouseEvents(!active, { forward: !active })
  // 切接收时刷新页面 hover(2026-08-10 修复"收起后鼠标悬浮无响应"):
  // 穿透死锁 = 穿透态下 OS 不投递鼠标事件,校正回接收后页面没有新的
  // mousemove,Chromium 不重算 hover/mouseenter 不触发(实测移回岛体
  // 后 hover 仍 false)——主进程按光标当前位置补发一次 mousemove,
  // 页面立即重算 hover,悬浮/点击恢复;光标不在窗口内则跳过(移入时
  // 的 mousemove 会自然触发)
  if (active) {
    try {
      const c = screen.getCursorScreenPoint()
      const b = win.getBounds()
      if (c.x >= b.x && c.x <= b.x + b.width && c.y >= b.y && c.y <= b.y + b.height) {
        win.webContents.sendInputEvent({ type: 'mouseMove', x: c.x - b.x, y: c.y - b.y })
      }
    } catch {
      // 光标/边界读取失败(窗口销毁竞态)忽略,不影响穿透切换
    }
  }
})
// 穿透轮询校正(2026-08-10 修复"清除数据后收起,鼠标悬浮/点击无响应"):
// mouseenter/leave 事件驱动穿透在窗口/岛体收缩(收起动画)时鼠标滑出岛体
// → mouseleave → 穿透开启;穿透态下 OS 不再投递鼠标事件到窗口(forward
// 转发的 mousemove 在 Windows 上不可靠),鼠标移回岛体时 mouseenter 永不
// 触发 = 穿透死锁(用户实测)。渲染端每 600ms 轮询本通道:返回窗口屏幕
// bounds + 光标屏幕位置,渲染端核对岛体 rect,状态不一致即校正穿透——
// 完全绕开事件可靠性,轮询兜底(正常 mouseenter/leave 仍走事件,幂等)
ipcMain.handle('widget:pointer-poll', () => {
  if (!win || win.isDestroyed()) return null
  try {
    // 真实穿透状态(2026-08-10 校正依据:渲染端意图可能因事件/轮询竞态
    // 与主进程实际状态脱节)——isIgnoreMouseEvents 部分 Electron 版本
    // 不存在(实测 43 报 is not a function),单独容错返回 undefined,
    // 渲染端回退"意图比较";bounds/cursor 始终可用
    let ignoreMouseEvents
    try {
      ignoreMouseEvents =
        typeof win.isIgnoreMouseEvents === 'function' ? win.isIgnoreMouseEvents() : undefined
    } catch {
      ignoreMouseEvents = undefined
    }
    return {
      bounds: win.getBounds(),
      cursor: screen.getCursorScreenPoint(),
      ignoreMouseEvents,
    }
  } catch {
    // 读取失败(窗口销毁竞态等)返回 null,渲染端跳过本轮
    return null
  }
})

// 消息气泡链接:系统浏览器打开(仅 http/https,防协议注入;
// 渲染端 Markdown 渲染器也只把 http(s) 渲染为可点击链接)
ipcMain.on('app:open-external', (_event, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) void shell.openExternal(url)
})

// 媒体降级打开(2026-08-08):岛内播放失败时用系统默认播放器打开
// (外部播放器仅为降级选择,正常播放全在窗口内)。远程 URL 走系统
// 浏览器(openExternal);本地路径经 island-media://local/<编码路径>
// 解码后 shell.openPath,扩展名与协议读同款校验(仅媒体可访问)。
// MEDIA_MIME_BY_EXT 声明在本文件后部,handler 运行时已初始化
ipcMain.on('app:open-media-external', (_event, url) => {
  if (typeof url !== 'string' || !url) return
  if (/^https?:\/\//i.test(url)) {
    void shell.openExternal(url)
    return
  }
  const m = /^island-media:\/\/local\/(.+)$/i.exec(url)
  const filePath = m ? decodeURIComponent(m[1]) : url
  const ext = path.extname(filePath).toLowerCase()
  if (!MEDIA_MIME_BY_EXT[ext]) return
  void shell.openPath(filePath)
})

// 死通道清理(审计 P2-1):widget:hide / widget:quit / widget:topmost
// 原为渲染端无人调用的通道(托盘退出走 app.quit、置顶走 tray 直调),
// 已删除;set-window-size 是渲染端唯一窗口尺寸通道

// 窗口尺寸调整节流:min-interval 16ms(≈一帧)——Agent 面板高度动画
// 每帧上报窗口跟随(平滑无台阶),帧内多次请求只保留最后一次;
// 普通视图切换(低频)不受影响;OS 窗口 resize 本身廉价,避免的是
// 渲染端逐事件高频 IPC 与帧内重复 resize
let windowResizeLastAt = 0
let windowResizeTimer = null
let windowResizePending = null
function scheduleWindowResize(fn) {
  windowResizePending = fn
  if (windowResizeTimer) return
  const wait = Math.max(0, 16 - (Date.now() - windowResizeLastAt))
  windowResizeTimer = setTimeout(() => {
    windowResizeTimer = null
    windowResizeLastAt = Date.now()
    const f = windowResizePending
    windowResizePending = null
    if (f) f()
  }, wait)
}

// 调整窗口尺寸(Agent 面板缩放:宽高按岛体视觉尺寸 + 余量;
// 其余视图由 set-size 保持 520 宽;widget:set-height 死通道已删)。
// 合理范围钳制,防脏数据。
// **展开位置补偿(2026-08-08 修复"首次展开偏右")**:win.setSize 的
// 锚点 = 左上角,变宽时窗口向右扩展 → 岛体视觉右偏(启动顶部居中的
// 窗口展开最明显,实测需手动拖回)。补偿:宽度变化保持窗口中心 X
// 不动(岛体左右对称展开,右扩变双扩),高度变化保持顶部不动
// (岛体向下生长,挂件在屏幕上方展开符合直觉)。
// **只按请求宽度变化补偿(2026-08-08 修复"展开向右位移")**:
// Windows 透明无边框窗口的实际宽比请求宽大 ~2px(实测 1242 vs 1240),
// 若每次 set-size(仅高度变化,如 Agent 面板高度渐进每帧上报)都按
// (ow-cw)/2 补偿,宽度偏差会被当成真实宽度变化,每帧右移 1-9px,
// 展开动画期间累积 80px+(实测 wx 从 237 漂到 318)。请求宽度未变
// (2px 容差)时不做 X 补偿,窗口位置稳定。
// **必须用 setBounds 而非 setSize(2026-08-08 修复"切音乐右漂")**:
// `resizable: false` 的窗口在 Windows 上 `setSize` **大→小不生效**
// (实测:520→1240 生效、1240→520 无效,窗口停在 1240)——此前
// setSize(520) 无效但 setPosition 补偿生效,1242 宽的窗口整体右移
// 361px,岛体(窗口内居中)跟着右漂 361(实测 after-pos size 仍
// [1242,282])。setBounds 走 SetWindowPos 同机制且对不可调窗口
// 生效,一次调用同时设位置+尺寸(无"先移后缩"中间态)
let lastSetSizeW = 0
// 全屏状态(2026-08-08 二轮修复"全屏时右键拖拽窗口越来越大"):渲染端
// fullscreenchange 经 widget:fullscreen 上报,全屏期间 widget:set-size
// **主进程兜底忽略**——渲染端 setWinSize 已有全屏守卫,但任何漏网
// 路径(旧调度中残留的 set-size、守卫竞态等)一旦改窗口尺寸,全屏层
// (100% viewport)就跟随放大 = "越来越大"。忽略同时打日志便于定位
// 泄漏来源。
// **全屏尺寸锁定(2026-08-09 三轮修复,用户实测日志确认)**:set-size
// 零调用但窗口仍变大——Electron 透明窗口 + DOM 全屏 + 窗口移动时
// Chromium 自行改变窗口尺寸(非 IPC 路径,getSize 实测)。全屏进入时
// 记录锁定尺寸,win resize 事件(Chromium 改尺寸会触发)立即 setBounds
// 恢复(位置保持,防递归:恢复到锁定尺寸后不再触发)
let widgetFullscreen = false
let fsLockedSize = null
// 全屏前的窗口尺寸/位置(2026-08-10 用户"窗口太小":全屏层 = 100%
// viewport = 窗口客户区,DOM 全屏在小窗 400×200 里 = 视频画面太小;
// **媒体岛全屏**(isMini=true)进入时把窗口放大到**鼠标所在显示器
// 工作区**(真全屏感),退出恢复全屏前位置+尺寸;对话窗口内媒体全屏
// (isMini=false)不放大窗口——只覆盖 Agent 对话窗口,范围由用户要求
// 收敛)
let preFsBounds = null
let preFsMini = false
ipcMain.on('widget:fullscreen', (_event, fs, inMini) => {
  widgetFullscreen = Boolean(fs)
  const isMini = Boolean(inMini)
  if (widgetFullscreen) {
    preFsMini = isMini
    if (win && !win.isDestroyed()) {
      preFsBounds = { ...win.getBounds() }
      if (isMini) {
        // 放大到鼠标所在显示器工作区(排除任务栏;多显示器取当前显示器)
        try {
          const pt = screen.getCursorScreenPoint()
          const { workArea } = screen.getDisplayNearestPoint(pt)
          // 高 DPI 下 workArea 是逻辑坐标,setBounds 同样用逻辑坐标,直接透传
          win.setBounds({
            x: workArea.x,
            y: workArea.y,
            width: workArea.width,
            height: workArea.height,
          })
        } catch (err) {
          console.error('[widget] fullscreen expand failed:', err)
        }
      }
    }
    const [w, h] = win ? win.getSize() : [0, 0]
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      fsLockedSize = [w, h]
      console.log('[widget] fullscreen locked size:', w, h, 'mini=', isMini)
    }
  } else {
    fsLockedSize = null
    // 退出全屏:媒体岛全屏(放大过窗口)恢复全屏前窗口的**位置 + 尺寸**
    // (2026-08-10 用户要求"缩回到原来展开时的小窗位置");对话窗口内
    // 媒体全屏未放大窗口,无需恢复
    if (preFsMini && preFsBounds && win && !win.isDestroyed()) {
      win.setBounds(preFsBounds)
    }
    preFsBounds = null
    preFsMini = false
  }
})
// 窗口尺寸应用(共用):位置中心补偿 + setBounds(合帧调度与直通共用)
function applyWindowSize(cw, ch) {
  if (!win || win.isDestroyed()) return
  const [wx, wy] = win.getPosition()
  const [ow] = win.getSize()
  // 补偿 = 仅请求宽度变化时保持窗口中心 X 不动(2px 容差防取整抖动)
  const dx =
    Number.isFinite(wx) && Number.isFinite(wy) && Number.isFinite(ow) && ow > 0 &&
    Math.abs(cw - lastSetSizeW) >= 2
      ? Math.round((ow - cw) / 2)
      : 0
  win.setBounds({
    x: Number.isFinite(wx) ? wx + dx : wx,
    y: Number.isFinite(wy) ? wy : wy,
    width: cw,
    height: ch,
  })
  lastSetSizeW = cw
}
ipcMain.on('widget:set-size', (_event, width, height, immediate) => {
  const w = Number(width)
  const h = Number(height)
  if (!Number.isFinite(w) || !Number.isFinite(h)) return
  const cw = Math.max(400, Math.min(1600, Math.round(w)))
  const ch = Math.max(200, Math.min(2000, Math.round(h)))
  if (widgetFullscreen) {
    console.log('[widget] set-size IGNORED (fullscreen):', cw, ch)
    return
  }
  // 直通模式(2026-08-10 修复"设置↔帮助切换 UI 抖动"):帮助手册等
  // 视图切换的窗口补间(rAF 每帧发尺寸)经 100ms trailing 合帧被压成
  // ~10Hz 台阶,而岛体 CSS 过渡 60fps 平滑——窗口台阶滞后岛体,
  // 高度/宽度被窗口切角(help-anim 巡检实测裁剪 8 帧最大 34px +
  // 每 100ms 跳变)。补间调用 immediate=true 直接 setBounds 不合帧,
  // 窗口与岛体同帧平滑
  if (immediate === true) {
    applyWindowSize(cw, ch)
    return
  }
  scheduleWindowResize(() => {
    // 调度窗口期间进入全屏:残留的 set-size 同样丢弃
    if (!win || win.isDestroyed() || widgetFullscreen) {
      if (widgetFullscreen && !win?.isDestroyed?.()) {
        console.log('[widget] set-size IGNORED (fullscreen, stale):', cw, ch)
      }
      return
    }
    applyWindowSize(cw, ch)
  })
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
  if (!win || win.isDestroyed()) return
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

// 自校正降频:getPosition 是同步 OS 往返,每事件都查浪费——拖拽跟手只
// 需 ~10Hz 校正(绝对定位本身不累积误差,校正只为 OS 取整/钳制纠偏)
const DRAG_CORRECT_MS = 100
let dragLastCorrectAt = 0

ipcMain.on('widget:drag-move', (_event, sx, sy) => {
  if (!win || win.isDestroyed() || !dragState) return
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
  // 保证下一次移动继续"跟手",不累积相对偏移;异常落点不采信。
  // 降频到 ~10Hz(每事件校正 = 每次移动两次同步 OS 往返,纯浪费)
  const now = Date.now()
  if (now - dragLastCorrectAt < DRAG_CORRECT_MS) return
  dragLastCorrectAt = now
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
  dragLastCorrectAt = 0
})

// ---------------------------------------------------------------------------
// IPC:Agent 模式(渲染端 → 引擎)
// ---------------------------------------------------------------------------

/** IPC 数组参数兜底(agent:send/summarize/mind-guess 共用,审计 P2 #7) */
function asArray(value, fallback = []) {
  return Array.isArray(value) ? value : fallback
}

// 发送一轮对话:引擎无状态,history 为渲染端回传的完整历史
ipcMain.on('agent:send', (_event, text, history) => {
  if (typeof text !== 'string') return
  getAgentEngine().send(text, asArray(history))
})

// exec_command 确认门回执(渲染端用户点允许/拒绝)
ipcMain.on('agent:tool-confirm', (_event, approved) => {
  if (!pendingCommandConfirm) return
  clearTimeout(pendingCommandConfirm.timer)
  pendingCommandConfirm.resolve(Boolean(approved))
  pendingCommandConfirm = null
})

ipcMain.on('agent:abort', () => {
  getAgentEngine().abort()
})

// 配置读取/写入(API Key / Base URL / 模型 / 系统提示词,存 settings.json;
// 经 currentAgentConfig:defaults 合并 + 旧 proactiveIntervalMinutes 迁移)
ipcMain.handle('agent:config-get', () => currentAgentConfig())

ipcMain.handle('agent:config-set', (_event, patch) => applyAgentConfigPatch(patch))

/** 主动陪伴 tick 最近一次结果(巡检经 deps 轮询:判定调度器确实按
 * 10s 间隔触发,不依赖 LLM judge 结果——judge-no 也应记录) */
let lastProactiveTick = null

function getLastProactiveTick() {
  return lastProactiveTick
}

// 主动陪伴 tick(2026-08-07):渲染端调度器触发(无操作满 N 分钟)。
// 判模式/配置/引擎忙 → 总结 Sub Agent 判断语境 → should 则主 Agent
// 完整回合主动回复。**resolve 时机 = judge 完成后**(渲染端 in-flight
// 覆盖 judge 全程,期间用户 send 天然优先——judge 结果到来时引擎已
// busy,proactiveTurn 自动放弃)。judge-no 携带 reason 供渲染端回退
// idle 时钟(下次判断在 N 分钟后,防闲置时每分钟一次 LLM 判断调用)。
// 每次调用记录 lastProactiveTick(巡检轮询用)
ipcMain.handle('agent:proactive-tick', async (_event, messages, idleMinutes) => {
  let result
  try {
    if (currentMode() !== 'agent') result = { started: false, reason: 'mode' }
    else if (!currentAgentConfig().proactiveEnabled) result = { started: false, reason: 'disabled' }
    else if (getAgentEngine().busy) result = { started: false, reason: 'busy' }
    else {
      // 防御过滤:只收 user/assistant(系统消息/脏数据不参与判断)
      const list = asArray(messages).filter(
        (m) => m && typeof m === 'object' && (m.role === 'user' || m.role === 'assistant'),
      )
      if (list.length === 0) result = { started: false, reason: 'empty' }
      else {
        const minutes = Math.min(480, Math.max(1, Math.round(Number(idleMinutes) || 60)))
        const verdict = await getSummaryAgent().judgeProactive(list, minutes)
        if (!verdict.should) result = { started: false, reason: 'judge-no' }
        else {
          getAgentEngine().proactiveTurn(list, { hint: verdict.hint })
          result = { started: true }
        }
      }
    }
  } catch (err) {
    // judge 调用失败不抛 unhandled rejection(渲染端无需感知,静默跳过)
    console.error('[agent] proactive-tick failed:', err)
    result = { started: false, reason: 'judge-error' }
  }
  lastProactiveTick = { at: Date.now(), ...result }
  return result
})

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
    // 记忆文件不存在(从未写入)→ 导出空记忆(审计 P2-3,原 ENOENT 抛错)
    const raw = await fs.promises.readFile(memoryPath, 'utf8').catch(() => '{"entries":[]}')
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
// IPC handler 统一错误保护(审计 P1-1):handle 拒绝(reject)会变成渲染端
// unhandled rejection;统一 try/catch,失败返回 {error} 结构(与
// memory-export/memory-import 既有约定一致,渲染端据此展示)
function safeHandle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await fn(...args)
    } catch (err) {
      return { error: (err && err.message) || String(err) }
    }
  })
}
safeHandle('agent:evolution-rollback', async () => getEvolution().rollback())
safeHandle('agent:evolution-reset', async () => getEvolution().resetAll())
safeHandle('agent:tools', async () => getAgentEngine().listAllTools())
// 清除数据(2026-08-10 用户要求,Agent 设置「数据管理」区):
// - scope 'app'   = 灵动岛所有数据:记忆/进化版本/settings.json(含
//   API Key/模型/模式)——渲染端已清 localStorage + IndexedDB,这里清
//   userData 文件;删除后重置内存缓存(懒加载单例重建,不然旧缓存会在
//   下次 save 复活;settingsCache 置 null,before-quit flush 变 no-op)
// - scope 'tools' = 所有工具的下载记录及源文件:bili 下载目录与登录态、
//   xxt 登录态与截图目录
// 删除失败(文件被占用,如下载中)返回 {error},渲染端展示;force 忽略
// 不存在,部分失败不中断其余删除
safeHandle('agent:clear-data', async (scope) => {
  const ud = app.getPath('userData')
  const rm = (p) => fs.rmSync(p, { recursive: true, force: true })
  if (scope === 'app') {
    rm(path.join(ud, 'memory.json'))
    rm(path.join(ud, 'memory-state.json'))
    rm(path.join(ud, 'evolution.json'))
    rm(path.join(ud, 'memory-snapshots'))
    rm(path.join(ud, 'settings.json'))
    memoryStore = null
    evolutionHandle = null
    resetSettingsCache()
    // 引擎随数据重建(2026-08-10 修复"LLM 列出记忆 id 但设置视图长期
    // 记忆为空"):引擎 tools 创建时持有 store 引用,不清除则旧引用继续
    // 操作已删除的旧记忆、与渲染端读的新实例永久不一致;dispose 清理
    // MCP 子进程,懒加载在下次对话重建
    if (agentEngine) {
      try {
        agentEngine.dispose()
      } catch {
        // already gone
      }
      agentEngine = null
    }
    return { ok: true }
  }
  if (scope === 'tools') {
    // bili 下载与登录态(下载中文件被占用会抛错 → 返回错误,可稍后重试)
    rm(path.join(ud, 'bili'))
    rm(path.join(ud, 'xxt-profile'))
    rm(path.join(ud, 'xxt-screenshots'))
    return { ok: true }
  }
  return { error: `未知的清除范围:${String(scope)}` }
})

/** 媒体扩展名 → MIME(island-media 协议推断 Content-Type;与渲染端
 * uploadStore 同款推断表,保持一致) */
const MEDIA_MIME_BY_EXT = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}
/** 本地媒体大小上限(2026-08-08 用户要求,按类型):视频 10GB /
 * 音频 1GB / 图片 10GB。**流式协议播放**(island-media://)——
 * 主进程按 Range 流式返回,Chromium 媒体栈边下边播,不整体进内存
 * (200MB 全量 Buffer + IPC 克隆会双倍占内存,10GB 直接 OOM,故不用
 * IPC 读取方案) */
const GB = 1024 * 1024 * 1024
const MEDIA_LIMIT_BY_EXT = {
  '.mp4': 10 * GB,
  '.m4v': 10 * GB,
  '.mov': 10 * GB,
  '.webm': 10 * GB,
  '.mp3': 1 * GB,
  '.wav': 1 * GB,
  '.flac': 1 * GB,
  '.ogg': 1 * GB,
  '.oga': 1 * GB,
  '.opus': 1 * GB,
  '.m4a': 1 * GB,
  '.aac': 1 * GB,
  '.png': 10 * GB,
  '.jpg': 10 * GB,
  '.jpeg': 10 * GB,
  '.gif': 10 * GB,
  '.webp': 10 * GB,
  '.bmp': 10 * GB,
}

// 自定义媒体协议特权(流式 body + 标准 URL 解析 + 安全上下文):
// 必须在 app ready 之前注册(registerSchemesAsPrivileged 的硬约束)
// **corsEnabled(2026-08-09 修复音频移交"fetch 被 CORS 拦截"根因)**:
// file:// 页面 fetch(island-media://) 是跨源请求,Chromium 只允许
// chrome/data/http 等内置 scheme 的跨源 fetch——自定义 scheme 不注册
// corsEnabled 时请求在网络层直接拒绝("Cross origin requests are only
// supported for protocol schemes: ..."),响应里的 Access-Control-Allow-
// Origin 头根本到不了 CORS 检查(实测:移交 fetch 一直 Failed to fetch,
// 静默降级只切模式——此前 CSP/URL 归一化修复都拦在这一层之前)
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'island-media',
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
])

/**
 * 本地媒体流式播放协议(2026-08-08,对话媒体窗口):
 * `island-media://local/<encodeURIComponent(绝对路径)>` —— 渲染端
 * MediaFrame 对本地路径直接映射此协议,img/video/audio 的 src 指向它;
 * 主进程按扩展名校验(仅媒体可访问,防任意文件读取)与按类型大小上限
 * (视频 10GB/音频 1GB/图片 10GB,超限 413)。
 * **流式实现**:fs.createReadStream 转 Web ReadableStream 分块发送,
 * 完整支持 Range 请求(206 + Content-Range,视频 seek 必需)——不用
 * net.fetch(file://):Chromium 的 file:// 请求不带/不支持 Range,视频
 * 播放器发 Range 会得到 416(实测 ERR_REQUEST_RANGE_NOT_SATISFIABLE)。
 * 播放全程内存占用 ≈ 块大小,10GB 视频不整体进内存。
 */
function registerIslandMediaProtocol() {
  protocol.handle('island-media', async (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname !== 'local') {
        return new Response('无效的媒体请求', { status: 400 })
      }
      const filePath = decodeURIComponent(url.pathname.replace(/^\//, ''))
      const ext = path.extname(filePath).toLowerCase()
      const mime = MEDIA_MIME_BY_EXT[ext]
      if (!mime) {
        return new Response('仅支持媒体文件(图片/视频/音频)', { status: 403 })
      }
      let stat
      try {
        stat = await fsPromises.stat(filePath)
      } catch {
        return new Response(`文件不存在:${filePath}`, { status: 404 })
      }
      if (!stat.isFile()) return new Response('不是文件', { status: 400 })
      const limit = MEDIA_LIMIT_BY_EXT[ext]
      if (stat.size > limit) {
        const isAudio = ['.mp3', '.wav', '.flac', '.ogg', '.oga', '.opus', '.m4a', '.aac'].includes(ext)
        return new Response(
          `文件过大(${(stat.size / GB).toFixed(1)}GB,该类型上限 ${isAudio ? '1GB' : '10GB'})`,
          { status: 413 },
        )
      }
      // Range 请求(视频 seek/分片):bytes=start-end → 206 部分内容
      const range = request.headers.get('range')
      let status = 200
      let start = 0
      let end = stat.size - 1
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
        if (m && (m[1] || m[2])) {
          if (m[1]) start = Math.min(parseInt(m[1], 10), stat.size - 1)
          if (m[2]) end = Math.min(parseInt(m[2], 10), stat.size - 1)
          if (start > end) return new Response('Range Not Satisfiable', { status: 416 })
          status = 206
        }
      }
      const headers = {
        'Content-Type': mime,
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      }
      if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`
      // createReadStream 流式分块 → Web ReadableStream(内存安全)
      const stream = Readable.toWeb(fs.createReadStream(filePath, { start, end }))
      return new Response(stream, { status, headers })
    } catch (err) {
      return new Response(`媒体读取失败:${(err && err.message) || String(err)}`, { status: 500 })
    }
  })
}

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

// 多媒体库视频导入:系统对话框选视频文件 → 返回 [{path, name, size}]
// (视频库是路径引用,浏览器 File 无绝对路径,必须主进程 dialog;
// 2026-08-08 多媒体库面板)
ipcMain.handle('app:pick-media-files', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '导入视频到多媒体库',
    filters: [{ name: '视频文件', extensions: ['mp4', 'm4v', 'mov', 'webm'] }],
    properties: ['openFile', 'multiSelections'],
  })
  if (canceled || filePaths.length === 0) return []
  return await Promise.all(
    filePaths.map(async (p) => {
      const stat = await fsPromises.stat(p).catch(() => null)
      return { path: p, name: path.basename(p), size: stat?.size ?? 0 }
    }),
  )
})

// Agent 工具清单(safeHandle 注册:名称/描述/参数 schema,供 UI 工具列表
// 视图展示;异步:内置工具 + MCP 服务工具(未连接的服务启动失败即跳过)
// + 技能)

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
  getSummaryAgent().summarize(asArray(messages)),
)

// 心理揣测(紧凑态文字区展示):独立 Sub Agent 根据当前对话揣测
// LLM 回复时的心态(≤10 汉字俏皮话);与总结/主对话引擎均隔离,
// 失败返回空串由渲染端回退标题/回复预览
ipcMain.handle('agent:mind-guess', (_event, messages) =>
  getMindAgent().guess(asArray(messages)),
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
        // 多媒体库(2026-08-08):图片/音频/视频三库,渲染端展开岛体进入
        label: '多媒体库…',
        click: () => {
          showWindow()
          win?.webContents.send('widget:open-media-library')
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
    // Windows 通知 AppUserModelID(Bug 修复 2026-08-07):不设置的话
    // new Notification().show() 静默失败——右下角不弹(实测:主动陪伴
    // 心理嘀咕从未出现;evolution/notify 的通知同样受影响)。必须与
    // 打包后 electron-builder 的 appId 一致(无 build.appId 配置时用固定值)
    app.setAppUserModelId('com.dynamic-island.widget')
    // 本地媒体流式播放协议(特权注册在 ready 前,handler 在此挂载)
    registerIslandMediaProtocol()
    createWindow()
    createTray()
    startBridge()
  })

  app.on('before-quit', () => {
    quitting = true
    // 防抖中的 settings 写立即落盘(退出瞬间的 mode/配置修改不丢)
    flushSettings()
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
