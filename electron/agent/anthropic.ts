/**
 * Anthropic Messages API Provider(Anthropic 协议兼容端点)
 *
 * 适用:DeepSeek Anthropic 兼容端点(https://api.deepseek.com/anthropic,
 * 官方指南:https://api-docs.deepseek.com/zh-cn/guides/anthropic_api)或
 * 原生 Anthropic(https://api.anthropic.com)。引擎按 baseURL 是否含
 * "anthropic" 自动切换本 provider。
 *
 * POST {baseURL}/v1/messages,鉴权头 x-api-key + anthropic-version。
 * 与 DeepSeek Chat Completions 的格式差异(核心):
 * - max_tokens 必填;
 * - 角色严格交替(相邻同角色消息必须合并);
 * - 工具结果不能放在助手消息里,必须打包进**下一条 user 消息**的
 *   tool_result 块(parts 模型里 tool-call/tool-result 成对,序列化时
 *   把 tool-result 重排到紧随的 user 消息);
 * - 同一条助手消息里 tool_use 块之后不能再有文本;
 * - 工具参数是流式 JSON delta(input_json_delta.partial_json)。
 *
 * SSE 事件:message_start → content_block_start(text/tool_use) →
 * content_block_delta(text_delta / input_json_delta) → content_block_stop
 * → message_delta(usage) → message_stop / error。
 */

import type { AgentConfig, AgentEvent, AgentMessage, AgentPart, AgentTool, ProviderOutcome } from './types'

/** 历史 → Anthropic messages(工具结果重排 + 相邻同角色合并) */
export function historyToAnthropic(history: AgentMessage[]): Array<{ role: 'user' | 'assistant'; content: unknown[] }> {
  const msgs: Array<{ role: 'user' | 'assistant'; content: unknown[] }> = []

  const pushBlock = (role: 'user' | 'assistant', block: unknown) => {
    const last = msgs[msgs.length - 1]
    if (last && last.role === role) last.content.push(block)
    else msgs.push({ role, content: [block] })
  }

  for (const msg of history) {
    if (msg.role === 'user') {
      const text = msg.parts
        .filter((p): p is Extract<AgentPart, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('\n')
      if (text) pushBlock('user', { type: 'text', text })
      continue
    }
    // assistant:文本块与 tool_use 按序;tool_result 收集后打包进下一条
    // user 消息(Anthropic 不允许工具结果出现在助手消息里)
    const pendingResults: unknown[] = []
    for (const part of msg.parts) {
      if (part.type === 'text') {
        pushBlock('assistant', { type: 'text', text: part.text })
      } else if (part.type === 'tool-call') {
        pushBlock('assistant', {
          type: 'tool_use',
          id: part.id,
          name: part.name,
          input: part.args ?? {},
        })
      } else if (part.type === 'tool-result') {
        pendingResults.push({
          type: 'tool_result',
          tool_use_id: part.id,
          content: part.result.length > 8000 ? part.result.slice(0, 8000) + '\n…(已截断)' : part.result,
        })
      }
    }
    for (const block of pendingResults) pushBlock('user', block)
  }

  // 空 content 的助手消息(纯工具调用的消息已由 tool_use 块填充,
  // 理论上不会出现;防御:合并进上一条)
  const filtered = msgs.filter((m) => m.content.length > 0)
  // 角色严格交替:连续同角色已由 pushBlock 合并,最后再校验一次
  for (let i = filtered.length - 1; i > 0; i--) {
    if (filtered[i].role === filtered[i - 1].role) {
      filtered[i - 1].content.push(...filtered[i].content)
      filtered.splice(i, 1)
    }
  }
  return filtered
}

/** 工具 → Anthropic tools(input_schema 必须是 object) */
function anthropicTools(tools: AgentTool[]) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }))
}

/**
 * 流式请求(与 streamChatCompletion 同构):
 * 事件经 onEvent 实时转发,完成后返回统一 ProviderOutcome。
 */
export async function streamAnthropic(params: {
  config: AgentConfig
  system: string
  history: AgentMessage[]
  tools: AgentTool[]
  signal: AbortSignal
  onEvent: (event: AgentEvent) => void
}): Promise<ProviderOutcome> {
  const { config, system, history, tools, signal, onEvent } = params
  const base = config.baseURL.trim().replace(/\/+$/, '')
  const url = `${base}/v1/messages`

  const body: Record<string, unknown> = {
    model: config.model.trim() || 'deepseek-v4-flash',
    max_tokens: 4096,
    system: system || undefined,
    messages: historyToAnthropic(history),
    // 有工具才带 tools(静默总结等无工具请求不带,请求体最小化)
    ...(tools.length > 0 ? { tools: anthropicTools(tools) } : {}),
    stream: true,
  }

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey.trim(),
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    throw new Error(`无法连接 Anthropic API(${url}):${(err as Error).message}`)
  }

  if (!res.ok || !res.body) {
    let detail = ''
    try {
      const text = await res.text()
      detail = text.slice(0, 500)
    } catch {
      // 忽略读失败
    }
    throw new Error(`Anthropic API 请求失败 HTTP ${res.status}:${detail}`)
  }

  // content_block_start 里的块(工具块流式累积 input JSON delta)
  const blocks = new Map<
    number,
    | { type: 'tool_use'; id: string; name: string; input: string }
    | { type: 'text' }
    | { type: 'thinking' }
  >()
  const textParts: string[] = []
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0

  const parseSse = async function* (reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<{ type: string; data: Record<string, unknown> }> {
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
            const parsed = JSON.parse(payload) as Record<string, unknown>
            if (parsed && typeof parsed.type === 'string') yield { type: parsed.type, data: parsed }
          } catch {
            // 非 JSON 帧跳过
          }
        }
        if (signal.aborted) throw new DOMException('aborted', 'AbortError')
      }
    } finally {
      reader.releaseLock()
    }
  }

  for await (const evt of parseSse(res.body.getReader())) {
    const d = evt.data
    switch (evt.type) {
      case 'message_start': {
        const message = d.message as Record<string, unknown> | undefined
        const usage = message?.usage as Record<string, unknown> | undefined
        if (typeof usage?.input_tokens === 'number') inputTokens = usage.input_tokens
        // 缓存命中(Anthropic 格式:cache_read_input_tokens)
        if (typeof usage?.cache_read_input_tokens === 'number') {
          cacheReadTokens = usage.cache_read_input_tokens
        }
        break
      }
      case 'content_block_start': {
        const index = d.index as number
        const block = d.content_block as Record<string, unknown> | undefined
        if (block?.type === 'tool_use' && typeof block.id === 'string') {
          blocks.set(index, {
            type: 'tool_use',
            id: block.id,
            name: typeof block.name === 'string' ? block.name : '',
            input: '',
          })
          onEvent({ type: 'tool-call', id: block.id, name: String(block.name ?? ''), args: '' })
        } else if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
          // 官方文档:thinking 内容块 Supported;转发为思维链流(UI 深度思考)
          blocks.set(index, { type: 'thinking' })
          onEvent({ type: 'reasoning-delta', text: block.thinking })
        } else {
          blocks.set(index, { type: 'text' })
        }
        break
      }
      case 'content_block_delta': {
        const index = d.index as number
        const delta = d.delta as Record<string, unknown> | undefined
        if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
          textParts.push(delta.text)
          onEvent({ type: 'text-delta', text: delta.text })
        } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
          // thinking 块增量(官方格式:delta.type = thinking_delta)
          onEvent({ type: 'reasoning-delta', text: delta.thinking })
        } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const block = blocks.get(index)
          if (block && block.type === 'tool_use') {
            block.input += delta.partial_json
            onEvent({ type: 'tool-partial-call', id: block.id, name: block.name, args: block.input })
          }
        }
        break
      }
      case 'content_block_stop': {
        const block = blocks.get(d.index as number)
        if (block && block.type === 'tool_use') {
          // 收尾:完整参数
          onEvent({ type: 'tool-call', id: block.id, name: block.name, args: block.input })
        }
        break
      }
      case 'message_delta': {
        const usage = d.usage as Record<string, unknown> | undefined
        if (typeof usage?.output_tokens === 'number') outputTokens = usage.output_tokens
        break
      }
      case 'message_stop': {
        break
      }
      case 'error': {
        const err = d.error as Record<string, unknown> | undefined
        throw new Error(`Anthropic 错误:${String(err?.message ?? '未知错误')}`)
      }
      default:
        break
    }
    if (signal.aborted) throw new DOMException('aborted', 'AbortError')
  }

  // 汇总工具调用(与事件收集互补,兜底)
  const calls = [...blocks.values()]
    .filter((b): b is Extract<(typeof blocks) extends Map<number, infer V> ? V : never, { type: 'tool_use' }> => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, args: b.input }))

  return {
    calls,
    text: textParts.join(''),
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cached_tokens: cacheReadTokens > 0 ? cacheReadTokens : undefined,
    },
    aborted: signal.aborted,
  }
}
