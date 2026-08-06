/**
 * useAgent —— Agent 模式状态管理
 *
 * 职责:
 * - 订阅引擎事件流(经主进程转发),组装消息(parts 模型)与状态机;
 * - 持有完整历史(引擎无状态,每次 send 回传),持久化到 localStorage;
 * - send / abort / clear / 配置读写。
 *
 * 流式管线:文本/推理增量、工具参数增量实时更新"未落定助手消息",
 * 引擎在每轮结束时发送权威 message 事件,以它替换流式累积(单一事实来源)。
 * 中止:丢弃未落定的流式消息(引擎不会再发 message 事件)。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AgentConfig,
  AgentEvent,
  AgentMessage,
  AgentPart,
  AgentSession,
  AgentStatus,
  AgentToolCallState,
  AgentToolInfo,
} from '../agent/types'

const HISTORY_KEY = 'widget-agent-messages'
/** 历史会话列表存储键(多对话存档) */
const SESSIONS_KEY = 'widget-agent-sessions'
/** 当前对话实时总结标题存储键 */
const TITLE_KEY = 'widget-agent-title'
/** 历史会话数量上限(超出丢弃最旧) */
const MAX_SESSIONS = 20

/** 未落定的助手消息(流式累积) */
interface PendingAssistant {
  text: string
  reasoning: string
  tools: AgentToolCallState[]
}

function loadHistory(): AgentMessage[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as AgentMessage[]
    if (!Array.isArray(parsed)) return []
    // 轻量校验:只保留合法消息,防御旧版本脏数据
    return parsed.filter(
      (m) =>
        m &&
        typeof m === 'object' &&
        (m.role === 'user' || m.role === 'assistant') &&
        Array.isArray(m.parts),
    )
  } catch {
    return []
  }
}

function loadSessions(): AgentSession[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as AgentSession[]
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (s) =>
        s &&
        typeof s === 'object' &&
        typeof s.id === 'string' &&
        typeof s.title === 'string' &&
        Array.isArray(s.messages),
    )
  } catch {
    return []
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  const text = raw.trim()
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export interface AgentController {
  status: AgentStatus
  messages: AgentMessage[]
  streaming: PendingAssistant | null
  lastError: string | null
  config: AgentConfig | null
  sessions: AgentSession[]
  tools: AgentToolInfo[]
  /** 当前对话实时总结标题(每轮回复后静默更新;null = 尚无总结) */
  currentTitle: string | null
  send(text: string): void
  abort(): void
  clear(): void
  loadSession(id: string): void
  deleteSession(id: string): void
  saveConfig(patch: Partial<AgentConfig>): Promise<void>
  /** 重新拉取配置(LLM 自我配置后设置界面需刷新) */
  refreshConfig(): void
}

export function useAgent(): AgentController {
  const [messages, setMessages] = useState<AgentMessage[]>(loadHistory)
  const [status, setStatus] = useState<AgentStatus>('idle')
  const [streaming, setStreaming] = useState<PendingAssistant | null>(null)
  const [lastError, setLastError] = useState<string | null>(null)
  const [config, setConfig] = useState<AgentConfig | null>(null)
  // 历史会话列表(新对话时自动存档当前对话)
  const [sessions, setSessions] = useState<AgentSession[]>(loadSessions)
  // 工具清单(引擎 → 主进程 IPC,UI 展示用)
  const [tools, setTools] = useState<AgentToolInfo[]>([])
  // 当前对话实时总结标题(每轮回复完成后静默总结;显示在文字区,
  // 入历史时作为标题)
  const [currentTitle, setCurrentTitle] = useState<string | null>(() => {
    try {
      return localStorage.getItem(TITLE_KEY)
    } catch {
      return null
    }
  })
  // 会话版本号:仅在 clear/loadSession(会话真正切换)时递增;
  // 总结完成时校验,旧会话的总结不覆盖新会话。
  // 注意:send 不递增——连续对话时每轮总结基于最新消息,旧总结结果
  // 主题一致仍有效,递增会把总结全部作废(文字区永远等不到标题)
  const sessionVersionRef = useRef(0)
  // 总结进行中标记 + 排队标记:进行中新一轮回复落定时不跳过,
  // 标记 pending,完成后补跑一次(追平连续对话——跳过会让标题
  // 永远等不到,是"显示回复开头"的常见原因)
  const summarizeInFlightRef = useRef(false)
  const summarizePendingRef = useRef(false)
  // 加载历史后跳过下一次总结(历史已有标题,无需重新总结)
  const skipNextSummaryRef = useRef(false)

  // 订阅/发送需要引用最新的 messages(事件回调里不要依赖闭包里的 state)
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const currentTitleRef = useRef(currentTitle)
  currentTitleRef.current = currentTitle
  const statusRef = useRef(status)
  statusRef.current = status

  // 事件订阅(一次性)
  useEffect(() => {
    const desktop = window.desktop
    if (!desktop?.onAgentEvent) return
    return desktop.onAgentEvent((raw: unknown) => {
      const event = raw as AgentEvent
      switch (event.type) {
        case 'status':
          setStatus(event.status)
          break
        case 'text-delta':
          setStreaming((prev) => ({ text: (prev?.text ?? '') + event.text, reasoning: prev?.reasoning ?? '', tools: prev?.tools ?? [] }))
          break
        case 'reasoning-delta':
          setStreaming((prev) => ({ text: prev?.text ?? '', reasoning: (prev?.reasoning ?? '') + event.text, tools: prev?.tools ?? [] }))
          break
        case 'tool-partial-call': {
          setStreaming((prev) => {
            const tools = prev?.tools ?? []
            const idx = tools.findIndex((t) => t.id === event.id)
            const entry: AgentToolCallState = { id: event.id, name: event.name, args: parseArgs(event.args), argsRaw: event.args }
            if (idx === -1) tools.push(entry)
            else tools[idx] = entry
            return { text: prev?.text ?? '', reasoning: prev?.reasoning ?? '', tools: [...tools] }
          })
          break
        }
        case 'tool-call': {
          setStreaming((prev) => {
            const tools = prev?.tools ?? []
            const idx = tools.findIndex((t) => t.id === event.id)
            const entry: AgentToolCallState = { id: event.id, name: event.name, args: parseArgs(event.args), argsRaw: event.args }
            if (idx === -1) tools.push(entry)
            else tools[idx] = entry
            return { text: prev?.text ?? '', reasoning: prev?.reasoning ?? '', tools: [...tools] }
          })
          break
        }
        case 'tool-result': {
          setStreaming((prev) => {
            const tools = prev?.tools ?? []
            const idx = tools.findIndex((t) => t.id === event.id)
            if (idx === -1) {
              tools.push({
                id: event.id,
                name: event.name,
                args: {},
                ok: event.ok,
                result: event.result,
                durationMs: event.durationMs,
              })
            } else {
              tools[idx] = {
                ...tools[idx],
                ok: event.ok,
                result: event.result,
                durationMs: event.durationMs,
              }
            }
            return { text: prev?.text ?? '', reasoning: prev?.reasoning ?? '', tools: [...tools] }
          })
          break
        }
        case 'message': {
          // 权威落定:以引擎回传的 parts 替换流式累积(附 token 用量);
          // 静默总结由下方 effect 在 status idle 后统一触发
          setStreaming(null)
          setMessages((prev) => [...prev, { ...event.message, usage: event.usage }])
          setLastError(null)
          break
        }
        case 'error':
          setStreaming(null)
          setLastError(event.message)
          setStatus('idle')
          break
        case 'background-done': {
          // 后台长任务完成(如 bili 下载):自动触发一轮对话——LLM 基于
          // 系统提示的状态块主动告知用户结果,无需用户主动提问
          // (实测:下载完成后用户不提问就不知道结果)。
          // 复用 send:busy 时忽略(对话中的状态块已覆盖),idle 时发送;
          // send 引用稳定(useCallback []),事件订阅闭包安全
          const text = `【系统通知】${event.title}:${event.message}。请根据当前任务状态,用一两句话主动告知用户结果。`
          send(text)
          break
        }
        default:
          break
      }
    })
    // send 引用稳定(useCallback [])且**声明在本 effect 之后**(TDZ:
    // 依赖数组在渲染时求值,把 send 放进依赖会"used before declaration"
    // 直接崩)——事件回调运行时 send 早已初始化,闭包引用安全
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 消息持久化:直接同步写(不防抖)。防抖 300ms 在页面刷新/渲染进程
  // 重启时会丢最后几秒的消息(实测:刚对话完最新一轮消息消失);
  // 写入频率低(每轮仅 send + message 落定两次),stringify 成本可接受。
  // 超限降级(历史含大工具结果时 localStorage 超限)→ 存最近 80 条,
  // 不静默丢失
  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(messages))
    } catch {
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(messages.slice(-80)))
      } catch {
        // 存储失败忽略(隐私模式等)
      }
    }
  }, [messages])
  // 历史会话持久化(数量少,直接同步写)
  useEffect(() => {
    try {
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions))
    } catch {
      // 存储失败忽略
    }
  }, [sessions])
  // 当前对话标题持久化
  useEffect(() => {
    try {
      if (currentTitle) localStorage.setItem(TITLE_KEY, currentTitle)
      else localStorage.removeItem(TITLE_KEY)
    } catch {
      // 存储失败忽略
    }
  }, [currentTitle])
  // 每轮回复完成后静默总结(messages 落定 + status idle 触发)。
  // 排队追平:总结进行中新一轮回复落定 → 标记 pending,完成后补跑
  // 最新一轮;结果带会话版本校验(clear/loadSession 作废),旧快照结果
  // 主题一致直接生效(总比空标题好,新总结后覆盖)。
  // 失败重试:网络抖动 1.5s 后重试同一快照(retryLeft 预算递减);
  // 预算耗尽 → 10s 后补跑一次**最新**消息(仅此一次,不连锁重试)—
  // 会话静止时标题也能补上,文字区不会一直停留在回复开头预览。
  // 入口守卫:任何路径不并发总结(in-flight 期间新触发只排队)
  const runSummary = useCallback((snapshot: AgentMessage[], retryLeft = 1) => {
    if (summarizeInFlightRef.current) return
    summarizeInFlightRef.current = true
    const version = sessionVersionRef.current
    // 总结落定后追平:期间新一轮回复落定(pending)→ 补跑最新一轮
    const catchUpIfNeeded = () => {
      if (!summarizePendingRef.current) return
      summarizePendingRef.current = false
      if (statusRef.current === 'idle' && messagesRef.current.length > 0) {
        void runSummary(messagesRef.current, 0)
      }
    }
    window.desktop
      ?.agentSummarize?.(snapshot)
      .then((title) => {
        summarizeInFlightRef.current = false
        // 双保险:引擎已清洗并截断到岛体文字区容量,这里再按码元
        // 兜底(标题过长在紧凑态会被截成"开头几字",观感等同失败)
        const t = Array.from((title ?? '').trim()).slice(0, 12).join('')
        if (t && sessionVersionRef.current === version) setCurrentTitle(t)
        catchUpIfNeeded()
      })
      .catch(() => {
        summarizeInFlightRef.current = false
        if (retryLeft > 0) {
          // 网络抖动:1.5s 后重试同一快照;期间新消息落定(排队中)
          // 则改补跑最新一轮,不再重试陈旧快照
          window.setTimeout(() => {
            if (summarizePendingRef.current) {
              summarizePendingRef.current = false
              if (statusRef.current === 'idle' && messagesRef.current.length > 0) {
                void runSummary(messagesRef.current, 0)
              }
            } else {
              void runSummary(snapshot, retryLeft - 1)
            }
          }, 1500)
        } else {
          // 全部重试都失败:延迟补跑一次最新消息(仅此一次,
          // 不再走重试链——避免对同一对话无限循环请求)
          window.setTimeout(() => {
            if (summarizeInFlightRef.current) return
            if (statusRef.current !== 'idle' || messagesRef.current.length === 0) return
            if (summarizePendingRef.current) summarizePendingRef.current = false
            summarizeInFlightRef.current = true
            const latest = messagesRef.current
            const v = sessionVersionRef.current
            window.desktop
              ?.agentSummarize?.(latest)
              .then((title) => {
                summarizeInFlightRef.current = false
                const t = Array.from((title ?? '').trim()).slice(0, 12).join('')
                if (t && sessionVersionRef.current === v) setCurrentTitle(t)
              })
              .catch(() => {
                summarizeInFlightRef.current = false
                // 补跑失败不再重试
              })
          }, 10000)
        }
      })
  }, [])

  useEffect(() => {
    if (status !== 'idle' || messages.length === 0) return
    if (skipNextSummaryRef.current) {
      skipNextSummaryRef.current = false
      return
    }
    if (summarizeInFlightRef.current) {
      // 进行中:排队,完成时补跑
      summarizePendingRef.current = true
      return
    }
    void runSummary(messages)
  }, [messages, status, runSummary])

  // 启动时读取配置(API Key / 模型等,主进程 settings.json)与工具清单
  useEffect(() => {
    window.desktop?.agentGetConfig?.().then(setConfig).catch(() => {})
    window.desktop
      ?.agentGetTools?.()
      .then((list) => setTools(list as AgentToolInfo[]))
      .catch(() => {})
  }, [])

  const send = useCallback((text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    if (statusRef.current === 'thinking' || statusRef.current === 'running') return
    const prev = messagesRef.current
    const last = prev[prev.length - 1]
    // 上一轮被中止/失败(未落定助手消息,历史以 user 消息结尾):把新输入
    // 合并进该消息——避免连续两条 user 消息(LLM 会把上一轮未答复的
    // 请求当"仍待执行"重复执行 = 上下文污染,实测:switch_to_music
    // 被重复调用,导致"打开B站"时又被自动切回音乐模式;此处合并后
    // 两段请求同一轮内一并答复)
    if (last && last.role === 'user') {
      const merged: AgentMessage = {
        ...last,
        parts: [...last.parts, { type: 'text', text: trimmed }],
      }
      const next = [...prev.slice(0, -1), merged]
      messagesRef.current = next
      setMessages(next)
      setLastError(null)
      // 引擎无状态:回传完整历史(末尾即当前轮的用户消息,引擎不再追加)
      window.desktop?.agentSend?.(trimmed, next)
      return
    }
    // 注意:不递增会话版本(连续对话时总结基于最新消息,旧结果主题一致
    // 仍有效;递增会把每轮总结都作废,标题永远等不到)
    const userMessage: AgentMessage = {
      id: `u-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'user',
      parts: [{ type: 'text', text: trimmed }],
    }
    const next = [...prev, userMessage]
    // 同步更新引用:连续 send 之间(React 尚未渲染)也能拿到最新历史,
    // 避免第二次 send 基于旧消息覆盖第一次(最新一轮用户消息消失)
    messagesRef.current = next
    setMessages(next)
    setLastError(null)
    // 引擎无状态:回传完整历史(含刚加入的用户消息)
    window.desktop?.agentSend?.(trimmed, next)
  }, [])

  const abort = useCallback(() => {
    window.desktop?.agentAbort?.()
    // 丢弃未落定的流式消息(引擎中止后不会再发 message 事件)
    setStreaming(null)
  }, [])

  const clear = useCallback(() => {
    // 新对话:当前对话(非空)存档到历史,再清空。
    // 标题用实时总结(每轮回复后已静默更新,无需再次调用 LLM)
    sessionVersionRef.current += 1
    const current = messagesRef.current
    if (current.length > 0) {
      const title = currentTitleRef.current?.trim() || '对话'
      const session: AgentSession = {
        id: `s-${Date.now()}`,
        title: title.slice(0, 24),
        updatedAt: Date.now(),
        messages: current,
      }
      setSessions((prev) => [session, ...prev].slice(0, MAX_SESSIONS))
    }
    setMessages([])
    setStreaming(null)
    setLastError(null)
    setCurrentTitle(null)
  }, [])

  const loadSession = useCallback((id: string) => {
    const target = sessionsRef.current.find((s) => s.id === id)
    if (!target) return
    // 加载 = 替换当前对话;从历史移除(当前会话继续由 HISTORY_KEY 持久化);
    // 标题重置并跳过下一次自动总结(历史消息不该被重新总结)
    sessionVersionRef.current += 1
    skipNextSummaryRef.current = true
    setMessages(target.messages)
    setSessions((prev) => prev.filter((s) => s.id !== id))
    setStreaming(null)
    setLastError(null)
    setCurrentTitle(null)
  }, [])

  const deleteSession = useCallback((id: string) => {
    setSessions((prev) => prev.filter((s) => s.id !== id))
  }, [])

  const saveConfig = useCallback(async (patch: Partial<AgentConfig>) => {
    const next = await window.desktop?.agentSetConfig?.(patch)
    if (next) setConfig(next as AgentConfig)
  }, [])

  /**
   * 重新拉取配置与工具清单(主进程)。
   * 场景:LLM 对话中 mcp_config/skills_config 工具改了配置(写 settings.json)
   * 或创建了技能(写技能目录)——而 config/tools 都只在挂载时读一次 →
   * 设置界面显示旧快照(实测 bug:对话里添加的 MCP 服务设置里为空;
   * LLM 创建的技能不出现在设置技能列表)。打开 Agent 设置视图时调用;
   * tools 刷新 = agentGetTools(listAllTools 实时扫描,新技能立即可见)
   */
  const refreshConfig = useCallback(() => {
    window.desktop?.agentGetConfig?.().then(setConfig).catch(() => {})
    window.desktop
      ?.agentGetTools?.()
      .then((list) => setTools(list as AgentToolInfo[]))
      .catch(() => {})
  }, [])

  return {
    status,
    messages,
    streaming,
    lastError,
    config,
    sessions,
    tools,
    currentTitle,
    send,
    abort,
    clear,
    loadSession,
    deleteSession,
    saveConfig,
    refreshConfig,
  }
}

/** 把消息 parts 里的文本拼出来(助手回复预览/落定展示用) */
export function textFromMessage(message: AgentMessage): string {
  return message.parts
    .filter((p): p is Extract<AgentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}
