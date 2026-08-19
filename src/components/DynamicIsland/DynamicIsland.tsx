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
import { FONT_WEIGHTS, type FontColorMode, type FontLibraryItem } from '../../media/fontStore'
import { useAgentPanelLayout } from '../../hooks/useAgentPanelLayout'
import type { AudioLibraryItem, VideoLibraryItem } from '../../media/libraryStore'
import { loadImageNaturalSize, sampleImageBrightness } from '../../media/imageUtils'
import { ParticleTime } from './ParticleTime'
import {
  AgentSettingsView,
  MediaLibraryView,
  AgentView,
  BackgroundView,
  ControlView,
  FontColorView,
  FontLibraryView,
  FontView,
  ImageLibraryView,
  ListView,
  SettingsView,
  LyricApiView,
  ThemeView,
} from './views'
import type { AgentConfig, AgentPanelProps } from '../../agent/types'
import { textFromMessage } from '../../agent/text'
import { AgentMediaMini } from './views/AgentMediaMini'
import {
  AGENT_MEDIA_EVENT,
  clearAgentVideoResume,
  type AgentMediaReport,
} from './views/Markdown'

/** 媒体源归一化比较(2026-08-09 修复"移交永不触发"):agentPlaying 上报
 * 的是**已解析形态**(VoiceBubble 收到 resolved 后原样上报,
 * island-media://local/<编码路径>),agentLastMedia 快照是消息里的
 * **原始路径**——resolveMediaSrc 对 island-media: 前缀不识别(正则
 * 只认 http/data/blob)会双重编码,两边直接比较恒不相等。归一化为
 * 原始路径(解码协议载荷)后比较;http/data/blob 原样(两形态一致) */
function normMediaSrc(src: string): string {
  const m = /^island-media:\/\/local\/(.+)$/.exec(src)
  if (!m) return src
  try {
    return decodeURIComponent(m[1])
  } catch {
    // 畸形编码(理论不可达):按原样比较
    return m[1]
  }
}
import {
  BG_COMPACT_REF_H,
  BG_COMPACT_REF_W,
  BG_CROP_REF_H,
  BG_CROP_REF_W,
  COLLAPSE_HIDE_MS,
  ELLIPSIS_SLOT_PX,
  EXPANDED_WIDTH_PX,
  clampExpandedWidth,
  FADE_IN_DELAY_MS,
  FADE_IN_FAST_MS,
  FADE_IN_MS,
  FADE_OUT_MS,
  HOVER_EXTEND_PX,
  ISLAND_BASE_PX,
  LONG_PRESS_MS,
  SWIPE_TIME_MS,
  LONG_PRESS_SLOP_PX,
  SWIPE_HYSTERESIS_PX,
  SEEK_MOMENTUM_VELOCITY_PX,
  SEEK_MOMENTUM_WINDOW_MS,
  MAX_WIDTH_PX,
  MODE_ICON_MORPH_MS,
  MORPH_ANIMATE_MS,
  SEEK_STEP_SEC,
  SUPPRESS_CLICK_MS,
  SWIPE_THRESHOLD_PX,
  TEXT_LEFT_PX,
  TEXT_RISE_PX,
  TEXT_SWAP_MS,
  TRACK_CYCLE_MS,
  applyTextLayout,
  bgSizePctFor,
  conflictsWithBar,
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
  /** Agent 音频移交(2026-08-09):收起面板时**仅当对话内正在播放**的
   * 音频才切回音乐模式并继续播放——宿主把音频接进本地播放器(经
   * addTracks 自动播放)再切模式;**未播放(暂停/播完/从未播过)收起
   * 不切音乐模式**(2026-08-09 用户要求:历史消息里有音频 ≠ 在播,
   * 收起面板不该跳到音乐模式),留在 Agent 模式紧凑态 */
  onAgentAudioHandoff?: (audio: {
    src: string
    name?: string
    /** 移交时播放进度秒(2026-08-11 音乐模式从该位置续播,不从头) */
    position?: number
    /** 对话窗口循环播放(2026-08-11 同步为音乐模式单曲循环) */
    loop?: boolean
  }) => void
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
  /** Agent 配置(设置视图"Agent 设置"入口;提供后设置视图显示该入口)。
   * 工具清单走 agent.tools 单通道(审计 P1 #4,消双通道冗余) */
  agentConfig?: {
    config: AgentConfig | null
    onSave: (patch: Partial<AgentConfig>) => void
    /** 重新拉取配置(Agent 设置视图打开时调用——LLM 自我配置后刷新) */
    onRefresh?: () => void
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
  /** 媒体窗口默认宽(2026-08-08:对话图片/视频窗口初始宽,160-800,缺省 320) */
  mediaWindowWidth?: number
  /** 媒体窗口默认宽变更(写 localStorage,即时生效) */
  onMediaWindowWidthChange?: (width: number) => void
  /** 多媒体库(2026-08-08):音频库(ArrayBuffer)/ 视频库(路径引用)条目与变更 */
  audioLibrary?: AudioLibraryItem[]
  onAudioLibraryChange?: (items: AudioLibraryItem[]) => void
  videoLibrary?: VideoLibraryItem[]
  onVideoLibraryChange?: (items: VideoLibraryItem[]) => void
  /** 音频库条目导入播放列表(单个/批量) */
  onAddLibraryTracks?: (items: AudioLibraryItem[]) => void
  /** 视频导入(宿主弹系统对话框选文件 → 记录路径入库) */
  onVideoImport?: () => void
  /** 托盘"多媒体库"菜单:seq 递增触发展开并进入多媒体库视图 */
  requestMediaLibrarySeq?: number
  /** LLM 工具 play_library_video(2026-08-10):待播放视频库条目 id——
   * 多媒体库面板展开后 MediaLibraryView 定位该视频自动播放;播完经
   * onMediaLibraryPlayConsumed 清回 null(下次打开不重复触发) */
  mediaLibraryPlayId?: string | null
  /** 待播放视频已消费(MediaLibraryView 已定位播放) */
  onMediaLibraryPlayConsumed?: () => void
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

/** 对话媒体小窗尺寸(2026-08-09):岛体 264×148(16:9 + 紧凑胶囊观感),
 * 窗口 = 岛体 + 40(复用 onAgentPanelSize 约定) */
const AGENT_MINI_W = 264
const AGENT_MINI_H = 148

const SETTINGS_VIEWS: readonly PanelView[] = [
  'settings',
  'background',
  'theme',
  'font',
  'font-color',
  'font-library',
  'image-library',
  'media-library',
  'agent-settings',
  'lyric-api',
]
const isSettingsView = (view: string) => SETTINGS_VIEWS.includes(view as PanelView)

/** 按码元截断(2026-08-16,紧凑态文字区标签兜底):UTF-16 按代码单元
 * 切片会劈开 emoji 代理对(显示 �)。超限截断尾部补省略号——超长文本
 * (如回复预览)被截断时用户需要"还有内容"的提示,不是静默丢掉 */
function cutLabel(text: string, max: number): string {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  return chars.slice(0, max).join('') + '…'
}

/**
 * Agent 模式紧凑态文案:监听 LLM 回复的完整流程。
 * - 深度思考中:thinking + 仅有 reasoning 流(无文本输出);
 * - 正在回复:thinking + 文本流已开始(流式增量实时可见);
 * - 正在执行:工具循环阶段(带当前工具名);
 * - 回复已完成:优先显示独立 Sub Agent 对 LLM 回复的心理揣测
 *   (每轮回复后静默更新,如「表面淡定,内心在慌」,替代标题更有人味),
 *   其次当前对话实时总结标题,再回退最近一条助手文本预览;
 * - 出错 → 提示展开查看;无回复 → 待命
 * 2026-08-16 用户实测"出现非常长的文本句子,右侧被截断":三条路径全部
 * 按码元设上限——揣测 16 / 标题 20 / 回复预览 20+省略号(预览是超长
 * 文本的主要来源,原实现整段回复全文直入文字区,岛宽 500px 封顶后
 * 右侧被静默裁剪、无省略号)
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
  // 回复已完成:心理揣测(独立 Sub Agent 根据当前对话揣测 LLM 回复时的
  // 心态,俏皮话 10 字左右、上限 16 字)→ 实时总结标题(≤20)→
  // 最近一条助手文本预览(截 20 + 省略号)。展示层再兜一次码元上限:
  // 引擎/runner 的截断不是唯一来源,localStorage 残留/事件注入都可能超长
  if (agent.mindGuess) return cutLabel(agent.mindGuess, 16)
  if (agent.currentTitle) return cutLabel(agent.currentTitle, 20)
  // 回退:最近一条含文本的助手消息(空格分隔,紧凑显示等价原实现)
  for (let i = agent.messages.length - 1; i >= 0; i--) {
    const m = agent.messages[i]
    if (m.role !== 'assistant') continue
    const text = textFromMessage(m, ' ').trim()
    if (text) return cutLabel(text, 20)
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
 * 其余状态用固定文案。
 * 歌手位占位:浏览器(Chrome/Edge 标签页)等平台 SMTC 查询不到作者,
 * artist 为空时文字区宽度为 0 → 悬停进度条位置计算异常,拖拽时粒子
 * 时间与进度条 UI 重叠(用户实测)——空值显示"未知作者"占位保宽度
 */
function mediaTextFor(
  state: IslandState,
  track: TrackInfo | null | undefined,
  showArtist: boolean,
): string {
  if (track && (state === 'playing' || state === 'idle')) {
    if (showArtist) return track.artist?.trim() || '未知作者'
    return `${state === 'playing' ? '正在播放' : '已暂停'}: ${track.title ?? ''}`
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
  onAgentAudioHandoff,
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
  audioLibrary = [],
  onAudioLibraryChange,
  videoLibrary = [],
  onVideoLibraryChange,
  onAddLibraryTracks,
  onVideoImport,
  requestMediaLibrarySeq,
  mediaLibraryPlayId,
  onMediaLibraryPlayConsumed,
  agent,
  agentConfig,
  onAgentPanelSize,
  collapseSeq,
  onAgentPanelWidth,
  mediaWindowWidth = 320,
  onMediaWindowWidthChange,
  ref,
}: DynamicIslandProps) {
  // Agent 模式激活(存在即激活):媒体数据与手势让位
  const agentActive = agent != null
  const agentActiveRef = useRef(false)
  agentActiveRef.current = agentActive
  // 对话媒体小窗/移交(2026-08-09):候选 = **数据驱动的最后媒体**
  // (AgentView 从消息数据计算并经 onMediaSnapshot 上报——数据顺序 =
  // 消息顺序,不受消息列表分批挂载影响;原挂载事件上报在大量历史
  // 消息时最后上报的是中间批次的旧媒体,实测音频移交错取旧文件);
  // agentPlaying = 播放状态事件上报(仅作小窗视频自动续播标记)。
  // agentMini = 收起瞬间的快照(独立存活)
  const [agentLastMedia, setAgentLastMedia] = useState<AgentMediaReport | null>(null)
  const agentLastMediaRef = useRef<AgentMediaReport | null>(null)
  // 2026-08-11 性能:agentPlaying 只被 doCollapse 同步读取(小窗快照/续播
  // 判定),**无渲染用途**——原 useState 让视频播放进度上报(节流 1Hz,
  // setAgentPlaying 每次新对象)触发整岛重渲染:消息多 + 视频播放 = 卡顿
  // 主因(1Hz 全列表重建,软件渲染下再叠视频合成)。改 useRef 直写,
  // 播放上报零渲染;doCollapse 读 ref 最新值,语义不变
  const agentPlayingRef = useRef<AgentMediaReport | null>(null)
  const [agentMini, setAgentMini] = useState<AgentMediaReport | null>(null)
  useEffect(() => {
    const onMedia = (event: Event) => {
      const detail = (
        event as CustomEvent<{ type: 'mount' | 'play' | 'unmount'; media: AgentMediaReport }>
      ).detail
      if (!detail || !detail.media || detail.type !== 'play') return
      // 播放/暂停:播放中 → 续播标记;暂停 → 清(仅同 src)
      if (detail.media.playing) agentPlayingRef.current = { ...detail.media }
      else if (agentPlayingRef.current && agentPlayingRef.current.src === detail.media.src) {
        agentPlayingRef.current = null
      }
    }
    document.addEventListener(AGENT_MEDIA_EVENT, onMedia)
    return () => document.removeEventListener(AGENT_MEDIA_EVENT, onMedia)
  }, [])
  // 镜像(ref):doCollapse 同步读取(避免闭包过期)
  useEffect(() => {
    agentLastMediaRef.current = agentLastMedia
  }, [agentLastMedia])
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
  // 音频移交回调(doCollapse 同步读;prop 可能不稳定,ref 镜像)。
  // 2026-08-09:onAgentSwipeToMusicRef 已删——未播放音频收起不再切
  // 音乐模式(用户要求),左滑手势直接用 prop(handleTextPointerUp)
  const onAgentAudioHandoffRef = useRef(onAgentAudioHandoff)
  useEffect(() => {
    onAgentAudioHandoffRef.current = onAgentAudioHandoff
  }, [onAgentAudioHandoff])
  // 长按展开:按下起点 + 计时器;位移超阈值或提前抬起则取消
  const pressRef = useRef<{
    startX: number
    startY: number
    pointerId: number
    timer: number
  } | null>(null)
  // 长按触发后的那次 click 只消费此标记(不切换状态也不收起,防止刚展开又被点掉)。
  // 限时 600ms 自动清除:面板按钮点击都 stopPropagation 不触发岛 click,
  // 若标记长期滞留,下一次点岛本体会被误吞而无法收起
  const suppressClickRef = useRef(false)
  const suppressTimerRef = useRef(0)
  const expandedRef = useRef(false)
  const onExpandChangeRef = useRef(onExpandChange)
  // 文字区滑动手势:按下起点 + 是否已触发(触发后不再重复)
  const swipeRef = useRef<{
    startX: number
    startY: number
    pointerId: number
    done: boolean
    /** 按下时刻(时间窗判定:快速滑动才算手势,长按/慢速拖动不算) */
    startAt: number
    /** 末段速度采样历史(方向滞后/速度判定用,150ms 窗口) */
    hist: { t: number; x: number }[]
    /** 主导方向(2026-08-18 设计规范:方向滞后——先右后左等反转不提交) */
    dir: 1 | -1 | null
  } | null>(null)
  // 进度条/滑杆拖动的速度采样历史(松手动量投影用,SEEK_MOMENTUM_WINDOW_MS 窗口)
  const barHistRef = useRef<{ t: number; x: number }[]>([])
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
  // **离开 Agent 对话视图(去 Agent 设置/多媒体库等)清除视频续播标记
  // (2026-08-13 用户实测"从 Agent 设置回到对话窗口时自动播放视频,
  // 不需要")**:panelView 切走 = AgentView 卸载 = 播放停止,但
  // lastPlayingVideoSrc 残留,返回重挂载时 MediaFrame 判 resume 自动
  // play(诈尸续播)。去 'control' 例外 = 收起路径(doCollapse 按
  // mediaMini 区分:收起为多媒体岛由小窗接管播放**不清**、收起为灵动岛
  // 已清);视频岛在播 → 展开面板的接管续播路径(control → agent)不受
  // 影响(只在离开 agent 时清)
  const prevPanelViewRef = useRef<PanelView>('control')
  useEffect(() => {
    const prev = prevPanelViewRef.current
    prevPanelViewRef.current = panelView
    if (prev === 'agent' && panelView !== 'agent' && panelView !== 'control') {
      clearAgentVideoResume()
    }
  }, [panelView])
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

    // 第一轮:非悬停时的字符截断(用 canvas 测量完整文字,不依赖 DOM 渲染状态)。
    // Agent 模式(2026-08-07):紧凑态文字(揣测 ≤16 码元/标题/回复)已按码元
    // 截断,且无进度条——岛宽随文字长度自适应扩展,正常不按像素截断
    // (用户要求:文字区随对应字数扩展岛宽;16 字约 340px < MAX_WIDTH_PX)。
    // **像素兜底(2026-08-16)**:码元上限挡不住自定义宽字体/中西混排
    // (如 16 个全角+半角混排字符可超 400px),岛宽 500px 封顶后文字
    // 溢出被岛体静默裁剪、无省略号(用户实测"长句右侧截断")——超限
    // 时走与音乐模式同款像素截断 + 省略号,不再静默裁剪
    if (agentActiveRef.current) {
      const available = MAX_WIDTH_PX - ISLAND_BASE_PX - ELLIPSIS_SLOT_PX
      const { visible, truncated } = truncateText(displayText, available, font)
      if (visible !== visibleTextRef.current) {
        visibleTextRef.current = visible
        setVisibleText(visible)
        setTextTruncated(truncated)
        return
      }
    } else {
      const available = MAX_WIDTH_PX - ISLAND_BASE_PX - ELLIPSIS_SLOT_PX
      const { visible, truncated } = truncateText(displayText, available, font)
      if (visible !== visibleTextRef.current) {
        visibleTextRef.current = visible
        setVisibleText(visible)
        setTextTruncated(truncated)
        return
      }
    }

    // 第二轮:截断内容已提交,测量最终宽度 → 计算悬停目标宽度 → px→px 过渡触发回弹
    const finalNatural = measureNaturalWidth(island)
    const conflicts = conflictsWithBar(fullTextWidth)
    // Agent 模式:紧凑态无进度条,悬停**不扩展**(扩展 = 进度条占位空白,
    // 收起面板时鼠标悬浮在岛上会触发,实测 bug);其余模式悬停为进度条预留
    const targetPx = hoveredRef.current && !agentActiveRef.current
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
    // 失败保持原值(与内联时 onload-only 语义一致);loadImageNaturalSize
    // 是 Promise,成功后 setState
    void loadImageNaturalSize(expandedImage).then((s) => {
      if (s) setBgNaturalE(s)
    })
  }, [expandedImage])
  const [bgNaturalC, setBgNaturalC] = useState<{ w: number; h: number } | null>(null)
  useEffect(() => {
    if (!compactImage) {
      setBgNaturalC(null)
      return
    }
    void loadImageNaturalSize(compactImage).then((s) => {
      if (s) setBgNaturalC(s)
    })
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
    // 多指防护(2026-08-18 设计规范):已在拖动中时忽略新指针,避免第二指跳变
    if (scrubbingRef.current) return
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
    // 速度采样历史起点(松手动量投影)
    barHistRef.current = [{ t: performance.now(), x: event.clientX }]
  }
  const handleBarPointerMove = (event: PointerEvent<HTMLDivElement>, bar: HTMLDivElement) => {
    if (!scrubbingRef.current) return
    // 采样末段速度:只留窗口内的历史
    const now = performance.now()
    barHistRef.current.push({ t: now, x: event.clientX })
    while (barHistRef.current.length && now - barHistRef.current[0].t > SEEK_MOMENTUM_WINDOW_MS) {
      barHistRef.current.shift()
    }
    setScrubRatio(ratioFromPointer(event, bar))
  }
  const handleBarPointerUp = (event: PointerEvent<HTMLDivElement>, bar: HTMLDivElement) => {
    if (!scrubbingRef.current) return
    scrubbingRef.current = false
    setScrubbing(false)
    setScrubRatio(null)
    // 动量投影(2026-08-18 设计规范 #5):快速甩动松手时,把落点投影到
    // 惯性终点再吸附,消除"时间瞬间停住"的接缝感;慢速拖动则常规落点
    let target = ratioFromPointer(event, bar)
    const hist = barHistRef.current
    const now = performance.now()
    while (hist.length && now - hist[0].t > SEEK_MOMENTUM_WINDOW_MS) hist.shift()
    if (hist.length >= 2) {
      const last = hist[hist.length - 1]
      const vPxPerS = ((event.clientX - last.x) / Math.max(now - last.t, 1)) * 1000
      if (Math.abs(vPxPerS) > SEEK_MOMENTUM_VELOCITY_PX) {
        // Apple 指数衰减投影:projPx = (v/1000)·r/(1-r),乘 0.2 权重收敛行程
        const projPx = (vPxPerS / 1000) * (0.998 / (1 - 0.998)) * 0.2
        target = Math.min(1, Math.max(0, target + projPx / bar.getBoundingClientRect().width))
      }
    }
    barHistRef.current = []
    onSeek?.(target * duration)
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
    // 多指防护(2026-08-18 设计规范):已有手势进行中时忽略新指针,避免跳变
    if (swipeRef.current) return
    swipeRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      pointerId: event.pointerId,
      done: false,
      startAt: performance.now(),
      hist: [],
      dir: null,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const handleTextPointerMove = (event: PointerEvent<HTMLSpanElement>) => {
    const gesture = swipeRef.current
    if (!gesture || gesture.done) return
    // 多指:只响应发起手势的那根指针
    if (gesture.pointerId !== event.pointerId) return
    const dx = event.clientX - gesture.startX
    const dy = event.clientY - gesture.startY
    const now = performance.now()
    // 维护末段速度采样历史(150ms 窗口,方向滞后/速度判定用)
    gesture.hist.push({ t: now, x: event.clientX })
    while (gesture.hist.length && now - gesture.hist[0].t > SEEK_MOMENTUM_WINDOW_MS) {
      gesture.hist.shift()
    }
    // 时间窗(2026-08-08 修复"长按边缘切换成音乐模式"):swipe 是
    // **快速滑动**手势,按下后须在 SWIPE_TIME_MS 内达到位移阈值——
    // 长按展开(450ms)期间的慢速位移/手抖先超 slop 取消长按后继续
    // 移动,若没有时间条件会误判为 swipe,Agent 模式直接切回音乐
    // (UI 抖动 + 展开中断,用户实测)
    if (
      Math.abs(dx) < SWIPE_THRESHOLD_PX ||
      Math.abs(dy) > Math.abs(dx) * 1.2 ||
      now - gesture.startAt > SWIPE_TIME_MS
    ) {
      return
    }
    // 方向滞后(2026-08-18 设计规范 #9):末段速度方向与总位移方向一致
    // 才提交——"先右后左"等反转(真实意图是左滑)首次越阈时不锁定方向。
    // 末段速度 = 窗口起点→当前点的平均速度;反向拖动时符号相反 → 等待确认
    const hist = gesture.hist
    const lastX = hist.length ? hist[0].x : gesture.startX
    const lastT = hist.length ? hist[0].t : gesture.startAt
    const v = (event.clientX - lastX) / Math.max(now - lastT, 1)
    if (Math.sign(v) !== Math.sign(dx)) return
    // 反向位移超过滞后量时翻转主导方向(双保险:极端"大幅反向再正向"保持跟手)
    if (gesture.dir === null) gesture.dir = dx > 0 ? 1 : -1
    else if (gesture.dir === 1 && -dx >= SWIPE_HYSTERESIS_PX) gesture.dir = -1
    else if (gesture.dir === -1 && dx >= SWIPE_HYSTERESIS_PX) gesture.dir = 1
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
  const doCollapse = useCallback((opts?: { mediaMini?: boolean }) => {
    releasePress()
    // 媒体小窗快照/音频移交(2026-08-09 修复"音乐模式展开/收回后自动
    // 从头播放"):doCollapse 是音乐模式收起也走的公共路径,agentLastMedia
    // 是最近 Agent 媒体、不随模式清除——音乐模式收起若重复执行移交,
    // 同一首歌会再次 addTracks 并从 0 自动播放(实测)。防重复的判据
    // = **agentPlaying(面板内当前正在播放)**,而非模式:Agent → 音乐
    // 的模式切换动画结束后 agent 已卸载(agentActive=false),但该链路
    // 的收起正是"续播移交"的主要场景,必须放行;首次移交后清
    // agentPlaying,音乐模式再展开/收回时判据为空 → 不再移交。
    // - 视频/图片 → 冻结为小窗快照(候选 = AgentView 数据上报的最后
    //   媒体,顺序可靠;自动续播标记 = 同 src 的播放事件);
    // - 音频 → **仅面板内正在播放**才移交本地播放器续播并切音乐模式;
    //   **未播放(暂停/播完/从没播过)收起不切音乐模式**(2026-08-09
    //   用户要求:没播音频时收起面板不该切成音乐模式——agentLastMedia
    //   是数据驱动快照,历史消息里有音频不等于在播,原来 else 分支
    //   无条件切模式,实测收起就跳到音乐模式)——留在 Agent 模式紧凑态;
    // - 处理完清 agentPlaying:面板卸载不派发 pause 事件,残留的
    //   playing:true 会在下次收起时误触发自动续播/移交
    // **mediaMini: false = "收起为灵动岛"(2026-08-10 用户要求拆分):
    // 收起成 Agent 紧凑态,不生成媒体岛;缺省 = 收起为多媒体岛**
    // **正在播放的媒体优先(2026-08-10 用户要求"正在播放视频却触发
    // 图片岛"**:agentLastMedia 是数据顺序的最后媒体,播放中的视频在
    // 中间/被后面的图片消息挤掉时收起会取图片;正在播放(agentPlaying)
    // 的媒体优先作小窗候选,无播放时才回退最后媒体)
    const mediaMini = opts?.mediaMini !== false
    const last = agentLastMediaRef.current
    const playingMedia = agentPlayingRef.current
    // **播放优先只认视频(2026-08-10 用户要求"最新消息为图片,且无视频
    // 播放则展示图片")**:playingMedia 是播放状态事件上报,残留的
    // playing:true(视频暂停/播完偶发未清)会让收起取旧视频而非最新消息
    // 的图片;图片没有"播放中"概念,不该参与播放优先——只有 kind===
    // 'video' 且 playing 才优先作小窗候选,其余场景一律取数据驱动的
    // 最后媒体(最新消息里的媒体,见 AgentView lastMedia)
    const playingVideo =
      playingMedia && playingMedia.kind === 'video' && playingMedia.playing && playingMedia.src
        ? playingMedia
        : null
    const media = playingVideo ?? last
    // 同 src 判据(2026-08-09):播放中 → 自动续播标记;暂停后收起 → 仍
    // 带进度,小窗点播放从暂停处继续(修复"收起变多媒体岛从头播放")
    const sameSrc =
      !!playingMedia?.src &&
      normMediaSrc(playingMedia.src) === normMediaSrc(media?.src ?? '')
    const playing = !!playingMedia?.playing && sameSrc
    if (media && media.kind !== 'audio' && mediaMini) {
      setAgentMini({
        ...media,
        playing,
        position: sameSrc ? playingMedia?.position : undefined,
      })
    } else {
      setAgentMini(null)
    }
    // **收起为灵动岛(mediaMini:false)清除视频续播标记(2026-08-11 用户
    // 要求"从别的窗口/模式切换回不自动播放,除非从视频岛正在播放的视频
    // 切换回来")**:面板卸载 = 视频播放停止,lastPlayingVideoSrc 残留会让
    // 下次展开面板"诈尸续播"(实测:收起为灵动岛 → 切音乐 → 切回 Agent
    // 展开,视频自动播)。收起为多媒体岛(默认)不清——小窗接管播放,
    // 小窗在播 → 展开面板的续播路径保留(小窗暂停/播完经 dispatch
    // playing:false 自清);模式切换的清理由 WidgetApp 负责(小窗/面板
    // 卸载的同一语义)
    if (!mediaMini && playingVideo) {
      clearAgentVideoResume()
    }
    // **音频移交独立判定(2026-08-10)**:小窗候选只认视频后,media 可能
    // 是最后消息(非音频),播放中的音频要单独取——playingMedia 是
    // audio 且在播(暂停/播完会 dispatch playing:false 清)才移交,
    // 不受数据最后媒体影响(用户实测"bili 下载的歌切音乐模式播放"走
    // 的就是这条链路)。
    // **同步进度与播放模式(2026-08-11 用户要求"参考视频岛切换逻辑")**:
    // VoiceBubble 播放时经上报带 position(节流 ~1Hz)与 loop(循环按钮);
    // 移交时一并传给宿主——音乐模式从该位置续播(不从头),循环同步为
    // 单曲循环;正在播放的音频**不中断**(宿主 addTrackUrl 直接用原始
    // src 立即播放,不再 fetch 转码等待)
    const playingAudio =
      playingMedia && playingMedia.kind === 'audio' && playingMedia.playing && playingMedia.src
        ? playingMedia
        : null
    // **仅"收起为多媒体岛"(mediaMini)执行音频移交(2026-08-12 修复
    // "播放音频时点收起为灵动岛,结果切成音乐模式"——用户实测):移交的
    // 语义 = 面板卸载后由音乐模式续播,那是多媒体岛的专属行为;收起为
    // 灵动岛(mediaMini:false) = 纯 Agent 紧凑态,音频随面板卸载停止,
    // 不切音乐模式
    if (mediaMini && playingAudio && onAgentAudioHandoffRef.current) {
      onAgentAudioHandoffRef.current({
        src: playingAudio.src,
        name: playingAudio.name,
        position: playingAudio.position,
        loop: playingAudio.loop,
      })
    }
    agentPlayingRef.current = null
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
        const conflicts = conflictsWithBar(fullTextWidth)
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
    // doCollapse 体依赖大量 ref/稳定回调,依赖数组保持空(避免无谓重建);
    // releasePress 为稳定 useCallback 但声明在其后(前向引用 TDZ),此处豁免
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * 展开/收起切换(单动画:收起 = 宽度/高度同时收缩 + 压感回弹并行,
   * 与音乐模式一致,无两段式割裂)
   */
  const changeExpanded = useCallback(
    (value: boolean, opts?: { mediaMini?: boolean }) => {
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
      doCollapse(opts)
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

  /** 结束按压:取消渐进循环并回弹(useCallback 稳定引用,供 window 监听绑定/解绑) */
  const releasePress = useCallback(() => {
    cancelAnimationFrame(pressRafRef.current)
    setPress(null)
  }, [])

  // 岛体按压/长按的指针事件(2026-08-18 修复回归):**不用 setPointerCapture**——
  // pointerdown 冒泡顺序是子→父,文字区/进度条先捕获,岛体再捕获会**覆盖**
  // 子元素捕获,导致文字区 swipe 的 pointermove/up 不再派发(Agent 模式手势
  // 切换失效的根因)。改用 window 级 pointermove/up/cancel 监听,移出岛体仍
  // 能收到事件(slop 取消失效、长按误触发、按压态滞留的问题同样解决),且不
  // 与任何子元素手势冲突。绑定在 handleIslandPointerDown 设 pressRef 后进行,
  // 命中即自我移除(引用稳定,不会泄漏)
  const handlePressMove = useCallback((event: globalThis.PointerEvent) => {
    const press = pressRef.current
    if (!press || press.pointerId !== event.pointerId) return
    if (
      Math.hypot(event.clientX - press.startX, event.clientY - press.startY) >
      LONG_PRESS_SLOP_PX
    ) {
      window.clearTimeout(press.timer)
      pressRef.current = null
      window.removeEventListener('pointermove', handlePressMove)
      window.removeEventListener('pointerup', handlePressEnd)
      window.removeEventListener('pointercancel', handlePressEnd)
      releasePress() // 位移超阈值视为滑动/拖动,取消按压
    }
    // move/end 互相引用(slop 取消需同时移除两个监听);两者均稳定,无陈旧闭包
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [releasePress])
  const handlePressEnd = useCallback((event: globalThis.PointerEvent) => {
    const press = pressRef.current
    if (!press || press.pointerId !== event.pointerId) return
    window.clearTimeout(press.timer)
    pressRef.current = null
    window.removeEventListener('pointermove', handlePressMove)
    window.removeEventListener('pointerup', handlePressEnd)
    window.removeEventListener('pointercancel', handlePressEnd)
    releasePress() // 松手回弹
    // 同上:move/end 互相引用,两者稳定,运行时无陈旧闭包
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [releasePress])
  const bindPressWindow = useCallback(() => {
    window.addEventListener('pointermove', handlePressMove)
    window.addEventListener('pointerup', handlePressEnd)
    window.addEventListener('pointercancel', handlePressEnd)
  }, [handlePressMove, handlePressEnd])

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
    // 多指防护(2026-08-18 设计规范):已有按压手势时忽略新指针(松手由
    // window 级 pointerup 监听兜底保证必达,pressRef 在松手即清空,
    // 非空即代表第二根手指)
    if (prev) return
    // 不做 setPointerCapture(2026-08-18 修复回归):会覆盖文字区/进度条
    // 先建立的捕获,导致子元素手势失效。移出岛体后的事件由 window 级
    // pointermove/up/cancel 监听兜底(bindPressWindow 在设 pressRef 时绑定)
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
        pointerId: event.pointerId,
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
      bindPressWindow()
      return
    }
    pressRef.current = {
      startX,
      startY,
      pointerId: event.pointerId,
      timer: window.setTimeout(() => {
        pressRef.current = null
        suppressClickRef.current = true // 吞掉松手后那次 click,避免刚展开即被收起
        window.clearTimeout(suppressTimerRef.current)
        suppressTimerRef.current = window.setTimeout(() => {
          suppressClickRef.current = false
        }, SUPPRESS_CLICK_MS)
        releasePress() // 按压回弹 → 同时伸缩展开
        setExpandedWidth(clampExpandedWidth())
        // 长按展开(2026-08-08 修复"长按边缘切换成音乐模式"):作废
        // 文字区滑动手势——展开已由长按触发,按住期间的后续移动(哪怕
        // 达到位移阈值)是长按的延续,不是 swipe,不应切回音乐/切歌
        swipeRef.current = null
        // Agent 模式:展开同一帧切到聊天视图(与 setExpanded 批量提交),
        // 高度目标直接是 --agent-h,避免"先朝 244 形变再改目标"的二次
        // 重定向抖动(视图切换 effect 兜底运行中/设置类视图保留)
        if (agentActive) {
          setPanelView((view) => (view === 'control' || view === 'list' ? 'agent' : view))
        }
        changeExpanded(true)
      }, LONG_PRESS_MS),
    }
    bindPressWindow()
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
    // **单击不展开(2026-08-10 用户澄清撤销)**:挂件版展开 = **长按**
    // (450ms),单击留给文字区快捷手势(双击播放/暂停、三连击切 Agent、
    // 左滑右滑切歌)——单击展开会把全部手势吞掉,用户实测文字区快捷
    // 手势失效,恢复原逻辑;onChange 缺失时单击无操作(Web 演示版有
    // onChange 时切换播放状态)
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
    const conflicts = conflictsWithBar(fullTextWidth)
    const natural = measureNaturalWidth(island)
    const targetPx = conflicts ? MAX_WIDTH_PX : Math.min(natural + HOVER_EXTEND_PX, MAX_WIDTH_PX)
    applyTextLayout(island, textEl, fullTextWidth, targetPx, true)
    setIslandWidth(`${targetPx}px`)
  }

  // 模式切换(音乐 ↔ Agent,如三连击快捷切换):compact 态清除悬停扩展态。
  // 鼠标在切换瞬间未离开岛体,hoveredRef 滞留 → 切到 Agent 后右侧进度条
  // 占位残留(实测:三连击切 Agent 右侧仍占位,重新悬浮才正常);重置为
  // 自然宽 + 悬停布局复位
  useEffect(() => {
    if (expandedRef.current) return
    hoveredRef.current = false
    setHovered(false)
    const island = islandRef.current
    const textEl = textRef.current
    if (island && textEl) {
      const natural = measureNaturalWidth(island)
      applyTextLayout(
        island,
        textEl,
        measureTextWidth(displayText, getComputedStyle(textEl).font),
        natural,
        false,
      )
      setIslandWidth(`${natural}px`)
    }
    // 依赖只取 agentActive:**不能**随 displayText 重跑——本 effect 会
    // 清空悬停态(hoveredRef/setHovered),紧凑态文字变化(如 agent 状态
    // 文案)时重跑会把用户正在悬停的岛体打回自然宽;文字驱动的布局
    // 由 displayText/visibleText 的 effect(上方)负责
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentActive])

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

  // Agent 面板高度/缩放布局(2026-08-07 抽出 hook:高度 JS 动画状态机、
  // 界面缩放与持久化、进入视图滑升、缩放同步窗口宽度——行为与内联时
  // 完全一致,高度动画首次可独立测试)
  const { setAgentPanelH, agentScale, handleAgentScaleChange, agentHReady } = useAgentPanelLayout({
    islandRef,
    panelView,
    expandedWidth,
    expanded,
    agentActive,
    onAgentPanelSize,
    onAgentPanelWidth,
  })

  // 外部请求(托盘菜单"设置"/托盘"多媒体库")打开设置类视图:
  // seq 变化即展开并切换(帮助手册已移除 2026-08-10;多媒体库优先)
  // 修复(2026-08-19):seq 是单调递增的常驻值,一旦触发就 ≥1。若用
  // `requestMediaLibrarySeq ? media-library : settings` 判断来源,先开过
  // 多媒体库(seq≥1)后,之后即使点的是"设置",mediaLibrarySeq 仍为真 →
  // 永远误入多媒体库。改用两组 seq 的**增量**比较:本轮只有递增的那一组
  // 才被兑现,另一组不视为新请求,互不干扰。
  const prevSettingsSeqRef = useRef(requestSettingsSeq ?? 0)
  const prevMediaLibrarySeqRef = useRef(requestMediaLibrarySeq ?? 0)
  useEffect(() => {
    const sSeq = requestSettingsSeq ?? 0
    const mSeq = requestMediaLibrarySeq ?? 0
    const settingsUp = sSeq > prevSettingsSeqRef.current
    const mediaUp = mSeq > prevMediaLibrarySeqRef.current
    prevSettingsSeqRef.current = sSeq
    prevMediaLibrarySeqRef.current = mSeq
    if (!settingsUp && !mediaUp) return
    // 两组同帧递增时优先多媒体库(原"多媒体库优先"语义保留)
    setPanelView(mediaUp ? 'media-library' : 'settings')
    setExpandedWidth(clampExpandedWidth())
    changeExpanded(true)
  }, [requestSettingsSeq, requestMediaLibrarySeq, changeExpanded])
  // 多媒体库独立菜单(2026-08-08 用户要求:不属设置范畴,设置入口移除):
  // 返回键行为 = 从哪来回哪去——托盘呼出(seq 路径)= 收起岛体;
  // Agent 对话 ⋯ 菜单呼出 = 回到对话视图
  const mediaLibraryBackRef = useRef<(() => void) | null>(null)
  // 背景编辑器返回目标(2026-08-08 用户要求"图片右键跳转后返回直接回
  // 多媒体库"):多媒体库图片右键"应用到背景"跳转时记录返回目标,
  // 背景编辑器返回键按此回多媒体库;其余入口(设置视图)返回设置视图
  const backgroundBackRef = useRef<(() => void) | null>(null)

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
    // 采样失败(null)→ 按深色底白字(与内联时 onerror 语义一致)
    void sampleImageBrightness(bg).then((avg) => {
      setAutoDarkText(avg != null && avg > 130)
    })
  }, [backgroundExpandedImage, backgroundCompactImage, expanded, fontColor?.mode])

  // 面板视图变化通知宿主(背景视图需要更高的岛体与窗口)
  // 进入 Agent 设置视图前刷新配置:LLM 对话中 mcp_config/skills_config
  // 写的配置立即可见(useAgent 只在挂载时读一次)。刷新必须在视图渲染前
  // 触发且只在 panelView 变化时一次——不能在 AgentSettingsView 挂载后
  // 刷新(异步返回重置正在编辑的表单,实测丢失编辑);agentConfig 经 ref
  // 访问(对象字面量每次渲染新引用,进依赖会无限循环刷新)
  const agentConfigRef = useRef(agentConfig)
  agentConfigRef.current = agentConfig
  useEffect(() => {
    onPanelViewChange?.(panelView)
    if (panelView === 'agent-settings') agentConfigRef.current?.onRefresh?.()
  }, [panelView, onPanelViewChange])

  // 媒体小窗尺寸(2026-08-10 用户要求"根据对应媒体元素在对话窗口的
  // 大小同步其大小,做成一模一样的小窗"):快照带 width/aspect(播放
  // 报告透传,MediaFrame 拖拽缩放/切回面板均同步)时小窗 = 媒体元素
  // 尺寸(宽 = width,高 = width / aspect);无尺寸(静态快照/图片)回退
  // 默认 264×148。窗口 = 岛体 + 40(复用 onAgentPanelSize 约定)。
  // 声明在本 effect 之后:收起时本 effect 晚于面板视图回落
  // (handlePanelViewChange 先设常规窗口),后发覆盖先发,窗口落到小窗
  // 尺寸。小窗无关闭键(2026-08-09 用户要求移除 ✕),退出 = 长按展开
  // 回面板(窗口由面板尺寸接管)
  const miniSize =
    agentMini?.width && agentMini.aspect
      ? {
          w: Math.round(agentMini.width),
          h: Math.round(agentMini.width / agentMini.aspect),
        }
      : { w: AGENT_MINI_W, h: AGENT_MINI_H }
  useEffect(() => {
    if (!expanded && agentActive && agentMini) {
      onAgentPanelSize?.(miniSize.w, miniSize.h)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- miniSize 由 agentMini 派生
  }, [expanded, agentActive, agentMini, onAgentPanelSize])

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
      // 卸载时移除岛体按压的 window 级监听(引用稳定,防泄漏)
      window.removeEventListener('pointermove', handlePressMove)
      window.removeEventListener('pointerup', handlePressEnd)
      window.removeEventListener('pointercancel', handlePressEnd)
    },
    [handlePressMove, handlePressEnd],
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
  // 粗细随设置(300-900 档位,2026-08-11 用户要求"更多选择";**原
  // 白名单只有 400/600/800,扩展后的 300/500/700/900 被过滤成
  // undefined = 切换无响应**,改为 FONT_WEIGHTS 校验)
  const islandFontFamily = fontDataUrl
    ? `'${CUSTOM_FONT_FAMILY}', ${getComputedStyle(document.body).fontFamily}`
    : undefined
  const islandFontWeight =
    fontWeight && FONT_WEIGHTS.includes(fontWeight) ? fontWeight : undefined

  const stateClass = state === 'playing' || state === 'idle' ? '' : state

  const isLoading = state === 'loading'

  const textTransform =
    textMotion === 'out'
      ? `translateY(-${TEXT_RISE_PX}px)`
      : textMotion === 'below'
        ? `translateY(${TEXT_RISE_PX}px)`
        : 'translateY(0)'
  // 文字位移动画(2026-08-18 设计规范:UI 禁用 ease-in——起步缓慢感觉迟钝;
  // 离场改强 ease-out"先快后慢"立即响应,入场用无过冲缓出;mask-size 从
  // 0.45s 弹簧收敛到 0.3s 无过冲,减少 paint 属性动画时长)
  const textTransition =
    `opacity ${textMotion === 'out' || textMotion === 'below' ? FADE_OUT_MS : FADE_IN_MS}ms ${
      textMotion === 'out' || textMotion === 'below'
        ? 'cubic-bezier(0.23, 1, 0.32, 1)'
        : 'cubic-bezier(0.22, 1, 0.36, 1)'
    }, ` +
    `transform ${
      textMotion === 'out' || textMotion === 'below' ? FADE_OUT_MS : FADE_IN_MS
    }ms ${
      textMotion === 'out' || textMotion === 'below'
        ? 'cubic-bezier(0.23, 1, 0.32, 1)'
        : 'cubic-bezier(0.22, 1, 0.36, 1)'
    }, ` +
    `mask-size 0.3s cubic-bezier(0.22, 1, 0.36, 1)`

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

  // 媒体小窗激活:Agent 模式紧凑态 + 有快照(音频不在此,走切音乐模式)
  const miniActive = agentActive && !expanded && agentMini && agentMini.kind !== 'audio'

  return (
    <div
      ref={islandRef}
      className={`island-demo${stateClass ? ` ${stateClass}` : ''}${modeClass ? ` ${modeClass}` : ''}${expanded ? ' expanded' : ''}${press ? ' is-pressed' : ''}${collapsing ? ' island-collapsing' : ''}${animating ? ' is-animating' : ''}${lyricFold ? ' island-lyric-off' : ''}${miniActive ? ' island-agent-mini' : ''}${panelView === 'background' ? ` island-bg-view${bgTarget === 'compact' ? ' island-bg-view--compact' : ''}` : ''}${panelView === 'font-library' || panelView === 'image-library' ? ' island-lib-view' : ''}${panelView === 'media-library' ? ' island-lib-view island-media-lib-view' : ''}${panelView === 'font' ? ' island-font-view' : ''}${panelView === 'font-color' ? ' island-font-color-view' : ''}${panelView === 'theme' ? ' island-theme-view' : ''}${panelView === 'agent' ? ' island-agent-view' : ''}${panelView === 'agent' && agentHReady ? ' agent-height-ready' : ''}${panelView === 'agent-settings' ? ' island-agent-settings-view' : ''}${panelView === 'settings' ? ' island-settings-view' : ''}${panelView === 'lyric-api' ? ' island-lyric-api-view' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`灵动岛,当前状态:${agentActive ? 'Agent' : ISLAND_STATES[state].label},点击切换,长按展开`}
      aria-expanded={expanded}
      style={
        {
          // Agent 展开态 = 逻辑宽 × 界面缩放(高度由 CSS var(--agent-h)
          // 计算);其余视图 = 逻辑展开宽(帮助手册已移除 2026-08-10)
          width: expanded
            ? agentActive
              ? `${Math.round(expandedWidth * (agentScale / 100))}px`
              : `${expandedWidth}px`
            : miniActive
              ? `${miniSize.w}px`
              : islandWidth,
          // 媒体小窗高度(2026-08-10 尺寸同步):快照带尺寸时 = 宽/宽高比
          // (与面板里媒体元素一模一样);行内覆盖 CSS 默认 148px
          height: miniActive ? `${miniSize.h}px` : undefined,
          '--state-color': theme,
          // 字体颜色(主文字/次级文字),null 时 CSS fallback 白色系
          '--text-color': resolvedTextColor ?? undefined,
          '--text-dim': textDimColor,
          // Agent 界面缩放系数(100% = 1):消息内嵌图片按此等比放大
          // (AgentImage 组件读取;原 CSS 注释声称 JS 设置但从未落盘)
          '--agent-s': agentActive ? agentScale / 100 : 1,
          transform: pressTransform,
          transformOrigin: pressOrigin,
          // 自定义字体:岛体 font-family 覆盖,后代继承
          fontFamily: islandFontFamily,
          // 字体粗细(全部文字生效)
          fontWeight: islandFontWeight,
          // Agent 面板高度(CSS 变量 --agent-h)由高度动画循环直接写 DOM,
          // 不经过 React state(60fps 动画不触发整岛重渲染)——此处不再声明
        } as CSSProperties
      }
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onPointerDown={handleIslandPointerDown}
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
      {/* 媒体小窗(2026-08-09):收起面板后岛体变形成小窗视频/图片;
          常规紧凑态保持图标 + 文字区 */}
      {miniActive && agentMini ? (
        <AgentMediaMini media={agentMini} onExpand={() => changeExpanded(true)} />
      ) : (
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
      )}
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
              // 返回目标 = 从哪来回哪去(多媒体库右键应用 → 回多媒体库;
              // 设置视图入口 → 回设置视图;一次即清)
              onBack={() => {
                const back = backgroundBackRef.current
                backgroundBackRef.current = null
                if (back) back()
                else setPanelView('settings')
              }}
            />
          ) : null}
          {/* 设置视图(托盘菜单入口,岛内打开):设置类功能的总入口,
              自定义背景 / 主题色 / 字体按宿主能力显隐(帮助手册已移除
              2026-08-10)。**返回收起 = 收起为灵动岛(2026-08-10 用户
              要求:设置等返回默认 Agent 紧凑态,不生成多媒体岛;
              "收起为多媒体岛"仅 ⋯ 菜单显式入口)** */}
          {panelView === 'settings' ? (
            <SettingsView
              onOpenBackground={onBackgroundChange ? () => setPanelView('background') : undefined}
              onOpenTheme={onThemeChange ? () => setPanelView('theme') : undefined}
              onOpenFont={onFontAdd || onFontLibraryChange ? () => setPanelView('font') : undefined}
              onOpenAgent={agentConfig ? () => setPanelView('agent-settings') : undefined}
              onOpenLyricApi={() => setPanelView('lyric-api')}
              onBack={() => changeExpanded(false, { mediaMini: false })}
            />
          ) : null}
          {/* 多媒体库(2026-08-08,独立菜单:托盘/Agent 菜单呼出,设置入口
              已移除——不属设置范畴,Agent 设置面板大小):
              图片/音频/视频三库增删改查,音频导入播放列表。
              返回 = 收起岛体(托盘呼出)或回到对话视图(⋯ 菜单呼出) */}
          {panelView === 'media-library' ? (
            <MediaLibraryView
              imageLibrary={imageLibrary}
              onImageLibraryChange={onImageLibraryChange}
              audioLibrary={audioLibrary}
              onAudioLibraryChange={(items) => onAudioLibraryChange?.(items)}
              videoLibrary={videoLibrary}
              onVideoLibraryChange={(items) => onVideoLibraryChange?.(items)}
              onAddToPlaylist={(items) => onAddLibraryTracks?.(items)}
              onVideoImport={onVideoImport}
              // 图片右键"应用到背景"(2026-08-08):把库中图片直接导入
              // 对应形态槽位(裁切参数复位默认,只需手动调整方位)并
              // 跳转背景编辑器——省略导入步骤
              onApplyImageToBackground={(target, dataUrl) => {
                if (!onBackgroundChange) return
                const crop = backgroundCrop ?? { expanded: DEFAULT_BG_CROP, compact: DEFAULT_BG_CROP }
                onBackgroundChange({
                  expandedImage: (target === 'expanded' ? dataUrl : backgroundExpandedImage) ?? null,
                  compactImage: (target === 'compact' ? dataUrl : backgroundCompactImage) ?? null,
                  opacity: backgroundOpacity ?? { expanded: 0.4, compact: 0.4 },
                  expanded: target === 'expanded' ? DEFAULT_BG_CROP : crop.expanded,
                  compact: target === 'compact' ? DEFAULT_BG_CROP : crop.compact,
                })
                // 返回目标 = 多媒体库(用户要求:调整方位后直接返回多媒体库,
                // 不经过设置视图)
                backgroundBackRef.current = () => setPanelView('media-library')
                setPanelView('background')
              }}
              onBack={() => {
                const back = mediaLibraryBackRef.current
                mediaLibraryBackRef.current = null
                if (back) back()
                // 托盘呼出路径:返回收起 = 收起为灵动岛(2026-08-10 用户
                // 要求与设置一致,不生成多媒体岛)
                else changeExpanded(false, { mediaMini: false })
              }}
              // LLM 工具 play_library_video(2026-08-10):定位播放指定视频
              autoPlayVideoId={mediaLibraryPlayId}
              onAutoPlayConsumed={onMediaLibraryPlayConsumed}
            />
          ) : null}
          {/* 歌词 API 接入点(设置视图"歌词 API"入口):预设厂家 + 自定义 */}
          {panelView === 'lyric-api' ? (
            <LyricApiView onBack={() => setPanelView('settings')} />
          ) : null}
          {/* Agent 聊天视图(agent 模式展开默认;只保留长按收回,
              设置类视图除外)。**agentHReady 门闩(2026-08-08 修复"展开
              动画图中 UI 透明")**:宽度动画期间面板不挂载(岛体 56 高
              宽条内面板被裁切、compact 内容已淡出 = 全透明),高度
              动画就绪后才挂载面板(淡入 + 测量 + 高度展开同步) */}
          {panelView === 'agent' && agent && agentHReady ? (
            <AgentView
              {...agent}
              // ⋯ 菜单"设置"入口:切换到 Agent 设置视图(设置类视图,
              // 只能经返回键退出);"多媒体库"入口切视图(独立菜单,
              // 返回回到对话视图)
              onOpenSettings={() => setPanelView('agent-settings')}
              onOpenMediaLibrary={() => {
                mediaLibraryBackRef.current = () => setPanelView('agent')
                setPanelView('media-library')
              }}
              onCollapse={() => changeExpanded(false)}
              // 收起为灵动岛(2026-08-10 用户要求):收起成 Agent 紧凑态,
              // 不生成媒体岛
              onCollapseMini={() => changeExpanded(false, { mediaMini: false })}
              onHeightChange={setAgentPanelH}
              onMediaSnapshot={setAgentLastMedia}
            />
          ) : null}
          {/* Agent 设置(设置视图"Agent 设置"入口,设置类视图:只能经返回键退出):
              API Key / Base URL / 模型 / 系统提示词,持久化走主进程 settings.json */}
          {panelView === 'agent-settings' && agentConfig ? (
            <AgentSettingsView
              config={agentConfig.config}
              onSave={agentConfig.onSave}
              // tools 单通道:AgentPanelProps(与 AgentView 工具列表同源,
              // 审计 P1 #4 消双通道冗余)
              tools={agent?.tools}
              scale={agentScale}
              onScaleChange={handleAgentScaleChange}
              mediaWindowWidth={mediaWindowWidth}
              onMediaWindowWidthChange={onMediaWindowWidthChange ?? (() => {})}
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
