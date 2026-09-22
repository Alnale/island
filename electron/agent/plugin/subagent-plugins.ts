/**
 * Sub Agent 落定插件:助手回复 → 同步评估标题 + 心理揣测
 *
 * 挂 agent/assistant-settled(fire-and-forget,不阻塞消息出口)。
 * 优先用 ctx.subagents(主进程单例);测试未注入时用本地工厂。
 * 只评估主对话;连续两轮只保留最新结果。
 */

import { ASSISTANT_SETTLED } from './lifecycle-events'
import { createMindAgent, createSummaryAgent } from '../subagents/subagents'
import { getDefaultLlmRuntime, type LlmStreamParams } from './llm'
import type { AgentContext, Plugin } from './kernel'
import type {} from './host'
import type { ProviderOutcome } from '../types'

export interface SubagentOnReplyConfig {
  stream?: (params: LlmStreamParams) => Promise<ProviderOutcome>
}

/** 助手回复落定 → 标题 + 心理揣测同步评估 */
export function mindGuessPlugin(config?: unknown): Plugin {
  const opts = (config && typeof config === 'object' ? config : {}) as SubagentOnReplyConfig
  return {
    name: 'subagent-on-reply',
    inject: ['config', 'events', 'sessionState'],
    apply(ctx: AgentContext) {
      let disposed = false
      ctx.effect(() => () => {
        disposed = true
      })
      const injected = opts.stream
      const stream = async (params: LlmStreamParams) => {
        if (disposed) return { calls: [], text: '', usage: null, aborted: true }
        return (injected ?? ((p: LlmStreamParams) => getDefaultLlmRuntime().stream(p)))(params)
      }
      const localMind = createMindAgent({
        getConfig: () => ctx.get('config').getConfig(),
        getMemoryStore: () => (ctx.has('memoryStore') ? ctx.get('memoryStore') : null),
        getEvolution: () => (ctx.has('evolution') ? ctx.get('evolution') : null),
        stream,
      })
      const localSummary = createSummaryAgent({
        getConfig: () => ctx.get('config').getConfig(),
        getMemoryStore: () => (ctx.has('memoryStore') ? ctx.get('memoryStore') : null),
        stream,
      })
      let seq = 0
      ctx.on(ASSISTANT_SETTLED, (info) => {
        if (disposed || ctx.get('sessionState').getSessionKey() !== 'main') return
        const my = ++seq
        const host = ctx.has('subagents') ? ctx.get('subagents') : null
        const mind = host?.mind ?? localMind
        const summary = host?.summary ?? localSummary
        void mind
          .guess(info.history)
          .then((guess) => {
            if (disposed || my !== seq || !guess) return
            ctx.get('events').emit({
              type: 'mind-guess',
              messageId: info.message.id,
              guess,
              proactive: info.proactive || undefined,
            })
          })
          .catch(() => {})
        void summary
          .summarize(info.history)
          .then((title) => {
            if (disposed || my !== seq || !title) return
            ctx.get('events').emit({
              type: 'conversation-title',
              messageId: info.message.id,
              title,
            })
          })
          .catch(() => {})
        if (ctx.get('config').getConfig().proactiveEnabled) {
          void summary
            .extractMemories(info.history)
            .then(async (entries) => {
              if (disposed || my !== seq || !entries.length) return
              const store = ctx.has('memoryStore') ? ctx.get('memoryStore') : null
              if (!store) return
              for (const e of entries) await store.add({ content: e.content, type: e.type, source: 'agent' })
            })
            .catch(() => {})
        }
      })
    },
  }
}
