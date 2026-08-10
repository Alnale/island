/**
 * Agent 引擎 —— 单 agent 循环 + 工具执行
 *
 * 借鉴:
 * - opencode src/session/llm.ts 的流式调用编排(系统提示拼接、abort 贯穿);
 * - MS Agent 参考后端 toolkit/agent_loop.rs 的 ReAct 循环语义:
 *   ① 流式回复(文本/工具调用增量事件实时转发)→ ② 有工具调用则逐个执行、
 *      结果回填上下文 → ③ 继续下一轮,直到模型给出纯文本回复;
 *   - 迭代上限防死循环(工具重复/只思考不行动);
 *   - 工具失败结构化提示(错误信息回填,LLM 可自纠)。
 *
 * 引擎无状态:每轮由渲染端回传完整历史(参考后端"客户端持有历史"模式),
 * 主进程注入 getConfig / onEvent / onSwitchToMusic 依赖。
 */

import { randomUUID } from 'node:crypto'
import { parseToolArgs } from './deepseek'
import { streamByConfig } from './provider'
import { createTools, disposeTools } from './tools'
import { getTasksStatusBlock } from './tasks'
import { createSettingsTools } from './settingsTools'
import { createMCPManager, type MCPManager } from './mcp'
import { createSkillLoader } from './skills'
import { createMemoryTools, formatMemoryBlock } from './memory'
import { createConfigTools } from './configTools'
import type {
  AgentConfig,
  AgentEvent,
  AgentMessage,
  AgentPart,
  AgentTool,
  EngineDeps,
  McpServerConfig,
  MediaAttachment,
  MemoryStoreLike,
  ToolParams,
} from './types'

// 测试用导出(工具执行链路直测)
export { createTools }
// 后台标签 Sub Agent 与自我配置工具组已拆独立模块(2026-08-07 审计 P1:
// engine.ts 1291 → 751 行),测试与 main.cjs 的导入路径经 re-export 保持
export {
  compressArgs,
  sanitizeTitle,
  fallbackTitle,
  parseTitleJson,
  extractJsonTitle,
  extractJsonObject,
  looksLikeCodeLiteral,
  sanitizeMind,
  buildMindSystem,
  buildJudgeSystem,
  parseJudgeJson,
  parseMemoriesJson,
  parseStyleJson,
  buildMemoryExtractSystem,
  buildUserStyleSystem,
  createSummaryAgent,
  createMindAgent,
  SUMMARY_STYLES,
  MIND_PERSONAS,
  resolveSubAgentStyle,
} from './subagents'
export { createConfigTools } from './configTools'

/**
 * 工具循环迭代上限。
 * 用户要求**移除 25 轮限制**(复杂任务试错空间仍不足)——不再设实际
 * 上限:防失控由用户停止按钮(abort)/上下文预算(trimHistory 200K)
 * 兜底。1000 仅作程序级保险(引擎自身 bug 防无限循环烧 token),
 * 正常 LLM 行为不可能达到(每轮至少一次完整 API 往返)
 */
const MAX_STEPS = 1000
/** 单个工具执行兜底超时(ms);工具可用 timeoutMs 字段覆盖(长任务工具
 * 如 xxt login 300s / doc_convert 120s 必须覆盖,否则被统一超时扼杀) */
const TOOL_TIMEOUT_MS = 60_000
/**
 * 主对话/子代理循环的输出上限(2026-08-08 修复):Responses 的
 * max_output_tokens **含思维链 token**——思考模式高 effort 下 4096
 * 常被思维链吃光,工具调用参数被截断成空串 → 工具失败 → LLM 重试
 * 又截断 = "一直调用参数为空的工具"(用户实测)。主循环默认 8192
 * (2026-08-08:原 16384 按用户要求砍半——预算只作上限,回复不会
 * 因此变长,LLM 任务确实巨大时可经 set_output_budget 按需调大,
 * 不必顶着大预算;官方上限 384K);
 * 总结/判断等无思考短任务保持缺省 4096(见 subagents.ts 调用,
 * 不传即默认)。
 * **2026-08-08 起可动态调整**(用户要求"LLM 自主判定要多少预算"):
 * 引擎持有可变 outputBudget(初始 = 持久化配置 maxOutputTokens ??
 * 本缺省),LLM 经 set_output_budget 工具(action=get 查当前值 →
 * action=set 按需设值,persist=true 写 settings.json 持久化);
 * 响应被预算截断(truncated)时引擎注入"预算不足"提示引导 LLM 处理
 */
const MAIN_MAX_OUTPUT_TOKENS = 8_192
/** 输出预算钳制范围(官方上限 384K 留余量) */
const MIN_OUTPUT_TOKENS = 4096
const MAX_OUTPUT_TOKENS = 262144

/**
 * 主动陪伴回合的内部指令(2026-08-07):作为 role:'system' 消息追加在
 * 请求 input 末尾(不进渲染端历史,不破坏 instructions 前缀缓存单元)。
 * 语义:让 LLM 自然主动开口、不暴露"系统判断/主动"等内部机制、一两句
 * 话、可跟进上次话题;文本自带"系统任务,非用户输入"声明——Anthropic
 * 兼容路径会把它并入 user 文本块,模型靠这句声明识别
 */
/**
 * 预算不足提示(2026-08-08,用户要求"增加 LLM 预算不足的提示"):
 * provider 报告响应被 max_output_tokens 截断(truncated)时,向下一轮
 * 请求注入本条 system 提示(仅一次)——LLM 据此判断:任务需要更长
 * 输出 → set_output_budget 按需调大后续写被截断的回复;任务已基本
 * 完成 → 直接收尾。不进渲染端历史(与 PROACTIVE_INSTRUCTION 同款
 * 请求侧指令,三 provider 序列化器已支持 system 分支)
 */
const BUDGET_TRUNCATE_HINT =
  '【系统提示,非用户输入】上一轮回复因输出预算(max_output_tokens)不足被截断。' +
  '如果当前任务需要更长的输出:请调用 set_output_budget 工具(action=get 查看当前预算,' +
  'action=set 按需调大,不必顶满上限),然后继续完成被截断的回复;' +
  '若任务已基本完成,直接给出收尾回复即可。'

const PROACTIVE_INSTRUCTION =
  '【系统主动任务,不是用户输入】用户已有一段时间没有与助手互动。' +
  '请基于当前对话语境、长期记忆与你的性格,主动说一两句自然、简短的话,开启或延续对话。' +
  '像真实的朋友那样——人是会用工具的:如果话题需要真实信息(后台任务进度、扫码登录等' +
  '等待状态、实时事件),就主动调用工具查证或顺手把事办了(web_search、查询后台任务状态、' +
  '用灵动岛设置工具帮用户调整挂件等),不要凭空猜测;但不要为了用工具而用工具,' +
  '把话说短、说自然,行动融入对话而不是罗列工具。' +
  '不要提及这是系统任务,不要长篇大论,不要解释你的行为。'

/**
 * 工具执行兜底超时(测试用导出):promise 与超时赛跑,超时/中止后拒绝
 * 并**清理定时器与监听器**(原实现 settle 后 setTimeout 残留)。
 * - ms:本工具兜底超时(工具 timeoutMs ?? 引擎默认);
 * - signal:主回合中止信号(用户点"停止"→ 在途工具立即失败返回,
 *   不再干等超时;delegate 子代理的循环也会随之停止);
 * 供 executeToolBatch 与手动调用路径共用
 */
export function raceWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
  name: string,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`工具执行超时(${Math.round(ms / 1000)}s):${name}`)),
      ms,
    )
    const onAbort = () => reject(new DOMException('aborted', 'AbortError'))
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer)
        reject(new DOMException('aborted', 'AbortError'))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    promise.then(
      (v) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (err) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}
/**
 * 工具参数校验(2026-08-08,LLM 自主纠错的核心机制):按工具 schema 的
 * required 校验参数,缺参/空参返回**可自纠的错误文本**(列出缺失参数名
 * + 类型 + 说明),不抛异常——由调用方把校验文本作为工具失败结果回填
 * LLM。LLM 看到"缺什么、怎么补"后自行重试,不再盲目前后反复空参调用
 * (用户实测:write_file 参数为空时 LLM 反复空参调用不修正)。
 * - 空值判定:undefined / null / 空字符串(数值 0 与布尔 false 是合法值);
 * - _raw(parseToolArgs 解析失败的原文)附带显示,LLM 能看到自己发了
 *   什么非 JSON 参数;
 * - 返回 null = 校验通过。
 */
export function validateRequiredArgs(
  tool: AgentTool,
  args: Record<string, unknown>,
): string | null {
  const required = tool.parameters?.required ?? []
  if (required.length === 0) return null
  const missing: string[] = []
  for (const key of required) {
    const v = args[key]
    if (v === undefined || v === null || v === '') missing.push(key)
  }
  if (missing.length === 0) return null
  const props = (tool.parameters?.properties ?? {}) as Record<
    string,
    { type?: string; description?: string; enum?: unknown[] }
  >
  const hints = missing
    .map((k) => {
      const p = props[k] ?? {}
      const type = p.type ?? 'string'
      const desc = p.description ? `,${p.description}` : ''
      const enumHint = Array.isArray(p.enum) && p.enum.length > 0 ? `,可选值:${p.enum.join('/')}` : ''
      return `"${k}"(${type}${desc}${enumHint})`
    })
    .join('、')
  const rawHint = typeof args._raw === 'string' ? `(本次收到的参数无法解析为 JSON,原文:${args._raw.slice(0, 100)})` : ''
  return (
    `工具 ${tool.name} 缺少必需参数:${missing.join('、')}。` +
    `参数要求:${hints}。${rawHint}请重新调用该工具,一次性提供完整参数。`
  )
}

/**
 * 上下文预算治理(官方文档:deepseek-v4-flash 上下文 1M,超出返回 400):
 * 按 token 粗估裁剪历史,超限从最旧丢弃。
 * - 估算:中文 ≈1 token/字、英文 ≈4 字符/token,取 0.6 系数保守;
 * - 上限 400K(2026-08-08 用户要求从 200K 提升;远低于 1M 窗口,
 *   工具结果/多轮累积的安全余量仍充足);
 * - 至少保留最近 10 条消息(不把对话裁没);
 * - 仅在超限时触发——正常对话不动历史,**不破坏缓存前缀**。
 */
const MAX_CONTEXT_TOKENS = 400_000
const MIN_KEEP_MESSAGES = 10

export function estimateMessageTokens(m: AgentMessage): number {
  let n = 0
  for (const p of m.parts) {
    if (p.type === 'text' || p.type === 'reasoning') n += p.text.length * 0.6
    else if (p.type === 'tool-result') n += p.result.length * 0.6
    else if (p.type === 'tool-call') n += JSON.stringify(p.args ?? {}).length * 0.3
  }
  return Math.ceil(n)
}

/** 历史裁剪(测试用导出):总估算超预算时从最旧丢弃
 * (至少保留最近 MIN_KEEP_MESSAGES 条) */
export function trimHistory(history: AgentMessage[]): AgentMessage[] {
  let total = 0
  for (const m of history) total += estimateMessageTokens(m)
  if (total <= MAX_CONTEXT_TOKENS) return history
  const keep: AgentMessage[] = []
  let sum = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const t = estimateMessageTokens(history[i])
    if (sum + t > MAX_CONTEXT_TOKENS && keep.length >= MIN_KEEP_MESSAGES) break
    keep.unshift(history[i])
    sum += t
  }
  return keep
}

export interface AgentEngine {
  /** 当前是否在运行一轮 */
  readonly busy: boolean
  /** 当前主对话输出预算(缺省 16384;set_output_budget 动态调整,测试/UI 读用) */
  readonly outputBudget: number
  /** 发送一轮对话(引擎无状态,history = 完整历史) */
  send(text: string, history: AgentMessage[]): void
  /**
   * 主动陪伴回合(2026-08-07):无用户消息的**完整回合**——思考/流式/
   * 工具/子代理全保留,消息以正常助手气泡落定(message 事件带
   * proactive 标记)。内部指令为 role:'system' 请求项,不进渲染端历史。
   * busy 时静默拒绝(不发 error 事件——内部操作被用户操作挤掉是正常
   * 情况,不排队,拒绝即丢弃)
   */
  proactiveTurn(history: AgentMessage[], opts?: { hint?: string }): void
  /** 中止当前轮(工具执行中的命令不强制杀,由各工具自身超时兜底) */
  abort(): void
  /** 工具清单(名称/描述/参数 schema,供 UI 展示;不含执行函数) */
  listTools(): Array<{ name: string; description: string; parameters: AgentTool['parameters'] }>
  /** 完整工具清单(内置 + MCP 服务工具 + 技能;MCP 未连接的服务跳过) */
  listAllTools(): Promise<Array<{ name: string; description: string; parameters: AgentTool['parameters'] }>>
  /** 测试 MCP 服务连通性(独立连接 → 列工具 → 销毁,不进入常驻) */
  testMCP(server: McpServerConfig): Promise<{ ok: boolean; error?: string; toolCount?: number }>
  /** 销毁外部工具资源(MCP 子进程),应用退出时调用 */
  dispose(): void
}

/**
 * exec_command 确认门工厂(测试用导出):confirmExec 开启时每轮首个命令
 * 执行前经 confirmCommand 请求用户确认(拒绝 = false 结构化失败回填,
 * LLM 可自纠;确认后本轮其余命令直接放行)。reset 每轮调用一次
 */
export function createTurnConfirmGate(
  config: { confirmExec?: boolean },
  confirmCommand?: (command: string) => Promise<boolean>,
): { reset(): void; check(name: string, args: Record<string, unknown>): Promise<boolean> } {
  let confirmed = false
  return {
    reset() {
      confirmed = false
    },
    async check(name, args) {
      if (!config.confirmExec || name !== 'exec_command' || confirmed) return true
      const approved = (await confirmCommand?.(String(args.command ?? ''))) ?? false
      if (approved) confirmed = true
      return approved
    },
  }
}

/**
 * 手动调用解析(测试用导出):输入以 / 开头 = 调技能(skill_<名>),
 * 以 @ 开头 = 调 MCP 工具(mcp_<服务>_<工具>)。引擎在循环前先执行
 * 工具,结果以 tool-call/tool-result parts 入历史,LLM 基于结果直接回复
 */
export function parseManualCall(text: string): { name: string; rest: string } | null {
  if (!text.startsWith('/') && !text.startsWith('@')) return null
  const m = /^[/@]\s*(\S+)\s*([\s\S]*)$/.exec(text.trim())
  if (!m || !m[1]) return null
  return { name: m[1], rest: m[2] ?? '' }
}

/** 手动调用匹配(测试用导出):精确 → 模糊唯一命中;多命中/未找到给可读提示 */
export function findManualTool(
  tools: AgentTool[],
  name: string,
): { tool: AgentTool | null; hint: string } {
  const exact = tools.find((t) => t.name === name)
  if (exact) return { tool: exact, hint: '' }
  const lower = name.toLowerCase()
  const matches = tools.filter((t) => t.name.includes(lower))
  if (matches.length === 1) return { tool: matches[0], hint: '' }
  if (matches.length > 1) {
    return {
      tool: null,
      hint: `「${name}」匹配到 ${matches.length} 个工具(${matches.map((t) => t.name).join('、')}),请指定完整工具名`,
    }
  }
  return {
    tool: null,
    hint: `未找到「${name}」。技能用 /技能名,如 /trump-perspective;MCP 工具用 @完整工具名,如 @mcp_filesystem_read_file(可用工具列表查看现有工具)`,
  }
}

interface TurnCtx {
  config: AgentConfig
  signal: AbortSignal
  onEvent: (event: AgentEvent) => void
}

export function createAgentEngine(deps: EngineDeps): AgentEngine {
  let running = false
  let ctl: AbortController | null = null
  /**
   * 主对话/子代理输出预算(2026-08-08 动态化):初始 = 持久化配置
   * (settings.json agent.maxOutputTokens,用户设置/LLM persist 写入)
   * ?? 引擎缺省 16384;set_output_budget 工具临时调大(大任务)后可调回,
   * persist=true 经 updateAgentConfig 写盘持久化
   */
  // 先取一次配置值(多次 getConfig() 调用返回新对象,TS 无法跨调用
  // 收窄 number|undefined)
  const configuredBudget = deps.getConfig().maxOutputTokens
  let outputBudget =
    typeof configuredBudget === 'number' &&
    Number.isFinite(configuredBudget) &&
    configuredBudget >= MIN_OUTPUT_TOKENS &&
    configuredBudget <= MAX_OUTPUT_TOKENS
      ? configuredBudget
      : MAIN_MAX_OUTPUT_TOKENS

  const emit = (event: AgentEvent) => deps.onEvent(event)

  /**
   * 外部工具源(MCP 服务工具 + 技能目录):每轮循环开始时拉取一次。
   * 配置读取走 getConfig(与引擎其余部分一致);MCP 服务连接失败/
   * 技能目录不存在都静默跳过(返回空数组),不影响对话——真正调用到
   * 该工具时才有错误信息回填 LLM。
   * 注意:技能每次重新扫描(配置变更即时生效,本地文件读取开销可忽略);
   * MCP 已连接的客户端缓存,不会反复握手;连接失败打日志不抛。
   */
  const mcpManager: MCPManager = createMCPManager()
  const skillLoader = createSkillLoader()
  async function getExternalTools(): Promise<AgentTool[]> {
    const cfg = deps.getConfig()
    const [mcpTools, skillTools] = await Promise.all([
      mcpManager.listTools(cfg.mcpServers ?? []).catch((err: Error) => {
        console.error('[agent] MCP 工具加载失败:', err.message)
        return []
      }),
      // 已排除技能(对话/设置里移除)扫描跳过;
      // ownDirs = userData/skills(自己创建的技能,设置界面分区展示)
      skillLoader.listTools(cfg.skillsDirs ?? [], cfg.excludedSkills ?? [], [
        deps.getSkillDir?.() ?? '',
      ]),
    ])
    return [...mcpTools, ...skillTools]
  }
  /** 已禁用工具集合(工具列表视图禁用;每轮实时读配置,禁用下一轮即生效) */
  function excludedToolSet(): Set<string> {
    return new Set(deps.getConfig().excludedTools ?? [])
  }

  /** 记忆存储(主进程注入;未注入时记忆功能禁用)。
   * **必须实时获取,不能创建时捕获**:清除数据(main.cjs agentClearData
   * 置 memoryStore=null)后主进程重建新实例——捕获旧引用会让 LLM 记忆
   * 工具永远操作清除前的旧数据,而渲染端(agent:memory-get 实时读)读
   * 新实例 → 两处永久不一致(实测:LLM 列出已删除记忆的 id,设置视图
   * 长期记忆为空) */
  function getMemoryStore(): MemoryStoreLike | null {
    return deps.getMemoryStore?.() ?? null
  }
  /** 记忆 → 系统提示块(静态段;按类型分组,变更才断缓存前缀) */
  async function getMemoryBlock(): Promise<string> {
    const store = getMemoryStore()
    if (!store) return ''
    try {
      const entries = await store.list()
      return formatMemoryBlock(entries)
    } catch {
      return ''
    }
  }

  /**
   * 子代理:嵌套 agent 循环(独立上下文,事件静默,返回结果文本)。
   * 配合并行工具执行:LLM 一次发多个 delegate 调用即并行子代理。
   * - 可限制工具子集(tools 参数);
   * - reasoning 仍需累积(DeepSeek thinking 模式回传要求);
   * - 工具级 60s 超时兜底(execute 外层 race),内部每轮 55s 超时。
   */
  async function runSubAgent(params: ToolParams, signal?: AbortSignal): Promise<string> {
    const task = String(params.task ?? '').trim()
    if (!task) throw new Error('delegate 的 task 参数不能为空')
    const config = deps.getConfig()
    if (!config.apiKey.trim()) throw new Error('尚未配置 DeepSeek API Key')
    const allowAll = !Array.isArray(params.tools) || params.tools.length === 0
    const allowed = new Set((Array.isArray(params.tools) ? params.tools : []).map(String))
    // 确认门捕获**本回合实例**:工厂作用域变量每轮重赋值,中止后未停的
    // 僵尸子代理继续跑会读到下一轮的门(跨轮污染确认语义,审计 P0)
    const myGate = turnConfirmGate
    // 子代理继承外部工具(MCP + 技能):未限制工具子集时全量可用
    const subTools = [...tools, ...(await getExternalTools())].filter(
      // 已禁用工具不注入子代理(用户禁用的工具任何路径都不可用)
      (t) => !excludedToolSet().has(t.name) && (allowAll || allowed.has(t.name)),
    )
    const subMap = new Map(subTools.map((t) => [t.name, t]))
    const system = [
      config.systemPrompt,
      String(params.system ?? '').trim() ||
        '你是子代理,专注完成委派的子任务,只返回任务结果文本,不要多余解释。',
    ]
      .filter(Boolean)
      .join('\n')
    const historyIn: AgentMessage[] = [
      { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: task }] },
    ]
    const msgParts: AgentPart[] = []
    let reasoningText = ''
    let pushedParts = 0
    // 预算截断提示注入标志(每轮仅一次,2026-08-08)
    let truncateHinted = false
    for (let step = 1; step <= MAX_STEPS; step++) {
      // 继承主回合中止信号:用户点"停止" → 子代理立即停(不再烧 token);
      // 每步 55s 内部超时照旧(AbortSignal.any 组合,任一触发即中止)
      if (signal?.aborted) break
      const result = await streamByConfig({
        config,
        system,
        history: historyIn,
        tools: subTools,
        signal: AbortSignal.any([AbortSignal.timeout(55000), ...(signal ? [signal] : [])]),
        // 与主循环同款输出上限(可变预算:set_output_budget 动态调整)
        maxOutputTokens: outputBudget,
        onEvent: (event) => {
          // 子代理静默执行(事件不转发 UI,过程由 delegate 卡片呈现)
          if (event.type === 'reasoning-delta') reasoningText += event.text
        },
      })
      if (result.aborted || signal?.aborted) break
      if (reasoningText) {
        msgParts.push({ type: 'reasoning', text: reasoningText })
        reasoningText = ''
      }
      const text = result.text
      if (text) msgParts.push({ type: 'text', text })
      // 预算截断时**不 break**(2026-08-08):半截结果入历史 + 循环底部
      // 注入 BUDGET_TRUNCATE_HINT,子代理下一轮续写/调预算
      if (result.calls.length === 0 && !result.truncated) break
      // 子代理内部工具也并行执行(继承主回合 signal:中止即失败返回)
      const batch = result.calls.map((c) => ({ id: c.id, name: c.name, args: parseToolArgs(c.args) }))
      const results = await executeToolBatch(batch, subMap, subTools, myGate, signal)
      for (let i = 0; i < batch.length; i++) {
        const r = results[i]
        msgParts.push({ type: 'tool-call', id: r.id, name: r.name, args: batch[i].args })
        msgParts.push({
          type: 'tool-result',
          id: r.id,
          name: r.name,
          ok: r.ok,
          result: r.out,
          durationMs: r.durationMs,
        })
      }
      historyIn.push({ id: randomUUID(), role: 'assistant', parts: msgParts.slice(pushedParts) })
      pushedParts = msgParts.length
      // 预算不足提示:本轮响应被 max_output_tokens 截断(且还有下一轮)
      // → 注入 system 提示,引导子代理按需调预算/收尾(每回合一次)
      if (result.truncated && !truncateHinted) {
        truncateHinted = true
        historyIn.push({ id: randomUUID(), role: 'system', parts: [{ type: 'text', text: BUDGET_TRUNCATE_HINT }] })
      }
    }
    const reply = msgParts
      .filter((p): p is Extract<AgentPart, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
      .join('\n')
    return reply || '(子代理未返回文本结果)'
  }

  /** delegate 子代理工具(按需调用:LLM 决定何时委派) */
  const delegateTool: AgentTool = {
    name: 'delegate',
    description:
      '委派子任务给子 Agent 并行处理。适合把大任务拆成多个独立子任务:一次调用多个 delegate 即可并行执行,' +
      '每个子 Agent 有独立上下文,可用工具执行并返回结果文本。注意:子任务之间应尽量独立,避免互相等待。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '子任务描述:要完成什么、期望的输出' },
        system: { type: 'string', description: '可选:子 Agent 专用系统提示(角色/约束/输出格式)' },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description: '可选:允许子 Agent 使用的工具名列表,缺省全部',
        },
      },
      required: ['task'],
    },
    async execute(params: ToolParams, ctx?: { signal?: AbortSignal }) {
      return runSubAgent(params, ctx?.signal)
    },
  }

  /**
   * LLM 自我配置工具组:自然语言直接管理 MCP 服务与技能目录。
   * 写配置经 deps.updateAgentConfig(主进程注入,同款校验);
   * 工具清单每轮刷新,新增服务/目录下一轮生效(结果里注明)
   */
  const configTools = createConfigTools({
    getConfig: deps.getConfig,
    updateAgentConfig: deps.updateAgentConfig,
    testMcp: (server) => mcpManager.test(server),
    // 技能扫描(排除校验:确认要排除的技能确实已注册)
    listSkills: (dirs, excluded) => skillLoader.listTools(dirs, excluded),
    // 技能创建写入目录(main.cjs 注入 userData/skills)
    getSkillDir: deps.getSkillDir,
    // 工具清单(禁用校验:tools_config 确认要禁用的工具确实存在;
    // 闭包引用下方 tools 数组——工具实际执行时已初始化,无 TDZ 问题)
    listAllTools: () => tools,
  })

  /** 记忆自我进化工具(委托主进程创建的 harness;后台执行,立即返回) */
  const evolveTool: AgentTool = {
    name: 'evolve_memory',
    description:
      '触发记忆系统的版本化自我进化(后台,多轮候选循环):每轮 评估记忆质量 → 生成带假说的改进 → ' +
      '复评 → 只接受评分严格更高的候选(接受 = 新版本存档,拒绝 = 恢复原版本),最多 rounds 轮,达标提前停。' +
      '适合:用户说"整理一下记忆""进化一下"、或对话沉淀多后主动触发。完成后有系统通知。',
    parameters: {
      type: 'object',
      properties: {
        focus: { type: 'string', description: '可选:本次进化的关注点(如"去重""补充偏好")' },
        rounds: { type: 'number', description: '候选轮数,缺省 2,最大 4(每轮一个候选版本)' },
      },
    },
    async execute(params: ToolParams) {
      const evolution = deps.getEvolution?.() ?? null
      if (!evolution) throw new Error('自我进化不可用(未启用)')
      return (
        await evolution.requestEvolve(
          params.focus ? String(params.focus) : undefined,
          params.rounds ? Number(params.rounds) : undefined,
        )
      ).message
    },
  }

  /**
   * 输出预算自我配置工具(2026-08-08,用户要求"LLM 自主判定要多少
   * 预算"):action=get 查当前值(供决策)→ action=set 按需设值。
   * 预算只是输出上限,不是越多越好——LLM 应按任务实际需要设值
   * (大任务如超长文档/大文件/长代码按需提高,常规任务保持缺省),
   * 避免异常失控回复烧 token。persist=true 经 updateAgentConfig
   * 写 settings.json(applyAgentConfigPatch 同款钳制 4096–262144),
   * 重启保留;缺省 false = 仅本次会话
   */
  const outputBudgetTool: AgentTool = {
    name: 'set_output_budget',
    description:
      '查看/调整主对话的输出预算(max_output_tokens,**含思维链 token**)。' +
      '**按任务实际需要设值,不是越大越好**:预算只是输出上限,回复不会因此变长,' +
      '过大只会让失控的回复烧更多 token。' +
      '用法:先 action=get 查看当前预算与缺省值;任务确实需要超长输出(超长文档/大文件/长代码)时,' +
      '用 action=set 设一个**合理的目标值**(如 32768/65536,最大 262144),完成后可调回缺省。' +
      'persist=true 写入配置文件(重启后仍生效);缺省 false = 仅本次会话有效(重启恢复缺省)。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'set'],
          description: 'get = 查询当前预算;set = 设置新预算(必填 maxOutputTokens)',
        },
        maxOutputTokens: {
          type: 'number',
          description: 'set 时的新输出预算(4096-262144,含思维链 token),按任务实际需要设值',
        },
        persist: { type: 'boolean', description: 'set 时是否持久化到配置文件,缺省 false(仅本次会话)' },
      },
      required: ['action'],
    },
    async execute(params: ToolParams) {
      const action = String(params.action ?? '')
      if (action === 'get') {
        return (
          `当前输出预算:${outputBudget}(缺省 ${MAIN_MAX_OUTPUT_TOKENS},范围 4096-262144,官方上限 384K)。` +
          '预算只是输出上限:任务需要超长输出时用 action=set 按需调大,常规任务保持当前值即可。'
        )
      }
      if (action !== 'set') throw new Error('action 仅支持 get/set')
      const raw = Number(params.maxOutputTokens)
      if (!Number.isFinite(raw)) throw new Error('set 需要 maxOutputTokens(数字,4096-262144)')
      const n = Math.min(MAX_OUTPUT_TOKENS, Math.max(MIN_OUTPUT_TOKENS, Math.round(raw)))
      const prev = outputBudget
      outputBudget = n
      let persistedNote = '仅本次会话有效(重启恢复缺省)'
      if (params.persist === true) {
        if (!deps.updateAgentConfig) {
          persistedNote = '无法持久化(未注入配置写入),仅本次会话有效'
        } else {
          deps.updateAgentConfig({ maxOutputTokens: n })
          persistedNote = '已写入配置文件,重启后仍生效'
        }
      }
      return (
        `输出预算已从 ${prev} 调整为 ${n}(${persistedNote})。` +
        `常规任务可调回缺省 ${MAIN_MAX_OUTPUT_TOKENS};超长任务按需保持即可。`
      )
    },
  }

  const tools = [
    ...createTools({
      onSwitchToMusic: deps.onSwitchToMusic,
      // 后台长任务完成(如 bili 下载)→ background-done 事件转发渲染端,
      // 渲染端自动触发一轮对话让 LLM 主动回复(用户无需提问)
      onBackgroundDone: (info) => emit({ type: 'background-done', ...info }),
    }),
    // 灵动岛设置工具(主题色/缩放/字体/背景图库):主进程注入了
    // runIslandSettings 才注册(挂件环境;Web 演示版无主进程)
    ...(deps.runIslandSettings
      ? createSettingsTools({ runIslandSettings: deps.runIslandSettings })
      : []),
    delegateTool,
    // 记忆工具:getter 惰性实时获取(createMemoryTools 在引擎创建时组装
    // 一次,固定 store 引用会在清除数据后操作已删除记忆,见 getMemoryStore)
    ...(getMemoryStore() ? createMemoryTools(() => getMemoryStore()) : []),
    ...configTools,
    evolveTool,
    outputBudgetTool,
  ]

  /**
   * 并发执行一批工具调用(每个独立 60s 超时),按传入顺序返回结果。
   * 并行:DeepSeek 并行工具调用始终开启,互不依赖的调用并发跑;
   * 结果按序回填,UI 工具卡片顺序与 parts 顺序一致
   */
  // exec_command 确认门(工厂作用域:子代理与主循环共用;每轮 runTurn 重置)
  const turnCommandConfirmed = { value: false }
  let turnConfirmGate: ((name: string, args: Record<string, unknown>) => Promise<boolean>) | undefined

  async function executeToolBatch(
    batch: Array<{ id: string; name: string; args: Record<string, unknown> }>,
    map: Map<string, AgentTool>,
    list: AgentTool[],
    confirmGate?: (name: string, args: Record<string, unknown>) => Promise<boolean>,
    signal?: AbortSignal,
  ): Promise<
    Array<{
      id: string
      name: string
      ok: boolean
      out: string
      durationMs: number
      image?: string
      media?: MediaAttachment[]
    }>
  > {
    return Promise.all(
      batch.map(async ({ id, name, args }) => {
        const tool = map.get(name)
        const started = Date.now()
        let out: string
        let ok: boolean
        let image: string | undefined
        let media: MediaAttachment[] | undefined
        if (!tool) {
          out = `未知工具:${name}(可用工具:${list.map((t) => t.name).join('、')})`
          ok = false
        } else {
          try {
            // 确认门(confirmExec):拒绝的命令不执行,结构化回填供 LLM 自纠
            if (confirmGate && !(await confirmGate(name, args))) {
              out = '用户拒绝了命令执行'
              ok = false
            } else {
              // 参数校验(2026-08-08,LLM 自主纠错):缺必需参数 → 结构化
              // 错误文本回填(列出缺失参数名+类型+说明),**不执行工具**——
              // 空参调用不再白白执行/烧时间,LLM 看到"缺什么、怎么补"
              // 后自行修正重试,不再反复空参调用
              const argError = validateRequiredArgs(tool, args)
              if (argError) {
                out = `工具执行失败:${argError}`
                ok = false
              } else {
                // 兜底超时 = 工具自声明 timeoutMs(长任务如 xxt/doc_convert)
                // ?? 引擎默认 60s;signal = 主回合中止(用户点"停止" →
                // 在途工具立即失败,不再干等超时;delegate 子代理借此停循环)
                const raw = await raceWithTimeout(
                  Promise.resolve(tool.execute(args, { signal })),
                  tool.timeoutMs ?? TOOL_TIMEOUT_MS,
                  name,
                  signal,
                )
                // 对象返回 = 文本 + 图片附件 + 媒体附件(open_file 媒体
                // 拦截注入,2026-08-08)
                if (typeof raw === 'object') {
                  out = raw.text
                  image = raw.image
                  media = raw.media
                } else {
                  out = raw
                }
                ok = true
              }
            }
          } catch (err) {
            out = `工具执行失败:${(err as Error).message}`
            ok = false
          }
        }
        return { id, name, ok, out, media, image, durationMs: Date.now() - started }
      }),
    )
  }

  /** 单轮完整循环(每轮由 send / proactiveTurn 启动,异常/中止都在这里收敛) */
  async function runTurn(
    text: string,
    history: AgentMessage[],
    ctx: TurnCtx,
    opts: { proactive?: boolean; hint?: string } = {},
  ) {
    const { signal, onEvent, config } = ctx
    onEvent({ type: 'status', status: 'thinking' })

    // 本轮历史 = 预算裁剪后的完整历史 + 工具循环中追加的助手消息。
    // 约定:history 末尾已含本轮用户消息(渲染端 send 回传的 next 以刚
    // 加入/合并后的 user 消息结尾)——**不再追加**,否则用户消息重复
    // 出现(同一轮请求发两遍);且中止后渲染端把新输入合并进"未答复的
    // 用户消息"时,无脑追加会把合并结果再拆开,污染复现。
    // 防御:历史缺尾(如直接调用 send 的旧脚本)则按 text 补一条。
    // 注意必须复制数组:trimHistory 未超限时返回原引用,后续 push 助手
    // 消息会改到调用方(渲染端)的历史
    const historyIn: AgentMessage[] = [...trimHistory(history)]
    // 主动回合:把内部指令作为 system 请求项追加在末尾(**无论如何都加**
    // ——历史末尾是未答复 user 消息时照样追加其后,system 无角色交替
    // 硬约束,LLM 回复该指令 + 上下文)。指令不进渲染端历史,后续 send
    // 回传的历史里没有它,不会重复注入;也不拼进 system prompt(动态段
    // 会断 DeepSeek 前缀缓存,50 倍价差)
    if (opts.proactive) {
      historyIn.push({
        id: randomUUID(),
        role: 'system',
        parts: [
          {
            type: 'text',
            text: PROACTIVE_INSTRUCTION + (opts.hint ? `\n(语境提示:${opts.hint})` : ''),
          },
        ],
      })
    } else {
      const lastMsg = historyIn[historyIn.length - 1]
      if (lastMsg?.role !== 'user') {
        historyIn.push({ id: randomUUID(), role: 'user', parts: [{ type: 'text', text }] })
      }
    }
    // 本轮助手消息的 parts(文本 / 工具调用 / 工具结果,按执行顺序累积)
    const msgParts: AgentPart[] = []
    // 已回填历史的 parts 数:每轮只把"新增部分"推给下一轮,
    // 避免整段累积 parts 重复回填(上下文成倍膨胀)
    let pushedParts = 0
    // reasoning 累积:流式事件旁路拦截(仅用于最终消息落定时展示)
    let reasoningText = ''
    let usage: { input: number; output: number; cached?: number } = { input: 0, output: 0 }
    // 预算截断提示注入标志(每回合仅一次,2026-08-08)
    let truncateHinted = false

    // exec_command 确认门:confirmExec 开启时,每轮首个命令执行前经
    // deps.confirmCommand 请求用户确认(拒绝 = 结构化失败回填,LLM 可
    // 自纠;确认后本轮其余命令直接放行)。gate 存工厂作用域:子代理
    // (runSubAgent)与主循环共用同一确认状态
    // 每轮重置确认状态;gate 存工厂作用域供子代理共用
    turnCommandConfirmed.value = false
    const gate = createTurnConfirmGate(config, deps.confirmCommand)
    turnConfirmGate = gate.check

    // 手动调用:/技能名 或 @mcp工具名 —— 循环前先执行工具,结果以
    // tool-call/tool-result parts 入历史,LLM 基于结果直接回复
    // (事件照常转发,UI 工具卡片与自动调用一致)
    const manual = parseManualCall(text)
    if (manual) {
      // 已禁用工具同样不可手动调用(不注入,匹配不到给出提示)
      const turnTools = [...tools, ...(await getExternalTools())].filter(
        (t) => !excludedToolSet().has(t.name),
      )
      const found = findManualTool(turnTools, manual.name)
      if (!found.tool) {
        onEvent({ type: 'error', message: found.hint })
        onEvent({ type: 'status', status: 'idle' })
        return
      }
      onEvent({ type: 'status', status: 'running' })
      const id = randomUUID()
      // 剩余文本:是合法 JSON 对象则作为参数,否则空参数
      // (文本进用户消息,LLM 有上下文可理解意图)
      let args: Record<string, unknown> = {}
      const rest = manual.rest.trim()
      if (rest) {
        try {
          const parsed = JSON.parse(rest)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed
        } catch {
          // 非 JSON:空参数
        }
      }
      onEvent({ type: 'tool-call', id, name: found.tool.name, args: JSON.stringify(args) })
      msgParts.push({ type: 'tool-call', id, name: found.tool.name, args })
      const started = Date.now()
      let ok = true
      let out = ''
      let outImage: string | undefined
      let outMedia: MediaAttachment[] | undefined
      try {
        // 参数校验(与 executeToolBatch 同款:缺必需参数 → 结构化错误
        // 回填 LLM 自纠,不执行;手动调用空参同样得到可读提示)
        const argError = validateRequiredArgs(found.tool, args)
        if (argError) throw new Error(argError)
        // 与 executeToolBatch 同款兜底:工具自声明 timeoutMs ?? 60s,
        // 主回合中止信号贯通(手动调用也响应"停止")
        const raw = await raceWithTimeout(
          Promise.resolve(found.tool.execute(args, { signal })),
          found.tool.timeoutMs ?? TOOL_TIMEOUT_MS,
          found.tool.name,
          signal,
        )
        if (typeof raw === 'object') {
          out = raw.text
          outImage = raw.image
          outMedia = raw.media
        } else {
          out = raw
        }
      } catch (err) {
        ok = false
        out = `工具执行失败:${(err as Error).message}`
      }
      onEvent({ type: 'tool-result', id, name: found.tool.name, ok, result: out, durationMs: Date.now() - started })
      msgParts.push({ type: 'tool-result', id, name: found.tool.name, ok, result: out, durationMs: Date.now() - started })
      // 工具图片附件(bili 登录二维码等):注入助手消息 image part,
      // 渲染端消息气泡直接展示——不依赖 LLM 复述长 base64
      if (outImage) msgParts.push({ type: 'image', dataUrl: outImage })
      // 工具媒体附件(open_file 媒体拦截):注入 media part,渲染端
      // MediaFrame 窗口内直接播放(不依赖 LLM 输出 markdown)
      if (outMedia && outMedia.length > 0) {
        for (const m of outMedia) msgParts.push({ type: 'media', kind: m.kind, url: m.url, name: m.name })
      }
      // 手动调用的执行结果入历史(在用户消息之后),LLM 第一步即看到
      historyIn.push({ id: randomUUID(), role: 'assistant', parts: msgParts.slice(0) })
      pushedParts = msgParts.length
    }

    for (let step = 1; step <= MAX_STEPS; step++) {
      if (signal.aborted) return
      // 系统提示 = 配置提示词 + 长期记忆块 + 后台任务状态块(记忆与
      // 状态都是静态/半静态段:记忆变更才断缓存前缀,状态块文案稳定)。
      // 后台任务(bili 下载/扫码登录等)完成信息若只靠一次性系统通知,
      // 后续对话中 LLM 对完成与否毫无感知,会惯性回复"还在进行/完成后
      // 会通知"(实测 bug);状态注入后 LLM 可依据真实状态如实回答,
      // 等待人工操作的任务(如扫码)也会提醒用户当前需要做什么。
      const bgStatus = getTasksStatusBlock()
      const memoryBlock = await getMemoryBlock()
      const evolutionStatus = (await deps.getEvolution?.()?.getStatus()) ?? ''
      const system = [
        config.systemPrompt || '你是桌面灵动岛挂件里的个人助手。',
        memoryBlock,
        evolutionStatus,
        bgStatus,
      ]
        .filter(Boolean)
        .join('\n\n')
      // 本轮工具清单 = 内置 + MCP 服务工具 + 技能(每步刷新:
      // MCP 服务崩溃/配置变更即时反映;命中缓存时零开销)。
      // 已禁用工具(工具列表禁用)过滤掉,LLM 看不到也调不到
      const turnTools = [...tools, ...(await getExternalTools())].filter(
        (t) => !excludedToolSet().has(t.name),
      )
      const turnMap = new Map(turnTools.map((t) => [t.name, t]))
      const result = await streamByConfig({
        config,
        system,
        history: historyIn,
        tools: turnTools,
        signal,
        // 输出上限 = 可变预算(缺省 8192,set_output_budget 按需可调):
        // 4096 在思考模式高 effort 下会截断工具调用参数 → 空参调用
        // 死循环(2026-08-08 修复);截断时引擎注入 BUDGET_TRUNCATE_HINT
        maxOutputTokens: outputBudget,
        onEvent: (event) => {
          if (event.type === 'reasoning-delta') reasoningText += event.text
          onEvent(event)
        },
      })
      if (result.aborted || signal.aborted) return
      if (result.usage) {
        usage.input += result.usage.input_tokens
        usage.output += result.usage.output_tokens
        if (result.usage.cached_tokens) usage.cached = (usage.cached ?? 0) + result.usage.cached_tokens
      }

      // DeepSeek thinking 模式要求 reasoning_text 回传(缺失会 400
      // "The reasoning_text in the thinking mode must be passed back to the API"):
      // 每轮(含工具循环)都把思维链存入 parts,历史序列化时输出
      // reasoning item —— 工具调用后的下一轮请求必须带上上一轮的思维链
      if (reasoningText) {
        msgParts.push({ type: 'reasoning', text: reasoningText })
        reasoningText = ''
      }

      const text = result.text
      if (text) msgParts.push({ type: 'text', text })

      const calls = result.calls
      if (calls.length === 0 && !result.truncated) {
        // 纯文本回复:本轮结束,落定权威消息(reasoning 已在上方入列);
        // 主动回合带 proactive 标记(主进程据此触发心理揣测通知,
        // 渲染端据此重置 idle 时钟;非主动回合载荷逐字节不变)
        onEvent({
          type: 'message',
          message: { id: randomUUID(), role: 'assistant', parts: msgParts, proactive: opts.proactive || undefined },
          usage,
        })
        onEvent({ type: 'status', status: 'idle' })
        return
      }
      // 预算截断(2026-08-08):calls 为空但响应被 max_output_tokens
      // 截断 → **不落定**,已输出的半截文本入历史 + 循环底部注入
      // BUDGET_TRUNCATE_HINT → 下一轮 LLM 续写/调预算(否则半截回复
      // 被当最终结果,预算不足提示永远用不上)

      // 有工具调用:进入执行阶段(参数已全程可见:tool-call 事件先发)。
      // 并行执行:DeepSeek 并行工具调用始终开启,互不依赖的调用并发跑
      // (多个 delegate 即并行子代理);结果按调用顺序回填。
      // 截断且无工具调用时跳过本分支(不误发 running 状态)
      let results: Array<{
        id: string
        name: string
        ok: boolean
        out: string
        durationMs: number
        image?: string
        media?: MediaAttachment[]
      }> = []
      if (calls.length > 0) {
        onEvent({ type: 'status', status: 'running' })
        const batch: Array<{ id: string; name: string; args: Record<string, unknown> }> = []
        for (const call of calls) {
          if (signal.aborted) return
          const args = parseToolArgs(call.args)
          msgParts.push({ type: 'tool-call', id: call.id, name: call.name, args })
          batch.push({ id: call.id, name: call.name, args })
        }
        results = await executeToolBatch(batch, turnMap, turnTools, turnConfirmGate, signal)
      }
      for (const r of results) {
        if (signal.aborted) return
        onEvent({
          type: 'tool-result',
          id: r.id,
          name: r.name,
          ok: r.ok,
          result: r.out,
          durationMs: r.durationMs,
        })
        msgParts.push({
          type: 'tool-result',
          id: r.id,
          name: r.name,
          ok: r.ok,
          result: r.out,
          durationMs: r.durationMs,
        })
        // 工具图片附件(如 bili 登录二维码):注入助手消息 image part,
        // 渲染端消息气泡直接展示——不依赖 LLM 复述长 base64
        if (r.image) msgParts.push({ type: 'image', dataUrl: r.image })
        // 工具媒体附件(open_file 媒体拦截):注入 media part,窗口内播放
        if (r.media && r.media.length > 0) {
          for (const m of r.media) msgParts.push({ type: 'media', kind: m.kind, url: m.url, name: m.name })
        }
      }

      // 把本轮新增的助手 parts(思维链 + 文本 + 调用 + 结果)回填历史,
      // 供下一轮上下文
      historyIn.push({ id: randomUUID(), role: 'assistant', parts: msgParts.slice(pushedParts) })
      pushedParts = msgParts.length
      // 预算不足提示(2026-08-08):本轮响应被 max_output_tokens 截断
      // → 注入 system 提示,LLM 自主判断:任务需要更长输出 → 调
      // set_output_budget 按需调大后续写;已基本完成 → 收尾。每回合
      // 仅注入一次(历史里保留到回合结束,不重复)
      if (result.truncated && !truncateHinted) {
        truncateHinted = true
        historyIn.push({ id: randomUUID(), role: 'system', parts: [{ type: 'text', text: BUDGET_TRUNCATE_HINT }] })
      }
    }

    onEvent({ type: 'error', message: `工具循环超过 ${MAX_STEPS} 轮仍未完成,已停止(请拆解任务或换种思路再试)` })
    onEvent({ type: 'status', status: 'idle' })
  }

  return {
    get busy() {
      return running
    },
    get outputBudget() {
      return outputBudget
    },
    send(text: string, history: AgentMessage[]) {
      if (running) {
        emit({ type: 'error', message: 'Agent 正在运行中,请先等待或中止' })
        return
      }
      const config = deps.getConfig()
      if (!config.apiKey.trim()) {
        emit({ type: 'error', message: '尚未配置 DeepSeek API Key(托盘菜单 → 设置 → Agent 设置)' })
        return
      }
      running = true
      const turnCtl = new AbortController()
      ctl = turnCtl
      void runTurn(text, history, { config, signal: turnCtl.signal, onEvent: emit })
        .catch((err: unknown) => {
          if ((err as Error).name !== 'AbortError') {
            emit({ type: 'error', message: (err as Error).message || String(err) })
          }
        })
        .finally(() => {
          // 只清自己的回合:abort 已同步复位、新回合已启动时,ctl 指向
          // 新回合的 controller,不能把新回合的 abort 能力清掉
          if (ctl === turnCtl) {
            running = false
            ctl = null
          }
        })
    },
    proactiveTurn(history: AgentMessage[], opts?: { hint?: string }) {
      // 与 send 互斥(共享 running):busy 时**静默返回**(不发 error 事件
      // ——内部操作被用户操作挤掉是正常情况,不打扰用户);不排队,
      // 拒绝即丢弃,避免积压。judge 阶段用户 send 天然优先:judge 结果
      // 到来时引擎已 busy,此处自动放弃
      if (running) return
      const config = deps.getConfig()
      if (!config.apiKey.trim()) return
      running = true
      const turnCtl = new AbortController()
      ctl = turnCtl
      void runTurn('', history, { config, signal: turnCtl.signal, onEvent: emit }, { proactive: true, hint: opts?.hint })
        .catch((err: unknown) => {
          if ((err as Error).name !== 'AbortError') {
            emit({ type: 'error', message: (err as Error).message || String(err) })
          }
        })
        .finally(() => {
          // 只清自己的回合(与 send 同款语义:abort 已同步复位或新回合
          // 已启动时,ctl 指向新回合的 controller,不能清掉)
          if (ctl === turnCtl) {
            running = false
            ctl = null
          }
        })
    },
    abort() {
      if (!running) return
      ctl?.abort()
      // 同步复位 running/ctl:abort 后立即重发不再被"正在运行中"挡回
      // (原实现等 runTurn 的 finally,中间 100ms 内新请求会被拒绝)
      running = false
      ctl = null
      emit({ type: 'status', status: 'idle' })
    },
    listTools() {
      // 只暴露描述(名称/说明/参数 schema),不含执行函数
      return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
    },
    async listAllTools() {
      // 内置 + 外部(MCP 未连接的服务跳过;技能实时扫描)。
      // UI 工具列表视图展示用;MCP 服务启动失败不影响其他工具
      const external = await getExternalTools()
      return [...tools, ...external].map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        // 技能来源分区(自己创建 vs 扫描到;设置界面分区展示)
        sourceKind: t.sourceKind,
      }))
    },
    async testMCP(server: McpServerConfig) {
      return mcpManager.test(server)
    },
    dispose() {
      mcpManager.dispose()
      // 关闭自动拉起的 DocFlow 服务(2026-08-07:服务由
      // doc_convert 首次调用自动启动,挂件退出时清理防残留)
      disposeTools()
    },
  }
}

// 自我进化 harness 与记忆存储(独立模块,provider 分发由 provider.ts
// 承担,无循环依赖;main.cjs 从同一打包产物取 createEvolution/createMemoryStore)
export { createEvolution } from './evolution'
export { createMemoryStore } from './memory'
