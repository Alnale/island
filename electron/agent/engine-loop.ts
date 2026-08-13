/**
 * 主对话循环业务
 *
 * 职责:单轮完整对话循环(runTurn),包括系统提示组装、LLM 流式调用、
 * 手动调用处理、工具循环、消息落定。
 * 本文件自包含所有需要的常量和辅助函数(允许与工具执行模块的同名函数代码重复),
 * 不依赖其他 engine-* 拆分文件,仅依赖已有的独立模块(tools/mcp/subagents 等)。
 */

import { randomUUID } from 'node:crypto'
import { parseToolArgs } from './deepseek'
import { streamByConfig, detectProvider } from './provider'
import { MASTER_IDENTITY_LINE, REPLY_RESTRAINT_LINE } from './constants'
import { buildToolsGuideBlock } from './tools'
import { getTasksStatusBlock } from './tasks'
import { formatMemoryBlock } from './memory'
import { executeToolBatch } from './engine-tool-execution'
import { createTurnConfirmGate } from './engine-confirm-gate'
import type {
  AgentConfig,
  AgentEvent,
  AgentMessage,
  AgentPart,
  AgentTool,
  MediaAttachment,
  MemoryStoreLike,
} from './types'

/** 工具循环迭代上限(程序级保险) */
const MAX_STEPS = 1000
/** 单个工具执行兜底超时(ms) */
const TOOL_TIMEOUT_MS = 60_000

/**
 * 上下文预算治理
 * 按 token 粗估裁剪历史,超限从最旧丢弃
 */
const MAX_CONTEXT_TOKENS = 400_000
const MIN_KEEP_MESSAGES = 10

/**
 * 预算不足提示
 */
const BUDGET_TRUNCATE_HINT =
  '【系统提示,非用户输入】上一轮回复因输出预算(max_output_tokens)不足被截断。' +
  '如果当前任务需要更长的输出:请调用 set_output_budget 工具(action=get 查看当前预算,' +
  'action=set 按需调大,不必顶满上限),然后继续完成被截断的回复;' +
  '若任务已基本完成,直接给出收尾回复即可。'

/**
 * 主动陪伴回合内部指令
 */
const PROACTIVE_INSTRUCTION =
  '【系统主动任务,不是用户输入】用户已有一段时间没有与助手互动。' +
  '请基于当前对话语境、长期记忆与你的性格,主动说一两句自然、简短的话,开启或延续对话。' +
  '像真实的朋友那样——人是会用工具的:如果话题需要真实信息(后台任务进度、扫码登录等' +
  '等待状态、实时事件),就主动调用工具查证或顺手把事办了(web_search、查询后台任务状态、' +
  '用灵动岛设置工具帮用户调整挂件等),不要凭空猜测;但不要为了用工具而用工具,' +
  '把话说短、说自然,行动融入对话而不是罗列工具。' +
  '如果 hint 指示在群里冒泡活跃气氛:用 napcat 工具 send_group 发一条轻松、短、自然的' +
  '消息到群里(贴合群内氛围),然后在窗口回复里一句话汇报即可,不要长篇大论。' +
  '不要提及这是系统任务,不要长篇大论,不要解释你的行为。'

/**
 * 工具执行兜底超时(本文件用,与工具执行模块的同名函数代码重复——业务独立演化)
 */
function raceWithTimeout<T>(
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
 * 工具参数校验(本文件用,与工具执行模块的同名函数代码重复——业务独立演化)
 */
function validateRequiredArgs(
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
 * 估算消息 token 数
 */
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
 * 历史裁剪
 */
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

/**
 * 手动调用解析
 */
function parseManualCall(text: string): { name: string; rest: string } | null {
  if (!text.startsWith('/') && !text.startsWith('@')) return null
  const m = /^[/@]\s*(\S+)\s*([\s\S]*)$/.exec(text.trim())
  if (!m || !m[1]) return null
  return { name: m[1], rest: m[2] ?? '' }
}

/**
 * 手动调用匹配
 */
function findManualTool(
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

/**
 * 手动调用前缀分离
 */
function matchManualToolPrefix(
  tools: AgentTool[],
  name: string,
): { tool: AgentTool; rest: string } | null {
  let best: AgentTool | null = null
  let bestLen = 0
  for (const t of tools) {
    if (name.startsWith(t.name) && t.name.length > bestLen) {
      best = t
      bestLen = t.name.length
    }
  }
  if (!best) return null
  return { tool: best, rest: name.slice(bestLen).trim() }
}

interface TurnCtx {
  config: AgentConfig
  signal: AbortSignal
  onEvent: (event: AgentEvent) => void
}

interface RunTurnDeps {
  getConfig: () => AgentConfig
  getMemoryStore: () => MemoryStoreLike | null
  getEvolutionStatus: () => Promise<string>
  getExternalTools: () => Promise<AgentTool[]>
  excludedToolSet: () => Set<string>
  /** 完整内置工具列表(含 delegateTool),由入口组装后传入 */
  getBuiltinTools: () => AgentTool[]
  /** 可变输出预算引用 */
  outputBudgetRef: { get value(): number }
}

/**
 * 创建 runTurn 函数
 *
 * 工具列表由入口组装后通过 getBuiltinTools 传入,避免循环依赖
 */
export function createRunTurn(deps: RunTurnDeps) {
  async function getMemoryBlock(): Promise<string> {
    const store = deps.getMemoryStore()
    if (!store) return ''
    try {
      const entries = await store.list()
      return formatMemoryBlock(entries)
    } catch {
      return ''
    }
  }

  return async function runTurn(
    text: string,
    history: AgentMessage[],
    ctx: TurnCtx,
    opts: { proactive?: boolean; hint?: string } = {},
  ) {
    const { signal, onEvent, config } = ctx
    onEvent({ type: 'status', status: 'thinking' })

    const historyIn: AgentMessage[] = [...trimHistory(history)]
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
    const msgParts: AgentPart[] = []
    let pushedParts = 0
    let reasoningText = ''
    let usage: { input: number; output: number; cached?: number } = { input: 0, output: 0 }
    let truncateHinted = false

    const gate = createTurnConfirmGate(config)
    const turnConfirmGate = gate.check
    const tools = deps.getBuiltinTools()

    // 手动调用处理
    const manual = parseManualCall(text)
    if (manual) {
      const turnTools = [...tools, ...(await deps.getExternalTools())].filter(
        (t) => !deps.excludedToolSet().has(t.name),
      )
      let found = findManualTool(turnTools, manual.name)
      let rest = manual.rest
      if (!found.tool) {
        const prefixed = matchManualToolPrefix(turnTools, manual.name)
        if (prefixed) {
          found = { tool: prefixed.tool, hint: '' }
          rest = prefixed.rest + (rest ? ' ' + rest : '')
        }
      }
      if (!found.tool) {
        onEvent({ type: 'error', message: found.hint })
        onEvent({ type: 'status', status: 'idle' })
        return
      }
      onEvent({ type: 'status', status: 'running' })
      const id = randomUUID()
      let args: Record<string, unknown> = {}
      const restTrimmed = rest.trim()
      if (restTrimmed) {
        try {
          const parsed = JSON.parse(restTrimmed)
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
        const argError = validateRequiredArgs(found.tool, args)
        if (argError) throw new Error(argError)
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
      if (outImage) msgParts.push({ type: 'image', dataUrl: outImage })
      if (outMedia && outMedia.length > 0) {
        for (const m of outMedia) msgParts.push({ type: 'media', kind: m.kind, url: m.url, name: m.name })
      }
      if (detectProvider(config.baseURL) !== 'anthropic') {
        msgParts.unshift({ type: 'reasoning', text: `(手动调用工具:${found.tool.name})` })
      }
      historyIn.push({ id: randomUUID(), role: 'assistant', parts: msgParts.slice(0) })
      pushedParts = msgParts.length
    }

    for (let step = 1; step <= MAX_STEPS; step++) {
      if (signal.aborted) return
      const bgStatus = getTasksStatusBlock()
      const memoryBlock = await getMemoryBlock()
      const evolutionStatus = (await deps.getEvolutionStatus()) ?? ''
      const toolsGuide = buildToolsGuideBlock()
      const system = [
        config.systemPrompt || '你是桌面灵动岛挂件里的个人助手。',
        MASTER_IDENTITY_LINE,
        REPLY_RESTRAINT_LINE,
        memoryBlock,
        evolutionStatus,
        bgStatus,
        toolsGuide,
      ]
        .filter(Boolean)
        .join('\n\n')
      const turnTools = [...tools, ...(await deps.getExternalTools())].filter(
        (t) => !deps.excludedToolSet().has(t.name),
      )
      const turnMap = new Map(turnTools.map((t) => [t.name, t]))
      const result = await streamByConfig({
        config,
        system,
        history: historyIn,
        tools: turnTools,
        signal,
        maxOutputTokens: deps.outputBudgetRef.value,
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
      if (reasoningText) {
        msgParts.push({ type: 'reasoning', text: reasoningText })
        reasoningText = ''
      }
      const replyText = result.text
      if (replyText) msgParts.push({ type: 'text', text: replyText })
      const calls = result.calls
      if (calls.length === 0 && !result.truncated) {
        onEvent({
          type: 'message',
          message: { id: randomUUID(), role: 'assistant', parts: msgParts, proactive: opts.proactive || undefined },
          usage,
        })
        onEvent({ type: 'status', status: 'idle' })
        return
      }
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
        if (r.image) msgParts.push({ type: 'image', dataUrl: r.image })
        if (r.media && r.media.length > 0) {
          for (const m of r.media) msgParts.push({ type: 'media', kind: m.kind, url: m.url, name: m.name })
        }
      }
      historyIn.push({ id: randomUUID(), role: 'assistant', parts: msgParts.slice(pushedParts) })
      pushedParts = msgParts.length
      if (result.truncated && !truncateHinted) {
        truncateHinted = true
        historyIn.push({ id: randomUUID(), role: 'system', parts: [{ type: 'text', text: BUDGET_TRUNCATE_HINT }] })
      }
    }

    onEvent({ type: 'error', message: `工具循环超过 ${MAX_STEPS} 轮仍未完成,已停止(请拆解任务或换种思路再试)` })
    onEvent({ type: 'status', status: 'idle' })
  }
}

// 导出供测试使用
export {
  MAX_STEPS,
  TOOL_TIMEOUT_MS,
  MAX_CONTEXT_TOKENS,
  MIN_KEEP_MESSAGES,
  estimateMessageTokens,
  trimHistory,
  parseManualCall,
  findManualTool,
  matchManualToolPrefix,
  validateRequiredArgs,
  raceWithTimeout,
}
