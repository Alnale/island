/**
 * 宿主服务声明(EngineDeps → ctx 服务键的类型映射)
 *
 * createAgentEngine 收到宿主的 EngineDeps 后,经 hostBridgePlugin 把各
 * 字段翻译为本文件声明的 ctx 服务——EngineDeps 由此退化为"宿主能力
 * 注入清单",不再穿透到 loop/工具内部;插件按 key 发现宿主能力。
 *
 * 可选宿主能力(未注入)以 `| undefined` / `| null` 注册:对应工具插件
 * 探测到空值即不激活(保持"未注入则不注册"的既有语义)。
 */

import type { AgentConfig, AgentEvent, AgentTool, EvolutionLike, MemoryStoreLike } from '../types'
import type { MCPManager } from '../mcp'
import type { NapcatClient } from '../napcat/napcat'
import type { createSkillLoader } from '../skills'

/** 技能扫描器(无导出类型名,以 ReturnType 指代) */
export type SkillLoader = ReturnType<typeof createSkillLoader>

/** 会话级可变状态(引擎入口持有,工具经服务惰性读取) */
export interface SessionStateService {
  getSessionId(): string | null
  getSessionKey(): string
}

/** 确认门(命令确认 = 每轮首个 exec_command;动作确认 = 每次调用) */
export interface ConfirmService {
  confirmCommand?(command: string): Promise<boolean>
  confirmAction?(title: string, detail: string): Promise<boolean>
}

/** 会话管理桥(set_session_note / clear_session_context) */
export interface SessionBridgeService {
  getNote(key: string): Promise<string>
  setNote(key: string, note: string): Promise<unknown>
  clearContext(key: string): Promise<unknown>
}

/** 主人 QQ 配置桥(set_owner_qq 工具) */
export interface OwnerConfigService {
  /** 当前轮次来源:'window' = 主人对话窗口直发;'qq'/'group' = QQ 外部;null = 询问/系统/主动轮 */
  getTurnSource(): string | null
  /** 写入 privacy.json masterQQ 并刷新双端缓存 */
  setOwnerQQ(qq: string): { ok: boolean; error?: string }
}

declare module './kernel' {
  interface ContextServices {
    /** Agent 配置(每步实时读,配置变更即时生效) */
    config: { getConfig(): AgentConfig }
    /** 引擎事件出口(→ 渲染端;sessionKey 由入口统一附加) */
    events: { emit(event: AgentEvent): void }
    /** 可变输出预算(主循环与 set_output_budget 工具共享读写) */
    outputBudget: { value: number }
    /** 会话级可变状态 */
    sessionState: SessionStateService
    /** 确认门 */
    confirm: ConfirmService
    /** MCP 管理器(引擎私有或宿主共享注入) */
    mcpManager: MCPManager
    /** 技能扫描器 */
    skillLoader: SkillLoader
    /** 外部工具源(MCP + 技能;宿主共享注入优先,缺省引擎自建) */
    externalTools: () => Promise<AgentTool[]>
    /** switch_to_music 工具出口 */
    switchToMusic: (play?: boolean) => void
    /** LLM 自我配置写入(settings.json agent 段) */
    updateConfig: ((patch: Partial<AgentConfig>) => void) | undefined
    /** 技能目录绝对路径(create_skill 写入) */
    skillDir: (() => string) | undefined
    /** 灵动岛设置桥(未注入 = 不注册设置工具) */
    islandSettings: ((op: string, args: unknown[]) => Promise<unknown>) | undefined
    /** 音乐控制桥(未注入 = 不注册 music_control) */
    musicControl: ((op: string, args: unknown[]) => Promise<unknown>) | undefined
    /** 会话管理桥(未注入 = 不注册会话工具) */
    sessionBridge: SessionBridgeService | undefined
    /** 主人 QQ 配置桥(未注入 = 不注册 set_owner_qq 工具) */
    ownerConfig: OwnerConfigService | undefined
    /** NapCat QQ 客户端(未注入 = 不注册 napcat 工具) */
    napcatClient: NapcatClient | undefined
    /** 记忆存储(null = 记忆工具/记忆提示块不可用) */
    memoryStore: MemoryStoreLike | null
    /** 自我进化 harness(null = evolve 工具不可用) */
    evolution: EvolutionLike | null
  }
}
