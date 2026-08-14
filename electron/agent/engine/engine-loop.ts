/**
 * 主对话循环业务
 *
 * 职责:单轮完整对话循环(runTurn),包括系统提示组装、LLM 流式调用、
 * 手动调用处理、工具循环、消息落定。
 *
 * 插件化重构(2026-08-14):一切能力经 ctx 服务解析——工具 → ctx.tools、
 * LLM → ctx.llm、系统提示段落 → agent/pre-step 瀑布;loop 本身只编排
 * 执行流(Plugins, not loop changes)。
 * 三期细分:历史裁剪 → engine-history.ts、手动调用 → engine-manual-call.ts、
 * 回合文案 → engine-turn-text.ts、执行辅助复用 engine-tool-execution.ts。
 * 十一期:回合/步边界发 turn/step 生命周期事件(plugin/lifecycle-events.ts)——
 * 观测/审计插件平行挂载监听即可,loop 只多出四个 emit 点。
 * 十二期:Model-visible⟺Logged——每次调 LLM 前记完整模型可见快照、
 * 助手消息落定记一条(plugin/session-log.ts);loop 只多出两个 append 点。
 */

import { randomUUID } from 'node:crypto'
import { parseToolArgs } from '../tools/tool-args'
import { detectProvider } from '../providers/provider'
import { MASTER_IDENTITY_LINE, REPLY_RESTRAINT_LINE } from '../constants'
import {
  executeToolBatch,
  raceWithTimeout,
  validateRequiredArgs,
  MAX_STEPS,
  TOOL_TIMEOUT_MS,
} from './engine-tool-execution'
import { createTurnConfirmGate } from './engine-confirm-gate'
import { trimHistory } from './engine-history'
import { parseManualCall, findManualTool, matchManualToolPrefix } from './engine-manual-call'
import { BUDGET_TRUNCATE_HINT, PROACTIVE_INSTRUCTION } from './engine-turn-text'
import { PRE_STEP_EVENT } from '../plugin/prompt'
import { toolExecHooksOf } from '../plugin/tool-events'
import { STEP_END, STEP_START, TURN_END, TURN_START } from '../plugin/lifecycle-events'
import { sanitizeMessagesForLog } from '../plugin/session-log'
import type { AgentContext } from '../plugin/kernel'
import type {} from '../plugin/host' // config/events/outputBudget 服务声明
import type {} from '../plugin/llm' // ctx.llm 服务声明
import type {} from '../plugin/tool-registry' // ctx.tools 服务声明
import type {
  AgentConfig,
  AgentEvent,
  AgentMessage,
  AgentPart,
  MediaAttachment,
} from '../types'

interface TurnCtx {
  config: AgentConfig
  signal: AbortSignal
}

/**
 * 创建 runTurn 函数
 *
 * 插件化重构(2026-08-14):能力全部经 ctx 服务解析(工具/LLM/提示段落),
 * 入口(engine.ts)负责装配插件树;loop 只编排执行流。
 */
export function createRunTurn(ctx: AgentContext) {
  return async function runTurn(
    text: string,
    history: AgentMessage[],
    turn: TurnCtx,
    opts: { proactive?: boolean; hint?: string } = {},
  ) {
    const { signal, config } = turn
    const emit = (event: AgentEvent) => ctx.get('events').emit(event)
    emit({ type: 'status', status: 'thinking' })

    const historyIn: AgentMessage[] = [...trimHistory(history)]
    if (opts.proactive) {
      historyIn.push({
        id: randomUUID(),
        role: 'system',
        parts: [
          {
            type: 'text',
            text: PROACTIVE_INSTRUCTION + (opts.hint ? `\n(语境提示:${opts.hint})` : ''),
          },
        ],
      })
    } else {
      const lastMsg = historyIn[historyIn.length - 1]
      if (lastMsg?.role !== 'user') {
        historyIn.push({ id: randomUUID(), role: 'user', parts: [{ type: 'text', text }] })
      }
    }
    const msgParts: AgentPart[] = []
    let pushedParts = 0
    let reasoningText = ''
    let usage: { input: number; output: number; cached?: number } = { input: 0, output: 0 }
    let truncateHinted = false

    const gate = createTurnConfirmGate(config)
    const turnConfirmGate = gate.check

    // 生命周期事件:turn-start 于回合开始触发;turn-end 在 finally 保证
    // 触发(正常完成/中断/手动调用未找到工具/超步数上限全覆盖)。
    // try 块内保持原缩进以最小化 diff。
    const turnStartedAt = Date.now()
    let steps = 0
    let turnOk = false
    ctx.emit(TURN_START, { text, proactive: !!opts.proactive, historySize: historyIn.length })
    try {

    // 手动调用处理
    const manual = parseManualCall(text)
    if (manual) {
      const turnTools = await ctx.get('tools').listTurn()
      let found = findManualTool(turnTools, manual.name)
      let rest = manual.rest
      if (!found.tool) {
        const prefixed = matchManualToolPrefix(turnTools, manual.name)
        if (prefixed) {
          found = { tool: prefixed.tool, hint: '' }
          rest = prefixed.rest + (rest ? ' ' + rest : '')
        }
      }
      if (!found.tool) {
        emit({ type: 'error', message: found.hint })
        emit({ type: 'status', status: 'idle' })
        return
      }
      emit({ type: 'status', status: 'running' })
      const id = randomUUID()
      let args: Record<string, unknown> = {}
      const restTrimmed = rest.trim()
      if (restTrimmed) {
        try {
          const parsed = JSON.parse(restTrimmed)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed
        } catch {
          // 非 JSON:空参数
        }
      }
      emit({ type: 'tool-call', id, name: found.tool.name, args: JSON.stringify(args) })
      msgParts.push({ type: 'tool-call', id, name: found.tool.name, args })
      const started = Date.now()
      let ok = true
      let out = ''
      let outImage: string | undefined
      let outMedia: MediaAttachment[] | undefined
      try {
        const argError = validateRequiredArgs(found.tool, args)
        if (argError) throw new Error(argError)
        const raw = await raceWithTimeout(
          Promise.resolve(found.tool.execute(args, { signal })),
          found.tool.timeoutMs ?? TOOL_TIMEOUT_MS,
          found.tool.name,
          signal,
        )
        if (typeof raw === 'object') {
          out = raw.text
          outImage = raw.image
          outMedia = raw.media
        } else {
          out = raw
        }
      } catch (err) {
        ok = false
        out = `工具执行失败:${(err as Error).message}`
      }
      emit({ type: 'tool-result', id, name: found.tool.name, ok, result: out, durationMs: Date.now() - started })
      msgParts.push({ type: 'tool-result', id, name: found.tool.name, ok, result: out, durationMs: Date.now() - started })
      if (outImage) msgParts.push({ type: 'image', dataUrl: outImage })
      if (outMedia && outMedia.length > 0) {
        for (const m of outMedia) msgParts.push({ type: 'media', kind: m.kind, url: m.url, name: m.name })
      }
      if (detectProvider(config.baseURL) !== 'anthropic') {
        msgParts.unshift({ type: 'reasoning', text: `(手动调用工具:${found.tool.name})` })
      }
      historyIn.push({ id: randomUUID(), role: 'assistant', parts: msgParts.slice(0) })
      pushedParts = msgParts.length
    }

    for (let step = 1; step <= MAX_STEPS; step++) {
      if (signal.aborted) return
      // 系统提示:基础段(用户提示词 + 身份/约束常量行)经 agent/pre-step
      // 瀑布由各提示段落插件依次追加(记忆/进化/后台任务/工具指南)
      const baseSystem = [
        config.systemPrompt || '你是桌面灵动岛挂件里的个人助手。',
        MASTER_IDENTITY_LINE,
        REPLY_RESTRAINT_LINE,
      ]
        .filter(Boolean)
        .join('\n\n')
      const system = await ctx.runWaterfall(PRE_STEP_EVENT, baseSystem, {
        config,
        proactive: !!opts.proactive,
        hint: opts.hint,
      })
      const turnTools = await ctx.get('tools').listTurn()
      const turnMap = new Map(turnTools.map((t) => [t.name, t]))
      const stepStartedAt = Date.now()
      steps = step
      ctx.emit(STEP_START, { step, toolCount: turnTools.length })
      // Model-visible⟺Logged:调 LLM 前把完整模型可见集落进会话日志
      ctx.get('sessionLog').append({
        kind: 'model-request',
        step,
        system,
        history: sanitizeMessagesForLog(historyIn),
        tools: turnTools.map((t) => t.name),
      })
      const result = await ctx.get('llm').stream({
        config,
        system,
        history: historyIn,
        tools: turnTools,
        signal,
        maxOutputTokens: ctx.get('outputBudget').value,
        onEvent: (event) => {
          if (event.type === 'reasoning-delta') reasoningText += event.text
          emit(event)
        },
      })
      if (result.aborted || signal.aborted) return
      if (result.usage) {
        usage.input += result.usage.input_tokens
        usage.output += result.usage.output_tokens
        if (result.usage.cached_tokens) usage.cached = (usage.cached ?? 0) + result.usage.cached_tokens
      }
      if (reasoningText) {
        msgParts.push({ type: 'reasoning', text: reasoningText })
        reasoningText = ''
      }
      const replyText = result.text
      if (replyText) msgParts.push({ type: 'text', text: replyText })
      const calls = result.calls
      if (calls.length === 0 && !result.truncated) {
        ctx.emit(STEP_END, { step, callCount: 0, truncated: false, durationMs: Date.now() - stepStartedAt })
        const msgId = randomUUID()
        // Model-visible⟺Logged:落定的助手消息将在下一轮进入 history,先记录
        ctx.get('sessionLog').append({
          kind: 'assistant-message',
          message: { id: msgId, role: 'assistant', parts: msgParts },
        })
        emit({
          type: 'message',
          message: { id: msgId, role: 'assistant', parts: msgParts, proactive: opts.proactive || undefined },
          usage,
        })
        emit({ type: 'status', status: 'idle' })
        turnOk = true
        return
      }
      let results: Array<{
        id: string
        name: string
        ok: boolean
        out: string
        durationMs: number
        image?: string
        media?: MediaAttachment[]
      }> = []
      if (calls.length > 0) {
        emit({ type: 'status', status: 'running' })
        const batch: Array<{ id: string; name: string; args: Record<string, unknown> }> = []
        for (const call of calls) {
          if (signal.aborted) return
          const args = parseToolArgs(call.args)
          msgParts.push({ type: 'tool-call', id: call.id, name: call.name, args })
          batch.push({ id: call.id, name: call.name, args })
        }
        results = await executeToolBatch(batch, turnMap, turnTools, turnConfirmGate, signal, toolExecHooksOf(ctx))
      }
      for (const r of results) {
        if (signal.aborted) return
        emit({
          type: 'tool-result',
          id: r.id,
          name: r.name,
          ok: r.ok,
          result: r.out,
          durationMs: r.durationMs,
        })
        msgParts.push({
          type: 'tool-result',
          id: r.id,
          name: r.name,
          ok: r.ok,
          result: r.out,
          durationMs: r.durationMs,
        })
        if (r.image) msgParts.push({ type: 'image', dataUrl: r.image })
        if (r.media && r.media.length > 0) {
          for (const m of r.media) msgParts.push({ type: 'media', kind: m.kind, url: m.url, name: m.name })
        }
      }
      historyIn.push({ id: randomUUID(), role: 'assistant', parts: msgParts.slice(pushedParts) })
      pushedParts = msgParts.length
      if (result.truncated && !truncateHinted) {
        truncateHinted = true
        historyIn.push({ id: randomUUID(), role: 'system', parts: [{ type: 'text', text: BUDGET_TRUNCATE_HINT }] })
      }
      ctx.emit(STEP_END, { step, callCount: calls.length, truncated: !!result.truncated, durationMs: Date.now() - stepStartedAt })
    }

    emit({ type: 'error', message: `工具循环超过 ${MAX_STEPS} 轮仍未完成,已停止(请拆解任务或换种思路再试)` })
    emit({ type: 'status', status: 'idle' })

    } finally {
      ctx.emit(TURN_END, {
        ok: turnOk,
        aborted: signal.aborted,
        steps,
        durationMs: Date.now() - turnStartedAt,
        usage,
      })
    }
  }
}

// 导出供测试使用(实现在细分模块,此处保持 engine.ts 的既有 re-export 路径)
export {
  MAX_STEPS,
  TOOL_TIMEOUT_MS,
  raceWithTimeout,
  validateRequiredArgs,
} from './engine-tool-execution'
export { MAX_CONTEXT_TOKENS, MIN_KEEP_MESSAGES, estimateMessageTokens, trimHistory } from './engine-history'
export { parseManualCall, findManualTool, matchManualToolPrefix } from './engine-manual-call'
