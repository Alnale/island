/**
 * 智谱 GLM 云端 Chat Completions Provider(2026-08-19 云端接入)
 *
 * 裸 fetch + SSE 解析(不依赖 AI SDK,引擎零第三方依赖):
 *   POST {baseURL}/chat/completions(baseURL 默认
 *   https://open.bigmodel.cn/api/paas/v4,官方文档:
 *   https://docs.bigmodel.cn/api-reference/模型-api/对话补全)
 *
 * 对照官方文档的兼容性要点:
 * - 请求体:model / messages / stream / thinking(仅 GLM-4.5 及以上
 *   支持 {type:'enabled'|'disabled'})/ reasoning_effort(仅 GLM-5.2
 *   支持:none/minimal 放弃思考、low/medium→high、xhigh→max,配置值
 *   直通由平台映射)/ tools(Function Call:{type:'function',
 *   function:{name,description,parameters}})/ tool_choice('auto')/
 *   response_format({type:'json_object'})/ max_tokens(1–131072,
 *   GLM-5/4.7/4.6 系最大 128K 输出);
 * - 流式 SSE:OpenAI 兼容 `data: {...}` 帧,最后 `data: [DONE]`;
 *   delta.content 正文、delta.reasoning_content 思维链、
 *   delta.tool_calls 按 index 累积(arguments JSON 字符串增量);
 *   usage 在末尾 chunk(prompt_tokens_details.cached_tokens =
 *   上下文缓存命中);
 * - finish_reason:stop / length(输出预算截断)/ tool_calls /
 *   sensitive(内容安全拦截,官方:流式异常终止时以 finish_reason
 *   返回异常原因,不再走错误码);
 * - 多轮工具调用:assistant.tool_calls + 每条调用紧跟 role:'tool'
 *   消息(tool_call_id 配对),OpenAI 标准格式;assistant 消息
 *   无需回传 reasoning_content(与 DeepSeek 思考模式不同,官方无
 *   此要求,回传徒增 token)。
 *
 * 与 deepseek/mimo/lmstudio 模块零相互导入(工程约定:厂商模块
 * 完全独立,允许合理重复)。
 */

import { parseSse, sanitizeJsonStrings, truncateResult } from './sse'
import { glmCloudErrorMessage, GLM_CLOUD_DEFAULT_MODEL } from './glm-cloud-constants'
import type { AgentConfig, AgentEvent, AgentMessage, AgentPart, AgentTool, ProviderOutcome } from '../types'

/** 工具 → GLM tools(官方 Function Call 格式:function 嵌套) */
function glmCloudTools(tools: AgentTool[]) {
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

/**
 * 模型是否支持 thinking 开关(官方:仅 GLM-4.5 及以上):
 * glm-4.5 / glm-4.6 / glm-4.7 / glm-5.x 支持;纯 glm-4 系
 * (glm-4-flash-250414 / glm-4-flashx-250414)与 glm-3 系不支持
 * ——不支持时不传该参数(平台默认,避免 1214 参数非法)。
 * 未知命名(非 glm-数字 开头)保守不传。
 */
function glmThinkingSupported(model: string): boolean {
  const m = /^glm-(\d+)(?:\.(\d+))?/.exec(model)
  if (!m) return false
  const major = Number(m[1])
  const minor = m[2] ? Number(m[2]) : 0
  return major > 4 || (major === 4 && minor >= 5)
}

/** 模型是否支持 reasoning_effort(官方:仅 GLM-5.2 支持) */
function glmEffortSupported(model: string): boolean {
  return /^glm-5\.2/.test(model)
}

/**
 * 历史消息 → GLM Chat Completions messages(OpenAI 标准格式):
 * - user → {role:'user', content};
 * - assistant → content + tool_calls(id/type/function{name, arguments
 *   JSON 字符串});reasoning 不回传(GLM 无 DeepSeek 式回传要求);
 * - 工具结果 → 独立 {role:'tool', tool_call_id, content} 消息,
 *   紧跟对应 assistant 消息(每条调用一条)。
 */
export function glmCloudHistoryToMessages(history: AgentMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const msg of history) {
    if (msg.role === 'user') {
      const text = joinText(msg.parts)
      if (text) out.push({ role: 'user', content: text })
      continue
    }
    // system 角色(主动陪伴回合的内部指令等):Chat Completions 允许
    // system 出现在任意位置,放这里保证安全序列化
    if (msg.role === 'system') {
      const text = joinText(msg.parts)
      if (text) out.push({ role: 'system', content: text })
      continue
    }
    const text = joinText(msg.parts)
    const calls = msg.parts.filter(
      (p): p is Extract<AgentPart, { type: 'tool-call' }> => p.type === 'tool-call',
    )
    const assistant: Record<string, unknown> = { role: 'assistant' }
    if (text) assistant.content = text
    if (calls.length > 0) {
      assistant.tool_calls = calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
      }))
    }
    // 空消息(无任何字段)跳过(防御,正常历史不会出现)
    if (assistant.content || assistant.tool_calls) out.push(assistant)
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
 * 发起一次流式请求(智谱 GLM 云端 Chat Completions API)。
 * 事件经 onEvent 实时转发(text-delta / reasoning-delta /
 * tool-partial-call / tool-call),完成后返回统一 ProviderOutcome。
 * - jsonMode:response_format {type:'json_object'}(官方:prompt 需
 *   说明需要 JSON 格式输出,调用方保证);
 * - noThinking:thinking {type:'disabled'}(GLM-4.5+ 非思考模式,
 *   总结标题等短输出任务用它避免思维链挤占输出预算);
 * - maxTokens:max_tokens 覆盖(官方 1–131072,建议 ≥1024;
 *   主对话循环传 8192 防工具参数被截断)。
 * 失败抛 Error(调用方转成 error 事件);中止按 signal.aborted 返回。
 */
export async function glmCloudStreamChatCompletion(params: {
  config: AgentConfig
  system: string
  history: AgentMessage[]
  tools: AgentTool[]
  signal: AbortSignal
  onEvent: (event: AgentEvent) => void
  jsonMode?: boolean
  noThinking?: boolean
  /** 输出上限覆盖(与 DeepSeek Chat 同语义:主循环 8192 防工具参数被截断) */
  maxOutputTokens?: number
}): Promise<ProviderOutcome> {
  const { config, system, history, tools, signal, onEvent, jsonMode, noThinking, maxOutputTokens } = params
  const base = config.baseURL.trim().replace(/\/+$/, '')
  const url = `${base}/chat/completions`
  const model = config.model.trim() || GLM_CLOUD_DEFAULT_MODEL
  // 思考开关:noThinking(引擎短输出任务)或设置页思考强度 none →
  // thinking disabled(与设置页"关"语义一致)
  const thinkingOn = glmThinkingSupported(model) && !noThinking && config.reasoningEffort !== 'none'

  const body: Record<string, unknown> = {
    model,
    messages: [
      // system 提示作为第一条 system 消息(官方示例格式;多轮对话
      // 完整历史回传,历史裁剪由引擎预算治理负责)
      ...(system ? [{ role: 'system', content: system }] : []),
      ...glmCloudHistoryToMessages(history),
    ],
    // 有工具才带 tools/tool_choice(静默总结等无工具请求不带,
    // 请求体最小化,规避空数组边界)
    ...(tools.length > 0 ? { tools: glmCloudTools(tools), tool_choice: 'auto' } : {}),
    // 思考模式:仅 GLM-4.5+ 传 thinking(纯 glm-4 系不传,平台默认);
    // noThinking → disabled(短输出任务避免思维链挤占预算)
    ...(glmThinkingSupported(model) ? { thinking: { type: thinkingOn ? 'enabled' : 'disabled' } } : {}),
    // 推理程度:仅 GLM-5.2 支持(官方:none/minimal 放弃思考、
    // low/medium→high、xhigh→max——配置值直通,平台负责映射);
    // thinking 已 disabled 时不传(无效参数)
    ...(glmEffortSupported(model) && thinkingOn ? { reasoning_effort: config.reasoningEffort || 'high' } : {}),
    // JSON 输出:json_object 模式(官方建议 prompt 明确要求 JSON)
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    // 输出上限:单轮回复防失控(GLM-5/4.7/4.6 系最大 128K 输出,
    // 不设会烧输出 token);主对话循环传 8192
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
      // 请求体深度清洗孤立代理(与 deepseek/chat 同款:历史文本含
      // 孤立代理码元时 JSON.stringify 原样输出 \udXXX,服务器解析 400,
      // 见 sse.ts sanitizeUnpairedSurrogates)
      body: JSON.stringify(sanitizeJsonStrings(body)),
      // **不传 signal(llhttp UAF 规避)**:fetch 的中止在 HTTP 解析
      // 中途销毁 socket = Node 22 use-after-free(nodejs#62095)。
      // 中止判定移到 parseSse 的安全点(sse.ts),语义不变
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    throw new Error(`无法连接智谱 GLM API(${url}):${(err as Error).message}`)
  }

  if (!res.ok || !res.body) {
    let detail = ''
    try {
      detail = (await res.text()).slice(0, 500)
    } catch {
      // 忽略读失败
    }
    // 错误码映射(官方错误码文档:HTTP 状态码 + 业务错误码 → 可读中文)
    throw new Error(glmCloudErrorMessage(res.status, detail))
  }

  // 流式工具调用按 index 累积(OpenAI 格式:首个 delta 带 id/name,
  // 后续只带 index + arguments 增量;GLM 未开 tool_stream 时整段
  // arguments 一次性到达,同款累积兼容)
  const callDeltas = new Map<number, { id: string; name: string; args: string }>()
  const textParts: string[] = []
  let usage: { input_tokens: number; output_tokens: number } | null = null
  let cachedTokens: number | undefined
  // 响应被输出预算截断标记(finish_reason 'length')
  let truncated = false

  for await (const evt of parseSse(res.body, signal)) {
    const d = evt.data
    const choice = (Array.isArray(d.choices) ? d.choices[0] : undefined) as
      | Record<string, unknown>
      | undefined
    const delta = choice?.delta as Record<string, unknown> | undefined
    if (delta) {
      // 思维链增量(GLM 字段 delta.reasoning_content;UI 深度思考)
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
    // 末尾 chunk 带 usage:缓存命中 prompt_tokens_details.cached_tokens
    const u = d.usage as Record<string, unknown> | undefined
    if (u && typeof u.prompt_tokens === 'number') {
      usage = {
        input_tokens: u.prompt_tokens,
        output_tokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : 0,
      }
      const details = u.prompt_tokens_details as Record<string, unknown> | undefined
      if (typeof details?.cached_tokens === 'number' && details.cached_tokens > 0) {
        cachedTokens = details.cached_tokens
      }
    }
    // 输出预算截断(finish_reason 'length');sensitive = 内容安全拦截
    // (官方:流式异常终止以 finish_reason 返回,正文可能为空——
    // 打日志即可,由引擎空回复兜底)
    if (choice?.finish_reason === 'length') truncated = true
    if (choice?.finish_reason === 'sensitive') {
      console.warn('[agent] 智谱 GLM 内容安全拦截(finish_reason=sensitive)')
    }
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
