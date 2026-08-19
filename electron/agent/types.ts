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

/** 媒体附件(工具结果注入对话气泡,2026-08-08):kind + url(本地绝对
 * 路径或远程 URL)+ 可选名称。渲染端 MediaFrame 窗口内直接播放
 * (本地路径映射 island-media:// 流式协议)——LLM 说"打开视频看看"
 * 时由 open_file 拦截注入,不再依赖 LLM 输出 markdown(实测 LLM
 * 只回复"已播放"而不展示,窗口看不到视频气泡) */
export interface MediaAttachment {
  kind: 'img' | 'video' | 'audio'
  url: string
  name?: string
}

/** 消息 part(opencode MessagePart 的子集) */
export type AgentPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | ToolCallPart
  | ToolResultPart
  | { type: 'image'; dataUrl: string }
  | { type: 'media'; kind: 'img' | 'video' | 'audio'; url: string; name?: string }

/** 一条消息:user(整条文本)或 assistant(parts 序列) */
export interface AgentMessage {
  id: string
  /**
   * user / assistant 为对话消息;system 为**请求侧内部指令**(主动陪伴
   * 回合的指令,仅引擎构造进 historyIn,永不进入渲染端消息列表——
   * 渲染端 loadHistory 只认 user/assistant)
   */
  role: 'user' | 'assistant' | 'system'
  parts: AgentPart[]
  /**
   * 主动陪伴回合落定的助手消息标记(渲染端据此重置 idle 时钟防触发
   * 循环;随 localStorage 持久化,后续 send 回传时按 assistant 正常
   * 序列化,引擎忽略该标记)
   */
  proactive?: boolean
}

/** 引擎 → 渲染端的事件流(经主进程转发) */
/** 会话隔离并发(2026-08-13):事件统一携带 sessionKey('main' = 主人
 * 主对话;'private:<QQ>' / 'group:<群号>' = 外部会话),渲染端按会话路由
 * 到对应状态机。交叉类型对联合分布,所有成员都带可选会话键 */
export type AgentEvent = { sessionKey?: string } & (
  | { type: 'status'; status: 'thinking' | 'running' | 'idle' }
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-partial-call'; id: string; name: string; args: string }
  | { type: 'tool-call'; id: string; name: string; args: string }
  | { type: 'tool-result'; id: string; name: string; ok: boolean; result: string; durationMs: number }
  /** 一轮回复完整落定(含工具调用与结果的权威 parts + token 用量) */
  | { type: 'message'; message: AgentMessage; usage?: { input: number; output: number; cached?: number } }
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
   * 判定器路由结果补标(2026-08-16 二轮修复"私聊消息正常发送但指纹 UI
   * 标识丢失"):意图判定器兜底路由成功的回复**文本没有指纹**(指纹缺失
   * 才走判定器)——渲染端 hasTurnMark/hasMasterTurnMark 检测不到 →
   * sentToPeer/sentToMaster 标签丢失。主进程在判定器路由发送成功后补发
   * 本事件(messageId = 该轮落定的引擎消息 id),渲染端按 id 给已落定
   * 消息补打标签。to:'master' = 发给主人 / 'peer' = 发给对方(私聊)/
   * 'group' = 发到群
   */
  | { type: 'message-routed'; messageId: string; to: 'master' | 'peer' | 'group' }
  /** 确认门:引擎请求用户确认(主进程转发;渲染端允许/拒绝后经
   * agent:tool-confirm 回传)。title/detail 可选——exec_command 确认只带
   * command(兼容),bili 批量下载等动作确认带 title+detail 展示 */
  | { type: 'tool-confirm-request'; command: string; title?: string; detail?: string }
  /**
   * 主动陪伴:主进程对主动回合消息的心理揣测结果(与 Windows 系统通知
   * 同一条 guess)——渲染端更新紧凑态文字区 mindGuess,与通知一致
   */
  | { type: 'mind-proactive'; messageId: string; guess: string }
  /**
   * 会话上下文已清空(2026-08-13,LLM clear_session_context 工具):主进程
   * 已擦除该会话持久化历史,渲染端据此清消息状态(**不中止当前回合**——
   * 工具在本回合执行,回复照常落定到全新上下文)
   */
  | { type: 'session-context-cleared' }
)

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
  /**
   * 受保护(锁定,2026-08-13 用户实测"进化总是丢失岛灵设定"):主人指定
   * 的岛灵设定/人设条目——自我进化绝对不可修改/删除/合并;人设类标签
   * 或内容在加载时自动补锁(见 constants.ts isProtectedEntry)
   */
  protected?: boolean
  createdAt: number
  updatedAt: number
}

/** 单个 LLM 供应商的连接凭据(API Key / Base URL / 模型) */
export interface ProviderCredentials {
  /** API Key(留空则拒绝发送) */
  apiKey: string
  /** API 地址 */
  baseURL: string
  /** 模型 ID */
  model: string
}

/** 支持的 LLM 供应商标识(lmstudio = 本地工作站,2026-08-18;
 * glm = 智谱 GLM 云端,2026-08-19) */
export type ProviderId = 'deepseek' | 'mimo' | 'lmstudio' | 'glm'

/** Agent 配置(settings.json 的 agent 段,主进程持有) */
export interface AgentConfig {
  /**
   * 当前激活的供应商(2026-08-14 多供应商独立存储:切换供应商时
   * apiKey/baseURL/model 从 providers[activeProvider] 读出;
   * 顶层 apiKey/baseURL/model 仍保留以兼容旧代码路径,但始终
   * 与 providers[activeProvider] 保持同步)
   */
  activeProvider: ProviderId
  /** 各供应商独立的连接凭据(每个 Key/地址/模型互不覆盖) */
  providers: Record<ProviderId, ProviderCredentials>
  /**
   * Sub Agent 供应商拆分(2026-08-18):总结/心理/标题/记忆提取等
   * Sub Agent 使用的供应商桶——主 Agent 用强模型、Sub Agent 用本地
   * 弱模型的分工;缺省 = 跟随主供应商(activeProvider),凭据从
   * providers[subProvider] 取,三供应商两两组合最多 9 种
   */
  subProvider?: ProviderId
  /** Sub Agent 模型覆盖(空 = 用 providers[subProvider] 已存模型) */
  subModel?: string
  /** 当前激活供应商的 API Key(与 providers[activeProvider].apiKey 同步) */
  apiKey: string
  /** 当前激活供应商的 Base URL */
  baseURL: string
  /** 当前激活供应商的模型 */
  model: string
  /**
   * 显式指定 LLM 适配器 id(2026-08-14 插件化重构:LLM 接缝按 baseURL
   * 自动解析适配器;配置本字段则强制使用该适配器——未注册时大声失败
   * LLM_ADAPTER_MISSING)。缺省 = 自动解析
   */
  llmAdapter?: string
  /** 系统提示词(默认值在 main.cjs 兜底) */
  systemPrompt: string
  /** 思考强度(官方文档 reasoning.effort:low/medium/high,默认 high) */
  reasoningEffort: string
  /**
   * 主对话/子代理循环输出预算 max_output_tokens(含思维链 token,
   * 2026-08-08):缺省引擎 MAIN_MAX_OUTPUT_TOKENS(16384);可由 LLM
   * 经 set_output_budget 工具自主调整(任务巨大时调大、完成后调回),
   * persist=true 时写这里持久化,重启保留
   */
  maxOutputTokens?: number
  /** MCP 服务端列表(每个服务暴露 mcp_<服务>_<工具> 工具) */
  mcpServers: McpServerConfig[]
  /** 技能目录列表(扫描 SKILL.md,每个技能暴露 skill_<名字> 工具) */
  skillsDirs: string[]
  /**
   * 已禁用工具名(工具列表视图禁用;内置/MCP/技能一律生效,引擎每轮
   * 注入工具时过滤,手动调用同样不可用)
   */
  excludedTools?: string[]
  /**
   * 已排除技能(slug = 工具名去 skill_ 前缀;扫描时跳过,对话中不可用)。
   * 支持 LLM 对话移除(skills_config exclude/include)与设置界面手动移除
   */
  excludedSkills?: string[]
  /**
   * exec_command 确认门(2026-08-06):开启后每轮首个命令执行需用户在
   * 渲染端确认(防 prompt injection 链式放大到任意命令);默认关闭
   */
  confirmExec?: boolean
  /**
   * 主动陪伴(2026-08-07):开启后用户无操作满 proactiveInterval × 单位,
   * 由总结 Sub Agent 判断语境是否需要主动开口,是则主 Agent 完整回合
   * 主动回复(默认开启)。2026-08-07 支持单位选择(秒/分钟/小时,
   * 数值不变仅换单位——旧 proactiveIntervalMinutes 由主进程迁移)
   */
  proactiveEnabled?: boolean
  /** 主动陪伴间隔数值(默认 60,钳制 5–480;配合 proactiveIntervalUnit) */
  proactiveInterval?: number
  /** 主动陪伴间隔单位:s=秒 / m=分钟(默认)/ h=小时 */
  proactiveIntervalUnit?: 's' | 'm' | 'h'
  /**
   * 总结标题文风(2026-08-07 Sub Agent 设置):预设 id(SUMMARY_STYLES)
   * 或自定义文本 ≤100 字;注入总结系统提示
   */
  summaryStyle?: string
  /** 心理揣测人格(2026-08-07 Sub Agent 设置):预设 id(MIND_PERSONAS)
   * 或自定义文本 ≤100 字;注入揣测系统提示 */
  mindPersona?: string
  /**
   * 工具输出根目录(2026-08-12):所有工具的产出文件统一存放——
   * 目录结构 = <根>/<工具名>/[<会话ID>](每工具文件夹分类、文件按
   * 对话 ID 分类;会话 ID 缺失时落在 <根>/<工具名>)。空 = 未启用,
   * 各工具保持默认位置(userData 下)。影响 bili 下载 / xxt 截图 /
   * doc_convert 输出;write_file 与 exec_command 是用户指定路径,
   * 不重定向
   */
  outputDir?: string
  /**
   * NapCat QQ 机器人(2026-08-12):WebSocket 地址(OneBot 11,默认
   * ws://127.0.0.1:3001)。收到私聊消息自动进入对话,LLM 回复发回 QQ
   */
  napcatWsUrl?: string
  /** NapCat 开关(默认 false;开启后挂件启动即连接) */
  napcatEnabled?: boolean
  /** 私聊扩展信任 QQ 号(主人由 privacy.json 配置;空 = 只信任主人) */
  napcatAllowed?: string[]
  /** 群白名单(由 privacy.json 的 allowedGroups 配置;空 = 不处理群消息) */
  napcatAllowedGroups?: string[]
  /** 机器人自身 QQ(群消息 @ 检测;由 privacy.json 的 botQQ 配置) */
  napcatBotQQ?: string
  /**
   * 屏蔽的外部会话键列表(2026-08-13 会话隔离:private:<QQ> / group:<群号>):
   * 屏蔽会话的消息只显示进对话窗口、不触发 LLM 回复;LLM 可经
   * napcat 工具 session_mute 管理,设置界面不暴露(会话管理走对话)
   */
  mutedSessions?: string[]
  /**
   * 撤销监控目录(2026-08-14 停止与撤销分离):须为 git 仓库。主人输入
   * 轮发送前逐目录拍隐藏快照(临时索引提交 + refs/island-undo 引用),
   * 撤销时精确还原工作区到该轮之前(reset 回快照前 HEAD + 覆盖脏改动
   * + 差集删除该轮新建文件)。空数组 = 撤销只回滚上下文不动文件
   */
  undoWatchDirs?: string[]
}

/** 工具执行上下文(可选第二参):主回合中止信号——delegate 子代理
 * 据此停止内部循环,用户点"停止"后不再烧 token */
export interface ToolExecCtx {
  signal?: AbortSignal
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
  /**
   * 执行兜底超时(ms,缺省引擎 60s)。长任务工具必须覆盖:
   * xxt login 300s / doc_convert 默认 120s——否则被引擎统一 60s
   * 超时先杀,工具内部声明的长超时形同虚设
   */
  timeoutMs?: number
  /**
   * 执行结果:字符串 = 纯文本(回填 LLM);
   * 对象 = 文本 + 图片附件(data URL,引擎注入助手消息 image part 供
   * 渲染端展示——如 bili 登录二维码,不依赖 LLM 复述长 base64)+
   * 媒体附件(2026-08-08:media part,渲染端 MediaFrame 窗口内播放)
   */
  execute(
    params: Record<string, unknown>,
    ctx?: ToolExecCtx,
  ): Promise<string | { text: string; image?: string; media?: MediaAttachment[] }>
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
  /**
   * 响应因输出预算(max_output_tokens)不足被截断(2026-08-08):
   * Responses = response.incomplete(reason max_output_tokens)、
   * Chat = finish_reason 'length'、Anthropic = stop_reason 'max_tokens'。
   * 引擎据此向 LLM 注入"预算不足"提示,引导其用 set_output_budget
   * 按需调大后继续,而不是顶着被截断的半截回复
   */
  truncated?: boolean
}

/** 引擎依赖(主进程注入) */
export interface EngineDeps {
  getConfig(): AgentConfig
  /** 事件转发(→ 渲染端) */
  onEvent(event: AgentEvent): void
  /** 共享外部工具源(2026-08-13 会话隔离并发):主进程为多个会话引擎
   * 提供同一 MCP 管理器/技能扫描器——避免每会话独立拉起 MCP 进程;
   * 未注入时引擎内部自建(测试/单引擎向后兼容) */
  externalTools?(): Promise<AgentTool[]>
  /** switch_to_music 工具:切换回音乐模式;play=true = 切换后立即开始
   * 播放当前播放列表(2026-08-11 用户"让 LLM 切音乐模式听歌没有自动播放") */
  onSwitchToMusic(play?: boolean): void
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
   * exec_command 确认门(confirmExec 开启时,每轮首个命令执行前调用;
   * 主进程持 pending,渲染端经 IPC 回用户选择,超时/无注入 = 拒绝)
   */
  confirmCommand?(command: string): Promise<boolean>
  /**
   * 通用动作确认门(2026-08-10,bili 批量下载等**每次调用**都须征求用户
   * 同意;与 confirmCommand 的"每轮首个命令确认一次"语义不同——本门
   * 每次调用都确认,不做轮内放行)。主进程实现与 confirmCommand 同款
   * 槽机制(并行确认互斥,超时 = 拒绝);未注入 = 直接放行(测试环境)
   */
  confirmAction?(title: string, detail: string): Promise<boolean>
  /**
   * 灵动岛设置工具:调渲染端设置桥(主进程注入,executeJavaScript 调
   * window.__islandSettings → 写 localStorage/IndexedDB → 派发
   * island-settings-changed 事件即时生效)。未注入则不注册设置工具
   */
  runIslandSettings?(op: string, args: unknown[]): Promise<unknown>
  /**
   * 音乐控制(2026-08-12,QQ 远程控制/后台对话):主进程经 executeJavaScript
   * 调 window.__islandMusicControl(外部 SMTC 优先,本地播放器兜底)。
   * 未注入则不注册 music_control 工具
   */
  runMusicControl?(op: string, args: unknown[]): Promise<unknown>
  /**
   * 会话管理工具(2026-08-13,用户要求"LLM 自己生成记录,自己清空当前
   * 会话上下文"):set_session_note / clear_session_context 的桥——主进程
   * 经 executeJavaScript 读写渲染端 localStorage + 派发
   * session-context-cleared 事件。key = 会话键('main' / private:<QQ> /
   * group:<群号>)。未注入则不注册会话工具
   */
  getSessionNote?(key: string): Promise<string>
  setSessionNote?(key: string, note: string): Promise<unknown>
  clearSessionContext?(key: string): Promise<unknown>
  /**
   * 主人 QQ 配置桥(2026-08-17,set_owner_qq 工具):getTurnSource 返回当前
   * 轮次来源('window' = 主人对话窗口直发,最高权限;'qq'/'group' = QQ
   * 外部;null = 询问/系统/主动轮);setOwnerQQ 写入 privacy.json masterQQ
   * 并刷新双端缓存。未注入则不注册工具
   */
  getTurnSource?(): string | null
  setOwnerQQ?(qq: string): { ok: boolean; error?: string }
  /**
   * NapCat QQ 机器人客户端(2026-08-12,main.cjs 创建注入):
   * 未注入则不注册 napcat 工具。收到的 QQ 消息经 main.cjs 转发渲染端
   * 进入对话;回复由 main.cjs 的 message 事件链路发回 QQ
   */
  napcat?: {
    status(): { connected: boolean; url: string; lastError: string; receivedCount: number; repliedCount: number }
    sendToQQ(qq: string, text: string): Promise<string>
    sendToGroup(groupId: string, text: string): Promise<string>
    getRecentMessages(): Array<{ qq: string; text: string; messageId: string; time: number; replied?: boolean }>
    /** 联系人档案(2026-08-12:napcat 工具 contacts/contact_update) */
    getContacts(): Promise<
      Record<string, { qq: string; name?: string; info?: string; source?: 'private' | 'group'; updatedAt: number }>
    >
    updateContact(patch: {
      qq: string
      name?: string
      info?: string
      source?: 'private' | 'group'
    }): Promise<{ qq: string; name?: string; info?: string; source?: 'private' | 'group'; updatedAt: number }>
  }
}

/** 记忆存储的引擎可见子集(避免 types ↔ memory 循环引用) */
export interface MemoryStoreLike {
  list(): Promise<MemoryEntry[]>
  add(input: {
    content: string
    type: MemoryEntry['type']
    source?: MemoryEntry['source']
    tags?: string[]
    protected?: boolean
  }): Promise<{ entry: MemoryEntry; created: boolean }>
  remove(key: string): Promise<number>
  update(
    id: string,
    patch: { content?: string; type?: MemoryEntry['type']; tags?: string[]; protected?: boolean },
  ): Promise<MemoryEntry | null>
  replaceAll(next: MemoryEntry[]): Promise<MemoryEntry[]>
  snapshot(backupPath: string): Promise<void>
  importEntries(next: MemoryEntry[]): Promise<{ imported: number; skipped: number }>
}

/** 自我进化 harness 的引擎可见子集 */
export interface EvolutionLike {
  requestEvolve(focus?: string, rounds?: number): Promise<{ started: boolean; message: string }>
  getStatus(): Promise<string>
}

/** 工具参数名 → 值的开放对象(工具 execute 收到的参数) */
export type ToolParams = Record<string, unknown>
