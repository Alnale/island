/**
 * Agent 引擎入口 —— 组合层(2026-08-14 插件化重构)
 *
 * 职责:对外暴露 createAgentEngine、引擎状态管理、send/proactiveTurn/abort
 * 等对外接口实现。
 *
 * 内部不再有"特权核心":createAgentEngine 只是把插件树装配出来——
 * 1. hostBridgePlugin 把宿主的 EngineDeps 翻译为 ctx 服务;
 * 2. llm/tools 两个能力接缝(Service Definition)注册 ctx.llm / ctx.tools;
 * 3. 各工具组/外部源/提示段落作为平行插件挂载(注册即可逆效果);
 * 4. agent loop 本身也注册为服务(agentLoop)——唯一的 loop 实现也只是
 *    插件之一,扩展方依赖事件与服务而不是它。
 * 业务逻辑仍按垂直域拆分在 engine-loop.ts / engine-tool-execution.ts /
 * engine-builtins.ts / engine-confirm-gate.ts。
 */

import { createContext } from '../plugin/kernel'
import type { AgentContext } from '../plugin/kernel'
import { builtinPlugins } from '../plugin'
import type {} from '../plugin/host' // 宿主服务键声明
import { createRunTurn } from './engine-loop'
import { fetchDeepseekBalance, MAIN_MAX_OUTPUT_TOKENS, MIN_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS } from './engine-builtins'
import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
  EngineDeps,
  McpServerConfig,
} from '../types'

/** agentLoop 服务:唯一的 loop 实现也只是插件之一(扩展依赖事件与服务而非它) */
type RunTurnFn = ReturnType<typeof createRunTurn>
declare module '../plugin/kernel' {
  interface ContextServices {
    agentLoop: RunTurnFn
  }
}

// 测试用导出(工具执行链路直测)
export { createTools } from '../tools/tools'
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
  buildClassifierSystem,
  parseClassifierJson,
  createSummaryAgent,
  createMindAgent,
  createReplyClassifier,
  SUMMARY_STYLES,
  MIND_PERSONAS,
  resolveSubAgentStyle,
} from '../subagents/subagents'
export { createConfigTools } from '../tools/configTools'
export {
  createNapcatClient,
  stripThinkingPreamble,
  isSuspectedMonologue,
  sessionKeyFor,
  isValidSessionKey,
  extractReplyToStranger,
  turnAlreadySentToPending,
  turnAlreadySentToTarget,
  isAskTurnToMaster,
  newTurnFingerprint,
  fingerprintMark,
  extractTurnFingerprint,
  extractMasterFingerprint,
  stripFingerprintMarks,
  routeForClassifierIntent,
  looksLikeForwardInstruction,
  REPLY_TO_STRANGER_MARK,
} from '../napcat/napcat'
export type {
  ReplyIntent,
  ClassifierTurnKind,
  ClassifierRouteAction,
} from '../napcat/napcat'
// NapCat 持久化域工具(2026-08-18 会话删除 / 清除数据补全,供主进程调用)
export { deleteNapcatChatsFor, resetNapcatStore } from '../napcat/napcat'

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

  // 可变输出预算(用对象包装以便各插件经 ctx.outputBudget 服务共享读写)
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

  // **2026-08-16 修复"后台任务完成通知串会话"**:事件 sessionKey 注入
  // 改为"显式键优先"——background-done 事件带任务发起会话键(task.
  // sessionKey,见 tools.ts onBackgroundDone)时必须透传,不能被本引擎
  // currentSessionKey 覆盖(多会话引擎并存时,任务终态回调由最后装配的
  // 引擎发出,其 currentSessionKey 未必是发起下载的会话);普通事件
  // (message/status 等)不带显式键,沿用引擎当前会话键
  const emit = (event: AgentEvent) => deps.onEvent({ ...event, sessionKey: event.sessionKey ?? currentSessionKey })

  // per-agent 上下文:每引擎一份(主对话与每个外部会话天然隔离)
  const ctx: AgentContext = createContext('agent-engine')

  // 组合层装配:宿主桥 → 接缝 → 工具组插件(顺序 = 工具列表呈现顺序)
  // → 外部工具源 → pre-step 提示段落插件(顺序 = 拼装顺序)
  // 完整有序清单由 plugin/index.ts 的 builtinPlugins() 单点声明
  for (const plugin of builtinPlugins(deps, emit, outputBudgetRef, {
    getSessionId: () => currentSessionId,
    getSessionKey: () => currentSessionKey,
  })) {
    ctx.plugin(plugin)
  }

  // agent loop 注册为服务(唯一实现也只是插件之一)
  const runTurn = createRunTurn(ctx)
  ctx.register('agentLoop', runTurn)

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
      void ctx.get('agentLoop')(text, history, { config, signal: turnCtl.signal })
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
      void ctx.get('agentLoop')('', history, { config, signal: turnCtl.signal }, { proactive: true, hint: opts?.hint })
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
      return ctx.get('tools').builtin().map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
    },
    async listAllTools() {
      return (await ctx.get('tools').all()).map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        sourceKind: t.sourceKind,
      }))
    },
    async testMCP(server) {
      return ctx.get('mcpManager').test(server)
    },
    async queryBalance() {
      const config = deps.getConfig()
      return fetchDeepseekBalance({ baseURL: config.baseURL, apiKey: config.apiKey })
    },
    dispose() {
      // 注册即可逆效果:一切注册按逆序回滚(MCP 进程/工具/docflow 子进程)
      ctx.dispose()
    },
  }
}

// 自我进化 harness 与记忆存储(独立模块,main.cjs 从同一打包产物取)
export { createEvolution } from '../evolution'
export { invalidatePrivacyCache } from '../privacy'
export { setNotificationShower, showNotify } from '../notify'
export { buildProfileCard } from '../napcat/napcat'
export { createMemoryStore } from '../memory'
export { createMCPManager } from '../mcp'
export { createSkillLoader } from '../skills'
// 撤销 git 快照(2026-08-14 停止与撤销分离;主进程 agent:undo-* IPC 用)
export { snapshotWatchDirs, restoreUndoSnapshot, releaseUndoRef } from '../undo'
