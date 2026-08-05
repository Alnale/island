/**
 * Agent 模式 —— 渲染端共享类型
 *
 * 消息模型与引擎(electron/agent/types.ts)对齐:消息由有序 parts 组成
 * (文本 / 推理 / 工具调用 / 工具结果),工具调用与结果成对配对。
 * 引擎事件经 preload 订阅,本文件是渲染端唯一事实来源。
 */

/** 引擎状态 → 渲染端状态机 */
export type AgentStatus = 'idle' | 'thinking' | 'running' | 'error'

/** 已落定的消息 part(与引擎类型同构) */
export type AgentPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; id: string; name: string; args: Record<string, unknown> }
  | {
      type: 'tool-result'
      id: string
      name: string
      ok: boolean
      result: string
      durationMs: number
    }

/** 一条消息:user(整条文本)或 assistant(parts 序列) */
export interface AgentMessage {
  id: string
  role: 'user' | 'assistant'
  parts: AgentPart[]
  /** token 用量(assistant 消息落定时附上;cached = 缓存命中 token 数) */
  usage?: { input: number; output: number; cached?: number }
}

/** 引擎事件流(与 electron/agent/types.ts 的 AgentEvent 同构) */
export type AgentEvent =
  | { type: 'status'; status: 'thinking' | 'running' | 'idle' }
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-partial-call'; id: string; name: string; args: string }
  | { type: 'tool-call'; id: string; name: string; args: string }
  | {
      type: 'tool-result'
      id: string
      name: string
      ok: boolean
      result: string
      durationMs: number
    }
  /** 一轮回复完整落定(权威 parts + token 用量,cached = 缓存命中) */
  | {
      type: 'message'
      message: AgentMessage
      usage?: { input: number; output: number; cached?: number }
    }
  | { type: 'error'; message: string }

/** 流式中的工具调用状态(参数收齐后解析为对象) */
export interface AgentToolCallState {
  id: string
  name: string
  /** 已解析参数(参数流未收齐时为 {}) */
  args: Record<string, unknown>
  /** 参数原始 JSON 文本(流式展示用,收齐后与 args 并存) */
  argsRaw?: string
  ok?: boolean
  result?: string
  durationMs?: number
}

/** 历史会话(多对话存档:标题 + 时间 + 完整消息) */
export interface AgentSession {
  id: string
  /** 首条用户消息摘要(列表标题) */
  title: string
  updatedAt: number
  messages: AgentMessage[]
}

/** 工具信息(列表展示:名称/描述/参数 schema) */
export interface AgentToolInfo {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

/** 面板 props:DynamicIsland 的 agent prop 与 AgentView 共用 */
export interface AgentPanelProps {
  status: AgentStatus
  messages: AgentMessage[]
  /** 流式中的助手消息(未落定):累积文本 + 已发起的工具调用 */
  streaming: { text: string; reasoning: string; tools: AgentToolCallState[] } | null
  lastError: string | null
  /** 历史会话列表(新对话/清空时自动存档) */
  sessions: AgentSession[]
  /** 加载历史会话(替换当前对话并从历史移除) */
  onLoadSession(id: string): void
  /** 删除历史会话 */
  onDeleteSession(id: string): void
  /** 工具清单(名称/描述/参数 schema,引擎提供) */
  tools: AgentToolInfo[]
  /** 当前对话实时总结标题(每轮回复后静默更新;紧凑态文字区展示) */
  currentTitle: string | null
  onSend(text: string): void
  onAbort(): void
  /** 新对话:当前对话存档到历史后清空 */
  onClear(): void
}

/** Agent 配置(settings.json 的 agent 段镜像) */
export interface AgentConfig {
  apiKey: string
  baseURL: string
  model: string
  systemPrompt: string
  /** 思考强度(low/medium/high,默认 high) */
  reasoningEffort: string
}
