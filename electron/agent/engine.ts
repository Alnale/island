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
import { parseToolArgs, streamResponse } from './deepseek'
import { streamAnthropic } from './anthropic'
import { createTools } from './tools'

// 测试用导出(工具执行链路直测)
export { createTools }
import type {
  AgentConfig,
  AgentEvent,
  AgentMessage,
  AgentPart,
  AgentTool,
  EngineDeps,
  ProviderOutcome,
  ToolParams,
} from './types'

/**
 * Provider 自动判定:按配置的请求地址切换协议。
 * - 地址含 "anthropic"(如 https://api.deepseek.com/anthropic 或
 *   https://api.anthropic.com)→ Anthropic Messages API;
 * - 其余(默认 https://api.deepseek.com)→ DeepSeek Responses API。
 */
function detectProvider(baseURL: string): 'anthropic' | 'responses' {
  return baseURL.toLowerCase().includes('anthropic') ? 'anthropic' : 'responses'
}

/** 按配置发起流式请求(两个 provider 同构返回 ProviderOutcome) */
function streamByConfig(params: {
  config: AgentConfig
  system: string
  history: AgentMessage[]
  tools: AgentTool[]
  signal: AbortSignal
  onEvent: (event: AgentEvent) => void
}): Promise<ProviderOutcome> {
  return detectProvider(params.config.baseURL) === 'anthropic'
    ? streamAnthropic(params)
    : streamResponse(params)
}

/**
 * 工具循环迭代上限(防死循环)。
 * 原 10 轮实测太紧:复杂任务(多工具链/委派/自动答题等)LLM 试错
 * 空间不足,频繁撞上限中断(用户反馈"试错成本太低")→ 放宽到 25。
 * 上下文增长由 trimHistory 预算治理(200K)兜底,不会失控;
 * 防死循环语义保留(重复工具调用/只思考不行动最终仍会中断)
 */
const MAX_STEPS = 25
/** 单个工具执行兜底超时(ms);工具内部另有自己的超时参数 */
const TOOL_TIMEOUT_MS = 60_000
/**
 * 上下文预算治理(官方文档:deepseek-v4-flash 上下文 1M,超出返回 400):
 * 按 token 粗估裁剪历史,超限从最旧丢弃。
 * - 估算:中文 ≈1 token/字、英文 ≈4 字符/token,取 0.6 系数保守;
 * - 上限 200K(远低于 1M 窗口,工具结果/多轮累积的安全余量);
 * - 至少保留最近 10 条消息(不把对话裁没);
 * - 仅在超限时触发——正常对话不动历史,**不破坏缓存前缀**。
 */
const MAX_CONTEXT_TOKENS = 200_000
const MIN_KEEP_MESSAGES = 10

function estimateMessageTokens(m: AgentMessage): number {
  let n = 0
  for (const p of m.parts) {
    if (p.type === 'text' || p.type === 'reasoning') n += p.text.length * 0.6
    else if (p.type === 'tool-result') n += p.result.length * 0.6
    else if (p.type === 'tool-call') n += JSON.stringify(p.args ?? {}).length * 0.3
  }
  return Math.ceil(n)
}

/**
 * 总结标题清洗与截断:去首尾引号/书名号/空白(LLM 可能不遵守
 * "不要引号"的约束),按 code point 截断到岛体文字区显示容量。
 * 标题必须短:紧凑态文字区约 6-9 个汉字,8 字提示词 + 10 码元
 * 硬截断保证完整显示——长标题在岛体上被截成"开头几字",
 * 观感等同"总结失败、显示回复开头"
 */
function sanitizeTitle(raw: string): string {
  const text = raw
    .trim()
    .replace(/^[「『"'《<]+|[」』"'》>]+$/g, '')
    .trim()
  return Array.from(text).slice(0, 10).join('')
}

/** 历史裁剪:总估算超预算时从最旧丢弃(至少保留最近 MIN_KEEP_MESSAGES 条) */
function trimHistory(history: AgentMessage[]): AgentMessage[] {
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
  /** 发送一轮对话(引擎无状态,history = 完整历史) */
  send(text: string, history: AgentMessage[]): void
  /** 中止当前轮(工具执行中的命令不强制杀,由各工具自身超时兜底) */
  abort(): void
  /** 工具清单(名称/描述/参数 schema,供 UI 展示;不含执行函数) */
  listTools(): Array<{ name: string; description: string; parameters: AgentTool['parameters'] }>
}

/**
 * 独立的总结后台 Sub Agent:与主对话引擎**零共享**——独立实例、
 * 独立 AbortController、每次调用独立读取配置。主对话的任何操作
 * (发送/中止/模式切换/清空)都无法打断它;它失败/超时也绝不
 * 外溢到主对话(失败返回空串,由调用方重试/补跑)。
 * 与 delegate 子代理同构:独立上下文、事件静默、单轮完成。
 */
export function createSummaryAgent(deps: { getConfig: () => AgentConfig }): {
  /** 静默总结对话标题(无工具单轮,事件不转发 UI);失败/未配置返回空串 */
  summarize(messages: AgentMessage[]): Promise<string>
} {
  return {
    async summarize(messages: AgentMessage[]) {
      const config = deps.getConfig()
      if (!config.apiKey.trim() || messages.length === 0) return ''
      try {
        // 静默总结:无工具、单轮、事件不转发 UI(标题生成不打扰用户);
        // 输入只取最近 12 条消息,并压缩 reasoning(500 字)与工具结果
        // (2000 字)——标题只需主题,细节无用,大请求是总结超时的
        // 隐藏原因(完整工具结果/长思维链会拖慢传输与处理);
        // 45s 超时:思考模式 + 高峰期服务慢,15s 实测太紧;失败返回
        // 空串,调用方重试/补跑,标题不会永久缺失
        const recent = messages.slice(-12).map((m) => ({
          ...m,
          parts: m.parts.map((p) =>
            p.type === 'reasoning'
              ? { ...p, text: p.text.slice(0, 500) }
              : p.type === 'tool-result'
                ? { ...p, result: p.result.slice(0, 2000) }
                : p,
          ),
        }))
        const result = await streamByConfig({
          config: { ...config, reasoningEffort: 'low' },
          system:
            '你是对话标题生成器。根据对话内容生成一个不超过 8 个汉字的简短标题,' +
            '直接返回标题文本,不要任何解释、标点或引号。',
          history: recent,
          tools: [],
          signal: AbortSignal.timeout(45000),
          onEvent: () => {},
        })
        return sanitizeTitle(result.text)
      } catch {
        return ''
      }
    },
  }
}

/** 单轮执行上下文 */
interface TurnCtx {
  config: AgentConfig
  signal: AbortSignal
  onEvent: (event: AgentEvent) => void
}

export function createAgentEngine(deps: EngineDeps): AgentEngine {
  let running = false
  let ctl: AbortController | null = null

  const emit = (event: AgentEvent) => deps.onEvent(event)

  /**
   * 子代理:嵌套 agent 循环(独立上下文,事件静默,返回结果文本)。
   * 配合并行工具执行:LLM 一次发多个 delegate 调用即并行子代理。
   * - 可限制工具子集(tools 参数);
   * - reasoning 仍需累积(DeepSeek thinking 模式回传要求);
   * - 工具级 60s 超时兜底(execute 外层 race),内部每轮 55s 超时。
   */
  async function runSubAgent(params: ToolParams): Promise<string> {
    const task = String(params.task ?? '').trim()
    if (!task) throw new Error('delegate 的 task 参数不能为空')
    const config = deps.getConfig()
    if (!config.apiKey.trim()) throw new Error('尚未配置 DeepSeek API Key')
    const allowAll = !Array.isArray(params.tools) || params.tools.length === 0
    const allowed = new Set((Array.isArray(params.tools) ? params.tools : []).map(String))
    const subTools = tools.filter((t) => allowAll || allowed.has(t.name))
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
    for (let step = 1; step <= MAX_STEPS; step++) {
      const result = await streamByConfig({
        config,
        system,
        history: historyIn,
        tools: subTools,
        signal: AbortSignal.timeout(55000),
        onEvent: (event) => {
          // 子代理静默执行(事件不转发 UI,过程由 delegate 卡片呈现)
          if (event.type === 'reasoning-delta') reasoningText += event.text
        },
      })
      if (result.aborted) break
      if (reasoningText) {
        msgParts.push({ type: 'reasoning', text: reasoningText })
        reasoningText = ''
      }
      const text = result.text
      if (text) msgParts.push({ type: 'text', text })
      if (result.calls.length === 0) break
      // 子代理内部工具也并行执行
      const batch = result.calls.map((c) => ({ id: c.id, name: c.name, args: parseToolArgs(c.args) }))
      const results = await executeToolBatch(batch, subMap, subTools)
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
    async execute(params: ToolParams) {
      return runSubAgent(params)
    },
  }

  const tools = [...createTools(deps), delegateTool]
  const toolMap = new Map(tools.map((t) => [t.name, t]))

  /**
   * 并发执行一批工具调用(每个独立 60s 超时),按传入顺序返回结果。
   * 并行:DeepSeek 并行工具调用始终开启,互不依赖的调用并发跑;
   * 结果按序回填,UI 工具卡片顺序与 parts 顺序一致
   */
  async function executeToolBatch(
    batch: Array<{ id: string; name: string; args: Record<string, unknown> }>,
    map: Map<string, AgentTool>,
    list: AgentTool[],
  ): Promise<Array<{ id: string; name: string; ok: boolean; out: string; durationMs: number }>> {
    return Promise.all(
      batch.map(async ({ id, name, args }) => {
        const tool = map.get(name)
        const started = Date.now()
        let out: string
        let ok: boolean
        if (!tool) {
          out = `未知工具:${name}(可用工具:${list.map((t) => t.name).join('、')})`
          ok = false
        } else {
          try {
            out = await Promise.race([
              Promise.resolve(tool.execute(args)),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`工具执行超时(${TOOL_TIMEOUT_MS / 1000}s)`)), TOOL_TIMEOUT_MS),
              ),
            ])
            ok = true
          } catch (err) {
            out = `工具执行失败:${(err as Error).message}`
            ok = false
          }
        }
        return { id, name, ok, out, durationMs: Date.now() - started }
      }),
    )
  }

  /** 单轮完整循环(每轮由 send 启动,异常/中止都在这里收敛) */
  async function runTurn(text: string, history: AgentMessage[], ctx: TurnCtx) {
    const { signal, onEvent, config } = ctx
    onEvent({ type: 'status', status: 'thinking' })

    // 本轮历史 = 预算裁剪后的历史 + 用户消息 + 工具循环中追加的助手消息
    // (预算治理防 400:1M 上下文超出报错;裁剪仅在超限时触发,不破坏缓存)
    const historyIn: AgentMessage[] = [
      ...trimHistory(history),
      { id: randomUUID(), role: 'user', parts: [{ type: 'text', text }] },
    ]
    // 本轮助手消息的 parts(文本 / 工具调用 / 工具结果,按执行顺序累积)
    const msgParts: AgentPart[] = []
    // 已回填历史的 parts 数:每轮只把"新增部分"推给下一轮,
    // 避免整段累积 parts 重复回填(上下文成倍膨胀)
    let pushedParts = 0
    // reasoning 累积:流式事件旁路拦截(仅用于最终消息落定时展示)
    let reasoningText = ''
    let usage: { input: number; output: number; cached?: number } = { input: 0, output: 0 }

    for (let step = 1; step <= MAX_STEPS; step++) {
      if (signal.aborted) return
      const result = await streamByConfig({
        config,
        system: config.systemPrompt || '你是桌面灵动岛挂件里的个人助手。',
        history: historyIn,
        tools,
        signal,
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
      if (calls.length === 0) {
        // 纯文本回复:本轮结束,落定权威消息(reasoning 已在上方入列)
        onEvent({
          type: 'message',
          message: { id: randomUUID(), role: 'assistant', parts: msgParts },
          usage,
        })
        onEvent({ type: 'status', status: 'idle' })
        return
      }

      // 有工具调用:进入执行阶段(参数已全程可见:tool-call 事件先发)。
      // 并行执行:DeepSeek 并行工具调用始终开启,互不依赖的调用并发跑
      // (多个 delegate 即并行子代理);结果按调用顺序回填
      onEvent({ type: 'status', status: 'running' })
      const batch: Array<{ id: string; name: string; args: Record<string, unknown> }> = []
      for (const call of calls) {
        if (signal.aborted) return
        const args = parseToolArgs(call.args)
        msgParts.push({ type: 'tool-call', id: call.id, name: call.name, args })
        batch.push({ id: call.id, name: call.name, args })
      }
      const results = await executeToolBatch(batch, toolMap, tools)
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
      }

      // 把本轮新增的助手 parts(思维链 + 文本 + 调用 + 结果)回填历史,
      // 供下一轮上下文
      historyIn.push({ id: randomUUID(), role: 'assistant', parts: msgParts.slice(pushedParts) })
      pushedParts = msgParts.length
    }

    onEvent({ type: 'error', message: `工具循环超过 ${MAX_STEPS} 轮仍未完成,已停止(请拆解任务或换种思路再试)` })
    onEvent({ type: 'status', status: 'idle' })
  }

  return {
    get busy() {
      return running
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
      ctl = new AbortController()
      void runTurn(text, history, { config, signal: ctl.signal, onEvent: emit })
        .catch((err: unknown) => {
          if ((err as Error).name !== 'AbortError') {
            emit({ type: 'error', message: (err as Error).message || String(err) })
          }
        })
        .finally(() => {
          running = false
          ctl = null
        })
    },
    abort() {
      if (!running) return
      ctl?.abort()
      emit({ type: 'status', status: 'idle' })
    },
    listTools() {
      // 只暴露描述(名称/说明/参数 schema),不含执行函数
      return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
    },
  }
}
