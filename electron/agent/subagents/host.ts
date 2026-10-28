/**
 * Sub Agent 能力宿主:一份单例装配全部工厂
 *
 * IPC(main.cjs)与引擎插件共用同一 host——标题评估不再出现「插件一份、
 * IPC 一份」双实例。能力表即架构:加一项能力 = 工厂 + 此处挂一行。
 * 心理刻画没有 Sub Agent:她在回复末行自己写下,引擎落定后判断。
 */

import {
  createProactiveAgent,
  createReplyClassifier,
  createSummaryAgent,
} from './subagents'
import type { LlmStreamParams } from '../plugin/llm'
import type { AgentConfig, EvolutionLike, MemoryStoreLike, ProviderOutcome, SubAgentHost } from '../types'

export interface SubAgentHostDeps {
  getConfig: () => AgentConfig
  getMemoryStore?(): MemoryStoreLike | null
  getEvolution?(): EvolutionLike | null
  getGroupStatus?(): Promise<string>
  stream?(params: LlmStreamParams): Promise<ProviderOutcome>
}

export function createSubAgentHost(deps: SubAgentHostDeps): SubAgentHost {
  return {
    summary: createSummaryAgent(deps),
    proactive: createProactiveAgent(deps),
    classifier: createReplyClassifier(deps),
  }
}
