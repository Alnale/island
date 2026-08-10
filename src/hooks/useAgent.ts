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
import type {
  AgentConfig,
  AgentEvent,
  AgentMessage,
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
  /** 待确认的命令(引擎请求,等待用户允许/拒绝;null = 无) */
  pendingConfirm: { command: string } | null
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
  // exec_command 确认门:引擎发 tool-confirm-request 等待用户选择
  const [pendingConfirm, setPendingConfirm] = useState<{ command: string } | null>(null)
  const [config, setConfig] = useState<AgentConfig | null>(null)
  // 历史会话列表(新对话时自动存档当前对话)
  const [sessions, setSessions] = useState<AgentSession[]>(loadSessions)
  // 工具清单(引擎 → 主进程 IPC,UI 展示用)
  const [tools, setTools] = useState<AgentToolInfo[]>([])
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
  const resetStreaming = useCallback(() => {
    if (streamingRafRef.current) cancelAnimationFrame(streamingRafRef.current)
    streamingRafRef.current = 0
    streamingRef.current = { text: '', reasoning: '', tools: [] }
    setStreaming(null)
  }, [])
  const scheduleStreamingCommit = useCallback(() => {
    if (streamingRafRef.current) return
    streamingRafRef.current = requestAnimationFrame(() => {
      streamingRafRef.current = 0
      setStreaming({ ...streamingRef.current })
    })
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
          setPendingConfirm({ command: event.command })
          break
        case 'background-done': {
          // 后台长任务完成(如 bili 下载):自动触发一轮对话——LLM 基于
          // 系统提示的状态块主动告知用户结果,无需用户主动提问
          // (实测:下载完成后用户不提问就不知道结果)。
          // 复用 send 的 silent 模式(2026-08-08 用户要求):系统提示
          // 不作为用户消息气泡出现在对话窗口(通知由主进程 Windows
          // 通知展示),LLM 回复照常落定。busy 时忽略(对话中的状态块
          // 已覆盖);send 引用稳定(useCallback []),事件订阅闭包安全
          const text = `【系统通知】${event.title}:${event.message}。请根据当前任务状态,用一两句话主动告知用户结果。`
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
        ?.agentProactiveTick?.(snapshot, Math.floor(idleMs / 60_000))
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

  const send = useCallback((text: string, opts?: { silent?: boolean }) => {
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
    // 注意:不递增会话版本(连续对话时总结基于最新消息,旧结果主题一致
    // 仍有效;递增会把每轮总结都作废,标题永远等不到)
    const userMessage: AgentMessage = {
      id: `u-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'user',
      parts: [{ type: 'text', text: trimmed }],
    }
    const next = [...base, userMessage]
    if (opts?.silent) {
      // 静默模式(2026-08-08 用户要求:background-done 等系统提示不作为
      // 用户气泡):**不落渲染端历史**(对话窗口不出现"【系统通知】…"
      // 气泡,通知由主进程 Windows 通知展示),仅作为本轮输入进引擎
      // 历史——LLM 据此回复,回复照常落定
      messagesRef.current = prev
      setLastError(null)
      // 引擎无状态:回传完整历史(末尾 = 系统通知,引擎不再追加)
      window.desktop?.agentSend?.(trimmed, next)
      return
    }
    // 同步更新引用:连续 send 之间(React 尚未渲染)也能拿到最新历史,
    // 避免第二次 send 基于旧消息覆盖第一次(最新一轮用户消息消失)
    messagesRef.current = next
    setMessages(next)
    setLastError(null)
    // 引擎无状态:回传完整历史(含刚加入的用户消息)
    window.desktop?.agentSend?.(trimmed, next)
  }, [])

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
    // 新对话:当前对话(非空)存档到历史,再清空。
    // 标题用实时总结(每轮回复后已静默更新,无需再次调用 LLM)
    sessionVersionRef.current += 1
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
  }, [resetStreaming])

  const loadSession = useCallback((id: string) => {
    const target = sessionsRef.current.find((s) => s.id === id)
    if (!target) return
    // 加载 = 替换当前对话;从历史移除(当前会话继续由 HISTORY_KEY 持久化);
    // 标题/心理重置并跳过下一次自动生成(历史消息不该被重新总结)
    sessionVersionRef.current += 1
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
