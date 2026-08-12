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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { stripNapcatHistoryInstructions } from '../agent/text'
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

/** 按码元截断(后台标签结果清洗:引擎已截,这里兜底;跨 emoji 安全) */
function truncateCodepoints(value: string | null | undefined, max: number): string {
  return Array.from((value ?? '').trim()).slice(0, max).join('')
}

const HISTORY_KEY = 'widget-agent-messages'
/** 历史会话列表存储键(多对话存档) */
const SESSIONS_KEY = 'widget-agent-sessions'
/** 当前对话实时总结标题存储键 */
const TITLE_KEY = 'widget-agent-title'
/** 心理揣测存储键(最近一次回复的心理;重启保留,文字区不落空) */
const MIND_KEY = 'widget-agent-mind'
/** 历史会话数量上限(超出丢弃最旧) */
const MAX_SESSIONS = 20

/** 新会话 ID(2026-08-12,工具输出按对话 ID 分类存放:引擎侧
 * <输出根>/<工具>/<会话ID> 目录由它拼接)。时间戳 + 随机后缀防
 * 同一毫秒多次 clear 撞同一 id(存档会话 id 沿用旧格式 s-<时间戳>,
 * 仅当前会话用本函数生成) */
function newSessionId(): string {
  return `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 历史会话坏标题判定(2026-08-12 用户实测"历史记录标题有问题"):
 * 旧版标题总结(修复前)存档的标题常是**摘抄回复句的截断残句**(如
 * "嘞,主人看完课要补个合集是吧,我这就把《"、"哈哈,看来TTG全员都在
 * 「赚钱买小胖」,")或**单字垃圾**(如"你")——历史存档不会自动重生成。
 * 判定特征与引擎 looksLikeSentenceTitle / looksLikeIncompleteMind 同款
 * (渲染端不 import 引擎运行时,内联):
 * 空 / <4 码元 / >6 码元含完成体"了"、句尾"的"、疑问词 /
 * 逗号顿号冒号结尾(半句) / 连词或"把/就"收尾 / 书名号引号残缺结尾 = 坏
 */
function isBadSessionTitle(title: string): boolean {
  const t = (title ?? '').trim()
  if (!t) return true
  const len = Array.from(t).length
  if (len < 4) return true
  // 疑问词与引擎 looksLikeSentenceTitle 同款(2026-08-12 四轮:漏口语
  // 疑问词"干啥"导致"哈喽主人～看我干啥呀?…"判不坏,修复 effect 跳过)
  if (
    len > 6 &&
    (/了/.test(t) ||
      /.+的$/.test(t) ||
      /(吗|呢|有没有|能不能|怎么|怎样|如何|为什么|啥|干嘛|干啥|谁|哪里|哪儿|是不是|会不会|要不要|好不好)/.test(t))
  ) {
    return true
  }
  // 残句:逗号/顿号/冒号结尾 = 半句;连词/把/就收尾 = 没说完;
  // 书名号/引号残缺结尾(如"我这就把《")= 截断残片
  if (/[,，、;；:：]$/.test(t)) return true
  if (/(你那|就是|因为|但是|然后|所以|还有|这边|之后|接着|反正|把|就)$/.test(t)) return true
  if (/[《「【"']$/.test(t)) return true
  return false
}

/**
 * 历史会话兜底标题(2026-08-12):重总结失败/结果仍坏时的本地确定性
 * 兜底——取首条用户消息文本,截 20 码元(与引擎 fallbackTitle 同语义;
 * 首条用户消息通常是短句,比坏标题可读)。标题必非空(会话必有消息)
 */
function fallbackSessionTitle(session: AgentSession): string {
  for (const m of session.messages) {
    if (m.role !== 'user') continue
    const text = m.parts
      .filter((p): p is Extract<AgentPart, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
      .join(' ')
    // 跳过过短消息(与引擎 fallbackTitle 同款:首条"你?"这类短句
    // 得到单字垃圾标题,取第一条 ≥4 码元的实质内容)
    if (text.trim() && Array.from(text).length >= 4) {
      // 与引擎 sanitizeTitle 同款终止标点截断:取第一个。！？～前的
      // 完整段(≥4 码元),避免长句 20 码元硬截的残句观感
      const seg = text.split(/[。！？!?…～~]/)[0].trim()
      return truncateCodepoints(seg.length >= 4 ? seg : text, 20)
    }
  }
  return '对话'
}

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
  /** 心理揣测(独立 Sub Agent 每轮回复后静默更新;紧凑态文字区优先展示) */
  mindGuess: string | null
  /** 发送一轮对话。opts.silent = 系统提示静默模式(不进渲染端历史,
   * 仅作引擎本轮输入——background-done 等系统通知用) */
  send(text: string, opts?: { silent?: boolean }): void
  abort(): void
  /** exec_command 确认门:回传用户选择(引擎在等待 tool-confirm-request) */
  confirmTool(approved: boolean): void
  /** 待确认的请求(引擎等待用户允许/拒绝;exec_command 带 command,
   * bili 批量下载等带 title/detail;null = 无) */
  pendingConfirm: { command: string; title?: string; detail?: string } | null
  clear(): void
  loadSession(id: string): void
  deleteSession(id: string): void
  saveConfig(patch: Partial<AgentConfig>): Promise<void>
  /** 重新拉取配置(LLM 自我配置后设置界面需刷新) */
  refreshConfig(): void
  /** 本会话流式落定且未自动播放过的消息 id(2026-08-10:媒体自动播放
   * 只限"当次对话";引用稳定,渲染时读 has) */
  mediaAutoPlayIds: ReadonlySet<string>
  /** 消费自动播放标记(消息首条媒体已自动播放过) */
  consumeMediaAutoPlay(id: string): void
}

export function useAgent(opts?: { allowProactive?: boolean }): AgentController {
  const [messages, setMessages] = useState<AgentMessage[]>(loadHistory)
  const [status, setStatus] = useState<AgentStatus>('idle')
  const [streaming, setStreaming] = useState<PendingAssistant | null>(null)
  const [lastError, setLastError] = useState<string | null>(null)
  // 确认门:引擎发 tool-confirm-request 等待用户选择(exec_command 确认
  // 带 command;bili 批量下载等动作确认带 title/detail,2026-08-10)
  const [pendingConfirm, setPendingConfirm] = useState<{
    command: string
    title?: string
    detail?: string
  } | null>(null)
  const [config, setConfig] = useState<AgentConfig | null>(null)
  // 历史会话列表(新对话时自动存档当前对话)
  const [sessions, setSessions] = useState<AgentSession[]>(loadSessions)
  // 工具清单(引擎 → 主进程 IPC,UI 展示用)
  const [tools, setTools] = useState<AgentToolInfo[]>([])
  const toolsRef = useRef(tools)
  toolsRef.current = tools
  // 当前对话实时总结标题(每轮回复完成后静默总结;入历史时作为标题)
  const [currentTitle, setCurrentTitle] = useState<string | null>(() => {
    try {
      return localStorage.getItem(TITLE_KEY)
    } catch {
      return null
    }
  })
  // 当前回复的心理揣测(独立 Sub Agent 每轮回复完成后静默生成;
  // 紧凑态文字区优先展示)
  const [mindGuess, setMindGuess] = useState<string | null>(() => {
    try {
      return localStorage.getItem(MIND_KEY)
    } catch {
      return null
    }
  })
  // 会话版本号:仅在 clear/loadSession(会话真正切换)时递增;
  // 后台标签(总结标题/心理揣测)完成时校验,旧会话的结果不覆盖新会话。
  // 注意:send 不递增——连续对话时每轮总结基于最新消息,旧总结结果
  // 主题一致仍有效,递增会把总结全部作废(文字区永远等不到标题)
  const sessionVersionRef = useRef(0)
  // 2026-08-10 自动播放标记:本会话**流式落定**且尚未自动播放过的助手
  // 消息 id——LLM 播放视频/音频只在"当次对话"(本轮落定)自动播放一次;
  // 历史会话加载/重挂载(收起再展开)读到已消费 → 不再自动播放
  const mediaAutoPlayRef = useRef(new Set<string>())
  // 加载历史后跳过下一次后台标签生成(历史已有标题/心理,无需重新生成)
  const skipNextLabelRef = useRef(false)
  // 主动陪伴(2026-08-07):上次"有操作"时刻(用户发送/清空/切换会话/
  // 主动回复落定都会重置)——调度器据此判断"无操作满 N 分钟"
  const lastUserSendRef = useRef(Date.now())
  // 当前会话 ID(2026-08-12,工具输出按对话 ID 分类存放):send /
  // proactive-tick 回传引擎,引擎据此拼输出目录(<根>/<工具>/<会话ID>)。
  // 初始化生成;clear(新对话)重新生成;loadSession 沿用历史会话 id
  // (加载的对话还是那个对话,输出归入原文件夹)
  const sessionIdRef = useRef(newSessionId())
  // 主动陪伴 tick in-flight 守卫(覆盖 judge 全程:IPC 在 judge 完成后
  // 才 resolve,期间不重发;judge 阶段用户 send 天然优先)
  const proactiveInFlightRef = useRef(false)

  // 订阅/发送需要引用最新的 messages(事件回调里不要依赖闭包里的 state)
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const currentTitleRef = useRef(currentTitle)
  currentTitleRef.current = currentTitle
  const statusRef = useRef(status)
  statusRef.current = status
  // 流式状态镜像 + rAF 合批:高频增量事件(text/reasoning/tool)直写镜像,
  // requestAnimationFrame 帧内一次性 setStreaming 提交——渲染/解析/测量
  // 频率压到帧率上限(跨 IPC 消息的多次 setState 不自动批处理)
  const streamingRef = useRef<PendingAssistant>({ text: '', reasoning: '', tools: [] })
  const streamingRafRef = useRef(0)
  // 流式提交 50ms 降频(2026-08-11 性能):rAF 合批在 165Hz 显示器上
  // 每帧提交一次——流式增量(文本/推理/工具参数)逐帧到达,渲染频率
  // 被帧率拉满,每帧都做全量 Markdown 重解析 + 测量 + reconcile。
  // 50ms 最小间隔压到 ~20Hz:LLM 生成速度远低于此,视觉无差,主线程
  // 工作减 ~3/4——视频播放/工具调用叠加时掉帧明显缓解
  const STREAM_COMMIT_MIN_MS = 50
  const lastStreamCommitRef = useRef(0)
  const streamCommitTimerRef = useRef(0)
  const resetStreaming = useCallback(() => {
    if (streamingRafRef.current) cancelAnimationFrame(streamingRafRef.current)
    streamingRafRef.current = 0
    window.clearTimeout(streamCommitTimerRef.current)
    streamCommitTimerRef.current = 0
    lastStreamCommitRef.current = 0
    streamingRef.current = { text: '', reasoning: '', tools: [] }
    setStreaming(null)
  }, [])
  const scheduleStreamingCommit = useCallback(() => {
    if (streamingRafRef.current || streamCommitTimerRef.current) return
    const now = performance.now()
    const wait = lastStreamCommitRef.current + STREAM_COMMIT_MIN_MS - now
    const commit = () => {
      streamingRafRef.current = requestAnimationFrame(() => {
        streamingRafRef.current = 0
        setStreaming({ ...streamingRef.current })
      })
    }
    if (wait <= 0) {
      lastStreamCommitRef.current = now
      commit()
    } else {
      streamCommitTimerRef.current = window.setTimeout(() => {
        streamCommitTimerRef.current = 0
        lastStreamCommitRef.current = performance.now()
        commit()
      }, wait)
    }
  }, [])
  // 工具镜像 upsert(新数组引用:提交后 React.memo 才能识别变化)。
  // 已存在条目**合并**(tool-result 只带 ok/result/durationMs,保留
  // 之前 tool-call 累积的 args/argsRaw;tool-call 的 name/args 覆盖旧值)
  const upsertTool = useCallback(
    (tool: Partial<AgentToolCallState> & { id: string; name: string }) => {
      const list = streamingRef.current.tools
      const idx = list.findIndex((t) => t.id === tool.id)
      streamingRef.current = {
        ...streamingRef.current,
        tools:
          idx === -1
            ? [...list, { ...tool, args: tool.args ?? {} }]
            : [...list.slice(0, idx), { ...list[idx], ...tool }, ...list.slice(idx + 1)],
      }
      scheduleStreamingCommit()
    },
    [scheduleStreamingCommit],
  )

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
          // 中止竞态:abort 后迟到的流式事件(status 已 idle)丢弃,
          // 防幽灵流式文本残留(parseSse 缓冲帧在 abort 后仍可能 yield 一次)
          if (statusRef.current === 'idle') break
          streamingRef.current.text += event.text
          scheduleStreamingCommit()
          break
        case 'reasoning-delta':
          if (statusRef.current === 'idle') break
          streamingRef.current.reasoning += event.text
          scheduleStreamingCommit()
          break
        case 'tool-partial-call':
        case 'tool-call':
          upsertTool({ id: event.id, name: event.name, args: parseArgs(event.args), argsRaw: event.args })
          break
        case 'tool-result':
          upsertTool({
            id: event.id,
            name: event.name,
            ok: event.ok,
            result: event.result,
            durationMs: event.durationMs,
          })
          break
        case 'message': {
          // 权威落定:以引擎回传的 parts 替换流式累积(附 token 用量);
          // 静默总结由下方 effect 在 status idle 后统一触发
          resetStreaming()
          // 2026-08-10 自动播放:落定的消息 id 入"可自动播放"集合——
          // 本轮渲染时首条媒体附件自动播放;消费后移除(见 consumeMediaAutoPlay)
          mediaAutoPlayRef.current.add(event.message.id)
          setMessages((prev) => [...prev, { ...event.message, usage: event.usage }])
          setLastError(null)
          // 主动陪伴:主动回复落定 = 一次"有操作"(重置 idle 时钟——
          // 否则每分钟重发 tick、judge 连续 yes → 每 N 分钟一条主动
          // 回复不断循环;judge 判 no 兜底不可依赖,关键坑)
          if (event.message.proactive) lastUserSendRef.current = Date.now()
          break
        }
        case 'error':
          resetStreaming()
          setLastError(event.message)
          setStatus('idle')
          break
        case 'tool-confirm-request':
          setPendingConfirm({ command: event.command, title: event.title, detail: event.detail })
          break
        case 'background-done': {
          // 后台长任务完成(如 bili 下载):自动触发一轮对话——LLM 基于
          // 系统提示的状态块主动告知用户结果,无需用户主动提问
          // (实测:下载完成后用户不提问就不知道结果)。
          // 复用 send 的 silent 模式(2026-08-08 用户要求):系统提示
          // 不作为用户消息气泡出现在对话窗口(通知由主进程 Windows
          // 通知展示),LLM 回复照常落定。
          // **busy 时入队(2026-08-13 用户实测"下载太快,上个消息没回完,
          // 完成通知被吞")**:原实现 busy 直接忽略——下载在回复中途完成
          // 时通知永久丢失(在途回合的状态块是旧快照,不会提及)。
          // 与 NapCat 消息同款排队:status idle 后逐条补发
          const text = `【系统通知】${event.title}:${event.message}。请根据当前任务状态,用一两句话主动告知用户结果。`
          if (statusRef.current === 'thinking' || statusRef.current === 'running') {
            silentQueueRef.current.push(text)
            break
          }
          send(text, { silent: true })
          break
        }
        case 'mind-proactive': {
          // 主动陪伴:主进程对主动回复的心理揣测(与 Windows 系统通知
          // 同一句)——更新紧凑态文字区,两处一致。messageId 校验:
          // clear/loadSession 后迟到的旧揣测丢弃(不污染新会话)
          const { messageId, guess } = event
          if (!guess) break
          if (!messagesRef.current.some((m) => m.id === messageId)) break
          setMindGuess(guess)
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
  // 历史会话坏标题自动修复(2026-08-12 用户实测"历史记录标题有问题"):
  // 旧版存档的坏标题(摘抄句截断残片/单字垃圾)加载时检测,异步重总结
  // 并更新存储——**只对坏标题调 LLM**(好标题不碰,"历史消息不该被重新
  // 总结"的既有设计不变);fixingRef 守卫防并发重总结;sessions 更新后
  // 好标题跳过,effect 收敛不循环
  const fixingSessionsRef = useRef(new Set<string>())
  useEffect(() => {
    if (!window.desktop?.agentSummarize) return
    let cancelled = false
    const fix = async () => {
      for (const s of sessions) {
        if (cancelled) return
        if (!isBadSessionTitle(s.title)) continue
        if (fixingSessionsRef.current.has(s.id)) continue
        fixingSessionsRef.current.add(s.id)
        try {
          const t = await window.desktop?.agentSummarize(s.messages)
          if (cancelled) return
          // 重总结结果仍坏(引擎判效漏网等)→ 本地兜底 = 首条用户消息
          // (确定性,保证标题可读且收敛,不反复重试)
          let title = truncateCodepoints(t ?? '', 20)
          if (isBadSessionTitle(title)) {
            title = fallbackSessionTitle(s)
          }
          setSessions((prev) => prev.map((x) => (x.id === s.id ? { ...x, title } : x)))
        } catch {
          // 重总结失败(超时等)→ 本地兜底标题(不保留坏标题等下次)
          const title = fallbackSessionTitle(s)
          if (title) {
            setSessions((prev) => prev.map((x) => (x.id === s.id ? { ...x, title } : x)))
          }
        } finally {
          fixingSessionsRef.current.delete(s.id)
        }
      }
    }
    void fix()
    return () => {
      cancelled = true
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
  // 心理揣测持久化(重启保留最近一次回复的心理,文字区不落空)
  useEffect(() => {
    try {
      if (mindGuess) localStorage.setItem(MIND_KEY, mindGuess)
      else localStorage.removeItem(MIND_KEY)
    } catch {
      // 存储失败忽略
    }
  }, [mindGuess])
  // 卸载时取消未提交的流式合批帧(避免卸载后 setState)
  useEffect(
    () => () => {
      if (streamingRafRef.current) cancelAnimationFrame(streamingRafRef.current)
      window.clearTimeout(streamCommitTimerRef.current)
    },
    [],
  )
  // 后台标签 Sub Agent 调用器(总结标题 / 心理揣测共用),行为语义:
  // - 入口守卫:进行中不并发,新一轮回复落定(进行中)只标记 pending,
  //   完成后补跑最新一轮(追平连续对话——跳过会让标签永远等不到,
  //   是"文字区一直显示回复开头"的常见原因);
  // - 结果带会话版本校验(clear/loadSession 作废),旧快照结果主题一致
  //   直接生效(总比空好,新结果后覆盖);
  // - 失败重试:1.5s 后重试同一快照(retryLeft 预算递减);
  //   预算耗尽 → 10s 后补跑一次**最新**消息(仅此一次,不连锁重试)—
  //   会话静止时标签也能补上,文字区不会一直停留在回复开头预览。
  // 每个标签独立 in-flight/排队状态(互不阻塞)
  const createLabelRunner = useCallback(
    (
      task: (snapshot: AgentMessage[]) => Promise<string>,
      apply: (value: string) => void,
      maxLen: number,
    ): ((snapshot: AgentMessage[]) => void) => {
      const st = { inflight: false, pending: false }
      const run = (snapshot: AgentMessage[], retryLeft = 1) => {
        if (st.inflight) return
        st.inflight = true
        const version = sessionVersionRef.current
        // 标签落定后追平:期间新一轮回复落定(pending)→ 补跑最新一轮
        const catchUp = () => {
          if (!st.pending) return
          st.pending = false
          if (statusRef.current === 'idle' && messagesRef.current.length > 0) {
            run(messagesRef.current, 0)
          }
        }
        task(snapshot)
          .then((value) => {
            st.inflight = false
            // 双保险:引擎已清洗并截断到岛体文字区容量,这里再按码元
            // 兜底(标签过长在紧凑态会被截成"开头几字",观感等同失败)
            // 上限按标签类型:标题 20(2026-08-07 放宽:推荐 10 字左右
            // 严格不超过 20)/ 心理揣测 16(15 字左右最多 16)
            const v = truncateCodepoints(value, maxLen)
            if (v && sessionVersionRef.current === version) apply(v)
            catchUp()
          })
          .catch(() => {
            st.inflight = false
            if (retryLeft > 0) {
              // 网络抖动:1.5s 后重试同一快照;期间新消息落定(排队中)
              // 则改补跑最新一轮,不再重试陈旧快照
              window.setTimeout(() => {
                if (st.pending) {
                  st.pending = false
                  if (statusRef.current === 'idle' && messagesRef.current.length > 0) {
                    run(messagesRef.current, 0)
                  }
                } else {
                  run(snapshot, retryLeft - 1)
                }
              }, 1500)
            } else {
              // 全部重试都失败:延迟补跑一次最新消息(仅此一次,
              // 不再走重试链——避免对同一对话无限循环请求)
              window.setTimeout(() => {
                if (st.inflight) return
                if (statusRef.current !== 'idle' || messagesRef.current.length === 0) return
                if (st.pending) st.pending = false
                st.inflight = true
                const latest = messagesRef.current
                const v = sessionVersionRef.current
                task(latest)
                  .then((value) => {
                    st.inflight = false
                    // 兜底同主路径(maxLen 按标签类型:标题 20 / 揣测 16)
                    const t = truncateCodepoints(value, maxLen)
                    if (t && sessionVersionRef.current === v) apply(t)
                  })
                  .catch(() => {
                    st.inflight = false
                    // 补跑失败不再重试
                  })
              }, 10000)
            }
          })
      }
      // 触发入口:进行中 → 标记排队(完成时由 catchUp 追平),否则立即执行
      return (snapshot) => {
        if (st.inflight) {
          st.pending = true
          return
        }
        run(snapshot)
      }
    },
    [],
  )
  // 总结标题 runner(每轮回复完成后静默生成;入历史作会话标题)
  const summaryRunner = useMemo(
    () =>
      createLabelRunner(
        (snapshot) => window.desktop?.agentSummarize?.(snapshot) ?? Promise.resolve(''),
        (t) => setCurrentTitle(t),
        // 标题上限 20 码元(2026-08-07 用户要求放宽:推荐 10 字左右,
        // 严格不超过 20;紧凑态文字区随字数扩展岛宽)
        20,
      ),
    [createLabelRunner],
  )
  // 心理揣测 runner(独立 Sub Agent,每轮回复完成后静默生成;
  // 紧凑态文字区优先展示)
  const mindRunner = useMemo(
    () =>
      createLabelRunner(
        (snapshot) => window.desktop?.agentMindGuess?.(snapshot) ?? Promise.resolve(''),
        (g) => setMindGuess(g),
        // 心理揣测上限 16 码元(15 字左右最多 16)
        16,
      ),
    [createLabelRunner],
  )

  useEffect(() => {
    if (status !== 'idle' || messages.length === 0) return
    if (skipNextLabelRef.current) {
      skipNextLabelRef.current = false
      // 只跳过总结标题(加载的历史会话已有标题语义,避免重复 LLM 调用);
      // **心理揣测照跑**(Bug 修复 2026-08-07):loadSession 清了 mindGuess
      // 又跳过生成 → 紧凑态文字区回退到"最后回复预览"(LLM 回复开头
      // 几个字),用户实测反馈;重新生成揣测后文字区恢复揣测优先
      mindRunner(messages)
      return
    }
    // 主动消息跳过心理揣测 runner:揣测由主进程统一提供(主动回合落定
    // 后 getMindAgent 跑一次 → 系统通知 + mind-proactive 事件 → 这里
    // setMindGuess,与通知同一句)——再跑 mindRunner 会重复调用 LLM 且
    // 两处措辞不一致;标题照常跟随(主动回复是真实内容)
    if (messages[messages.length - 1]?.proactive) {
      summaryRunner(messages)
      return
    }
    // 两个后台标签 runner 各自守卫并发(进行中 → 内部标记排队,完成追平)
    summaryRunner(messages)
    mindRunner(messages)
  }, [messages, status, summaryRunner, mindRunner])

  /**
   * 拉取配置与工具清单(主进程),挂载与"打开设置视图前刷新"共用。
   * 场景:LLM 对话中 mcp_config/skills_config 工具改了配置(写 settings.json)
   * 或创建了技能(写技能目录)——而 config/tools 都只在挂载时读一次 →
   * 设置界面显示旧快照(实测 bug:对话里添加的 MCP 服务设置里为空;
   * LLM 创建的技能不出现在设置技能列表)。打开 Agent 设置视图时调用;
   * tools 刷新 = agentGetTools(listAllTools 实时扫描,新技能立即可见)
   */
  const loadConfigAndTools = useCallback(() => {
    window.desktop?.agentGetConfig?.().then(setConfig).catch(() => {})
    window.desktop
      ?.agentGetTools?.()
      .then((list) => setTools(list))
      .catch(() => {})
  }, [])

  // 启动时读取配置(API Key / 模型等,主进程 settings.json)与工具清单
  useEffect(() => {
    loadConfigAndTools()
    // **外部工具缺失自动重拉(2026-08-10 修复"输入框 @ 不显示 MCP 服务")**:
    // agentGetTools(listAllTools)对 MCP 服务是逐个连接,握手慢的服务
    // (如 npx 首次下载 siyuan-mcp 需数秒)在挂载时可能还没就绪,工具
    // 清单里就缺了 MCP 工具 → @ 候选永远为空(引擎对话循环每轮都刷新,
    // 所以"对话里能用 @ 但候选不显示"这类不一致)。挂载后若清单里
    // 没有任何外部工具(mcp_/skill_),延迟 3s 重拉一次(至多 2 次,
    // 命中即停)
    let retries = 2
    const timer = window.setInterval(() => {
      if (retries <= 0) {
        window.clearInterval(timer)
        return
      }
      const list = toolsRef.current
      const hasExternal = list.some((t) => t.name.startsWith('mcp_') || t.name.startsWith('skill_'))
      if (hasExternal) {
        window.clearInterval(timer)
        return
      }
      retries -= 1
      window.desktop?.agentGetTools?.().then((list2) => setTools(list2)).catch(() => {})
    }, 3000)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 挂载时一次性
  }, [loadConfigAndTools])

  // 主动陪伴调度器(2026-08-07):每 60s 检查触发条件——① Agent 模式
  // (WidgetApp 经 allowProactive 传入)② 配置开启 ③ status idle ④ 有
  // 对话历史 ⑤ 距上次"有操作"(发送/清空/切换会话/主动回复落定)≥ N
  // 分钟 ⑥ 非 in-flight。满足则发 tick(带完整历史与空闲分钟数)→
  // 主进程:总结 Sub Agent 判断语境 → should 则主 Agent 完整回合主动
  // 回复(思考/流式/工具照常,消息正常落定)。judge-no 回退 idle 时钟
  // (下次判断在 N 分钟后——不静默变每分钟一次 LLM 判断调用,1440 次/
  // 天);busy/mode/disabled 各自自愈(用户操作已重置时钟 / 模式切换
  // 停 effect / 配置变更重装 effect),不回退
  useEffect(() => {
    if (!window.desktop?.agentProactiveTick || !opts?.allowProactive) return
    if (!config?.proactiveEnabled) return
    // 间隔 = 数值 × 单位换算(2026-08-07 单位选择:s=秒 / m=分钟 / h=小时)
    const unitSecs =
      config.proactiveIntervalUnit === 's' ? 1 : config.proactiveIntervalUnit === 'h' ? 3600 : 60
    const intervalMs = Math.max(1, config.proactiveInterval ?? 15) * unitSecs * 1000
    const timer = window.setInterval(() => {
      if (proactiveInFlightRef.current) return
      if (statusRef.current !== 'idle') return
      if (messagesRef.current.length === 0) return
      const idleMs = Date.now() - lastUserSendRef.current
      if (idleMs < intervalMs) return
      proactiveInFlightRef.current = true
      const snapshot = messagesRef.current
      window.desktop
        ?.agentProactiveTick?.(snapshot, Math.floor(idleMs / 60_000), sessionIdRef.current)
        .then((r) => {
          if (r?.reason === 'judge-no') lastUserSendRef.current = Date.now()
        })
        .catch(() => {})
        .finally(() => {
          proactiveInFlightRef.current = false
        })
    }, 60_000)
    return () => window.clearInterval(timer)
  }, [config?.proactiveEnabled, config?.proactiveInterval, config?.proactiveIntervalUnit, opts?.allowProactive])

  const send = useCallback(
    (text: string, opts?: { silent?: boolean; source?: 'qq' | 'group' | 'ask'; target?: string; media?: string[]; profileCard?: string }) => {
    const trimmed = text.trim()
    if (!trimmed) return
    if (statusRef.current === 'thinking' || statusRef.current === 'running') return
    // 主动陪伴:任何一轮对话 = 有操作(重置 idle 时钟,含 background-done
    // 的系统通知自动轮——有对话在发生就不该主动打扰)
    lastUserSendRef.current = Date.now()
    const prev = messagesRef.current
    const last = prev[prev.length - 1]
    // 上一轮被中止/失败(未落定助手消息,历史以 user 消息结尾):该轮
    // 请求未得到答复,保留只会被 LLM 当"仍待执行"重复执行(上下文污染,
    // 实测:switch_to_music 被重复调用,导致"打开B站"时又被自动切回
    // 音乐模式)。**新输入替换该未完成消息、独立成条**(2026-08-08 用户
    // 要求:原合并实现把新输入并进旧消息,旧请求内容已过时还占上下文;
    // 替换后 LLM 只答复新请求,历史干净)
    const base = last && last.role === 'user' ? prev.slice(0, -1) : prev
    // **历史指令段剥离(2026-08-12 用户实测"主人账号发消息被当外人"
    // 根因)**:main.cjs 注入的【回复规则】/【群聊上下文】/旧式
    // 【私聊指令】【群聊指令】【主人消息】段只对该轮生效——历史消息
    // 的指令段若不剥离,LLM 每轮都读到旧指令(陌生人链路的「先问
    // 主人/按指示回他」),新消息(如主人发来)被误沿用旧语境。
    // **【档案卡】保留(2026-08-13 用户澄清"档案卡与消息分类是给历史
    // 消息隔离的")**:历史里每条 QQ 消息都带着说话人的档案卡,LLM
    // 跨轮次正确区分人——用 stripNapcatHistoryInstructions(与显示层
    // 的 stripNapcatInstructions 区别仅在此);当前轮消息的注入指令
    // 保留(本轮要听)
    const history = base.map((m) => {
      if (m.role === 'user' && (m.source === 'qq' || m.source === 'group' || m.source === 'ask')) {
        return {
          ...m,
          parts: m.parts.map((p) => (p.type === 'text' ? { ...p, text: stripNapcatHistoryInstructions(p.text) } : p)),
        }
      }
      return m
    })
    // 注意:不递增会话版本(连续对话时总结基于最新消息,旧结果主题一致
    // 仍有效;递增会把每轮总结都作废,标题永远等不到)
    // **图片附件(2026-08-12 收图链路)**:opts.media = 本地图片路径列表
    // (main.cjs 下载的 QQ/群消息图片)→ 用户消息 parts 追加 media part,
    // 对话窗口展示图片(引擎 historyToItems 只序列化 text part,LLM 侧
    // 经文本标注【图片已下载】知晓路径)
    const mediaParts = (opts?.media ?? [])
      .filter((p) => typeof p === 'string' && p.trim())
      .map((p, i) => ({ type: 'media' as const, kind: 'img' as const, url: p, name: `QQ图片${i + 1}` }))
    const userMessage: AgentMessage = {
      id: `u-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'user',
      parts: [{ type: 'text', text: trimmed }, ...mediaParts],
      // NapCat 来源标记(2026-08-12):QQ 私聊('qq',target = QQ 号)/
      // 群聊('group',target = 群号)/ 询问轮('ask',target = 陌生人 QQ,
      // 2026-08-13 起保留字段以显示私聊类别头;回复路由走主进程
      // lastAskTurn,与此字段无关)。档案卡(2026-08-13)随消息展示
      source:
        opts?.source === 'qq' || opts?.source === 'group' || opts?.source === 'ask' ? opts.source : undefined,
      qq: opts?.target,
      profileCard: opts?.profileCard,
    }
    const next = [...history, userMessage]
    if (opts?.silent) {
      // 静默模式(2026-08-08 用户要求:background-done 等系统提示不作为
      // 用户气泡):**不落渲染端历史**(对话窗口不出现"【系统通知】…"
      // 气泡,通知由主进程 Windows 通知展示),仅作为本轮输入进引擎
      // 历史——LLM 据此回复,回复照常落定
      messagesRef.current = prev
      setLastError(null)
      // 引擎无状态:回传完整历史(末尾 = 系统通知,引擎不再追加);
      // 带会话 ID;**source='system'(2026-08-13 泄露修复)**:系统轮回复
      // 永不路由到 QQ(此前被 pendingQQReply 当主人指示发给了陌生人)
      window.desktop?.agentSend?.(trimmed, next, sessionIdRef.current, 'system', undefined)
      return
    }
    // 同步更新引用:连续 send 之间(React 尚未渲染)也能拿到最新历史,
    // 避免第二次 send 基于旧消息覆盖第一次(最新一轮用户消息消失)
    messagesRef.current = next
    setMessages(next)
    setLastError(null)
    // 引擎无状态:回传完整历史(含刚加入的用户消息);带会话 ID 与
    // 来源标记(2026-08-13 泄露修复,三分类):
    // - 'qq'/'group'/'ask' = QQ 触发(回复路由见 main.cjs);
    // - 'window' = 主人在对话窗口直接输入(唯一可消费陌生人 pending
    //   的窗口轮);
    // - 'system' = 系统通知轮(background-done 等,永不路由 QQ)
    const routed = opts?.source === 'qq' || opts?.source === 'group' || opts?.source === 'ask' ? opts.source : undefined
    window.desktop?.agentSend?.(
      trimmed,
      next,
      sessionIdRef.current,
      routed ?? 'window',
      routed ? opts?.target : undefined,
    )
  },
    [],
  )

  // NapCat 消息(2026-08-12):主进程收到 QQ 私聊(napcat:message)/ 群
  // 接话(napcat:group-message)→ 作为用户消息 send(显示在对话窗口,
  // 同步上下文)。busy 时排队(按到达顺序,status idle 后逐条发送)。
  // **来源分级(2026-08-12 二轮,用户要求"偏袒我这一方")**:
  // - 白名单 QQ(trusted: true)= 自主回复链路——send 带 source='qq',
  //   回复落定自动发回(带上下文与长期记忆);
  // - 陌生人(trusted: false)= 主进程已把文本注入"【QQ xxx 发来消息,
  //   先问主人】"前缀,本侧**不带 source**——LLM 先询问主人,主人
  //   指示后的回复由主进程 pendingQQReply 链路发回;
  // - 群接话 = 带 source='group'(回复发回群)
  const napcatQueueRef = useRef<Array<{ text: string; source?: 'qq' | 'group' | 'ask'; target?: string; media?: string[]; profileCard?: string }>>([])
  // 系统通知队列(2026-08-13:background-done busy 时入队,idle 后逐条
  // 补发——防"下载太快通知被吞")
  const silentQueueRef = useRef<string[]>([])
  useEffect(() => {
    const offs: Array<() => void> = []
    const push = (
      text: string,
      source: 'qq' | 'group' | 'ask' | undefined,
      target: string | undefined,
      media?: string[],
      profileCard?: string,
    ) => {
      if (!text.trim()) return
      if (statusRef.current === 'thinking' || statusRef.current === 'running') {
        napcatQueueRef.current.push({ text, source, target, media, profileCard })
        return
      }
      send(text, source && target ? { source, target, media, profileCard } : { media, profileCard })
    }
    const off1 = window.desktop?.onNapcatMessage?.((msg) => {
      if (!msg || typeof msg.text !== 'string') return
      // trusted: true = 白名单(自主回复,带 source='qq');
      // false = 陌生人(带 source='ask'——2026-08-12 询问同步:该轮回复
      // 是"询问主人怎么回复",main.cjs 把它发到主人 QQ,同时对话窗口
      // 显示;主人指示后(QQ 或对话窗口)回复发回陌生人)
      // media(2026-08-12 收图):消息图片本地路径 → 对话展示;
      // profileCard(2026-08-13):发送者档案卡 → 气泡头部分层展示
      push(msg.text, msg.trusted === false ? 'ask' : 'qq', msg.qq, msg.media, msg.profileCard)
    })
    if (typeof off1 === 'function') offs.push(off1)
    const off2 = window.desktop?.onNapcatGroupMessage?.((msg) => {
      if (msg && typeof msg.text === 'string') push(msg.text, 'group', msg.groupId, msg.media, msg.profileCard)
    })
    if (typeof off2 === 'function') offs.push(off2)
    return () => {
      for (const off of offs) off()
    }
  }, [send])
  // busy 结束(idle)后处理排队的 NapCat 消息与系统通知(bili 完成等;
  // 2026-08-13:后台任务完成通知 busy 时入队,idle 后逐条补发,不再被吞)。
  // 每条 send 会重新进入 busy → 下一轮 idle 再取下一条,天然串行
  useEffect(() => {
    if (status !== 'idle') return
    const napcat = napcatQueueRef.current.shift()
    if (napcat) {
      send(napcat.text, napcat.source && napcat.target ? { source: napcat.source, target: napcat.target, media: napcat.media, profileCard: napcat.profileCard } : { media: napcat.media, profileCard: napcat.profileCard })
      return
    }
    const silent = silentQueueRef.current.shift()
    if (silent) {
      send(silent, { silent: true })
    }
  }, [status, send])

  const confirmTool = useCallback((approved: boolean) => {
    window.desktop?.agentConfirmTool?.(approved)
    setPendingConfirm(null)
  }, [])
  // 轮次结束(status idle)时清掉残留确认请求(用户未答时引擎 120s
  // 超时拒绝并继续,这里兜底 UI 状态)
  useEffect(() => {
    if (status === 'idle') setPendingConfirm(null)
  }, [status])

  const abort = useCallback(() => {
    window.desktop?.agentAbort?.()
    // 丢弃未落定的流式消息(引擎中止后不会再发 message 事件;
    // 镜像同步清空 + 取消未提交的合批帧)
    resetStreaming()
  }, [resetStreaming])

  const clear = useCallback(() => {
    // **中止正在运行的回合(2026-08-11 修复"新对话后对话窗口仍 16:9")**:
    // 新对话不清除会让引擎继续流式——① 迟到的回复落进新对话(孤儿消息,
    // 用户没问新问题窗口却撑回 16:9);② status 停在 thinking 时思考占位
    // 行让空对话测高 > 面板下限,高度公式误判"有内容"直接按宽度 9/16
    // 封顶——新对话永远等不到扁平窗口(用户实测)。abort 同步复位引擎
    // running(引擎经 abort 事件回 status idle),setStatus('idle') 让
    // 渲染端立即进入空闲,迟到的流式事件被 statusRef 守卫丢弃
    abort()
    setStatus('idle')
    // 新对话:当前对话(非空)存档到历史,再清空。
    // 标题用实时总结(每轮回复后已静默更新,无需再次调用 LLM)
    sessionVersionRef.current += 1
    // 新对话 = 新会话 ID(此后工具输出落到新对话文件夹)
    sessionIdRef.current = newSessionId()
    // 自动播放标记随会话清空(历史/新会话不自动播)
    mediaAutoPlayRef.current.clear()
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
    resetStreaming()
    setLastError(null)
    setCurrentTitle(null)
    setMindGuess(null)
    // 主动陪伴:切换会话 = 有操作(新会话从零计时)
    lastUserSendRef.current = Date.now()
  }, [abort, resetStreaming])

  const loadSession = useCallback((id: string) => {
    const target = sessionsRef.current.find((s) => s.id === id)
    if (!target) return
    // 加载 = 替换当前对话;从历史移除(当前会话继续由 HISTORY_KEY 持久化);
    // 标题/心理重置并跳过下一次自动生成(历史消息不该被重新总结)
    sessionVersionRef.current += 1
    // 加载历史会话 = 沿用其原 id(对话还是那个对话,工具输出归入
    // 原对话文件夹;2026-08-12)
    sessionIdRef.current = target.id
    // 自动播放标记随会话切换清空(加载的历史消息不自动播放)
    mediaAutoPlayRef.current.clear()
    skipNextLabelRef.current = true
    setMessages(target.messages)
    setSessions((prev) => prev.filter((s) => s.id !== id))
    setStreaming(null)
    setLastError(null)
    setCurrentTitle(null)
    setMindGuess(null)
    // 主动陪伴:加载历史会话 = 有操作(从零计时)
    lastUserSendRef.current = Date.now()
  }, [])

  const deleteSession = useCallback((id: string) => {
    setSessions((prev) => prev.filter((s) => s.id !== id))
  }, [])

  const saveConfig = useCallback(async (patch: Partial<AgentConfig>) => {
    const next = await window.desktop?.agentSetConfig?.(patch)
    if (next) setConfig(next)
  }, [])

  const refreshConfig = loadConfigAndTools

  // 消费自动播放标记(2026-08-10):AssistantBlock 渲染并自动播放首条媒体
  // 后调用——从 Set 移除,该消息重挂载(收起再展开/历史恢复)不再自动播
  const consumeMediaAutoPlay = useCallback((id: string) => {
    mediaAutoPlayRef.current.delete(id)
  }, [])

  return {
    status,
    messages,
    streaming,
    lastError,
    pendingConfirm,
    confirmTool,
    config,
    sessions,
    tools,
    currentTitle,
    mindGuess,
    /** 本会话流式落定且未自动播放过的消息 id(引用稳定,渲染时读 has) */
    mediaAutoPlayIds: mediaAutoPlayRef.current,
    /** 消费自动播放标记(媒体已自动播放过) */
    consumeMediaAutoPlay,
    send,
    abort,
    clear,
    loadSession,
    deleteSession,
    saveConfig,
    refreshConfig,
  }
}
