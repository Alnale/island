/**
 * pre-step 提示段落插件(Consumer:消费 agent/pre-step 瀑布接缝)
 *
 * 注册顺序 = 拼装顺序:记忆 → 进化 → 后台任务 → 工具指南。
 * 每个段落插件只做一件事:在 baseSystem 上追加自己的文本块。
 * 新增段落 = 平行挂载一个新插件,不改 loop。
 */

import { PRE_STEP_EVENT } from './prompt'
import { MIND_REFLECT_LINE } from '../mind-reflect'
import { formatMemoryBlock } from '../memory'
import { formatPersonaBlock } from '../persona'
import { getTasksStatusBlock } from '../tasks'
import type { AgentContext, Plugin } from './kernel'

/**
 * 人格卡段落(2026-10-25):激活卡存在时注入 prompt 原文 + 进化整合区。
 * 无激活 / id 失效 / store 未注入 → 空串(静默跳过,不阻断对话)。
 * 放在记忆段之前:人格(身份/称谓/说话方式)优先于长期记忆的风格要求。
 */
export function personaPromptPlugin(): Plugin {
  return {
    name: 'prompt-persona',
    inject: ['personaStore'],
    apply(ctx: AgentContext) {
      ctx.waterfall(PRE_STEP_EVENT, async (system, next, info) => {
        const store = ctx.get('personaStore')
        const activeId = info?.config?.activePersonaId
        if (!store || !activeId) return next(system)
        let block = ''
        try {
          block = formatPersonaBlock(await store.list(), activeId)
        } catch {
          block = ''
        }
        return next(block ? `${system}\n\n${block}` : system)
      })
    },
  }
}

/** 长期记忆段落 */
export function memoryPromptPlugin(): Plugin {
  return {
    name: 'prompt-memory',
    inject: ['memoryStore'],
    apply(ctx: AgentContext) {
      ctx.waterfall(PRE_STEP_EVENT, async (system, next) => {
        const store = ctx.get('memoryStore')
        let block = ''
        if (store) {
          try {
            block = formatMemoryBlock(await store.list())
          } catch {
            block = ''
          }
        }
        return next(block ? `${system}\n\n${block}` : system)
      })
    },
  }
}

/** 自我进化状态段落 */
export function evolutionPromptPlugin(): Plugin {
  return {
    name: 'prompt-evolution',
    inject: ['evolution'],
    apply(ctx: AgentContext) {
      ctx.waterfall(PRE_STEP_EVENT, async (system, next) => {
        const block = (await ctx.get('evolution')?.getStatus()) ?? ''
        return next(block ? `${system}\n\n${block}` : system)
      })
    },
  }
}

/** 后台任务状态段落 */
export function bgTasksPromptPlugin(): Plugin {
  return {
    name: 'prompt-bg-tasks',
    apply(ctx: AgentContext) {
      ctx.waterfall(PRE_STEP_EVENT, async (system, next) => {
        const block = getTasksStatusBlock()
        return next(block ? `${system}\n\n${block}` : system)
      })
    },
  }
}

/**
 * 她自己的心理刻画(2026-10-26):挂在提示瀑布最后,让主 Agent 在回复
 * 末行写下岛面一句和输入框底字;等回复落定再判断。不另开模型来猜。
 */
export function mindPromptPlugin(): Plugin {
  return {
    name: 'prompt-mind',
    apply(ctx: AgentContext) {
      ctx.waterfall(PRE_STEP_EVENT, async (system, next) => next(`${system}\n\n${MIND_REFLECT_LINE}`))
    },
  }
}

/** 本机工具指南段落 */
export function toolsGuidePromptPlugin(): Plugin {
  return {
    name: 'prompt-tools-guide',
    apply(ctx: AgentContext) {
      ctx.waterfall(PRE_STEP_EVENT, async (system, next) => {
        // 惰性 import 打破 tools.ts ↔ 本文件的潜在顶层环
        const { buildToolsGuideBlock } = await import('../tools/tools')
        const block = buildToolsGuideBlock()
        return next(block ? `${system}\n\n${block}` : system)
      })
    },
  }
}
