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
  getLog(): Promise<EvolutionLogEntry[]>
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
  /** 本轮是否应用了清理类改动(delete/merge 整合,2026-08-11) */
  cleanupApplied?: boolean
  error?: string
}

/** 改进建议(op: add/delete/update;delete/update 需要 id 或内容片段) */
interface EvolutionChange {
  op: 'add' | 'delete' | 'update'
  id?: string
  content?: string
  type?: MemoryEntry['type']
  /** 合并标记(2026-08-11 垂直细分整合):update 且 merge=true = 该主题
   * 的整合条目(内容 = 多条相似记忆的要点汇总)——与 delete 同例豁免
   * hypothesis(确定性整合),并计入"清理类"轮次(棘轮容差) */
  merge?: boolean
  /** 假说:预测改进后哪些可观察行为会变化(无假说的建议不采纳;
   * delete 与 merge 整合豁免) */
  hypothesis?: string
}

/** 清理类建议判定(2026-08-11,测试用导出):delete 或 merge 整合 = 确定性
 * 清理(内容只减/重写不增,LLM 常不写假说);add 与普通 update 需要
 * hypothesis 且不属清理类 */
export function isCleanupChange(ch: EvolutionChange): boolean {
  return ch.op === 'delete' || ch.merge === true
}

/** 应用一个候选的改进建议(单轮);返回应用的 change 数。
 * **2026-08-10 修复(用户实测"评审发现条目1、2、3高度重复却没合并")**:
 * ① delete(删除冗余/过时条目)不再强制 hypothesis——它是确定性的清理
 *   操作,LLM 常不为其写假说(日志实测"建议删除第2、3条"无假说被整体
 *   忽略);add/update 保持强制(防无效建议);
 * ② delete/update 的序号 → 真实条目映射(mapSeqToEntry)——原实现把
 *   序号当 key 传 store.remove,按内容 includes 匹配删不中;
 * ③ 多条建议顺序应用时列表会变化(删除后条目前移),每次操作前重读
 *   最新列表再映射(原 listNow 快照索引过期);
 * **2026-08-11 垂直细分整合**:merge:true 的 update(整合条目)与 delete
 *   同例豁免 hypothesis(确定性整合,见 isCleanupChange)——原实现把
 *   合并 update 当普通 update 强制假说,LLM 忘写假说时整个整合被跳过,
 *   残留的重复条目永远清理不掉(用户实测)。导出供测试(store 参数化,
 *   与 createEvolution 闭包版行为一致) */
export async function applyChanges(
  changes: EvolutionChange[],
  store: MemoryStoreLike | null,
): Promise<number> {
  if (!store) return 0
  // **评审的序号针对评审输入时的列表(初始快照)**——一次映射全部目标,
  // 之后按 UUID 应用(顺序无关)。逐条重读再映射在**多条删除**时会错位:
  // 删除 #2 后原 #3 前移到 #2,重读映射 '3' 越界落空(实测"应应用 3 条
  // 实际 2"、残留重复);update 改变 updatedAt 重排后同样错位
  const original = await store.list()
  let changeCount = 0
  for (const ch of changes) {
    // 假说驱动:add/普通 update 必须带假说(预测行为变化);
    // delete 与 merge 整合例外(确定性清理,见上)
    if (!isCleanupChange(ch) && !ch.hypothesis?.trim()) continue
    try {
      if (ch.op === 'add' && ch.content?.trim()) {
        await store.add({ content: ch.content, type: ch.type ?? 'fact', source: 'evolution' })
        changeCount++
      } else if (ch.op === 'delete' || (ch.op === 'update' && ch.id)) {
        const target = mapSeqToEntry(original, ch.id)
        if (ch.op === 'delete') {
          if (target) {
            changeCount += await store.remove(target.id)
          } else if (ch.content?.trim()) {
            // 兼容直接传内容片段(旧语义,评审偶发输出内容而非序号)
            changeCount += await store.remove(ch.content)
          }
        } else if (target && ch.content?.trim()) {
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

/**
 * 序号 → 当前列表条目映射(测试用导出):评审输出的 delete/update 的
 * id 是 1 基序号(原条目在评审输入里的顺序)。**2026-08-10 修复
 * "发现重复却没合并"**:原 delete 分支把序号当 key 直接传
 * store.remove——store 按真实 UUID 或内容片段匹配,序号永远命中
 * 不了 UUID(内容 includes 数字又可能误删)——建议落空、记忆原样、
 * 复评同分、棘轮拒绝。序号合法且界内返回条目,否则 null
 */
export function mapSeqToEntry(fresh: MemoryEntry[], id: string | undefined): MemoryEntry | null {
  const idx = Number(id)
  return Number.isInteger(idx) && idx >= 1 && idx <= fresh.length ? fresh[idx - 1] : null
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
      /**
       * @param jsonMode 请求 json 模式(评审/复评默认 true);**解析失败
       * 降级重试时传 false**(2026-08-11 实测:jsonMode 下评审/复评偶发
       * 返回空/垃圾,parse 失败 → before=0 → 空轮次被棘轮接受,版本
       * 空转、记忆原样——与总结标题的 json_mode 三级降级链同策略)
       */
      async evaluate(system: string, input: string, phase: string, opts?: { jsonMode?: boolean }): Promise<string> {
        onEvent({ type: 'evolution-progress', phase })
        const config = getConfig()
        if (!config.apiKey.trim()) throw new Error('尚未配置 API Key,无法评估')
        const jsonMode = opts?.jsonMode !== false
        for (let retry = 0; retry < 2; retry++) {
          try {
            const result = await streamByConfig({
              // **noThinking + 低强度(2026-08-11 实测修复:评审/复评空白
              // content 的根因——原用 config 默认 effort=high,复杂评审
              // 任务把输出 token 全烧在思维链上,最终文本恒为空(两次
              // 实测 review raw:""),与总结标题同款场景(该处早已
              // noThinking 修复);noThinking 后模型直接产出 JSON,历史
              // 可靠(judge/风格分析同款)**
              config: { ...config, reasoningEffort: 'low' },
              system,
              history: [{ id: 'eval', role: 'user', parts: [{ type: 'text', text: input }] }],
              tools: [],
              signal: AbortSignal.timeout(EVAL_TIMEOUT_MS),
              onEvent: () => {},
              jsonMode,
              noThinking: true,
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
      '评分维度(每项 0-10):冗余度(**同一主题最多一条**)、一致性(无自相矛盾)、时效性(无明显过时)、' +
      '可操作性(每条具体、不空泛)、价值性(值得长期保留)。总分 0-100。' +
      '输出格式:{"total": 总分, "issues": ["问题1"], "changes": [{"op": "add"|"delete"|"update", ' +
      '"id": "原条目序号(delete/update 必填)", "content": "内容", "type": "preference|fact|workflow|lesson", ' +
      '"merge": true|false, "hypothesis": "预测的改进效果"}]}。' +
      '**垂直细分整合(最重要,优先于其它 change)**:把内容相似/重复的条目按主题归组——同一主题' +
      '(如"回答风格"、"B站视频下载"、"夜间习惯"、"TTG/小胖偏好"、"工具使用"等)的多条记忆' +
      '必须整合为**一条**垂直细分条目:选该主题内容最完整的一条,输出 ' +
      '{"op": "update", "id": 该条序号, "content": 整合全部要点后的精炼内容(保留各条的全部信息点,不丢失任何信息), "merge": true},' +
      '该主题其余条目逐条输出 {"op": "delete", "id": 序号}。**合并后逐条核对:同一主题必须只剩一条,' +
      '不允许残留任何重复**;不同主题不要互相合并(垂直细分,不是大杂烩)。' +
      '合并的 update(带 "merge": true)与 delete 都是显然的清理,不需要 hypothesis。' +
      '其他规则:措辞可优化但内容有价值的 update(必须带 hypothesis);缺失的重要维度 add(必须带 hypothesis)。' +
      '每条非 delete、非 merge 的 change 必须带 hypothesis(预测改进后 Agent 行为/回答质量的具体变化)——' +
      '只加分析步骤、不预测行为变化的建议是无效改进,不要给出。只输出 JSON,不要解释。'
    )
  }

  /** 复评系统提示(独立打分,黑盒) */
  function reevalSystemPrompt(): string {
    return (
      '你是记忆系统评审器。对给定记忆集打分,输出 JSON(必须含 "json" 字样):{"total": 总分0-100}。' +
      '评分维度:冗余度/一致性/时效性/可操作性/价值性。只输出 JSON。'
    )
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
    const reviewInput = `【系统提示词】${config.systemPrompt.slice(0, 500)}\n\n【当前记忆】\n${memoryDump(entries)}${focusLine}`
    const reviewText = await evaluator.evaluate(
      reviewSystemPrompt(),
      reviewInput,
      `第 ${roundNo}/${rounds} 轮:评估子代理评审`,
    )
    let review = parseJsonLoose(reviewText)
    // **评审 JSON 解析失败降级(2026-08-11 实测:jsonMode 下评审返回
    // 空/垃圾 → parse 失败 → before=0 → 空轮次被棘轮接受,版本空转、
    // 记忆原样("什么时候能真正整合有效信息"的根因))**:去掉 jsonMode
    // 纯文本重试一次(措辞已含"只输出 JSON"),仍解析不出 total 即视为
    // LLM 失败上抛(中止本轮会话,不再产生垃圾轮次)
    if (!review || typeof review.total !== 'number') {
      onEvent({ type: 'evolution-progress', phase: `第 ${roundNo}/${rounds} 轮:评审 JSON 解析失败,降级重试` })
      const retryText = await evaluator.evaluate(
        reviewSystemPrompt(),
        reviewInput,
        `第 ${roundNo}/${rounds} 轮:评估子代理评审(纯文本重试)`,
        { jsonMode: false },
      )
      review = parseJsonLoose(retryText)
    }
    if (!review || typeof review.total !== 'number') throw new Error('评审输出无法解析(两次尝试均非合法 JSON)')
    const before = clampScore(review.total)
    const issues = Array.isArray(review.issues) ? review.issues.map(String) : []
    const changes = Array.isArray(review.changes)
      ? review.changes.filter((c): c is EvolutionChange => !!c && typeof c === 'object')
      : []

    // 2. 候选:应用建议前确保 Reference 快照存在(拒绝时恢复点;
    //    同版本不重复打包——第一轮创建,后续轮复用)
    const refVersion = state.version
    await ensureSnapshot(refVersion)
    const changeCount = await applyChanges(changes, getStore())
    const hasRealChange = changeCount > 0
    // 清理类轮次(2026-08-11 二轮):本轮含 delete/merge 整合建议
    // (评审的确定性清理——内容只减/整合,评审自己设计的改动)
    const cleanupApplied = hasRealChange && changes.some(isCleanupChange)

    // 3. 复评(独立黑盒打分)——**仅对纯增改轮次(无 delete/merge 清理)
    //    生效(2026-08-11 实测:复评与评审分数不同量级、噪声大——评审
    //    92、复评 62,否决掉评审确认的垂直细分整合 = "很多冗余记忆但
    //    没整合"的最后一环;清理是评审的确定性判断,直接接受;
    //    纯增改轮次保留复评棘轮防无效改动)**
    let after = before
    if (!cleanupApplied && hasRealChange) {
      const afterEntries = await store.list()
      const reevalText = await evaluator.evaluate(
        reevalSystemPrompt(),
        `【改进后记忆】\n${memoryDump(afterEntries)}`,
        `第 ${roundNo}/${rounds} 轮:评估子代理复评`,
      )
      let reeval = parseJsonLoose(reevalText)
      if (!reeval || typeof reeval.total !== 'number') {
        // 与评审同款降级(见上)
        const retryText = await evaluator.evaluate(
          reevalSystemPrompt(),
          `【改进后记忆】\n${memoryDump(afterEntries)}`,
          `第 ${roundNo}/${rounds} 轮:评估子代理复评(纯文本重试)`,
          { jsonMode: false },
        )
        reeval = parseJsonLoose(retryText)
      }
      if (!reeval || typeof reeval.total !== 'number') throw new Error('复评输出无法解析(两次尝试均非合法 JSON)')
      after = clampScore(reeval.total)
    }

    // 4. 棘轮:严格更高分才接受(版本+1 存档);否则从 Reference 快照恢复。
    // **清理类轮次 = 评审权威直接接受(2026-08-11 二轮)**:复评噪声
    // 否决把评审确认的整合整体回滚(实测 92→62 拒绝,记忆原样)——评审
    // 就是设计这些改动的裁判,清理(delete/merge)直接落地;纯增改轮次
    // 保留 after > before 棘轮。
    // **空轮次永不接受(2026-08-11 实测修复:评审解析失败 before=0 +
    // 零改动被 after>before 接受 → 版本空转 v2→v5、记忆原样)**——
    // 无实际改动的轮次不产生版本(评审"无有效改进"时正常结束会话)
    const applied = hasRealChange && (cleanupApplied || after > before)
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
      (hasRealChange
        ? cleanupApplied
          ? `;整合/清理 ${changeCount} 条重复(评审确认直接接受)`
          : `;应用 ${changeCount} 条假说改进`
        : ';无有效改进(无假说的建议已忽略)')
    lastResult = { at: Date.now(), version: state.version, applied, before, after, summary }
    logs = [{ at: Date.now(), version: state.version, before, after, applied, summary, changes: changeCount }, ...logs]
    await saveLog()
    return { ok: true, applied, before, after, version: state.version, summary, cleanupApplied }
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
      // 继续评审只会重复同一结论;拒绝的候选结果作 evidence 记录在日志)。
      // **本轮有清理类改动(整合/删除重复)时不提前停(2026-08-11)**:整合
      // 后的残留重复需要下一轮再清——实测 95 分达标停了,TTG/夜猫子
      // 重复还残留着;轮数预算内继续给清理空间
      if (result.after >= TARGET_SCORE && !result.cleanupApplied) break
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
