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
 *    默认 2)按记忆规模自适应放大(约每 15 条一轮,上限 6,
 *    2026-08-14 可扩展性修复),评分 ≥92 或提升 <2 分提前停;
 *    LLM 调用失败不消耗轮数;评审输出 token 上限与超时同样按记忆
 *    规模放大(evalOutputBudget / evalTimeoutMs),防大记忆集截断崩溃;
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
import { isProtectedEntry } from './constants'
import {
  formatPersonaStyleBlock,
  isPersonaMergeCandidate,
  MAX_PERSONA_NOTES,
  sanitizePersonaStyle,
  splitNoteLines,
} from './persona'
import { showNotify } from './notify'
import { getDefaultLlmRuntime, type LlmStreamParams } from './plugin/llm'
import { createEvaluatorAgent } from './subagents/subagents'
import type {
  AgentConfig,
  AgentEvent,
  MemoryEntry,
  MemoryStoreLike,
  PersonaBufferSource,
  PersonaBufferStoreLike,
  PersonaCard,
  PersonaCardStoreLike,
  PersonaStyle,
  ProviderOutcome,
} from './types'

/** 评估 Sub Agent 单次调用基础超时(条目多时按 evalTimeoutMs 自适应放大) */
const EVAL_TIMEOUT_MS = 60_000
/** 评估超时上限(2026-08-14 可扩展性:条目再多也不超过 3 分钟) */
const EVAL_TIMEOUT_MAX_MS = 180_000
/** 日志保留条数 */
const LOG_MAX = 20
/** 每轮候选上限(轮数预算;LLM 失败不消耗)——2026-08-14 从 4 提到 6:
 * 大记忆集(40+ 条)每轮只清最严重的几个主题(见评审提示词"输出预算"),
 * 需要更多轮次收敛 */
const MAX_ROUNDS = 6
/** 评分达标线:达到即提前停 */
const TARGET_SCORE = 92

/**
 * 轮数预算按记忆规模自适应(2026-08-14 可扩展性修复,测试用导出):
 * 用户实测"条目超过 40 个进化基本就崩了"——根因之一是评审被要求一次
 * 整合全部主题,条目多时输出 JSON 超出模型输出上限被截断、解析失败、
 * 整个进化中止。修复后每轮只处理最严重的若干主题(评审提示词"输出
 * 预算"),轮数按条目数放大:约每 15 条一轮,下限 = 用户请求轮数,
 * 上限 MAX_ROUNDS。导出供测试(纯函数)。
 */
export function resolveRoundBudget(requested: number, entryCount: number): number {
  const base = Math.min(Math.max(Math.round(requested) || 2, 1), MAX_ROUNDS)
  const need = Math.ceil(Math.max(entryCount, 0) / 15)
  return Math.min(Math.max(base, need), MAX_ROUNDS)
}

/**
 * 评审输出 token 预算按输入规模自适应(2026-08-14,测试用导出):
 * 原实现不传 maxOutputTokens → DeepSeek/Anthropic 适配器缺省 4096 token;
 * 40+ 条目时评审 JSON(merge 整合必须保留全部信息点,体积 ≈ 记忆总量)
 * 远超 4096 → 输出截断成残缺 JSON → parseJsonLoose 失败 → 降级重试同样
 * 截断 → "评审输出无法解析"中止(用户实测"崩了"的直接根因)。
 * 预算 ≈ 输入字符数(中文 ≈ 1.5 字符/token + JSON 结构开销),
 * 下限 6144(小记忆集也比缺省 4096 宽裕)、上限 16384(防烧 token)。
 */
export function evalOutputBudget(inputChars: number): number {
  return Math.min(16384, Math.max(6144, Math.round(Math.max(inputChars, 0))))
}

/** 评估超时按条目数自适应(2026-08-14):基础 60s + 每条 2s,上限 180s。
 * 大记忆集的评审要生成长 JSON,固定 60s 超时把慢而正确的输出掐死 →
 * 重试再超时 → 中止 */
export function evalTimeoutMs(entryCount: number): number {
  return Math.min(EVAL_TIMEOUT_MAX_MS, EVAL_TIMEOUT_MS + Math.max(entryCount, 0) * 2000)
}

export interface EvolutionHandle {
  /** 触发一次进化(已在进化中则忽略,返回说明);立即返回,后台执行 */
  requestEvolve(focus?: string, rounds?: number): Promise<{ started: boolean; message: string }>
  /**
   * 快捷单轮进化(2026-09-22 用户要求"LLM 直接进行快捷自我进化,运行
   * 记忆进化"):同步跑恰好一轮,等待完成后返回人话摘要——LLM 当轮把
   * 进化结果讲给用户(后台 run 是 fire-and-forget + 通知,拿不到当轮结果)
   */
  runQuick(focus?: string): Promise<{ ok: boolean; message: string }>
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
  /** 本轮是否产生人格卡建议进缓冲区(2026-10-26;测试/日志用) */
  personaProposed?: boolean
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

/**
 * 人格卡整合建议(2026-10-25):把标【可整合·人设/风格】的零散记忆整理
 * 进当前激活人格卡的「进化整合区」。**人格卡提示词由主人手写,本流程
 * 绝不改写**;notes 只追加到整合区,sourceIds 只能取候选条目。
 */
export interface EvolutionPersonaMerge {
  /** 要追加到整合区的要点(多行文本;可选) */
  notes?: string
  /** 候选条目在评审输入中的 1 基序号 */
  sourceIds?: string[]
  /** 可选:完整改写后的人格提示词(手动合并才生效) */
  prompt?: string
  /** 可选:结构化风格提案(手动合并才生效) */
  style?: PersonaStyle
}

/** 人格卡整合建议(进入缓冲区前的预览结果) */
export interface PersonaProposal {
  /** 建议追加到整合区的要点(已去重、已补受保护原文) */
  notes: string
  /** 建议整合的源记忆快照 */
  sources: PersonaBufferSource[]
  /** 可选:人格卡提示词/风格提案(手动合并才生效) */
  cardPatch?: { prompt?: string; style?: PersonaStyle }
  skippedReason?: string
}

/** 文本归一化(受保护原文是否已写入 notes 的包含判定) */
function normText(s: unknown): string {
  return String(s ?? '').replace(/\s+/g, '').toLowerCase()
}

/**
 * 生成人格卡整合建议(不落盘、不删记忆,2026-10-26 改为缓冲区模式):
 * 1. 无激活卡 / 非候选 sourceId → skippedReason;
 * 2. 受保护的人设条目原文逐行写入建议(合并后防丢失);
 * 3. 与现有整合区重复 → duplicate-notes;容量不足 → notes-full;
 * 4. 返回源记忆快照,供缓冲区合并时删除、撤销时恢复。
 */
export function buildPersonaProposal(
  original: MemoryEntry[],
  card: PersonaCard,
  merge: EvolutionPersonaMerge,
): PersonaProposal {
  const targets: MemoryEntry[] = []
  const seen = new Set<string>()
  for (const seq of merge.sourceIds ?? []) {
    const e = mapSeqToEntry(original, String(seq))
    if (!e || seen.has(e.id) || !isPersonaMergeCandidate(e)) continue
    seen.add(e.id)
    targets.push(e)
  }
  const prompt = String(merge.prompt ?? '').trim().slice(0, 8000)
  const style = sanitizePersonaStyle(merge.style)
  const cardPatch =
    prompt || style
      ? { ...(prompt ? { prompt } : {}), ...(style ? { style } : {}) }
      : undefined
  if (targets.length === 0 && !cardPatch) return { notes: '', sources: [], skippedReason: 'no-candidates' }
  let block = String(merge.notes ?? '').trim()
  // 受保护人设条目:原文必须出现在建议里;评审漏写时由代码逐字补上
  let normBlock = normText(block)
  for (const e of targets) {
    if (!isProtectedEntry(e)) continue
    const n = normText(e.content)
    if (!n || normBlock.includes(n)) continue
    block += `\n- ${e.content}`
    normBlock += n
  }
  const existing = splitNoteLines(card.notes)
  const existingNorm = new Set(existing.map((l) => normText(l)))
  const freshLines = splitNoteLines(block).filter((l) => {
    const n = normText(l)
    return !!n && !existingNorm.has(n)
  })
  if (freshLines.length === 0 && !cardPatch) {
    return { notes: '', sources: [], skippedReason: 'duplicate-notes' }
  }
  if (freshLines.length > 0) {
    const projected = [...existing.map((l) => `- ${l}`), ...freshLines.map((l) => `- ${l}`)].join('\n')
    if (projected.length > MAX_PERSONA_NOTES) return { notes: '', sources: [], skippedReason: 'notes-full' }
  }
  return {
    notes: freshLines.join('\n'),
    sources: targets.map((e) => ({
      id: e.id,
      content: e.content,
      type: e.type,
      tags: e.tags,
      source: e.source,
      protected: e.protected,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    })),
    cardPatch,
  }
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
 *   与 createEvolution 闭包版行为一致);
 * **2026-08-13 受保护条目硬拦截(用户实测"进化总是丢失岛灵设定")**:
 *   主人指定的人设/岛灵设定(protected 标记或人设标签/内容,见
 *   constants.isProtectedEntry)对 delete/update/merge 全部免疫——
 *   评审提示词禁止触碰(见 reviewSystemPrompt)+ 本层代码硬跳过,
 *   双保险;清理类轮次免复评直接接受,评审误改人设会直接落盘,
 *   必须在此拦截(实测 v26→v28 把人设重写成"整体切换为鲸鱼娘模式")
 * **2026-10-26 人格卡缓冲区**:人格卡建议不再由本函数落盘;runRound
 *   通过 preserveIds 保护候选条目——建议合并前,普通 delete/update
 *   不允许删改这些候选项(防止"没沉淀进人格卡就被清理掉")。 */
export async function applyChanges(
  changes: EvolutionChange[],
  store: MemoryStoreLike | null,
  opts?: { preserveIds?: Set<string> },
): Promise<number> {
  if (!store) return 0
  // **评审的序号针对评审输入时的列表(初始快照)**——一次映射全部目标,
  // 之后按 UUID 应用(顺序无关)。逐条重读再映射在**多条删除**时会错位:
  // 删除 #2 后原 #3 前移到 #2,重读映射 '3' 越界落空(实测"应应用 3 条
  // 实际 2"、残留重复);update 改变 updatedAt 重排后同样错位
  const original = await store.list()
  const preserve = opts?.preserveIds ?? new Set<string>()
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
        // 受保护条目硬拦截(2026-08-13):delete/update/merge 的目标是
        // 人设/岛灵设定 → 直接跳过(LLM 无视提示词也不生效)
        if (target && isProtectedEntry(target)) continue
        // 人格卡候选保护(2026-10-26):已进入建议缓冲区的条目只允许经
        // 合并迁移,不允许被普通清理顺手删掉
        if (target && preserve.has(target.id)) continue
        if (ch.op === 'delete') {
          if (target) {
            changeCount += await store.remove(target.id)
          } else if (ch.content?.trim()) {
            // 兼容直接传内容片段(旧语义,评审偶发输出内容而非序号);
            // **锁定过滤(2026-08-13)**:原样调 store.remove(content) 会把
            // 包含该片段的受保护条目一起删掉——改为逐条按 id 删,
            // 受保护条目跳过
            const fragment = ch.content.trim()
            for (const m of original.filter(
              (e) => e.content.includes(fragment) && !isProtectedEntry(e) && !preserve.has(e.id),
            )) {
              changeCount += await store.remove(m.id)
            }
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

/** 人格卡整合建议解析(容错:notes 非字符串/sourceIds 非法 → null) */
export function parsePersonaMerge(raw: unknown): EvolutionPersonaMerge | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const notes = String(r.notes ?? '').trim().slice(0, 3000)
  const sourceIds = Array.isArray(r.sourceIds)
    ? r.sourceIds.map((v) => String(v ?? '').trim()).filter(Boolean).slice(0, 20)
    : []
  const prompt = String(r.prompt ?? '').trim().slice(0, 8000)
  const style = sanitizePersonaStyle(r.style)
  // 至少要有一个可落地内容(notes / prompt / style);sourceIds 只是迁移源
  if (!notes && !prompt && !style) return null
  return {
    ...(notes ? { notes } : {}),
    ...(sourceIds.length > 0 ? { sourceIds } : {}),
    ...(prompt ? { prompt } : {}),
    ...(style ? { style } : {}),
  }
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
  /** 人格卡存储(2026-10-25;未注入 = 不整合人格卡,旧宿主兼容) */
  getPersonaStore?(): PersonaCardStoreLike | null
  /** 人格卡建议缓冲区(2026-10-26;未注入 = 不产生建议) */
  getPersonaBufferStore?(): PersonaBufferStoreLike | null
  /** 记忆文件与日志目录(userData) */
  getMemoryDir(): string
  onEvent(event: AgentEvent): void
  /** LLM 流式调用(可注入;缺省经 LLM 接缝默认运行时) */
  stream?(params: LlmStreamParams): Promise<ProviderOutcome>
}): EvolutionHandle {
  const { getConfig, getStore, getMemoryDir, onEvent } = deps
  const stream = deps.stream ?? ((params: LlmStreamParams) => getDefaultLlmRuntime().stream(params))
  // 评估 Sub Agent:与总结同一套内核(Sub 供应商/超时/鉴权)
  const evaluator = createEvaluatorAgent({
    getConfig,
    stream,
    onProgress: (phase) => onEvent({ type: 'evolution-progress', phase }),
  })
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
    // 人格卡不再进进化快照(2026-10-26):建议只进缓冲区,合并是独立
    // 手动动作;快照回滚不应覆盖主人后来的合并(撤销由缓冲区负责)。
    await fs.writeFile(file, JSON.stringify({ version, entries }, null, 2), 'utf8')
    return file
  }

  /** 记忆清单文本(评审/复评的输入)。
   * **受保护标记(2026-08-13,用户实测"进化总是丢失岛灵设定")**:人设/
   * 岛灵设定条目标注【受保护·主人设定】——评审提示词禁止触碰,且
   * applyChanges 代码层硬拦截,双保险 */
  function memoryDump(entries: MemoryEntry[], markCandidates = false): string {
    if (entries.length === 0) return '(暂无记忆)'
    const typeLabel: Record<string, string> = { preference: '偏好', fact: '事实', workflow: '工作流', lesson: '教训' }
    return entries
      .map((e, i) => {
        const lock = isProtectedEntry(e) ? '【受保护·主人设定】' : ''
        // 人格卡整合候选(2026-10-25):只有标记者可被 personaMerge 引用
        const mergeable = markCandidates && isPersonaMergeCandidate(e) ? '【可整合·人设/风格】' : ''
        return `${i + 1}. [${typeLabel[e.type] ?? e.type}]${lock}${mergeable} ${e.content}`
      })
      .join('\n')
  }

  /** 评审系统提示(评分 rubric + 假说驱动的改进建议) */
  function reviewSystemPrompt(): string {
    return (
      '你是记忆系统评审器。对给定记忆集(用户偏好/事实/工作流/教训)做质量评估,输出 JSON(必须含 "json" 字样)。' +
      '评分维度(每项 0-10):冗余度(**同一主题最多一条**)、一致性(无自相矛盾)、时效性(无明显过时)、' +
      '可操作性(每条具体、不空泛)、价值性(值得长期保留)。总分 0-100。' +
      '输出格式:{"total": 总分, "issues": ["问题1"], "changes": [{"op": "add"|"delete"|"update", ' +
      '"id": "原条目序号(delete/update 必填)", "content": "内容", "type": "preference|fact|workflow|lesson", ' +
      '"merge": true|false, "hypothesis": "预测的改进效果"}], ' +
      '"personaMerge": {"notes": "追加到人格卡整合区的要点(多行)", "sourceIds": [候选条目序号], ' +
      '"prompt": "可选:完整改写后的人格提示词", "style": {"tone": "…", "sentence": "…", "emoji": "none|rare|normal", "examples": [{"user":"…","assistant":"…"}]}}}。' +
      '**全量覆盖(2026-10-26,最高优先级之一)**:必须逐条审视清单里的**所有记忆**(事实/工作流/教训/偏好),' +
      '不要只看带【可整合】标记的候选——每条要么明确保留,要么纳入 changes 去重/合并/删除;' +
      '遗漏整块重复或过时条目视为本轮不合格。' +
      '**人格卡提案(可选)**:若确实需要优化主人手写的提示词或结构化风格,可给 personaMerge.prompt/style' +
      '(必须给**完整值**,不要只给差异);**不得丢失主人原有的身份/称谓/禁忌/偏好**;没有把握就不提。' +
      '提案会先进缓冲区,主人看到前后差异后手动合并才生效。' +
      '**人格卡整合(2026-10-25,仅在输入含【当前人格卡】时)**:清单中带【可整合·人设/风格】的' +
      '条目(人设/人格/岛灵设定、说话风格/偏好)可整理进当前人格卡的「进化整合区」——' +
      '按主题写成简洁要点(每条一行、保留全部信息点),用 personaMerge.notes 输出,' +
      'sourceIds 只填这些候选条目的序号;建议先进入"记忆进化缓冲区",主人合并到人格卡后才从长期记忆移除。' +
      '新的性格特征单独写成「性格:词——这个性格在说话里怎么体现」(词要具体,如护短、嘴硬;不要写「更自然」「有人味」)。' +
      '提示词或整合区里已经有的性格不要再写。没有新性格就不要为了凑数输出 personaMerge。' +
      '**人格卡提示词原文由主人手写**:你不能直接改写卡片;只能通过 personaMerge.prompt/style 提交提案,' +
      '由主人查看差异后手动合并;没有提案时 personaMerge 只追加整合区。' +
      '受保护候选条目的原文会由程序逐字写入整合区,不要遗漏其信息;' +
      '**受保护条目可以列入 personaMerge.sourceIds**(这是它们唯一的迁移路径:' +
      '内容先写入人格卡再移除),但仍不得出现在 changes 的 delete/update/merge 里;' +
      '整合区容量有限(12000 字),写不下时程序会整体放弃且不删源条目——' +
      '所以要精炼,宁少勿滥。没有【当前人格卡】或没有候选条目时不要输出 personaMerge;' +
      'personaMerge 属于清理类改动,不需要 hypothesis。' +
      '**垂直细分整合(最重要,优先于其它 change)**:把内容相似/重复的条目按主题归组——同一主题' +
      '(如"回答风格"、"B站视频下载"、"夜间习惯"、"TTG/小胖偏好"、"工具使用"等)的多条记忆' +
      '必须整合为**一条**垂直细分条目:选该主题内容最完整的一条,输出 ' +
      '{"op": "update", "id": 该条序号, "content": 整合全部要点后的精炼内容(保留各条的全部信息点,不丢失任何信息), "merge": true},' +
      '该主题其余条目逐条输出 {"op": "delete", "id": 序号}。**合并后逐条核对:同一主题必须只剩一条,' +
      '不允许残留任何重复**;不同主题不要互相合并(垂直细分,不是大杂烩)。' +
      '**输出预算(条目多时尤其重要)**:单次最多输出 12 条 changes——优先处理最严重的 2~3 个' +
      '重复/低价值主题并把它们整合干净,其余问题留给后续轮次(进化共多轮,不必一轮清完);' +
      'changes 过多会超出输出上限被截断,整轮 JSON 报废、前功尽弃。' +
      '**受保护条目(清单中带【受保护·主人设定】标记)是主人指定的岛灵设定/人设/角色,绝对不可触碰**(2026-08-13):' +
      '任何 change 都不得以受保护条目为目标——不得 delete、不得 update/merge 改写其内容、' +
      '不得把其它条目合并进它、也不得把它并入其它条目;主题整合时受保护条目原样保留。' +
      '若其它条目与受保护条目看似冲突,**以受保护条目为准,修改其它条目**,' +
      '绝不为"协调一致/精简表述/消除冲突"而改写或删除受保护条目。' +
      '不要 add 人设/人格/角色相关的新条目(人设只能由主人指定,不是评审的权限)。' +
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
      // 人格卡不经进化快照回滚(2026-10-26):建议只在缓冲区,合并撤销由
      // 缓冲区记录负责;此处只清掉回滚目标之后尚未合并的建议
      await deps.getPersonaBufferStore?.()?.removeAfterVersion(version)
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
    // 人格卡建议(2026-10-26):仅在设置页开启 personaEvolveEnabled 时
    // 让评审输出 personaMerge;结果只进缓冲区,不直接改卡/删记忆。
    const personaStore = deps.getPersonaStore?.() ?? null
    const personaBufferStore = deps.getPersonaBufferStore?.() ?? null
    const personaEnabled = config.personaEvolveEnabled === true
    const activePersonaId = String(config.activePersonaId ?? '').trim()
    const activePersona = personaStore && activePersonaId ? await personaStore.get(activePersonaId) : null
    // 待处理建议一并给评审:避免反复提出已经排队等待合并的内容
    let pendingBlock = ''
    if (activePersona && personaEnabled && personaBufferStore) {
      try {
        const pending = (await personaBufferStore.list()).filter(
          (i) => i.cardId === activePersona.id && !i.mergedAt && !i.undoneAt,
        )
        if (pending.length > 0) {
          const lines = pending
            .map((i) => `- [${i.kind === 'style' ? '风格' : i.kind === 'trait' ? '性格' : '记忆'}] ${i.notes.replace(/\s+/g, ' ').slice(0, 500)}`)
            .join('\n')
          pendingBlock = `\n【待处理人格卡建议(勿重复提出)】\n${lines.slice(0, 2000)}`
        }
      } catch {
        pendingBlock = ''
      }
    }
    const personaInput = activePersona && personaEnabled
      ? `【当前人格卡】\n名称:${activePersona.name}\n` +
        `提示词(主人手写,绝对不可改写):\n${activePersona.prompt.slice(0, 4000) || '(空)'}\n` +
        `${formatPersonaStyleBlock(activePersona.style) || '(未设置结构化风格)'}\n` +
        `进化整合区(可追加;当前):\n${(activePersona.notes ?? '').slice(0, 8000) || '(空)'}` +
        pendingBlock
      : personaEnabled
        ? '【当前人格卡】未激活人格卡(禁止输出 personaMerge)'
        : '【当前人格卡】未开启人格卡优化(本机设置里关闭;禁止输出 personaMerge)'

    // 1. 评审(评分 + 问题 + 假说建议)——委托独立评估 Sub Agent
    const reviewInput = `【系统提示词】${config.systemPrompt.slice(0, 500)}\n\n${personaInput}\n\n【当前记忆】\n${memoryDump(entries, true)}${focusLine}`
    // **可扩展性预算(2026-08-14,用户实测"条目超 40 个进化就崩了")**:
    // 输出 token 上限与超时按记忆规模放大——原缺省 4096 token/60s 在
    // 大记忆集下把评审 JSON 截断/掐死,两次降级重试同样失败 → 中止
    const dumpChars = entries.reduce((n, e) => n + e.content.length, 0)
    const evalOpts = {
      maxOutputTokens: evalOutputBudget(dumpChars),
      timeoutMs: evalTimeoutMs(entries.length),
    }
    const reviewText = await evaluator.evaluate(
      reviewSystemPrompt(),
      reviewInput,
      `第 ${roundNo}/${rounds} 轮:评估子代理评审`,
      evalOpts,
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
        { ...evalOpts, jsonMode: false },
      )
      review = parseJsonLoose(retryText)
    }
    if (!review || typeof review.total !== 'number') throw new Error('评审输出无法解析(两次尝试均非合法 JSON)')
    const before = clampScore(review.total)
    const issues = Array.isArray(review.issues) ? review.issues.map(String) : []
    const changes = Array.isArray(review.changes)
      ? review.changes.filter((c): c is EvolutionChange => !!c && typeof c === 'object')
      : []
    const personaMerge = personaEnabled ? parsePersonaMerge(review.personaMerge) : null
    // 先把建议算出来(不落盘):源条目本轮受保护,普通清理不得删改
    const personaProposal =
      personaMerge && activePersona
        ? buildPersonaProposal(entries, activePersona, personaMerge)
        : null
    const proposalOk =
      !!personaProposal &&
      !personaProposal.skippedReason &&
      (personaProposal.sources.length > 0 || !!personaProposal.cardPatch)
    const preserveIds = new Set(proposalOk ? personaProposal!.sources.map((s) => s.id) : [])

    // 2. 候选:应用建议前确保 Reference 快照存在(拒绝时恢复点;
    //    同版本不重复打包——第一轮创建,后续轮复用)
    const refVersion = state.version
    await ensureSnapshot(refVersion)
    const changeCount = await applyChanges(changes, getStore(), { preserveIds })
    // 人格卡建议算真实改动(进入缓冲区;不直接改卡)
    const hasRealChange = changeCount > 0 || proposalOk
    // 清理类轮次(2026-08-11 二轮):本轮含 delete/merge 整合建议
    // (评审的确定性清理——内容只减/整合,评审自己设计的改动);
    // 人格卡建议同样免复评直接接受(2026-10-26)
    const cleanupApplied = hasRealChange && (changes.some(isCleanupChange) || proposalOk)

    // 3. 复评(独立黑盒打分)——**仅对纯增改轮次(无 delete/merge 清理)
    //    生效(2026-08-11 实测:复评与评审分数不同量级、噪声大——评审
    //    92、复评 62,否决掉评审确认的垂直细分整合 = "很多冗余记忆但
    //    没整合"的最后一环;清理是评审的确定性判断,直接接受;
    //    纯增改轮次保留复评棘轮防无效改动)**
    let after = before
    if (!cleanupApplied && hasRealChange) {
      const afterEntries = await store.list()
      // 复评只输出 {"total":N},无需放大输出预算;但输入同样大,超时同步放大
      const reevalOpts = { timeoutMs: evalOpts.timeoutMs }
      const reevalText = await evaluator.evaluate(
        reevalSystemPrompt(),
        `【改进后记忆】\n${memoryDump(afterEntries)}`,
        `第 ${roundNo}/${rounds} 轮:评估子代理复评`,
        reevalOpts,
      )
      let reeval = parseJsonLoose(reevalText)
      if (!reeval || typeof reeval.total !== 'number') {
        // 与评审同款降级(见上)
        const retryText = await evaluator.evaluate(
          reevalSystemPrompt(),
          `【改进后记忆】\n${memoryDump(afterEntries)}`,
          `第 ${roundNo}/${rounds} 轮:评估子代理复评(纯文本重试)`,
          { ...reevalOpts, jsonMode: false },
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
    // 人格卡建议只在轮次被接受后进缓冲区(拒绝即丢弃),不直接改卡
    let personaBuffered = 0
    if (applied && proposalOk && personaProposal && activePersona && personaBufferStore) {
      try {
        await personaBufferStore.add({
          cardId: activePersona.id,
          cardName: activePersona.name,
          notes: personaProposal.notes,
          sourceIds: personaProposal.sources.map((s) => s.id),
          sources: personaProposal.sources,
          cardPatch: personaProposal.cardPatch,
          evolutionVersion: state.version,
        })
        personaBuffered = Math.max(1, personaProposal.sources.length)
      } catch {
        // 缓冲区写失败不影响记忆进化结果
      }
    }
    const summary =
      `v${refVersion}→v${applied ? state.version : refVersion} 评分 ${before} → ${after}` +
      (issues.length > 0 ? `;问题:${issues[0].slice(0, 50)}` : '') +
      (hasRealChange
        ? cleanupApplied
          ? `;整合/清理 ${changeCount} 条重复(评审确认直接接受)`
          : `;应用 ${changeCount} 条假说改进`
        : ';无有效改进(无假说的建议已忽略)') +
      (personaBuffered > 0
        ? `;人格卡建议 ${personaBuffered} 条已进入缓冲区(设置页按需合并)`
        : '')
    lastResult = { at: Date.now(), version: state.version, applied, before, after, summary }
    logs = [{ at: Date.now(), version: state.version, before, after, applied, summary, changes: changeCount }, ...logs]
    await saveLog()
    return {
      ok: true,
      applied,
      before,
      after,
      version: state.version,
      summary,
      cleanupApplied,
      personaProposed: personaBuffered > 0,
    }
  }

  /** 完整进化会话:多轮候选循环,直到轮数预算/达标/拒绝后停止。
   * **轮数按记忆规模自适应(2026-08-14)**:每轮只清最严重的几个主题
   * (评审提示词"输出预算"),条目多时需要更多轮收敛——见 resolveRoundBudget */
  async function runEvolution(focus?: string, rounds = 2): Promise<EvolutionResult[]> {
    const results: EvolutionResult[] = []
    const store = getStore()
    const entryCount = store ? (await store.list()).length : 0
    const roundBudget = resolveRoundBudget(rounds, entryCount)
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
    /**
     * 快捷单轮进化(2026-09-22 用户要求"LLM 直接进行快捷自我进化,运行
     * 记忆进化"):同步跑**恰好一轮**(不走 resolveRoundBudget 的条目数
     * 放大——快捷就是轻量),评审→应用→复评→棘轮,等结果回来给人话摘要,
     * LLM 当轮转述。busy 与后台 run 共用同一守卫(两路互斥)。
     */
    async runQuick(focus?: string) {
      await initPromise
      if (busy) return { ok: false, message: '记忆进化已在运行中,请稍候' }
      busy = true
      onEvent({ type: 'evolution-progress', phase: '快捷记忆进化(单轮)' })
      try {
        const r = await runRound(focus, 1, 1)
        return {
          ok: true,
          message:
            `快捷记忆进化完成:${r.summary}` +
            (r.applied ? '(已接受,新版本已存档)' : '(未应用,记忆已恢复原样)'),
        }
      } catch (err) {
        return { ok: false, message: `快捷记忆进化失败:${(err as Error).message}` }
      } finally {
        busy = false
        onEvent({ type: 'evolution-done' })
      }
    },
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
          showNotify(title, body)
        })
        .catch((err: Error) => {
          showNotify('记忆进化失败', err.message.slice(0, 120))
        })
        .finally(() => {
          busy = false
          onEvent({ type: 'evolution-done' })
        })
      return {
        started: true,
        // 轮数与 runEvolution 同款自适应(按条目数放大,见 resolveRoundBudget),
        // 提示与实际执行一致
        message: `记忆进化已开始(共 ${resolveRoundBudget(rounds, (await getStore()?.list())?.length ?? 0)} 轮,后台执行,完成后有系统通知)`,
      }
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
      // 独立人格卡缓冲区一并清空(版本历史已归零,旧建议无归属)
      await deps.getPersonaBufferStore?.()?.clear()
      return '已清除全部版本,回到初始状态(v1)'
    },
  }
}
