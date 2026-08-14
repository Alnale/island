/**
 * 能力事件:工具执行链(tools/pre-execute + tools/post-execute)
 *
 * 扩展点语义(参考架构文档"Capability 事件:不导入 loop 即可给 seam
 * 附加策略与适配器"):策略/审计/限速插件**不改 engine-tool-execution**——
 * 平行挂载瀑布监听器即可。执行链在每次工具调用前后各跑一条瀑布:
 *
 * - **tools/pre-execute**:值 = 执行计划 { tool, args, deny? }。
 *   监听器可改写 args;设 `deny = 理由` 即拒绝执行(大声失败:理由成为
 *   工具失败结果回流给模型)。注册顺序 = 策略叠加顺序。
 * - **tools/post-execute**:值 = 执行结果 { tool, args, ok, out,
 *   durationMs }。监听器可改写结果(裁剪/标注),或做必须等待的审计记录。
 *
 * 接线单点:engine-loop(主循环)与 delegate 子代理都经 toolExecHooksOf(ctx)
 * 取得钩子注入 executeToolBatch——两处执行链共享同一套扩展点语义。
 */

import type { AgentContext } from './kernel'
import type { AgentTool } from '../types'

export const TOOL_PRE_EXECUTE = 'tools/pre-execute' as const
export const TOOL_POST_EXECUTE = 'tools/post-execute' as const

/** 执行计划(tools/pre-execute 瀑布值) */
export interface ToolExecutePlan {
  tool: AgentTool
  args: Record<string, unknown>
  /** 策略插件设置即拒绝执行(大声失败:理由成为工具失败结果) */
  deny?: string
}

/** 执行结果(tools/post-execute 瀑布值) */
export interface ToolExecuteOutcome {
  tool: AgentTool
  /** 实际执行所用参数(pre-execute 改写后的) */
  args: Record<string, unknown>
  ok: boolean
  out: string
  durationMs: number
}

declare module './kernel' {
  interface ContextWaterfallMap {
    /** 工具执行前:可改写参数或 deny 拒绝(不调用 next 即短路保留原计划) */
    'tools/pre-execute': [ToolExecutePlan, []]
    /** 工具执行后:可改写 ok/out(结果裁剪/标注/审计) */
    'tools/post-execute': [ToolExecuteOutcome, []]
  }
}

/** 执行链钩子(executeToolBatch 的中性入参,不依赖 ctx) */
export interface ToolExecHooks {
  preExecute(plan: ToolExecutePlan): Promise<ToolExecutePlan>
  postExecute(outcome: ToolExecuteOutcome): Promise<ToolExecuteOutcome>
}

/** 从 ctx 构造执行链钩子(主循环与 delegate 接线单点) */
export function toolExecHooksOf(ctx: AgentContext): ToolExecHooks {
  return {
    preExecute: (plan) => ctx.runWaterfall(TOOL_PRE_EXECUTE, plan),
    postExecute: (outcome) => ctx.runWaterfall(TOOL_POST_EXECUTE, outcome),
  }
}
