import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { DynamicIsland } from '../src/components/DynamicIsland'
import { useSystemMedia } from '../src/hooks/useSystemMedia'
import { useIslandMedia } from '../src/hooks/useIslandMedia'
import {
  useBackgroundStore,
  useCustomTheme,
  useFontStore,
  useHint,
} from '../src/hooks/useIslandCustomizations'
import { PLAY_MODES } from '../src/media/playbackModes'
import type { PanelView } from '../src/components/DynamicIsland/layout'
import { useMediaPlayer } from '../src/media/useMediaPlayer'
import type { AgentPanelProps } from '../src/agent/types'
import { useAgent } from '../src/hooks/useAgent'
import { registerIslandSettingsBridge } from '../src/settingsBridge'

/** Agent 模式的岛体强调色(自定义主题色未设置时使用) */
const AGENT_THEME = '#4d6bfe'
/** 模式切换:收起岛体动画时长(ms),动画完成后再切换数据源 */
const MODE_SWITCH_ANIMATE_MS = 420
/** 模式 localStorage 镜像键(启动瞬间避免闪错模式,权威值在主进程 settings.json) */
const MODE_STORAGE_KEY = 'widget-mode'

// THEME_STORAGE_KEY 从 src/settingsBridge 导入(设置桥与 UI 共用同一键)
/** 挂件窗口常规宽度(与 electron/main.cjs 的 WINDOW_W 一致) */
const WINDOW_W = 520
/** 挂件窗口常规高度(与 electron/main.cjs 的 WINDOW_H 一致) */
const WINDOW_H = 280
/** 背景编辑器视图的窗口高度(岛体加高到 440 + 余量) */
const BG_VIEW_WINDOW_H = 480
/** 帮助手册视图窗口尺寸:岛体 800×640(缩放 200% 的大小)+ 余量 */
const HELP_WIN_W = 820
const HELP_VIEW_WINDOW_H = 680
/**
 * 视图 → 窗口高度映射(岛体高度 + 顶部 8px 定位余量 + 缓冲):
 * 背景编辑器 / 库页面用大面板(480);自定义颜色页 352px 岛体
 * (SV 取色面需要高度),非常规高度需在此登记
 */
// 键类型 = PanelView(拼错键由编译器兜底,审计 P2)
const VIEW_WINDOW_H: Partial<Record<PanelView, number>> = {
  background: BG_VIEW_WINDOW_H,
  'font-library': BG_VIEW_WINDOW_H,
  'image-library': BG_VIEW_WINDOW_H,
  'font-color': 364,
  theme: 364,
  help: HELP_VIEW_WINDOW_H,
  // 设置视图与歌词 API 视图(2026-08-07 用户要求增高):岛体 440
  // 大面板 + 余量,与背景编辑器/库页面同款窗口高
  settings: BG_VIEW_WINDOW_H,
  'lyric-api': BG_VIEW_WINDOW_H,
  // Agent 聊天面板:高度内容自适应(下限 240),窗口由 onAgentPanelHeight
  // 动态跟随(岛体 + 40 余量);VIEW_WINDOW_H 无需登记(回落 WINDOW_H)
  // Agent 设置表单(API Key / 模型 / 系统提示词;岛体 540 + 余量,
  // 原 440/500 仍太扁,用户要求继续增高)
  'agent-settings': 580,
}

// 背景参数读写(不透明度/裁切)抽在 backgroundStore 共享 —— 与设置桥
// 同一实现,旧版单数值/单独键迁移行为两端一致(初始状态 + 事件重读共用)

/**
 * 桌面挂件版灵动岛:
 * 只渲染灵动岛本体(无演示页面),数据源与完整版一致——
 * 系统媒体监听(SMTC)优先,本地播放器兜底。
 *
 * 鼠标穿透由 stage 容器(岛体 + 展开面板)的 mouseenter/leave 驱动,
 * 事件冒泡不受组件内部 hover 屏蔽影响:进入岛体才接收鼠标,离开立即穿透,
 * 展开面板期间移出也能可靠恢复(修复"面板收不回来"的卡死感)。
 * 移动挂件:右键长按(~0.4s)进入拖拽模式后拖动(主进程按屏幕工作区
 * 钳制,不会拖出桌面);快速右键点击/快速右键拖动不做任何事。
 */
export default function WidgetApp() {
  const player = useMediaPlayer()
  const system = useSystemMedia()
  // 当前模式:音乐播放器 ↔ Agent(权威值在主进程 settings.json,经 IPC 同步;
  // localStorage 仅作启动瞬间的快速回显;声明在 useAgent 之前——主动陪伴
  // 需要按模式决定是否允许调度器触发)
  const [mode, setMode] = useState<'music' | 'agent'>(() => {
    try {
      return localStorage.getItem(MODE_STORAGE_KEY) === 'agent' ? 'agent' : 'music'
    } catch {
      return 'music'
    }
  })
  // Agent 模式(托盘右键切换):状态/消息/流式累积/发送/中止/配置
  // 主动陪伴(2026-08-07):仅在 Agent 模式允许调度器触发(音乐模式
  // 下主动对话没有语义;主进程 currentMode 再兜底)
  const agent = useAgent({ allowProactive: mode === 'agent' })
  // 定制状态(主题色/提示/背景图+图片库/字体库)与媒体数据源派生统一走
  // 双宿主共享 hook(与 Web 演示版同一实现;原 ~400 行逐字重复已收敛,
  // 2026-08-06 架构优化;LLM 设置工具的即时重读也收进各 hook)
  const { hint, showHint } = useHint()
  const { customTheme, applyCustomTheme } = useCustomTheme()
  const {
    background,
    backgroundCropProp,
    handleBackgroundChange,
    imageLibrary,
    handleImageLibraryChange,
  } = useBackgroundStore()
  const {
    font,
    fontLibrary,
    fontColorProp,
    handleFontLibraryChange,
    handleFontAdd,
    handleFontSelect,
    handleFontColorChange,
    handleFontWeightChange,
  } = useFontStore()
  const {
    handleToggleSource,
    externalActive,
    externalMode,
    lyricsData,
    islandState,
    islandTrack,
    islandPosition,
    islandDuration,
    islandPrev,
    islandNext,
    islandToggle,
    handleCycleMode,
    islandSeek,
  } = useIslandMedia({ player, system, showHint })
  // 待应用模式(托盘切换请求):先收起岛体动画完成,再真正切换数据源,
  // 避免"Agent 面板瞬间消失 + 尺寸突变"造成的 UI 变形错乱。
  // source:切换来源('tool' = Agent 工具 switch_to_music)——工具触发的
  // 切换属于对话流程,应用模式后**不中止**正在运行的本轮(见下方 effect)
  const [pendingMode, setPendingMode] = useState<{
    mode: 'music' | 'agent'
    source: 'user' | 'tool'
  } | null>(null)
  // 最近一次应用的模式切换来源(供"切回音乐是否中止 Agent 轮次"判定;
  // 默认 'user':启动/手势/托盘均为用户主动)
  const lastModeSourceRef = useRef<'user' | 'tool'>('user')
  // 订阅托盘切换(进入待应用队列)+ 启动时向主进程确认持久化模式(直接应用)
  useEffect(() => {
    window.desktop?.onSetMode?.((payload) => setPendingMode(payload))
    window.desktop?.getMode?.().then((persisted) => {
      setMode(persisted)
      try {
        localStorage.setItem(MODE_STORAGE_KEY, persisted)
      } catch {
        // 忽略存储失败
      }
    })
  }, [])
  // 模式切换:收起岛体(当前模式数据保留到动画完成)→ 切换数据源 + 重置窗口
  const [collapseSeq, setCollapseSeq] = useState(0)
  useEffect(() => {
    if (!pendingMode || pendingMode.mode === mode) return
    setCollapseSeq((s) => s + 1)
    const timer = window.setTimeout(() => {
      lastModeSourceRef.current = pendingMode.source
      setMode(pendingMode.mode)
      setPendingMode(null)
      try {
        localStorage.setItem(MODE_STORAGE_KEY, pendingMode.mode)
      } catch {
        // 忽略存储失败
      }
      // 音乐 → Agent:自动暂停当前播放的音频(外部平台或本地播放器),
      // 避免切到 Agent 模式后声音继续;切回音乐时不自动恢复,
      // 由用户手动继续(与数据源切换的"双向暂停"约定一致)。
      // externalActive 为切换前(音乐模式)的值,闭包捕获正确
      if (pendingMode.mode === 'agent') {
        if (externalActive) void system.control('pause')
        else player.pause()
      }
      window.desktop?.setWindowSize?.(WINDOW_W, WINDOW_H)
    }, MODE_SWITCH_ANIMATE_MS)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- externalActive/system/player 取切换前状态即可
  }, [pendingMode, mode])
  // 切回音乐模式时中止正在运行的 Agent 轮次——但 **工具触发**的切换除外
  // (switch_to_music 属于对话流程:中止会把最终回复一并丢弃,历史停在
  // 未答复的用户消息;下一轮 LLM 把旧请求当"仍待执行"重复执行,造成
  // 上下文污染,实测"打开B站"时又被自动切回音乐模式)。工具触发的
  // 切换让引擎完成本轮,回复正常落定,回到 Agent 模式气泡还在。
  // 用户主动切换(托盘/手势,source='user')保持中止语义不变
  useEffect(() => {
    if (
      mode === 'music' &&
      lastModeSourceRef.current !== 'tool' &&
      (agent.status === 'thinking' || agent.status === 'running')
    ) {
      agent.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])
  // 托盘菜单请求打开设置:seq 递增触发岛内展开并切换视图
  // (背景 / 帮助手册 / 主题色从设置视图内部进入,无独立外部入口)。
  // 订阅返回取消函数,cleanup 注销(preload 实际返回;修复前类型声明为
  // void 导致订阅未清理,StrictMode 双挂载下回调翻倍,审计 P1-2)
  const [settingsSeq, setSettingsSeq] = useState(0)
  useEffect(() => {
    return window.desktop?.onOpenSettings?.(() => setSettingsSeq((s) => s + 1))
  }, [])
  // 初次安装引导:主进程检测到首启 → 自动展开并进入帮助手册
  const [helpSeq, setHelpSeq] = useState(0)
  useEffect(() => {
    return window.desktop?.onOpenHelp?.(() => setHelpSeq((s) => s + 1))
  }, [])
  // Agent 面板视觉尺寸(内容自适应 × 界面缩放):窗口 = 岛体 + 余量。
  // 高度不设死区:高度动画每帧上报(≥1px 变化),窗口逐帧跟随平滑无台阶;
  // 宽度保留 4px 死区(缩放变化低频,防重复调用)。
  // 声明在 handlePanelViewChange 之前(agent-settings 视图宽度沿用此值)
  const lastAgentWindowSize = useRef({ w: 0, h: 0 })
  // 高空间视图(背景编辑器 / 库页面 / 自定义颜色页)按映射同步调整
  // 窗口高度,离开回落常规高度与宽度(520)
  const handlePanelViewChange = useCallback((view: PanelView) => {
    // Agent 设置视图(Bug 修复 2026-08-07):宽度沿用 Agent 面板当前窗口
    // 宽(缩放机制经 onAgentPanelSize 上报维护)——一律拉回 520 会把缩放
    // 后的岛体(展开宽 × 缩放,300% 时 1200px)裁成"矩形 + UI 没加载全"
    // (实测:窗口 522×580,岛体被窗口裁剪)
    const width =
      view === 'agent-settings'
        ? lastAgentWindowSize.current.w || WINDOW_W
        : view === 'help'
          ? HELP_WIN_W
          : WINDOW_W
    // Agent 设置视图(2026-08-07 用户要求"参考 Agent 展开的先变宽再变长
    // 动画"):高度由 Agent 面板高度动画逐帧跟随(onAgentPanelSize 从当前
    // 显示高度滑升到 580,窗口与岛体形变同步)——瞬设高度会"窗口先就位、
    // 岛体还在长",底部露出空隙割裂;这里只同步宽度,高度保持当前
    if (view === 'agent-settings') {
      window.desktop?.setWindowSize?.(width, window.innerHeight)
      return
    }
    window.desktop?.setWindowSize?.(width, VIEW_WINDOW_H[view] ?? WINDOW_H)
  }, [])
  const handleAgentPanelSize = useCallback((width: number, height: number) => {
    const w = Math.round(width + 40)
    const h = Math.round(height + 40)
    const last = lastAgentWindowSize.current
    if (Math.abs(w - last.w) < 4 && h === last.h) return
    last.w = w
    last.h = h
    window.desktop?.setWindowSize?.(w, h)
  }, [])
  // 缩放即时反馈:宽度变化立即跟随(高度保持当前窗口,由视图回调管理)
  const handleAgentPanelWidth = useCallback((width: number) => {
    const w = Math.round(width + 40)
    const last = lastAgentWindowSize.current
    if (Math.abs(w - last.w) < 4) return
    last.w = w
    window.desktop?.setWindowSize?.(w, window.innerHeight)
  }, [])
  // 注册设置桥(LLM 设置工具入口;Web 演示版无主进程工具调用,不注册;
  // 设置变更事件的即时重读已收进 useIslandCustomizations 各 hook;
  // 外部模式同步/循环/seek 已收进 useIslandMedia 共享 hook)
  useEffect(() => {
    registerIslandSettingsBridge()
  }, [])

  // Agent 模式文字区左滑/右滑:退出 Agent 切回音乐模式
  // (经主进程持久化 + 托盘菜单同步,与托盘切换同一链路)
  const handleAgentSwipeToMusic = useCallback(() => {
    window.desktop?.setMode?.('music')
  }, [])
  // 音乐模式文字区三连击:切入 Agent 模式(与左滑/右滑退出对称)
  const handleAgentTripleClick = useCallback(() => {
    window.desktop?.setMode?.('agent')
  }, [])

  // 主题色:自定义 > 播放模式色 > 状态色(组件内);Agent 模式用专属强调色
  const mediaTheme = externalActive
    ? PLAY_MODES[externalMode].color
    : islandState === 'playing' || islandState === 'idle'
      ? PLAY_MODES[player.mode].color
      : null
  const islandTheme = customTheme ?? (mode === 'agent' ? AGENT_THEME : mediaTheme)

  // Agent 面板 props(memo 保持引用稳定,配合 DynamicIsland(React.memo))。
  // 先解构字段再入依赖:exhaustive-deps 对 agent 整对象访问会要求把
  // 整个对象入依赖(每次渲染新对象 → memo 恒失效),按字段解构后
  // 依赖列表精确且稳定
  const {
    status: agentStatus,
    messages: agentMessages,
    streaming: agentStreaming,
    lastError: agentLastError,
    pendingConfirm: agentPendingConfirm,
    confirmTool: agentConfirmTool,
    sessions: agentSessions,
    loadSession,
    deleteSession,
    tools: agentTools,
    currentTitle,
    mindGuess,
    send: agentSend,
    abort: agentAbort,
    clear: agentClear,
    saveConfig: agentSaveConfig,
    config: agentConfig,
  } = agent
  // agentConfig 引用必须稳定:内联对象字面量每次渲染都是新引用,会击穿
  // DynamicIsland 的 memo(1827 行巨型组件在流式期间被整树重渲染)。
  // tools 不再走此通道(审计 P1 #4:双通道冗余,统一由 AgentPanelProps.tools
  // 进入——设置视图从 agent prop 取,同一 useAgent.tools 单一来源)
  const agentConfigProp = useMemo(
    () => ({
      config: agent.config,
      onSave: agent.saveConfig,
      onRefresh: agent.refreshConfig,
    }),
    [agent.config, agent.saveConfig, agent.refreshConfig],
  )
  const agentPanelProps: AgentPanelProps | undefined = useMemo(
    () =>
      mode === 'agent'
        ? {
            status: agentStatus,
            messages: agentMessages,
            streaming: agentStreaming,
            lastError: agentLastError,
            sessions: agentSessions,
            onLoadSession: loadSession,
            onDeleteSession: deleteSession,
            tools: agentTools,
            currentTitle,
            mindGuess,
            onSend: agentSend,
            onAbort: agentAbort,
            onClear: agentClear,
            // 工具列表视图禁用/恢复(持久化 settings.json agent 段;
            // 引擎每轮实时读配置,下一轮生效)
            excludedTools: agentConfig?.excludedTools ?? [],
            onExcludedToolsChange: (names) => agentSaveConfig({ excludedTools: names }),
            pendingConfirm: agentPendingConfirm,
            onConfirmTool: agentConfirmTool,
          }
        : undefined,
    [
      mode,
      agentStatus,
      agentMessages,
      agentStreaming,
      agentLastError,
      agentSessions,
      loadSession,
      deleteSession,
      agentTools,
      currentTitle,
      mindGuess,
      agentSend,
      agentAbort,
      agentClear,
      agentConfig?.excludedTools,
      agentSaveConfig,
      agentConfirmTool,
      agentPendingConfirm,
    ],
  )

  // 鼠标穿透:stage(岛体+展开面板)内接收鼠标,离开立即穿透。
  // 用 stage 容器而非组件 onHoverChange:组件展开期间屏蔽自己的 hover 事件,
  // 但 mouseenter/leave 仍会冒泡到父容器,穿透状态不会粘滞
  const handleStageEnter = useCallback(() => {
    window.desktop?.pointer(true)
  }, [])
  const handleStageLeave = useCallback(() => {
    // 拖拽中不关闭穿透:鼠标可能已移出岛体(如窗口被屏幕边缘钳制),
    // 窗口仍需接收指针事件(依赖指针捕获持续送达)
    if (dragRef.current?.dragging) return
    window.desktop?.pointer(false)
  }, [])
  // 兜底:鼠标移出窗口(forward 模式下 leave 可能丢失)
  const handleRootMouseLeave = useCallback(() => {
    if (dragRef.current?.dragging) return
    window.desktop?.pointer(false)
  }, [])

  // 右键长按拖拽移动挂件:按住右键 400ms 内不移动(位移 < 阈值)
  // 进入拖拽模式,之后拖动窗口跟随鼠标——长按区分"快速右键拖动",
  // 那不做任何事。配合指针捕获,拖拽期间即使鼠标移出岛体/窗口
  // (屏幕边缘钳制场景)事件仍持续送达(OS 捕获 + 穿透保持接收),
  // 松手后按指针实际位置恢复穿透状态
  const DRAG_HOLD_MS = 400
  const DRAG_HOLD_SLOP_PX = 8
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    /** 拖拽激活基准:长按期间实时更新,激活时以最新位置为基准
     *  (避免"按下点与指针"的固定偏移——长按期间的手抖) */
    actX: number
    actY: number
    timer: number
    dragging: boolean
    lastX: number
    lastY: number
  } | null>(null)

  const handleDragPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 2) return
    // 自愈:若此前丢失 pointerup 残留拖拽状态,先清掉
    const prev = dragRef.current
    if (prev) window.clearTimeout(prev.timer)
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const startX = event.screenX
    const startY = event.screenY
    // 起点坐标异常(合成/边缘事件)不进入长按,避免把 NaN 传给主进程
    if (!Number.isFinite(startX) || !Number.isFinite(startY)) return
    dragRef.current = {
      pointerId: event.pointerId,
      startX,
      startY,
      actX: startX,
      actY: startY,
      timer: window.setTimeout(() => {
        const drag = dragRef.current
        if (!drag || drag.pointerId !== event.pointerId) return
        // 长按成立:进入拖拽模式,以长按期间的最新位置为基准
        drag.dragging = true
        window.desktop?.dragStart(drag.actX, drag.actY)
      }, DRAG_HOLD_MS),
      dragging: false,
      lastX: startX,
      lastY: startY,
    }
  }, [])

  // 拖拽合帧:pointermove 可达 125Hz+,主进程 setPosition/getPosition 是
  // 同步 OS 往返——每帧至多发送一次 IPC(最后一次坐标),跟手无感知
  const dragRafRef = useRef(0)
  const dragPendingRef = useRef<{ x: number; y: number } | null>(null)

  const handleDragPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || event.pointerId !== drag.pointerId) return
    if (!Number.isFinite(event.screenX) || !Number.isFinite(event.screenY)) return
    if (!drag.dragging) {
      // 长按期间轻微移动(阈值内):更新激活基准,拖拽开始时以最新位置
      // 为准,消除"按下点与指针"的固定偏移
      drag.actX = event.screenX
      drag.actY = event.screenY
      // 长按成立前移动超阈值:取消(快速右键拖动不生效)
      if (
        Math.hypot(event.screenX - drag.startX, event.screenY - drag.startY) >
        DRAG_HOLD_SLOP_PX
      ) {
        window.clearTimeout(drag.timer)
        dragRef.current = null
      }
      return
    }
    // 窗口移动后 Chromium 合成坐标相同/亚像素差异的指针事件:
    // 与上次发送坐标偏差 < 0.5px 的一律丢弃,阻断自移动正反馈与抖动
    // (真实位移由主进程 Math.round 吸收,亚像素移动本就无效果)
    if (
      Math.abs(event.screenX - drag.lastX) < 0.5 &&
      Math.abs(event.screenY - drag.lastY) < 0.5
    ) {
      return
    }
    drag.lastX = event.screenX
    drag.lastY = event.screenY
    // rAF 合帧:本帧内后续事件只更新待发坐标,不重复 IPC
    dragPendingRef.current = { x: event.screenX, y: event.screenY }
    if (!dragRafRef.current) {
      dragRafRef.current = requestAnimationFrame(() => {
        dragRafRef.current = 0
        const p = dragPendingRef.current
        dragPendingRef.current = null
        if (p) window.desktop?.dragMove(p.x, p.y)
      })
    }
  }, [])

  const handleDragPointerEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || event.pointerId !== drag.pointerId) return
    window.clearTimeout(drag.timer)
    dragRef.current = null
    if (!drag.dragging) return
    // 松手:未发送的合帧坐标先发出(窗口落点 = 最后指针位置),再结束
    if (dragRafRef.current) cancelAnimationFrame(dragRafRef.current)
    dragRafRef.current = 0
    const pending = dragPendingRef.current
    dragPendingRef.current = null
    if (pending) window.desktop?.dragMove(pending.x, pending.y)
    window.desktop?.dragEnd()
    // 拖拽期间穿透保持接收鼠标;结束后按指针实际位置恢复
    // (指针已移出岛体则立即恢复穿透,避免残留"接收"状态)
    const el = document.elementFromPoint(event.clientX, event.clientY)
    window.desktop?.pointer(el !== null && event.currentTarget.contains(el))
  }, [])

  // 卸载时清理右键长按计时器与拖拽合帧
  useEffect(
    () => () => {
      const drag = dragRef.current
      if (drag) window.clearTimeout(drag.timer)
      if (dragRafRef.current) cancelAnimationFrame(dragRafRef.current)
    },
    [],
  )

  return (
    <div className="widget-root" onMouseLeave={handleRootMouseLeave}>
      <div
        className="widget-stage"
        onMouseEnter={handleStageEnter}
        onMouseLeave={handleStageLeave}
        onContextMenu={(event) => event.preventDefault()}
        onPointerDown={handleDragPointerDown}
        onPointerMove={handleDragPointerMove}
        onPointerUp={handleDragPointerEnd}
        onPointerCancel={handleDragPointerEnd}
      >
        <DynamicIsland
          state={islandState}
          track={islandTrack}
          agent={agentPanelProps}
          agentConfig={agentConfigProp}
          position={islandPosition}
          duration={islandDuration}
          onSeek={externalActive ? islandSeek : player.seek}
          onSwipeLeft={islandPrev}
          onSwipeRight={islandNext}
          onAgentSwipeToMusic={handleAgentSwipeToMusic}
          onAgentTripleClick={handleAgentTripleClick}
          onTextDoubleClick={islandToggle}
          mode={externalActive ? externalMode : player.mode}
          onCycleMode={handleCycleMode}
          themeColor={islandTheme ?? undefined}
          systemActive={externalActive}
          systemPlatform={externalActive ? system.platform : undefined}
          onToggleSource={system.active && system.track ? handleToggleSource : undefined}
          modeSupported={system.modeSupported}
          lyrics={lyricsData}
          playlist={!externalActive ? player.tracks : undefined}
          playlistIndex={!externalActive ? player.index : undefined}
          onPlayTrack={!externalActive ? player.playIndex : undefined}
          onTogglePlay={externalActive ? islandToggle : player.toggle}
          onUploadTracks={!externalActive ? player.addTracks : undefined}
          onRemoveTrack={!externalActive ? player.removeTrack : undefined}
          theme={customTheme}
          onThemeChange={applyCustomTheme}
          hint={hint}
          backgroundExpandedImage={background.expandedImage}
          backgroundCompactImage={background.compactImage}
          backgroundOpacity={background.opacity}
          backgroundCrop={backgroundCropProp}
          onBackgroundChange={handleBackgroundChange}
          requestSettingsSeq={settingsSeq}
          requestHelpSeq={helpSeq}
          onPanelViewChange={handlePanelViewChange}
          onAgentPanelSize={handleAgentPanelSize}
          onAgentPanelWidth={handleAgentPanelWidth}
          collapseSeq={collapseSeq}
          fontLibrary={fontLibrary}
          currentFontId={font.currentFontId}
          fontColor={fontColorProp}
          onFontAdd={handleFontAdd}
          onFontLibraryChange={handleFontLibraryChange}
          onFontSelect={handleFontSelect}
          onFontColorChange={handleFontColorChange}
          fontWeight={font.weight}
          onFontWeightChange={handleFontWeightChange}
          imageLibrary={imageLibrary}
          onImageLibraryChange={handleImageLibraryChange}
        />
      </div>
    </div>
  )
}
