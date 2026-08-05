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
  type ReactNode,
  type RefObject,
} from 'react'
import type { AgentMessage, AgentPanelProps, AgentPart, AgentToolCallState } from '../../../agent/types'
import {
  AGENT_PANEL_FIXED_H,
  AGENT_PANEL_MAX_H,
  AGENT_PANEL_MIN_H,
  AGENT_PHASE_IN_MS,
} from '../layout'

/** 面板子视图:聊天 / 对话历史 / 工具列表 */
type AgentViewKind = 'chat' | 'history' | 'tools'
/**
 * 视图切换离场副本卸载延时(ms):必须大于 CSS 离场动画时长(0.15s),
 * 留出余量保证动画播完(forwards 停在透明)才卸载——提前卸载会
 * 在动画中途突然消失,是切换闪烁的常见原因
 */
const VIEW_LEAVE_MS = 200

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

/** 写入剪贴板:Clipboard API 优先,失败(非安全上下文等)回退 execCommand */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }
}

/** 复制按钮:点击把文本写入剪贴板,短暂显示 ✓ 反馈。
 * 拦截左键 pointerdown —— 消息区内交互元素,长按不触发岛体收回 */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className={`island-agent-copy${copied ? ' copied' : ''}`}
      title="复制"
      aria-label="复制"
      onPointerDown={(event) => {
        if (event.button === 0) event.stopPropagation()
      }}
      onClick={(event) => {
        event.stopPropagation()
        void copyToClipboard(text).then((ok) => {
          if (!ok) return
          setCopied(true)
          window.setTimeout(() => setCopied(false), 900)
        })
      }}
    >
      {copied ? (
        '✓'
      ) : (
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
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  )
}

/** 用户消息气泡:右侧强调色,文本 + 复制按钮 */
function UserBubble({ m }: { m: AgentMessage }) {
  const text = m.parts
    .filter((p): p is Extract<AgentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
  return (
    <div className="island-agent-msg-user">
      <div className="island-agent-msg-user-text">{text}</div>
      <CopyButton text={text} />
    </div>
  )
}

/** 工具卡片:从已落定消息的 parts 里取"调用 + 结果"对 */
function ToolCard({ call }: { call: { id: string; name: string; args: Record<string, unknown>; ok?: boolean; result?: string; durationMs?: number } }) {
  return (
    <details className="island-agent-tool">
      {/* 卡片是交互元素:拦截左键,长按卡片不触发岛体收回 */}
      <summary
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
      </summary>
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
    </details>
  )
}

/** 助手消息块:parts 按顺序渲染(文本段 + 工具卡片),尾部附 token 用量 */
function AssistantBlock({
  parts,
  usage,
}: {
  parts: AgentMessage['parts']
  usage?: AgentMessage['usage']
}) {
  return (
    <div className="island-agent-msg-assistant">
      {parts.map((part, i) => {
        if (part.type === 'text') {
          return (
            <div key={i} className="island-agent-text">
              {part.text}
            </div>
          )
        }
        if (part.type === 'tool-call') {
          const result = parts.find(
            (p): p is Extract<AgentMessage['parts'][number], { type: 'tool-result' }> =>
              p.type === 'tool-result' && p.id === part.id,
          )
          return (
            <ToolCard
              key={part.id}
              call={{
                id: part.id,
                name: part.name,
                args: part.args,
                ok: result?.ok,
                result: result?.result,
                durationMs: result?.durationMs,
              }}
            />
          )
        }
        return null
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

/** 流式工具卡(执行中:状态随事件流转) */
function StreamingToolCard({ tool }: { tool: AgentToolCallState }) {
  return (
    <ToolCard
      call={{
        id: tool.id,
        name: tool.name,
        args: tool.args,
        ok: tool.ok,
        result: tool.result,
        durationMs: tool.durationMs,
      }}
    />
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
  onCollapse,
  onHeightChange,
}: AgentViewProps) {
  const [input, setInput] = useState('')
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
  // 输入框引用:LLM 回复完成后自动聚焦,直接可输入
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const busy = status === 'thinking' || status === 'running'
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

  const submit = () => {
    const text = input.trim()
    if (!text || busy) return
    onSend(text)
    setInput('')
    // 发送后滚到底(输入框高度可能变化)
    requestAnimationFrame(() => {
      const el = scrollRef.current
      if (el) {
        atBottomRef.current = true
        el.scrollTop = el.scrollHeight
      }
    })
  }

  const handleInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
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
              <div key={s.id} className="island-agent-history-item">
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
                  onClick={(event) => {
                    event.stopPropagation()
                    onDeleteSession(s.id)
                  }}
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
      /* 工具列表视图:名称 + 描述 + 参数 schema(可展开) */
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
            {tools.length === 0 && <div className="island-agent-welcome">工具清单加载中…</div>}
            {tools.map((t) => (
              <details
                key={t.name}
                className="island-agent-tools-item"
                onPointerDown={(event) => {
                  if (event.button === 0) event.stopPropagation()
                }}
              >
                <summary>
                  <span className="island-agent-tools-name">{t.name}</span>
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
          <div className="island-agent-menu" ref={menuRef}>
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
                {busy && (
                  <button
                    type="button"
                    className="island-agent-menu-item danger"
                    onClick={(event) => {
                      event.stopPropagation()
                      setMenuOpen(false)
                      onAbort()
                    }}
                  >
                    停止生成
                  </button>
                )}
                {messages.length > 0 && (
                  <button
                    type="button"
                    className="island-agent-menu-item"
                    onClick={(event) => {
                      event.stopPropagation()
                      setMenuOpen(false)
                      onClear()
                    }}
                  >
                    新对话
                  </button>
                )}
                <button
                  type="button"
                  className="island-agent-menu-item"
                  onClick={(event) => {
                    event.stopPropagation()
                    setMenuOpen(false)
                    switchView('history')
                  }}
                >
                  对话历史
                </button>
                <button
                  type="button"
                  className="island-agent-menu-item"
                  onClick={(event) => {
                    event.stopPropagation()
                    setMenuOpen(false)
                    switchView('tools')
                  }}
                >
                  工具列表
                </button>
                <button
                  type="button"
                  className="island-agent-menu-item"
                  onClick={(event) => {
                    event.stopPropagation()
                    setMenuOpen(false)
                    onCollapse()
                  }}
                >
                  收起面板
                </button>
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
                    {streaming.text}
                    <span className="island-agent-caret" aria-hidden="true" />
                  </div>
                )}
                {streaming.tools.map((tool) => (
                  <StreamingToolCard key={tool.id} tool={tool} />
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
