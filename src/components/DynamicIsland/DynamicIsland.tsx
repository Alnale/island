import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type Ref,
} from 'react'
import {
  ISLAND_STATES,
  STATE_ORDER,
  type IslandState,
  type TrackInfo,
} from '../../data/islandStates'
import { formatTime } from '../../utils/format'
import type { PlaybackMode } from '../../media/playbackModes'
import { DEFAULT_BG_CROP, type ImageLibraryItem } from '../../media/backgroundStore'
import { type FontColorMode, type FontLibraryItem } from '../../media/fontStore'
import { ParticleTime } from './ParticleTime'
import {
  AgentSettingsView,
  AgentView,
  BackgroundView,
  ControlView,
  FontColorView,
  FontLibraryView,
  FontView,
  HelpView,
  ImageLibraryView,
  ListView,
  SettingsView,
  ThemeView,
} from './views'
import type { AgentConfig, AgentPanelProps, AgentPart } from '../../agent/types'
import {
  AGENT_PANEL_MIN_H,
  BG_COMPACT_REF_H,
  BG_COMPACT_REF_W,
  BG_CROP_REF_H,
  BG_CROP_REF_W,
  COLLAPSE_HIDE_MS,
  ELLIPSIS_SLOT_PX,
  EXPANDED_MIN_WIDTH_PX,
  EXPANDED_VIEWPORT_MARGIN_PX,
  EXPANDED_WIDTH_PX,
  FADE_IN_DELAY_MS,
  FADE_IN_FAST_MS,
  FADE_IN_MS,
  FADE_OUT_MS,
  HOVER_EXTEND_PX,
  ISLAND_BASE_PX,
  LONG_PRESS_MS,
  LONG_PRESS_SLOP_PX,
  MAX_WIDTH_PX,
  MODE_ICON_MORPH_MS,
  MORPH_ANIMATE_MS,
  PROGRESS_RIGHT_MARGIN_PX,
  PROGRESS_WIDTH_PX,
  SEEK_STEP_SEC,
  SUPPRESS_CLICK_MS,
  SWIPE_THRESHOLD_PX,
  TEXT_LEFT_PX,
  TEXT_RISE_PX,
  TEXT_SWAP_MS,
  TRACK_CYCLE_MS,
  applyTextLayout,
  bgSizePctFor,
  measureNaturalWidth,
  measureTextWidth,
  truncateText,
  type PanelView,
  type TextMotion,
} from './layout'
import './DynamicIsland.css'

interface DynamicIslandProps {
  /** 当前状态(受控组件) */
  state: IslandState
  /** 当前歌曲(播放中/已暂停时传入);传入后文字显示歌名,isPlaying 才有意义 */
  track?: TrackInfo | null
  /** 播放进度(秒) */
  position?: number
  /** 总时长(秒);>0 时进度条为确定进度且可拖动/点击控制 */
  duration?: number
  /** 拖动/点击进度条或 API seekTo 时回调(秒),由外部更新播放进度 */
  onSeek?: (seconds: number) => void
  /** 点击灵动岛切换状态时回调 */
  onChange?: (next: IslandState) => void
  /** 悬停状态变化回调(供外部暂停/恢复自动演示) */
  onHoverChange?: (hovered: boolean) => void
  /** 文字区手势:左滑回调(通常切换上一首) */
  onSwipeLeft?: () => void
  /** 文字区手势:右滑回调(通常切换下一首) */
  onSwipeRight?: () => void
  /** Agent 模式:文字区左滑/右滑手势回调(通常退出 Agent 切回音乐) */
  onAgentSwipeToMusic?: () => void
  /** 音乐模式:文字区三连击回调(通常切入 Agent 模式) */
  onAgentTripleClick?: () => void
  /** 文字区双击回调(通常暂停/继续播放) */
  onTextDoubleClick?: () => void
  /** 长按展开状态变化回调(供外部暂停/恢复自动演示) */
  onExpandChange?: (expanded: boolean) => void
  /** 播放模式:决定主题色与进度条跑马灯样式(仅媒体模式传入) */
  mode?: PlaybackMode
  /** 展开面板中循环切换播放模式(顺序 → 单曲 → 随机) */
  onCycleMode?: () => void
  /** 播放/暂停态主题色(跟随播放模式),覆盖 playing/idle 的默认状态色 */
  themeColor?: string
  /** 播放列表(媒体模式传入,供展开面板列表视图) */
  playlist?: TrackInfo[]
  /** 当前播放索引(列表高亮) */
  playlistIndex?: number
  /** 系统媒体监听激活(外部平台正在播放):显示平台徽标,禁用播放模式/播放列表 */
  systemActive?: boolean
  /** 外部平台信息(徽标/主题色) */
  systemPlatform?: { id: string; label: string; color: string }
  /** 歌词数据(自动查询的 LRC 歌词:歌名/行/当前高亮索引) */
  lyrics?: {
    loading: boolean
    lyricTitle: string | null
    lines: Array<{ time: number; text: string }>
    currentIndex: number
  }
  /** 点击音乐图标:切换数据源(本地播放器 ↔ 系统监听) */
  onToggleSource?: () => void
  /** 外部平台是否支持播放模式控制(PlaybackInfo 可用);不支持时禁用模式按钮 */
  modeSupported?: boolean
  /** 播放列表点击切换 */
  onPlayTrack?: (index: number) => void
  /** 播放/暂停切换(播放列表点击当前曲目时触发) */
  onTogglePlay?: () => void
  /** 上传音频文件(文件选择回调) */
  onUploadTracks?: (files: File[]) => void
  /** 删除列表曲目(仅上传曲目) */
  onRemoveTrack?: (index: number) => void
  /** 当前自定义主题色(null = 跟随播放模式/状态色);与 onThemeChange 配合启用主题色视图 */
  theme?: string | null
  /** 选择主题色回调(null = 恢复跟随播放模式);不传则不渲染主题色按钮/视图 */
  onThemeChange?: (color: string | null) => void
  /** 操作结果提示文本:紧凑态显示在左侧文字区(与歌名同款字体),展开态显示在播放键下方;null 隐藏 */
  hint?: string | null
  /** 自定义背景图(data URL);展开态 / 紧凑态各自独立的图片,互不影响。
   *  渲染在岛体深色底之上,不透明度/裁切可调 */
  backgroundExpandedImage?: string | null
  backgroundCompactImage?: string | null
  /** 背景图不透明度(展开态 / 紧凑态各自独立,0-1) */
  backgroundOpacity?: { expanded: number; compact: number }
  /** 背景裁切参数:展开态 / 紧凑态各自独立,互不影响
   *  (缩放 1 = 铺满 cover,位置百分比 0-100,50 = 居中) */
  backgroundCrop?: {
    expanded: { zoom: number; posX: number; posY: number }
    compact: { zoom: number; posX: number; posY: number }
  }
  /** 背景变化(上传新图 / 裁切 / 调整不透明度 / 移除)。
   *  传入后启用"自定义背景"面板视图(托盘菜单入口,岛内打开) */
  onBackgroundChange?: (bg: {
    expandedImage: string | null
    compactImage: string | null
    opacity: { expanded: number; compact: number }
    expanded: { zoom: number; posX: number; posY: number }
    compact: { zoom: number; posX: number; posY: number }
  }) => void
  /** 外部请求打开设置(托盘菜单):seq 变化即展开并切换到设置视图 */
  requestSettingsSeq?: number
  /** 面板视图变化回调(宿主据此调整窗口高度:背景视图需要更高空间) */
  onPanelViewChange?: (view: PanelView) => void
  /** 面板控制区显示"设置"按钮(Web 演示入口;桌面端入口在托盘菜单) */
  settingsButton?: boolean
  /** 字体库(多字体管理,设置"字体"视图);库中 id 与 dataUrl 由宿主持久化 */
  fontLibrary?: FontLibraryItem[]
  /** 当前应用字体的 id(null = 系统默认字体) */
  currentFontId?: string | null
  /** 字体颜色设置:auto = 按背景亮度自动黑白;custom = 自定义色。
   *  传入后启用"字体"设置视图 */
  fontColor?: { mode: FontColorMode; value: string | null }
  /** 上传字体加入库(宿主负责持久化并设为当前应用) */
  onFontAdd?: (item: FontLibraryItem) => void
  /** 字体库变化(删除 / 编辑名称后的完整列表) */
  onFontLibraryChange?: (items: FontLibraryItem[]) => void
  /** 应用库中字体(id = null 恢复系统默认) */
  onFontSelect?: (id: string | null) => void
  /** 字体颜色变化(自动黑白 / 自定义色) */
  onFontColorChange?: (mode: FontColorMode, value: string | null) => void
  /** 字体粗细(400 常规 / 600 中等 / 800 粗体,单字重字体由浏览器合成加粗) */
  fontWeight?: number
  /** 字体粗细变化 */
  onFontWeightChange?: (weight: number) => void
  /** 图片库(多图管理,背景视图"图片库"入口);宿主持久化 */
  imageLibrary?: ImageLibraryItem[]
  /** 图片库变化(删除 / 编辑名称后的完整列表) */
  onImageLibraryChange?: (items: ImageLibraryItem[]) => void
  /**
   * Agent 模式(存在即激活,桌面端由托盘菜单切换):
   * 紧凑态显示 Agent 状态/回复预览,展开面板切换为聊天视图。
   * 传入后媒体数据(track/playlist 等)与手势(双击/滑动)自动让位
   */
  agent?: AgentPanelProps
  /** Agent 配置(设置视图"Agent 设置"入口;提供后设置视图显示该入口) */
  agentConfig?: {
    config: AgentConfig | null
    onSave: (patch: Partial<AgentConfig>) => void
  }
  /**
   * Agent 面板视觉尺寸变化(px,内容自适应 × 界面缩放;仅 agent 视图生效)。
   * 宿主据此同步窗口尺寸(岛体 + 余量),长高/缩放窗口跟随
   */
  onAgentPanelSize?: (width: number, height: number) => void
  /**
   * 外部请求收起岛体(宿主在模式切换等场景调用):seq 递增即收起。
   * 消除"Agent 缩放/展开状态残留进另一模式"的观感错乱
   */
  collapseSeq?: number
  /**
   * Agent 面板视觉宽度变化(px,缩放即时反馈;仅 agent 模式展开时生效)。
   * 缩放在设置视图切换时窗口宽度也要立即跟随(高度由面板视图回调管理)
   */
  onAgentPanelWidth?: (width: number) => void
  /** 对外 API(ref) */
  ref?: Ref<DynamicIslandHandle>
}

/** 灵动岛媒体快照(API 返回) */
export interface IslandSnapshot {
  state: IslandState
  /** 是否正在播放音乐(需绑定 track 才有意义) */
  isPlaying: boolean
  /** 当前歌曲,未接媒体时为 null */
  track: TrackInfo | null
  /** 当前进度(秒) */
  position: number
  /** 总时长(秒) */
  duration: number
}

/**
 * 灵动岛对外 API:监听媒体播放状态、获取歌曲信息、控制播放进度。
 * 通过 ref 获取,如 <DynamicIsland ref={api} />;
 * subscribe 订阅后,状态/歌曲/进度变化时会推送快照(监听功能)。
 */
export interface DynamicIslandHandle {
  /** 当前是否正在播放音乐 */
  isPlaying(): boolean
  /** 当前播放的歌曲,未接媒体时为 null */
  getTrack(): TrackInfo | null
  /** 当前播放进度(秒) */
  getPosition(): number
  /** 歌曲总时长(秒) */
  getDuration(): number
  /** 跳转到指定进度(秒),经 onSeek 回传外部 */
  seekTo(seconds: number): void
  /** 取当前快照 */
  snapshot(): IslandSnapshot
  /** 监听状态/歌曲/进度变化;订阅时立即推送一次,返回取消订阅函数 */
  subscribe(listener: (snap: IslandSnapshot) => void): () => void
}

/** 设置类视图:从托盘"设置"或演示"设置"按钮进入,一律屏蔽
 *  单击岛体 / 长按 / Esc / 点击面板外等一切缩回操作,只能通过返回键退出 */
/** 文字区三连击判定窗口(ms):三次点击两两间隔都在窗口内才触发 */
const TRIPLE_CLICK_WINDOW_MS = 400

const SETTINGS_VIEWS: readonly PanelView[] = [
  'settings',
  'background',
  'theme',
  'help',
  'font',
  'font-color',
  'font-library',
  'image-library',
  'agent-settings',
]
const isSettingsView = (view: string) => SETTINGS_VIEWS.includes(view as PanelView)

/**
 * Agent 模式紧凑态文案:监听 LLM 回复的完整流程。
 * - 深度思考中:thinking + 仅有 reasoning 流(无文本输出);
 * - 正在回复:thinking + 文本流已开始(流式增量实时可见);
 * - 正在执行:工具循环阶段(带当前工具名);
 * - 回复已完成:最近一条助手文本预览(岛内自动截断省略);
 * - 出错 → 提示展开查看;无回复 → 待命
 */
function agentCompactLabel(agent: AgentPanelProps): string {
  if (agent.lastError) return 'Agent 出错,展开查看'
  if (agent.status === 'thinking') {
    if (agent.streaming?.text) return '正在回复…'
    if (agent.streaming?.reasoning) return '深度思考中…'
    return '思考中…'
  }
  if (agent.status === 'running') {
    const tools = agent.streaming?.tools
    const last = tools && tools.length > 0 ? tools[tools.length - 1] : null
    return last ? `正在执行:${last.name}` : 'Agent 正在执行…'
  }
  // 回复已完成:优先显示当前对话的实时总结标题(每轮回复后静默更新),
  // 无总结时回退最近一条助手文本预览
  if (agent.currentTitle) return agent.currentTitle
  for (let i = agent.messages.length - 1; i >= 0; i--) {
    const m = agent.messages[i]
    if (m.role !== 'assistant') continue
    const texts = m.parts
      .filter((p): p is Extract<AgentPart, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
    if (texts.length > 0) return texts.join(' ')
  }
  return 'Agent 待命'
}

/** Agent 模式左侧图标:四角星(sparkles,与灵动岛线稿风格一致) */
function AgentIcon() {
  return (
    <svg
      className="island-svg"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3z" />
      <path d="M19 3v3M20.5 4.5h-3" />
    </svg>
  )
}


/** 注入 @font-face 时使用的字体族名(与岛体 font-family 应用一致) */
const CUSTOM_FONT_FAMILY = 'island-font-custom'

/**
 * 右侧文字:绑定歌曲后播放/暂停在"歌名/歌手"间循环(媒体模式),
 * 其余状态用固定文案
 */
function mediaTextFor(
  state: IslandState,
  track: TrackInfo | null | undefined,
  showArtist: boolean,
): string {
  if (track && (state === 'playing' || state === 'idle')) {
    if (showArtist) return track.artist
    return `${state === 'playing' ? '正在播放' : '已暂停'}: ${track.title}`
  }
  return ISLAND_STATES[state].text
}

/**
 * 灵动岛组件。
 *
 * 状态切换约定:
 * - 左侧图标原地切换(容器尺寸固定,不影响岛体宽度)
 * - 右侧文字上移淡出 → 换内容后藏在下方 → 宽度回弹结束后从下方上移淡入
 *   (切换期间文字不可见,宽度变化不会产生可见抖动)
 * - 非悬停:文字过长时字符截断 + 省略号
 * - 悬停:完整文字 + 进度条放得下则不渐隐,进度条从文字尾部后滑出;
 *   放不下时尾部 mask 渐隐让位,只有与进度条冲突的部分有动画
 * - 岛体仅在文字宽度变化时伸缩:JS 测量自然宽度后以 px→px 过渡触发回弹,
 *   不做整岛缩放形变,保证任何情况下不抖动
 *
 * 媒体模式(绑定 track/position/duration 后):
 * - 播放/暂停状态文字显示歌名,加载状态显示加载动画
 * - 进度条仅在媒体状态(播放/加载/暂停)出现;成功/警告/错误等通知状态
 *   悬停只抬起不展开,也不出现进度条
 * - 确定进度(有 duration)可点击/拖动跳转,键盘方向键步进;经 onSeek 回传外部
 * - 通过 ref 暴露 DynamicIslandHandle API:isPlaying/getTrack/getPosition/
 *   getDuration/seekTo/snapshot/subscribe
 */
/**
 * memo 包裹:父组件(挂件/演示页)高频重渲染时,props 未变的渲染直接跳过
 * (播放中 position 变化仍正常重渲;暂停/空闲时父组件的轮询/计时渲染
 * 不再连带整棵岛体树)。宿主侧需保证回调/对象型 props 引用稳定
 */
export const DynamicIsland = memo(function DynamicIsland({
  state,
  track,
  position = 0,
  duration = 0,
  onSeek,
  onChange,
  onHoverChange,
  onSwipeLeft,
  onSwipeRight,
  onAgentSwipeToMusic,
  onAgentTripleClick,
  onTextDoubleClick,
  onExpandChange,
  mode,
  onCycleMode,
  themeColor,
  playlist,
  playlistIndex,
  systemActive = false,
  systemPlatform,
  lyrics,
  onToggleSource,
  modeSupported = true,
  onPlayTrack,
  onTogglePlay,
  onUploadTracks,
  onRemoveTrack,
  theme: customTheme,
  onThemeChange,
  hint,
  backgroundExpandedImage,
  backgroundCompactImage,
  backgroundOpacity,
  backgroundCrop,
  onBackgroundChange,
  requestSettingsSeq,
  onPanelViewChange,
  settingsButton,
  fontLibrary,
  currentFontId,
  fontColor,
  onFontAdd,
  onFontLibraryChange,
  onFontSelect,
  onFontColorChange,
  fontWeight,
  onFontWeightChange,
  imageLibrary,
  onImageLibraryChange,
  agent,
  agentConfig,
  onAgentPanelSize,
  collapseSeq,
  onAgentPanelWidth,
  ref,
}: DynamicIslandProps) {
  // Agent 模式激活(存在即激活):媒体数据与手势让位
  const agentActive = agent != null
  const agentActiveRef = useRef(false)
  agentActiveRef.current = agentActive
  const islandRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLSpanElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const panelBarRef = useRef<HTMLDivElement>(null)
  const hoveredRef = useRef(false)
  const scrubbingRef = useRef(false) // 拖动中:悬停移出不收缩,防进度条中途被收回
  const displayTextRef = useRef('')
  const widthRef = useRef<string | undefined>(undefined)
  const visibleTextRef = useRef('')
  const listenersRef = useRef(new Set<(snap: IslandSnapshot) => void>())
  const onSeekRef = useRef(onSeek)
  const onHoverChangeRef = useRef(onHoverChange)
  const stateRef = useRef(state)
  // 长按展开:按下起点 + 计时器;位移超阈值或提前抬起则取消
  const pressRef = useRef<{ startX: number; startY: number; timer: number } | null>(null)
  // 长按触发后的那次 click 只消费此标记(不切换状态也不收起,防止刚展开又被点掉)。
  // 限时 600ms 自动清除:面板按钮点击都 stopPropagation 不触发岛 click,
  // 若标记长期滞留,下一次点岛本体会被误吞而无法收起
  const suppressClickRef = useRef(false)
  const suppressTimerRef = useRef(0)
  const expandedRef = useRef(false)
  const onExpandChangeRef = useRef(onExpandChange)
  // 文字区滑动手势:按下起点 + 是否已触发(触发后不再重复)
  const swipeRef = useRef<{ startX: number; startY: number; pointerId: number; done: boolean } | null>(null)
  // 文字区点击时间序列(三连击检测:三次点击间隔都在窗口内即触发)
  const tripleClickRef = useRef<number[]>([])
  onSeekRef.current = onSeek
  onExpandChangeRef.current = onExpandChange
  onHoverChangeRef.current = onHoverChange
  stateRef.current = state

  const [islandWidth, setIslandWidth] = useState<string | undefined>(undefined)
  const [displayText, setDisplayText] = useState(() => mediaTextFor(state, track, false))
  const [visibleText, setVisibleText] = useState(() => mediaTextFor(state, track, false))
  // 媒体模式:文字区在"歌名/歌手"间循环
  const [showArtist, setShowArtist] = useState(false)
  // 悬停上浮(渲染级,与按压 transform 合并)
  const [hovered, setHovered] = useState(false)
  // 3D 按压:按下位置相对岛中心的象限(-1..1) + 按压力度(0-1,按住越久越深),
  // 驱动下沉/倾斜/回弹
  const [press, setPress] = useState<{ qx: number; qy: number; strength: number } | null>(null)
  const pressRafRef = useRef(0)
  const pressStartRef = useRef(0)
  const [textTruncated, setTextTruncated] = useState(false)
  const [textOpacity, setTextOpacity] = useState(1)
  const [textMotion, setTextMotion] = useState<TextMotion>('idle')
  // 长按展开:胶囊形变为更大的圆角矩形面板(展开宽按视口实时计算)
  const [expanded, setExpanded] = useState(false)
  const [expandedWidth, setExpandedWidth] = useState(EXPANDED_WIDTH_PX)
  // 收起过渡期:隐藏悬停进度条并屏蔽 hover 布局,防"收缩中的大岛 + 悬停内容"叠加
  const [collapsing, setCollapsing] = useState(false)
  const collapseTimerRef = useRef(0)
  const collapsingRef = useRef(false)
  collapsingRef.current = collapsing
  // 形变动画期:关闭背景毛玻璃(backdrop 每帧重采样是卡顿主因),动画结束恢复
  const [animating, setAnimating] = useState(false)
  const animatingTimerRef = useRef(0)
  // 播放模式图标切换:保留旧图标做"擦除"退出,新图标"画出"进入
  const [prevMode, setPrevMode] = useState<PlaybackMode | null>(null)
  const prevModeRef = useRef<PlaybackMode | null>(null)
  // (主题色涟漪已移除:扩散圆会染到岛角,颜色变化由各元素 transition 平滑过渡)
  // 展开面板视图:媒体控制 / 播放列表 / 主题色 / 自定义背景 / 帮助手册 / 字体 / 设置
  // (各视图为独立组件,见 ./views)
  const [panelView, setPanelView] = useState<PanelView>('control')
  // 主题色切换的"跑马灯流体"动画:记录颜色与触发位置,动画结束自动清除
  const [ripple, setRipple] = useState<{ id: number; color: string; x: number; y: number } | null>(null)
  const rippleIdRef = useRef(0)
  const rippleTimerRef = useRef(0)
  const triggerRipple = useCallback((color: string, x?: number, y?: number) => {
    const rect = islandRef.current?.getBoundingClientRect()
    setRipple({
      id: ++rippleIdRef.current,
      color,
      x: x ?? (rect ? rect.width / 2 : 200),
      y: y ?? (rect ? rect.height / 2 : 100),
    })
    window.clearTimeout(rippleTimerRef.current)
    rippleTimerRef.current = window.setTimeout(() => setRipple(null), 1000)
  }, [])
  // 首页歌词显示开关(点击音乐图标切换)
  const [lyricShown, setLyricShown] = useState(true)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // 主题色涟漪:模式切换时颜色从按钮位置扩散到整个岛
  expandedRef.current = expanded

  // 主题色:播放/暂停态跟随播放模式,其余状态用状态色
  const theme =
    (state === 'playing' || state === 'idle') && themeColor ? themeColor : ISLAND_STATES[state].color
  // 播放模式类:驱动进度条跑马灯样式(仅媒体模式)
  const modeClass = mode ? `mode-${mode}` : ''

  // 按压 transform:以按压点为原点下沉 + 倾斜(3D 压感),松手回弹。
  // CSS 旋转方向:rotateX(正) 底边向前、rotateY(正) 右边向后。
  // 按左上角(qx,qy 均负)→ rotateX(+, 底边翘) rotateY(-, 右边翘) →
  // 右下角 z 最大 = 微微翘起,按压角 z 最深,依次类推
  const pressTransform = press
    ? `perspective(800px) rotateX(${(-press.qy * (7.5 + 12.5 * press.strength)).toFixed(2)}deg) rotateY(${(press.qx * (7.5 + 12.5 * press.strength)).toFixed(2)}deg) scale(${(0.975 - 0.06 * press.strength).toFixed(3)})`
    : hovered
      ? 'translateY(-2px)'
      : 'none'
  const pressOrigin = press
    ? `${(((press.qx + 1) / 2) * 100).toFixed(1)}% ${(((press.qy + 1) / 2) * 100).toFixed(1)}%`
    : undefined
  // 拖动进度条时的临时比例(0-1);松手后经 onSeek 回传外部,由外部更新真实进度
  const [scrubRatio, setScrubRatio] = useState<number | null>(null)
  const [scrubbing, setScrubbing] = useState(false)
  // 按下瞬间记录的标题文字宽度:粒子时间居中于文字区域(而非整个岛宽,
  // 否则短标题的岛会让时间与进度条重叠)
  const [scrubTitleWidth, setScrubTitleWidth] = useState(0)
  displayTextRef.current = displayText
  widthRef.current = islandWidth

  // 本地播放器模式且播放列表为空:紧凑态文字区提示上传(仅提示,
  // 上传入口在展开面板主体);playlist 已传说明是本地模式
  const showUploadPrompt = track == null && playlist != null && playlist.length === 0
  // 操作提示优先:紧凑态直接把提示文本放进左侧文字区(与歌名同款字体、
  // 同套切换动画,不额外加气泡),展开态由面板在播放键下方渲染;
  // Agent 模式:状态/回复预览文案走 agentCompactLabel
  const text =
    agentActive
      ? agentCompactLabel(agent)
      : hint && !expanded
        ? hint
        : showUploadPrompt
          ? '本地暂无音乐,长按上传'
          : mediaTextFor(state, track, showArtist)

  // 媒体模式下文字区循环显示歌名/歌手名;悬浮、拖动进度条或展开期间暂停循环,
  // 避免触发文字切换动画导致岛宽/进度条位置变化
  useEffect(() => {
    if (!track || (state !== 'playing' && state !== 'idle')) return
    const timer = window.setInterval(() => {
      if (!scrubbingRef.current && !hoveredRef.current && !expandedRef.current)
        setShowArtist((v) => !v)
    }, TRACK_CYCLE_MS)
    return () => window.clearInterval(timer)
  }, [track, state])

  // 右侧文字:先上移淡出,换内容后藏在下方(淡入由宽度回弹后的 layout effect 负责)
  useEffect(() => {
    if (text === displayTextRef.current) {
      // 首次渲染或文字未变化:保持可见
      setTextOpacity(1)
      setTextMotion('idle')
      return
    }
    setTextOpacity(0)
    setTextMotion('out')
    const timer = window.setTimeout(() => setDisplayText(text), TEXT_SWAP_MS)
    return () => window.clearTimeout(timer)
  }, [text])

  // 新文字落位后:字符截断 → 测量最终自然宽度并触发宽度回弹 → 应用布局 → 回弹结束后上移淡入
  useLayoutEffect(() => {
    const island = islandRef.current
    const textEl = textRef.current
    if (!island || !textEl) return

    // 悬停校准:JS 记录的悬停态可能因鼠标事件丢失(点击穿透窗口下偶发)
    // 而滞留,导致"宽岛无进度条"——以 DOM 实时 :hover 为准,不在悬停
    // 态就回落自然宽。切歌/换平台等文字变化会触发本 effect 重新计算宽度,
    // 正是滞留态暴露的时机
    if (!expandedRef.current && hoveredRef.current && !island.matches(':hover')) {
      hoveredRef.current = false
      setHovered(false)
      onHoverChangeRef.current?.(false)
    }

    const font = getComputedStyle(textEl).font
    const fullTextWidth = measureTextWidth(displayText, font)

    // 第一轮:非悬停时的字符截断(用 canvas 测量完整文字,不依赖 DOM 渲染状态)
    const available = MAX_WIDTH_PX - ISLAND_BASE_PX - ELLIPSIS_SLOT_PX
    const { visible, truncated } = truncateText(displayText, available, font)
    if (visible !== visibleTextRef.current) {
      visibleTextRef.current = visible
      setVisibleText(visible)
      setTextTruncated(truncated)
      return
    }

    // 第二轮:截断内容已提交,测量最终宽度 → 计算悬停目标宽度 → px→px 过渡触发回弹
    const finalNatural = measureNaturalWidth(island)
    const conflicts =
      fullTextWidth + PROGRESS_WIDTH_PX + PROGRESS_RIGHT_MARGIN_PX + TEXT_LEFT_PX >
      MAX_WIDTH_PX
    const targetPx = hoveredRef.current
      ? conflicts
        ? MAX_WIDTH_PX
        : Math.min(finalNatural + HOVER_EXTEND_PX, MAX_WIDTH_PX)
      : finalNatural
    // 宽度需要变化时等回弹结束再淡入;宽度不变时(如同长度文字)快速淡入
    const needsResize = widthRef.current !== `${targetPx}px`
    applyTextLayout(island, textEl, fullTextWidth, targetPx, hoveredRef.current)
    setIslandWidth(`${targetPx}px`)
    const timer = window.setTimeout(
      () => {
        setTextOpacity(1)
        setTextMotion('in')
      },
      needsResize ? FADE_IN_DELAY_MS : FADE_IN_FAST_MS,
    )
    return () => window.clearTimeout(timer)
  }, [displayText, visibleText])

  const progressMode = ISLAND_STATES[state].progress
  // Agent 模式:不渲染紧凑进度条(媒体让位)
  const showBar = !agentActive && progressMode !== 'none'
  // 确定进度:拖动中显示临时比例,否则按 position/duration;无 duration 时退回扫光
  const fillRatio = duration > 0 ? Math.min(position / duration, 1) : 0
  const displayRatio = scrubbing && scrubRatio !== null ? scrubRatio : fillRatio
  // 拖动中左侧文字切换为当前拖拽的时间预览(粒子效果,居中显示;
  // 不触发切换动画、不动岛宽,进度条位置保持稳定;松手后经 onSeek 提交并回到歌曲名)
  // 展开面板中拖动同样走 scrubbing 管线,但粒子时间只属于紧凑布局
  const showingScrub = scrubbing && duration > 0 && !expanded
  const scrubSeconds = scrubRatio !== null ? scrubRatio * duration : 0
  // 展开面板中的媒体控制:绑定曲目且处于媒体状态时显示播放控制,否则显示收起按钮
  const panelHasControls =
    track != null && (state === 'playing' || state === 'idle' || state === 'loading')
  // 歌词区折叠:用户关闭歌词,或开启但当前曲目未匹配到歌词
  // (查询中保持展开,避免"展开→折叠→展开"闪动)
  const lyricFold =
    !lyricShown || (lyrics !== undefined && !lyrics.loading && lyrics.lines.length === 0)
  // 裁切参数与当前编辑目标:展开态 / 紧凑态各自独立(互不影响)。
  // 背景的裁切交互 / 视口 / 上传逻辑自包含在 BackgroundView,
  // 这里仅保留根元素 class 需要的 bgTarget 与传给视图的裁切参数
  const crop = backgroundCrop ?? { expanded: DEFAULT_BG_CROP, compact: DEFAULT_BG_CROP }
  const expandedCrop = crop.expanded
  const compactCrop = crop.compact
  const [bgTarget, setBgTarget] = useState<'expanded' | 'compact'>('expanded')
  const expandedImage = backgroundExpandedImage ?? null
  const compactImage = backgroundCompactImage ?? null
  // 岛体根部背景图 CSS 变量需要各形态背景的百分比尺寸(cover 基准 + 缩放):
  // 图片自然尺寸异步加载后计算(BackgroundView 内的视口裁切各自独立计算)
  const [bgNaturalE, setBgNaturalE] = useState<{ w: number; h: number } | null>(null)
  useEffect(() => {
    if (!expandedImage) {
      setBgNaturalE(null)
      return
    }
    const img = new Image()
    img.onload = () => setBgNaturalE({ w: img.naturalWidth, h: img.naturalHeight })
    img.src = expandedImage
  }, [expandedImage])
  const [bgNaturalC, setBgNaturalC] = useState<{ w: number; h: number } | null>(null)
  useEffect(() => {
    if (!compactImage) {
      setBgNaturalC(null)
      return
    }
    const img = new Image()
    img.onload = () => setBgNaturalC({ w: img.naturalWidth, h: img.naturalHeight })
    img.src = compactImage
  }, [compactImage])
  const bgSizeExpanded = bgNaturalE
    ? bgSizePctFor(BG_CROP_REF_W, BG_CROP_REF_H, expandedCrop.zoom, bgNaturalE.w, bgNaturalE.h)
    : null
  const bgSizeCompact = bgNaturalC
    ? bgSizePctFor(
        BG_COMPACT_REF_W,
        BG_COMPACT_REF_H,
        compactCrop.zoom,
        bgNaturalC.w,
        bgNaturalC.h,
      )
    : null

  const ratioFromPointer = (event: PointerEvent<HTMLDivElement>, bar: HTMLDivElement): number => {
    const rect = bar.getBoundingClientRect()
    return Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1)
  }

  // 点击/拖动进度条:按下即定位,拖动实时预览,松手提交 onSeek
  // (紧凑条与展开面板条共用同一套逻辑,由调用方传入条元素)
  const handleBarPointerDown = (event: PointerEvent<HTMLDivElement>, bar: HTMLDivElement) => {
    if (duration <= 0) return
    // 仅左键:右键留给挂件层的"长按拖拽移动挂件"
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation() // 不向上冒泡为岛体长按
    // 按下瞬间记录"文字区实际渲染宽度"供粒子时间居中。
    // 直接用 DOM 布局宽度(含截断省略号),比 canvas 估算 + 硬编码
    // 省略号宽度更准确:不同歌名(长短/是否截断)下粒子时间都精确居中
    const el = textRef.current
    if (el) {
      setScrubTitleWidth(el.offsetWidth)
    }
    bar.setPointerCapture(event.pointerId)
    scrubbingRef.current = true
    setScrubbing(true)
    setScrubRatio(ratioFromPointer(event, bar))
  }
  const handleBarPointerMove = (event: PointerEvent<HTMLDivElement>, bar: HTMLDivElement) => {
    if (!scrubbingRef.current) return
    setScrubRatio(ratioFromPointer(event, bar))
  }
  const handleBarPointerUp = (event: PointerEvent<HTMLDivElement>, bar: HTMLDivElement) => {
    if (!scrubbingRef.current) return
    scrubbingRef.current = false
    setScrubbing(false)
    setScrubRatio(null)
    onSeek?.(ratioFromPointer(event, bar) * duration)
  }

  // 键盘控制进度(与指针拖动走同一 onSeek 通道)
  const handleBarKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (duration <= 0) return
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      onSeek?.(Math.max(position - SEEK_STEP_SEC, 0))
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      onSeek?.(Math.min(position + SEEK_STEP_SEC, duration))
    } else if (event.key === 'Home') {
      event.preventDefault()
      onSeek?.(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      onSeek?.(duration)
    }
  }

  // 文字区鼠标手势:横向滑动超阈值即触发(左滑 onSwipeLeft/右滑 onSwipeRight),
  // 纵向位移过大视为误触;仅绑定了手势回调时启用;Agent 模式下媒体手势让位,
  // 改接 onAgentSwipeToMusic(左滑/右滑都触发,通常退出 Agent 切回音乐)
  const hasTextGestures = agentActive
    ? Boolean(onAgentSwipeToMusic)
    : Boolean(onSwipeLeft || onSwipeRight)
  const handleTextPointerDown = (event: PointerEvent<HTMLSpanElement>) => {
    // 音乐模式文字区三连击:切换到 Agent 模式。与双击(播放/暂停)并存
    // —— 第三击按下时前两次已产生 dblclick,播放状态切换的副作用保留
    if (!agentActive && onAgentTripleClick && event.button === 0) {
      const now = Date.now()
      const times = tripleClickRef.current
      times.push(now)
      // 只保留窗口内的点击(间隔过久的旧点击滑出)
      while (times.length > 0 && now - times[0] > TRIPLE_CLICK_WINDOW_MS) times.shift()
      if (times.length >= 3) {
        times.length = 0
        onAgentTripleClick()
      }
    }
    if (!hasTextGestures) return
    // 仅左键:右键留给挂件层的"长按拖拽移动挂件"
    if (event.button !== 0) return
    swipeRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      pointerId: event.pointerId,
      done: false,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const handleTextPointerMove = (event: PointerEvent<HTMLSpanElement>) => {
    const gesture = swipeRef.current
    if (!gesture || gesture.done) return
    const dx = event.clientX - gesture.startX
    const dy = event.clientY - gesture.startY
    if (Math.abs(dx) < SWIPE_THRESHOLD_PX || Math.abs(dy) > Math.abs(dx) * 1.2) return
    gesture.done = true
    // Agent 模式:左滑/右滑无方向语义,都是退出 Agent 切回音乐
    if (agentActive) {
      onAgentSwipeToMusic?.()
      return
    }
    if (dx > 0) onSwipeRight?.()
    else onSwipeLeft?.()
  }
  const handleTextPointerUp = (event: PointerEvent<HTMLSpanElement>) => {
    const gesture = swipeRef.current
    if (gesture && gesture.pointerId === event.pointerId) swipeRef.current = null
  }

  /** 切换展开状态并通知外部(供暂停/恢复自动演示) */
  /**
   * 真正执行收起:宽度回缩 + 压感回弹 + 面板视图重置(音乐模式直接走这里;
   * Agent 模式先经两阶段——阶段 1 只收缩高度,阶段 2 才到本函数,
   * 压感在高度收缩期间保持,长条上 3D 旋转先随收缩自然收尾再回弹)
   */
  const doCollapse = useCallback(() => {
    releasePress()
    setExpanded(false)
    onExpandChangeRef.current?.(false)
    // 形变动画期:关闭背景毛玻璃(backdrop 每帧重采样是卡顿主因)
    setAnimating(true)
    window.clearTimeout(animatingTimerRef.current)
    animatingTimerRef.current = window.setTimeout(() => setAnimating(false), MORPH_ANIMATE_MS)
    // 收起时清掉残留的拖动状态与面板视图(拖动中收起可能不触发 bar 的 pointerup)。
    // 统一回落 control:窗口高度随之恢复 280;Agent 模式再次展开时由下方
    // "agent 激活" effect 把 control/list 切回 agent 视图(避免收起后窗口
    // 停留在聊天高度 640)
    scrubbingRef.current = false
    setScrubbing(false)
    setScrubRatio(null)
    setPanelView('control')
    // 收起目标宽度按收起后的状态重新计算(不复用展开前的悬停宽):
    // - 悬停且当前状态有进度条 → 悬停目标宽(进度条会显示)
    // - 非悬停或状态无进度条(success/error 等) → 自然紧凑宽,
    //   避免"宽岛无进度条"的留白(demo 状态循环中收起时的常见问题)
    const island = islandRef.current
    const textEl = textRef.current
    if (island && textEl) {
      const font = getComputedStyle(textEl).font
      const fullTextWidth = measureTextWidth(displayTextRef.current, font)
      const natural = measureNaturalWidth(island)
      const hoverNow = island.matches(':hover')
      const hasBar = ISLAND_STATES[stateRef.current].progress !== 'none'
      if (hoverNow && hasBar) {
        const conflicts =
          fullTextWidth + PROGRESS_WIDTH_PX + PROGRESS_RIGHT_MARGIN_PX + TEXT_LEFT_PX >
          MAX_WIDTH_PX
        const targetPx = conflicts
          ? MAX_WIDTH_PX
          : Math.min(natural + HOVER_EXTEND_PX, MAX_WIDTH_PX)
        applyTextLayout(island, textEl, fullTextWidth, targetPx, true)
        setIslandWidth(`${targetPx}px`)
      } else {
        applyTextLayout(island, textEl, fullTextWidth, natural, false)
        setIslandWidth(`${natural}px`)
      }
      // 收起后鼠标不在岛上:解除悬停暂停(恢复自动演示循环)
      if (!hoverNow && hoveredRef.current) {
        hoveredRef.current = false
        setHovered(false)
        onHoverChangeRef.current?.(false)
      }
    }
    // 收起瞬间进入 collapsing:隐藏悬停进度条并屏蔽 hover 布局,
    // 等岛收缩完成后再恢复(紧凑内容的淡入延迟由 CSS 的 transition-delay 承担)
    setCollapsing(true)
    window.clearTimeout(collapseTimerRef.current)
    collapseTimerRef.current = window.setTimeout(() => {
      setCollapsing(false)
      // 校准:收起触发瞬间鼠标在岛上(长按/点按),但松手移开后
      // mouseleave 在 collapsing 期间被屏蔽——此时按实时 :hover 回落自然宽,
      // 避免"悬停宽但无进度条"的留白
      const island = islandRef.current
      const textEl = textRef.current
      if (island && textEl && !island.matches(':hover') && !expandedRef.current) {
        const font = getComputedStyle(textEl).font
        const fullTextWidth = measureTextWidth(displayTextRef.current, font)
        const natural = measureNaturalWidth(island)
        applyTextLayout(island, textEl, fullTextWidth, natural, false)
        setIslandWidth(`${natural}px`)
      }
    }, COLLAPSE_HIDE_MS)
  }, [])

  /**
   * 展开/收起切换(单动画:收起 = 宽度/高度同时收缩 + 压感回弹并行,
   * 与音乐模式一致,无两段式割裂)
   */
  const changeExpanded = useCallback(
    (value: boolean) => {
      if (value === expandedRef.current) return
      if (value) {
        setExpanded(true)
        onExpandChangeRef.current?.(true)
        // 形变动画期:关闭背景毛玻璃(backdrop 每帧重采样是卡顿主因)
        setAnimating(true)
        window.clearTimeout(animatingTimerRef.current)
        animatingTimerRef.current = window.setTimeout(() => setAnimating(false), MORPH_ANIMATE_MS)
        return
      }
      doCollapse()
    },
    [doCollapse],
  )

  // 3D 按压反馈:记录按压点象限,按压力度随按住时长渐进(0→1,与长按阈值同步,
  // 每帧节流 16ms,避免 60fps setState 重渲染),整岛以按压点为原点逐渐下沉/倾斜
  const pressIslandAt = (event: PointerEvent<HTMLDivElement>) => {
    const island = islandRef.current
    if (!island) return
    cancelAnimationFrame(pressRafRef.current)
    const rect = island.getBoundingClientRect()
    const qx = Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width) * 2 - 1))
    const qy = Math.max(-1, Math.min(1, ((event.clientY - rect.top) / rect.height) * 2 - 1))
    pressStartRef.current = performance.now()
    let lastSet = 0
    const step = (now: number) => {
      const strength = Math.min(1, (now - pressStartRef.current) / LONG_PRESS_MS)
      if (now - lastSet >= 16) {
        lastSet = now
        setPress({ qx, qy, strength })
      }
      if (strength < 1) pressRafRef.current = requestAnimationFrame(step)
    }
    pressRafRef.current = requestAnimationFrame(step)
  }

  /** 结束按压:取消渐进循环并回弹 */
  const releasePress = () => {
    cancelAnimationFrame(pressRafRef.current)
    setPress(null)
  }

  /** 上传音乐:文件选择后回调外部(清空 input 允许重复选择同一文件) */
  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (files.length > 0) onUploadTracks?.(files)
  }

  // 字体上传错误提示(在字体视图预览行状态位短暂显示,3s 自动清除)
  const [fontError, setFontError] = useState<string | null>(null)
  const fontErrorTimerRef = useRef(0)
  const showFontError = useCallback((msg: string) => {
    setFontError(msg)
    window.clearTimeout(fontErrorTimerRef.current)
    fontErrorTimerRef.current = window.setTimeout(() => setFontError(null), 3000)
  }, [])

  // 长按:紧凑态长按展开,展开态长按收起——按到 450ms 直接形变,不等待松手。
  // 压感全程渐进(无静止停顿);触发收起时保持最深压感并行收缩(一边 3D 压感
  // 一边收起),松手或动画结束后回弹归位
  const handleIslandPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    // 仅响应左键:右键不触发按压/长按(右键拖拽已移除,右键按下不做任何事)
    if (event.button !== 0) return
    // 设置类视图:禁用按压/长按收起(控件的点按会冒泡到这里,
    // 只能通过返回键收起),避免设置/编辑中被误缩回
    if (isSettingsView(panelView)) return
    const prev = pressRef.current
    if (prev) window.clearTimeout(prev.timer)
    const startX = event.clientX
    const startY = event.clientY
    // Agent 展开态:不做 3D 按压反馈(聊天面板交互区已拦截左键,
    // 到达这里的左键来自消息区空白,长按/点击均无收起操作);
    // 紧凑态保留按压反馈(长按展开手感与音乐模式一致)
    if (!(agentActiveRef.current && expandedRef.current)) pressIslandAt(event)
    if (expandedRef.current) {
      // Agent 模式:禁用长按收回(只能通过右上角收起面板按钮),
      // 按压反馈仍保留(按下有 3D 压感,松手回弹)
      if (agentActiveRef.current) return
      pressRef.current = {
        startX,
        startY,
        timer: window.setTimeout(() => {
          pressRef.current = null
          suppressClickRef.current = true // 吞掉松手后的 click,避免收起后误切换状态
          window.clearTimeout(suppressTimerRef.current)
          suppressTimerRef.current = window.setTimeout(() => {
            suppressClickRef.current = false
          }, SUPPRESS_CLICK_MS)
          // 压感回弹由 doCollapse 统一在收缩时执行(同 tick 并行)
          changeExpanded(false)
        }, LONG_PRESS_MS),
      }
      return
    }
    pressRef.current = {
      startX,
      startY,
      timer: window.setTimeout(() => {
        pressRef.current = null
        suppressClickRef.current = true // 吞掉松手后那次 click,避免刚展开即被收起
        window.clearTimeout(suppressTimerRef.current)
        suppressTimerRef.current = window.setTimeout(() => {
          suppressClickRef.current = false
        }, SUPPRESS_CLICK_MS)
        releasePress() // 按压回弹 → 同时伸缩展开
        setExpandedWidth(
          Math.max(
            EXPANDED_MIN_WIDTH_PX,
            Math.min(EXPANDED_WIDTH_PX, window.innerWidth - EXPANDED_VIEWPORT_MARGIN_PX),
          ),
        )
        // Agent 模式:展开同一帧切到聊天视图(与 setExpanded 批量提交),
        // 高度目标直接是 --agent-h,避免"先朝 244 形变再改目标"的二次
        // 重定向抖动(视图切换 effect 兜底运行中/设置类视图保留)
        if (agentActive) {
          setPanelView((view) => (view === 'control' || view === 'list' ? 'agent' : view))
        }
        changeExpanded(true)
      }, LONG_PRESS_MS),
    }
  }
  const handleIslandPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const press = pressRef.current
    if (!press) return
    if (
      Math.hypot(event.clientX - press.startX, event.clientY - press.startY) >
      LONG_PRESS_SLOP_PX
    ) {
      window.clearTimeout(press.timer)
      pressRef.current = null
      releasePress() // 位移超阈值视为滑动/拖动,取消按压
    }
  }
  const handleIslandPointerEnd = () => {
    const press = pressRef.current
    if (press) {
      window.clearTimeout(press.timer)
      pressRef.current = null
    }
    releasePress() // 松手回弹
  }

  const handleClick = () => {
    // 长按触发展开后的那次 click:只消费标记,不切换状态也不收起
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    // 展开状态:点按岛体收起(设置类视图除外——只能通过返回键;
    // Agent 模式屏蔽单击缩回,只保留长按收回)
    if (expandedRef.current) {
      if (!agentActive && !isSettingsView(panelView)) changeExpanded(false)
      return
    }
    if (!onChange) return
    const next = STATE_ORDER[(STATE_ORDER.indexOf(state) + 1) % STATE_ORDER.length]
    onChange(next)
  }

  // 悬停:计算目标宽度 + 渐隐/进度条位置(冲突才渐隐,不冲突进度条从文字尾部后滑出)
  const handleMouseEnter = () => {
    if (expandedRef.current) return // 展开期间不响应悬停伸缩
    if (collapsingRef.current) return // 收起冷却期不响应悬停(防宽度在悬浮/非悬浮间跳变叠加)
    const island = islandRef.current
    const textEl = textRef.current
    if (!island || !textEl) return
    hoveredRef.current = true
    setHovered(true)
    onHoverChange?.(true)
    if (!showBar) return // 通知状态无进度条:悬停只抬起/发光,不展开
    const font = getComputedStyle(textEl).font
    const fullTextWidth = measureTextWidth(displayText, font)
    const conflicts =
      fullTextWidth + PROGRESS_WIDTH_PX + PROGRESS_RIGHT_MARGIN_PX + TEXT_LEFT_PX >
      MAX_WIDTH_PX
    const natural = measureNaturalWidth(island)
    const targetPx = conflicts ? MAX_WIDTH_PX : Math.min(natural + HOVER_EXTEND_PX, MAX_WIDTH_PX)
    applyTextLayout(island, textEl, fullTextWidth, targetPx, true)
    setIslandWidth(`${targetPx}px`)
  }

  const handleMouseLeave = () => {
    if (expandedRef.current) return // 展开期间不响应悬停伸缩
    if (collapsingRef.current) return // 收起冷却期不响应悬停
    const island = islandRef.current
    const textEl = textRef.current
    if (!island || !textEl) return
    hoveredRef.current = false
    setHovered(false)
    onHoverChange?.(false)
    if (scrubbingRef.current) return // 拖动中保持展开,松手后由下次悬停变化纠正
    const font = getComputedStyle(textEl).font
    const fullTextWidth = measureTextWidth(displayText, font)
    const natural = measureNaturalWidth(island)
    applyTextLayout(island, textEl, fullTextWidth, natural, false)
    setIslandWidth(`${natural}px`)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && expandedRef.current) {
      // 设置类视图 / Agent 模式:Esc 不收起(设置类只能通过返回键,
      // Agent 模式只保留长按收回)
      if (!isSettingsView(panelView) && !agentActive) {
        event.preventDefault()
        changeExpanded(false)
      }
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      handleClick()
    }
  }

  // 展开期间:点按岛外任意位置或按 Esc 收起(设置类视图除外——
  // 只能通过返回键收起,避免设置/编辑中被误缩回;
  // Agent 模式同样屏蔽,只保留长按收回)
  useEffect(() => {
    if (!expanded) return
    const onDocPointerDown = (event: globalThis.PointerEvent) => {
      const island = islandRef.current
      if (
        island &&
        !island.contains(event.target as Node) &&
        !isSettingsView(panelView) &&
        !agentActive
      ) {
        changeExpanded(false)
      }
    }
    const onDocKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !isSettingsView(panelView) && !agentActive) {
        changeExpanded(false)
      }
    }
    document.addEventListener('pointerdown', onDocPointerDown)
    document.addEventListener('keydown', onDocKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown)
      document.removeEventListener('keydown', onDocKeyDown)
    }
  }, [expanded, changeExpanded, panelView, agentActive])

  // Agent 模式:展开默认进聊天视图(媒体控制/列表视图让位;
  // 设置类视图如"设置"保留,托盘入口仍可用)
  useEffect(() => {
    if (!agentActive || !expanded) return
    setPanelView((view) => (view === 'control' || view === 'list' ? 'agent' : view))
  }, [agentActive, expanded])

  // Agent 面板岛体高度(px,逻辑值):内容自适应(AgentView 测量回调写入
  // --agent-h),默认下限留一点空;离开 agent 视图重置,下次进入重新测量
  const [agentPanelH, setAgentPanelH] = useState(AGENT_PANEL_MIN_H)
  useEffect(() => {
    if (panelView !== 'agent') setAgentPanelH(AGENT_PANEL_MIN_H)
  }, [panelView])
  // Agent 面板界面缩放(百分比 100-300,最低 100%):等比例缩放展开态 UI。
  // 持久化 localStorage;视觉尺寸 = 逻辑值 × 缩放,窗口由宿主跟随
  const AGENT_SCALE_KEY = 'widget-agent-scale'
  const [agentScale, setAgentScale] = useState(() => {
    try {
      const v = Number(localStorage.getItem(AGENT_SCALE_KEY))
      if (Number.isFinite(v) && v >= 100 && v <= 300) return Math.round(v)
    } catch {
      // 忽略存储失败
    }
    return 100
  })
  const handleAgentScaleChange = useCallback((scale: number) => {
    const clamped = Math.min(300, Math.max(100, Math.round(scale)))
    setAgentScale(clamped)
    try {
      localStorage.setItem(AGENT_SCALE_KEY, String(clamped))
    } catch {
      // 忽略存储失败
    }
  }, [])
  // 视觉尺寸同步宿主:窗口跟随(宿主回调须引用稳定)。
  // 缩放只放大面板宽度(UI 元素不缩放),高度仍由内容驱动
  useEffect(() => {
    if (panelView === 'agent') {
      const s = agentScale / 100
      onAgentPanelSize?.(Math.round(expandedWidth * s), agentPanelH)
    }
  }, [panelView, agentPanelH, agentScale, expandedWidth, onAgentPanelSize])
  // 缩放变化立即同步窗口宽度(无论当前面板视图——设置视图里切缩放
  // 也要即时看到放大效果;高度由各视图回调管理)
  useEffect(() => {
    if (!agentActive || !expanded) return
    onAgentPanelWidth?.(Math.round(expandedWidth * (agentScale / 100)))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅缩放/展开变化时触发
  }, [agentScale, expanded])

  // 外部请求(托盘菜单"设置")打开设置视图:seq 变化即展开并切换。
  // 背景 / 帮助 / 主题色 / 字体从设置视图内部进入,不再有独立外部入口
  useEffect(() => {
    if (!requestSettingsSeq) return
    setPanelView('settings')
    setExpandedWidth(
      Math.max(
        EXPANDED_MIN_WIDTH_PX,
        Math.min(EXPANDED_WIDTH_PX, window.innerWidth - EXPANDED_VIEWPORT_MARGIN_PX),
      ),
    )
    changeExpanded(true)
  }, [requestSettingsSeq, changeExpanded])

  // 当前应用字体:库中按 id 取(dataUrl 注入 @font-face,名称用于预览/搜索)
  const currentFont = fontLibrary?.find((f) => f.id === currentFontId) ?? null
  const fontDataUrl = currentFont?.dataUrl ?? null
  const fontFamilyName = currentFont?.name ?? null

  // 自定义字体:注入 @font-face(data URL 直接作 src,跨端一致),
  // 字体变更时重建,移除/卸载时清理注入的样式
  useEffect(() => {
    if (!fontDataUrl) return
    const style = document.createElement('style')
    style.id = 'island-font-face'
    style.textContent = `@font-face { font-family: '${CUSTOM_FONT_FAMILY}'; src: url("${fontDataUrl}"); }`
    document.head.appendChild(style)
    return () => style.remove()
  }, [fontDataUrl])

  // 自动字体颜色(auto 模式):从**当前形态**的背景图(展开态用展开图,
  // 紧凑态用紧凑图,缺图时退另一形态)采样**原图**平均亮度。
  // 用原图而非合成亮度(opacity 叠加后纯白图也只有 ~108 亮度,永远判暗
  // → 白字不可读);白底图原图亮度高 → 黑字,暗色图 → 白字,
  // 阈值 130 兼顾"大部分白底"与纯深色图;无背景图时按深色底(白字)
  const [autoDarkText, setAutoDarkText] = useState(false)
  useEffect(() => {
    if (fontColor?.mode !== 'auto') return
    const bg = expanded
      ? backgroundExpandedImage ?? backgroundCompactImage
      : backgroundCompactImage ?? backgroundExpandedImage
    if (!bg) {
      setAutoDarkText(false)
      return
    }
    const img = new Image()
    img.onload = () => {
      try {
        // 32×32 采样缩放后取原图平均亮度(忽略透明像素)
        const canvas = document.createElement('canvas')
        canvas.width = 32
        canvas.height = 32
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) {
          setAutoDarkText(false)
          return
        }
        ctx.drawImage(img, 0, 0, 32, 32)
        const { data } = ctx.getImageData(0, 0, 32, 32)
        let sum = 0
        let count = 0
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] > 125) {
            sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
            count++
          }
        }
        setAutoDarkText(count > 0 && sum / count > 130)
      } catch {
        setAutoDarkText(false)
      }
    }
    img.onerror = () => setAutoDarkText(false)
    img.src = bg
  }, [backgroundExpandedImage, backgroundCompactImage, expanded, fontColor?.mode])

  // 面板视图变化通知宿主(背景视图需要更高的岛体与窗口)
  useEffect(() => {
    onPanelViewChange?.(panelView)
  }, [panelView, onPanelViewChange])

  // 外部请求收起(宿主在模式切换等场景调用;seq 递增触发,仅展开态有效)
  useEffect(() => {
    if (!collapseSeq) return
    changeExpanded(false)
  }, [collapseSeq, changeExpanded])

  // 卸载时清理全部计时器 / 按压渐进循环 / 收起与动画延迟
  // (含防抖与临时状态计时器,Web 演示版反复切换组件时防残留;
  // 视图内部自身的计时器已由各视图组件清理)
  useEffect(
    () => () => {
      const press = pressRef.current
      if (press) window.clearTimeout(press.timer)
      cancelAnimationFrame(pressRafRef.current)
      window.clearTimeout(collapseTimerRef.current)
      window.clearTimeout(animatingTimerRef.current)
      window.clearTimeout(suppressTimerRef.current)
      window.clearTimeout(rippleTimerRef.current)
      window.clearTimeout(fontErrorTimerRef.current)
    },
    [],
  )

  // 播放模式切换:旧图标线条擦除动画(主题色涟漪已移除,
  // 颜色变化由各元素 --state-color 过渡平滑完成)
  useEffect(() => {
    if (!mode) return
    setPrevMode(prevModeRef.current)
    prevModeRef.current = mode
    const t = window.setTimeout(() => setPrevMode(null), MODE_ICON_MORPH_MS)
    return () => window.clearTimeout(t)
  }, [mode])

  // (粒子时间在展开面板中作为 flex 子元素与歌名同行内嵌,无需测量定位)

  // 字体颜色解析:custom = 自定义色;auto = 背景亮度判定的黑白;默认不覆盖
  // (CSS fallback 白色系)。--text-dim 为次级文字色(主色 55% 透明度)
  const resolvedTextColor =
    fontColor?.mode === 'custom' && fontColor.value
      ? fontColor.value
      : fontColor?.mode === 'auto'
        ? autoDarkText
          ? '#0b0b0f'
          : '#ffffff'
        : null
  const textDimColor = resolvedTextColor
    ? `color-mix(in srgb, ${resolvedTextColor} 55%, transparent)`
    : undefined
  // 自定义字体应用:覆盖岛体及后代文字(按钮/输入 font-family: inherit 跟随),
  // fallback 取运行时 body 字体栈,保证无字体时的观感一致;
  // 粗细随设置(400/600/800,单字重字体由浏览器合成加粗)
  const islandFontFamily = fontDataUrl
    ? `'${CUSTOM_FONT_FAMILY}', ${getComputedStyle(document.body).fontFamily}`
    : undefined
  const islandFontWeight =
    fontWeight && [400, 600, 800].includes(fontWeight) ? fontWeight : undefined

  const stateClass = state === 'playing' || state === 'idle' ? '' : state

  const isLoading = state === 'loading'

  const textTransform =
    textMotion === 'out'
      ? `translateY(-${TEXT_RISE_PX}px)`
      : textMotion === 'below'
        ? `translateY(${TEXT_RISE_PX}px)`
        : 'translateY(0)'
  const textTransition =
    `opacity ${textMotion === 'out' || textMotion === 'below' ? FADE_OUT_MS : FADE_IN_MS}ms ${
      textMotion === 'out' || textMotion === 'below'
        ? 'ease-in'
        : 'cubic-bezier(0.22, 1, 0.36, 1)'
    }, ` +
    `transform ${
      textMotion === 'out' || textMotion === 'below' ? FADE_OUT_MS : FADE_IN_MS
    }ms ${
      textMotion === 'out' || textMotion === 'below'
        ? 'ease-in'
        : 'cubic-bezier(0.22, 1, 0.36, 1)'
    }, ` +
    `mask-size 0.45s cubic-bezier(0.34, 1.56, 0.64, 1)`

  const makeSnapshot = useCallback(
    (): IslandSnapshot => ({
      state,
      isPlaying: track != null && state === 'playing',
      track: track ?? null,
      position,
      duration,
    }),
    [state, track, position, duration],
  )

  // 灵动岛 API:检测播放状态、歌曲信息、控制进度、监听变化
  useImperativeHandle(
    ref,
    () => ({
      isPlaying: () => track != null && state === 'playing',
      getTrack: () => track ?? null,
      getPosition: () => position,
      getDuration: () => duration,
      seekTo: (seconds) =>
        onSeekRef.current?.(duration > 0 ? Math.min(Math.max(seconds, 0), duration) : seconds),
      snapshot: makeSnapshot,
      subscribe: (listener) => {
        listenersRef.current.add(listener)
        listener(makeSnapshot()) // 订阅即推送一次当前快照
        return () => {
          listenersRef.current.delete(listener)
        }
      },
    }),
    [state, track, position, duration, makeSnapshot],
  )

  // 状态/歌曲/进度变化时向订阅者推送快照(灵动岛监听功能)
  useEffect(() => {
    const snap = makeSnapshot()
    listenersRef.current.forEach((listener) => listener(snap))
  }, [makeSnapshot])

  return (
    <div
      ref={islandRef}
      className={`island-demo${stateClass ? ` ${stateClass}` : ''}${modeClass ? ` ${modeClass}` : ''}${expanded ? ' expanded' : ''}${press ? ' is-pressed' : ''}${collapsing ? ' island-collapsing' : ''}${animating ? ' is-animating' : ''}${lyricFold ? ' island-lyric-off' : ''}${panelView === 'background' ? ` island-bg-view${bgTarget === 'compact' ? ' island-bg-view--compact' : ''}` : ''}${panelView === 'font-library' || panelView === 'image-library' ? ' island-lib-view' : ''}${panelView === 'font' ? ' island-font-view' : ''}${panelView === 'font-color' ? ' island-font-color-view' : ''}${panelView === 'theme' ? ' island-theme-view' : ''}${panelView === 'agent' ? ' island-agent-view' : ''}${panelView === 'agent' && agent?.streaming ? ' island-agent-streaming' : ''}${panelView === 'agent-settings' ? ' island-agent-settings-view' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`灵动岛,当前状态:${agentActive ? 'Agent' : ISLAND_STATES[state].label},点击切换,长按展开`}
      aria-expanded={expanded}
      style={
        {
          // Agent 展开态:岛体宽度 = 逻辑展开宽 × 界面缩放(高度由 CSS
          // var(--agent-h) × var(--agent-s) 计算)
          width: expanded
            ? agentActive
              ? `${Math.round(expandedWidth * (agentScale / 100))}px`
              : `${expandedWidth}px`
            : islandWidth,
          '--state-color': theme,
          // 字体颜色(主文字/次级文字),null 时 CSS fallback 白色系
          '--text-color': resolvedTextColor ?? undefined,
          '--text-dim': textDimColor,
          transform: pressTransform,
          transformOrigin: pressOrigin,
          // 自定义字体:岛体 font-family 覆盖,后代继承
          fontFamily: islandFontFamily,
          // 字体粗细(全部文字生效)
          fontWeight: islandFontWeight,
          // Agent 面板高度(逻辑值,CSS 变量驱动 .island-agent-view 高度
          // 与消息列表 max-height;非 agent 模式不设)
          '--agent-h': agentActive ? `${agentPanelH}px` : undefined,
        } as CSSProperties
      }
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onPointerDown={handleIslandPointerDown}
      onPointerMove={handleIslandPointerMove}
      onPointerUp={handleIslandPointerEnd}
      onPointerCancel={handleIslandPointerEnd}
    >
      <div className="island-bg" aria-hidden="true">
        {/* 自定义背景:覆盖在深色底之上,不透明度可调;内容层在其上 */}
        {(expandedImage || compactImage) && (
          <div
            className="island-bg-image"
            style={
              {
                // 不透明度按形态取(展开态 / 紧凑态各自独立)
                opacity:
                  (expanded ? backgroundOpacity?.expanded : backgroundOpacity?.compact) ?? 1,
                // 展开态 / 紧凑态各自独立的图片与裁切参数(CSS 按形态切换)
                '--bg-img-e': expandedImage ? `url("${expandedImage}")` : 'none',
                '--bg-size-e': bgSizeExpanded ? `${bgSizeExpanded}%` : undefined,
                '--bg-pos-e': `${expandedCrop.posX}% ${expandedCrop.posY}%`,
                '--bg-img-c': compactImage ? `url("${compactImage}")` : 'none',
                '--bg-size-c': bgSizeCompact ? `${bgSizeCompact}%` : undefined,
                '--bg-pos-c': `${compactCrop.posX}% ${compactCrop.posY}%`,
              } as CSSProperties
            }
          />
        )}
      </div>
      {/* 设置类视图持久蒙版:独立一层,不参与面板淡入动画。
          视图切换瞬间蒙版始终不透明,背景图不会闪烁透出
          (面板自身不再带蒙版背景,由本层统一提供) */}
      {expanded && panelView !== 'control' && (
        <div className="island-panel-mask" aria-hidden="true" />
      )}
      <div className="island-content">
        <div className="island-icon">
          {/* Agent 模式:四角星图标;音乐模式:状态图标 */}
          <div className="icon-floater">{agentActive ? <AgentIcon /> : ISLAND_STATES[state].icon(state)}</div>
        </div>
        <span
          ref={textRef}
          className="island-text"
          style={{ opacity: textOpacity, transform: textTransform, transition: textTransition }}
          onPointerDown={handleTextPointerDown}
          onPointerMove={handleTextPointerMove}
          onPointerUp={handleTextPointerUp}
          onPointerCancel={handleTextPointerUp}
          onDoubleClick={agentActive ? undefined : (onTextDoubleClick ?? undefined)}
        >
          {showingScrub ? null : visibleText}
          {!showingScrub && textTruncated && <span className="text-truncate-ellipsis">…</span>}
          {!showingScrub && (agentActive ? agent.status === 'thinking' : isLoading) && (
            <span className="text-ellipsis" aria-hidden="true">
              <span className="dot" />
              <span className="dot" />
              <span className="dot" />
            </span>
          )}
        </span>
      </div>
      {/* 拖动中:粒子时间画布覆盖标题文字区域居中显示(指针穿透,不影响进度条拖动) */}
      {showingScrub && (
        <ParticleTime
          seconds={scrubSeconds}
          centerX={TEXT_LEFT_PX - 1 + scrubTitleWidth / 2}
          color={theme}
        />
      )}
      {/* 长按展开:更大的圆角矩形控制面板,收纳媒体信息、进度与播放控制;
          双视图:媒体控制(默认) / 播放列表(可上传音乐) */}
      {expanded && (
        <div className="island-panel">
          {panelView === 'control' ? (
            <ControlView
              state={state}
              track={track}
              showUploadPrompt={showUploadPrompt}
              panelHasControls={panelHasControls}
              showBar={showBar}
              position={position}
              duration={duration}
              displayRatio={displayRatio}
              scrubbing={scrubbing}
              scrubRatio={scrubRatio}
              hint={hint}
              theme={theme}
              playlist={playlist}
              systemActive={systemActive}
              systemPlatform={systemPlatform}
              mode={mode}
              prevMode={prevMode}
              modeSupported={modeSupported}
              lyrics={lyrics}
              lyricShown={lyricShown}
              lyricFold={lyricFold}
              onToggleLyric={() => setLyricShown((v) => !v)}
              onToggleSource={onToggleSource}
              onPlayTrack={onPlayTrack}
              onCycleMode={onCycleMode}
              onPrev={onSwipeLeft}
              onNext={onSwipeRight}
              onPlayPause={onTextDoubleClick}
              onChangeView={setPanelView}
              onCollapse={() => changeExpanded(false)}
              settingsButton={settingsButton}
              fileInputRef={fileInputRef}
              panelBarRef={panelBarRef}
              onBarPointerDown={handleBarPointerDown}
              onBarPointerMove={handleBarPointerMove}
              onBarPointerUp={handleBarPointerUp}
              onBarKeyDown={handleBarKeyDown}
            />
          ) : panelView === 'list' ? (
            <ListView
              playlist={playlist}
              playlistIndex={playlistIndex}
              onPlayTrack={onPlayTrack}
              onTogglePlay={onTogglePlay}
              onRemoveTrack={onRemoveTrack}
              fileInputRef={fileInputRef}
              onBack={() => setPanelView('control')}
            />
          ) : null}
          {/* 主题色视图:预设色板(跟随播放模式 + 常用色)+
              复用字体取色器(SV 面 + 色相条)+ hex 输入 */}
          {panelView === 'theme' && onThemeChange ? (
            <ThemeView
              customTheme={customTheme}
              theme={theme}
              onRipple={triggerRipple}
              islandRef={islandRef}
              onThemeChange={onThemeChange}
              onBack={() => setPanelView('settings')}
            />
          ) : null}
          {/* 自定义背景视图(托盘菜单入口,岛内打开):
              一键上传即应用(cover 居中),之后可用双形态蒙版裁切;
              裁切/视口/上传逻辑自包含在 BackgroundView */}
          {panelView === 'background' && onBackgroundChange ? (
            <BackgroundView
              bgTarget={bgTarget}
              expandedImage={expandedImage}
              compactImage={compactImage}
              backgroundOpacity={backgroundOpacity}
              backgroundCrop={crop}
              onBackgroundChange={onBackgroundChange}
              onTargetChange={setBgTarget}
              imageLibraryAvailable={Boolean(onImageLibraryChange)}
              onOpenImageLibrary={() => setPanelView('image-library')}
              onBack={() => setPanelView('settings')}
            />
          ) : null}
          {/* 帮助手册视图(托盘菜单入口,岛内打开):操作引导列表 */}
          {panelView === 'help' ? <HelpView onBack={() => setPanelView('settings')} /> : null}
          {/* 设置视图(托盘菜单入口,岛内打开):设置类功能的总入口,
              自定义背景 / 帮助手册 / 主题色按宿主能力显隐 */}
          {panelView === 'settings' ? (
            <SettingsView
              onOpenBackground={onBackgroundChange ? () => setPanelView('background') : undefined}
              onOpenHelp={() => setPanelView('help')}
              onOpenTheme={onThemeChange ? () => setPanelView('theme') : undefined}
              onOpenFont={onFontAdd || onFontLibraryChange ? () => setPanelView('font') : undefined}
              onOpenAgent={agentConfig ? () => setPanelView('agent-settings') : undefined}
              onBack={() => changeExpanded(false)}
            />
          ) : null}
          {/* Agent 聊天视图(agent 模式展开默认;只保留长按收回,
              设置类视图除外) */}
          {panelView === 'agent' && agent ? (
            <AgentView
              {...agent}
              onCollapse={() => changeExpanded(false)}
              onHeightChange={setAgentPanelH}
            />
          ) : null}
          {/* Agent 设置(设置视图"Agent 设置"入口,设置类视图:只能经返回键退出):
              API Key / Base URL / 模型 / 系统提示词,持久化走主进程 settings.json */}
          {panelView === 'agent-settings' && agentConfig ? (
            <AgentSettingsView
              config={agentConfig.config}
              onSave={agentConfig.onSave}
              scale={agentScale}
              onScaleChange={handleAgentScaleChange}
              onBack={() => setPanelView('settings')}
            />
          ) : null}
          {/* 字体设置视图(设置视图"字体"入口,岛内打开):
              上传自定义字体(注入 @font-face 应用到岛体全部文字)、
              字体颜色:自动(按背景亮度选黑/白保证可读)或自定义色 */}
          {panelView === 'font' && (onFontAdd || onFontLibraryChange) ? (
            <FontView
              fontLibrary={fontLibrary}
              fontDataUrl={fontDataUrl}
              fontFamilyName={fontFamilyName}
              fontError={fontError}
              fontWeight={fontWeight}
              fontColor={fontColor}
              onFontWeightChange={onFontWeightChange}
              onFontSelect={onFontSelect}
              onFontAdd={onFontAdd}
              onFontColorChange={onFontColorChange}
              onError={showFontError}
              onOpenLibrary={() => setPanelView('font-library')}
              onOpenColorView={() => setPanelView('font-color')}
              onBack={() => setPanelView('settings')}
            />
          ) : null}
          {/* 自定义颜色页(字体视图"自定义"入口,岛内打开):
              预设色板 + 岛内自绘取色器(SV 面 + 色相条)+ hex 输入 */}
          {panelView === 'font-color' && onFontColorChange ? (
            <FontColorView
              fontColor={fontColor}
              onFontColorChange={onFontColorChange}
              onBack={() => setPanelView('font')}
            />
          ) : null}
          {/* 字体库页面(字体视图"字体库"入口,岛内打开,大面板):
              搜索 / 列表(点击应用、行内编辑名称、删除)/ 上传入库 */}
          {panelView === 'font-library' && onFontLibraryChange ? (
            <FontLibraryView
              fontLibrary={fontLibrary}
              currentFontId={currentFontId}
              onFontSelect={onFontSelect}
              onFontLibraryChange={onFontLibraryChange}
              onFontAdd={onFontAdd}
              onError={showFontError}
              onBack={() => setPanelView('font')}
            />
          ) : null}
          {/* 图片库页面(背景视图"图片库"入口,岛内打开,大面板):
              搜索 / 网格(点击应用当前形态、行内编辑名称、删除)/ 上传入库 */}
          {panelView === 'image-library' && onImageLibraryChange ? (
            <ImageLibraryView
              imageLibrary={imageLibrary}
              onImageLibraryChange={onImageLibraryChange}
              onBackgroundChange={onBackgroundChange}
              backgroundOpacity={backgroundOpacity}
              expandedImage={expandedImage}
              compactImage={compactImage}
              bgTarget={bgTarget}
              expandedCrop={expandedCrop}
              compactCrop={compactCrop}
              onBack={() => setPanelView('background')}
            />
          ) : null}
          {/* 上传音乐文件选择(隐藏输入,由"上传音乐"按钮触发;
              字体/背景上传输入已下沉到各自视图) */}
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*"
            multiple
            hidden
            onClick={(event) => event.stopPropagation()}
            onChange={handleFileChange}
          />
        </div>
      )}
      {/* 主题色切换的跑马灯流体动画:从触发位置扩散的颜色涟漪 + 扫过岛体的色带 */}
      {ripple && (
        <div
          key={ripple.id}
          className="island-ripple"
          style={
            {
              '--ripple-color': ripple.color,
              '--rx': `${ripple.x}px`,
              '--ry': `${ripple.y}px`,
            } as CSSProperties
          }
          aria-hidden="true"
        />
      )}
      {/* 进度条仅媒体状态(播放/加载/暂停)渲染,成功/警告/错误不出现;
          悬停时从文字尾部后滑出,有确定进度时可拖动/点击/键盘控制;
          展开期间不渲染(由展开面板内的全宽进度条接管) */}
      {!expanded && showBar && (
        <div
          ref={barRef}
          className={`island-extra${duration > 0 ? ' seekable' : ''}${scrubbing ? ' scrubbing' : ''}`}
          role={duration > 0 ? 'slider' : undefined}
          tabIndex={duration > 0 ? 0 : undefined}
          aria-label="播放进度"
          aria-valuemin={duration > 0 ? 0 : undefined}
          aria-valuemax={duration > 0 ? duration : undefined}
          aria-valuenow={duration > 0 ? position : undefined}
          aria-valuetext={
            duration > 0 ? `${formatTime(position)} / ${formatTime(duration)}` : undefined
          }
          // --progress-ratio 供填充比例使用
          style={{ '--progress-ratio': displayRatio } as CSSProperties}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation()
            handleBarKeyDown(event)
          }}
          onPointerDown={(event) => barRef.current && handleBarPointerDown(event, barRef.current)}
          onPointerMove={(event) => barRef.current && handleBarPointerMove(event, barRef.current)}
          onPointerUp={(event) => barRef.current && handleBarPointerUp(event, barRef.current)}
          onPointerCancel={(event) => barRef.current && handleBarPointerUp(event, barRef.current)}
        >
          <div className={`island-progress${duration > 0 ? ' island-progress--determinate' : ''}`}>
            {duration > 0 && <div className="island-progress-fill" />}
          </div>
        </div>
      )}
    </div>
  )
})
