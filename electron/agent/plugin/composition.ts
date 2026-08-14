/**
 * 声明式组合层:Profile → Patch 的配置驱动装配(dsh 对照收官项)
 *
 * 设计(参考架构文档第 4 节):引擎启动时的插件树不再由 index.ts 的
 * 硬编码序列决定,而是由一份**有序的 Profile(行清单)**声明,每行
 * `id + name + config`;patch 按 id 整体替换某行配置或插入新行。
 * "想换掉某个实现?把那一行的 name 改成另一个即可"——每一部分都可
 * 从配置替换,dump 即见真实启动树。
 *
 * 行语义(对齐 dsh):
 * - 工厂注册表 `name → factory`,name 是唯一的可替换耦合面;
 * - patch 按 id 定位,**整体替换该行**(不是合并)或在末尾插入新行;
 * - 行顺序即装配顺序;`enabled: false` 的行被跳过;
 * - 未知 name / 重复 id 大声失败(AGENT_COMPOSITION_LINE_UNKNOWN /
 *   AGENT_COMPOSITION_ID_DUP),绝不静默。
 *
 * host-bridge 需宿主 deps,经 CompositionEnv 注入;其余工厂忽略 env。
 */

import { hostBridgePlugin } from './host-bridge'
import { llmSeamPlugin } from './llm'
import { toolRegistryPlugin } from './tool-registry'
import { sessionLogPlugin } from './session-log'
import {
  builtinToolsPlugin,
  configToolsPlugin,
  coreToolsPlugin,
  delegateToolPlugin,
  externalToolsSourcePlugin,
  memoryToolsPlugin,
  musicToolsPlugin,
  napcatToolsPlugin,
  sessionToolsPlugin,
  settingsToolsPlugin,
} from './tool-plugins'
import {
  bgTasksPromptPlugin,
  evolutionPromptPlugin,
  memoryPromptPlugin,
  toolsGuidePromptPlugin,
} from './prompt-plugins'
import { AGENT_COMPOSITION_ID_DUP, AGENT_COMPOSITION_LINE_UNKNOWN, CodedError } from './errors'
import type { Plugin } from './kernel'
import type { SessionStateService } from './host'
import type { AgentEvent, EngineDeps } from '../types'

/** 装配宿主上下文(host-bridge 等需要 deps 的工厂从这里取) */
export interface CompositionEnv {
  deps: EngineDeps
  emit: (event: AgentEvent) => void
  outputBudget: { value: number }
  sessionState: SessionStateService
}

/** 插件工厂:由行 config 与 env 产出一个可挂载插件 */
export type PluginFactory = (config: unknown, env: CompositionEnv) => Plugin

/** Profile 的一行:id 定位、name 选实现、config 传参、enabled 开关 */
export interface CompositionLine {
  id: string
  name: string
  config?: unknown
  enabled?: boolean
}

/** Profile:一份有序行清单 */
export interface Profile {
  lines: CompositionLine[]
}

/**
 * 工厂注册表(name → factory)——组合层唯一的实现解析点。
 * 换实现 = 换行的 name;新增能力 = 注册工厂并在 Profile 加一行。
 */
export const PLUGIN_REGISTRY: Record<string, PluginFactory> = {
  'host-bridge': (_c, env) => hostBridgePlugin(env.deps, env.emit, env.outputBudget, env.sessionState),
  'seam-llm': () => llmSeamPlugin(),
  'seam-tools': () => toolRegistryPlugin(),
  'session-log': () => sessionLogPlugin(),
  'tools-core': () => coreToolsPlugin(),
  'tools-island-settings': () => settingsToolsPlugin(),
  'tools-napcat': () => napcatToolsPlugin(),
  'tools-music-control': () => musicToolsPlugin(),
  'tools-session': () => sessionToolsPlugin(),
  'tools-delegate': () => delegateToolPlugin(),
  'tools-memory': () => memoryToolsPlugin(),
  'tools-config': () => configToolsPlugin(),
  'tools-builtin': () => builtinToolsPlugin(),
  'tools-external-source': () => externalToolsSourcePlugin(),
  'prompt-memory': () => memoryPromptPlugin(),
  'prompt-evolution': () => evolutionPromptPlugin(),
  'prompt-bg-tasks': () => bgTasksPromptPlugin(),
  'prompt-tools-guide': () => toolsGuidePromptPlugin(),
}

/** 引擎缺省 Profile(与既有 builtinPlugins 的装配顺序逐位一致) */
export function defaultProfile(): Profile {
  return {
    lines: [
      { id: 'host-bridge', name: 'host-bridge' },
      { id: 'seam-llm', name: 'seam-llm' },
      { id: 'seam-tools', name: 'seam-tools' },
      { id: 'session-log', name: 'session-log' },
      { id: 'tools-core', name: 'tools-core' },
      { id: 'tools-island-settings', name: 'tools-island-settings' },
      { id: 'tools-napcat', name: 'tools-napcat' },
      { id: 'tools-music-control', name: 'tools-music-control' },
      { id: 'tools-session', name: 'tools-session' },
      { id: 'tools-delegate', name: 'tools-delegate' },
      { id: 'tools-memory', name: 'tools-memory' },
      { id: 'tools-config', name: 'tools-config' },
      { id: 'tools-builtin', name: 'tools-builtin' },
      { id: 'tools-external-source', name: 'tools-external-source' },
      { id: 'prompt-memory', name: 'prompt-memory' },
      { id: 'prompt-evolution', name: 'prompt-evolution' },
      { id: 'prompt-bg-tasks', name: 'prompt-bg-tasks' },
      { id: 'prompt-tools-guide', name: 'prompt-tools-guide' },
    ],
  }
}

/**
 * 应用 patch:按 id 定位——命中则**整体替换该行**(name/config 一并换),
 * 未命中则追加到末尾。返回新数组,不改 base。
 */
export function applyPatch(base: CompositionLine[], patch: CompositionLine[]): CompositionLine[] {
  const out = base.map((l) => ({ ...l }))
  for (const line of patch) {
    const i = out.findIndex((l) => l.id === line.id)
    if (i >= 0) out[i] = { ...line }
    else out.push({ ...line })
  }
  return out
}

/** 校验行清单:重复 id / 未知 name 大声失败(装配前最早可解析点) */
export function assertLinesValid(lines: CompositionLine[]): void {
  const seen = new Set<string>()
  for (const line of lines) {
    if (seen.has(line.id)) {
      throw new CodedError(AGENT_COMPOSITION_ID_DUP, `组合行 id 重复:${line.id}`)
    }
    seen.add(line.id)
    if (!PLUGIN_REGISTRY[line.name]) {
      throw new CodedError(
        AGENT_COMPOSITION_LINE_UNKNOWN,
        `组合行 name 未注册:${line.name}(id=${line.id})`,
      )
    }
  }
}

/** 经 Profile + patch 解析出有序插件列表(enabled: false 的行被跳过) */
export function composeProfile(env: CompositionEnv, profile?: Profile, patch?: CompositionLine[]): Plugin[] {
  const base = profile?.lines ?? defaultProfile().lines
  const lines = patch && patch.length > 0 ? applyPatch(base, patch) : base
  assertLinesValid(lines)
  return lines.filter((l) => l.enabled !== false).map((l) => PLUGIN_REGISTRY[l.name](l.config, env))
}

/** dump 真实启动树(对应 `--dump-config`:透明可见、任何一行可被 patch 覆盖) */
export function dumpComposition(profile?: Profile, patch?: CompositionLine[]): Array<Pick<CompositionLine, 'id' | 'name' | 'enabled'>> {
  const base = profile?.lines ?? defaultProfile().lines
  const lines = patch && patch.length > 0 ? applyPatch(base, patch) : base
  assertLinesValid(lines)
  return lines.map((l) => ({ id: l.id, name: l.name, enabled: l.enabled !== false }))
}
