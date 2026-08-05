/**
 * Agent 引擎 —— 共享类型
 *
 * 消息模型借鉴 opencode(packages/opencode/src/session/message.ts)的
 * MessagePart 语义,去掉 Effect Schema,仅保留结构化类型:
 * 每条消息由有序 parts 组成(文本 / 推理 / 工具调用 / 工具结果),
 * 工具调用与结果成对出现(同 id),顺序即执行顺序。
 *
 * 引擎本身无状态(不持有会话):每次 send 由渲染端回传完整历史,
 * 与参考后端(MS Agent)的"客户端持有历史、请求时回传"模式一致。
 */

/** 工具调用(参数已收齐) */
export interface ToolCallPart {
  type: 'tool-call'
  /** 调用 id(与 tool-result 配对) */
  id: string
  /** 工具名 */
  name: string
  /** 完整参数(对象) */
  args: Record<string, unknown>
}

/** 工具执行结果 */
export interface ToolResultPart {
  type: 'tool-result'
  /** 与 tool-call 配对的 id */
  id: string
  name: string
  ok: boolean
  /** 结果文本(执行产物,回填给 LLM 的就是它) */
  result: string
  /** 执行耗时(ms) */
  durationMs: number
}

/** 消息 part(opencode MessagePart 的子集) */
export type AgentPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | ToolCallPart
  | ToolResultPart

/** 一条消息:user(整条文本)或 assistant(parts 序列) */
export interface AgentMessage {
  id: string
  role: 'user' | 'assistant'
  parts: AgentPart[]
}

/** 引擎 → 渲染端的事件流(经主进程转发) */
export type AgentEvent =
  | { type: 'status'; status: 'thinking' | 'running' | 'idle' }
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-partial-call'; id: string; name: string; args: string }
  | { type: 'tool-call'; id: string; name: string; args: string }
  | { type: 'tool-result'; id: string; name: string; ok: boolean; result: string; durationMs: number }
  /** 一轮回复完整落定(含工具调用与结果的权威 parts + token 用量) */
  | { type: 'message'; message: AgentMessage; usage?: { input: number; output: number } }
  | { type: 'error'; message: string }

/** Agent 配置(settings.json 的 agent 段,主进程持有) */
export interface AgentConfig {
  /** DeepSeek API Key(留空则拒绝发送) */
  apiKey: string
  /** 默认 https://api.deepseek.com */
  baseURL: string
  /** 默认 deepseek-v4-flash(当前唯一支持 Responses API 的模型) */
  model: string
  /** 系统提示词(默认值在 main.cjs 兜底) */
  systemPrompt: string
  /** 思考强度(官方文档 reasoning.effort:low/medium/high,默认 high) */
  reasoningEffort: string
}

/**
 * 工具定义(模块化):name/description/parameters(JSON Schema)注入 LLM
 * 上下文(LLM 据此生成参数),execute 在本机执行(无沙箱)。
 * 参数全程可知:执行前经 tool-call 事件展示完整参数,结果经 tool-result
 * 事件回显。
 */
export interface AgentTool {
  name: string
  description: string
  /** JSON Schema(object) */
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
  execute(params: Record<string, unknown>): Promise<string> | string
}

/**
 * Provider 统一返回(DeepSeek Responses / Anthropic Messages 同构):
 * 事件已实时转发,calls/text 为权威汇总(工具调用参数、回复文本)。
 * cached_tokens = 命中上下文硬盘缓存的前缀 token 数(DeepSeek 自动
 * 缓存:请求前缀完整匹配缓存前缀单元才命中;usage 里 input_tokens_details
 * .cached_tokens / Anthropic cache_read_input_tokens)
 */
export interface ProviderOutcome {
  calls: Array<{ id: string; name: string; args: string }>
  text: string
  usage: { input_tokens: number; output_tokens: number; cached_tokens?: number } | null
  aborted: boolean
}

/** 引擎依赖(主进程注入) */
export interface EngineDeps {
  getConfig(): AgentConfig
  /** 事件转发(→ 渲染端) */
  onEvent(event: AgentEvent): void
  /** switch_to_music 工具:切换回音乐模式 */
  onSwitchToMusic(): void
}

/** 工具参数名 → 值的开放对象(工具 execute 收到的参数) */
export type ToolParams = Record<string, unknown>
