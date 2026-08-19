/**
 * Agent 聊天面板(agent 模式展开视图)
 *
 * 灵动岛设计语言:深底 + 强调色(--state-color)+ 中性胶囊按钮 + 蒙版。
 * - 消息列表:用户右侧强调色气泡,助手左侧浅底文本块(工具卡片内联,
 *   顺序即执行顺序,参数/结果全程可见 —— 过程可知);
 * - 流式:文本增量实时渲染 + 光标,工具参数流实时回显;
 * - 底部输入:Enter 发送(IME 组字中不触发)/ Shift+Enter 换行,
 *   运行中按钮变"停止"。
 *
 * 交互守卫:左键 pointerdown 在视图根部 stopPropagation,
 * 防止岛体长按收起/按压反馈把聊天面板误缩回(右键仍冒泡给挂件层拖拽)。
 */

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import type { AgentPanelProps, AgentToolInfo } from '../../../agent/types'
import { stripMcpServiceLabel } from '../../../../electron/agent/constants'
import { mediaKindOf } from './markdownParser'
import { useLeavingList } from '../../../hooks/useLeavingList'
import { getSessionNote, setSessionNote } from '../../../hooks/useAgent'
import { QuickMenu } from './QuickMenu'
import { Markdown, type AgentMediaReport } from './Markdown'
import { AssistantBlock, MasterTurnTag, PeerTurnTag, ToolSummary, UserBubble } from './AgentMessages'
import type { AgentMessage } from '../../../agent/types'
import { hasMasterTurnMark, hasTurnMark, stripTurnMarks, textFromParts } from '../../../agent/text'
import {
  AGENT_PANEL_FIXED_H,
  AGENT_PANEL_HEIGHT_SLACK,
  AGENT_PANEL_MAX_H,
  AGENT_PANEL_MIN_H,
  AGENT_PHASE_IN_MS,
  AGENT_WIDTH_ANIMATE_MS,
  SESSION_DOCK_OPEN_H,
} from '../layout'

/** 面板子视图:聊天 / 对话历史 / 工具列表 */
type AgentViewKind = 'chat' | 'history' | 'tools'

/** 头部下拉菜单项 id:⋯ 弹出菜单与快捷切换按钮共用 */
type AgentMenuItemId =
  | 'stop'
  | 'clear'
  | 'history'
  | 'tools'
  | 'media-library'
  | 'settings'
  | 'collapse'
  | 'collapse-media'

/** 快捷按钮图标(stroke 风格,与头部其他 ctl 按钮一致) */
const QUICK_MENU_ICONS: Record<AgentMenuItemId, ReactNode> = {
  stop: (
    <svg className="island-ctl-svg" width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  ),
  clear: (
    <svg
      className="island-ctl-svg"
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  history: (
    <svg
      className="island-ctl-svg"
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15 14" />
    </svg>
  ),
  tools: (
    <svg
      className="island-ctl-svg"
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
    >
      <line x1="4" y1="6" x2="20" y2="6" />
      <circle cx="14" cy="6" r="2" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <circle cx="8" cy="12" r="2" />
      <line x1="4" y1="18" x2="20" y2="18" />
      <circle cx="16" cy="18" r="2" />
    </svg>
  ),
  settings: (
    <svg
      className="island-ctl-svg"
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
  ),
  // 收起为灵动岛(2026-08-10 用户要求):收缩成紧凑岛(无媒体小窗)
  collapse: (
    <svg
      className="island-ctl-svg"
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  ),
  // 收起为多媒体岛(2026-08-10 用户要求):媒体小窗/音频移交
  'collapse-media': (
    <svg
      className="island-ctl-svg"
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="6 15 12 9 18 15" />
      <rect x="3" y="4" width="18" height="16" rx="3" />
    </svg>
  ),
  'media-library': (
    <svg
      className="island-ctl-svg"
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  ),
}
/**
 * 视图切换离场副本卸载延时(ms):必须大于 CSS 离场动画时长(0.15s),
 * 留出余量保证动画播完(forwards 停在透明)才卸载——提前卸载会
 * 在动画中途突然消失,是切换闪烁的常见原因
 */
const VIEW_LEAVE_MS = 200

/** 输入草稿持久化键(2026-08-10 用户要求"切换窗口面板不丢失输入"):
 * AgentView 卸载(收起面板/切多媒体库/设置视图/切音乐模式)后重挂载
 * 恢复未发送的输入;发送成功即清除(已消费) */
const AGENT_DRAFT_KEY = 'widget-agent-draft'

/** 骨架阈值(2026-08-17 弃虚拟滚动后):消息多(>一批)时展开先渲染轻量
 * 骨架(形变动画期间 DOM 极小),延迟后再一次全量挂载真实消息并测量长高;
 * 消息少(≤一批)直接渲染内容。不再做逐帧分批挂载(全量渲染下无意义) */
const BATCH_RENDER = 12

/** 拖拽上传的附件(2026-08-17):path = 绝对路径(Web 演示降级为文件名),
 * kind = 媒体分类(media part 对话窗口展示)/ 文件(仅路径标注让 LLM 读取) */
type DropAttachment = {
  path: string
  name: string
  size: number
  kind: 'img' | 'video' | 'audio' | 'file'
}

/** 附件类型图标(stroke 风格,与 island-ctl-svg 一致) */
function AttachIcon({ kind }: { kind: DropAttachment['kind'] }) {
  if (kind === 'img') {
    return (
      <svg className="island-attach-ic" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <polyline points="21 15 16 10 5 21" />
      </svg>
    )
  }
  if (kind === 'video') {
    return (
      <svg className="island-attach-ic" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="5" width="14" height="14" rx="2" />
        <polygon points="16 10 22 7 22 17 16 14" />
      </svg>
    )
  }
  if (kind === 'audio') {
    return (
      <svg className="island-attach-ic" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 18V5l12-2v13" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="16" r="3" />
      </svg>
    )
  }
  return (
    <svg className="island-attach-ic" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  )
}

/**
 * 平滑滚动到目标位置(自绘 rAF 插值,非线性):
 * - **先加速再减速**(easeInOutQuart)——减速段斜率陡,明显"刹车";
 * - **动态高斯模糊按速度占比二次衰减**(blur = true 时):峰值约 3.5px,
 *   速度降到峰值 25% 以下完全清除(提前消退,减速段清晰)。模糊是给
 *   长消息列表滚动动画的性能优化——没有历史消息的滚动(如新对话进入)
 *   传 blur = false,避免无谓的模糊;
 * - 时长自适应(距离越大越久,clamp 500-1200ms;进入 800ms / 发送 650ms);
 * - 用户手动滚动(滚轮/拖拽/触摸)时立即取消动画与模糊,不打架。
 * (曾加入过冲回弹,用户反馈不合适,已移除——纯滑行到位的缓动)
 */
// 2026-08-18:移除逐帧 blur 逻辑——唯一调用(scrollToBottom smooth)传
// blur=false,该分支是从未启用的死代码;且滚动中逐帧写 filter 属 paint
// 重活,软件渲染下是卡顿源。现只做 scrollTop 位移(合成友好)
function smoothScrollTo(el: HTMLElement, target: number, durationMs = 800) {
  const start = el.scrollTop
  const dist = target - start
  if (Math.abs(dist) < 1) return
  const duration = Math.min(1200, Math.max(500, durationMs))
  const startTime = performance.now()
  let cancelled = false
  const cancel = () => {
    cancelled = true
  }
  // 用户介入(滚轮/触摸/点击)即中止自绘动画,交给浏览器原生行为
  el.addEventListener('wheel', cancel, { once: true, passive: true })
  el.addEventListener('touchstart', cancel, { once: true, passive: true })
  el.addEventListener('pointerdown', cancel, { once: true })
  const easeInOutQuart = (t: number) =>
    t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2
  const step = (now: number) => {
    if (cancelled) return
    const t = Math.min(1, (now - startTime) / duration)
    el.scrollTop = start + dist * easeInOutQuart(t)
    if (t < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

/** 文本中**最后一个** markdown 媒体链接的媒体快照(2026-08-10,媒体岛
 * 判定:LLM 回复常内嵌 ![名字](路径) 而非 media part——最后出现的
 * 媒体 = 最新消息里的媒体;与 Markdown 组件渲染分派同款扩展名逻辑) */
function findLastMdMedia(
  text: string,
): { kind: 'img' | 'video' | 'audio'; src: string; name?: string } | null {
  const re = /!\[([^\]]*)\]\(([^)\s]+)\)/g
  let last: { alt: string; url: string } | null = null
  let m: RegExpExecArray | null
  while ((m = re.exec(text ?? ''))) {
    last = { alt: m[1], url: m[2] }
  }
  if (!last) return null
  const kind = mediaKindOf(last.url)
  if (!kind) return null
  return { kind, src: last.url, name: last.alt || undefined }
}

/** 历史会话时间显示:今天 → HH:MM;昨天 → 昨天;更早 → M月D日 */
function formatSessionTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return '昨天'
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/**
 * 工具列表行(2026-08-11 性能拆分:原 activeTools.map 里每次 AgentView
 * 渲染都对**所有工具**同步执行 JSON.stringify(parameters)(exec_command/
 * write_file/bili 等 schema 大,切视图必卡)且 <details> 折叠时 body
 * 仍全量渲染。参数文本 useMemo(工具清单一次加载引用稳定,仅变化时
 * 重算),**body 常驻但 grid 0fr 收起**(2026-08-18 改受控 div + grid 动画:
 * 原 details 条件渲染瞬间跳变,与窗口高度动画割裂、响应滞后;grid 平滑
 * 展开后内容随窗口高度动画并行协调,参数仅展开时可见)
 */
const ToolsItem = memo(function ToolsItem({
  tool,
  animClass,
  onDisable,
}: {
  tool: AgentToolInfo
  animClass: string
  onDisable: (name: string) => void
}) {
  const [open, setOpen] = useState(false)
  const paramsText = useMemo(() => JSON.stringify(tool.parameters, null, 2), [tool.parameters])
  return (
    <div
      className={`island-agent-tools-item${open ? ' open' : ''}${animClass}`}
      onPointerDown={(event) => {
        if (event.button === 0) event.stopPropagation()
      }}
    >
      {/* 头部:名称 + 禁用 + 箭头(受控 button,2026-08-18 改 grid 平滑展开——
          原 details 条件渲染瞬间跳变,与窗口高度动画割裂、响应滞后) */}
      <div className="island-agent-tools-head">
        <button
          type="button"
          className="island-agent-tools-summary"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="island-agent-tools-name">{tool.name}</span>
          <span className="island-agent-tools-toggle" aria-hidden="true">
            ▸
          </span>
        </button>
        <button
          type="button"
          className="island-tools-disable"
          title="禁用此工具(对话中不可用)"
          onClick={(event) => {
            event.stopPropagation()
            onDisable(tool.name)
          }}
        >
          禁用
        </button>
      </div>
      {/* body 常驻 + grid 0fr↔1fr 平滑展开(与窗口高度动画并行协调) */}
      <div className="island-agent-tools-body-wrap">
        <div className="island-agent-tools-body">
          <p className="island-agent-tools-desc">{tool.description}</p>
          <pre className="island-agent-tool-code">{paramsText}</pre>
        </div>
      </div>
    </div>
  )
})

export interface AgentViewProps extends AgentPanelProps {
  /** 收起为多媒体岛(视频/图片冻结为媒体小窗;音频播放中移交音乐模式) */
  onCollapse: () => void
  /** 收起为灵动岛(2026-08-10 用户要求:收起成 Agent 紧凑态,不生成
   * 媒体岛) */
  onCollapseMini: () => void
  /**
   * 岛体高度自适应回调:内容变化时上报目标高度(px),
   * DynamicIsland 写入 --agent-h 驱动岛体高度
   */
  onHeightChange?: (height: number) => void
  /**
   * 对话最后媒体快照(2026-08-09):收起面板时媒体小窗/音频移交的候选
   * ——从消息**数据**取最后一条含 media part 的消息的最后一个媒体
   * (数据顺序 = 消息顺序,不受分批挂载影响)
   */
  onMediaSnapshot?: (media: AgentMediaReport | null) => void
}

export function AgentView({
  status,
  messages,
  streaming,
  lastError,
  sessions,
  sessionList,
  currentSessionKey,
  unreadCounts,
  onSwitchSession,
  onDeleteExternalSession,
  tools,
  onLoadSession,
  onDeleteSession,
  onSend,
  onAbort,
  onUndo,
  onClear,
  onOpenSettings,
  onOpenMediaLibrary,
  onExcludedToolsChange,
  excludedTools,
  pendingConfirm,
  onConfirmTool,
  onCollapse,
  onCollapseMini,
  onHeightChange,
  onMediaSnapshot,
  mediaAutoPlayIds,
  onMediaAutoPlayed,
}: AgentViewProps) {
  // 稳定引用(2026-08-11,性能):消费自动播放标记回调按 id 传参,每条
  // 消息复用同一引用——内联箭头会让 AssistantBlock 的 memo 全部失效,
  // 任何一次本组件重渲染都重建全部已落定消息(视频播放 1Hz 上报/流式
  // 期间尤其放大,见 Fix B)
  // 会话面板开合(2026-08-13 会话隔离)
  const [sessionOpen, setSessionOpen] = useState(false)
  const sessionOpenRef = useRef(sessionOpen)
  sessionOpenRef.current = sessionOpen
  const dockRef = useRef<HTMLDivElement>(null)
  // 会话上下文横幅(2026-08-13 修复"收起会话面板后单条消息底部被截断"):
  // 查看外部会话时横幅占一行,高度测量须计入(见 measureHeight bannerH)
  const bannerRef = useRef<HTMLDivElement>(null)
  // 会话情况记录 + 快捷清空(2026-08-13 用户要求"给单个会话加上情况
  // 记录,可以快捷清空上下文"):横幅右侧两个操作——「记录」= 该会话
  // 上下文备忘(localStorage,注入 LLM 每轮参考,清空上下文不清除);
  // 「清空」= 两段式确认后清空该会话消息历史(abort + 擦除)
  const [sessionNoteEdit, setSessionNoteEdit] = useState(false)
  const [sessionNoteDraft, setSessionNoteDraft] = useState('')
  const [sessionNoteText, setSessionNoteText] = useState('')
  const [clearArmed, setClearArmed] = useState(false)
  const clearArmTimerRef = useRef<number | null>(null)
  // 会话删除(2026-08-18 用户要求"增加会话删除功能,除主对话";后改单击
  // 即删:原两段式确认需二次点击,用户第一击变红误以为已删 → "删除后还在
  // 列表"。删除会话属低风险(聊天/列表,可重建),改单击直接执行并进抑制
  // 窗口,交互更直观不会"看起来没删")
  const handleDeleteExternalSession = useCallback(
    (event: MouseEvent<HTMLSpanElement>, key: string) => {
      event.stopPropagation()
      void onDeleteExternalSession?.(key)
    },
    [onDeleteExternalSession],
  )
  // 记录框收起动画(2026-08-17 用户要求"呼出记录框和保存记录的动画"):
  // 保存/取消先播放收起(淡出 + 上移),动画结束后才真正关闭编辑框——
  // 直接条件切换瞬间卸载无过渡,生硬
  const [noteClosing, setNoteClosing] = useState(false)
  const noteCloseTimerRef = useRef(0)
  // 切会话:重读该会话的记录、复位编辑与确认态(并清收起定时器)
  useEffect(() => {
    window.clearTimeout(noteCloseTimerRef.current)
    setSessionNoteText(currentSessionKey ? getSessionNote(currentSessionKey) : '')
    setSessionNoteEdit(false)
    setNoteClosing(false)
    setClearArmed(false)
  }, [currentSessionKey])
  // 卸载清理确认复位定时器 + 记录框收起定时器
  useEffect(
    () => () => {
      if (clearArmTimerRef.current !== null) clearTimeout(clearArmTimerRef.current)
      window.clearTimeout(noteCloseTimerRef.current)
    },
    [],
  )
  const beginNoteClose = useCallback(() => {
    if (noteClosing) return
    setNoteClosing(true)
    window.clearTimeout(noteCloseTimerRef.current)
    noteCloseTimerRef.current = window.setTimeout(() => {
      setNoteClosing(false)
      setSessionNoteEdit(false)
    }, 200)
  }, [noteClosing])
  const startEditNote = useCallback(() => {
    // 收起动画中途再次呼出:复位(取消定时器,直接打开)
    if (noteClosing) {
      window.clearTimeout(noteCloseTimerRef.current)
      setNoteClosing(false)
    }
    setSessionNoteDraft(sessionNoteText)
    setSessionNoteEdit(true)
  }, [sessionNoteText, noteClosing])
  const saveSessionNote = useCallback(() => {
    if (currentSessionKey) {
      setSessionNote(currentSessionKey, sessionNoteDraft)
      setSessionNoteText(getSessionNote(currentSessionKey))
    }
    // 保存后播放收起动画再关闭(记录已写入,动画期间横幅停留片刻)
    beginNoteClose()
  }, [currentSessionKey, sessionNoteDraft, beginNoteClose])
  const cancelSessionNote = useCallback(() => beginNoteClose(), [beginNoteClose])
  // 快捷清空该会话上下文:两段式确认(与清除数据同款:首次点击进入
  // 确认态 3.5s 自动复位,再次点击执行)——清空 = onClear(当前会话
  // 控制器,中止运行中的回合 + 擦除消息历史 + 新会话 ID;外部会话
  // 不归档共享对话历史,见 useAgent clear)
  const handleClearSession = useCallback(() => {
    if (clearArmed) {
      setClearArmed(false)
      if (clearArmTimerRef.current !== null) {
        clearTimeout(clearArmTimerRef.current)
        clearArmTimerRef.current = null
      }
      onClear?.()
    } else {
      setClearArmed(true)
      clearArmTimerRef.current = window.setTimeout(() => setClearArmed(false), 3500)
    }
  }, [clearArmed, onClear])

  const onMediaAutoPlayedStable = useCallback(
    (id: string) => onMediaAutoPlayed?.(id),
    [onMediaAutoPlayed],
  )
  // 撤销回调稳定引用(2026-08-14 停止与撤销分离):同 onMediaAutoPlayed,
  // 内联箭头会打穿 UserBubble 的 memo
  const onUndoStable = useCallback(
    (id: string) => onUndo?.(id),
    [onUndo],
  )
  // 单条消息渲染:useCallback 稳定引用——全量渲染下消息组件靠 memo
  // 跳过未变化消息;mediaAutoPlayIds 变化(新消息落定)才重建(此时
  // 消息数据本就该刷新)
  const renderMessage = useCallback(
    (m: AgentMessage) =>
      m.role === 'user' ? (
        <UserBubble key={m.id} m={m} onUndo={onUndoStable} />
      ) : m.role === 'system' ? (
        // 系统消息(2026-08-14 软停止):停止说明等,居中一行小字弱化
        <div key={m.id} className="island-agent-msg-system">
          {textFromParts(m.parts)}
        </div>
      ) : (
        <AssistantBlock
          key={m.id}
          id={m.id}
          parts={m.parts}
          usage={m.usage}
          sentToPeer={m.sentToPeer}
          sentToMaster={m.sentToMaster}
          interrupted={m.interrupted}
          mediaAutoPlay={mediaAutoPlayIds?.has(m.id) ?? false}
          onMediaAutoPlayed={onMediaAutoPlayedStable}
        />
      ),
    [mediaAutoPlayIds, onMediaAutoPlayedStable, onUndoStable],
  )
  // 对话最后媒体快照(2026-08-09):从消息**数据**取最后一条含媒体的
  // 消息的最后一个媒体——数据顺序 = 消息顺序,不受消息列表分批挂载
  // (visibleCount)/重挂载影响(原挂载事件上报在大量历史消息时最后上报
  // 的是中间批次的旧媒体,实测音频移交错取旧文件);收起面板时
  // DynamicIsland 据此变形成媒体小窗/移交音频。
  // **markdown 内嵌媒体也算(2026-08-10 用户实测"最新消息为图片,收起
  // 却不出图片岛"根因之一)**:LLM 常用回复内嵌 ![图](路径) 而非 media
  // part——media part 与文本里的 markdown 媒体链接都算,取最后出现的
  // (同一消息内 media part 优先于其后的 markdown 文本?不——按 parts
  // 顺序逐条取最后媒体,与渲染顺序一致)
  const lastMedia = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const parts = messages[i].parts
      if (!Array.isArray(parts)) continue
      for (let j = parts.length - 1; j >= 0; j--) {
        const p = parts[j]
        if (p.type === 'media') {
          return { kind: p.kind, src: p.url, name: p.name }
        }
        if (p.type === 'text') {
          // 文本里的 markdown 媒体链接:从后往前找第一个
          // ![名字](路径)(与 Markdown 组件渲染分派同款正则)
          const mdMedia = findLastMdMedia(p.text)
          if (mdMedia) return mdMedia
        }
      }
    }
    return null
  }, [messages])
  useEffect(() => {
    onMediaSnapshot?.(lastMedia)
  }, [lastMedia, onMediaSnapshot])
  // 输入草稿(2026-08-10 用户要求"切换窗口面板不丢失已输入文本"):
  // localStorage 持久化——收起面板/切多媒体库/切设置/切音乐模式
  // (AgentView 卸载)后重挂载恢复;发送成功后清除(已消费)。
  // 两个宿主(挂件/Web 演示)共用同一键,键名以 widget- 前缀与既有
  // 设置键一致
  const [input, setInput] = useState(() => {
    try {
      return localStorage.getItem(AGENT_DRAFT_KEY) ?? ''
    } catch {
      return ''
    }
  })
  useEffect(() => {
    try {
      if (input) localStorage.setItem(AGENT_DRAFT_KEY, input)
      else localStorage.removeItem(AGENT_DRAFT_KEY)
    } catch {
      // 存储失败忽略(隐私模式等)
    }
  }, [input])
  // 拖拽上传附件(2026-08-17 用户要求"本地拖拽文件到对话窗口,快捷上传
  // 并做成标签 UI"):拖入的文件生成标签(输入区上方),随文字发送一起
  // 交给 LLM(媒体作 media part 展示,全部附件路径标注让 LLM 读取)。
  // 标签 = 待发送附件,可单独移除;发送成功后清空。
  // dragActive(2026-08-17):拖拽经过消息区时显示"松开上传"高亮蒙版
  const [attachments, setAttachments] = useState<DropAttachment[]>([])
  const [dragActive, setDragActive] = useState(false)
  // 附件行展开动画(2026-08-17 用户要求"拖入后整体位移布局的更改动画,
  // 当前没有,非常生硬"):attachments 从空 → 非空先渲染折叠态,下一帧
  // 再展开(grid-template-rows 0fr → 1fr 平滑长高)——输入区高度渐进
  // 增长,消息列表/输入框随 flex 布局渐进压缩,不再瞬间跳变。
  // 移除到空时回落折叠态;添加第二个附件不重开(保持展开)
  const [attachOpen, setAttachOpen] = useState(false)
  useEffect(() => {
    if (attachments.length === 0) {
      setAttachOpen(false)
      return
    }
    const raf = requestAnimationFrame(() => setAttachOpen(true))
    return () => cancelAnimationFrame(raf)
  }, [attachments.length])
  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index))
  }, [])
  // dragActive 经 ref 访问(拖拽事件高频触发,避免重复 setState 触发渲染)
  const dragActiveRef = useRef(dragActive)
  dragActiveRef.current = dragActive
  // 拖拽事件(绑定消息列表容器;preventDefault 是放行的前提,不阻止会
  // 被浏览器默认行为接管——打开文件/导航离开)。拖入文件夹时
  // dataTransfer.files 为空(需 webkitGetAsEntry 递归),暂不处理
  const handleDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    setDragActive(false)
    const files = Array.from(event.dataTransfer?.files ?? [])
    if (files.length === 0) return
    const items = files.map((f) => {
      // 绝对路径经 preload webUtils 解析(仅拖拽/粘贴来源);Web 演示
      // 无 desktop → 降级用文件名作 path(仅展示,无真实读取)
      const path = window.desktop?.getPathForFile?.(f) || f.name
      return { path, name: f.name, size: f.size, kind: (mediaKindOf(path) ?? 'file') as DropAttachment['kind'] }
    })
    setAttachments((prev) => [...prev, ...items])
  }, [])
  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (!dragActiveRef.current) setDragActive(true)
  }, [])
  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    // 子元素间拖移会冒泡 dragleave,用 relatedTarget 判断是否真的离开
    // 容器(relatedTarget 在容器外才收起高亮)
    const rt = event.relatedTarget as Node | null
    if (!(event.currentTarget as Node).contains(rt)) setDragActive(false)
  }, [])
  // / 与 @ 手动调用的候选列表(输入前缀时列出技能/MCP 工具)
  const [suggestions, setSuggestions] = useState<AgentToolInfo[]>([])
  const [suggestionIndex, setSuggestionIndex] = useState(0)
  // 收起动画中(closing = 卡片逐个折叠退场,全部退完才卸载列表)
  const [suggestClosing, setSuggestClosing] = useState(false)
  const suggestCloseTimerRef = useRef(0)
  // suggestions 经 ref 访问:closeSuggestions 必须**引用稳定**(useCallback
  // 空依赖)——输入 effect 依赖它,若随 suggestions.length 变化,收起
  // 卸载(setSuggestions([]))后引用变化会触发 effect 重跑、候选重新展开
  // (实测 bug:Esc 后候选又弹回来)
  const suggestionsRef = useRef(suggestions)
  suggestionsRef.current = suggestions
  // 收起:卡片倒序 stagger 退场(总时长 = 容器收缩 0.24s + 卡片数 × 间隔),
  // 完成后真正卸载;重复触发只重置计时(打字/多次 Esc 安全)。
  // 与收起动画时长匹配(CSS 容器 0.24s / 卡片 0.2s)——提前卸载会截断动画
  const closeSuggestions = useCallback(() => {
    const n = suggestionsRef.current.length
    if (n === 0) return
    setSuggestClosing(true)
    window.clearTimeout(suggestCloseTimerRef.current)
    suggestCloseTimerRef.current = window.setTimeout(
      () => {
        setSuggestions([])
        setSuggestClosing(false)
      },
      240 + n * 30,
    )
  }, [])
  // 删除中的会话 id(离场动画中;播完才真正删除;useLeavingList 收敛
  // 定时器模式,审计 P2)
  const sessionsLeave = useLeavingList()
  // 工具列表视图:搜索词 / 禁用·恢复的离场与入场动画(leaving = 从当前
  // 区离场,entering = 移入另一区时回弹入场;离场定时器 useLeavingList
  // 自清,入场计时器统一收集清理)
  const [toolQuery, setToolQuery] = useState('')
  const toolsLeave = useLeavingList()
  const [enteringTools, setEnteringTools] = useState<string[]>([])
  const toolAnimTimersRef = useRef<number[]>([])
  // 面板子视图:聊天 / 对话历史 / 工具列表
  const [view, setView] = useState<AgentViewKind>('chat')
  // 视图切换过渡:先切主实例(新视图进场动画),旧视图副本盖在上层
  // 播放离场动画后卸载 —— 交叉过渡,无硬切;back = 返回 chat 方向
  const [leaving, setLeaving] = useState<{ view: AgentViewKind; back: boolean } | null>(null)
  // 展开首帧两阶段:消息多(>一批)时先渲染轻量骨架占位(形变动画期间
  // DOM 极小,展开顺),延迟后挂载真实消息内容;消息少(≤一批)时**直接
  // 渲染内容**——单次形变、测量一次到位,避免"先展开到下限再拉长"的
  // 二次跳变观感(2026-08-08 用户反馈"几条消息也卡",实测卡的主感是
  // 骨架期高度停在下限、content 切换后再形变一次)
  const [phase, setPhase] = useState<'skeleton' | 'content'>(() =>
    messages.length > BATCH_RENDER ? 'skeleton' : 'content',
  )
  useEffect(() => {
    if (phase !== 'skeleton') return
    const timer = window.setTimeout(() => setPhase('content'), AGENT_PHASE_IN_MS)
    return () => window.clearTimeout(timer)
  }, [phase])
  // 消息挂载(2026-08-12 虚拟滚动接管):MessageWindow 按可视区窗口化
  // 渲染,只挂载可视区 ± overscan 的消息,其余高度由 spacer 撑起——
  // 数百条消息的 DOM/绘制成本与可视区解耦,滚动到中间不再抽搐。
  // 原分批挂载(visibleCount 逐批 rAF 增长)与 content-visibility
  // 估算(--msg-h/阈值 200)已删除,见 MessageWindow.tsx 头部注释
  // 卸载时清理候选收起计时器(动画未完成即卸载不残留)
  useEffect(() => () => window.clearTimeout(suggestCloseTimerRef.current), [])
  // 输入框引用:LLM 回复完成后自动聚焦,直接可输入
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // 跳底锚点(2026-08-17 收敛):消息列表末尾 0 高哨兵,统一跳底用它对齐
  const bottomAnchorRef = useRef<HTMLDivElement>(null)
  // 贴底标志:用户滚动时置 false,切会话/新消息贴底时置 true
  const atBottomRef = useRef(true)
  // 2026-08-18 完全重写滚动逻辑:移除 settle 循环和 autoScrollRef 守卫。
  // 滚动 = 简单直接的 scrollTop = scrollHeight,无多帧校正、无守卫阻塞。
  // 会话切换使用 useLayoutEffect(同帧滚底,不咯噔、不残留滚动空间)。
  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current
    if (!el) return
    if (smooth && !window.desktop) {
      const a = bottomAnchorRef.current
      if (a) {
        const crect = el.getBoundingClientRect()
        const arect = a.getBoundingClientRect()
        const delta = arect.bottom - crect.bottom
        if (delta > 0.5) smoothScrollTo(el, el.scrollTop + delta, 650)
      }
      return
    }
    // 简单直接:一次 scrollTop 赋值,无 settle 循环、无守卫
    el.scrollTop = el.scrollHeight
  }, [])
  // 最简滚动方案(2026-08-18):每帧 useLayoutEffect 强制滚底,无依赖数组、
  // 无守卫、无条件。确保每次 DOM 更新后 scrollTop 都指向 scrollHeight,
  // 消除所有"先显示最新→突然跳回历史"的时序竞态。
  useLayoutEffect(() => {
    if (view !== 'chat' || phase !== 'content') return
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  })
  // 卸载时清理测量节流计时器
  useEffect(() => () => window.clearTimeout(measureTimerRef.current), [])
  const busy = status === 'thinking' || status === 'running'
  // 快捷菜单项(2026-08-07 重构:通用 QuickMenu 取代 ⋯ 弹出菜单):
  // 条件项随状态(停止生成仅运行中、新对话仅非空历史)。**默认选中
  // "新对话"**(用户要求);收起恒为末项(历史为空时的回退默认)。
  // **收起拆分(2026-08-10 用户要求)**:收起为灵动岛(紧凑态,不生成
  // 媒体岛)/ 收起为多媒体岛(视频/图片冻结媒体小窗,音频移交)
  const menuItems: Array<{ id: AgentMenuItemId; label: string; danger?: boolean }> = []
  if (busy) menuItems.push({ id: 'stop', label: '停止生成', danger: true })
  if (messages.length > 0) menuItems.push({ id: 'clear', label: '新对话' })
  menuItems.push(
    { id: 'history', label: '对话历史' },
    { id: 'tools', label: '工具列表' },
    { id: 'media-library', label: '多媒体库' },
    { id: 'settings', label: '设置' },
    { id: 'collapse', label: '收起为灵动岛' },
    { id: 'collapse-media', label: '收起为多媒体岛' },
  )
  // LLM 回复完成(运行中 → 空闲)自动聚焦输入框,直接可输入
  const wasBusyRef = useRef(busy)
  useEffect(() => {
    if (wasBusyRef.current && !busy && view === 'chat') {
      inputRef.current?.focus()
    }
    wasBusyRef.current = busy
  }, [busy, view])

  // 岛体高度自适应:目标高度 = 固定部分 + 消息列表内容自然高。
  // 内容自然高 = 子元素高度求和(含列表 gap):消息区 = 虚拟滚动窗口
  // (MessageWindow,高度恒等于虚拟总高——见其 spacer 数学) + 尾部
  // (流式/思考/错误);scrollHeight 在内容不足时 = 可视高(flex 拉伸
  // 的盒高,自收敛)——岛体高度只长不缩,上一轮对话拉伸后,新对话
  // 不会缩回初始小空间(实测 bug);子元素高度不受 flex 拉伸影响,
  // 始终反映真实内容。
  // clamp 到 [176, 700];超高时岛体封顶 700,列表滚动不自锁。
  // 流式回复中:**测量与上报一起按 80ms 节拍**(测量本身是强制 reflow——
  // offsetHeight 循环 + getComputedStyle,每帧跑 = reflow 频率≈帧率;
  // 节拍点排队期间跳过的调用不再测量,只保留最后一次)
  const measureTimerRef = useRef(0)
  const streamingRef = useRef(streaming)
  streamingRef.current = streaming
  const measureHeight = useCallback(() => {
    const doMeasure = (el: HTMLElement) => {
      let contentH = 0
      // 参与 gap 计数的可见子元素数(空 tail display:none 不占位,
      // 排除后与条件渲染的测量口径一致,见 .island-agent-tail:empty)
      let visibleCount = 0
      const children = el.children
      for (let i = 0; i < children.length; i++) {
        const child = children[i] as HTMLElement
        if (child.offsetHeight === 0 && getComputedStyle(child).display === 'none') continue
        visibleCount++
        contentH += child.offsetHeight
      }
      if (visibleCount > 1) {
        // 列表 gap 从运行时样式读取(聊天 10px / 历史、工具 8px,自动跟随)
        const gap = parseFloat(getComputedStyle(el).rowGap)
        if (Number.isFinite(gap) && gap > 0) contentH += (visibleCount - 1) * gap
      }
      // **会话面板高度需求(2026-08-13 三轮,用户要求"窗口大小足够展示
      // 相关信息,支持高度响应式伸缩")**:面板展开时,窗口需容纳面板
      // (面板垂直居中于岛体,超出部分 = 需要的额外窗口高度)
      let dockH = 0
      if (sessionOpenRef.current) {
        // 2026-08-18 优化:用目标高度(SESSION_DOCK_OPEN_H,与 CSS
        // .island-session-dock.open 的 height 一致)而非动画中的 offsetHeight
        // ——点击即按最终高度计算,窗口高度动画与 dock 动画并行一步到位,
        // 不再等 CSS 动画完成再量(380ms 滞后 + 中间值错位的根源);
        // 折叠时 dock(52px)比内容矮,无额外窗口高度需求
        dockH = Math.max(0, Math.min(SESSION_DOCK_OPEN_H, 480) - contentH)
      }
      // **会话上下文横幅高度(2026-08-13 用户实测"收起会话面板后单条
      // 消息底部被截断、响应式布局失效")**:查看外部会话时横幅在消息
      // 列表上方占一行(含 10px 视图 gap),AGENT_PANEL_FIXED_H(116)只
      // 标定 头+消息区+输入 无横幅的布局——预算不足把消息区挤矮,底部
      // 被裁、消息与输入框之间没有留空;会话面板展开时 dockH 余量恰好
      // 兜住,收起后暴露。横幅高度计入预算,消息区恢复完整高度
      let bannerH = 0
      if (bannerRef.current) bannerH = bannerRef.current.offsetHeight + 10
      const next = Math.min(
        AGENT_PANEL_MAX_H,
        // + AGENT_PANEL_HEIGHT_SLACK(2026-08-13 修复"切会话收起面板后
        // 单条消息底部被截断"):零余量预算在 offsetHeight 取整/行高小数
        // 下消息区比内容矮 1-2px,底缘被裁;加余量后消息区留出呼吸空间
        Math.max(AGENT_PANEL_MIN_H, AGENT_PANEL_FIXED_H + contentH + dockH + bannerH + AGENT_PANEL_HEIGHT_SLACK),
      )
      onHeightChange?.(next)
    }
    // 骨架期不测量(消息区未挂载,保持岛体下限;内容期才测量长高)
    if (phase !== 'content') return
    // 工具列表/对话历史视图同样参与测高(2026-08-14 用户实测"工具列表都
    // 打开半天它才伸长/收起后半天才缩短"):岛体随列表内容伸缩,超高封顶
    // AGENT_PANEL_MAX_H 后列表内部滚动。原设计保持进入前的聊天高度、窗口
    // 对工具列表零响应,观感即"不响应"
    const el = scrollRef.current
    if (!el) return
    if (streamingRef.current) {
      if (measureTimerRef.current) return // 已有节拍点排队,本帧跳过测量
      measureTimerRef.current = window.setTimeout(() => {
        measureTimerRef.current = 0
        // 视图切换等可能已卸载,离屏节点高度失真,跳过
        if (el.isConnected) doMeasure(el)
      }, 80)
      return
    }
    doMeasure(el)
  }, [onHeightChange, phase])

  // 工具列表/对话历史视图的子行高度变化 → 重测(2026-08-14):列表容器
  // 自身高度被 flex 固定,容器级 ResizeObserver 不随内容增高触发,需观察
  // **每个子元素**——覆盖工具清单异步加载、搜索过滤、禁用/恢复移行、
  // ToolsItem 参数卡展开/折叠(内部 state 不在 deps,行尺寸变化是唯一信号);
  // deps 里的数据源变化会重建观察(子元素增删),尺寸变化即时触发
  useLayoutEffect(() => {
    if (phase !== 'content') return
    if (view !== 'tools' && view !== 'history') return
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => measureHeight())
    for (let i = 0; i < el.children.length; i++) ro.observe(el.children[i])
    return () => ro.disconnect()
  }, [view, phase, measureHeight, tools, toolQuery, excludedTools, sessions])

  // 会话面板开合 → 重测高度(2026-08-18 优化:去掉 380ms 延迟——原等 CSS
  // 高度动画完成再测,窗口变化明显滞后"响应不及时";dockH 已按目标高度
  // 计算,点击即测,窗口高度动画立即与 dock 动画并行开始)
  useEffect(() => {
    measureHeight()
  }, [sessionOpen, currentSessionKey, measureHeight])
  // 视图切换(chat ↔ 对话历史/工具列表):立即换主实例(新视图进场
  // 动画),旧视图副本盖在上层播放离场动画,结束后卸载并重测高度
  // (窗口跟随新视图内容)。过渡中不响应再次切换(0.17s 极短)
  const viewRef = useRef(view)
  viewRef.current = view
  const leavingRef = useRef(leaving)
  leavingRef.current = leaving
  // 是否发生过视图切换:首次挂载(面板展开)chat 不加进场动画,
  // 避免与面板展开动画叠加
  const switchedRef = useRef(false)
  const switchTimerRef = useRef(0)
  const switchView = useCallback(
    (next: AgentViewKind) => {
      if (next === viewRef.current || leavingRef.current) return
      switchedRef.current = true
      setView(next)
      setLeaving({ view: viewRef.current, back: next === 'chat' })
      window.clearTimeout(switchTimerRef.current)
      switchTimerRef.current = window.setTimeout(() => {
        setLeaving(null)
        // 新视图列表已挂载:重测高度,窗口跟随新视图内容
        requestAnimationFrame(measureHeight)
      }, VIEW_LEAVE_MS)
    },
    [measureHeight],
  )
  // 卸载时清理切换定时器(面板收起等)
  useEffect(() => () => window.clearTimeout(switchTimerRef.current), [])

  // 删除会话:先播离场动画(高度折叠 + 淡出上移,0.24s)再真正删除——
  // 行高在点击瞬间固定为测量值(触发折叠过渡),负 margin 抵消列表
  // gap,行消失过程列表平滑上移,无跳变;多个行可同时离场(各自定时)
  const handleDeleteSession = (event: MouseEvent<HTMLButtonElement>, id: string) => {
    event.stopPropagation()
    const row = event.currentTarget.closest('.island-agent-history-item') as HTMLElement | null
    row?.style.setProperty('height', `${row.offsetHeight}px`)
    sessionsLeave.beginLeave(id, () => onDeleteSession(id))
  }
  // 卸载时清理未完成动画定时器(useLeavingList 已自清,这里只剩工具区)
  useEffect(
    () => () => {
      toolAnimTimersRef.current.forEach((t) => window.clearTimeout(t))
    },
    [],
  )

  // 工具禁用 / 恢复:先播离场动画(0.24s)再提交配置,行移入另一区时
  // 带入场动画(0.34s 回弹);动画期间禁止重复操作(动画未完成即卸载
  // 不残留,计时器统一收集)
  // useCallback(2026-08-11:传给 ToolsItem 的 onDisable 需稳定引用,
  // 否则 AgentView 每次渲染把 ToolsItem 的 memo 打穿)
  const toggleToolDisabled = useCallback(
    (name: string, disable: boolean) => {
      const current = excludedTools ?? []
      // 仅离场中拦截:入场动画期间允许再次操作(行还在原区,离场动画
      // 会覆盖入场动画,无冲突)
      if (toolsLeave.leavingIds.includes(name)) return
      const next = disable
        ? [...new Set([...current, name])]
        : current.filter((n) => n !== name)
      if (next.length === current.length) return
      toolsLeave.beginLeave(name, () => {
        onExcludedToolsChange?.(next)
        // 行移入目标区(禁用区 / 可用区):回弹入场动画
        setEnteringTools((prev) => [...prev, name])
        toolAnimTimersRef.current.push(
          window.setTimeout(() => {
            setEnteringTools((prev) => prev.filter((n) => n !== name))
          }, 460),
        )
      })
    },
    [excludedTools, toolsLeave, onExcludedToolsChange],
  )
  // 禁用点击包装(2026-08-11:稳定引用——内联箭头会把 ToolsItem 的
  // memo 打穿)
  const disableTool = useCallback(
    (name: string) => toggleToolDisabled(name, true),
    [toggleToolDisabled],
  )

  // ===== 右上角快捷菜单(2026-08-07 重构:通用 QuickMenu——整合按钮 +
  // 同行联通展开 + 滚轮逐格切换 + 高亮滑块,取代原 ⋯ 弹出菜单与
  // 悬浮快捷按钮) =====
  // **默认选中的类型是新对话**(用户要求);历史为空时无"新对话"项 → 回退末项。
  // 菜单项随 busy/messages 变化:索引经 ref 跨渲染同步,渲染时钳制有效范围
  const [quickIndex, setQuickIndex] = useState(() => {
    const i = menuItems.findIndex((m) => m.id === 'clear')
    return i >= 0 ? i : menuItems.length - 1
  })
  const quickIndexRef = useRef(quickIndex)
  quickIndexRef.current = quickIndex
  const quickItem = menuItems[Math.min(quickIndex, menuItems.length - 1)]

  // 执行菜单项动作(⋯ 快捷菜单共用)
  const runItem = useCallback(
    (id: AgentMenuItemId) => {
      switch (id) {
        case 'stop':
          onAbort()
          break
        case 'clear':
          onClear()
          break
        case 'history':
          switchView('history')
          break
        case 'tools':
          switchView('tools')
          break
        case 'settings':
          onOpenSettings?.()
          break
        case 'media-library':
          onOpenMediaLibrary?.()
          break
        case 'collapse':
          // 收起为灵动岛(紧凑态,不生成媒体岛)
          onCollapseMini()
          break
        case 'collapse-media':
          // 收起为多媒体岛(媒体小窗/音频移交)
          onCollapse()
          break
      }
    },
    [onAbort, onClear, onCollapse, onCollapseMini, onOpenSettings, onOpenMediaLibrary, switchView],
  )

  // 菜单项内容(图标 + 标签):QuickMenu 的按钮 WheelSwap 与菜单项共用
  const quickItemNode = (item: { id: AgentMenuItemId; label: string; danger?: boolean }) => (
    <>
      {QUICK_MENU_ICONS[item.id]}
      <span className={`island-agent-quick-label${item.danger ? ' danger' : ''}`}>{item.label}</span>
    </>
  )
  // 执行后复位默认(新对话;新对话后历史为空 → clear 项消失,回退末项)
  const resetQuickToDefault = () => {
    const i = menuItems.findIndex((m) => m.id === 'clear')
    quickIndexRef.current = i >= 0 ? i : menuItems.length - 1
    setQuickIndex(quickIndexRef.current)
  }

  // 内容变化(消息/流式/状态)时重测(rAF 延迟一帧:面板首帧挂载不阻塞
  // 展开动画布局,测量结果下一帧生效,展开更顺)。**view 入 deps**(2026-08-14):
  // 视图切换当帧即重测(~16ms),不等旧视图离场 200ms 后的定时器
  useLayoutEffect(() => {
    const raf = requestAnimationFrame(measureHeight)
    return () => cancelAnimationFrame(raf)
  }, [measureHeight, view, messages, streaming, status, lastError, phase])

  // 消息内容高度变化 → 重测岛体 + 贴底跟随(2026-08-17 弃虚拟滚动后恢复
  // 容器级 RO):工具卡片展开/媒体加载/文本重排使单条消息高度变化,消息
  // 窗口容器高度(= 全部消息高 + gap)随之变化 → 岛体高度跟随(原
  // MessageWindow 的 onLayoutChange 通道);同时若用户贴底,跳底跟随
  // 内容增长——流式增量/媒体加载期间"持续贴底"的可靠来源,替代原
  // "消息变化 effect + 双 rAF + 150ms 定时器"反复覆盖绝对 scrollTop
  // 造成的抖动(2026-08-17 用户实测)。**观察范围扩大到整个消息区
  // (2026-08-17 修复"发送消息偶现跳到历史中部")**:原只观察消息窗口,
  // 流式尾部(tail)的增高无 RO 覆盖、仅靠 streaming 引用变化的 effect
  // 跟随(时序上偶有漏跳底)——改为观察消息区所有直接子元素,任何内容
  // 增高都触发贴底跟随;scrollToBottom 内部的持续校正循环再兜底到稳定
  useLayoutEffect(() => {
    if (phase !== 'content') return
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      measureHeight()
      if (atBottomRef.current && viewRef.current === 'chat') scrollToBottom()
    })
    for (let i = 0; i < el.children.length; i++) ro.observe(el.children[i])
    return () => ro.disconnect()
    // view 入 deps(2026-08-19):三视图共用滚动容器,切换时 children 被整批
    // 替换——原 deps 不含 view,切回 chat 后 RO 观察的还是挂载时的旧节点
    // 引用(已卸载,静默失效),工具卡片展开等高度变化无人测量
  }, [phase, measureHeight, scrollToBottom, currentSessionKey, view])

  // 卸载时清理测量节流计时器
  useEffect(() => () => window.clearTimeout(measureTimerRef.current), [])

  // 消息/流式变化时自动滚到底(用户上翻查看历史时不打扰)。
  // 2026-08-17 收敛:统一走 scrollToBottom 锚点对齐精确落底(替代原
  // jumpToBottom 双 rAF + 150ms 定时器);内容高度持续增长(流式增量/
  // 媒体异步加载)由上方 ResizeObserver 跟随,这里覆盖 messages/
  // streaming 引用变化的主路径(新消息落定 / 流式起止)
  useEffect(() => {
    if (atBottomRef.current && view === 'chat' && phase === 'content') {
      scrollToBottom()
    }
  }, [messages, streaming, status, lastError, view, phase, scrollToBottom])

  // 会话切换强制贴底已合并进上方统一滚底 effect(2026-08-17 收敛,
  // 见 scrollRef 处注释——避免两处独立 effect 触发路径不一致)

  // 聊天/历史/工具视图共用滚动处理(2026-08-17 弃虚拟滚动后,chat 视图
  // 滚动容器也挂 onScroll):按距底 48px 更新贴底标志(供新消息跳底判定)。
  // **原生监听兜底(2026-08-17 修复"桌面端无法滚动")**:useCallback 稳定
  // 引用,既绑定 React onScroll,又经下方 effect 加原生 scroll 监听——
  // 保证用户滚动(滚轮/拖滚动条)时 atBottomRef 一定置 false,后续
  // effect 才不把滚动拉回底部(否则表现为"滚动条无法滚动/一滚就弹回")
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }, [])
  // atBottomRef 可靠更新:chat 内容态给滚动容器加原生 scroll 监听
  // (React onScroll 合成事件在个别环境不触发,兜底确保贴底标志准确)
  useEffect(() => {
    if (phase !== 'content' || view !== 'chat') return
    const el = scrollRef.current
    if (!el) return
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [phase, view, handleScroll])

  // 进入对话面板(chat 视图内容挂载后)自动滚动到最近信息:
  // 恢复历史/展开面板时用户期望看到最新消息,而不是停留在旧位置。
  // 自绘非线性滚动(先加速再减速 + 平滑停止;距离大时动画稍长)。
  // 高斯模糊只用于长消息列表滚动的性能优化——**新对话没有过去的
  // 消息时不模糊**(紧凑态进入新对话的滚动动画干净无模糊)。
  // messages 长度经 ref 读取:不入依赖(消息到达时发送路径已平滑滚动,
  // 这里只在视图/骨架切换时滚动一次)
  // 全量渲染(2026-08-17):scrollHeight 为真实值,滚动即准确到底
  useEffect(() => {
    if (view !== 'chat' || phase !== 'content') return
    const el = scrollRef.current
    if (el) {
      atBottomRef.current = true
      // 串行展开(2026-08-08 用户要求:先宽 → 后高 → 伴随滚动):
      // 进入面板的滚动延迟到高度动画开始时(AGENT_WIDTH_ANIMATE_MS,
      // 与 useAgentPanelLayout 的 agentHReady 同拍,2026-08-09 由
      // MORPH_ANIMATE_MS 400ms 同步——原滚动比高度动画晚 100ms,
      // 展开收尾滞涩)——宽度动画期间岛体还是 56 高宽条,滚动无意义
      // 且浪费;高度展开时伴随滚动到底(统一 scrollToBottom 锚点对齐,
      // 2026-08-17:Web 演示保留平滑滚动,桌面挂件瞬时跳底)
      const t = window.setTimeout(() => {
        scrollToBottom()
      }, AGENT_WIDTH_ANIMATE_MS)
      return () => window.clearTimeout(t)
    }
  }, [view, phase, scrollToBottom])

  const submit = () => {
    const text = input.trim()
    // 2026-08-17 拖拽上传:纯附件(无文字)也可发送;空文字且无附件才拦截
    if ((!text && attachments.length === 0) || busy) return
    // 附件拆分(2026-08-17):媒体附件 → media(对话窗口展示 + LLM 侧标注);
    // 全部附件路径 → paths(文本标注让 LLM 用 read_file/命令读取分析)
    const media = attachments.filter((a) => a.kind !== 'file').map((a) => a.path)
    const paths = attachments.map((a) => a.path)
    onSend(text, { media, paths })
    setAttachments([])
    setInput('')
    // 已发送 = 草稿已消费,清除持久化(防重挂载后旧草稿复活)
    try {
      localStorage.removeItem(AGENT_DRAFT_KEY)
    } catch {
      // 忽略
    }
    // 发送后自绘非线性滚动到底(输入框高度可能变化;先加速再减速,
    // 平滑停止)。**不模糊**:对话中跳转最新消息的消息列表往往很短,
    // 模糊只服务于长列表滚动动画的性能优化,这里不需要(实测对话中
    // 每次发送都会触发模糊,观感不佳)。2026-08-17 统一走 scrollToBottom
    // 锚点对齐(桌面挂件瞬时落底,Web 演示平滑滚动)
    requestAnimationFrame(() => {
      atBottomRef.current = true
      scrollToBottom()
    })
  }

  // 输入以 / 或 @ 开头时,计算候选(技能 / MCP 工具;按输入 token 过滤)
  useEffect(() => {
    const prefix = input[0]
    if (prefix !== '/' && prefix !== '@') {
      // 非前缀输入:收起动画(卡片逐个折叠退场)
      closeSuggestions()
      return
    }
    const token = input.slice(1).split(/\s+/)[0].toLowerCase()
    // 外部工具前缀:技能 skill_<slug>;MCP 工具 mcp_<服务>_<工具>——
    // **显式排除内置工具 mcp_config**(2026-08-10:原"名称里存在第二个
    // 下划线"区分约定过脆,任何命名变化都会让 MCP 工具混不进/混进
    // 候选;显式排除 + mcp_ 前缀 = 全部外部 MCP 工具稳定显示)
    const all = tools.filter((t) =>
      prefix === '/'
        ? t.name.startsWith('skill_')
        : t.name.startsWith('mcp_') && t.name !== 'mcp_config',
    )
    // 全量匹配(不截断上限——用户技能不可能只有 6 个,实测被 slice 截断;
    // 超高由 max-height + overflow 滚动兜底,列表随岛体高度显示)
    const matched = token ? all.filter((t) => t.name.toLowerCase().includes(token)) : all
    // 重新展开:取消收起动画,列表逐卡展开
    window.clearTimeout(suggestCloseTimerRef.current)
    setSuggestClosing(false)
    setSuggestions(matched)
    setSuggestionIndex(0)
    // closeSuggestions 引用稳定(useCallback 空依赖),入依赖不触发重跑
  }, [input, tools, closeSuggestions])

  // 应用候选:替换开头的 /xxx 或 @xxx,保留后续文本(收起动画)
  const applySuggestion = (name: string) => {
    const prefix = input[0]
    const rest = input.replace(/^[/@]\S*/, '').trim()
    setInput(prefix + name + (rest ? ' ' + rest : ''))
    closeSuggestions()
    inputRef.current?.focus()
  }

  const handleInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 候选列表打开时:↑↓ 导航 / Esc 关闭 / Enter 选中(不发送)
    if (suggestions.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSuggestionIndex((i) => (i + 1) % suggestions.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSuggestionIndex((i) => (i - 1 + suggestions.length) % suggestions.length)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        closeSuggestions()
        return
      }
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault()
        const name = suggestions[suggestionIndex]?.name
        if (name) applySuggestion(name)
        return
      }
    }
    // Enter 发送;Shift+Enter 换行;IME 组字中 Enter 不上屏发送
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  const statusText =
    status === 'thinking'
      ? '思考中…'
      : status === 'running'
        ? '执行工具中…'
        : status === 'error'
          ? '出错了'
          : messages.length > 0
            ? '已就绪'
            : '待命'

  /**
   * 面板子视图内容(chat / 对话历史 / 工具列表)。
   * listRef:主实例传滚动容器 ref(高度测量);离场副本传 undefined
   * —— 副本只是视觉残留,不能抢占 ref(副本卸载时 React 会把 ref
   * 置 null,主实例的滚动绑定会丢失)
   */
  const renderBody = (
    which: AgentViewKind,
    listRef?: RefObject<HTMLDivElement | null>,
  ): ReactNode => {
    if (which === 'history') {
      /* 历史视图:返回对话 + 会话列表(点击加载 = 替换当前对话) */
      return (
        <div className="island-agent-history">
          <div className="island-agent-history-head">
            <button
              type="button"
              className="island-agent-history-back"
              onClick={(event) => {
                event.stopPropagation()
                switchView('chat')
              }}
            >
              <svg
                className="island-ctl-svg"
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="15 18 9 12 15 6" />
              </svg>
              <span>返回对话</span>
            </button>
            <span className="island-agent-history-title">对话历史</span>
          </div>
          <div className="island-agent-history-list" ref={listRef} onScroll={handleScroll}>
            {sessions.length === 0 && (
              <div className="island-agent-welcome">暂无历史对话,新对话会自动存档</div>
            )}
            {sessions.map((s) => (
              <div
                key={s.id}
                className={`island-agent-history-item${sessionsLeave.leavingIds.includes(s.id) ? ' leaving' : ''}`}
              >
                <button
                  type="button"
                  className="island-agent-history-open"
                  onClick={(event) => {
                    event.stopPropagation()
                    onLoadSession(s.id)
                    switchView('chat')
                  }}
                >
                  <span className="island-agent-history-name">{s.title}</span>
                  <span className="island-agent-history-time">{formatSessionTime(s.updatedAt)}</span>
                </button>
                <button
                  type="button"
                  className="island-agent-history-del"
                  title="删除会话"
                  onClick={(event) => handleDeleteSession(event, s.id)}
                >
                  <svg
                    className="island-ctl-svg"
                    width="12"
                    height="12"
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
              </div>
            ))}
          </div>
        </div>
      )
    }
    if (which === 'tools') {
      /* 工具列表视图:搜索 + 名称 / 描述 / 参数 schema(可展开) +
         禁用工具(禁用区)与恢复 */
      const q = toolQuery.trim().toLowerCase()
      const excludedSet = new Set(excludedTools ?? [])
      const matches = (name: string, desc: string) =>
        !q || name.toLowerCase().includes(q) || desc.toLowerCase().includes(q)
      const activeTools = tools.filter(
        (t) => !excludedSet.has(t.name) && matches(t.name, t.description),
      )
      // 禁用区行:名称 + 查表描述(工具已不在清单时只有名称)
      const disabledRows = (excludedTools ?? [])
        .filter((name) => {
          if (!q) return true
          const info = tools.find((t) => t.name === name)
          return (
            name.toLowerCase().includes(q) ||
            (info?.description.toLowerCase().includes(q) ?? false)
          )
        })
        .map((name) => ({ name, info: tools.find((t) => t.name === name) }))
      // 离场 / 入场动画类(禁用点击与恢复点击共用:先离场再移区入场)
      const rowAnimClass = (name: string) =>
        `${toolsLeave.leavingIds.includes(name) ? ' island-ui-leave' : ''}${
          enteringTools.includes(name) ? ' island-ui-enter' : ''
        }`
      return (
        <div className="island-agent-history">
          <div className="island-agent-history-head">
            <button
              type="button"
              className="island-agent-history-back"
              onClick={(event) => {
                event.stopPropagation()
                switchView('chat')
              }}
            >
              <svg
                className="island-ctl-svg"
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="15 18 9 12 15 6" />
              </svg>
              <span>返回对话</span>
            </button>
            <span className="island-agent-history-title">工具列表</span>
          </div>
          <div className="island-agent-history-list" ref={listRef} onScroll={handleScroll}>
            {/* 搜索框:按名称 / 说明过滤可用区与禁用区 */}
            <div className="island-tools-search">
              <svg
                className="island-ctl-svg"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.3-4.3" />
              </svg>
              <input
                type="text"
                value={toolQuery}
                placeholder="搜索工具名称或说明…"
                spellCheck={false}
                onChange={(event) => setToolQuery(event.target.value)}
              />
              {toolQuery && (
                <button
                  type="button"
                  className="island-tools-search-clear"
                  title="清空搜索"
                  onClick={(event) => {
                    event.stopPropagation()
                    setToolQuery('')
                  }}
                >
                  ✕
                </button>
              )}
            </div>
            {tools.length === 0 && <div className="island-agent-welcome">工具清单加载中…</div>}
            {tools.length > 0 && activeTools.length === 0 && disabledRows.length === 0 && (
              <div className="island-agent-welcome">没有匹配的工具</div>
            )}
            {activeTools.map((t) => (
              <ToolsItem
                key={t.name}
                tool={t}
                animClass={rowAnimClass(t.name)}
                onDisable={disableTool}
              />
            ))}
            {/* 禁用区:被禁用的工具集中展示,可恢复(动画与禁用同款) */}
            {disabledRows.length > 0 && (
              <div className="island-tools-excluded">
                <div className="island-tools-excluded-head">
                  <span>已禁用({disabledRows.length})</span>
                  <span className="island-tools-excluded-hint">禁用后对话中不再可用</span>
                </div>
                {disabledRows.map((row) => (
                  <div key={row.name} className={`island-tools-excluded-row${rowAnimClass(row.name)}`}>
                    <span className="island-tools-excluded-name">{row.name}</span>
                    {row.info && (
                      <span className="island-tools-excluded-desc">{row.info.description}</span>
                    )}
                    <button
                      type="button"
                      className="island-tools-restore"
                      title="恢复此工具"
                      onClick={(event) => {
                        event.stopPropagation()
                        toggleToolDisabled(row.name, false)
                      }}
                    >
                      恢复
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )
    }
    /* 聊天视图:头部(状态 + 下拉菜单)+ 消息列表(骨架两阶段)+ 输入区 */
    return (
      <>
        {/* 会话隔离折叠面板(2026-08-13 二轮,用户澄清):按钮与面板
            **一体式胶囊**(同一容器同一描边,展开时面板从按钮向左
            联通伸出,非独立浮层);面板叠在主对话窗口上——**不替换
            主对话**,选中某会话后面板内小窗展示该会话 */}
        {(
          <div ref={dockRef} className={`island-session-dock${sessionOpen ? ' open' : ''}`}>
            {/* 会话按钮:矩形左缘突起(一体式) */}
            <button
              type="button"
              className="island-session-fold"
              title="会话切换"
              aria-expanded={sessionOpen}
              onClick={() => setSessionOpen((o) => !o)}
            >
              <span className="island-session-fold-label">会话</span>
              {(sessionList ?? []).some((it) => (unreadCounts?.[it.key] ?? 0) > 0) && (
                <span className="island-session-fold-dot" aria-hidden="true" />
              )}
            </button>
            {/* 面板:纯会话切换器(2026-08-13 七轮)——悬停即把主对话
                窗口切到对应上下文;主对话入口一键切回(快照保留) */}
            <div className="island-session-panel">
              <div className="island-session-left">
                <div className="island-session-title">会话切换</div>
                <button
                  type="button"
                  className={`island-session-item${currentSessionKey !== 'main' ? '' : ' on'}`}
                  onClick={() => onSwitchSession?.('main')}
                >
                  <span className="island-session-name">
                    <span className="island-session-name-title">主对话(主人)</span>
                    <span className="island-session-name-caption">切换回主人对话(快照恢复)</span>
                  </span>
                </button>
                {(sessionList ?? []).length === 0 && (
                  <div className="island-session-chat-empty">暂无外部会话(收到/发出 QQ 消息后自动创建)</div>
                )}
                {(sessionList ?? []).map((it) => (
                  <button
                    key={it.key}
                    type="button"
                    className={`island-session-item${currentSessionKey === it.key ? ' on' : ''}`}
                    onClick={() => onSwitchSession?.(it.key)}
                  >
                    <span className="island-session-name">
                      <span className="island-session-name-title">{it.title}</span>
                      <span className="island-session-name-caption">{it.caption || (it.kind === 'group' ? '群聊' : '私聊')}</span>
                    </span>
                    {(unreadCounts?.[it.key] ?? 0) > 0 && (
                      <span className="island-session-unread">{unreadCounts![it.key]}</span>
                    )}
                    {/* 删除外部会话(2026-08-18 会话删除):单击即删(主对话
                        'main' 不在列表,天然不可删) */}
                    {onDeleteExternalSession && (
                      <span
                        role="button"
                        aria-label="删除该会话(聊天记录一并清除)"
                        className="island-session-del"
                        title="删除该会话(聊天记录一并清除)"
                        onClick={(event) => handleDeleteExternalSession(event, it.key)}
                      >
                        <svg className="island-ctl-svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                          <path d="M10 11v6M14 11v6" />
                        </svg>
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
        {/* 会话上下文横幅(2026-08-13 八轮):查看外部会话历史时,
            对话窗口上方显示会话名 + 会话操作(情况记录/快捷清空);
            高度计入岛体测量(见 measureHeight bannerH) */}
        {currentSessionKey && currentSessionKey !== 'main' && (
          <div ref={bannerRef} className="island-session-current">
            {sessionNoteEdit ? (
              <div className={`island-session-note-editor${noteClosing ? ' closing' : ''}`}>
                <textarea
                  className="island-session-note-input"
                  value={sessionNoteDraft}
                  placeholder="记录本会话情况(如:对方身份/最近聊什么/回复风格)——每轮回复都会参考;清空上下文不会清除记录"
                  onChange={(e) => setSessionNoteDraft(e.target.value)}
                  rows={2}
                />
                <div className="island-session-note-actions">
                  <button type="button" className="island-session-ctl" onClick={saveSessionNote}>
                    保存
                  </button>
                  <button type="button" className="island-session-ctl" onClick={cancelSessionNote}>
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <>
                <span key={currentSessionKey} className="island-session-current-title">
                  {(() => {
                    const it = (sessionList ?? []).find((x) => x.key === currentSessionKey)
                    const kind = it?.kind
                    return (
                      <>
                        {/* 会话类型徽标(2026-08-17 横幅美化):私聊 = 人形,
                            群聊 = 群组图标,一眼区分当前会话类型 */}
                        <span className={`island-session-current-badge${kind === 'group' ? ' group' : ''}`}>
                          {kind === 'group' ? (
                            <svg className="island-ctl-svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                              <circle cx="9" cy="8" r="3.5" />
                              <path d="M2.5 20c0-3 3-4.5 6.5-4.5s6.5 1.5 6.5 4.5" />
                              <circle cx="17" cy="9" r="2.5" />
                              <path d="M17 11.5c2.4 0 4.5 1.2 4.5 3.6" />
                            </svg>
                          ) : (
                            <svg className="island-ctl-svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                              <circle cx="12" cy="8" r="4" />
                              <path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
                            </svg>
                          )}
                        </span>
                        <span className="island-session-current-name">
                          {it ? it.title : currentSessionKey}
                        </span>
                      </>
                    )
                  })()}
                </span>
                <span key={currentSessionKey} className="island-session-current-actions">
                  <button
                    type="button"
                    className={`island-session-ctl${sessionNoteText ? ' has-note' : ''}`}
                    title={sessionNoteText ? `情况记录:${sessionNoteText.slice(0, 30)}${sessionNoteText.length > 30 ? '…' : ''}` : '写情况记录(该会话上下文备忘,每轮回复参考)'}
                    onClick={startEditNote}
                  >
                    {/* 记录:铅笔图标 + 文字;有记录时右侧加强调色小圆点徽标 */}
                    <svg className="island-ctl-svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 20h9" />
                      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
                    </svg>
                    <span>记录</span>
                    {sessionNoteText && <span className="island-session-ctl-dot" aria-hidden="true" />}
                  </button>
                  <button
                    type="button"
                    className={`island-session-ctl danger${clearArmed ? ' armed' : ''}`}
                    title="清空该会话上下文(消息历史,记录保留)"
                    onClick={handleClearSession}
                  >
                    {/* 清空:垃圾桶图标 + 文字;armed 时红底确认 */}
                    <svg className="island-ctl-svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                      <path d="M10 11v6M14 11v6" />
                      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                    </svg>
                    <span>{clearArmed ? '确认清空' : '清空'}</span>
                  </button>
                </span>
              </>
            )}
          </div>
        )}
        <div
          className="island-agent-head"
          onPointerDown={(event) => {
            if (event.button === 0) event.stopPropagation()
          }}
        >
          <span className="island-agent-title">
            <span className={`island-agent-dot${busy ? ' thinking' : ''}`} aria-hidden="true" />
            Agent
          </span>
          <span className="island-agent-status">{statusText}</span>
          {/* 右上角快捷菜单(2026-08-07 重构:通用 QuickMenu,默认"新对话";
              左侧展开,悬浮/滚轮/点击切换,单击菜单项执行;收起为灵动岛/
              收起为多媒体岛均为菜单项,2026-08-10 用户要求独立按钮移除) */}
          <QuickMenu
            items={menuItems}
            value={quickItem}
            onChange={(item) => {
              const i = menuItems.indexOf(item)
              if (i >= 0) {
                quickIndexRef.current = i
                setQuickIndex(i)
              }
            }}
            onSelect={(item) => {
              runItem(item.id)
              resetQuickToDefault()
            }}
            getLabel={quickItemNode}
            direction="left"
            title="滚轮切换,单击执行"
            wheelWhenOpen
            buttonAction="run"
          />
        </div>

        {/* 消息列表:展开首帧先渲染骨架占位(形变动画期间 DOM 轻量),
            延迟后挂载真实内容淡入并测量长高。
            2026-08-17 弃虚拟滚动:MessageWindow 虚拟滚动在会话切换/贴底
            时估算高度漂移、滚动条上下抖动且不落底(用户实测)——改回
            全量渲染,scrollHeight 始终为真实值,跳底 = scrollTop 直赋,
            简单可靠;消息组件(UserBubble/AssistantBlock)已 memo,追加
            时未变消息跳过重渲染。滚动容器挂 onScroll 更新贴底标志
            (chat 视图与历史/工具视图共用 handleScroll)。
            **拖拽上传(2026-08-17)**:同一容器绑定 dragover/drop,文件
            拖入对话窗口即生成附件标签(输入区上方);拖拽经过时显示
            "松开添加"高亮蒙版 */}
        {phase === 'skeleton' ? (
          <div className="island-agent-skeleton" aria-hidden="true">
            <div className="island-agent-skeleton-item assistant" />
            <div className="island-agent-skeleton-item user" />
            <div className="island-agent-skeleton-item assistant short" />
          </div>
        ) : (
          <div
            className={`island-agent-messages${dragActive ? ' drag' : ''}`}
            ref={listRef}
            onScroll={handleScroll}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            {dragActive && (
              <div className="island-agent-drop-mask">
                <span className="island-agent-drop-mask-title">松开以添加文件</span>
                <span className="island-agent-drop-mask-sub">将生成附件标签,随消息发送给 Agent</span>
              </div>
            )}
            {messages.length === 0 && !streaming && !lastError && (
              <div className="island-agent-welcome">
                我是岛灵,可以帮你执行本机操作。
                <br />
                试试:「打开计算器」「查一下最近的新闻」「列出下载目录」
              </div>
            )}
            <div className="island-msgs-window">
              {messages.map((m) => (
                <div key={m.id} className="island-msgs-item">
                  {renderMessage(m)}
                </div>
              ))}
            </div>
            {/* 尾部(流式/思考/错误):独立 flex 段,消息落定后并入列表。
                **恒渲染(2026-08-19 修复"工具静默期展开/收起工具列表窗口
                不伸缩")**:高度 RO 在 effect 挂载时快照观察子元素——tail
                原为条件渲染,流式开始才挂载,deps(phase/measureHeight/
                scrollToBottom/currentSessionKey)无变化 → RO 永不观察它;
                纯工具调用静默期(调用已显示、结果未回,无事件流)展开/
                收起 ToolSummary 无人测量。恒渲染 + :empty 隐藏让 tail 在
                RO 建立时即被观察,内部内容照旧条件渲染(空态 display:none
                不占 gap、不参与测量) */}
            <div className="island-agent-tail">
              {/* 流式中的助手回复:工具实时并入同一汇总列表(收纳态
                  只有一行,执行中脉冲/成功失败计数实时更新;展开可
                  看各卡状态,卡片 key 稳定 → open 状态跨事件保留) */}
              {streaming && (streaming.text || streaming.tools.length > 0) && (
                <div className={`island-agent-msg-assistant${hasTurnMark(streaming.text) ? ' qq-peer' : ''}`}>
                  {hasTurnMark(streaming.text) && <PeerTurnTag />}
                  {hasMasterTurnMark(streaming.text) && <MasterTurnTag />}
                  {streaming.text && (
                    <div className="island-agent-text">
                      {/* 流式前缀可能先到指纹标记(未凑齐时 strip 不命中,
                          凑齐即剥)——与落定消息同款剥离,气泡不露标记 */}
                      <Markdown text={stripTurnMarks(streaming.text)} caret />
                    </div>
                  )}
                  {streaming.tools.length > 0 && (
                    <ToolSummary
                      items={streaming.tools.map((tool) => ({
                        id: tool.id,
                        name: tool.name,
                        args: tool.args,
                        ok: tool.ok,
                        result: tool.result,
                        durationMs: tool.durationMs,
                      }))}
                    />
                  )}
                </div>
              )}
              {/* 思考中(无文本输出时) */}
              {status === 'thinking' && !streaming?.text && (
                <div className="island-agent-thinking">
                  <span className="island-agent-dot thinking" aria-hidden="true" />
                  正在思考
                  <span className="island-agent-dots" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </span>
                </div>
              )}
              {lastError && <div className="island-agent-error">{lastError}</div>}
            </div>
            {/* 跳底锚点(2026-08-17):列表末尾 0 高哨兵,统一跳底
                scrollToBottom 按实时布局对齐容器底边,精确落底 */}
            <div ref={bottomAnchorRef} className="island-msgs-anchor" aria-hidden="true" />
          </div>
        )}

        {/* 输入区(交互区:长按不触发收回) */}
        <div
          className="island-agent-input"
          onPointerDown={(event) => {
            if (event.button === 0) event.stopPropagation()
          }}
        >
          {pendingConfirm && (
            <div className="island-agent-confirm">
              {/* 确认卡通用化(2026-08-10):exec_command 确认带 command 显示
                  "允许执行命令?";bili 批量下载等动作确认带 title/detail
                  显示动作标题 + 详情 */}
              <span className="island-agent-confirm-title">
                {pendingConfirm.title ?? '允许执行命令?'}
              </span>
              {pendingConfirm.detail ? (
                <span className="island-agent-confirm-detail">{pendingConfirm.detail}</span>
              ) : (
                <code className="island-agent-confirm-cmd">{pendingConfirm.command}</code>
              )}
              <div className="island-agent-confirm-actions">
                <button
                  type="button"
                  className="island-agent-confirm-allow"
                  onClick={(event) => {
                    event.stopPropagation()
                    onConfirmTool(true)
                  }}
                >
                  允许
                </button>
                <button
                  type="button"
                  className="island-agent-confirm-deny"
                  onClick={(event) => {
                    event.stopPropagation()
                    onConfirmTool(false)
                  }}
                >
                  拒绝
                </button>
              </div>
            </div>
          )}
          {suggestions.length > 0 && (
            <div className={`island-agent-suggest${suggestClosing ? ' closing' : ''}`}>
              {suggestions.map((t, i) => (
                <button
                  key={t.name}
                  type="button"
                  // 展开:自输入框**从下而上**逐卡滑入(靠近输入框的最后一张
                  // 先出现,向上逐张展开——倒序 stagger);收起:同样从输入框
                  // 处开始逐卡折叠退场(倒序 stagger)
                  style={{ animationDelay: `${(suggestions.length - 1 - i) * 30}ms` }}
                  className={`island-agent-suggest-item${suggestClosing ? ' out' : ''}${
                    i === suggestionIndex && !suggestClosing ? ' on' : ''
                  }`}
                  // mousedown preventDefault 防 textarea 失焦;点击应用候选
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    event.stopPropagation()
                    applySuggestion(t.name)
                  }}
                >
                  <span className="island-agent-suggest-cmd">
                    {input[0]}
                    {t.name}
                  </span>
                  <span className="island-agent-suggest-desc">
                    {stripMcpServiceLabel(t.description).slice(0, 28)}
                  </span>
                </button>
              ))}
            </div>
          )}
          {/* 附件标签行(2026-08-17 拖拽上传):待发送附件标签(chip)——类型
              图标 + 文件名 + × 移除;悬停 title 显示完整路径。媒体附件
              (图片/音视频)图标带 media 强调色,发送时作 media part 展示,
              全部附件路径随消息标注交给 LLM 读取分析 */}
          {attachments.length > 0 && (
            <div className={`island-agent-attach-slot${attachOpen ? ' open' : ''}`}>
              <div className="island-agent-attach-inner">
                {attachments.map((a, i) => (
                  <span key={`${a.path}-${i}`} className={`island-agent-attach${a.kind !== 'file' ? ' media' : ''}`} title={a.path}>
                    <span className="island-agent-attach-icwrap">
                      <AttachIcon kind={a.kind} />
                    </span>
                    <span className="island-agent-attach-name">{a.name}</span>
                    <button
                      type="button"
                      className="island-agent-attach-remove"
                      aria-label={`移除附件 ${a.name}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        removeAttachment(i)
                      }}
                    >
                      <svg className="island-ctl-svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round">
                        <path d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  </span>
                ))}
                <span className="island-agent-attach-hint">将随消息发送给 Agent</span>
              </div>
            </div>
          )}
          <textarea
            ref={inputRef}
            value={input}
            placeholder="输入指令,Enter 发送…"
            rows={1}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleInputKeyDown}
            // 仅主实例自动聚焦(离场副本不抢焦点——挂载时 autoFocus
            // 会把输入焦点从用户处抢走,造成切换时的焦点跳动)
            autoFocus={listRef !== undefined}
          />
          {busy ? (
            <button
              type="button"
              className="island-agent-stop"
              onClick={(event) => {
                event.stopPropagation()
                onAbort()
              }}
            >
              停止
            </button>
          ) : (
            <button
              type="button"
              className="island-agent-send"
              disabled={!input.trim() && attachments.length === 0}
              onClick={(event) => {
                event.stopPropagation()
                submit()
              }}
            >
              <svg
                className="island-ctl-svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M22 2L11 13" />
                <path d="M22 2l-7 20-4-9-9-4 20-7z" />
              </svg>
            </button>
          )}
        </div>
      </>
    )
  }

  return (
    <div className="island-agent">
      {/* 收起交互:Agent 模式只保留长按收回 —— 消息区左键放行(长按空白/列表
          即可收回,拖动滚动/选择文本时位移超阈值自动取消长按);交互区
          (头部/输入区/工具卡片)拦截左键,长按不误触收回。
          右键全程放行(挂件层右键长按拖拽移动窗口) */}
      {view === 'chat' ? (
        <div
          key="chat"
          className={switchedRef.current ? 'island-agent-view enter-back' : 'island-agent-view'}
        >
          {renderBody('chat', scrollRef)}
        </div>
      ) : view === 'history' ? (
        <div key="history" className="island-agent-view enter-fwd">
          {renderBody('history', scrollRef)}
        </div>
      ) : (
        <div key="tools" className="island-agent-view enter-fwd">
          {renderBody('tools', scrollRef)}
        </div>
      )}
      {/* 离场副本:旧视图盖在上层淡出(不挂滚动 ref、不接收交互,
          结束后卸载) */}
      {leaving && (
        <div className={leaving.back ? 'island-agent-leave back' : 'island-agent-leave fwd'}>
          {renderBody(leaving.view, undefined)}
        </div>
      )}
    </div>
  )
}
