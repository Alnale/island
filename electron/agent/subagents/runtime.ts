/**
 * Sub Agent 能力内核
 *
 * 所有后台 Sub Agent(总结/揣测/主动陪伴/判定器/进化评估)共用这一层:
 * 配置解析、超时、鉴权、输入压缩、同源上下文、JSON 单轮重试。
 * 工厂只声明「拼什么提示、怎么解析」,不再各自复制一遍调用脚手架。
 *
 * 与主对话引擎零共享:每次调用独立读配置、独立 AbortSignal;
 * 失败由工厂给 fallback,绝不外溢到主循环。
 */

import { getDefaultLlmRuntime, type LlmStreamParams } from '../plugin/llm'
import { isLMStudioProvider } from '../providers/lmstudio-constants'
import { formatMemoryBlock } from '../memory'
import { getTasksStatusBlock } from '../tasks'
import { compressArgs } from './subagents-helpers'
import type {
  AgentConfig,
  AgentMessage,
  AgentPart,
  EvolutionLike,
  MemoryStoreLike,
  ProviderOutcome,
} from '../types'

export type SubStream = (params: LlmStreamParams) => Promise<ProviderOutcome>

/** 缺省 LLM 流(经接缝默认运行时;工厂可注入替换) */
export const defaultSubStream: SubStream = (params) => getDefaultLlmRuntime().stream(params)

/**
 * Sub 供应商解析:subProvider 指定桶,subModel 覆盖 model;
 * 桶凭据不全回退主配置(空 model 硬撞本地端点会静默失败,2026-08-19)
 */
export function resolveSubConfig(config: AgentConfig): AgentConfig {
  const pid = config.subProvider ?? config.activeProvider
  const creds = config.providers?.[pid]
  const subModel = (config.subModel ?? '').trim()
  if (!creds || (!creds.model && !subModel)) return config
  if (pid === config.activeProvider && !subModel) return config
  return {
    ...config,
    apiKey: creds.apiKey,
    baseURL: creds.baseURL,
    model: subModel || creds.model,
  }
}

/**
 * Sub 任务超时。后台静默任务(总结/揣测/判断)指向 LM Studio 时放宽到
 * 300s——本地思维链动辄数分钟,云端 20-90s 会把 Sub 全部掐死。
 * 路径同步等待(QQ 路由判定)传 extendLocal:false,超时必须短。
 */
export function subTimeout(
  config: AgentConfig,
  baseMs: number,
  opts?: { extendLocal?: boolean },
): AbortSignal {
  const extend = opts?.extendLocal !== false
  const ms = extend && isLMStudioProvider(config.baseURL) ? Math.max(baseMs, 300000) : baseMs
  return AbortSignal.timeout(ms)
}

/** apiKey 空时仅 LM Studio 本地端点放行(与 engine.ts 同款规则) */
export function subKeyReady(config: AgentConfig): boolean {
  if (config.apiKey.trim()) return true
  const u = (config.baseURL || '').toLowerCase()
  return (
    config.activeProvider === 'lmstudio' ||
    u.includes('lmstudio') ||
    u.includes('127.0.0.1:1234') ||
    u.includes('localhost:1234')
  )
}

/** 一次调用的配置快照:已解析 Sub 桶 + 是否可发 */
export function prepareSubCall(getConfig: () => AgentConfig): { config: AgentConfig; ready: boolean } {
  const config = resolveSubConfig(getConfig())
  return { config, ready: subKeyReady(config) }
}

export interface CompressMessagesOpts {
  /** 最多保留最近 N 条,缺省 12 */
  limit?: number
  reasoning?: number
  toolResult?: number
  /** 文本截断;0/缺省 = 不截 */
  text?: number
}

/** 输入压缩(标签/判断只需主题,大参数是超时隐藏原因) */
export function compressMessages(messages: AgentMessage[], opts: CompressMessagesOpts = {}): AgentMessage[] {
  const limit = opts.limit ?? 12
  const reasoning = opts.reasoning ?? 500
  const toolResult = opts.toolResult ?? 2000
  const text = opts.text ?? 0
  return messages.slice(-limit).map((m) => ({
    ...m,
    parts: m.parts.map((p) => {
      if (p.type === 'reasoning') return { ...p, text: p.text.slice(0, reasoning) }
      if (p.type === 'tool-result') return { ...p, result: p.result.slice(0, toolResult) }
      if (p.type === 'tool-call') return { ...p, args: compressArgs(p.args) as Record<string, unknown> }
      if (p.type === 'text' && text > 0 && p.text.length > text) {
        return { ...p, text: p.text.slice(0, text) + '…' }
      }
      return p
    }),
  }))
}

/** 后台标签默认压缩:最近 12 条,文本截 200 */
export function recentMessages(messages: AgentMessage[]): AgentMessage[] {
  return compressMessages(messages, { limit: 12, reasoning: 500, toolResult: 2000, text: 200 })
}

/** 判定器/评估器用的单条 user 历史 */
export function singleUserHistory(id: string, text: string): AgentMessage[] {
  return [{ id, role: 'user', parts: [{ type: 'text', text }] }]
}

export interface SubContextBlocks {
  memoryBlock: string
  evolutionStatus: string
  bgStatus: string
  groupStatus: string
}

/** 与主引擎同源的上下文块(记忆/进化/后台任务/群状态);缺失静默省略 */
export async function loadSubContext(deps: {
  getMemoryStore?(): MemoryStoreLike | null
  getEvolution?(): EvolutionLike | null
  getGroupStatus?(): Promise<string>
}): Promise<SubContextBlocks> {
  let memoryBlock = ''
  try {
    memoryBlock = formatMemoryBlock((await deps.getMemoryStore?.()?.list()) ?? [])
  } catch {
    // 省略
  }
  let evolutionStatus = ''
  try {
    evolutionStatus = (await deps.getEvolution?.()?.getStatus()) ?? ''
  } catch {
    // 省略
  }
  let groupStatus = ''
  try {
    groupStatus = (await deps.getGroupStatus?.()) ?? ''
  } catch {
    // 省略
  }
  return { memoryBlock, evolutionStatus, bgStatus: getTasksStatusBlock(), groupStatus }
}

export function currentTimeBlock(): string {
  const now = new Date()
  return (
    `当前时间:${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ` +
    `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  )
}

export interface RunSubJsonOpts<T> {
  config: AgentConfig
  stream: SubStream
  system: string
  history: AgentMessage[]
  timeoutMs: number
  parse: (text: string) => T | null
  fallback: T
  /** 解析出值但仍判无效时重试(如空数组/空串) */
  accept?: (value: T) => boolean
  retries?: number
  jsonMode?: boolean
  noThinking?: boolean
  /** 路径等待不放宽本地 300s,缺省 true(后台任务放宽) */
  extendLocalTimeout?: boolean
  maxOutputTokens?: number
}

/**
 * JSON 单轮 + 一次重试的共用执行器。
 * 解析失败/不可接受/调用失败 → 重试;全部失败返回 fallback(安全侧)。
 * 标题降级链与心理揣测反馈重试太特殊,不走本函数。
 */
export async function runSubJson<T>(opts: RunSubJsonOpts<T>): Promise<T> {
  const retries = opts.retries ?? 2
  const jsonMode = opts.jsonMode !== false
  const noThinking = opts.noThinking !== false
  for (let retry = 0; retry < retries; retry++) {
    try {
      const result = await opts.stream({
        config: { ...opts.config, reasoningEffort: 'low' },
        system: opts.system,
        history: opts.history,
        tools: [],
        signal: subTimeout(opts.config, opts.timeoutMs, { extendLocal: opts.extendLocalTimeout }),
        onEvent: () => {},
        jsonMode,
        noThinking,
        maxOutputTokens: opts.maxOutputTokens,
      })
      if (result.aborted) {
        if (retry === retries - 1) break
        continue
      }
      const parsed = opts.parse(result.text)
      if (parsed == null) {
        if (retry === retries - 1) break
        continue
      }
      if (opts.accept && !opts.accept(parsed)) {
        if (retry === retries - 1) break
        continue
      }
      return parsed
    } catch {
      if (retry === retries - 1) break
    }
  }
  return opts.fallback
}

/** 文本 part 过滤(心理揣测:工具语法会诱发幻觉) */
export function textReasoningOnly(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((m) => ({
    ...m,
    parts: m.parts.filter((p): p is Extract<AgentPart, { type: 'text' | 'reasoning' }> => p.type === 'text' || p.type === 'reasoning'),
  }))
}
