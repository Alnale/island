import {
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
import { PLAY_MODES, type PlaybackMode } from '../../media/playbackModes'
import { downscaleBackgroundImage } from '../../media/backgroundStore'
import { ParticleTime } from './ParticleTime'
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
  /** 背景图不透明度 0-1 */
  backgroundOpacity?: number
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
    opacity: number
    expanded: { zoom: number; posX: number; posY: number }
    compact: { zoom: number; posX: number; posY: number }
  }) => void
  /** 外部请求打开背景编辑器(托盘菜单):seq 变化即展开并切换到背景视图 */
  requestBackgroundSeq?: number
  /** 面板视图变化回调(宿主据此调整窗口高度:背景视图需要更高空间) */
  onPanelViewChange?: (view: 'control' | 'list' | 'theme' | 'background') => void
  /** 面板控制区显示"自定义背景"按钮(Web 演示入口;桌面端入口在托盘菜单) */
  backgroundButton?: boolean
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

// 动画时序(与 CSS 中宽度过渡 0.5s 保持同步)
/** 主题色预设(与播放模式/状态色同一色系,供主题色视图) */
const THEME_PRESETS = ['#4ade80', '#60a5fa', '#a78bfa', '#f87171', '#fbbf24', '#22d3ee', '#f472b6']

/** HEX → RGB(自定义取色输入用) */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return { r: 74, g: 222, b: 128 }
  const n = parseInt(m[1], 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

/** RGB → HEX */
function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

const FADE_OUT_MS = 130 // 文字上移淡出时长
const TEXT_SWAP_MS = 140 // 淡出完成后换新文字
const FADE_IN_MS = 240 // 新文字上移淡入时长
const FADE_IN_DELAY_MS = 450 // 宽度回弹基本结束后再淡入,避免缩小回弹时文字被裁剪
const FADE_IN_FAST_MS = 40 // 宽度无需变化时快速淡入
const TEXT_RISE_PX = 6 // 文字滑动距离
const MAX_WIDTH_PX = 500 // 与 CSS max-width 保持一致
// 岛体固定内容宽度(不含文字):边框 2 + 内边距 56 + 图标 28 + 单段 gap 14(进度条已绝对定位)
const ISLAND_BASE_PX = 100
// 文字元素左偏移:边框 1 + 内边距 28 + 图标 28 + gap 14(相对岛 border-box 左缘)
const TEXT_LEFT_PX = 71
// 进度条:宽度 130 + 距岛右缘 30(内边距 28 + 边框 2)
const PROGRESS_WIDTH_PX = 130
const PROGRESS_RIGHT_MARGIN_PX = 30
// 进度条左缘与文字尾部之间的间距(悬停时防止进度条贴字;
// 渐隐时保证渐隐终点到进度条左缘之间有纯黑间隔,不与半透明文字叠加)
const BAR_TAIL_GAP_PX = 14
// 悬停展开增量:让进度条排在文字尾部之后(文字左偏移 + 进度条总占位 + 间距 - 岛基础宽)
const HOVER_EXTEND_PX = TEXT_LEFT_PX + PROGRESS_WIDTH_PX + PROGRESS_RIGHT_MARGIN_PX + BAR_TAIL_GAP_PX - ISLAND_BASE_PX
// 省略号占位宽度(font-size 0.95rem ≈ 15px) + 余量
const ELLIPSIS_SLOT_PX = 18
// 无需让位时的遮罩宽度:把渐变末 12% 的渐隐区整体推出文字右缘之外,文字完全不透明
const MASK_NO_FADE = 'calc(100% + 20%)'
// 进度条键盘方向键步进(秒)
const SEEK_STEP_SEC = 5
// 文字区滑动手势判定阈值(px):横向位移超过该值且明显大于纵向时触发
const SWIPE_THRESHOLD_PX = 36
// 文字区歌曲名/歌手名循环切换间隔(原 3s,调慢 3 倍避免频繁轮播)
const TRACK_CYCLE_MS = 9000
// 长按触发展开的持续时间(ms),参考 iOS 长按手感
const LONG_PRESS_MS = 450
// 长按判定允许的指针位移(px):移动超过该值视为滑动/拖动,取消长按
const LONG_PRESS_SLOP_PX = 8
// 展开后的岛宽(px):胶囊形变为更大的圆角矩形
const EXPANDED_WIDTH_PX = 400
// 展开岛宽距视口左右的最小边距(px)
const EXPANDED_VIEWPORT_MARGIN_PX = 80
// 展开最小宽度(px),小屏兜底
const EXPANDED_MIN_WIDTH_PX = 240
// 收起后隐藏悬停进度条的时长(ms),等岛收缩完成再淡入(1.5 倍速)
const COLLAPSE_HIDE_MS = 320
// suppressClick 标记的有效期(ms):长按松手后的 click 在此窗口内被吞,
// 过期自动清除(面板按钮点击不触发岛 click,防止标记滞留吞掉后续收起点击)
const SUPPRESS_CLICK_MS = 600
// 形变动画期间关闭毛玻璃的时长(ms),略长于宽度/高度弹簧过渡(1.5 倍速)
const MORPH_ANIMATE_MS = 400
// 播放模式图标"线条重组"动画时长(ms),含涟漪清理
const MODE_ICON_MORPH_MS = 420

/**
 * 文字位移动画阶段:
 * - idle: 初始静止
 * - out:  上移淡出中(transform 0 → -rise)
 * - below: 已换内容,藏在下方等宽度回弹结束(opacity 0,transform +rise,不可见)
 * - in:   从下方上移淡入(+rise → 0)
 */
type TextMotion = 'idle' | 'out' | 'below' | 'in'

/** canvas 文本宽度测量(与 DOM 渲染同字体,结果一致) */
let textMeasureCanvas: HTMLCanvasElement | null = null

function measureTextWidth(text: string, font: string): number {
  if (!textMeasureCanvas) textMeasureCanvas = document.createElement('canvas')
  const ctx = textMeasureCanvas.getContext('2d')
  if (!ctx) return text.length * 15
  ctx.font = font
  return ctx.measureText(text).width
}

/**
 * 将文字截断到可用宽度以内,尾部由省略号元素承接。
 * 二分查找最大可见前缀,保证截断后的宽度严格不超限。
 * 仅用于非悬停场景:悬停时若放不下则改用 mask 渐隐让位。
 */
function truncateText(
  text: string,
  maxWidth: number,
  font: string,
): { visible: string; truncated: boolean } {
  if (measureTextWidth(text, font) <= maxWidth) {
    return { visible: text, truncated: false }
  }
  let lo = 1
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (measureTextWidth(text.slice(0, mid), font) <= maxWidth) lo = mid
    else hi = mid - 1
  }
  return { visible: text.slice(0, lo), truncated: true }
}

/**
 * 播放模式图标(顺序/单曲循环/随机):
 * 所有线条 pathLength=1 归一化,配合 CSS 的 stroke-dasharray 做
 * "旧线条擦除 → 新线条画出"的重组动画
 */
function ModeIcon({ mode, className }: { mode: PlaybackMode; className?: string }) {
  const base = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  } as const
  if (mode === 'repeat-one') {
    return (
      <svg className={className} width="16" height="16" viewBox="0 0 24 24" {...base}>
        <path pathLength={1} d="M17 2l4 4-4 4" />
        <path pathLength={1} d="M3 11v-1a4 4 0 0 1 4-4h14" />
        <path pathLength={1} d="M7 22l-4-4 4-4" />
        <path pathLength={1} d="M21 13v1a4 4 0 0 1-4 4H3" />
        <path pathLength={1} d="M11 10h1v4" />
      </svg>
    )
  }
  if (mode === 'shuffle') {
    return (
      <svg className={className} width="16" height="16" viewBox="0 0 24 24" {...base}>
        <polyline pathLength={1} points="16 3 21 3 21 8" />
        <line pathLength={1} x1="4" y1="20" x2="21" y2="3" />
        <polyline pathLength={1} points="21 16 21 21 16 21" />
        <line pathLength={1} x1="15" y1="15" x2="21" y2="21" />
        <line pathLength={1} x1="4" y1="4" x2="9" y2="9" />
      </svg>
    )
  }
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" {...base}>
      <polyline pathLength={1} points="17 1 21 5 17 9" />
      <path pathLength={1} d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline pathLength={1} points="7 23 3 19 7 15" />
      <path pathLength={1} d="M21 13v2a4 4 0 0 1-4 4H3" />
    </svg>
  )
}

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
 * 应用文字尾部渐隐遮罩与进度条位置。
 * 渐隐只在悬停且"完整文字 + 进度条放不下"(目前仅播放中长文字)时启用:
 * - 非悬停或放得下:文字完全不渐隐,进度条从文字尾部后 BAR_TAIL_GAP_PX 处滑出
 * - 悬停且放不下:文字尾部渐隐让位,渐隐终点(文字完全透明点)提前到进度条
 *   左缘之前(BAR_TAIL_GAP_PX),进度条下方为纯黑背景,不与半透明文字叠加
 */
function applyTextLayout(
  island: HTMLElement,
  textEl: HTMLElement,
  fullTextWidth: number,
  targetWidth: number,
  hovered: boolean,
) {
  const textWidth = textEl.scrollWidth // 可见文字布局宽度(含省略号,不受 mask 影响)
  const textRight = TEXT_LEFT_PX + textWidth
  // 完整文字 + 进度条是否超出岛宽上限(统一用 MAX_WIDTH_PX 判断,避免
  // 与 targetWidth 的取整/浮点差异导致误判,如 91.2+231 vs 322)
  const conflicts =
    fullTextWidth + PROGRESS_WIDTH_PX + PROGRESS_RIGHT_MARGIN_PX + TEXT_LEFT_PX >
    MAX_WIDTH_PX
  const fadeEnd =
    hovered && conflicts
      ? targetWidth - PROGRESS_WIDTH_PX - PROGRESS_RIGHT_MARGIN_PX - BAR_TAIL_GAP_PX
      : hovered
        ? textRight + BAR_TAIL_GAP_PX
        : textRight
  if (fadeEnd >= textRight) {
    // 非悬停或放得下:不需要让位,渐隐区推出文字右缘之外,文字完全不透明
    textEl.style.setProperty('--mask-width', MASK_NO_FADE)
  } else {
    textEl.style.setProperty('--mask-width', `${fadeEnd - TEXT_LEFT_PX}px`)
  }
  // absolute left 相对岛的 padding box(比 border-box 少 1px 边框)。
  // 进度条是文字元素的兄弟节点,变量需设在岛元素上才能被它继承
  island.style.setProperty('--extra-left', `${fadeEnd - 1}px`)
}

/**
 * 测量灵动岛当前内容的自然宽度。
 *
 * 测量期间临时关闭过渡:若带着过渡恢复"旧宽度",浏览器会把这一步注册成
 * 一次"自然宽度→旧宽度"的过渡,之后设置新宽度时过渡被重定向,起点≈终点,
 * 宽度动画会坍缩成不可见的瞬移。关闭过渡可保证后续"旧宽度→自然宽度"
 * 是一次干净的回弹过渡(px→px 可插值,auto 不可插值)。
 */
function measureNaturalWidth(island: HTMLElement): number {
  const prevWidth = island.style.width
  const prevTransition = island.style.transition
  island.style.transition = 'none'
  island.style.width = 'auto'
  void island.offsetWidth
  const width = Math.min(island.offsetWidth, MAX_WIDTH_PX)
  island.style.width = prevWidth
  void island.offsetWidth
  island.style.transition = prevTransition
  return width
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
export function DynamicIsland({
  state,
  track,
  position = 0,
  duration = 0,
  onSeek,
  onChange,
  onHoverChange,
  onSwipeLeft,
  onSwipeRight,
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
  requestBackgroundSeq,
  onPanelViewChange,
  backgroundButton,
  ref,
}: DynamicIslandProps) {
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
  // 展开面板视图:媒体控制 / 播放列表 / 主题色 / 自定义背景
  const [panelView, setPanelView] = useState<'control' | 'list' | 'theme' | 'background'>('control')
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
  // 自定义 RGB 输入(右侧常驻取色):输入防抖后触发流体动画
  const [rgb, setRgb] = useState(() => hexToRgb(customTheme ?? THEME_PRESETS[0]))
  const rgbDebounceRef = useRef(0)
  useEffect(() => {
    setRgb(hexToRgb(customTheme ?? THEME_PRESETS[0]))
  }, [customTheme])
  const handleRgbChange = (channel: 'r' | 'g' | 'b', value: number) => {
    const next = { ...rgb, [channel]: value }
    setRgb(next)
    const hex = rgbToHex(next.r, next.g, next.b)
    onThemeChange?.(hex)
    // 连续输入只触发最后一次流体动画
    window.clearTimeout(rgbDebounceRef.current)
    rgbDebounceRef.current = window.setTimeout(() => {
      const rect = islandRef.current?.getBoundingClientRect()
      triggerRipple(hex, rect ? rect.width / 2 : 200, rect ? 44 : 100)
    }, 300)
  }
  // 首页歌词显示开关(点击音乐图标切换)
  const [lyricShown, setLyricShown] = useState(true)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // 背景图片上传输入(自定义背景视图)
  const bgFileInputRef = useRef<HTMLInputElement>(null)
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
  // 同套切换动画,不额外加气泡),展开态由面板在播放键下方渲染
  const text =
    hint && !expanded
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
  const showBar = progressMode !== 'none'
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
  // 裁切参考尺寸:展开态 400×244、紧凑态 280×56(挂件典型宽度);
  // 两种 UI 形态各自独立的裁切参数,互不影响
  const BG_CROP_REF_W = 400
  const BG_CROP_REF_H = 244
  const BG_COMPACT_REF_W = 280
  const BG_COMPACT_REF_H = 56
  const DEFAULT_CROP = { zoom: 1, posX: 50, posY: 50 }
  const crop = backgroundCrop ?? { expanded: DEFAULT_CROP, compact: DEFAULT_CROP }
  const expandedCrop = crop.expanded
  const compactCrop = crop.compact
  // 当前编辑目标(展开态 / 紧凑态):视口蒙版与滑杆作用于该形态
  const [bgTarget, setBgTarget] = useState<'expanded' | 'compact'>('expanded')
  const expandedImage = backgroundExpandedImage ?? null
  const compactImage = backgroundCompactImage ?? null
  const activeImage = bgTarget === 'expanded' ? expandedImage : compactImage
  const activeCrop = bgTarget === 'expanded' ? expandedCrop : compactCrop
  // 各形态背景图的自然尺寸(计算 cover 基准与可平移余量)
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
  // 背景尺寸 %(相对元素宽度):1x = cover;null = 图片尺寸未知(加载中)
  const bgSizePctFor = (refW: number, refH: number, zoom: number, w: number, h: number): number =>
    Math.max(100, (refH / refW) * (w / h) * 100) * zoom
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
  const bgStyleFor = (
    image: string,
    sizePct: number | null,
    posX: number,
    posY: number,
  ): CSSProperties => ({
    backgroundImage: `url("${image}")`,
    backgroundSize: sizePct ? `${sizePct}%` : 'cover',
    backgroundPosition: sizePct ? `${posX}% ${posY}%` : '50% 50%',
  })
  // 更新当前编辑目标的裁切参数(另一形态的图片与裁切均不受影响)
  const patchActiveCrop = (patch: Partial<{ zoom: number; posX: number; posY: number }>) => {
    if (!onBackgroundChange) return
    const next = { ...activeCrop, ...patch }
    onBackgroundChange({
      expandedImage,
      compactImage,
      opacity: backgroundOpacity ?? 0.4,
      expanded: bgTarget === 'expanded' ? next : expandedCrop,
      compact: bgTarget === 'compact' ? next : compactCrop,
    })
  }
  // 裁切视口拖拽平移:拖动图片选择可见区域(位置 % 相对"图片超出视口"的余量)
  const bgPanRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    startPosX: number
    startPosY: number
  } | null>(null)
  const handleBgPanDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !onBackgroundChange) return
    event.currentTarget.setPointerCapture(event.pointerId)
    bgPanRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startPosX: activeCrop.posX,
      startPosY: activeCrop.posY,
    }
  }
  const handleBgPanMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const pan = bgPanRef.current
    if (!pan || event.pointerId !== pan.pointerId || !onBackgroundChange) return
    const natural = bgTarget === 'expanded' ? bgNaturalE : bgNaturalC
    if (!natural) return
    const sizePct = bgTarget === 'expanded' ? bgSizeExpanded : bgSizeCompact
    if (sizePct === null) return
    const el = event.currentTarget
    const vw = el.clientWidth
    const vh = el.clientHeight
    const overflowW = (sizePct / 100 - 1) * vw
    const overflowH = (sizePct / 100) * vw * (natural.h / natural.w) - vh
    const dx = event.clientX - pan.startX
    const dy = event.clientY - pan.startY
    const clamp01 = (v: number) => Math.max(0, Math.min(100, v))
    const nextX = overflowW > 0 ? clamp01(pan.startPosX - (dx / overflowW) * 100) : 50
    const nextY = overflowH > 0 ? clamp01(pan.startPosY - (dy / overflowH) * 100) : 50
    if (nextX !== activeCrop.posX || nextY !== activeCrop.posY) {
      patchActiveCrop({ posX: nextX, posY: nextY })
    }
  }
  const handleBgPanEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    const pan = bgPanRef.current
    if (pan && pan.pointerId === event.pointerId) bgPanRef.current = null
  }
  // 滚轮缩放(以视口中心为锚:位置 % 不变,中心内容保持)
  const handleBgWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!onBackgroundChange) return
    event.preventDefault()
    const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1
    const next = Math.max(1, Math.min(4, activeCrop.zoom * factor))
    if (next === activeCrop.zoom) return
    patchActiveCrop({ zoom: next })
  }
  // 双击复位当前形态的裁切(cover 居中)
  const handleBgDoubleClick = () => {
    if (!onBackgroundChange) return
    if (activeCrop.zoom === 1 && activeCrop.posX === 50 && activeCrop.posY === 50) return
    patchActiveCrop({ zoom: 1, posX: 50, posY: 50 })
  }

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
  // 纵向位移过大视为误触;仅绑定了手势回调时启用
  const hasTextGestures = Boolean(onSwipeLeft || onSwipeRight)
  const handleTextPointerDown = (event: PointerEvent<HTMLSpanElement>) => {
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
    if (dx > 0) onSwipeRight?.()
    else onSwipeLeft?.()
  }
  const handleTextPointerUp = (event: PointerEvent<HTMLSpanElement>) => {
    const gesture = swipeRef.current
    if (gesture && gesture.pointerId === event.pointerId) swipeRef.current = null
  }

  /** 切换展开状态并通知外部(供暂停/恢复自动演示) */
  const changeExpanded = useCallback((value: boolean) => {
    if (value === expandedRef.current) return
    setExpanded(value)
    onExpandChangeRef.current?.(value)
    // 形变动画期:关闭背景毛玻璃(backdrop 每帧重采样是卡顿主因)
    setAnimating(true)
    window.clearTimeout(animatingTimerRef.current)
    animatingTimerRef.current = window.setTimeout(() => setAnimating(false), MORPH_ANIMATE_MS)
    // 收起时清掉残留的拖动状态与面板视图(拖动中收起可能不触发 bar 的 pointerup)
    if (!value) {
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
    }
  }, [])

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

  /** 上传背景图:读取为 data URL 后一键应用(cover 居中),之后可裁切微调 */
  const handleBackgroundFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !onBackgroundChange) return
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        // 先降采样(形变逐帧重栅格化大图是卡顿主因),再一键应用到当前形态
        // (该形态 cover 居中,另一形态的图片与裁切不受影响)
        void downscaleBackgroundImage(reader.result).then((small) => {
          onBackgroundChange({
            expandedImage: bgTarget === 'expanded' ? small : expandedImage,
            compactImage: bgTarget === 'compact' ? small : compactImage,
            opacity: backgroundOpacity ?? 0.4,
            expanded: bgTarget === 'expanded' ? DEFAULT_CROP : expandedCrop,
            compact: bgTarget === 'compact' ? DEFAULT_CROP : compactCrop,
          })
        })
      }
    }
    reader.readAsDataURL(file)
  }

  // 长按:紧凑态长按展开,展开态长按收起——按到 450ms 直接形变,不等待松手。
  // 压感全程渐进(无静止停顿);触发收起时保持最深压感并行收缩(一边 3D 压感
  // 一边收起),松手或动画结束后回弹归位
  const handleIslandPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    // 仅响应左键:右键不触发按压/长按(右键拖拽已移除,右键按下不做任何事)
    if (event.button !== 0) return
    // 背景编辑器视图:禁用按压/长按收起(裁切视口/控件的点按会冒泡到这里,
    // 只能通过返回键收起),避免编辑中被误缩回
    if (panelView === 'background') return
    const prev = pressRef.current
    if (prev) window.clearTimeout(prev.timer)
    const startX = event.clientX
    const startY = event.clientY
    pressIslandAt(event)
    if (expandedRef.current) {
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
          // 压感回弹与收缩同步并行(同为 0.5s 弹簧,同时结束,
          // 避免收起动画结束后才回弹造成的"动画 UI 与静态 UI 冲突"抖动)
          releasePress()
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
    // 展开状态:点按岛体收起(背景编辑器视图除外——只能通过返回键)
    if (expandedRef.current) {
      if (panelView !== 'background') changeExpanded(false)
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
      // 背景编辑器视图:Esc 不收起(只能通过返回键)
      if (panelView !== 'background') {
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

  // 展开期间:点按岛外任意位置或按 Esc 收起(背景编辑器视图除外——
  // 只能通过返回键收起,避免编辑中被误缩回)
  useEffect(() => {
    if (!expanded) return
    const onDocPointerDown = (event: globalThis.PointerEvent) => {
      const island = islandRef.current
      if (island && !island.contains(event.target as Node) && panelView !== 'background') {
        changeExpanded(false)
      }
    }
    const onDocKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && panelView !== 'background') changeExpanded(false)
    }
    document.addEventListener('pointerdown', onDocPointerDown)
    document.addEventListener('keydown', onDocKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown)
      document.removeEventListener('keydown', onDocKeyDown)
    }
  }, [expanded, changeExpanded, panelView])

  // 外部请求(托盘菜单"自定义背景")打开面板视图:seq 变化即展开并切换
  useEffect(() => {
    if (!requestBackgroundSeq) return
    setPanelView('background')
    setExpandedWidth(
      Math.max(
        EXPANDED_MIN_WIDTH_PX,
        Math.min(EXPANDED_WIDTH_PX, window.innerWidth - EXPANDED_VIEWPORT_MARGIN_PX),
      ),
    )
    changeExpanded(true)
  }, [requestBackgroundSeq, changeExpanded])

  // 面板视图变化通知宿主(背景视图需要更高的岛体与窗口)
  useEffect(() => {
    onPanelViewChange?.(panelView)
  }, [panelView, onPanelViewChange])

  // 卸载时清理长按计时器 / 按压渐进循环 / 收起与动画延迟
  useEffect(
    () => () => {
      const press = pressRef.current
      if (press) window.clearTimeout(press.timer)
      cancelAnimationFrame(pressRafRef.current)
      window.clearTimeout(collapseTimerRef.current)
      window.clearTimeout(animatingTimerRef.current)
      window.clearTimeout(suppressTimerRef.current)
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
      className={`island-demo${stateClass ? ` ${stateClass}` : ''}${modeClass ? ` ${modeClass}` : ''}${expanded ? ' expanded' : ''}${press ? ' is-pressed' : ''}${collapsing ? ' island-collapsing' : ''}${animating ? ' is-animating' : ''}${lyricFold ? ' island-lyric-off' : ''}${panelView === 'background' ? ' island-bg-view' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`灵动岛,当前状态:${ISLAND_STATES[state].label},点击切换,长按展开`}
      aria-expanded={expanded}
      style={
        {
          width: expanded ? `${expandedWidth}px` : islandWidth,
          '--state-color': theme,
          transform: pressTransform,
          transformOrigin: pressOrigin,
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
                opacity: backgroundOpacity ?? 1,
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
      <div className="island-content">
        <div className="island-icon">
          <div className="icon-floater">{ISLAND_STATES[state].icon(state)}</div>
        </div>
        <span
          ref={textRef}
          className="island-text"
          style={{ opacity: textOpacity, transform: textTransform, transition: textTransition }}
          onPointerDown={handleTextPointerDown}
          onPointerMove={handleTextPointerMove}
          onPointerUp={handleTextPointerUp}
          onPointerCancel={handleTextPointerUp}
          onDoubleClick={onTextDoubleClick ?? undefined}
        >
          {showingScrub ? null : visibleText}
          {!showingScrub && textTruncated && <span className="text-truncate-ellipsis">…</span>}
          {!showingScrub && isLoading && (
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
          {panelView === 'control' && showUploadPrompt ? (
            /* 空播放列表:整个面板居中显示上传引导(提示下方是上传按钮) */
            <div className="island-panel-empty">
              <p className="island-panel-empty-text">本地暂无音乐,上传后即可播放</p>
              <button
                type="button"
                className="island-ctl island-ctl--upload"
                onClick={(event) => {
                  event.stopPropagation()
                  fileInputRef.current?.click()
                }}
              >
                <svg
                  className="island-ctl-svg"
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                <span>上传音乐</span>
              </button>
            </div>
          ) : panelView === 'control' ? (
            <>
          <div className="island-panel-head">
            {/* 图标列:音乐图标(点击切换本地播放器/系统监听数据源)+ 图标下方当前数据源标签 */}
            <div className="island-panel-icon-col">
              <button
                type="button"
                className="island-icon island-panel-icon island-panel-icon-btn"
                aria-label="切换本地播放/系统监听"
                title="切换本地播放/系统监听"
                onClick={(event) => {
                  event.stopPropagation()
                  onToggleSource?.()
                }}
              >
                {ISLAND_STATES[state].icon(`panel-${state}`)}
              </button>
              <span className="island-panel-icon-tag">
                {systemActive && systemPlatform
                  ? systemPlatform.label
                  : ISLAND_STATES[state].label}
              </span>
            </div>
            <div className="island-panel-meta">
              {/* 主行:歌名(可省略)+ 粒子时间(与歌名同行,flex 内嵌不重叠) */}
              <div className="island-panel-main-row">
                <span className="island-panel-title">
                  {track
                    ? track.title
                    : showUploadPrompt
                      ? '本地暂无音乐'
                      : ISLAND_STATES[state].text}
                </span>
                <ParticleTime
                  seconds={scrubbing && scrubRatio !== null ? scrubRatio * duration : position}
                  centerX={0}
                  color={theme}
                  inline
                />
              </div>
              {/* 歌手行始终占位(空内容也保留行高),避免进度条位置随曲目信息位移 */}
              <span className="island-panel-artist">{track?.artist ?? ''}</span>
            </div>
          </div>
          {/* 双行歌词:面板级绝对定位(水平居中、固定在歌手行下方),
              脱离文档流——歌词显隐不影响进度条/控制键位置 */}
          <div
            className={`island-panel-lyric-inline${lyricFold ? ' lyric-hidden' : ''}`}
            key={lyrics?.currentIndex ?? -1}
          >
            <p
              className={`island-lyric-line${lyricShown && lyrics && lyrics.lines.length > 0 ? ' active' : ''}`}
            >
              {lyricShown && lyrics && lyrics.lines.length > 0
                ? lyrics.lines[lyrics.currentIndex >= 0 ? lyrics.currentIndex : 0]?.text ?? ''
                : ''}
            </p>
            <p className="island-lyric-line">
              {lyricShown && lyrics && lyrics.lines.length > 0
                ? lyrics.lines[lyrics.currentIndex + 1]?.text ?? ''
                : ''}
            </p>
          </div>

          {showBar && duration > 0 && (
            <div className="island-panel-progress-row">
              <span className="island-panel-time">0:00</span>
              <div
                ref={panelBarRef}
                className="island-panel-progress"
                role="slider"
                tabIndex={0}
                aria-label="播放进度"
                aria-valuemin={0}
                aria-valuemax={duration}
                aria-valuenow={scrubbing && scrubRatio !== null ? scrubRatio * duration : position}
                aria-valuetext={`${formatTime(position)} / ${formatTime(duration)}`}
                style={{ '--progress-ratio': displayRatio } as CSSProperties}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  event.stopPropagation()
                  handleBarKeyDown(event)
                }}
                onPointerDown={(event) =>
                  panelBarRef.current && handleBarPointerDown(event, panelBarRef.current)
                }
                onPointerMove={(event) =>
                  panelBarRef.current && handleBarPointerMove(event, panelBarRef.current)
                }
                onPointerUp={(event) =>
                  panelBarRef.current && handleBarPointerUp(event, panelBarRef.current)
                }
                onPointerCancel={(event) =>
                  panelBarRef.current && handleBarPointerUp(event, panelBarRef.current)
                }
              >
                <div className="island-panel-progress-fill" />
              </div>
              <span className="island-panel-time">{formatTime(duration)}</span>
            </div>
          )}
          {showBar && duration <= 0 && (
            <div className="island-panel-progress-row">
              <div className="island-panel-progress" aria-hidden="true">
                <div className="island-panel-progress-fill" />
              </div>
            </div>
          )}

          {/* 媒体状态:播放控制;通知状态:收起按钮 */}
          {panelHasControls ? (
            <div className="island-panel-controls">
              {/* 歌词开关:左下角(与播放列表并排) */}
              {lyrics && (
                <button
                  type="button"
                  className={`island-ctl island-ctl--lyric${lyricShown ? ' on' : ''}`}
                  aria-label={lyricShown ? '隐藏歌词' : '显示歌词'}
                  aria-pressed={lyricShown}
                  title={lyricShown ? '隐藏歌词' : '显示歌词'}
                  onClick={(event) => {
                    event.stopPropagation()
                    setLyricShown((v) => !v)
                  }}
                >
                  <svg
                    className="island-ctl-svg"
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M9 18V5l12-2v13" />
                    <circle cx="6" cy="18" r="3" />
                    <circle cx="18" cy="16" r="3" />
                  </svg>
                </button>
              )}
              {/* 播放列表入口:切换到列表视图(上传音乐/查看曲目);外部平台时隐藏 */}
              {!systemActive && playlist && onPlayTrack && (
                <button
                  type="button"
                  className="island-ctl island-ctl--list"
                  aria-label="播放列表"
                  title="播放列表"
                  onClick={(event) => {
                    event.stopPropagation()
                    setPanelView('list')
                  }}
                >
                  <svg
                    className="island-ctl-svg"
                    width="17"
                    height="17"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <line x1="8" y1="6" x2="21" y2="6" />
                    <line x1="8" y1="12" x2="21" y2="12" />
                    <line x1="8" y1="18" x2="21" y2="18" />
                    <line x1="3" y1="6" x2="3.01" y2="6" />
                    <line x1="3" y1="12" x2="3.01" y2="12" />
                    <line x1="3" y1="18" x2="3.01" y2="18" />
                  </svg>
                </button>
              )}
              {/* 主题色:右下角(模式按钮左侧),切换到主题色视图 */}
              {/* 自定义背景入口(仅 Web 演示显示;桌面端入口在托盘菜单):
                  切换到背景编辑器视图 */}
              {onBackgroundChange && backgroundButton && (
                <button
                  type="button"
                  className="island-ctl island-ctl--bg"
                  aria-label="自定义背景"
                  title="自定义背景"
                  onClick={(event) => {
                    event.stopPropagation()
                    setPanelView('background')
                  }}
                >
                  <svg
                    className="island-ctl-svg"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <path d="M21 15l-5-5L5 21" />
                  </svg>
                </button>
              )}
              {onThemeChange && (
                <button
                  type="button"
                  className="island-ctl island-ctl--theme"
                  aria-label="主题色"
                  title="主题色"
                  onClick={(event) => {
                    event.stopPropagation()
                    setPanelView('theme')
                  }}
                >
                  <svg
                    className="island-ctl-svg"
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 22a10 10 0 1 1 10-10c0 1.4-.9 2.6-2.2 2.6H16a2.6 2.6 0 0 0 0 5.2H14a3.6 3.6 0 0 0-2 2.2" />
                    <circle cx="7.5" cy="10.5" r="1.3" />
                    <circle cx="11" cy="7" r="1.3" />
                    <circle cx="15.5" cy="9" r="1.3" />
                  </svg>
                </button>
              )}
              {mode && onCycleMode && (
                <button
                  type="button"
                  className="island-ctl island-ctl--mode"
                  aria-label={`播放模式:${PLAY_MODES[mode].label}`}
                  title={
                    systemActive && !modeSupported
                      ? '当前平台不支持播放模式控制'
                      : PLAY_MODES[mode].label
                  }
                  disabled={systemActive && !modeSupported}
                  onClick={(event) => {
                    event.stopPropagation()
                    onCycleMode()
                  }}
                >
                  {/* 图标切换动画:旧图标线条擦除 + 新图标线条画出的"重组" */}
                  <span className="island-mode-icons" aria-hidden="true">
                    {prevMode && prevMode !== mode && (
                      <ModeIcon
                        key={`leave-${prevMode}`}
                        mode={prevMode}
                        className="island-mode-svg island-mode-svg--leave"
                      />
                    )}
                    <ModeIcon
                      key={`enter-${mode}`}
                      mode={mode}
                      className="island-mode-svg island-mode-svg--enter"
                    />
                  </span>
                </button>
              )}
              <button
                type="button"
                className="island-ctl island-ctl--prev"
                aria-label="上一首"
                onClick={(event) => {
                  event.stopPropagation()
                  onSwipeLeft?.()
                }}
              >
                <svg
                  className="island-ctl-svg"
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polygon points="19 20 9 12 19 4" />
                  <line x1="5" y1="19" x2="5" y2="5" />
                </svg>
              </button>
              <button
                type="button"
                className="island-ctl island-ctl--primary"
                aria-label={state === 'playing' ? '暂停' : '播放'}
                onClick={(event) => {
                  event.stopPropagation()
                  onTextDoubleClick?.()
                }}
              >
                {state === 'playing' ? (
                  /* 暂停:两条短粗圆角竖条(宽度 3.6、高 14、圆头),舒展不紧凑 */
                  <svg
                    className="island-ctl-svg"
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <rect x="6.8" y="5" width="3.6" height="14" rx="1.8" />
                    <rect x="13.6" y="5" width="3.6" height="14" rx="1.8" />
                  </svg>
                ) : (
                  /* 播放:饱满圆角三角形(粗描边圆角连接) */
                  <svg
                    className="island-ctl-svg"
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2.6}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M7.5 4.8v14.4L19.5 12z" />
                  </svg>
                )}
              </button>
              <button
                type="button"
                className="island-ctl island-ctl--next"
                aria-label="下一首"
                onClick={(event) => {
                  event.stopPropagation()
                  onSwipeRight?.()
                }}
              >
                <svg
                  className="island-ctl-svg"
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polygon points="5 4 15 12 5 20" />
                  <line x1="19" y1="5" x2="19" y2="19" />
                </svg>
              </button>
              {/* 操作提示:播放键正下方(纯文本,与面板次级文字同款,无气泡;
                  面板控制区始终贴底,提示固定落在按钮下方 16px 内边距区) */}
              {hint && (
                <div className="island-hint-play" role="status">
                  {hint}
                </div>
              )}
            </div>
          ) : (
            <div className="island-panel-dismiss">
              <button
                type="button"
                className="island-ctl"
                aria-label="收起"
                onClick={(event) => {
                  event.stopPropagation()
                  changeExpanded(false)
                }}
              >
                <svg
                  className="island-ctl-svg"
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
            </div>
          )}
            </>
          ) : panelView === 'list' ? (
            /* ===== 播放列表视图:曲目列表 + 上传音乐 ===== */
            <div className="island-panel-list">
              <div className="island-panel-list-head">
                <span className="island-panel-state">
                  <span className="island-panel-state-dot" aria-hidden="true" />
                  播放列表
                </span>
                <span className="island-panel-list-count">
                  {playlist?.length ?? 0} 首
                </span>
              </div>
              <ul className="island-panel-tracks">
                {(playlist ?? []).map((t, i) => (
                  <li
                    key={`${t.url ?? t.title}-${i}`}
                    className={`island-track${i === playlistIndex ? ' active' : ''}`}
                  >
                    <button
                      type="button"
                      className="island-track-main"
                      aria-label={`${i === playlistIndex ? '暂停/继续' : '播放'} ${t.title}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        // 单击当前曲目:播放/暂停切换;其他曲目:直接播放
                        if (i === playlistIndex) onTogglePlay?.()
                        else onPlayTrack?.(i)
                      }}
                    >
                      <span className="island-track-index" aria-hidden="true">
                        {i === playlistIndex ? '▶' : String(i + 1).padStart(2, '0')}
                      </span>
                      <span className="island-track-meta">
                        <span className="island-track-title">{t.title}</span>
                        <span className="island-track-artist">{t.artist}</span>
                      </span>
                      <span className="island-track-duration">
                        {t.duration > 0 ? formatTime(t.duration) : ''}
                      </span>
                    </button>
                    {t.source === 'uploaded' && onRemoveTrack && (
                      <button
                        type="button"
                        className="island-track-remove"
                        aria-label={`删除 ${t.title}`}
                        title="删除"
                        onClick={(event) => {
                          event.stopPropagation()
                          onRemoveTrack(i)
                        }}
                      >
                        <svg
                          className="island-ctl-svg"
                          width="13"
                          height="13"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={2.2}
                          strokeLinecap="round"
                        >
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    )}
                  </li>
                ))}
                {(playlist ?? []).length === 0 && (
                  <li className="island-track-empty">暂无曲目,点击下方上传音乐</li>
                )}
              </ul>
              <div className="island-panel-list-foot">
                <button
                  type="button"
                  className="island-ctl island-ctl--upload"
                  onClick={(event) => {
                    event.stopPropagation()
                    fileInputRef.current?.click()
                  }}
                >
                  <svg
                    className="island-ctl-svg"
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  <span>上传音乐</span>
                </button>
                <button
                  type="button"
                  className="island-ctl island-ctl--back"
                  onClick={(event) => {
                    event.stopPropagation()
                    setPanelView('control')
                  }}
                >
                  <svg
                    className="island-ctl-svg"
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                  <span>返回</span>
                </button>
              </div>
            </div>
          ) : null}
          {/* 主题色视图:左侧预设色板 + 右侧常驻 RGB 自定义取色 */}
          {panelView === 'theme' && onThemeChange ? (
            <div className="island-panel-theme">
              <div className="island-panel-list-head">
                <span className="island-panel-list-count">主题色</span>
              </div>
              <div className="island-theme-layout">
                {/* 左:预设色板(跟随播放模式 + 常用色) */}
                <div className="island-theme-presets">
                  <button
                    type="button"
                    className={`island-theme-swatch island-theme-swatch--follow${customTheme == null ? ' active' : ''}`}
                    title="跟随播放模式/状态色"
                    onClick={(event) => {
                      event.stopPropagation()
                      const rect = islandRef.current?.getBoundingClientRect()
                      triggerRipple(
                        theme,
                        event.clientX - (rect?.left ?? 0),
                        event.clientY - (rect?.top ?? 0),
                      )
                      onThemeChange(null)
                    }}
                  />
                  {THEME_PRESETS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={`island-theme-swatch${customTheme === c ? ' active' : ''}`}
                      style={{ background: c, '--swatch-color': c } as CSSProperties}
                      title={c}
                      onClick={(event) => {
                        event.stopPropagation()
                        const rect = islandRef.current?.getBoundingClientRect()
                        triggerRipple(
                          c,
                          event.clientX - (rect?.left ?? 0),
                          event.clientY - (rect?.top ?? 0),
                        )
                        onThemeChange(c)
                      }}
                    />
                  ))}
                </div>
                {/* 右:常驻 RGB 自定义取色(输入即生效,无弹出层) */}
                <div className="island-theme-custom">
                  <div className="island-theme-custom-head">
                    <span
                      className="island-theme-custom-preview"
                      style={{ background: theme }}
                      aria-hidden="true"
                    />
                    <span>自定义 RGB</span>
                  </div>
                  {(
                    [
                      ['R', rgb.r],
                      ['G', rgb.g],
                      ['B', rgb.b],
                    ] as const
                  ).map(([ch, v]) => (
                    <label key={ch} className="island-theme-rgb-row">
                      <span className="island-theme-rgb-key">{ch}</span>
                      <input
                        type="number"
                        min={0}
                        max={255}
                        value={v}
                        onChange={(event) => {
                          event.stopPropagation()
                          handleRgbChange(ch.toLowerCase() as 'r' | 'g' | 'b', Number(event.target.value))
                        }}
                      />
                    </label>
                  ))}
                </div>
              </div>
              <div className="island-panel-list-foot">
                <button
                  type="button"
                  className="island-ctl island-ctl--back"
                  onClick={(event) => {
                    event.stopPropagation()
                    setPanelView('control')
                  }}
                >
                  <svg
                    className="island-ctl-svg"
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                  <span>返回</span>
                </button>
              </div>
            </div>
          ) : null}
          {/* 自定义背景视图(托盘菜单入口,岛内打开):
              一键上传即应用(cover 居中),之后可用双形态蒙版裁切
              (展开态视口拖拽平移 + 紧凑态胶囊预览,岛体本身即实时预览);
              无预览区——上传后默认就已更换 */}
          {panelView === 'background' && onBackgroundChange ? (
            <div className="island-panel-bg">
              <div className="island-panel-list-head">
                <span className="island-panel-list-count">自定义背景</span>
              </div>
              {/* 分段切换始终可见:即使当前形态没有图片(刚被移除),也能切到
                  另一形态继续管理其图片与裁切 */}
              <div
                className={`island-bg-seg${bgTarget === 'compact' ? ' island-bg-seg--compact' : ''}`}
                role="tablist"
                aria-label="裁切目标"
              >
                {/* 滑动指示条:随目标切换回弹平移 */}
                <span className="island-bg-seg-thumb" aria-hidden="true" />
                <button
                  type="button"
                  className={bgTarget === 'expanded' ? 'on' : ''}
                  onClick={(event) => {
                    event.stopPropagation()
                    setBgTarget('expanded')
                  }}
                >
                  展开态
                </button>
                <button
                  type="button"
                  className={bgTarget === 'compact' ? 'on' : ''}
                  onClick={(event) => {
                    event.stopPropagation()
                    setBgTarget('compact')
                  }}
                >
                  紧凑态
                </button>
              </div>
              {activeImage ? (
                <>
                  {/* 裁切区:当前形态的蒙版视口(拖拽平移/滚轮缩放/双击复位) */}
                  <div className="island-bg-crop">
                    <div
                      className={`island-bg-viewport${bgTarget === 'compact' ? ' island-bg-viewport--compact' : ''}`}
                      onPointerDown={handleBgPanDown}
                      onPointerMove={handleBgPanMove}
                      onPointerUp={handleBgPanEnd}
                      onPointerCancel={handleBgPanEnd}
                      onWheel={handleBgWheel}
                      onDoubleClick={handleBgDoubleClick}
                      style={bgStyleFor(
                        activeImage ?? '',
                        bgTarget === 'expanded' ? bgSizeExpanded : bgSizeCompact,
                        activeCrop.posX,
                        activeCrop.posY,
                      )}
                    >
                      <span className="island-bg-mask-tag">
                        {bgTarget === 'expanded' ? '展开态' : '紧凑态'}
                      </span>
                      <span className="island-bg-hint">拖拽平移 · 滚轮缩放 · 双击复位</span>
                    </div>
                  </div>
                  <div className="island-bg-controls">
                    <div className="island-bg-sliders">
                      <label className="island-bg-slider">
                        <span className="island-bg-opacity-row">
                          <span>缩放</span>
                          <span>{activeCrop.zoom.toFixed(1)}x</span>
                        </span>
                        <input
                          type="range"
                          min={100}
                          max={400}
                          value={Math.round(activeCrop.zoom * 100)}
                          onChange={(event) => {
                            event.stopPropagation()
                            patchActiveCrop({ zoom: Number(event.target.value) / 100 })
                          }}
                        />
                      </label>
                      <label className="island-bg-slider">
                        <span className="island-bg-opacity-row">
                          <span>不透明度</span>
                          <span>{Math.round((backgroundOpacity ?? 0.4) * 100)}%</span>
                        </span>
                        <input
                          type="range"
                          min={0}
                          max={100}
                          value={Math.round((backgroundOpacity ?? 0.4) * 100)}
                          onChange={(event) => {
                            event.stopPropagation()
                            onBackgroundChange({
                              expandedImage,
                              compactImage,
                              opacity: Number(event.target.value) / 100,
                              expanded: expandedCrop,
                              compact: compactCrop,
                            })
                          }}
                        />
                      </label>
                    </div>
                    <div className="island-bg-actions">
                      <button
                        type="button"
                        className="island-ctl island-ctl--upload"
                        onClick={(event) => {
                          event.stopPropagation()
                          bgFileInputRef.current?.click()
                        }}
                      >
                        <svg
                          className="island-ctl-svg"
                          width="15"
                          height="15"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={2}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                          <polyline points="17 8 12 3 7 8" />
                          <line x1="12" y1="3" x2="12" y2="15" />
                        </svg>
                        <span>更换图片</span>
                      </button>
                      {(activeCrop.zoom !== 1 || activeCrop.posX !== 50 || activeCrop.posY !== 50) && (
                        <button
                          type="button"
                          className="island-ctl island-ctl--clear"
                          onClick={(event) => {
                            event.stopPropagation()
                            patchActiveCrop({ zoom: 1, posX: 50, posY: 50 })
                          }}
                        >
                          <svg
                            className="island-ctl-svg"
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={2.2}
                            strokeLinecap="round"
                          >
                            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                            <path d="M3 3v5h5" />
                          </svg>
                          <span>重置裁切</span>
                        </button>
                      )}
                      <button
                        type="button"
                        className="island-ctl island-ctl--clear"
                        onClick={(event) => {
                          event.stopPropagation()
                          // 移除当前形态的背景(另一形态不受影响)
                          onBackgroundChange({
                            expandedImage: bgTarget === 'expanded' ? null : expandedImage,
                            compactImage: bgTarget === 'compact' ? null : compactImage,
                            opacity: backgroundOpacity ?? 0.4,
                            expanded: bgTarget === 'expanded' ? DEFAULT_CROP : expandedCrop,
                            compact: bgTarget === 'compact' ? DEFAULT_CROP : compactCrop,
                          })
                        }}
                      >
                        <svg
                          className="island-ctl-svg"
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={2.2}
                          strokeLinecap="round"
                        >
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                        <span>移除背景</span>
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="island-bg-empty">
                  <p className="island-bg-empty-text">
                    上传一张图片作为{bgTarget === 'expanded' ? '展开态' : '紧凑态'}背景,
                    岛体将实时预览
                  </p>
                  <button
                    type="button"
                    className="island-ctl island-ctl--upload"
                    onClick={(event) => {
                      event.stopPropagation()
                      bgFileInputRef.current?.click()
                    }}
                  >
                    <svg
                      className="island-ctl-svg"
                      width="15"
                      height="15"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="17 8 12 3 7 8" />
                      <line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                    <span>上传图片</span>
                  </button>
                </div>
              )}
              {/* 扁平返回键:独占一行,纯文本式(无按钮底/边框),背景编辑器的唯一收起方式 */}
              <div className="island-panel-list-foot island-bg-foot">
                <button
                  type="button"
                  className="island-bg-back"
                  onClick={(event) => {
                    event.stopPropagation()
                    changeExpanded(false)
                  }}
                >
                  <svg
                    className="island-ctl-svg"
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                  <span>返回</span>
                </button>
              </div>
            </div>
          ) : null}
          {/* 背景图片上传(隐藏输入,由"上传图片"按钮触发) */}
          <input
            ref={bgFileInputRef}
            type="file"
            accept="image/*"
            hidden
            onClick={(event) => event.stopPropagation()}
            onChange={handleBackgroundFileChange}
          />
          {/* 上传音乐文件选择(隐藏输入,由"上传音乐"按钮触发) */}
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
}
