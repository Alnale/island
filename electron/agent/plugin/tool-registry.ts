/**
 * 能力接缝 2:工具注册表(ctx.tools)
 *
 * 三角色模型(缺一不可):
 * - **Service Definition(本文件)**:ToolRegistry 拥有 ctx.tools key,
 *   维护静态注册工具 + 动态工具源;listTurn 在**每步执行时**解析
 *   (注册表 ∪ 动态源,按配置 excludedTools 过滤)。
 * - **Service Provider**:内置工具组(tools/settings/napcat/music/
 *   session/memory/config/builtins/delegate)与外部源(MCP + 技能)各自
 *   经 register/registerSource 注册进本接缝——provider **不拥有** key,
 *   注册即可逆效果(返回 disposer,卸载自动注销)。
 * - **Consumer**:engine-loop(主循环每步取工具)/ engine-tool-execution
 *   (delegate 子代理经 listTurn 取全量工具)。
 */

import type { AgentContext, Disposer, Plugin } from './kernel'
import type {} from './host' // 宿主服务声明(config 等 key 的声明合并)
import type { AgentTool } from '../types'

declare module './kernel' {
  interface ContextServices {
    tools: ToolRegistry
  }
}

/** 动态工具源(每步解析时实时调用,保持 MCP/技能配置变更即时生效) */
export type ToolSourceProvider = () => Promise<AgentTool[]>

/** 工具注册表(Service Definition) */
export interface ToolRegistry {
  /** 注册单个静态工具(即可逆效果) */
  register(tool: AgentTool): Disposer
  /** 批量注册一组静态工具(整组一条效果,卸载整组注销) */
  registerTools(tools: AgentTool[]): Disposer
  /** 注册动态工具源(list 时实时调用;label 仅诊断用) */
  registerSource(provider: ToolSourceProvider, label?: string): Disposer
  /** 静态注册工具快照(按注册顺序;设置界面/禁用校验用) */
  builtin(): AgentTool[]
  /** 静态 ∪ 动态源全部工具(不做排除过滤) */
  all(): Promise<AgentTool[]>
  /** 本回合可用工具:all() 按配置 excludedTools 过滤(Consumer 主入口) */
  listTurn(): Promise<AgentTool[]>
  /** 按名查静态工具(手动调用匹配用) */
  get(name: string): AgentTool | null
}

export function createToolRegistry(ctx: AgentContext): ToolRegistry {
  /** 静态工具:name → tool(Map 保序 = 注册顺序) */
  const tools = new Map<string, AgentTool>()
  const sources: Array<{ label: string; provider: ToolSourceProvider }> = []

  const registry: ToolRegistry = {
    register(tool) {
      return ctx.effect(
        () => {
          tools.set(tool.name, tool)
          return () => {
            if (tools.get(tool.name) === tool) tools.delete(tool.name)
          }
        },
        `tools.register(${tool.name})`,
      )
    },
    registerTools(group) {
      return ctx.effect(
        () => {
          for (const t of group) tools.set(t.name, t)
          return () => {
            for (const t of group) {
              if (tools.get(t.name) === t) tools.delete(t.name)
            }
          }
        },
        `tools.registerTools(${group.map((t) => t.name).join(',') || '(空)'})`,
      )
    },
    registerSource(provider, label = 'source') {
      return ctx.effect(
        () => {
          const entry = { label, provider }
          sources.push(entry)
          return () => {
            const i = sources.indexOf(entry)
            if (i >= 0) sources.splice(i, 1)
          }
        },
        `tools.registerSource(${label})`,
      )
    },
    builtin() {
      return [...tools.values()]
    },
    async all() {
      const dynamic: AgentTool[] = []
      for (const source of [...sources]) {
        try {
          dynamic.push(...(await source.provider()))
        } catch (err) {
          console.error(`[tools] 动态工具源加载失败(${source.label}):`, (err as Error).message)
        }
      }
      return [...tools.values(), ...dynamic]
    },
    async listTurn() {
      const excluded = new Set(ctx.get('config').getConfig().excludedTools ?? [])
      return (await registry.all()).filter((t) => !excluded.has(t.name))
    },
    get(name) {
      return tools.get(name) ?? null
    },
  }
  return registry
}

/** 类型化取服务 */
export function getToolRegistry(ctx: AgentContext): ToolRegistry {
  return ctx.get('tools')
}

/** 工具接缝初始化插件:注册 ctx.tools(接缝自带默认装配) */
export function toolRegistryPlugin(): Plugin {
  return {
    name: 'seam-tools',
    apply(ctx: AgentContext) {
      ctx.register('tools', createToolRegistry(ctx))
    },
  }
}
