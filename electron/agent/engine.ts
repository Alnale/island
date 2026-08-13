/**
 * Agent 引擎入口
 *
 * 职责:对外暴露 createAgentEngine、引擎状态管理、工具数组组装、
 * send/proactiveTurn/abort 等对外接口实现。
 * 业务逻辑已按垂直域拆分到 engine-loop.ts / engine-tool-execution.ts /
 * engine-builtins.ts / engine-confirm-gate.ts,各业务文件自包含,允许代码重复。
 */

import { createRunTurn } from './engine-loop'
import { createDelegateTool } from './engine-tool-execution'
import { createBuiltinTools, fetchDeepseekBalance, MAIN_MAX_OUTPUT_TOKENS, MIN_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS } from './engine-builtins'
import { createTools, disposeTools } from './tools'
import { createMusicControlTools, createSettingsTools } from './settingsTools'
import { createSessionTools } from './sessionTools'
import { createMCPManager, type MCPManager } from './mcp'
import { createNapcatTools, type NapcatClient } from './napcat'
import { createSkillLoader } from './skills'
import { createMemoryTools } from './memory'
import { createConfigTools } from './configTools'
import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
  EngineDeps,
  McpServerConfig,
  MemoryStoreLike,
} from './types'

// 测试用导出(工具执行链路直测)
export { createTools }
// Sub Agent 相关导出(测试与 main.cjs 依赖路径)
export {
  compressArgs,
  sanitizeTitle,
  fallbackTitle,
  parseTitleJson,
  extractJsonTitle,
  extractJsonObject,
  looksLikeCodeLiteral,
  looksLikeSentenceTitle,
  looksLikeIncompleteMind,
  cutMindSentence,
  salvageMindClause,
  sanitizeMind,
  buildMindSystem,
  buildJudgeSystem,
  parseJudgeJson,
  parseMemoriesJson,
  parseStyleJson,
  buildMemoryExtractSystem,
  buildUserStyleSystem,
  createSummaryAgent,
  createMindAgent,
  SUMMARY_STYLES,
  MIND_PERSONAS,
  resolveSubAgentStyle,
} from './subagents'
export { createConfigTools } from './configTools'
export {
  createNapcatClient,
  stripThinkingPreamble,
  sessionKeyFor,
  isValidSessionKey,
  extractReplyToStranger,
  turnAlreadySentToPending,
  turnAlreadySentToTarget,
  isAskTurnToMaster,
  newTurnFingerprint,
  fingerprintMark,
  extractTurnFingerprint,
  REPLY_TO_STRANGER_MARK,
} from './napcat'

// 供测试使用的辅助函数(从 engine-loop 重新导出)
export {
  estimateMessageTokens,
  trimHistory,
  parseManualCall,
  findManualTool,
  matchManualToolPrefix,
  validateRequiredArgs,
  raceWithTimeout,
  MAX_STEPS,
} from './engine-loop'

// 供测试使用
export { createTurnConfirmGate } from './engine-confirm-gate'
export { fetchDeepseekBalance, MAIN_MAX_OUTPUT_TOKENS, MIN_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS } from './engine-builtins'

export interface AgentEngine {
  readonly busy: boolean
  readonly outputBudget: number
  send(text: string, history: AgentMessage[], sessionId?: string, sessionKey?: string): void
  proactiveTurn(history: AgentMessage[], opts?: { hint?: string; sessionId?: string }): void
  abort(): void
  listTools(): Array<{ name: string; description: string; parameters: AgentTool['parameters'] }>
  listAllTools(): Promise<Array<{ name: string; description: string; parameters: AgentTool['parameters'] }>>
  testMCP(server: McpServerConfig): Promise<{ ok: boolean; error?: string; toolCount?: number }>
  queryBalance(): Promise<{
    isAvailable: boolean
    balances: Array<{ currency: string; total: number; granted: number; toppedUp: number }>
  }>
  dispose(): void
}

export function createAgentEngine(deps: EngineDeps): AgentEngine {
  let running = false
  let ctl: AbortController | null = null
  let currentSessionId: string | null = null
  let currentSessionKey = 'main'

  // 可变输出预算(用对象包装以便各业务模块共享读写)
  const configuredBudget = deps.getConfig().maxOutputTokens
  const outputBudgetRef = {
    value:
      typeof configuredBudget === 'number' &&
      Number.isFinite(configuredBudget) &&
      configuredBudget >= MIN_OUTPUT_TOKENS &&
      configuredBudget <= MAX_OUTPUT_TOKENS
        ? configuredBudget
        : MAIN_MAX_OUTPUT_TOKENS,
  }

  const emit = (event: AgentEvent) => deps.onEvent({ ...event, sessionKey: currentSessionKey })

  // 外部工具源(MCP + 技能)
  const mcpManager: MCPManager = createMCPManager()
  const skillLoader = createSkillLoader()
  async function getExternalTools(): Promise<AgentTool[]> {
    if (deps.externalTools) {
      try {
        return await deps.externalTools()
      } catch (err) {
        console.error('[agent] 共享外部工具加载失败:', (err as Error).message)
        return []
      }
    }
    const cfg = deps.getConfig()
    const [mcpTools, skillTools] = await Promise.all([
      mcpManager.listTools(cfg.mcpServers ?? []).catch((err: Error) => {
        console.error('[agent] MCP 工具加载失败:', err.message)
        return []
      }),
      skillLoader.listTools(cfg.skillsDirs ?? [], cfg.excludedSkills ?? [], [
        deps.getSkillDir?.() ?? '',
      ]),
    ])
    return [...mcpTools, ...skillTools]
  }

  function excludedToolSet(): Set<string> {
    return new Set(deps.getConfig().excludedTools ?? [])
  }

  function getMemoryStore(): MemoryStoreLike | null {
    return deps.getMemoryStore?.() ?? null
  }

  async function getEvolutionStatus(): Promise<string> {
    return (await deps.getEvolution?.()?.getStatus()) ?? ''
  }

  // 内置专属工具(预算/进化/余额)
  const builtinTools = createBuiltinTools(outputBudgetRef, deps)

  // delegate 工具(需要延迟获取完整工具列表)
  const delegateTool = createDelegateTool({
    getConfig: deps.getConfig,
    getOutputBudget: () => outputBudgetRef.value,
    getAllTools: async () => {
      const core = getCoreTools()
      const ext = await getExternalTools()
      return [...core, ...ext].filter((t) => !excludedToolSet().has(t.name))
    },
  })

  // 核心工具列表(不含外部工具,外部工具每轮动态获取)
  function getCoreTools(): AgentTool[] {
    return [
      ...createTools({
        onSwitchToMusic: deps.onSwitchToMusic,
        onBackgroundDone: (info) => emit({ type: 'background-done', ...info }),
        confirmAction: deps.confirmAction,
        getOutputDir: () => deps.getConfig().outputDir?.trim() || null,
        getSessionId: () => currentSessionId,
      }),
      ...(deps.runIslandSettings
        ? createSettingsTools({ runIslandSettings: deps.runIslandSettings })
        : []),
      ...(deps.napcat ? createNapcatTools({
        client: deps.napcat as unknown as NapcatClient,
        getSessionKey: () => currentSessionKey,
        confirmDangerous: deps.confirmAction,
      }) : []),
      ...(deps.runMusicControl ? createMusicControlTools(deps.runMusicControl) : []),
      ...(deps.setSessionNote && deps.clearSessionContext
        ? createSessionTools({
            getSessionKey: () => currentSessionKey,
            getNote: deps.getSessionNote ?? (async () => ''),
            setNote: deps.setSessionNote,
            clearContext: deps.clearSessionContext,
          })
        : []),
      delegateTool,
      ...(getMemoryStore() ? createMemoryTools(() => getMemoryStore()) : []),
      ...createConfigTools({
        getConfig: deps.getConfig,
        updateAgentConfig: deps.updateAgentConfig,
        testMcp: (server) => mcpManager.test(server),
        listSkills: (dirs, excluded) => skillLoader.listTools(dirs, excluded),
        getSkillDir: deps.getSkillDir,
        listAllTools: () => getCoreTools(),
      }),
      ...builtinTools,
    ]
  }

  // 缓存核心工具列表(避免每次都重建,但配置变更后需要刷新——这里先简单重建,
  // 因为 createTools 本身开销不大,未来可加缓存失效)
  function getBuiltinToolsForLoop(): AgentTool[] {
    return getCoreTools()
  }

  // 创建主循环
  const runTurn = createRunTurn({
    getConfig: deps.getConfig,
    getMemoryStore,
    getEvolutionStatus,
    getExternalTools,
    excludedToolSet,
    getBuiltinTools: getBuiltinToolsForLoop,
    outputBudgetRef,
  })

  return {
    get busy() {
      return running
    },
    get outputBudget() {
      return outputBudgetRef.value
    },
    send(text, history, sessionId, sessionKey) {
      if (running) {
        emit({ type: 'error', message: 'Agent 正在运行中,请先等待或中止' })
        return
      }
      const config = deps.getConfig()
      if (!config.apiKey.trim()) {
        emit({ type: 'error', message: '尚未配置 DeepSeek API Key(托盘菜单 → 设置 → Agent 设置)' })
        return
      }
      currentSessionId = typeof sessionId === 'string' && sessionId ? sessionId : null
      currentSessionKey = typeof sessionKey === 'string' && sessionKey ? sessionKey : 'main'
      running = true
      const turnCtl = new AbortController()
      ctl = turnCtl
      void runTurn(text, history, { config, signal: turnCtl.signal, onEvent: emit })
        .catch((err: unknown) => {
          if ((err as Error).name !== 'AbortError') {
            emit({ type: 'error', message: (err as Error).message || String(err) })
          }
        })
        .finally(() => {
          if (ctl === turnCtl) {
            running = false
            ctl = null
          }
        })
    },
    proactiveTurn(history, opts) {
      if (running) return
      const config = deps.getConfig()
      if (!config.apiKey.trim()) return
      currentSessionId =
        typeof opts?.sessionId === 'string' && opts.sessionId ? opts.sessionId : null
      running = true
      const turnCtl = new AbortController()
      ctl = turnCtl
      void runTurn('', history, { config, signal: turnCtl.signal, onEvent: emit }, { proactive: true, hint: opts?.hint })
        .catch((err: unknown) => {
          if ((err as Error).name !== 'AbortError') {
            emit({ type: 'error', message: (err as Error).message || String(err) })
          }
        })
        .finally(() => {
          if (ctl === turnCtl) {
            running = false
            ctl = null
          }
        })
    },
    abort() {
      if (!running) return
      ctl?.abort()
      running = false
      ctl = null
      emit({ type: 'status', status: 'idle' })
    },
    listTools() {
      return getCoreTools().map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
    },
    async listAllTools() {
      const external = await getExternalTools()
      return [...getCoreTools(), ...external].map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        sourceKind: t.sourceKind,
      }))
    },
    async testMCP(server) {
      return mcpManager.test(server)
    },
    async queryBalance() {
      const config = deps.getConfig()
      return fetchDeepseekBalance({ baseURL: config.baseURL, apiKey: config.apiKey })
    },
    dispose() {
      mcpManager.dispose()
      disposeTools()
    },
  }
}

// 自我进化 harness 与记忆存储(独立模块,main.cjs 从同一打包产物取)
export { createEvolution } from './evolution'
export { setNotificationShower, showNotify } from './notify'
export { buildProfileCard } from './napcat'
export { createMemoryStore } from './memory'
export { createMCPManager } from './mcp'
export { createSkillLoader } from './skills'
// 撤销 git 快照(2026-08-14 停止与撤销分离;主进程 agent:undo-* IPC 用)
export { snapshotWatchDirs, restoreUndoSnapshot, releaseUndoRef } from './undo'
