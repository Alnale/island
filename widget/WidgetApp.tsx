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
import { inferAudioType } from '../src/media/uploadStore'
import { resolveMediaSrc } from '../src/components/DynamicIsland/views/Markdown'
import type { AgentPanelProps } from '../src/agent/types'
import { useAgent } from '../src/hooks/useAgent'
import {
  MEDIA_WINDOW_STORAGE_KEY,
  onMediaLibraryPlay,
  onSettingsChange,
  registerIslandSettingsBridge,
  readMediaWindowWidth,
} from '../src/settingsBridge'
import {
  genLibraryId,
  loadAudioLibrary,
  loadVideoLibrary,
  saveAudioItems,
  saveVideoItems,
  type AudioLibraryItem,
  type VideoLibraryItem,
} from '../src/media/libraryStore'

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
  // 帮助手册视图已移除(2026-08-10 用户要求)
  // 设置视图与歌词 API 视图(2026-08-07 用户要求增高):岛体 440
  // 大面板 + 余量,与背景编辑器/库页面同款窗口高
  settings: BG_VIEW_WINDOW_H,
  'lyric-api': BG_VIEW_WINDOW_H,
  // Agent 聊天面板:高度内容自适应(下限 240),窗口由 onAgentPanelHeight
  // 动态跟随(岛体 + 40 余量);VIEW_WINDOW_H 无需登记(回落 WINDOW_H)
  // Agent 设置表单(API Key / 模型 / 系统提示词;岛体 540 + 余量,
  // 原 440/500 仍太扁,用户要求继续增高)
  'agent-settings': 580,
  // 多媒体库(2026-08-08 独立菜单,Agent 设置面板大小:岛体 540 + 余量;
  // 此前未登记 → 窗口停在 280,岛体底部被窗口裁切 = "UI 底部截断" bug)
  'media-library': 580,
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
      setWinSize(WINDOW_W, WINDOW_H)
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
  // 全屏状态(2026-08-08 用户要求"全屏时右键拖拽移动窗口,不退出全屏、
  // 不越来越大"):全屏层 = 100% viewport,窗口任何 setWindowSize 都会
  // 让全屏层跟随 resize 放大(实测"全屏界面越来越大"的根因)——全屏
  // 期间**暂停窗口尺寸跟随**(移动窗口的 setPosition 不受影响,全屏层
  // 跟随窗口移动是标准行为);退出全屏恢复
  const fullscreenRef = useRef(false)
  useEffect(() => {
    const onChange = () => {
      const el = document.fullscreenElement
      fullscreenRef.current = Boolean(el)
      // 上报主进程:全屏期间主进程兜底忽略 set-size(渲染端守卫之外的
      // 漏网路径也能被拦下,防全屏层跟随窗口 resize 放大)。
      // **全屏范围区分(2026-08-10 用户要求)**:全屏元素在媒体岛
      // (.island-agent-mini)内 = 视频岛/图片岛全屏 → 主进程放大窗口到
      // 显示器(真全屏);对话窗口内媒体(消息气泡)全屏 → 只覆盖 Agent
      // 对话窗口,不放大窗口
      const inMini = !!el?.closest?.('.island-agent-mini')
      window.desktop?.setFullscreen?.(fullscreenRef.current, inMini)
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])
  /** 窗口尺寸变更统一出口:全屏中跳过(防全屏层被窗口 resize 放大) */
  const setWinSize = useCallback((w: number, h: number) => {
    if (fullscreenRef.current) return
    window.desktop?.setWindowSize?.(w, h)
  }, [])

  // Agent 面板视觉尺寸(内容自适应 × 界面缩放):窗口 = 岛体 + 余量。
  // 高度不设死区:高度动画每帧上报(≥1px 变化),窗口逐帧跟随平滑无台阶;
  // 宽度保留 4px 死区(缩放变化低频,防重复调用)。
  // 声明在 handlePanelViewChange 之前(agent-settings 视图宽度沿用此值)
  const lastAgentWindowSize = useRef({ w: 0, h: 0 })
  // mode 的最新值(ref:handlePanelViewChange 是稳定回调,effect 内读最新)
  const modeRef = useRef(mode)
  useEffect(() => {
    modeRef.current = mode
  }, [mode])
  // 高空间视图(背景编辑器 / 库页面 / 自定义颜色页)按映射同步调整
  // 窗口高度,离开回落常规高度与宽度(520)。
  // 帮助手册已移除(2026-08-10 用户要求),无 help 分支
  const handlePanelViewChange = useCallback((view: PanelView) => {
    // 视图宽度:
    // - agent-settings:沿用 Agent 面板当前窗口宽(缩放机制经
    //   onAgentPanelSize 上报维护)——一律拉回 520 会把缩放后的岛体
    //   (展开宽 × 缩放,300% 时 1200px)裁成"矩形 + UI 没加载全"
    //   (Bug 修复 2026-08-07,实测:窗口 522×580,岛体被窗口裁剪);
    // - **Agent 模式下所有展开视图岛体宽 = 展开宽 × 界面缩放**
    //   (DynamicIsland 宽度 agentActive 分支),设置/背景/主题/字体等
    //   非 agent 视图的窗口必须同步按 Agent 面板宽保持——拉回 520 会
    //   窗口(520)比岛体(1200)窄被裁切,位置补偿右移 361px 后设置
    //   面板缩在右侧(2026-08-08 实测:agent-settings 返回 settings,
    //   面板显示在原窗口右侧);
    const width =
      view === 'agent-settings'
        ? lastAgentWindowSize.current.w || WINDOW_W
        : modeRef.current === 'agent'
          ? lastAgentWindowSize.current.w || WINDOW_W
          : WINDOW_W
    // Agent 设置视图(2026-08-07 用户要求"参考 Agent 展开的先变宽再变长
    // 动画"):高度由 Agent 面板高度动画逐帧跟随(onAgentPanelSize 从当前
    // 显示高度滑升到 580,窗口与岛体形变同步)——瞬设高度会"窗口先就位、
    // 岛体还在长",底部露出空隙割裂;这里只同步宽度,高度保持当前
    if (view === 'agent-settings') {
      setWinSize(width, window.innerHeight)
      return
    }
    setWinSize(width, VIEW_WINDOW_H[view] ?? WINDOW_H)
  }, [setWinSize])
  const handleAgentPanelSize = useCallback((width: number, height: number) => {
    const w = Math.round(width + 40)
    const h = Math.round(height + 40)
    const last = lastAgentWindowSize.current
    if (Math.abs(w - last.w) < 4 && h === last.h) return
    last.w = w
    last.h = h
    setWinSize(w, h)
  }, [setWinSize])
  // 缩放即时反馈:宽度变化立即跟随(高度保持当前窗口,由视图回调管理)
  const handleAgentPanelWidth = useCallback((width: number) => {
    const w = Math.round(width + 40)
    const last = lastAgentWindowSize.current
    if (Math.abs(w - last.w) < 4) return
    last.w = w
    setWinSize(w, window.innerHeight)
  }, [setWinSize])
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
  // Agent 音频移交(2026-08-09 修复"收起切音乐模式后没正常播放"):
  // 收起面板时对话音频接进本地播放器继续播——fetch 音频源 → File →
  // addTracks(自动播放首曲,持久化进播放列表)→ 切音乐模式。失败也
  // 切模式(至少不卡在 Agent 模式)。
  // **URL 归一化只做一次(2026-08-09 五轮修复"仍没加载播放"根因)**:
  // 上报 src 的形态不统一——MediaFrame 挂载上报原始路径、VoiceBubble
  // 播放上报**已解析的协议 URL**(island-media://local/...);若对已
  // 解析 URL 再 resolveMediaSrc 会双重编码
  // (island-media://local/island-media%3A%2F%2Flocal%2F...) → 协议
  // 解码后路径非真实文件 → fetch 404 → 静默降级只切模式(播放中的
  // 音频恰好走播放上报 = 已解析形态,实测一直失败)。已含协议/URL
  // 前缀的直接用,裸路径才解析
  const handleAgentAudioHandoff = useCallback(
    (audio: { src: string; name?: string }) => {
      const name = audio.name || '对话音频'
      void (async () => {
        try {
          const url = /^(https?:|data:|blob:|island-media:)/i.test(audio.src)
            ? audio.src
            : resolveMediaSrc(audio.src)
          const res = await fetch(url)
          if (!res.ok) throw new Error(`fetch ${res.status}`)
          const blob = await res.blob()
          // 临时诊断(2026-08-09 排查移交,定位后删除)
          console.log('[handoff] fetch ok, blob size:', blob.size, 'type:', blob.type)
          const file = new File([blob], name, { type: inferAudioType(name, blob.type) })
          player.addTracks([file])
        } catch (err) {
          console.error('[widget] agent audio handoff failed:', err)
        }
        window.desktop?.setMode?.('music')
      })()
    },
    [player],
  )
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
    mediaAutoPlayIds: agentMediaAutoPlayIds,
    consumeMediaAutoPlay: agentConsumeMediaAutoPlay,
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
  // 媒体窗口默认宽(2026-08-08):对话图片/视频窗口初始宽;localStorage
  // 即时生效(设置界面 QuickMenu / LLM set_media_window_size 工具写入,
  // MediaFrame 挂载时读取同一键)
  // 多媒体库(2026-08-08):音频库(ArrayBuffer)/ 视频库(路径引用),
  // 挂载时从 IndexedDB 恢复;变更写库 + setState
  const [audioLibrary, setAudioLibrary] = useState<AudioLibraryItem[]>([])
  const [videoLibrary, setVideoLibrary] = useState<VideoLibraryItem[]>([])
  useEffect(() => {
    let cancelled = false
    void loadAudioLibrary().then((items) => {
      if (!cancelled) setAudioLibrary(items)
    })
    void loadVideoLibrary().then((items) => {
      if (!cancelled) setVideoLibrary(items)
    })
    return () => {
      cancelled = true
    }
  }, [])
  const handleAudioLibraryChange = useCallback((items: AudioLibraryItem[]) => {
    setAudioLibrary(items)
    void saveAudioItems(items)
  }, [])
  const handleVideoLibraryChange = useCallback((items: VideoLibraryItem[]) => {
    setVideoLibrary(items)
    void saveVideoItems(items)
  }, [])
  // 视频导入:主进程对话框选文件 → 记录路径入库(浏览器 File 无绝对路径)
  const handleVideoImport = useCallback(() => {
    void window.desktop?.pickMediaFiles?.().then((files) => {
      if (!files || files.length === 0) return
      const items = files.map((f) => ({
        id: genLibraryId('video'),
        name: f.name.slice(0, 100),
        path: f.path,
        size: f.size,
        createdAt: Date.now(),
      }))
      setVideoLibrary((prev) => [...prev, ...items])
      void saveVideoItems([...videoLibraryRef.current, ...items])
    })
  }, [])
  const videoLibraryRef = useRef(videoLibrary)
  videoLibraryRef.current = videoLibrary
  // 托盘"多媒体库"菜单:seq 递增触发岛内展开并进入多媒体库视图
  const [mediaLibrarySeq, setMediaLibrarySeq] = useState(0)
  useEffect(() => {
    return window.desktop?.onOpenMediaLibrary?.(() => setMediaLibrarySeq((s) => s + 1))
  }, [])
  // LLM 工具 play_library_video(2026-08-10):桥派发 island:media-library-play
  // → 展开多媒体库面板 + 记下待播放视频 id(MediaLibraryView 挂载后定位
  // 自动播放;播完经 onMediaLibraryPlayConsumed 清回 null)
  const [mediaLibraryPlayId, setMediaLibraryPlayId] = useState<string | null>(null)
  useEffect(
    () =>
      onMediaLibraryPlay((id) => {
        setMediaLibraryPlayId(id)
        setMediaLibrarySeq((s) => s + 1)
      }),
    [],
  )
  // LLM 设置工具(import_audio_library 等)改库后即时重读(2026-08-08
  // 补:桥 notify mediaLibrary 但 WidgetApp 此前未监听,导入后列表
  // 不刷新,需重进面板才可见)
  useEffect(
    () =>
      onSettingsChange(['mediaLibrary'], () => {
        void loadAudioLibrary().then((items) => setAudioLibrary(items))
        void loadVideoLibrary().then((items) => setVideoLibrary(items))
      }),
    [],
  )

  // 多媒体库音频导入播放列表(2026-08-08 用户要求"导入后直接切音乐模式
  // 开始播放"):addLibraryTracks 自动播放首曲,随后经主进程切回音乐模式
  // (模式切换动画自动收起岛体,音乐在紧凑态/面板正常播放——停在多媒体
  // 库面板里"导入成功却没反应"很奇怪)
  const handleAddLibraryTracks = useCallback(
    (items: AudioLibraryItem[]) => {
      void player.addLibraryTracks(items)
      window.desktop?.setMode?.('music')
    },
    [player],
  )

  const [mediaWindowWidth, setMediaWindowWidth] = useState(() => readMediaWindowWidth())
  const handleMediaWindowWidthChange = useCallback((w: number) => {
    const clamped = Math.min(800, Math.max(160, Math.round(w)))
    try {
      localStorage.setItem(MEDIA_WINDOW_STORAGE_KEY, String(clamped))
    } catch {
      // 存储失败(隐私模式等)仍按当前值生效
    }
    setMediaWindowWidth(clamped)
  }, [])

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
            // 2026-08-10 自动播放只限"当次对话"(LLM 播放的那一轮才自动播,
            // 历史/重挂载不播):Set 引用稳定 + 消费函数
            mediaAutoPlayIds: agentMediaAutoPlayIds,
            onMediaAutoPlayed: agentConsumeMediaAutoPlay,
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
      agentMediaAutoPlayIds,
      agentConsumeMediaAutoPlay,
    ],
  )

  // 鼠标穿透:stage(岛体+展开面板)内接收鼠标,离开立即穿透。
  // 用 stage 容器而非组件 onHoverChange:组件展开期间屏蔽自己的 hover 事件,
  // 但 mouseenter/leave 仍会冒泡到父容器,穿透状态不会粘滞。
  // **lastPointerPollRef = 渲染端认为的当前穿透意图(事件与轮询共用,
  // 2026-08-10 修复"展开态点击无响应"):事件(enter/leave)改状态时同步
  // 更新,轮询据此校正——原实现 ref 只记轮询自己发的状态,展开动画/
  // hover 重算瞬间误触发 mouseleave → 穿透开,轮询 last 仍 true、
  // inside 仍 true → 永不校正 = 穿透保持开(forward 只转发 move 不转发
  // down/up → hover 正常但点击全丢,用户实测"展开态无法交互")**
  const lastPointerPollRef = useRef<boolean | null>(null)
  const handleStageEnter = useCallback(() => {
    lastPointerPollRef.current = true
    window.desktop?.pointer(true)
  }, [])
  const handleStageLeave = useCallback(() => {
    // 拖拽中不关闭穿透:鼠标可能已移出岛体(如窗口被屏幕边缘钳制),
    // 窗口仍需接收指针事件(依赖指针捕获持续送达)
    if (dragRef.current?.dragging) return
    lastPointerPollRef.current = false
    window.desktop?.pointer(false)
  }, [])
  // 兜底:鼠标移出窗口(forward 模式下 leave 可能丢失)
  const handleRootMouseLeave = useCallback(() => {
    if (dragRef.current?.dragging) return
    lastPointerPollRef.current = false
    window.desktop?.pointer(false)
  }, [])
  // 穿透轮询校正(2026-08-10 修复"清除数据后收起,鼠标悬浮/点击无响应"):
  // mouseleave → 穿透后,穿透态下 OS 不再投递鼠标事件到窗口(forward 的
  // mousemove 转发在 Windows 不可靠),鼠标移回岛体时 mouseenter 永不触发
  // = 穿透死锁(用户实测:收起后悬浮/点击无响应)。每 600ms 轮询主进程
  // 光标屏幕位置,与岛体屏幕 rect(窗口 bounds + viewport rect)核对,
  // 与 lastPointerPollRef(事件+轮询共用的意图状态)不一致即校正穿透——
  // 完全绕开事件可靠性,轮询兜底(正常 mouseenter/leave 仍走事件,
  // pointer(true/false) 幂等)。拖拽期间跳过(拖拽自己管理穿透:指针
  // 捕获持续送达)。挂载立即校正一次 + 穿透开启时 200ms 高频轮询
  // (2026-08-10:清除数据 reload 后窗口收缩把光标甩出窗口 → mouseleave
  // → 穿透开,移回岛体收不到事件,恢复延迟受轮询周期限制——高频压缩
  // 到不可感知,穿透关闭时事件流正常,600ms 低频兜底省 IPC)
  useEffect(() => {
    let stopped = false
    let timer: number | undefined
    const tick = async () => {
      if (stopped) return
      // 动态轮询周期(2026-08-10 修复"清除数据后悬浮要等更久才生效"):
      // 穿透开启 = 事件被吞的危险状态(清除数据 reload 后窗口从设置大面板
      // 收缩回 520×280,光标被甩出窗口 → mouseleave → 穿透开,移回岛体
      // 收不到任何事件,只能靠本轮询恢复)——60ms 高频轮询(200ms 实测
      // 用户仍能感知停顿,60ms 链路总延迟 ~70ms 人眼不可辨;光标停住时
      // 无任何事件可依赖,轮询周期即恢复延迟上限);穿透关闭时事件流
      // 正常,600ms 低频兜底省 IPC
      let delay = 600
      if (!dragRef.current?.dragging) {
        const info = await window.desktop?.pointerPoll?.()
        if (info) {
          const island = document.querySelector<HTMLElement>('.island-demo')
          if (island) {
            const r = island.getBoundingClientRect()
            const sx = info.bounds.x + r.left
            const sy = info.bounds.y + r.top
            const inside =
              info.cursor.x >= sx &&
              info.cursor.x <= sx + r.width &&
              info.cursor.y >= sy &&
              info.cursor.y <= sy + r.height
            // 以主进程**实际**穿透状态为准校正(2026-08-10 二轮修复:事件/
            // 轮询竞态可能让渲染端意图与主进程脱节——直接比对
            // info.ignoreMouseEvents,不一致即校正,不再依赖 last 记忆);
            // isIgnoreMouseEvents 不可用(undefined)时回退"渲染端意图"比较
            const actual =
              typeof info.ignoreMouseEvents === 'boolean'
                ? info.ignoreMouseEvents === false
                : lastPointerPollRef.current === true
            if (inside !== actual) {
              lastPointerPollRef.current = inside
              window.desktop?.pointer(inside)
            }
            delay = actual ? 600 : 60
          }
        }
      }
      timer = window.setTimeout(() => void tick(), delay)
    }
    // 挂载立即校正一次(不等第一个 600ms 周期):reload/清除数据后
    // lastPointerPollRef 为 null(回退比较得 actual=false),光标恰在岛体
    // 上时首 tick 即恢复,不拖到下一周期
    void tick()
    return () => {
      stopped = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
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
    // 全屏中拖拽(2026-08-08 用户要求"全屏时右键拖拽移动窗口,不退出
    // 全屏"):正常进入拖拽移动窗口——全屏层跟随窗口移动是标准行为;
    // "全屏界面越来越大"的根因是全屏期间窗口被 setWindowSize(布局
    // 变化触发)导致全屏层跟随 resize 放大,已由 setWinSize 全屏期间
    // 暂停尺寸变更解决,移动(setPosition)不影响全屏层尺寸
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
          onAgentAudioHandoff={handleAgentAudioHandoff}
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
          onPanelViewChange={handlePanelViewChange}
          onAgentPanelSize={handleAgentPanelSize}
          onAgentPanelWidth={handleAgentPanelWidth}
          mediaWindowWidth={mediaWindowWidth}
          onMediaWindowWidthChange={handleMediaWindowWidthChange}
          audioLibrary={audioLibrary}
          onAudioLibraryChange={handleAudioLibraryChange}
          videoLibrary={videoLibrary}
          onVideoLibraryChange={handleVideoLibraryChange}
          onAddLibraryTracks={handleAddLibraryTracks}
          onVideoImport={handleVideoImport}
          requestMediaLibrarySeq={mediaLibrarySeq}
          mediaLibraryPlayId={mediaLibraryPlayId}
          onMediaLibraryPlayConsumed={() => setMediaLibraryPlayId(null)}
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
