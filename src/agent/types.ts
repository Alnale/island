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
  /** 记忆自我进化后台任务进度(渲染端忽略,状态机不受影响) */
  | { type: 'evolution-progress'; phase: string }
  | { type: 'evolution-done' }
  /** 后台长任务完成(如 bili 下载):自动触发一轮对话,LLM 主动回复 */
  | { type: 'background-done'; title: string; message: string }

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
  /** 技能来源分区:created = 灵动岛创建 / imported = 手动导入 / scanned = 扫描到的 */
  sourceKind?: 'created' | 'imported' | 'scanned'
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
  /** 打开 Agent 设置视图(⋯ 菜单"设置"入口) */
  onOpenSettings?(): void
}

/**
 * MCP 服务端配置(settings.json 的 agent.mcpServers 段)。
 * type = stdio(默认):本地进程,command/args/env;type = sse:远程端点,url + headers
 */
export interface McpServerConfig {
  /** 服务名(工具名前缀 mcp_<name>_;仅展示用,可中文) */
  name: string
  /** 传输类型:stdio(本地进程,默认)/ sse(远程端点) */
  type?: 'stdio' | 'sse'
  /** stdio:启动命令(npx / node / 绝对路径可执行文件等) */
  command: string
  /** stdio:启动参数(数组) */
  args?: string[]
  /** stdio:注入子进程的环境变量(KEY=值;如服务器需要的 API Key) */
  env?: Record<string, string>
  /** sse:服务端端点 URL */
  url?: string
  /** sse:请求头(如 Authorization) */
  headers?: Record<string, string>
}

/** 记忆条目(记忆系统;类型 = 偏好/事实/工作流/教训) */
export interface MemoryEntry {
  id: string
  type: 'preference' | 'fact' | 'workflow' | 'lesson'
  content: string
  tags?: string[]
  source?: 'manual' | 'agent' | 'evolution'
  createdAt: number
  updatedAt: number
}

/** Agent 配置(settings.json 的 agent 段镜像) */
export interface AgentConfig {
  apiKey: string
  baseURL: string
  model: string
  systemPrompt: string
  /** 思考强度(low/medium/high,默认 high) */
  reasoningEffort: string
  /** MCP 服务端列表(每个服务暴露 mcp_<服务>_<工具> 工具) */
  mcpServers: McpServerConfig[]
  /** 技能目录列表(扫描 SKILL.md,每个技能暴露 skill_<名字> 工具) */
  skillsDirs: string[]
  /** 已排除技能(扫描跳过;LLM 对话 / 设置界面移除) */
  excludedSkills: string[]
}
