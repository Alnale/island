/**
 * 内置插件集装配(组合层入口)
 *
 * 十三期起装配由**声明式组合层**驱动(composition.ts):builtinPlugins()
 * 把缺省 Profile(defaultProfile 的有序行清单)经 composeProfile 解析为
 * 插件树;opts.profile / opts.patch 可整体替换或按 id 覆盖任意一行——
 * "想换掉某个实现,把那一行的 name 换掉即可"。缺省装配与既往硬编码
 * 序列逐位一致,行为零变化。
 *
 * 文件划分(按领域细分):
 * - composition.ts   声明式组合层(Profile/Patch/工厂注册表/dump)
 * - host-bridge.ts   宿主桥(唯一接触 EngineDeps 的插件)
 * - llm.ts           LLM 接缝 + 初始化插件(llmSeamPlugin)
 * - tool-registry.ts 工具接缝 + 初始化插件(toolRegistryPlugin)
 * - tool-plugins.ts  各工具组插件(Consumer)
 * - prompt-plugins.ts pre-step 提示段落插件(Consumer)
 *
 * 纪律:新增能力 = 在对应领域文件写一个插件 + 注册工厂 + Profile 加一行,
 * 不改 loop、不改其他插件;装配清单在 defaultProfile 单点声明、dump 可见。
 */

import { composeProfile, type CompositionEnv, type CompositionLine, type Profile } from './composition'
import type { Plugin } from './kernel'
import type { SessionStateService } from './host'
import type { AgentEvent, EngineDeps } from '../types'

/** builtinPlugins 组合选项(profile 整体替换缺省;patch 按 id 覆盖/插入行) */
export interface BuiltinPluginsOptions {
  profile?: Profile
  patch?: CompositionLine[]
}

/** 装配引擎完整能力树的有序插件清单(声明式组合层驱动) */
export function builtinPlugins(
  deps: EngineDeps,
  emit: (event: AgentEvent) => void,
  outputBudget: { value: number },
  sessionState: SessionStateService,
  opts?: BuiltinPluginsOptions,
): Plugin[] {
  const env: CompositionEnv = { deps, emit, outputBudget, sessionState }
  return composeProfile(env, opts?.profile, opts?.patch)
}

// 细分插件工厂全部导出(测试与外部装配可单独取用)
export { hostBridgePlugin } from './host-bridge'
export { llmSeamPlugin } from './llm'
export { toolRegistryPlugin } from './tool-registry'
export { sessionLogPlugin } from './session-log'
export * from './composition'
export * from './tool-plugins'
export * from './prompt-plugins'
export * from './tool-events'
export * from './lifecycle-events'
