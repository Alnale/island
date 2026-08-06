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
  /** 记忆自我进化后台任务进度(渲染端忽略,状态机不受影响) */
  | { type: 'evolution-progress'; phase: string }
  | { type: 'evolution-done' }
  /**
   * 后台长任务完成(如 bili 下载):渲染端据此**自动触发一轮对话**,
   * LLM 基于状态块主动回复用户,无需用户提问(实测:下载完成后用户
   * 不提问就不知道结果)。主进程只在 Agent 模式转发
   */
  | { type: 'background-done'; title: string; message: string }

/**
 * MCP 服务端配置(settings.json 的 agent.mcpServers 段)。
 * type = stdio(默认):启动本地进程,command/args/env;type = sse:
 * 远程服务端,url + headers(opencode 的 MCPServer 同构)。
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
  /** 记忆内容(一句话为宜;多句用分号分隔) */
  content: string
  tags?: string[]
  /** 来源:manual = 设置界面手写 / agent = LLM 对话沉淀 / evolution = 自我进化 */
  source?: 'manual' | 'agent' | 'evolution'
  createdAt: number
  updatedAt: number
}

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
  /** MCP 服务端列表(每个服务暴露 mcp_<服务>_<工具> 工具) */
  mcpServers: McpServerConfig[]
  /** 技能目录列表(扫描 SKILL.md,每个技能暴露 skill_<名字> 工具) */
  skillsDirs: string[]
  /**
   * 已禁用工具名(工具列表视图禁用;内置/MCP/技能一律生效,引擎每轮
   * 注入工具时过滤,手动调用同样不可用)
   */
  excludedTools: string[]
  /**
   * 已排除技能(slug = 工具名去 skill_ 前缀;扫描时跳过,对话中不可用)。
   * 支持 LLM 对话移除(skills_config exclude/include)与设置界面手动移除
   */
  excludedSkills: string[]
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
  /**
   * 技能来源分区(设置界面三区展示):
   * created = 灵动岛创建(引擎 create / 自然语言,userData/skills 无导入标记);
   * imported = 手动导入(agent:skill-import,技能目录有 .island-imported 标记);
   * scanned = 扫描到的外部技能(Claude Code/Codex/opencode 等目录)
   */
  sourceKind?: 'created' | 'imported' | 'scanned'
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
  /** 记忆存储(主进程创建;未注入则记忆工具/记忆块不可用) */
  getMemoryStore?(): MemoryStoreLike | null
  /** 自我进化 harness(主进程创建,懒加载;未注入则 evolve 工具不可用) */
  getEvolution?(): EvolutionLike | null
  /**
   * LLM 自我配置:把补丁写入 settings.json 的 agent 段(经主进程同款
   * 校验)。mcp_config / skills_config 工具调用;未注入则工具报错
   */
  updateAgentConfig?(patch: Partial<AgentConfig>): void
  /** 技能目录绝对路径(create_skill 写入;main.cjs 注入 userData/skills) */
  getSkillDir?(): string
  /**
   * 灵动岛设置工具:调渲染端设置桥(主进程注入,executeJavaScript 调
   * window.__islandSettings → 写 localStorage/IndexedDB → 派发
   * island-settings-changed 事件即时生效)。未注入则不注册设置工具
   */
  runIslandSettings?(op: string, args: unknown[]): Promise<unknown>
}

/** 记忆存储的引擎可见子集(避免 types ↔ memory 循环引用) */
export interface MemoryStoreLike {
  list(): Promise<MemoryEntry[]>
  add(input: {
    content: string
    type: MemoryEntry['type']
    source?: MemoryEntry['source']
    tags?: string[]
  }): Promise<{ entry: MemoryEntry; created: boolean }>
  remove(key: string): Promise<number>
  update(id: string, patch: { content?: string; type?: MemoryEntry['type']; tags?: string[] }): Promise<MemoryEntry | null>
  replaceAll(next: MemoryEntry[]): Promise<MemoryEntry[]>
  snapshot(backupPath: string): Promise<void>
}

/** 自我进化 harness 的引擎可见子集 */
export interface EvolutionLike {
  requestEvolve(focus?: string, rounds?: number): Promise<{ started: boolean; message: string }>
  getStatus(): Promise<string>
}

/** 工具参数名 → 值的开放对象(工具 execute 收到的参数) */
export type ToolParams = Record<string, unknown>
