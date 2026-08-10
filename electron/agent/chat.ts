/**
 * DeepSeek Chat Completions API Provider(官方指南全部对齐)
 *
 * **备选 provider**:引擎按 baseURL 自动判定(见 engine.ts detectProvider)——地址
 * 含 "chat" 时使用本 provider(如自定义端点/代理);**默认走 Responses API**
 * (deepseek.ts)。两 provider 同构返回 ProviderOutcome。
 *
 * 端点:POST {baseURL}/chat/completions(默认 https://api.deepseek.com)。
 *
 * 对照官方指南(https://api-docs.deepseek.com/zh-cn/guides/):
 * - **multi_round_chat 多轮对话**:无状态 API,每轮请求把完整对话历史
 *   拼成 messages 数组(system 提示在开头,用户每轮追加);历史裁剪由
 *   引擎预算治理负责,此处按官方格式原样序列化;
 * - **tool_calls 工具调用**:tools 定义 `{type:'function', function:
 *   {name, description, parameters}}`;模型返回的 assistant 消息带
 *   tool_calls(id/type/function{name, arguments **JSON 字符串**}),
 *   每条调用紧跟一条 `role:'tool'` 消息(tool_call_id 配对)再继续对话;
 *   strict 模式(Beta,需 base_url /beta 且全部参数 required +
 *   additionalProperties:false)不启用——本引擎工具参数多含可选字段,
 *   参数容错由 parseToolArgs 兜底;
 * - **json_mode JSON 输出**:response_format {type:'json_object'} 且
 *   prompt 必须含 "json" 字样(调用方保证);**API 有概率返回空 content**
 *   (官方明示),调用方必须兜底;本引擎用于静默总结(标题 JSON);
 * - **chat_prefix_completion 对话前缀续写**(Beta,需 /beta base_url +
 *   assistant 消息 prefix:True):本引擎不强制模型输出前缀,不适用;
 * - **fim_completion FIM 补全**(Beta,仅非思考模式,IDE 代码补全场景):
 *   本引擎是对话 Agent,不适用;
 * - **上下文硬盘缓存**(chat_prefix_completion 同源,默认开启):请求前缀
 *   **完整匹配缓存前缀单元**才命中;命中数在 usage.prompt_cache_hit_tokens
 *   (未命中 prompt_cache_miss_tokens)。
 *
 * 思考模式(quick start 官方示例):顶层 `thinking: {type:'enabled'}` +
 * `reasoning_effort`;流式思维链增量在 delta.reasoning_content;
 * **多轮对话必须回传上一轮 assistant 消息的 reasoning_content**
 * (缺失 400 "The reasoning_content in the thinking mode must be
 * passed back to the API",与 Responses 同规则)——序列化时并入
 * assistant 消息的 reasoning_content 字段。
 *
 * 流式 SSE:OpenAI 格式 `data: {...}` 帧,最后 `data: [DONE]`;
 * usage 在末尾 chunk(choices 为空)返回;工具参数按 index 流式 delta
 * (首个 delta 带 id/name,后续只带 index + arguments 增量)。
 */

import { parseSse, truncateResult } from './sse'
import { apiErrorMessage } from './constants'
import type { AgentConfig, AgentEvent, AgentMessage, AgentPart, AgentTool, ProviderOutcome } from './types'

/** 工具 → Chat Completions tools(官方格式:function 嵌套) */
function chatTools(tools: AgentTool[]) {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

/** 文本 parts 拼接(user 消息 / assistant content) */
function joinText(parts: AgentPart[]): string {
  return parts
    .filter((p): p is Extract<AgentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

/** reasoning parts 拼接(回传给 API 的 reasoning_content) */
function joinReasoning(parts: AgentPart[]): string {
  return parts
    .filter((p): p is Extract<AgentPart, { type: 'reasoning' }> => p.type === 'reasoning')
    .map((p) => p.text)
    .join('\n')
}

/**
 * 历史消息 → Chat Completions messages(官方多轮对话 + 工具调用格式):
 * - user → {role:'user', content};
 * - assistant → reasoning_content(思考模式回传要求)+ content +
 *   tool_calls(id/type/function{name, arguments JSON 字符串});
 * - 工具结果 → 独立的 {role:'tool', tool_call_id, content} 消息,
 *   紧跟对应 assistant 消息(每条调用一条)。
 * 与 Responses API 的差异:reasoning 从"独立 item"改为助手消息的
 * reasoning_content 字段;工具结果从 function_call_output item 改为
 * tool 角色消息(tool_call_id 配对)。
 */
export function historyToMessages(history: AgentMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const msg of history) {
    if (msg.role === 'user') {
      const text = joinText(msg.parts)
      if (text) out.push({ role: 'user', content: text })
      continue
    }
    // system 角色(主动陪伴回合的内部指令等):Chat Completions 允许
    // system 出现在任意位置,放这里保证安全序列化(不落 assistant 分支)
    if (msg.role === 'system') {
      const text = joinText(msg.parts)
      if (text) out.push({ role: 'system', content: text })
      continue
    }
    const reasoning = joinReasoning(msg.parts)
    const text = joinText(msg.parts)
    const calls = msg.parts.filter(
      (p): p is Extract<AgentPart, { type: 'tool-call' }> => p.type === 'tool-call',
    )
    const assistant: Record<string, unknown> = { role: 'assistant' }
    // 思考模式回传:引擎每轮(含工具循环)都把思维链存进 parts,
    // 序列化时并入相邻 assistant 消息的 reasoning_content 字段
    if (reasoning) assistant.reasoning_content = reasoning
    if (text) assistant.content = text
    if (calls.length > 0) {
      assistant.tool_calls = calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
      }))
    }
    // 空消息(无任何字段)跳过(防御,正常历史不会出现)
    if (assistant.reasoning_content || assistant.content || assistant.tool_calls) out.push(assistant)
    // 工具结果:每条独立 tool 角色消息,紧跟对应 assistant 消息
    for (const p of msg.parts) {
      if (p.type === 'tool-result') {
        // 结果截断回填(参考后端 token 预算治理):完整结果已走事件给 UI
        out.push({ role: 'tool', tool_call_id: p.id, content: truncateResult(p.result) })
      }
    }
  }
  return out
}

/**
 * 发起一次流式请求(DeepSeek Chat Completions API)。
 * 事件经 onEvent 实时转发(text-delta / reasoning-delta /
 * tool-partial-call / tool-call),完成后返回统一 ProviderOutcome。
 * jsonMode:response_format {type:'json_object'}(官方 JSON 输出指南;
 * 调用方必须保证 prompt 含 "json" 字样,否则 API 报错;
 * 且 API 有概率返回空 content,调用方需兜底)。
 * thinking:false = thinking {type:'disabled'}(非思考模式)——实测
 * 思考模式 + json_object 时模型常把输出 token 全花在思维链上、
 * 正文返回空/空白(官方"有概率返回空 content"的典型场景),短输出
 * 任务(总结标题)应禁用思考
 */
export async function streamChatCompletion(params: {
  config: AgentConfig
  system: string
  history: AgentMessage[]
  tools: AgentTool[]
  signal: AbortSignal
  onEvent: (event: AgentEvent) => void
  jsonMode?: boolean
  thinking?: boolean
  /** 输出上限覆盖(与 Responses 同语义:主循环 8192 防工具参数被截断) */
  maxOutputTokens?: number
}): Promise<ProviderOutcome> {
  const { config, system, history, tools, signal, onEvent, jsonMode, thinking, maxOutputTokens } = params
  const base = config.baseURL.trim().replace(/\/+$/, '')
  const url = `${base}/chat/completions`

  const body: Record<string, unknown> = {
    model: config.model.trim() || 'deepseek-v4-flash',
    messages: [
      // system 提示作为第一条 system 消息(多轮对话指南:system 开头、
      // 角色按序交替;前缀缓存要求该段保持稳定——动态段放在历史末尾)
      ...(system ? [{ role: 'system', content: system }] : []),
      ...historyToMessages(history),
    ],
    // 有工具才带 tools(静默总结等无工具请求不带,请求体最小化)
    ...(tools.length > 0 ? { tools: chatTools(tools) } : {}),
    // 思考模式(quick start 官方示例:thinking {type:'enabled'} +
    // reasoning_effort;v4-flash 思考模式默认开启,显式声明以对齐官方;
    // thinking:false → {type:'disabled'} 非思考模式)
    thinking: thinking === false ? { type: 'disabled' } : { type: 'enabled' },
    reasoning_effort: config.reasoningEffort || 'high',
    // JSON 输出(json_mode 官方指南):prompt 必须含 "json" 字样
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    // 输出上限:单轮回复防失控(官方:输出上限 384K,不设会烧输出 token);
    // 主对话循环传 8192(思考模式高 effort 下 4096 会截断工具参数)
    max_tokens: maxOutputTokens ?? 4096,
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
      detail = (await res.text()).slice(0, 500)
    } catch {
      // 忽略读失败
    }
    // 错误码映射(2026-08-10,与 Responses 同款可读中文错误)
    throw new Error(apiErrorMessage(res.status, detail))
  }

  // 流式工具调用按 index 累积(OpenAI 格式:首个 delta 带 id/name,
  // 后续只带 index + arguments 增量;arguments 是 JSON 字符串增量)
  const callDeltas = new Map<number, { id: string; name: string; args: string }>()
  const textParts: string[] = []
  let usage: { input_tokens: number; output_tokens: number } | null = null
  let cachedTokens: number | undefined
  // 响应被输出预算截断标记(finish_reason 'length',2026-08-08)
  let truncated = false

  for await (const evt of parseSse(res.body, signal)) {
    const d = evt.data
    const choice = (Array.isArray(d.choices) ? d.choices[0] : undefined) as
      | Record<string, unknown>
      | undefined
    const delta = choice?.delta as Record<string, unknown> | undefined
    if (delta) {
      // 思维链增量(DeepSeek 字段 delta.reasoning_content;UI 深度思考)
      const rc = delta.reasoning_content
      if (typeof rc === 'string' && rc) onEvent({ type: 'reasoning-delta', text: rc })
      // 正文增量
      const content = delta.content
      if (typeof content === 'string' && content) {
        textParts.push(content)
        onEvent({ type: 'text-delta', text: content })
      }
      // 工具调用增量(并行:同一 chunk 可含多条 index)
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
    // 末尾 chunk 带 usage(choices 为空):缓存命中 prompt_cache_hit_tokens
    const u = d.usage as Record<string, unknown> | undefined
    if (u && typeof u.prompt_tokens === 'number') {
      usage = {
        input_tokens: u.prompt_tokens,
        output_tokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : 0,
      }
      if (typeof u.prompt_cache_hit_tokens === 'number' && u.prompt_cache_hit_tokens > 0) {
        cachedTokens = u.prompt_cache_hit_tokens
      }
    }
    // 输出预算截断(OpenAI 格式:finish_reason 'length',2026-08-08)
    if (choice?.finish_reason === 'length') truncated = true
    if (signal.aborted) throw new DOMException('aborted', 'AbortError')
  }

  // 收尾:流式结束,按 index 顺序输出完整工具调用(id 缺失的丢弃)
  const calls: Array<{ id: string; name: string; args: string }> = []
  for (const entry of callDeltas.values()) {
    if (!entry.id) continue
    calls.push({ id: entry.id, name: entry.name, args: entry.args })
    onEvent({ type: 'tool-call', id: entry.id, name: entry.name, args: entry.args })
  }

  // 统一返回(事件已实时转发,calls/text 为权威汇总)
  return {
    calls,
    text: textParts.join(''),
    usage: usage ? { ...usage, cached_tokens: cachedTokens } : null,
    aborted: signal.aborted,
    truncated: truncated || undefined,
  }
}

/* parseToolArgs 死副本已删(2026-08-07 审计 P1:与 deepseek.ts 逐字节
 * 相同且零引用,引擎统一从 deepseek 导入) */
