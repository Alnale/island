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
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  type WheelEvent,
} from 'react'
import type { AgentMessage, AgentPanelProps, AgentPart, AgentToolInfo } from '../../../agent/types'
import { useWheelSteps } from '../../../hooks/useWheelSteps'
import { WheelSwap } from './WheelSwap'
import { CopyButton, Markdown } from './Markdown'
import {
  AGENT_PANEL_FIXED_H,
  AGENT_PANEL_MAX_H,
  AGENT_PANEL_MIN_H,
  AGENT_PHASE_IN_MS,
} from '../layout'

/** 面板子视图:聊天 / 对话历史 / 工具列表 */
type AgentViewKind = 'chat' | 'history' | 'tools'

/** 头部下拉菜单项 id:⋯ 弹出菜单与快捷切换按钮共用 */
type AgentMenuItemId = 'stop' | 'clear' | 'history' | 'tools' | 'settings' | 'collapse'

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
}
/**
 * 视图切换离场副本卸载延时(ms):必须大于 CSS 离场动画时长(0.15s),
 * 留出余量保证动画播完(forwards 停在透明)才卸载——提前卸载会
 * 在动画中途突然消失,是切换闪烁的常见原因
 */
const VIEW_LEAVE_MS = 200

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
function smoothScrollTo(el: HTMLElement, target: number, durationMs = 800, blur = true) {
  const start = el.scrollTop
  const dist = target - start
  if (Math.abs(dist) < 1) return
  const duration = Math.min(1200, Math.max(500, durationMs))
  const startTime = performance.now()
  let cancelled = false
  let lastScroll = start
  let lastTime = startTime
  let peakVel = 0
  const cancel = () => {
    cancelled = true
    if (blur) el.style.filter = ''
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
    const pos = start + dist * easeInOutQuart(t)
    el.scrollTop = pos
    if (blur) {
      // 动态模糊:按速度占比二次衰减(速度降到峰值 25% 以下完全清除,
      // 提前消退让减速段清晰可见)
      const dt = Math.max(1, now - lastTime)
      const vel = Math.abs(pos - lastScroll) / dt
      if (vel > peakVel) peakVel = vel
      const ratio = peakVel > 0 ? vel / peakVel : 0
      el.style.filter = ratio > 0.25 ? `blur(${(3.5 * ratio * ratio).toFixed(2)}px)` : ''
    }
    lastScroll = pos
    lastTime = now
    if (t < 1) requestAnimationFrame(step)
    else el.style.filter = ''
  }
  requestAnimationFrame(step)
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

export interface AgentViewProps extends AgentPanelProps {
  /** 收起岛体(头部"收起"按钮) */
  onCollapse: () => void
  /**
   * 岛体高度自适应回调:内容变化时上报目标高度(px),
   * DynamicIsland 写入 --agent-h 驱动岛体高度
   */
  onHeightChange?: (height: number) => void
}

/** 用户消息气泡:右侧强调色,Markdown 文本(plainMermaid:用户贴的
 * mermaid 源码按普通代码块显示,图表深色主题进浅色气泡不可读) + 复制按钮 */
function UserBubble({ m }: { m: AgentMessage }) {
  const text = m.parts
    .filter((p): p is Extract<AgentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
  return (
    <div className="island-agent-msg-user">
      <div className="island-agent-msg-user-text">
        <Markdown text={text} plainMermaid />
      </div>
      <CopyButton text={text} />
    </div>
  )
}

/** 单个工具调用的数据(模块内卡片 / 流式卡片共用) */
interface ToolCallData {
  id: string
  name: string
  args: Record<string, unknown>
  ok?: boolean
  result?: string
  durationMs?: number
}

/** 工具卡片:头部(状态 + 名称 + 耗时)+ 可展开参数/结果(过程可知)。
    展开/收起 = 高度经 grid-template-rows 0fr↔1fr 动画(无需测量高度;
    无过冲缓动——弹簧曲线插值到负 fr 会被钳制,收起时会抖动) */
function ToolCard({ call }: { call: ToolCallData }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`island-agent-tool${open ? ' open' : ''}`}>
      {/* 卡片是交互元素:拦截左键,长按卡片不触发岛体收回 */}
      <button
        type="button"
        className="island-agent-tool-head"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation()
          setOpen((v) => !v)
        }}
        onPointerDown={(event) => {
          if (event.button === 0) event.stopPropagation()
        }}
      >
        <span className={`island-agent-tool-state ${call.ok === false ? 'err' : call.ok ? 'ok' : 'run'}`} aria-hidden="true">
          {call.ok === false ? '✕' : call.ok ? '✓' : '●'}
        </span>
        <span className="island-agent-tool-name">{call.name}</span>
        {call.durationMs !== undefined && (
          <span className="island-agent-tool-time">{call.durationMs}ms</span>
        )}
        <span className="island-agent-tool-toggle" aria-hidden="true">
          ▸
        </span>
      </button>
      <div className="island-agent-tool-body-wrap">
        <div className="island-agent-tool-body">
          <div className="island-agent-tool-sec">
            <span className="island-agent-tool-sec-title">参数</span>
            <pre className="island-agent-tool-code">{JSON.stringify(call.args ?? {}, null, 2)}</pre>
          </div>
          {call.result !== undefined && (
            <div className="island-agent-tool-sec">
              <span className="island-agent-tool-sec-title">{call.ok === false ? '错误' : '结果'}</span>
              <pre className="island-agent-tool-code">{call.result}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** 工具模块:同一回复中**连续**的工具调用收纳成一个模块(信息密度优化——
    逐个工具卡片平铺时,一轮回复 5~6 个工具占用大半面板高度)。
    默认收纳:只有头部一行(图标 + 名称/计数 + 状态汇总 + 总耗时 + 箭头);
    点击展开/收起,高度动画同卡片(0fr↔1fr 无过冲)。头部实时汇总:
    执行中脉冲点 / 成功失败计数,收纳态也能一眼看到执行概况 */
function ToolModule({ items }: { items: ToolCallData[] }) {
  const [open, setOpen] = useState(false)
  const running = items.some((i) => i.ok === undefined)
  const okCount = items.filter((i) => i.ok === true).length
  const errCount = items.filter((i) => i.ok === false).length
  const totalMs = items.reduce((sum, i) => sum + (i.durationMs ?? 0), 0)
  return (
    <div className={`island-agent-tool-module${open ? ' open' : ''}`}>
      {/* 模块头部:交互元素,拦截左键(长按不触发岛体收回) */}
      <button
        type="button"
        className="island-agent-tool-module-head"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation()
          setOpen((v) => !v)
        }}
        onPointerDown={(event) => {
          if (event.button === 0) event.stopPropagation()
        }}
      >
        <svg
          className="island-ctl-svg"
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          aria-hidden="true"
        >
          <line x1="4" y1="6" x2="20" y2="6" />
          <circle cx="14" cy="6" r="2" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <circle cx="8" cy="12" r="2" />
          <line x1="4" y1="18" x2="20" y2="18" />
          <circle cx="16" cy="18" r="2" />
        </svg>
        <span className="island-agent-tool-module-title">
          {items.length === 1 ? items[0].name : `工具调用 ×${items.length}`}
        </span>
        {running ? (
          <span className="island-agent-tool-module-state run">● 执行中</span>
        ) : (
          <>
            {okCount > 0 && <span className="island-agent-tool-module-state ok">✓ {okCount}</span>}
            {errCount > 0 && <span className="island-agent-tool-module-state err">✕ {errCount}</span>}
          </>
        )}
        {totalMs > 0 && <span className="island-agent-tool-time">{totalMs}ms</span>}
        <span className="island-agent-tool-toggle" aria-hidden="true">
          ▸
        </span>
      </button>
      <div className="island-agent-tool-module-body">
        <div className="island-agent-tool-module-inner">
          {items.map((call) => (
            <ToolCard key={call.id} call={call} />
          ))}
        </div>
      </div>
    </div>
  )
}

/** 助手消息块:parts 按顺序渲染(文本段 + 工具调用),尾部附 token 用量。
    工具调用按**连续序列**分组:单次调用 = 一张卡片(点击直开参数/结果);
    连续多次 = 收纳成工具模块(头部一行汇总,点击展开看各卡,再点卡片
    展开参数)——一轮回复的工具再多也只占一行,信息密度优化 */
function AssistantBlock({
  parts,
  usage,
}: {
  parts: AgentMessage['parts']
  usage?: AgentMessage['usage']
}) {
  // 归并节点序列:文本段与连续工具组交替;工具组内的卡片按执行顺序
  // 排列(调用 + 结果配对;顺序即执行顺序,过程可知)
  const nodes: Array<
    | { kind: 'text'; text: string }
    | { kind: 'tools'; items: ToolCallData[] }
  > = []
  let group: ToolCallData[] = []
  const flushGroup = () => {
    if (group.length > 0) {
      nodes.push({ kind: 'tools', items: group })
      group = []
    }
  }
  parts.forEach((part) => {
    if (part.type === 'text') {
      flushGroup()
      nodes.push({ kind: 'text', text: part.text })
    } else if (part.type === 'tool-call') {
      const result = parts.find(
        (p): p is Extract<AgentMessage['parts'][number], { type: 'tool-result' }> =>
          p.type === 'tool-result' && p.id === part.id,
      )
      group.push({
        id: part.id,
        name: part.name,
        args: part.args,
        ok: result?.ok,
        result: result?.result,
        durationMs: result?.durationMs,
      })
    }
  })
  flushGroup()
  return (
    <div className="island-agent-msg-assistant">
      {nodes.map((node, i) => {
        if (node.kind === 'text') {
          return (
            <div key={`t-${i}`} className="island-agent-text">
              <Markdown text={node.text} />
            </div>
          )
        }
        // 单次调用 = 卡片直开参数;连续多次 = 工具模块(收纳,点击展开)
        if (node.items.length === 1) {
          return <ToolCard key={node.items[0].id} call={node.items[0]} />
        }
        return <ToolModule key={node.items[0].id} items={node.items} />
      })}
      {/* 气泡脚注:复制按钮(复制本条回复文本)+ token 用量 */}
      <div className="island-agent-msg-foot">
        <CopyButton
          text={parts
            .filter((p): p is Extract<AgentPart, { type: 'text' }> => p.type === 'text')
            .map((p) => p.text)
            .join('\n')}
        />
        {usage && (
          <span className="island-agent-usage">
            输入 {usage.input.toLocaleString()} · 输出 {usage.output.toLocaleString()}
            {usage.cached ? ` · 缓存命中 ${usage.cached.toLocaleString()}` : ''}
          </span>
        )}
      </div>
    </div>
  )
}

export function AgentView({
  status,
  messages,
  streaming,
  lastError,
  sessions,
  tools,
  onLoadSession,
  onDeleteSession,
  onSend,
  onAbort,
  onClear,
  onOpenSettings,
  onExcludedToolsChange,
  excludedTools,
  onCollapse,
  onHeightChange,
}: AgentViewProps) {
  const [input, setInput] = useState('')
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
  // 删除中的会话 id(离场动画中;播完才真正删除)
  const [leavingSessionIds, setLeavingSessionIds] = useState<string[]>([])
  const leavingSessionTimersRef = useRef<number[]>([])
  // 工具列表视图:搜索词 / 禁用·恢复的离场与入场动画(leaving = 从当前
  // 区离场,entering = 移入另一区时回弹入场;动画计时器统一收集清理)
  const [toolQuery, setToolQuery] = useState('')
  const [leavingTools, setLeavingTools] = useState<string[]>([])
  const [enteringTools, setEnteringTools] = useState<string[]>([])
  const toolAnimTimersRef = useRef<number[]>([])
  // 面板子视图:聊天 / 对话历史 / 工具列表
  const [view, setView] = useState<AgentViewKind>('chat')
  // 视图切换过渡:先切主实例(新视图进场动画),旧视图副本盖在上层
  // 播放离场动画后卸载 —— 交叉过渡,无硬切;back = 返回 chat 方向
  const [leaving, setLeaving] = useState<{ view: AgentViewKind; back: boolean } | null>(null)
  // 展开首帧两阶段:先渲染轻量骨架占位(形变动画期间 DOM 极小,展开顺),
  // 短暂延迟后挂载真实消息内容(依次加载)
  const [phase, setPhase] = useState<'skeleton' | 'content'>('skeleton')
  useEffect(() => {
    const timer = window.setTimeout(() => setPhase('content'), AGENT_PHASE_IN_MS)
    return () => window.clearTimeout(timer)
  }, [])
  // 右上角下拉菜单(⋯):停止生成 / 新对话 / 对话历史 / 工具列表 / 收起面板
  const [menuOpen, setMenuOpen] = useState(false)
  // 卸载时清理候选收起计时器(动画未完成即卸载不残留)
  useEffect(() => () => window.clearTimeout(suggestCloseTimerRef.current), [])
  // 输入框引用:LLM 回复完成后自动聚焦,直接可输入
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const busy = status === 'thinking' || status === 'running'
  // 下拉菜单项:⋯ 弹出菜单与快捷切换按钮共用;条件项随状态
  // (停止生成仅运行中、新对话仅非空历史)。收起面板恒为末项
  // (快捷按钮的默认显示项)
  const menuItems: Array<{ id: AgentMenuItemId; label: string; danger?: boolean }> = []
  if (busy) menuItems.push({ id: 'stop', label: '停止生成', danger: true })
  if (messages.length > 0) menuItems.push({ id: 'clear', label: '新对话' })
  menuItems.push(
    { id: 'history', label: '对话历史' },
    { id: 'tools', label: '工具列表' },
    { id: 'settings', label: '设置' },
    { id: 'collapse', label: '收起面板' },
  )
  // LLM 回复完成(运行中 → 空闲)自动聚焦输入框,直接可输入
  const wasBusyRef = useRef(busy)
  useEffect(() => {
    if (wasBusyRef.current && !busy && view === 'chat') {
      inputRef.current?.focus()
    }
    wasBusyRef.current = busy
  }, [busy, view])

  // 菜单打开时:点击菜单外任意位置关闭(菜单内点击由按钮自身处理)
  useEffect(() => {
    if (!menuOpen) return
    const onDocPointerDown = (event: globalThis.PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('pointerdown', onDocPointerDown)
    return () => document.removeEventListener('pointerdown', onDocPointerDown)
  }, [menuOpen])

  // 岛体高度自适应:目标高度 = 固定部分 + 消息列表内容自然高。
  // 内容自然高 = 子元素高度求和(含列表 gap):scrollHeight 在内容
  // 不足时 = 可视高(flex 拉伸的盒高,自收敛)——岛体高度只长不缩,
  // 上一轮对话拉伸后,新对话不会缩回初始小空间(实测 bug);
  // 子元素高度不受 flex 拉伸影响,始终反映真实内容。
  // clamp 到 [200, 600];超高时岛体封顶 600,列表滚动不自锁。
  // 流式回复中:80ms trailing 节流(逐字增长时高度瞬跳 + 低频重排,防卡)
  const measureTimerRef = useRef(0)
  const streamingRef = useRef(streaming)
  streamingRef.current = streaming
  const measureHeight = useCallback(() => {
    // 骨架期不测量(消息区未挂载,保持岛体下限;内容期才测量长高)
    if (phase !== 'content') return
    // 工具列表/对话历史视图:高度由聊天视图决定(岛体保持进入前的聊天
    // 高度),内容在岛体剩余空间内滚动——不能按子视图内容测量,否则
    // 工具多/会话多会把岛体撑到上限(用户要求:与工具列表相同设计,
    // 实时响应布局,岛体小则列表小可滚动,岛体扩展列表随之扩展)
    if (viewRef.current === 'tools' || viewRef.current === 'history') return
    const el = scrollRef.current
    if (!el) return
    let contentH = 0
    const children = el.children
    for (let i = 0; i < children.length; i++) {
      contentH += (children[i] as HTMLElement).offsetHeight
    }
    if (children.length > 1) {
      // 列表 gap 从运行时样式读取(聊天 10px / 历史、工具 8px,自动跟随)
      const gap = parseFloat(getComputedStyle(el).rowGap)
      if (Number.isFinite(gap) && gap > 0) contentH += (children.length - 1) * gap
    }
    const next = Math.min(
      AGENT_PANEL_MAX_H,
      Math.max(AGENT_PANEL_MIN_H, AGENT_PANEL_FIXED_H + contentH),
    )
    if (streamingRef.current) {
      window.clearTimeout(measureTimerRef.current)
      measureTimerRef.current = window.setTimeout(() => onHeightChange?.(next), 80)
    } else {
      onHeightChange?.(next)
    }
  }, [onHeightChange, phase])

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
    if (leavingSessionIds.includes(id)) return
    const row = event.currentTarget.closest('.island-agent-history-item') as HTMLElement | null
    row?.style.setProperty('height', `${row.offsetHeight}px`)
    setLeavingSessionIds((prev) => [...prev, id])
    leavingSessionTimersRef.current.push(
      window.setTimeout(() => {
        setLeavingSessionIds((prev) => prev.filter((x) => x !== id))
        onDeleteSession(id)
      }, 260),
    )
  }
  // 卸载时清理离场定时器(动画未完成即卸载不残留)
  useEffect(
    () => () => {
      leavingSessionTimersRef.current.forEach((t) => window.clearTimeout(t))
      toolAnimTimersRef.current.forEach((t) => window.clearTimeout(t))
    },
    [],
  )

  // 工具禁用 / 恢复:先播离场动画(0.24s)再提交配置,行移入另一区时
  // 带入场动画(0.34s 回弹);动画期间禁止重复操作(动画未完成即卸载
  // 不残留,计时器统一收集)
  const toggleToolDisabled = (name: string, disable: boolean) => {
    const current = excludedTools ?? []
    // 仅离场中拦截:入场动画期间允许再次操作(行还在原区,离场动画
    // 会覆盖入场动画,无冲突)
    if (leavingTools.includes(name)) return
    const next = disable
      ? [...new Set([...current, name])]
      : current.filter((n) => n !== name)
    if (next.length === current.length) return
    setLeavingTools((prev) => [...prev, name])
    toolAnimTimersRef.current.push(
      window.setTimeout(() => {
        setLeavingTools((prev) => prev.filter((n) => n !== name))
        onExcludedToolsChange?.(next)
        // 行移入目标区(禁用区 / 可用区):回弹入场动画
        setEnteringTools((prev) => [...prev, name])
        toolAnimTimersRef.current.push(
          window.setTimeout(() => {
            setEnteringTools((prev) => prev.filter((n) => n !== name))
          }, 460),
        )
      }, 260),
    )
  }

  // ===== 快捷切换按钮(悬浮 ⋯ 时在左侧浮现;滚轮逐格切换、单击跳转) =====
  // 默认显示"收起面板"(末项);滚轮可切换到菜单的各个入口;单击执行当前项。
  // 菜单项随 busy/messages 变化:索引经 ref 跨渲染同步,渲染时钳制有效范围
  const [quickIndex, setQuickIndex] = useState(() => menuItems.length - 1)
  const [quickTick, setQuickTick] = useState(0)
  // 切换前的内容与方向(WheelSwap 旧内容滑出/新内容回弹滑入)
  const [quickPrev, setQuickPrev] = useState<{ id: AgentMenuItemId; label: string } | null>(null)
  const [quickDir, setQuickDir] = useState<1 | -1>(1)
  const quickIndexRef = useRef(quickIndex)
  quickIndexRef.current = quickIndex
  const quickItem = menuItems[Math.min(quickIndex, menuItems.length - 1)]

  // 执行菜单项动作(⋯ 弹出菜单与快捷按钮共用)
  const runItem = useCallback(
    (id: AgentMenuItemId) => {
      setMenuOpen(false)
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
        case 'collapse':
          onCollapse()
          break
      }
    },
    [onAbort, onClear, onCollapse, onOpenSettings, switchView],
  )

  // 滚轮推进一格(dir = 1 向下滚 = 列表下移 = 下一项;-1 向上滚 = 上一项,
  // 循环)。每格重挂载按钮重放内容交换动画(旧内容滑出/新内容回弹滑入)
  const stepQuick = (dir: 1 | -1) => {
    const n = menuItems.length
    const cur = Math.min(quickIndexRef.current, n - 1)
    setQuickPrev(menuItems[cur])
    setQuickDir(dir)
    quickIndexRef.current = (cur + dir + n) % n
    setQuickIndex(quickIndexRef.current)
    setQuickTick((t) => t + 1)
  }

  // 滚轮逐格步进(共享 useWheelSteps:每 60px 一步、步间 ≥100ms、
  // 350ms 无滚动重置——与记忆类型按钮手感一致)
  const wheelSteps = useWheelSteps()
  const handleQuickWheel = (event: WheelEvent<HTMLDivElement>) => {
    const dir = wheelSteps(event)
    if (dir) stepQuick(dir)
  }

  // 单击快捷按钮:执行当前项并复位默认(收起面板)
  const handleQuickClick = (event: MouseEvent<HTMLDivElement>) => {
    event.stopPropagation()
    runItem(quickItem.id)
    setQuickPrev(quickItem)
    setQuickDir(1)
    quickIndexRef.current = menuItems.length - 1
    setQuickIndex(quickIndexRef.current)
    setQuickTick((t) => t + 1)
  }

  // 快捷按钮内容(图标 + 标签):WheelSwap 的旧/新两层共用
  const quickItemNode = (item: { id: AgentMenuItemId; label: string }) => (
    <>
      {QUICK_MENU_ICONS[item.id]}
      <span className="island-agent-quick-label">{item.label}</span>
    </>
  )

  // 内容变化(消息/流式/状态)时重测(rAF 延迟一帧:面板首帧挂载不阻塞
  // 展开动画布局,测量结果下一帧生效,展开更顺)
  useLayoutEffect(() => {
    const raf = requestAnimationFrame(measureHeight)
    return () => cancelAnimationFrame(raf)
  }, [measureHeight, messages, streaming, status, lastError, phase])

  // ResizeObserver 兜底:字体/岛宽变化导致换行数变化时,列表高度随之变化
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || !onHeightChange) return
    const observer = new ResizeObserver(measureHeight)
    observer.observe(el)
    return () => observer.disconnect()
  }, [measureHeight, onHeightChange])

  // 卸载时清理测量节流计时器
  useEffect(() => () => window.clearTimeout(measureTimerRef.current), [])

  // 消息/流式变化时自动滚到底(用户上翻查看历史时不打扰)
  useEffect(() => {
    const el = scrollRef.current
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [messages, streaming, status, lastError])

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }

  // 进入对话面板(chat 视图内容挂载后)自动滚动到最近信息:
  // 恢复历史/展开面板时用户期望看到最新消息,而不是停留在旧位置。
  // 自绘非线性滚动(先加速再减速 + 平滑停止;距离大时动画稍长)。
  // 高斯模糊只用于长消息列表滚动的性能优化——**新对话没有过去的
  // 消息时不模糊**(紧凑态进入新对话的滚动动画干净无模糊)。
  // messages 长度经 ref 读取:不入依赖(消息到达时发送路径已平滑滚动,
  // 这里只在视图/骨架切换时滚动一次)
  const messagesLenRef = useRef(messages.length)
  messagesLenRef.current = messages.length
  useEffect(() => {
    if (view !== 'chat' || phase !== 'content') return
    const el = scrollRef.current
    if (el) {
      atBottomRef.current = true
      smoothScrollTo(el, el.scrollHeight, 800, messagesLenRef.current > 0)
    }
  }, [view, phase])

  const submit = () => {
    const text = input.trim()
    if (!text || busy) return
    onSend(text)
    setInput('')
    // 发送后自绘非线性滚动到底(输入框高度可能变化;先加速再减速,
    // 平滑停止)。**不模糊**:对话中跳转最新消息的消息列表往往很短,
    // 模糊只服务于长列表滚动动画的性能优化,这里不需要(实测对话中
    // 每次发送都会触发模糊,观感不佳)
    requestAnimationFrame(() => {
      const el = scrollRef.current
      if (el) {
        atBottomRef.current = true
        smoothScrollTo(el, el.scrollHeight, 650, false)
      }
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
    // 外部工具前缀:技能 skill_<slug>;MCP 工具 mcp_<服务>_<工具>(双下划线)——
    // 内置工具 mcp_config 恰好以 mcp_ 开头,用"名称里存在第二个下划线"
    // 区分(外部 MCP 工具名必有服务段与工具段,实测 @mcp_config 混入候选)
    const all = tools.filter((t) =>
      prefix === '/'
        ? t.name.startsWith('skill_')
        : t.name.startsWith('mcp_') && t.name.indexOf('_', 4) > 0,
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
                className={`island-agent-history-item${leavingSessionIds.includes(s.id) ? ' leaving' : ''}`}
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
        `${leavingTools.includes(name) ? ' island-ui-leave' : ''}${
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
              <details
                key={t.name}
                className={`island-agent-tools-item${rowAnimClass(t.name)}`}
                onPointerDown={(event) => {
                  if (event.button === 0) event.stopPropagation()
                }}
              >
                <summary>
                  <span className="island-agent-tools-name">{t.name}</span>
                  <button
                    type="button"
                    className="island-tools-disable"
                    title="禁用此工具(对话中不可用)"
                    onClick={(event) => {
                      // preventDefault 阻止 summary 的展开/收起默认行为
                      event.preventDefault()
                      event.stopPropagation()
                      toggleToolDisabled(t.name, true)
                    }}
                  >
                    禁用
                  </button>
                  <span className="island-agent-tools-toggle" aria-hidden="true">
                    ▸
                  </span>
                </summary>
                <div className="island-agent-tools-body">
                  <p className="island-agent-tools-desc">{t.description}</p>
                  <pre className="island-agent-tool-code">
                    {JSON.stringify(t.parameters, null, 2)}
                  </pre>
                </div>
              </details>
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
          <div className={`island-agent-menu${menuOpen ? ' open' : ''}`} ref={menuRef}>
            {/* 快捷切换按钮:悬浮 ⋯ 时在左侧浮现,默认显示"收起面板"。
                滚轮在菜单各入口间逐格切换(顿挫 tick)、单击执行当前项。
                透明命中区自 ⋯ 左缘向左延伸(覆盖间隙与按钮本身)——鼠标
                从 ⋯ 横移到按钮的过程悬停不中断,按钮不会中途消失。
                菜单打开时(.open)隐藏(弹出面板已展开,快捷按钮冗余) */}
            <div
              className="island-agent-quick"
              onPointerDown={(event) => {
                if (event.button === 0) event.stopPropagation()
              }}
              onClick={handleQuickClick}
              onWheel={handleQuickWheel}
            >
              <button
                key={quickTick}
                type="button"
                className={`island-agent-quick-btn${quickItem.danger ? ' danger' : ''}`}
                title={quickItem.label}
              >
                <WheelSwap tick={quickTick} dir={quickDir} prev={quickPrev ? quickItemNode(quickPrev) : null}>
                  {quickItemNode(quickItem)}
                </WheelSwap>
              </button>
            </div>
            <button
              type="button"
              className={`island-agent-ctl${menuOpen ? ' on' : ''}`}
              title="更多操作"
              onClick={(event) => {
                event.stopPropagation()
                setMenuOpen((v) => !v)
              }}
            >
              <svg
                className="island-ctl-svg"
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <circle cx="12" cy="5" r="1.9" />
                <circle cx="12" cy="12" r="1.9" />
                <circle cx="12" cy="19" r="1.9" />
              </svg>
            </button>
            {menuOpen && (
              <div className="island-agent-menu-pop">
                {menuItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`island-agent-menu-item${item.danger ? ' danger' : ''}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      runItem(item.id)
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 消息列表:展开首帧先渲染骨架占位(形变动画期间 DOM 轻量),
            延迟后挂载真实内容淡入并测量长高 */}
        {phase === 'skeleton' ? (
          <div className="island-agent-skeleton" aria-hidden="true">
            <div className="island-agent-skeleton-item assistant" />
            <div className="island-agent-skeleton-item user" />
            <div className="island-agent-skeleton-item assistant short" />
          </div>
        ) : (
          <div className="island-agent-messages" ref={listRef} onScroll={handleScroll}>
            {messages.length === 0 && !streaming && !lastError && (
              <div className="island-agent-welcome">
                我是岛灵,可以帮你执行本机操作。
                <br />
                试试:「打开计算器」「查一下最近的新闻」「列出下载目录」
              </div>
            )}
            {messages.map((m) =>
              m.role === 'user' ? (
                <UserBubble key={m.id} m={m} />
              ) : (
                <AssistantBlock key={m.id} parts={m.parts} usage={m.usage} />
              ),
            )}
            {/* 流式中的助手回复 */}
            {streaming && (streaming.text || streaming.tools.length > 0) && (
              <div className="island-agent-msg-assistant">
                {streaming.text && (
                  <div className="island-agent-text">
                    <Markdown text={streaming.text} caret />
                  </div>
                )}
                {streaming.tools.map((tool) => (
                  <ToolCard
                    key={tool.id}
                    call={{
                      id: tool.id,
                      name: tool.name,
                      args: tool.args,
                      ok: tool.ok,
                      result: tool.result,
                      durationMs: tool.durationMs,
                    }}
                  />
                ))}
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
        )}

        {/* 输入区(交互区:长按不触发收回) */}
        <div
          className="island-agent-input"
          onPointerDown={(event) => {
            if (event.button === 0) event.stopPropagation()
          }}
        >
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
                    {t.description.replace(/^\[MCP 服务:[^\]]+\]\s*/, '').slice(0, 28)}
                  </span>
                </button>
              ))}
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
              disabled={!input.trim()}
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
