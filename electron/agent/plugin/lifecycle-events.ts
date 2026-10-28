/**
 * 生命周期事件:turn/step 全链路(turn-start/end + step-start/end)
 *
 * 扩展点语义(参考架构文档"事件广度"一节):观测/审计/统计插件
 * **不改 engine-loop**——平行挂载事件监听器即可。主循环在回合与
 * 步的边界各发一对事件(fire-and-forget,监听器不阻塞执行流):
 *
 * - **agent/turn-start**:回合开始(历史组装完成时),携带用户输入与
 *   是否主动发言。
 * - **agent/turn-end**:回合结束(finally 语义——正常完成/中断/工具
 *   未找到/超步数上限均保证触发),携带 ok/步数/用量/耗时。
 * - **agent/step-start** / **agent/step-end**:每个 LLM 步的开始与
 *   结束(含工具调用数、是否被输出预算截断)。
 * - **agent/assistant-settled**:最终助手消息落定(无待执行工具),
 *   携带落定消息 + 含本轮的历史;标题/记忆落定插件平行挂载,不阻塞消息出口。
 *
 * 与能力事件(tools/pre-execute)的分工:能力事件是瀑布(可决策/改写),
 * 生命周期事件是纯观察(只读载荷,不影响执行流)。
 */

import type { AgentContext } from './kernel'
import type { AgentMessage } from '../types'

export const TURN_START = 'agent/turn-start' as const
export const TURN_END = 'agent/turn-end' as const
export const STEP_START = 'agent/step-start' as const
export const STEP_END = 'agent/step-end' as const
/** 助手消息落定(最终回复,无待执行工具):标题同步评估挂这里(心理刻画在引擎落定处判断) */
export const ASSISTANT_SETTLED = 'agent/assistant-settled' as const

/** 回合用量(与主循环内部累加结构一致) */
export interface TurnUsage {
  input: number
  output: number
  cached?: number
}

/** agent/turn-start 载荷 */
export interface TurnStartInfo {
  /** 本轮用户输入原文 */
  text: string
  /** 是否主动发言(系统触发) */
  proactive: boolean
  /** 进入回合时的历史条数(含本轮追加的用户消息) */
  historySize: number
}

/** agent/turn-end 载荷 */
export interface TurnEndInfo {
  /** 正常完成(消息落定)为 true;中断/未找到工具/超步数上限为 false */
  ok: boolean
  /** 结束时 AbortSignal 是否已触发 */
  aborted: boolean
  /** 实际经历的 LLM 步数(手动调用失败回合为 0) */
  steps: number
  durationMs: number
  usage: TurnUsage
}

/** agent/step-start 载荷 */
export interface StepStartInfo {
  step: number
  /** 本步可见工具数 */
  toolCount: number
}

/** agent/step-end 载荷 */
export interface StepEndInfo {
  step: number
  /** 本步模型发起的工具调用数 */
  callCount: number
  /** 是否因输出预算截断 */
  truncated: boolean
  durationMs: number
}

/** agent/assistant-settled 载荷(最终回复落定,与 message 事件同步发出) */
export interface AssistantSettledInfo {
  /** 本轮落定的助手消息 */
  message: AgentMessage
  /** 含本轮落定消息的完整历史(标题总结取最近 12 条) */
  history: AgentMessage[]
  /** 是否主动陪伴回合 */
  proactive: boolean
}

declare module './kernel' {
  interface ContextEventMap {
    'agent/turn-start': [TurnStartInfo]
    'agent/turn-end': [TurnEndInfo]
    'agent/step-start': [StepStartInfo]
    'agent/step-end': [StepEndInfo]
    'agent/assistant-settled': [AssistantSettledInfo]
  }
}

/** 生命周期事件记录器(测试辅助:按序收集事件名) */
export interface LifecycleRecorder {
  seq: string[]
  dispose(): void
}

/** 订阅四条生命周期事件并按触发顺序记录标签(测试专用) */
export function recordLifecycle(ctx: AgentContext): LifecycleRecorder {
  const seq: string[] = []
  const disposers = [
    ctx.on(TURN_START, (i) => seq.push(`turn-start:${i.historySize}`)),
    ctx.on(TURN_END, (i) => seq.push(`turn-end:ok=${i.ok}:steps=${i.steps}:aborted=${i.aborted}`)),
    ctx.on(STEP_START, (i) => seq.push(`step-start:${i.step}`)),
    ctx.on(STEP_END, (i) => seq.push(`step-end:${i.step}:calls=${i.callCount}`)),
  ]
  return { seq, dispose: () => disposers.forEach((d) => d()) }
}
