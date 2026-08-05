/**
 * 自我进化 harness —— 记忆系统的版本化自主优化循环
 *
 * 按 penguin-harness(packages/skills/skills/agent-optimization 技能 +
 * server snapshot-service)的机制重构:
 *
 * 1. **版本化快照**:每个**接受**的版本存档 memory-snapshots/v<N>.json
 *    (同版本不重复打包);memory-state.json 持久化当前版本号与评分;
 *    回滚只能恢复到已接受版本(防降级,拒绝的候选不会产生版本);
 * 2. **Reference 语义**:当前已接受版本 = Reference;每轮从 Reference
 *    出发构造一个**候选**,接受后成为新 Reference;
 * 3. **假说驱动**:评审的每条改进建议必须带 hypothesis(预测的可观察
 *    行为变化)——只加分析不预测行为的建议不算有效改进;
 * 4. **多轮循环**:每轮 评审(评分+问题+假说建议) → 快照 Reference →
 *    应用候选 → 复评 → 棘轮接受(严格更高分,版本+1 存档)/ 拒绝
 *    (从快照恢复,结果作下一轮 evidence);轮数预算 rounds(工具参数,
 *    默认 2 上限 4),评分 ≥92 或提升 <2 分提前停;LLM 调用失败不消耗轮数;
 * 5. **独立评估**:评审/复评是独立无工具调用(只给公开记忆内容,
 *    黑盒打分,防自评偏差);
 * 6. **CONTRACT**:进化只改记忆(可编辑资产),不触碰引擎/工具代码。
 *
 * 后台任务语义(借鉴 bili 后台下载):工具/按钮触发后立即返回"进化已开始",
 * 完成后发系统通知 + 状态注入系统提示。事件 evolution-progress/done
 * 渲染端忽略(状态机不受影响)。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { Notification } from 'electron'
import { streamByConfig } from './provider'
import type { AgentConfig, AgentEvent, MemoryEntry, MemoryStoreLike } from './types'

/** 评估 Sub Agent 单次调用超时(评审/复评各一次,后台任务无整体时限) */
const EVAL_TIMEOUT_MS = 60_000
/** 日志保留条数 */
const LOG_MAX = 20
/** 每轮候选上限(轮数预算;LLM 失败不消耗) */
const MAX_ROUNDS = 4
/** 评分达标线:达到即提前停 */
const TARGET_SCORE = 92

export interface EvolutionHandle {
  /** 触发一次进化(已在进化中则忽略,返回说明);立即返回,后台执行 */
  requestEvolve(focus?: string, rounds?: number): Promise<{ started: boolean; message: string }>
  /** 系统提示状态注入块(进行中/最近结果;无历史返回空串) */
  getStatus(): Promise<string>
  /** 进化日志(设置界面展示) */
  getLog(): EvolutionLogEntry[]
  /** 回滚到最近一个已接受版本(防降级:拒绝的候选不产生版本) */
  rollback(): Promise<string>
  /** 清除全部版本与日志,回到初始状态(v1 无快照)——设置界面"清除所有版本" */
  resetAll(): Promise<string>
}

export interface EvolutionLogEntry {
  at: number
  /** 本候选的版本号(拒绝 = Reference 版本,接受 = 新版本) */
  version: number
  before: number
  after: number
  applied: boolean
  summary: string
  changes: number
}

interface EvolutionResult {
  ok: boolean
  applied: boolean
  before: number
  after: number
  version: number
  summary: string
  error?: string
}

/** 改进建议(op: add/delete/update;delete/update 需要 id 或内容片段) */
interface EvolutionChange {
  op: 'add' | 'delete' | 'update'
  id?: string
  content?: string
  type?: MemoryEntry['type']
  /** 假说:预测改进后哪些可观察行为会变化(无假说的建议不采纳) */
  hypothesis?: string
}

/** 评审响应(JSON):分数 + 问题 + 建议 */
interface ReviewResult {
  total: number
  issues: string[]
  changes: EvolutionChange[]
}

/** JSON 解析(容忍 markdown 代码块包裹/前导说明文本) */
function parseJsonLoose(raw: string): Record<string, unknown> | null {
  const text = raw.trim()
  if (!text) return null
  const candidates = [text, text.replace(/^```(?:json)?\s*|\s*```$/g, ''), text.slice(text.indexOf('{'))]
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c)
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
    } catch {
      // 尝试下一个候选
    }
  }
  return null
}

function clampScore(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 0
}

export function createEvolution(deps: {
  getConfig(): AgentConfig
  getStore(): MemoryStoreLike | null
  /** 记忆文件与日志目录(userData) */
  getMemoryDir(): string
  onEvent(event: AgentEvent): void
}): EvolutionHandle {
  const { getConfig, getStore, getMemoryDir, onEvent } = deps
  // 评估 Sub Agent(独立实例):评审与复评委托给它,优化流程自身不评分
  const evaluator = createEvaluatorAgent()
  let busy = false
  let lastResult: { at: number; version: number; applied: boolean; before: number; after: number; summary: string } | null = null
  let logs: EvolutionLogEntry[] = []
  /** 当前 Reference 版本号与评分(持久化 memory-state.json) */
  let state = { version: 1, score: 0 as number | null, updatedAt: 0 }

  const statePath = () => path.join(getMemoryDir(), 'memory-state.json')
  const snapshotsDir = () => path.join(getMemoryDir(), 'memory-snapshots')
  const logPath = () => path.join(getMemoryDir(), 'evolution.json')

  /**
   * 日志与版本状态异步加载,首次调用前等待完成(创建即启动)。
   * 竞态:设置界面打开后立刻点回滚,若 loadState 未完成会读到初始
   * version=1 → "无可回滚"(实测);各方法入口先 await 本 promise
   */
  const initPromise = Promise.all([loadLog(), loadState()])

  async function loadLog() {
    try {
      const raw = await fs.readFile(logPath(), 'utf8')
      const data = JSON.parse(raw) as { logs?: unknown }
      if (Array.isArray(data.logs)) logs = data.logs as EvolutionLogEntry[]
    } catch {
      logs = []
    }
  }

  async function saveLog() {
    try {
      await fs.writeFile(logPath(), JSON.stringify({ logs: logs.slice(0, LOG_MAX) }, null, 2), 'utf8')
    } catch {
      // 日志写失败不影响主流程
    }
  }

  async function loadState() {
    try {
      const raw = await fs.readFile(statePath(), 'utf8')
      const data = JSON.parse(raw) as { version?: unknown; score?: unknown; updatedAt?: unknown }
      state = {
        version: Number.isInteger(data.version) && Number(data.version) >= 1 ? Number(data.version) : 1,
        score: typeof data.score === 'number' ? data.score : null,
        updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : 0,
      }
    } catch {
      state = { version: 1, score: null, updatedAt: 0 }
    }
  }

  async function saveState() {
    try {
      await fs.writeFile(statePath(), JSON.stringify(state, null, 2), 'utf8')
    } catch {
      // 状态写失败不影响主流程
    }
  }

  /** Reference 快照:当前版本若未存档则写入(同版本不重复打包,
   * 借鉴 penguin snapshot-service 语义)。返回快照版本 */
  async function ensureSnapshot(version: number): Promise<string> {
    const store = getStore()
    const file = path.join(snapshotsDir(), `v${version}.json`)
    try {
      await fs.access(file)
      return file // 已存在,不重复打包
    } catch {
      // 不存在:创建
    }
    await fs.mkdir(snapshotsDir(), { recursive: true })
    const entries = store ? await store.list() : []
    await fs.writeFile(file, JSON.stringify({ version, entries }, null, 2), 'utf8')
    return file
  }

  /** 记忆清单文本(评审/复评的输入) */
  function memoryDump(entries: MemoryEntry[]): string {
    if (entries.length === 0) return '(暂无记忆)'
    const typeLabel: Record<string, string> = { preference: '偏好', fact: '事实', workflow: '工作流', lesson: '教训' }
    return entries
      .map((e, i) => `${i + 1}. [${typeLabel[e.type] ?? e.type}] ${e.content}`)
      .join('\n')
  }

  /**
   * 评估 Sub Agent(独立实例)——评审与复评都委托给它。
   * 借鉴 penguin-harness 的语义:"评估必须委托 agent-evaluation 子代理,
   * 优化器自己不评分"——评估者与改进者分离,防自评偏差。
   * 每次评估独立 AbortController/60s 超时;调用失败(超时/网络)自动
   * 重试一次,仍失败上抛(由进化流程终止并通知);事件静默,仅经
   * onEvent 发 evolution-progress 阶段提示(渲染端忽略)。
   */
  function createEvaluatorAgent() {
    return {
      async evaluate(system: string, input: string, phase: string): Promise<string> {
        onEvent({ type: 'evolution-progress', phase })
        const config = getConfig()
        if (!config.apiKey.trim()) throw new Error('尚未配置 API Key,无法评估')
        for (let retry = 0; retry < 2; retry++) {
          try {
            const result = await streamByConfig({
              config,
              system,
              history: [{ id: 'eval', role: 'user', parts: [{ type: 'text', text: input }] }],
              tools: [],
              signal: AbortSignal.timeout(EVAL_TIMEOUT_MS),
              onEvent: () => {},
              jsonMode: true,
            })
            if (result.aborted) throw new Error('评估被中止')
            return result.text
          } catch (err) {
            if (retry === 0) {
              onEvent({ type: 'evolution-progress', phase: `${phase}(网络重试)` })
              continue
            }
            throw err
          }
        }
        throw new Error('评估失败')
      },
    }
  }

  /** 评审系统提示(评分 rubric + 假说驱动的改进建议) */
  function reviewSystemPrompt(): string {
    return (
      '你是记忆系统评审器。对给定记忆集(用户偏好/事实/工作流/教训)做质量评估,输出 JSON(必须含 "json" 字样)。' +
      '评分维度(每项 0-10):冗余度(无重复内容)、一致性(无自相矛盾)、时效性(无明显过时)、' +
      '可操作性(每条具体、不空泛)、价值性(值得长期保留)。总分 0-100。' +
      '输出格式:{"total": 总分, "issues": ["问题1"], "changes": [{"op": "add"|"delete"|"update", ' +
      '"id": "原条目序号(delete/update 必填)", "content": "内容", "type": "preference|fact|workflow|lesson", ' +
      '"hypothesis": "预测的改进效果"}]}。' +
      'change 规则:明显冗余/过时/错误的条目 delete;措辞可优化但内容有价值的 update;缺失的重要维度 add。' +
      '**每条 change 必须带 hypothesis(预测改进后 Agent 行为/回答质量的具体变化)**——只加分析步骤、' +
      '不预测行为变化的建议是无效改进,不要给出。只输出 JSON,不要解释。'
    )
  }

  /** 复评系统提示(独立打分,黑盒) */
  function reevalSystemPrompt(): string {
    return (
      '你是记忆系统评审器。对给定记忆集打分,输出 JSON(必须含 "json" 字样):{"total": 总分0-100}。' +
      '评分维度:冗余度/一致性/时效性/可操作性/价值性。只输出 JSON。'
    )
  }

  /** 应用一个候选的改进建议(单轮);返回应用的 change 数 */
  async function applyChanges(changes: EvolutionChange[]): Promise<number> {
    const store = getStore()
    if (!store) return 0
    let changeCount = 0
    const listNow = await store.list()
    for (const ch of changes) {
      // 假说驱动:无假说的建议不采纳(只加分析不预测行为的无效改进)
      if (!ch.hypothesis?.trim()) continue
      try {
        if (ch.op === 'add' && ch.content?.trim()) {
          await store.add({ content: ch.content, type: ch.type ?? 'fact', source: 'evolution' })
          changeCount++
        } else if (ch.op === 'delete') {
          changeCount += await store.remove(ch.id ?? ch.content ?? '')
        } else if (ch.op === 'update' && ch.id) {
          // id 是评审输出里的序号(1 基),映射到当前列表
          const idx = Number(ch.id)
          const target = listNow[idx - 1]
          if (target && ch.content?.trim()) {
            await store.update(target.id, { content: ch.content, type: ch.type })
            changeCount++
          }
        }
      } catch {
        // 单条建议失败不影响其余
      }
    }
    return changeCount
  }

  /** 从指定版本快照恢复(拒绝候选 / 手动回滚共用);返回恢复条数 */
  async function restoreFromSnapshot(version: number): Promise<number> {
    const store = getStore()
    if (!store) return 0
    try {
      const raw = await fs.readFile(path.join(snapshotsDir(), `v${version}.json`), 'utf8')
      const data = JSON.parse(raw) as { entries?: MemoryEntry[] }
      const entries = Array.isArray(data.entries) ? data.entries : []
      await store.replaceAll(entries)
      return entries.length
    } catch {
      return -1 // 快照缺失/损坏
    }
  }

  /** 单轮进化:评审 → 候选 → 复评 → 棘轮接受/拒绝 */
  async function runRound(focus: string | undefined, roundNo: number, rounds: number): Promise<EvolutionResult> {
    const store = getStore()
    if (!store) throw new Error('记忆系统未启用')
    const entries = await store.list()
    const config = getConfig()
    const focusLine = focus?.trim() ? `\n本次关注点:${focus.trim()}` : ''

    // 1. 评审(评分 + 问题 + 假说建议)——委托独立评估 Sub Agent
    const reviewText = await evaluator.evaluate(
      reviewSystemPrompt(),
      `【系统提示词】${config.systemPrompt.slice(0, 500)}\n\n【当前记忆】\n${memoryDump(entries)}${focusLine}`,
      `第 ${roundNo}/${rounds} 轮:评估子代理评审`,
    )
    const review = parseJsonLoose(reviewText)
    const before = clampScore(review?.total)
    const issues = Array.isArray(review?.issues) ? review.issues.map(String) : []
    const changes = Array.isArray(review?.changes)
      ? review.changes.filter((c): c is EvolutionChange => !!c && typeof c === 'object')
      : []

    // 2. 候选:应用建议前确保 Reference 快照存在(拒绝时恢复点;
    //    同版本不重复打包——第一轮创建,后续轮复用)
    const refVersion = state.version
    await ensureSnapshot(refVersion)
    const changeCount = await applyChanges(changes)
    const hasRealChange = changeCount > 0

    // 3. 复评(独立黑盒打分)——同样委托独立评估 Sub Agent
    const afterEntries = await store.list()
    const reevalText = await evaluator.evaluate(
      reevalSystemPrompt(),
      `【改进后记忆】\n${memoryDump(afterEntries)}`,
      `第 ${roundNo}/${rounds} 轮:评估子代理复评`,
    )
    const after = clampScore(parseJsonLoose(reevalText)?.total)

    // 4. 棘轮:严格更高分才接受(版本+1 存档);否则从 Reference 快照恢复
    const applied = after > before
    if (applied) {
      state.version += 1
      state.score = after
      state.updatedAt = Date.now()
      await ensureSnapshot(state.version) // 新版本存档(接受后立即持久化)
      await saveState()
    } else {
      await restoreFromSnapshot(refVersion)
    }
    const summary =
      `v${refVersion}→v${applied ? state.version : refVersion} 评分 ${before} → ${after}` +
      (issues.length > 0 ? `;问题:${issues[0].slice(0, 50)}` : '') +
      (hasRealChange ? `;应用 ${changeCount} 条假说改进` : ';无有效改进(无假说的建议已忽略)')
    lastResult = { at: Date.now(), version: state.version, applied, before, after, summary }
    logs = [{ at: Date.now(), version: state.version, before, after, applied, summary, changes: changeCount }, ...logs]
    await saveLog()
    return { ok: true, applied, before, after, version: state.version, summary }
  }

  /** 完整进化会话:多轮候选循环,直到轮数预算/达标/拒绝后停止 */
  async function runEvolution(focus?: string, rounds = 2): Promise<EvolutionResult[]> {
    const results: EvolutionResult[] = []
    const roundBudget = Math.min(Math.max(Math.round(rounds) || 2, 1), MAX_ROUNDS)
    for (let round = 1; round <= roundBudget; round++) {
      let result: EvolutionResult
      try {
        result = await runRound(focus, round, roundBudget)
      } catch (err) {
        // LLM 调用失败(超时/网络/未配置 Key):终止会话并**上抛**,
        // 由 requestEvolve 的 catch 发"进化失败"通知(不静默;
        // 无 Key 时用户需要知道为什么没进化)
        onEvent({ type: 'evolution-progress', phase: `进化中止:${(err as Error).message}` })
        throw err
      }
      results.push(result)
      // 提前停:达标(评分 ≥ TARGET)或本候选被拒(记忆集已是最优,
      // 继续评审只会重复同一结论;拒绝的候选结果作 evidence 记录在日志)
      if (result.after >= TARGET_SCORE) break
      if (!result.applied) break
    }
    return results
  }

  return {
    async requestEvolve(focus?: string, rounds = 2) {
      await initPromise
      if (busy) return { started: false, message: '记忆进化已在运行中,请稍候' }
      busy = true
      onEvent({ type: 'evolution-progress', phase: '启动记忆进化' })
      void runEvolution(focus, rounds)
        .then((results) => {
          if (results.length === 0) return
          const last = results[results.length - 1]
          const n = results.filter((r) => r.applied).length
          const title = n > 0 ? '记忆进化完成' : '记忆进化:未应用'
          const body =
            `${n} 轮应用,最近一轮 ${last.summary}` +
            (n === 0 ? '(评分未严格提高,已回滚,无改动)' : '。可在 Agent 设置 → 自我进化 里查看或回滚')
          new Notification({ title, body }).show()
        })
        .catch((err: Error) => {
          new Notification({ title: '记忆进化失败', body: err.message.slice(0, 120) }).show()
        })
        .finally(() => {
          busy = false
          onEvent({ type: 'evolution-done' })
        })
      return { started: true, message: `记忆进化已开始(共 ${Math.min(Math.max(Math.round(rounds) || 2, 1), MAX_ROUNDS)} 轮,后台执行,完成后有系统通知)` }
    },
    async getStatus() {
      await initPromise
      if (busy) return '【记忆进化】进行中,完成后会通知。'
      if (lastResult) {
        return `【记忆进化】最近一轮:${lastResult.summary}。` +
          '对话中提及进化结果时按此如实回答。'
      }
      return ''
    },
    async getLog() {
      await initPromise
      return logs
    },
    async rollback() {
      await initPromise
      // 防降级语义:只回滚到最近一个**已接受**版本(拒绝的候选从未产生
      // 版本);当前就是最初版本(v1 快照缺失)则无可回滚
      const store = getStore()
      if (!store) return '记忆系统未启用'
      const target = state.version - 1
      if (target < 1) return '无可回滚的已接受版本(当前就是初始版本)'
      const n = await restoreFromSnapshot(target)
      if (n < 0) return `回滚失败:快照 v${target} 不存在或已损坏`
      state.version = target
      state.score = null
      state.updatedAt = Date.now()
      await saveState()
      logs = [
        { at: Date.now(), version: target, before: 0, after: 0, applied: false, summary: `手动回滚到已接受版本 v${target}`, changes: 0 },
        ...logs,
      ]
      await saveLog()
      return `已回滚到 v${target}(${n} 条记忆)`
    },
    async resetAll() {
      await initPromise
      // 清除全部版本快照/状态/日志,回到初始状态(v1 无快照);
      // 记忆条目本身保留(进化历史清空,记忆资产不清)
      try {
        await fs.rm(snapshotsDir(), { recursive: true, force: true })
      } catch {
        // 快照目录不存在
      }
      try {
        await fs.rm(logPath(), { force: true })
      } catch {
        // 日志文件不存在
      }
      try {
        await fs.rm(statePath(), { force: true })
      } catch {
        // 状态文件不存在
      }
      state = { version: 1, score: null, updatedAt: 0 }
      logs = []
      lastResult = null
      await saveState()
      await saveLog()
      return '已清除全部版本,回到初始状态(v1)'
    },
  }
}
