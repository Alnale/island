/**
 * 灵动岛布局与颜色工具(从 DynamicIsland.tsx 拆出,保持原逻辑逐字不变):
 * - 动画时序 / 尺寸常量(组件内 JS 测量与 CSS 过渡共用的锚点)
 * - 文字测量 / 截断 / 渐隐让位 / 自然宽度测量(px→px 过渡的布局算法)
 * - 取色器颜色换算(HEX ↔ HSV)
 */

// 动画时序(与 CSS 中宽度过渡 0.5s 保持同步)
export const FADE_OUT_MS = 130 // 文字上移淡出时长
export const TEXT_SWAP_MS = 140 // 淡出完成后换新文字
export const FADE_IN_MS = 240 // 新文字上移淡入时长
export const FADE_IN_DELAY_MS = 450 // 宽度回弹基本结束后再淡入,避免缩小回弹时文字被裁剪
export const FADE_IN_FAST_MS = 40 // 宽度无需变化时快速淡入
export const TEXT_RISE_PX = 6 // 文字滑动距离
export const MAX_WIDTH_PX = 500 // 与 CSS max-width 保持一致
// 岛体固定内容宽度(不含文字):边框 2 + 内边距 56 + 图标 28 + 单段 gap 14(进度条已绝对定位)
export const ISLAND_BASE_PX = 100
// 文字元素左偏移:边框 1 + 内边距 28 + 图标 28 + gap 14(相对岛 border-box 左缘)
/** 文字是否与进度条冲突(悬停展开时完整文字 + 进度条放不下的判断;
 * 原内联 ×4 收敛,审计 P2) */
export function conflictsWithBar(fullTextWidth: number): boolean {
  return fullTextWidth + PROGRESS_WIDTH_PX + PROGRESS_RIGHT_MARGIN_PX + TEXT_LEFT_PX > MAX_WIDTH_PX
}

export const TEXT_LEFT_PX = 71
// 进度条:宽度 130 + 距岛右缘 30(内边距 28 + 边框 2)
export const PROGRESS_WIDTH_PX = 130
export const PROGRESS_RIGHT_MARGIN_PX = 30
// 进度条左缘与文字尾部之间的间距(悬停时防止进度条贴字;
// 渐隐时保证渐隐终点到进度条左缘之间有纯黑间隔,不与半透明文字叠加)
export const BAR_TAIL_GAP_PX = 14
// 悬停展开增量:让进度条排在文字尾部之后(文字左偏移 + 进度条总占位 + 间距 - 岛基础宽)
export const HOVER_EXTEND_PX =
  TEXT_LEFT_PX + PROGRESS_WIDTH_PX + PROGRESS_RIGHT_MARGIN_PX + BAR_TAIL_GAP_PX - ISLAND_BASE_PX
// 省略号占位宽度(font-size 0.95rem ≈ 15px) + 余量
export const ELLIPSIS_SLOT_PX = 18
// 无需让位时的遮罩宽度:把渐变末 12% 的渐隐区整体推出文字右缘之外,文字完全不透明
export const MASK_NO_FADE = 'calc(100% + 20%)'
// 进度条键盘方向键步进(秒)
export const SEEK_STEP_SEC = 5
// 文字区滑动手势判定阈值(px):横向位移超过该值且明显大于纵向时触发
export const SWIPE_THRESHOLD_PX = 36
// 文字区歌曲名/歌手名循环切换间隔(原 3s,调慢 3 倍避免频繁轮播)
export const TRACK_CYCLE_MS = 9000
// 长按触发展开的持续时间(ms),参考 iOS 长按手感
export const LONG_PRESS_MS = 450
// 长按判定允许的指针位移(px):移动超过该值视为滑动/拖动,取消长按
export const LONG_PRESS_SLOP_PX = 8
// 文字区滑动手势时间窗(ms,2026-08-08 修复"长按边缘误切换音乐模式"):
// swipe 是快速滑动——按下后须在该时间内达到位移阈值才算手势,
// 长按(450ms)取消后的慢速位移/手抖不触发
export const SWIPE_TIME_MS = 300
// 展开后的岛宽(px):胶囊形变为更大的圆角矩形
export const EXPANDED_WIDTH_PX = 400
// 展开岛宽距视口左右的最小边距(px)
export const EXPANDED_VIEWPORT_MARGIN_PX = 80
// 展开最小宽度(px),小屏兜底
export const EXPANDED_MIN_WIDTH_PX = 240
/** 展开宽度钳制(长按展开/外部请求共用,原内联 ×3 收敛):
 * viewport 余量内取标准展开宽,小屏取最小宽 */
export function clampExpandedWidth(): number {
  return Math.max(
    EXPANDED_MIN_WIDTH_PX,
    Math.min(EXPANDED_WIDTH_PX, window.innerWidth - EXPANDED_VIEWPORT_MARGIN_PX),
  )
}
// 收起后隐藏悬停进度条的时长(ms),等岛收缩完成再淡入(1.5 倍速)
export const COLLAPSE_HIDE_MS = 320
// suppressClick 标记的有效期(ms):长按松手后的 click 在此窗口内被吞,
// 过期自动清除(面板按钮点击不触发岛 click,防止标记滞留吞掉后续收起点击)
export const SUPPRESS_CLICK_MS = 600
// 形变动画期间关闭毛玻璃的时长(ms),略长于宽度/高度弹簧过渡(1.5 倍速)
export const MORPH_ANIMATE_MS = 400
// Agent 展开宽度动画时长(ms,2026-08-09 优化"展开不够平滑"):与
// views-agent.css 的 width 过渡同步——agentHReady(串行展开的第二段
// 高度动画门闩)在此刻触发,宽度刚到位高度立即开始,**消除原 400ms
// 计时 vs 240ms 宽度过渡之间 160ms 的空等顿点**
export const AGENT_WIDTH_ANIMATE_MS = 300
// 播放模式图标"线条重组"动画时长(ms),含涟漪清理
export const MODE_ICON_MORPH_MS = 420

/** 面板视图(渲染哪个面板分支);宿主据此调整窗口高度。
 * help 已移除(2026-08-10 用户要求) */
export type PanelView =
  | 'control'
  | 'list'
  | 'theme'
  | 'background'
  | 'font'
  | 'font-color'
  | 'font-library'
  | 'image-library'
  | 'media-library'
  | 'settings'
  | 'agent'
  | 'agent-settings'
  | 'lyric-api'

/** 主题色预设(与播放模式/状态色同一色系,供主题色视图) */
export const THEME_PRESETS = [
  '#4ade80',
  '#60a5fa',
  '#a78bfa',
  '#f87171',
  '#fbbf24',
  '#22d3ee',
  '#f472b6',
]

/** 0..1 区间夹取(取色器指针换算用) */
export function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

// Agent 面板岛体高度自适应:固定部分(头部 26 + 输入 34 + 间距 20 +
// 内边距 26 ≈ 106,取 116 留余量)、下限 176(2026-08-11 从 200 下调:
// 0 消息自然高 = 固定区 116 + 欢迎语 ~41 ≈ 157,下限 176 = 新对话面板
// 保持矮小,不再被 200 顶高)、上限 700(2026-08-11 从 600 上调:窗口
// 高度 1:1 跟随内容、上限 = 宽度 9/16——高缩放比例(300% 时 16:9 =
// 675)下内容测高必须能超过 600 才能到达 16:9 上限,否则"最大高度
// 比 16:9 小,大概 6、7";内容超高滚动)。
// CSS 的 .island-agent-view height 与 .island-agent-messages max-height
// 同步用 --agent-h 变量(差值 = FIXED_H)
export const AGENT_PANEL_FIXED_H = 116
export const AGENT_PANEL_MIN_H = 176
export const AGENT_PANEL_MAX_H = 700
/** 高度预算余量(2026-08-13 用户实测"切会话收起面板后单条消息底部被
 * 截断"):FIXED_H + contentH + bannerH 是零余量预算——offsetHeight 取整
 * 与行高小数叠加,消息区实际可用高比内容矮 1-2px,最后一条消息底缘
 * 被裁、与输入框之间没有留空(会话横幅占一行时最明显)。预算加 6px
 * 余量,消息区永远比内容多出呼吸空间,视觉不可感知 */
export const AGENT_PANEL_HEIGHT_SLACK = 6
/** 展开首帧骨架屏时长(ms):形变动画期间先渲染轻量占位,之后挂载真实内容。
 *  120ms:形变(0.3s)进行到约 1/3 时挂载内容并测量——高度从该点以 CSS
 *  过渡并入宽度动画(并行动画;若等形变结束才测,就变成"先宽后高"顺序) */
export const AGENT_PHASE_IN_MS = 340
/** 紧凑态岛体高度(px,与 CSS .island-demo 的 height 一致):
 *  Agent 面板高度动画从紧凑高度起步,展开/重进时平滑滑升 */
export const ISLAND_COMPACT_H = 56
/** 展开面板固定高度(px,与 CSS .island-demo.expanded 的 height 一致):
 *  Agent 设置视图入口动画的起点下限——settings 视图显示高度即此值 */
export const ISLAND_PANEL_H = 244
/** Agent 设置视图岛体高度(px,与 CSS .island-agent-settings-view 的
 *  height 一致):从设置视图切入时,高度动画从当前显示高度滑升到此值
 *  (参考 Agent 展开的"先变宽再变长"形变,窗口逐帧跟随) */
export const AGENT_SETTINGS_H = 540

// 背景裁切参考尺寸:展开态 400×244、紧凑态 280×56(挂件典型宽度)。
// 岛体根部背景图 CSS 变量与 BackgroundView 视口共用同一套计算
export const BG_CROP_REF_W = 400
export const BG_CROP_REF_H = 244
export const BG_COMPACT_REF_W = 280
export const BG_COMPACT_REF_H = 56

/** 背景尺寸 %(相对元素宽度):1x = cover;null = 图片尺寸未知(加载中) */
export function bgSizePctFor(
  refW: number,
  refH: number,
  zoom: number,
  w: number,
  h: number,
): number {
  return Math.max(100, (refH / refW) * (w / h) * 100) * zoom
}

/** HEX → HSV(岛内自绘取色器状态) */
export function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return { h: 0, s: 0, v: 1 }
  const n = parseInt(m[1], 16)
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const b = (n & 255) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: max === 0 ? 0 : d / max, v: max }
}

/** HSV → HEX(拖拽取色实时提交) */
export function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s
  const hp = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let r = 0
  let g = 0
  let b = 0
  if (hp < 1) [r, g, b] = [c, x, 0]
  else if (hp < 2) [r, g, b] = [x, c, 0]
  else if (hp < 3) [r, g, b] = [0, c, x]
  else if (hp < 4) [r, g, b] = [0, x, c]
  else if (hp < 5) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const m = v - c
  const q = (n: number) =>
    Math.max(0, Math.min(255, Math.round((n + m) * 255)))
      .toString(16)
      .padStart(2, '0')
  return `#${q(r)}${q(g)}${q(b)}`
}

/**
 * 文字位移动画阶段:
 * - idle: 初始静止
 * - out:  上移淡出中(transform 0 → -rise)
 * - below: 已换内容,藏在下方等宽度回弹结束(opacity 0,transform +rise,不可见)
 * - in:   从下方上移淡入(+rise → 0)
 */
export type TextMotion = 'idle' | 'out' | 'below' | 'in'

/** canvas 文本宽度测量(与 DOM 渲染同字体,结果一致) */
let textMeasureCanvas: HTMLCanvasElement | null = null

export function measureTextWidth(text: string, font: string): number {
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
// 按字素拆分(完整 emoji / ZWJ 序列 / 组合字符):UTF-16 按代码单元切片
// 会劈开代理对(emoji 显示成 �)。Intl.Segmenter 不可用时退 code point 级
const graphemeSegmenter =
  typeof Intl.Segmenter !== 'undefined'
    ? new Intl.Segmenter('zh', { granularity: 'grapheme' })
    : null

function splitGraphemes(text: string): string[] {
  if (graphemeSegmenter) {
    return [...graphemeSegmenter.segment(text)].map((s) => s.segment)
  }
  return Array.from(text)
}

export function truncateText(
  text: string,
  maxWidth: number,
  font: string,
): { visible: string; truncated: boolean } {
  if (measureTextWidth(text, font) <= maxWidth) {
    return { visible: text, truncated: false }
  }
  // 二分查找在字素序列上进行(LLM 回复常带 emoji,绝不能从中劈开)
  const graphemes = splitGraphemes(text)
  let lo = 1
  let hi = graphemes.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (measureTextWidth(graphemes.slice(0, mid).join(''), font) <= maxWidth) lo = mid
    else hi = mid - 1
  }
  return { visible: graphemes.slice(0, lo).join(''), truncated: true }
}

/**
 * 应用文字尾部渐隐遮罩与进度条位置。
 * 渐隐只在悬停且"完整文字 + 进度条放不下"(目前仅播放中长文字)时启用:
 * - 非悬停或放得下:文字完全不渐隐,进度条从文字尾部后 BAR_TAIL_GAP_PX 处滑出
 * - 悬停且放不下:文字尾部渐隐让位,渐隐终点(文字完全透明点)提前到进度条
 *   左缘之前(BAR_TAIL_GAP_PX),进度条下方为纯黑背景,不与半透明文字叠加
 */
export function applyTextLayout(
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
export function measureNaturalWidth(island: HTMLElement): number {
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
