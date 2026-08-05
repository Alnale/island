/**
 * DeepSeek Responses API Provider
 *
 * 裸 fetch + SSE 解析(不依赖 AI SDK,引擎零第三方依赖):
 *   POST {baseURL}/responses(base_url = https://api.deepseek.com,
 *   官方指南:https://api-docs.deepseek.com/zh-cn/guides/responses_api,
 *   API 参考:https://api-docs.deepseek.com/zh-cn/api/create-response)
 *
 * 兼容性要点(严格按官方"兼容性明细"表):
 * - 顶层参数:model / input / instructions / stream / temperature /
 *   top_p / max_output_tokens / tools(function / web_search)/
 *   tool_choice / reasoning(effort 支持)/ text.format / user;
 *   不支持的参数被静默忽略,无状态 API(previous_response_id 等不支持);
 * - 输入 Items:message(content 支持字符串与 input_text / output_text
 *   内容块;**不支持 reasoning 内容块**,实测塞进 message content 会 400
 *   "unknown variant 'reasoning'")、function_call(归并到相邻 assistant
 *   消息)、function_call_output、reasoning(明文 content 归并到相邻
 *   assistant 消息;summary / encrypted_content 不支持);
 * - 流式:stream: true,事件带 event 字段与递增 sequence_number,
 *   以 response.completed / .incomplete / .failed 结束,没有 [DONE]。
 *
 * 流式事件:response.created → response.output_item.added →
 * response.output_text.delta / response.reasoning_text.delta /
 * response.function_call_arguments.delta → response.output_item.done →
 * response.completed / .incomplete / .failed
 */

import type { AgentConfig, AgentEvent, AgentMessage, AgentPart, AgentTool, ProviderOutcome } from './types'

/** SSE 解析出的单条事件 */
interface SseEvent {
  type: string
  data: unknown
}

/** 工具调用流式累积器 */
interface StreamCall {
  id: string
  name: string
  args: string
}

/**
 * 历史消息 → Responses API 的 input items(严格按官方文档:
 * https://api-docs.deepseek.com/zh-cn/guides/responses_api 输入 Items 表):
 * - user 消息 → message(role=user, content=input_text 块);
 * - assistant 消息:
 *   reasoning part → 独立 reasoning item(明文 content 归并到相邻
 *     assistant 消息;message 内容块不支持 reasoning 类型,塞进去 400);
 *   连续文本 → message(role=assistant, content=output_text 块);
 *   工具调用 → function_call 项(归并到相邻 assistant 消息);
 *   工具结果 → function_call_output 项(引用 call_id)。
 */
export function historyToItems(history: AgentMessage[]): unknown[] {
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
    // assistant:reasoning 先输出(思维链先于回复,归并到相邻助手消息),
    // 再按 parts 顺序展开文本与工具调用
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
          // 结果截断回填(参考后端 token 预算治理):完整结果已走事件给 UI
          output: part.result.length > 8000 ? part.result.slice(0, 8000) + '\n…(已截断)' : part.result,
        })
      }
    }
    flushText()
  }
  return items
}

/** 解析 SSE 字节流:按空行分帧,取 data: 的 JSON(OpenAI 兼容格式) */
async function* parseSse(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let sep: number
      while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const frame = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        const dataLine = frame
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => l.startsWith('data:'))
        if (!dataLine) continue
        const payload = dataLine.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          const parsed = JSON.parse(payload)
          if (parsed && typeof parsed.type === 'string') {
            yield { type: parsed.type, data: parsed }
          }
        } catch {
          // 非 JSON 帧(注释/心跳)跳过
        }
      }
      if (signal.aborted) throw new DOMException('aborted', 'AbortError')
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * 发起一次流式请求(DeepSeek Responses API,官方指南 + API 参考:
 * https://api-docs.deepseek.com/zh-cn/guides/responses_api
 * https://api-docs.deepseek.com/zh-cn/api/create-response)。
 * 事件经 onEvent 实时转发(text-delta / reasoning-delta /
 * tool-partial-call / tool-call),完成后返回统一 ProviderOutcome。
 * - jsonMode:text.format {type:'json_object'}(API 参考:text.format
 *   支持 text / json_object / json_schema;prompt 需含 "json" 字样);
 * - noThinking:reasoning.effort 'none'(API 参考:effort 值域
 *   none/minimal/low/medium/high/xhigh/max,none = 关闭思考模式;
 *   短输出任务如总结标题用它,避免思维链挤占输出预算)。
 * 失败抛 Error(调用方转成 error 事件);中止抛 AbortError。
 */
export async function streamResponse(params: {
  config: AgentConfig
  system: string
  history: AgentMessage[]
  tools: AgentTool[]
  signal: AbortSignal
  onEvent: (event: AgentEvent) => void
  jsonMode?: boolean
  noThinking?: boolean
}): Promise<ProviderOutcome> {
  const { config, system, history, tools, signal, onEvent, jsonMode, noThinking } = params
  const base = config.baseURL.trim().replace(/\/+$/, '')
  const url = `${base}/responses`

  const body: Record<string, unknown> = {
    model: config.model.trim() || 'deepseek-v4-flash',
    instructions: system,
    input: historyToItems(history),
    // 有工具才带 tools/tool_choice(静默总结等无工具请求不带,
    // 请求体最小化,规避空数组边界)
    ...(tools.length > 0
      ? {
          tools: tools.map((t) => ({
            type: 'function',
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
          tool_choice: 'auto',
        }
      : {}),
    // 官方 API 参考:reasoning.effort 值域 none/minimal/low/medium/high/
    // xhigh/max;none = 关闭思考模式;配置值直通(设置页可选"关")
    reasoning: { effort: noThinking ? 'none' : config.reasoningEffort || 'high' },
    // JSON 输出(API 参考 text.format):json_object 模式;
    // 官方 json_mode 指南:prompt 必须含 "json" 字样(调用方保证)
    ...(jsonMode ? { text: { format: { type: 'json_object' } } } : {}),
    // 输出上限:单轮回复防失控(含思维链 token,官方:384K 上限,
    // 不设会烧输出 token)
    max_output_tokens: 4096,
    stream: true,
  }

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey.trim()}`,
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    throw new Error(`无法连接 DeepSeek API(${url}):${(err as Error).message}`)
  }

  if (!res.ok || !res.body) {
    let detail = ''
    try {
      const text = await res.text()
      detail = text.slice(0, 500)
    } catch {
      // 忽略读失败
    }
    throw new Error(`DeepSeek API 请求失败 HTTP ${res.status}:${detail}`)
  }

  const calls = new Map<string, StreamCall>()
  const textParts: string[] = []
  // 输出项(按出现顺序,response.completed 前补全):
  // 官方事件的 output_item 只含增量,completed 才带完整 output;
  // 这里只需 usage(参数/文本已由事件增量收集)
  let usage: { input_tokens: number; output_tokens: number } | null = null

  for await (const evt of parseSse(res.body, signal)) {
    const d = evt.data as Record<string, unknown>
    switch (evt.type) {
      case 'response.output_item.added': {
        const item = d.item as Record<string, unknown> | undefined
        if (item?.type === 'function_call' && typeof item.call_id === 'string') {
          const call: StreamCall = {
            id: item.call_id,
            name: typeof item.name === 'string' ? item.name : '',
            args: typeof item.arguments === 'string' ? item.arguments : '',
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
          // reasoning 只作 UI 展示转发,不在此收集
          onEvent({ type: 'reasoning-delta', text })
        }
        break
      }
      case 'response.function_call_arguments.delta': {
        const id = typeof d.call_id === 'string' ? d.call_id : ''
        const delta = typeof d.delta === 'string' ? d.delta : ''
        const call = calls.get(id)
        if (!call) continue
        call.args += delta
        onEvent({ type: 'tool-partial-call', id: call.id, name: call.name, args: call.args })
        break
      }
      case 'response.output_item.done': {
        const item = d.item as Record<string, unknown> | undefined
        if (item?.type === 'function_call' && typeof item.call_id === 'string') {
          const call = calls.get(item.call_id)
          if (call) {
            // 收尾:部分平台只走 done 不带完整 arguments,用最终值
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
          // 缓存命中:input_tokens_details.cached_tokens(上下文硬盘缓存,
          // 前缀完整匹配才命中;官方文档:自动开启、按前缀单元落盘)
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
        break
      }
      case 'response.failed': {
        const err = d.error as Record<string, unknown> | undefined
        throw new Error(`DeepSeek 响应失败:${String(err?.message ?? '未知错误')}`)
      }
      case 'response.error': {
        const err = d.error as Record<string, unknown> | undefined
        throw new Error(`DeepSeek 错误:${String(err?.message ?? '未知错误')}`)
      }
      default:
        break
    }
    if (signal.aborted) throw new DOMException('aborted', 'AbortError')
  }

  // 统一返回(事件已实时转发,calls/text 为权威汇总)
  return {
    calls: [...calls.values()].map((c) => ({ id: c.id, name: c.name, args: c.args })),
    text: textParts.join(''),
    usage,
    aborted: signal.aborted,
  }
}

/** 解析工具参数 JSON(容错:非对象/空串 → {}) */
export function parseToolArgs(raw: string): Record<string, unknown> {
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
