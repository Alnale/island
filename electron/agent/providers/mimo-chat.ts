/**
 * MiMo Chat Completions API Provider(小米 MiMo 大模型 Chat Completions 兼容)
 *
 * 完全独立适配(不依赖 deepseek/chat/anthropic 业务模块):
 *   POST {baseURL}/v1/chat/completions,官方指南:
 *   https://mimo.mi.com/docs/zh-CN/api/chat/openai-api
 *
 * 兼容性要点(严格按官方文档):
 * - 端点:POST /v1/chat/completions;
 * - 认证:api-key 头(MiMo 原生)+ Authorization: Bearer(双兼容);
 * - 顶层参数:model / messages / max_completion_tokens(**注意:不是 max_tokens**)
 *   / temperature / top_p / stream / response_format / thinking / tools / tool_choice;
 * - thinking 参数:{type:'enabled'/'disabled'}(不是 reasoning 对象),多轮思考模式
 *   必须回传 reasoning_content;
 * - tools:function 工具 + web_search 内置联网搜索;
 * - response_format:{type:'text'/'json_object'};
 * - 流式:SSE 格式(OpenAI 兼容),data: {...} 帧,最后 data: [DONE];
 *   delta 字段:content / reasoning_content / tool_calls;
 * - 模型:mimo-v2.5-pro(默认 max 131072 tokens) / mimo-v2.5(默认 32768);
 * - thinking 模式下不支持自定义 temperature/top_p(强制 1.0/0.95)。
 *
 * 错误码(https://mimo.mi.com/docs/zh-CN/api/guidance/error-codes):
 *   400/401/402/403/404/421/429/500/503(421 = 内容拦截,403 = 地区/风控)
 */

import { parseSse, sanitizeJsonStrings, truncateResult } from './sse'
import { mimoErrorMessage } from './mimo-constants'
import type { AgentConfig, AgentEvent, AgentMessage, AgentPart, AgentTool, ProviderOutcome } from '../types'

/** 工具 → MiMo Chat Completions tools(function 嵌套格式) */
function mimoChatTools(tools: AgentTool[]) {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters, strict: false },
  }))
}

/** 文本 parts 拼接(user 消息 / assistant content) */
function mimoJoinText(parts: AgentPart[]): string {
  return parts
    .filter((p): p is Extract<AgentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

/** reasoning parts 拼接(回传给 API 的 reasoning_content) */
function mimoJoinReasoning(parts: AgentPart[]): string {
  return parts
    .filter((p): p is Extract<AgentPart, { type: 'reasoning' }> => p.type === 'reasoning')
    .map((p) => p.text)
    .join('\n')
}

/**
 * 历史消息 → MiMo Chat Completions messages:
 * - user → {role:'user', content};
 * - system → {role:'system', content}(MiMo 也支持 developer 角色,统一用 system);
 * - assistant → reasoning_content(思考模式回传) + content + tool_calls;
 * - 工具结果 → 独立的 {role:'tool', tool_call_id, content} 消息,紧跟对应 assistant。
 */
export function mimoHistoryToMessages(history: AgentMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const msg of history) {
    if (msg.role === 'user') {
      const text = mimoJoinText(msg.parts)
      if (text) out.push({ role: 'user', content: text })
      continue
    }
    if (msg.role === 'system') {
      const text = mimoJoinText(msg.parts)
      if (text) out.push({ role: 'system', content: text })
      continue
    }
    const reasoning = mimoJoinReasoning(msg.parts)
    const text = mimoJoinText(msg.parts)
    const calls = msg.parts.filter(
      (p): p is Extract<AgentPart, { type: 'tool-call' }> => p.type === 'tool-call',
    )
    const assistant: Record<string, unknown> = { role: 'assistant' }
    if (reasoning) assistant.reasoning_content = reasoning
    if (text) assistant.content = text
    if (calls.length > 0) {
      assistant.tool_calls = calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
      }))
    }
    if (assistant.reasoning_content || assistant.content || assistant.tool_calls) out.push(assistant)
    for (const p of msg.parts) {
      if (p.type === 'tool-result') {
        out.push({ role: 'tool', tool_call_id: p.id, content: truncateResult(p.result) })
      }
    }
  }
  return out
}

/**
 * 发起一次流式请求(MiMo Chat Completions API)。
 * 事件经 onEvent 实时转发(text-delta / reasoning-delta /
 * tool-partial-call / tool-call),完成后返回统一 ProviderOutcome。
 * - jsonMode:response_format {type:'json_object'}(prompt 需含 "json");
 * - noThinking:thinking {type:'disabled'}(短输出任务如总结标题用,
 *   避免思维链挤占输出预算;MiMo thinking 模式下 json_object 易返回空 content);
 * - maxOutputTokens:max_completion_tokens 覆盖(注意字段名不是 max_tokens)。
 */
export async function mimoStreamChatCompletion(params: {
  config: AgentConfig
  system: string
  history: AgentMessage[]
  tools: AgentTool[]
  signal: AbortSignal
  onEvent: (event: AgentEvent) => void
  jsonMode?: boolean
  noThinking?: boolean
  maxOutputTokens?: number
}): Promise<ProviderOutcome> {
  const { config, system, history, tools, signal, onEvent, jsonMode, noThinking, maxOutputTokens } = params
  const base = config.baseURL.trim().replace(/\/+$/, '')
  // 自动补全 /v1 前缀
  const url = base.includes('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`

  const thinkingEnabled = !noThinking && config.reasoningEffort !== 'none'

  const body: Record<string, unknown> = {
    model: config.model.trim() || 'mimo-v2.5-pro',
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...mimoHistoryToMessages(history),
    ],
    ...(tools.length > 0 ? { tools: mimoChatTools(tools), tool_choice: 'auto' } : {}),
    // MiMo 用 thinking:{type:enabled/disabled} 控制思考模式
    thinking: thinkingEnabled ? { type: 'enabled' } : { type: 'disabled' },
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    // **注意:MiMo Chat 用 max_completion_tokens,不是 max_tokens**
    max_completion_tokens: maxOutputTokens ?? 8192,
    stream: true,
  }

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 双认证兼容
        'api-key': config.apiKey.trim(),
        Authorization: `Bearer ${config.apiKey.trim()}`,
      },
      body: JSON.stringify(sanitizeJsonStrings(body)),
      // 不传 signal(规避 Node 22 llhttp UAF)
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    throw new Error(`无法连接 MiMo API(${url}):${(err as Error).message}`)
  }

  if (!res.ok || !res.body) {
    let detail = ''
    try {
      detail = (await res.text()).slice(0, 500)
    } catch {
      // 忽略读失败
    }
    throw new Error(mimoErrorMessage(res.status, detail))
  }

  // 流式工具调用按 index 累积(OpenAI 兼容格式)
  const callDeltas = new Map<number, { id: string; name: string; args: string }>()
  const textParts: string[] = []
  let usage: { input_tokens: number; output_tokens: number } | null = null
  let cachedTokens: number | undefined
  let truncated = false

  for await (const evt of parseSse(res.body, signal)) {
    const d = evt.data
    // 注意:Chat Completions SSE 帧没有 type 字段(OpenAI 格式),直接用 choices
    const choice = (Array.isArray(d.choices) ? d.choices[0] : undefined) as
      | Record<string, unknown>
      | undefined
    const delta = choice?.delta as Record<string, unknown> | undefined
    if (delta) {
      // 思维链增量(MiMo 字段 delta.reasoning_content)
      const rc = delta.reasoning_content
      if (typeof rc === 'string' && rc) onEvent({ type: 'reasoning-delta', text: rc })
      // 正文增量
      const content = delta.content
      if (typeof content === 'string' && content) {
        textParts.push(content)
        onEvent({ type: 'text-delta', text: content })
      }
      // 工具调用增量
      const tcs = delta.tool_calls
      if (Array.isArray(tcs)) {
        for (const tc of tcs as Array<Record<string, unknown>>) {
          const index = typeof tc.index === 'number' ? tc.index : 0
          const fn = tc.function as Record<string, unknown> | undefined
          const entry = callDeltas.get(index) ?? { id: '', name: '', args: '' }
          if (typeof tc.id === 'string' && tc.id) entry.id = tc.id
          if (typeof fn?.name === 'string' && fn.name) entry.name = fn.name
          if (typeof fn?.arguments === 'string' && fn.arguments) entry.args += fn.arguments
          callDeltas.set(index, entry)
          if (entry.id) {
            onEvent({ type: 'tool-partial-call', id: entry.id, name: entry.name, args: entry.args })
          }
        }
      }
    }
    // 末尾 chunk 带 usage(MiMo: prompt_tokens / completion_tokens /
    // prompt_tokens_details.cached_tokens)
    const u = d.usage as Record<string, unknown> | undefined
    if (u && typeof u.prompt_tokens === 'number') {
      usage = {
        input_tokens: u.prompt_tokens,
        output_tokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : 0,
      }
      const promptDetails = u.prompt_tokens_details as Record<string, unknown> | undefined
      if (promptDetails && typeof promptDetails.cached_tokens === 'number' && promptDetails.cached_tokens > 0) {
        cachedTokens = promptDetails.cached_tokens
      }
    }
    // 输出预算截断(finish_reason 'length' 或 'content_filter')
    if (choice?.finish_reason === 'length' || choice?.finish_reason === 'content_filter') truncated = true
    if (signal.aborted) throw new DOMException('aborted', 'AbortError')
  }

  // 收尾:流式结束,按 index 输出完整工具调用
  const calls: Array<{ id: string; name: string; args: string }> = []
  for (const entry of callDeltas.values()) {
    if (!entry.id) continue
    calls.push({ id: entry.id, name: entry.name, args: entry.args })
    onEvent({ type: 'tool-call', id: entry.id, name: entry.name, args: entry.args })
  }

  return {
    calls,
    text: textParts.join(''),
    usage: usage ? { ...usage, cached_tokens: cachedTokens } : null,
    aborted: signal.aborted,
    truncated: truncated || undefined,
  }
}
