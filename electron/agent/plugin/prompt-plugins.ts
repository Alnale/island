/**
 * pre-step 提示段落插件(Consumer:消费 agent/pre-step 瀑布接缝)
 *
 * 注册顺序 = 拼装顺序:记忆 → 进化 → 后台任务 → 工具指南。
 * 每个段落插件只做一件事:在 baseSystem 上追加自己的文本块。
 * 新增段落 = 平行挂载一个新插件,不改 loop。
 */

import { PRE_STEP_EVENT } from './prompt'
import { formatMemoryBlock } from '../memory'
import { getTasksStatusBlock } from '../tasks'
import type { AgentContext, Plugin } from './kernel'

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
