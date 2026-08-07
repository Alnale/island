/**
 * Agent 模式 —— 渲染端共享类型
 *
 * **唯一事实来源 = 引擎侧 electron/agent/types.ts**(2026-08-07 审计
 * 收敛:此前两份同构类型手动维护,已实测漂移 4 处——message usage 缺
 * cached、AgentConfig excludedTools/excludedSkills 可选性不一致、
 * 引擎 AgentEvent 缺 tool-confirm-request)。本文件只做 re-export +
 * 渲染端扩展。全部 `import type` 编译期擦除,不把 electron 侧代码
 * 打进渲染包(引擎 types.ts 零 node 运行时依赖,已核实)。
 */

import type {
  AgentEvent as EngineAgentEvent,
  AgentMessage as EngineAgentMessage,
  AgentConfig as EngineAgentConfig,
  AgentTool as EngineAgentTool,
  McpServerConfig,
  MemoryEntry,
} from '../../electron/agent/types'

/** 引擎状态 → 渲染端状态机 */
export type AgentStatus = 'idle' | 'thinking' | 'running' | 'error'

/** 已落定的消息 part(与引擎类型同构) */
export type { AgentPart } from '../../electron/agent/types'

/** 一条消息:渲染端扩展 usage(token 用量,cached = 上下文缓存命中) */
export interface AgentMessage extends EngineAgentMessage {
  /** token 用量(assistant 消息落定时附上;cached = 缓存命中 token 数) */
  usage?: { input: number; output: number; cached?: number }
}

/** 引擎事件流(含确认门/进化/后台完成事件) */
export type AgentEvent = EngineAgentEvent

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

/** 工具信息(列表展示:名称/描述/参数 schema;引擎 listAllTools 返回,
 * 不含 execute——渲染端不执行工具) */
export type AgentToolInfo = Omit<EngineAgentTool, 'execute'>

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
  /** 当前对话实时总结标题(每轮回复后静默更新;入历史作会话标题) */
  currentTitle: string | null
  /** 心理揣测(独立 Sub Agent 每轮回复后静默更新;紧凑态文字区优先展示) */
  mindGuess: string | null
  onSend(text: string): void
  onAbort(): void
  /** 新对话:当前对话存档到历史后清空 */
  onClear(): void
  /** 打开 Agent 设置视图(⋯ 菜单"设置"入口) */
  onOpenSettings?(): void
  /** 已禁用工具名(工具列表视图禁用;引擎下一轮起不注入) */
  excludedTools?: string[]
  /** 更新禁用工具列表(工具列表视图禁用 / 恢复) */
  onExcludedToolsChange?(names: string[]): void
  /** exec_command 确认请求(confirmExec 开启,引擎等待用户选择) */
  pendingConfirm: { command: string } | null
  /** 回传确认结果(允许 / 拒绝) */
  onConfirmTool(approved: boolean): void
}

/** MCP 服务端配置(与引擎同构,re-export) */
export type { McpServerConfig }

/** 记忆条目(记忆系统;类型 = 偏好/事实/工作流/教训) */
export type { MemoryEntry }

/** Agent 配置:渲染端要求 excludedTools/excludedSkills 与主动陪伴两
 * 字段必填(引擎侧可选——主进程 AGENT_CONFIG_DEFAULTS 总是补齐,
 * 渲染端按必填使用) */
export interface AgentConfig extends EngineAgentConfig {
  excludedTools: string[]
  excludedSkills: string[]
  /** 主动陪伴开关(默认 true;用户无操作满 N 分钟后判断是否主动开口) */
  proactiveEnabled: boolean
  /** 主动陪伴间隔数值(默认 60,钳制 5–480;配合 proactiveIntervalUnit) */
  proactiveInterval: number
  /** 主动陪伴间隔单位(s=秒 / m=分钟 / h=小时) */
  proactiveIntervalUnit: 's' | 'm' | 'h'
  /** 总结标题文风(Sub Agent 设置:预设 id 或自定义 ≤100 字) */
  summaryStyle: string
  /** 心理揣测人格(Sub Agent 设置:预设 id 或自定义 ≤100 字) */
  mindPersona: string
}
