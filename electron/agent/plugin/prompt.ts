/**
 * 能力接缝 3:系统提示拼装(agent/pre-step 瀑布)
 *
 * 扩展点语义(参考架构文档"事件即扩展点"):系统提示不再由 loop 硬编码
 * 拼装——loop 只给出基础提示(用户 systemPrompt + 身份/约束常量行),
 * 各提示段落(记忆/进化状态/后台任务/工具指南)作为独立插件挂
 * agent/pre-step 瀑布监听器依次追加。以后新增提示段落 = 平行挂载一个
 * 新插件,**不改 loop**(Plugins, not loop changes)。
 *
 * 瀑布为 around 中间件语义:监听器收 (system, next, info),调用
 * next(改写后的 system) 委托给下一个监听器;不调用即短路(策略监听器
 * 拥有决策权时可以短路)。注册顺序 = 拼装顺序。
 */

import type { AgentConfig } from '../types'

/** 回合信息(瀑布附加参数:监听器据此决定注入什么) */
export interface PreStepInfo {
  config: AgentConfig
  /** 主动陪伴回合(无用户输入,提示段落可据此收敛) */
  proactive: boolean
  /** 主动陪伴语境提示 */
  hint?: string
}

/** 瀑布事件名常量 */
export const PRE_STEP_EVENT = 'agent/pre-step' as const

declare module './kernel' {
  interface ContextWaterfallMap {
    /** 系统提示拼装:值 = 累积的 system 文本 */
    'agent/pre-step': [string, [PreStepInfo]]
  }
}
