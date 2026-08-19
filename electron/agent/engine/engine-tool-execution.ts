/**
 * 工具执行业务
 *
 * 职责:批量工具执行、子代理(delegate)运行、delegate 工具定义。
 * 自包含工具执行所需的辅助函数(raceWithTimeout、validateRequiredArgs,
 * 导出供主循环复用——允许与主循环独立演化);回合级共享文案经
 * engine-turn-text.ts 单点维护。
 */

import { randomUUID } from 'node:crypto'
import { parseToolArgs } from '../tools/tool-args'
import { createTurnConfirmGate } from './engine-confirm-gate'
import { BUDGET_TRUNCATE_HINT } from './engine-turn-text'
import type { ToolExecHooks } from '../plugin/tool-events'
import type { LlmStreamParams } from '../plugin/llm'
import type {
  AgentConfig,
  AgentMessage,
  AgentPart,
  AgentTool,
  MediaAttachment,
  ProviderOutcome,
  ToolParams,
} from '../types'

/** 工具循环迭代上限(程序级保险) */
const MAX_STEPS = 1000
/** 单个工具执行兜底超时(ms) */
const TOOL_TIMEOUT_MS = 60_000
/** 子代理循环每步内部超时 */
const SUBAGENT_STEP_TIMEOUT_MS = 55_000

/**
 * 工具执行兜底超时(导出供主循环复用)
 */
export function raceWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
  name: string,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`工具执行超时(${Math.round(ms / 1000)}s):${name}`)),
      ms,
    )
    const onAbort = () => reject(new DOMException('aborted', 'AbortError'))
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer)
        reject(new DOMException('aborted', 'AbortError'))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    promise.then(
      (v) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (err) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

/**
 * 工具参数校验(导出供主循环复用)
 */
export function validateRequiredArgs(
  tool: AgentTool,
  args: Record<string, unknown>,
): string | null {
  const required = tool.parameters?.required ?? []
  if (required.length === 0) return null
  const missing: string[] = []
  for (const key of required) {
    const v = args[key]
    if (v === undefined || v === null || v === '') missing.push(key)
  }
  if (missing.length === 0) return null
  const props = (tool.parameters?.properties ?? {}) as Record<
    string,
    { type?: string; description?: string; enum?: unknown[] }
  >
  const hints = missing
    .map((k) => {
      const p = props[k] ?? {}
      const type = p.type ?? 'string'
      const desc = p.description ? `,${p.description}` : ''
      const enumHint = Array.isArray(p.enum) && p.enum.length > 0 ? `,可选值:${p.enum.join('/')}` : ''
      return `"${k}"(${type}${desc}${enumHint})`
    })
    .join('、')
  const rawHint = typeof args._raw === 'string' ? `(本次收到的参数无法解析为 JSON,原文:${args._raw.slice(0, 100)})` : ''
  return (
    `工具 ${tool.name} 缺少必需参数:${missing.join('、')}。` +
    `参数要求:${hints}。${rawHint}请重新调用该工具,一次性提供完整参数。`
  )
}

/**
 * 并发执行一批工具调用(每个独立超时),按传入的顺序返回结果
 *
 * hooks(2026-08-14 能力事件):每次调用前跑 tools/pre-execute 瀑布
 * (可改写参数或 deny 拒绝),后跑 tools/post-execute 瀑布(可改写结果);
 * 未注入钩子时行为与旧版完全一致。
 */
export async function executeToolBatch(
  batch: Array<{ id: string; name: string; args: Record<string, unknown> }>,
  map: Map<string, AgentTool>,
  list: AgentTool[],
  confirmGate?: (name: string, args: Record<string, unknown>) => Promise<boolean>,
  signal?: AbortSignal,
  hooks?: ToolExecHooks,
): Promise<
  Array<{
    id: string
    name: string
    ok: boolean
    out: string
    durationMs: number
    image?: string
    media?: MediaAttachment[]
  }>
> {
  return Promise.all(
    batch.map(async ({ id, name, args }) => {
      const tool = map.get(name)
      const started = Date.now()
      let out: string
      let ok: boolean
      let image: string | undefined
      let media: MediaAttachment[] | undefined
      let execArgs = args
      if (!tool) {
        out = `未知工具:${name}(可用工具:${list.map((t) => t.name).join('、')})`
        ok = false
      } else {
        // tools/pre-execute:策略插件可改写参数或 deny 拒绝(大声失败)
        const plan = hooks ? await hooks.preExecute({ tool, args }) : { tool, args }
        execArgs = plan.args
        if (plan.deny) {
          out = `工具执行被拒绝:${plan.deny}`
          ok = false
        } else {
          try {
            if (confirmGate && !(await confirmGate(name, execArgs))) {
              out = '用户拒绝了命令执行'
              ok = false
            } else {
              const argError = validateRequiredArgs(tool, execArgs)
              if (argError) {
                out = `工具执行失败:${argError}`
                ok = false
              } else {
                const raw = await raceWithTimeout(
                  Promise.resolve(tool.execute(execArgs, { signal })),
                  tool.timeoutMs ?? TOOL_TIMEOUT_MS,
                  name,
                  signal,
                )
                if (typeof raw === 'object') {
                  out = raw.text
                  image = raw.image
                  media = raw.media
                } else {
                  out = raw
                }
                ok = true
              }
            }
          } catch (err) {
            out = `工具执行失败:${(err as Error).message}`
            ok = false
          }
        }
        // tools/post-execute:策略插件可改写结果(裁剪/标注/审计)
        if (hooks) {
          const after = await hooks.postExecute({ tool, args: execArgs, ok, out, durationMs: Date.now() - started })
          ok = after.ok
          out = after.out
        }
      }
      return { id, name, ok, out, media, image, durationMs: Date.now() - started }
    }),
  )
}

/**
 * 子代理:嵌套 agent 循环(独立上下文,事件静默,返回结果文本)
 * 本函数不直接导出,由 createDelegateTool 创建的工具调用
 */
async function runSubAgent(
  params: ToolParams,
  getConfig: () => AgentConfig,
  getOutputBudget: () => number,
  getAllTools: () => Promise<AgentTool[]>,
  stream: (p: LlmStreamParams) => Promise<ProviderOutcome>,
  signal?: AbortSignal,
  hooks?: ToolExecHooks,
): Promise<string> {
  const task = String(params.task ?? '').trim()
  if (!task) throw new Error('delegate 的 task 参数不能为空')
  const config = getConfig()
  // LM Studio 本地端点免 Key 放行(2026-08-18,与 engine.ts 同款规则)
  {
    const u = (config.baseURL || '').toLowerCase()
    const free =
      config.apiKey.trim() ||
      config.activeProvider === 'lmstudio' ||
      u.includes('lmstudio') ||
      u.includes('127.0.0.1:1234') ||
      u.includes('localhost:1234')
    if (!free) throw new Error('尚未配置 API Key(云端供应商到 Agent 设置填写;LM Studio 本地免 Key)')
  }
  const allowAll = !Array.isArray(params.tools) || params.tools.length === 0
  const allowed = new Set((Array.isArray(params.tools) ? params.tools : []).map(String))

  // 子代理独立确认门
  const gate = createTurnConfirmGate(config)
  const subConfirm = gate.check

  const system = [
    config.systemPrompt,
    String(params.system ?? '').trim() ||
      '你是子代理,专注完成委派的子任务,只返回任务结果文本,不要多余解释。',
  ]
    .filter(Boolean)
    .join('\n')
  const historyIn: AgentMessage[] = [
    { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: task }] },
  ]
  const msgParts: AgentPart[] = []
  let reasoningText = ''
  let pushedParts = 0
  let truncateHinted = false

  for (let step = 1; step <= MAX_STEPS; step++) {
    if (signal?.aborted) break
    // 每步获取最新工具列表(支持动态新增)
    const allTools = await getAllTools()
    const subTools = allTools.filter(
      (t) => !new Set(getConfig().excludedTools ?? []).has(t.name) && (allowAll || allowed.has(t.name)),
    )
    const subMap = new Map(subTools.map((t) => [t.name, t]))

    const result = await stream({
      config,
      system,
      history: historyIn,
      tools: subTools,
      signal: AbortSignal.any([AbortSignal.timeout(SUBAGENT_STEP_TIMEOUT_MS), ...(signal ? [signal] : [])]),
      maxOutputTokens: getOutputBudget(),
      onEvent: (event) => {
        if (event.type === 'reasoning-delta') reasoningText += event.text
      },
    })
    if (result.aborted || signal?.aborted) break
    if (reasoningText) {
      msgParts.push({ type: 'reasoning', text: reasoningText })
      reasoningText = ''
    }
    const text = result.text
    if (text) msgParts.push({ type: 'text', text })
    if (result.calls.length === 0 && !result.truncated) break
    const batch = result.calls.map((c) => ({ id: c.id, name: c.name, args: parseToolArgs(c.args) }))
    const results = await executeToolBatch(batch, subMap, subTools, subConfirm, signal, hooks)
    for (let i = 0; i < batch.length; i++) {
      const r = results[i]
      msgParts.push({ type: 'tool-call', id: r.id, name: r.name, args: batch[i].args })
      msgParts.push({
        type: 'tool-result',
        id: r.id,
        name: r.name,
        ok: r.ok,
        result: r.out,
        durationMs: r.durationMs,
      })
    }
    historyIn.push({ id: randomUUID(), role: 'assistant', parts: msgParts.slice(pushedParts) })
    pushedParts = msgParts.length
    if (result.truncated && !truncateHinted) {
      truncateHinted = true
      historyIn.push({ id: randomUUID(), role: 'system', parts: [{ type: 'text', text: BUDGET_TRUNCATE_HINT }] })
    }
  }
  const reply = msgParts
    .filter((p): p is Extract<AgentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
  return reply || '(子代理未返回文本结果)'
}

/**
 * 创建 delegate 子代理工具
 */
export function createDelegateTool(deps: {
  getConfig: () => AgentConfig
  getOutputBudget: () => number
  getAllTools: () => Promise<AgentTool[]>
  /** LLM 流式调用(由 ctx.llm 接缝注入,子代理与主循环共用同一接缝) */
  stream: (params: LlmStreamParams) => Promise<ProviderOutcome>
  /** 工具执行链钩子(tools/pre-execute + post-execute 瀑布;子代理同享扩展点) */
  hooks?: ToolExecHooks
}): AgentTool {
  return {
    name: 'delegate',
    description:
      '委派子任务给子 Agent 并行处理。适合把大任务拆成多个独立子任务:一次调用多个 delegate 即可并行执行,' +
      '每个子 Agent 有独立上下文,可用工具执行并返回结果文本。注意:子任务之间应尽量独立,避免互相等待。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '子任务描述:要完成什么、期望的输出' },
        system: { type: 'string', description: '可选:子 Agent 专用系统提示(角色/约束/输出格式)' },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description: '可选:允许子 Agent 使用的工具名列表,缺省全部',
        },
      },
      required: ['task'],
    },
    async execute(params: ToolParams, ctx?: { signal?: AbortSignal }) {
      return runSubAgent(
        params,
        deps.getConfig,
        deps.getOutputBudget,
        deps.getAllTools,
        deps.stream,
        ctx?.signal,
        deps.hooks,
      )
    },
  }
}

// 导出常量供测试用
export { MAX_STEPS, TOOL_TIMEOUT_MS }
