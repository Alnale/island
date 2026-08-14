/**
 * 宿主桥插件(Host Bridge)
 *
 * 唯一接触 Electron 宿主依赖(EngineDeps)的插件:把宿主能力翻译为
 * ctx 服务(host.ts 声明的 key)。其他所有插件只消费服务,不知道宿主存在。
 */

import { createMCPManager } from '../mcp'
import { createSkillLoader } from '../skills'
import type { AgentContext, Plugin } from './kernel'
import type { SessionStateService } from './host'
import type { AgentEvent, EngineDeps } from '../types'

/** 宿主桥:把 EngineDeps 翻译为 ctx 服务 */
export function hostBridgePlugin(
  deps: EngineDeps,
  emit: (event: AgentEvent) => void,
  outputBudget: { value: number },
  sessionState: SessionStateService,
): Plugin {
  return {
    name: 'host-bridge',
    apply(ctx: AgentContext) {
      const mcpManager = createMCPManager()
      const skillLoader = createSkillLoader()

      ctx.register('config', { getConfig: deps.getConfig })
      ctx.register('events', { emit })
      ctx.register('outputBudget', outputBudget)
      ctx.register('sessionState', sessionState)
      ctx.register('confirm', {
        confirmCommand: deps.confirmCommand,
        confirmAction: deps.confirmAction,
      })
      ctx.register('mcpManager', mcpManager)
      ctx.register('skillLoader', skillLoader)
      ctx.register('switchToMusic', deps.onSwitchToMusic)
      ctx.register('updateConfig', deps.updateAgentConfig)
      ctx.register('skillDir', deps.getSkillDir)
      ctx.register('islandSettings', deps.runIslandSettings)
      ctx.register('musicControl', deps.runMusicControl)
      ctx.register(
        'sessionBridge',
        deps.setSessionNote && deps.clearSessionContext
          ? {
              getNote: deps.getSessionNote ?? (async () => ''),
              setNote: deps.setSessionNote,
              clearContext: deps.clearSessionContext,
            }
          : undefined,
      )
      ctx.register('napcatClient', deps.napcat as never)
      ctx.register('memoryStore', deps.getMemoryStore?.() ?? null)
      ctx.register('evolution', deps.getEvolution?.() ?? null)

      // 外部工具源:宿主共享注入优先(多会话引擎共用 MCP 进程);
      // 缺省引擎自建(MCP + 技能,每步实时调用)
      const externalTools =
        deps.externalTools ??
        (async () => {
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
        })
      ctx.register('externalTools', externalTools)

      // MCP 管理器随引擎销毁回收(技能扫描器无资源)
      return () => mcpManager.dispose()
    },
  }
}
