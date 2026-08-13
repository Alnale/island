/**
 * MiMo Responses API Provider(小米 MiMo 大模型 Responses API 兼容)
 *
 * 完全独立适配(不依赖 deepseek/chat/anthropic 业务模块):
 *   POST {baseURL}/v1/responses,官方指南:
 *   https://mimo.mi.com/docs/zh-CN/api/chat/responses
 *
 * 兼容性要点(严格按官方"兼容性说明与限制"):
 * - 顶层参数:model / input / instructions / stream / temperature /
 *   top_p / max_output_tokens / tools(function) / tool_choice /
 *   reasoning(effort: none/low/medium/high,但 low/medium/high 效果一致)/
 *   text.format;不支持 background / previous_response_id / context_management;
 * - 输入 Items:与 OpenAI Responses 格式对齐,支持 message(input_text/
 *   output_text)、function_call、function_call_output、reasoning;
 * - 流式:SSE 事件 response.created → response.output_item.added →
 *   response.output_text.delta / response.reasoning_text.delta /
 *   response.function_call_arguments.delta → response.output_item.done →
 *   response.completed / .incomplete;
 * - 认证:支持 api-key 头(MiMo 原生)和 Authorization: Bearer(兼容 OpenAI);
 * - 模型:mimo-v2.5-pro / mimo-v2.5;
 * - 思考模式:reasoning.effort = none 关闭,其余均开启(无强度区分)。
 *
 * 错误码(https://mimo.mi.com/docs/zh-CN/api/guidance/error-codes):
 *   400 格式错误 / 401 认证失败 / 402 余额不足 / 403 拒绝访问(地区/风控)/
 *   404 资源未找到 / 421 内容拦截 / 429 请求超限 / 500 服务器失败 / 503 故障
 */

import { parseSse, sanitizeJsonStrings, truncateResult } from './sse'
import { mimoErrorMessage } from './mimo-constants'
import type { AgentConfig, AgentEvent, AgentMessage, AgentPart, AgentTool, ProviderOutcome } from './types'

/** 工具调用流式累积器(MiMo  Responses 格式:item_id + output_index 匹配) */
interface MimoStreamCall {
  id: string
  name: string
  args: string
  itemId?: string
  outputIndex?: number
}

/**
 * 增量/收尾事件 → 匹配回对应的工具调用。
 * MiMo Responses 事件字段分布(参考官方文档):
 * - output_item.added/.done:带 item.call_id / item.id / output_index;
 * - function_call_arguments.delta/.done:带 item_id + output_index +
 *   arguments(部分实现可能带 call_id,按优先级依次尝试)
 */
function mimoFindCall(d: Record<string, unknown>, calls: Map<string, MimoStreamCall>): MimoStreamCall | null {
  if (typeof d.call_id === 'string') {
    const c = calls.get(d.call_id)
    if (c) return c
  }
  if (typeof d.output_index === 'number') {
    for (const c of calls.values()) if (c.outputIndex === d.output_index) return c
  }
  if (typeof d.item_id === 'string') {
    for (const c of calls.values()) if (c.itemId === d.item_id) return c
  }
  return null
}

/**
 * 历史消息 → MiMo Responses API 的 input items(对齐官方 InputItemList):
 * - user → message(role=user, content=input_text 块);
 * - system/developer → message(role=system 或 developer,content=input_text);
 * - assistant:reasoning 先输出(独立 reasoning item),再文本/工具调用;
 * - 工具调用 → function_call 项;工具结果 → function_call_output 项引用 call_id。
 */
export function mimoHistoryToItems(history: AgentMessage[]): unknown[] {
  const items: unknown[] = []
  for (const msg of history) {
    if (msg.role === 'user') {
      const text = msg.parts
        .filter((p): p is Extract<AgentPart, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('\n')
      if (text) items.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] })
      continue
    }
    // system 角色:MiMo Responses 支持 system/developer 角色,追加在 input 中
    if (msg.role === 'system') {
      const text = msg.parts
        .filter((p): p is Extract<AgentPart, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('\n')
      if (text) items.push({ type: 'message', role: 'system', content: [{ type: 'input_text', text }] })
      continue
    }
    // assistant:reasoning 先输出(思维链独立项),再按序展开文本与工具调用
    const reasoning = msg.parts
      .filter((p): p is Extract<AgentPart, { type: 'reasoning' }> => p.type === 'reasoning')
      .map((p) => p.text)
      .join('\n')
    if (reasoning) {
      items.push({ type: 'reasoning', content: [{ type: 'reasoning_text', text: reasoning }] })
    }
    let pendingText = ''
    const flushText = () => {
      if (!pendingText) return
      items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: pendingText }] })
      pendingText = ''
    }
    for (const part of msg.parts) {
      if (part.type === 'text') {
        pendingText += pendingText ? '\n' + part.text : part.text
      } else if (part.type === 'tool-call') {
        flushText()
        items.push({
          type: 'function_call',
          call_id: part.id,
          name: part.name,
          arguments: JSON.stringify(part.args ?? {}),
        })
      } else if (part.type === 'tool-result') {
        items.push({
          type: 'function_call_output',
          call_id: part.id,
          output: truncateResult(part.result),
        })
      }
    }
    flushText()
  }
  return items
}

/**
 * 发起一次流式请求(MiMo Responses API)。
 * 事件经 onEvent 实时转发(text-delta / reasoning-delta /
 * tool-partial-call / tool-call),完成后返回统一 ProviderOutcome。
 * - jsonMode:text.format {type:'json_object'};
 * - noThinking:reasoning.effort 'none'(关闭思考模式,短任务如总结用);
 * - maxOutputTokens:max_output_tokens 覆盖(mimo-v2.5-pro 默认 131072,
 *   mimo-v2.5 默认 32768,主对话循环传合适值防失控)。
 * 失败抛 Error;中止抛 AbortError。
 */
export async function mimoStreamResponse(params: {
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
  // 自动补全 /v1 前缀(用户可能只填到域名)
  const url = base.includes('/v1') ? `${base}/responses` : `${base}/v1/responses`

  const body: Record<string, unknown> = {
    model: config.model.trim() || 'mimo-v2.5-pro',
    instructions: system,
    input: mimoHistoryToItems(history),
    ...(tools.length > 0
      ? {
          tools: tools.map((t) => ({
            type: 'function',
            name: t.name,
            description: t.description,
            parameters: t.parameters,
            strict: false,
          })),
          tool_choice: 'auto',
        }
      : {}),
    // reasoning.effort: none 关闭思考,其余均开启(MiMo 无强度区分)
    reasoning: { effort: noThinking ? 'none' : (config.reasoningEffort === 'none' ? 'none' : 'high') },
    ...(jsonMode ? { text: { format: { type: 'json_object' } } } : {}),
    max_output_tokens: maxOutputTokens ?? 8192,
    stream: true,
  }

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 双认证兼容:优先 api-key 头(MiMo 原生),同时带 Bearer 兜底
        'api-key': config.apiKey.trim(),
        Authorization: `Bearer ${config.apiKey.trim()}`,
      },
      body: JSON.stringify(sanitizeJsonStrings(body)),
      // 不传 signal(规避 Node 22 llhttp UAF,见 sse.ts parseSse 注释)
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

  const calls = new Map<string, MimoStreamCall>()
  const textParts: string[] = []
  let usage: { input_tokens: number; output_tokens: number; cached_tokens?: number } | null = null
  let truncated = false

  for await (const evt of parseSse(res.body, signal)) {
    const d = evt.data as Record<string, unknown>
    switch (evt.type) {
      case 'response.output_item.added': {
        const item = d.item as Record<string, unknown> | undefined
        if (item?.type === 'function_call' && typeof item.call_id === 'string') {
          const call: MimoStreamCall = {
            id: item.call_id,
            name: typeof item.name === 'string' ? item.name : '',
            args: typeof item.arguments === 'string' ? item.arguments : '',
            itemId: typeof item.id === 'string' ? item.id : undefined,
            outputIndex: typeof d.output_index === 'number' ? d.output_index : undefined,
          }
          calls.set(call.id, call)
          onEvent({ type: 'tool-call', id: call.id, name: call.name, args: call.args })
        }
        break
      }
      case 'response.output_text.delta': {
        const text = typeof d.delta === 'string' ? d.delta : ''
        if (text) {
          textParts.push(text)
          onEvent({ type: 'text-delta', text })
        }
        break
      }
      case 'response.reasoning_text.delta': {
        const text = typeof d.delta === 'string' ? d.delta : ''
        if (text) {
          onEvent({ type: 'reasoning-delta', text })
        }
        break
      }
      case 'response.function_call_arguments.delta': {
        const delta = typeof d.delta === 'string' ? d.delta : ''
        if (!delta) break
        const call = mimoFindCall(d, calls)
        if (!call) continue
        call.args += delta
        onEvent({ type: 'tool-partial-call', id: call.id, name: call.name, args: call.args })
        break
      }
      case 'response.function_call_arguments.done': {
        const args = typeof d.arguments === 'string' ? d.arguments : ''
        const call = mimoFindCall(d, calls)
        if (!call) continue
        call.args = args
        onEvent({ type: 'tool-call', id: call.id, name: call.name, args: call.args })
        break
      }
      case 'response.output_item.done': {
        const item = d.item as Record<string, unknown> | undefined
        if (item?.type === 'function_call' && typeof item.call_id === 'string') {
          const call = calls.get(item.call_id)
          if (call) {
            if (typeof item.id === 'string') call.itemId = item.id
            if (typeof d.output_index === 'number') call.outputIndex = d.output_index
            call.args =
              typeof item.arguments === 'string' && item.arguments.length > call.args.length
                ? item.arguments
                : call.args
            onEvent({ type: 'tool-call', id: call.id, name: call.name, args: call.args })
          }
        }
        break
      }
      case 'response.completed': {
        const resp = d.response as Record<string, unknown> | undefined
        const u = resp?.usage as Record<string, unknown> | undefined
        if (u) {
          const details = u.input_tokens_details as Record<string, unknown> | undefined
          usage = {
            input_tokens: typeof u.input_tokens === 'number' ? u.input_tokens : 0,
            output_tokens: typeof u.output_tokens === 'number' ? u.output_tokens : 0,
            cached_tokens:
              typeof details?.cached_tokens === 'number' ? details.cached_tokens : undefined,
          }
        }
        break
      }
      case 'response.incomplete': {
        const reason = (d.incomplete_details as Record<string, unknown> | undefined)?.reason ?? d.reason ?? '未知原因'
        console.warn(`[agent] MiMo 响应不完整:${String(reason)}`)
        truncated = true
        break
      }
      case 'response.failed': {
        const err = d.error as Record<string, unknown> | undefined
        throw new Error(`MiMo 响应失败:${String(err?.message ?? '未知错误')}`)
      }
      case 'response.error': {
        const err = d.error as Record<string, unknown> | undefined
        throw new Error(`MiMo 错误:${String(err?.message ?? '未知错误')}`)
      }
      default:
        break
    }
    if (signal.aborted) throw new DOMException('aborted', 'AbortError')
  }

  return {
    calls: [...calls.values()].map((c) => ({ id: c.id, name: c.name, args: c.args })),
    text: textParts.join(''),
    usage,
    aborted: signal.aborted,
    truncated: truncated || undefined,
  }
}

/** 解析 MiMo 工具参数 JSON(容错:非对象/空串 → {}) */
export function mimoParseToolArgs(raw: string): Record<string, unknown> {
  const text = raw.trim()
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return { _raw: text }
  }
}
