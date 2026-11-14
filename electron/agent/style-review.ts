/**
 * 去 AI 味独立评审 Agent(2026-10-26)
 *
 * 与记忆进化完全独立:读取最近 30 条岛灵回复(只取 assistant 文本 part),
 * 由 Sub 供应商做一次无工具评审,再经本地规则收束:
 * - 代码块先抽掉,避免任务正文占满样本;
 * - 带上前一条用户原话,并标闲聊 / 任务,清单只在闲聊里算 AI 腔;
 * - 对照当前人格卡,丢掉已经禁用的词和空泛建议;
 * - 回复里反复出现的套话,模型漏报时由代码补上;
 * - 禁用词必须能在原文里找到,防止评审编造。
 * 结果由主进程写入人格卡进化缓冲区(kind='style')。禁用词和反例进
 * cardPatch.style,合并时只追加这两项,不改语气和提示词。
 */

import type { LlmStreamParams } from './plugin/llm'
import type { AgentConfig, AgentMessage, PersonaCard, ProviderOutcome } from './types'
import { styleModeForText, type StyleMode } from './persona-style'
import {
  defaultSubStream,
  prepareSubCall,
  runSubJson,
  singleUserHistory,
} from './subagents/runtime'

export interface StyleReviewResult {
  /** 检出的 AI 腔问题(引用原句片段) */
  issues: string[]
  /** 可执行的去 AI 味建议(写入人格卡整合区) */
  notes: string[]
  /** 反例(绝不要这样说的原句/改写) */
  antiExamples: string[]
  /** 建议追加的禁用词(必须在回复原文里出现过) */
  bannedPhrases: string[]
}

export interface StyleReviewSample {
  user: string
  assistant: string
  mode: StyleMode
}

const EMPTY: StyleReviewResult = { issues: [], notes: [], antiExamples: [], bannedPhrases: [] }

/** 空泛、无法执行的建议(评审爱写,落进整合区没有用) */
const VAGUE_NOTE =
  /^(?:请)?(?:要)?(?:更)?(?:自然|口语化|像人|有人味|接地气)(?:一点|一些|些)?[。！!]?$|^说话(?:要)?自然(?:一点|些)?$|^不要太(?:像)?\s*ai$|^减少\s*ai\s*味$|^语气自然一点$/i

/**
 * 确定性套话。opener/closer 出现一次就值得禁;
 * 「首先 / 其次」只统计闲聊,且至少两次,避免任务步骤被误伤。
 */
const AI_MARKERS: Array<{ phrase: string; where: 'all' | 'chat'; min: number }> = [
  { phrase: '当然可以', where: 'all', min: 1 },
  { phrase: '我来帮你', where: 'all', min: 1 },
  { phrase: '我来为你', where: 'all', min: 1 },
  { phrase: '很高兴为你', where: 'all', min: 1 },
  { phrase: '希望这对你有帮助', where: 'all', min: 1 },
  { phrase: '希望对你有帮助', where: 'all', min: 1 },
  { phrase: '如果还有其他问题', where: 'all', min: 1 },
  { phrase: '如果还有什么问题', where: 'all', min: 1 },
  { phrase: '随时告诉我', where: 'all', min: 1 },
  { phrase: '需要我帮你', where: 'all', min: 1 },
  { phrase: '要不要我', where: 'all', min: 1 },
  { phrase: '首先', where: 'chat', min: 2 },
  { phrase: '其次', where: 'chat', min: 2 },
  { phrase: '综上所述', where: 'chat', min: 1 },
  { phrase: '总的来说', where: 'chat', min: 1 },
  { phrase: '总而言之', where: 'chat', min: 1 },
]

function normKey(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '')
}

function textOf(message: AgentMessage): string {
  return message.parts
    .filter((p): p is Extract<AgentMessage['parts'][number], { type: 'text' }> => p.type === 'text')
    .map((p) => String(p.text ?? '').trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

/** 评审样本里拿掉代码,避免长代码把后面的客套截掉 */
function stripCodeForReview(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '[代码略]')
    .replace(/`[^`\n]+`/g, '[代码略]')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function countOccurs(hay: string, needle: string): number {
  if (!needle) return 0
  let n = 0
  let i = 0
  while ((i = hay.indexOf(needle, i)) !== -1) {
    n += 1
    i += needle.length
  }
  return n
}

/** 评审取样:不传 ids 时取最近 limit 条;传入 ids 时只评审这些助手消息 */
export interface StyleSampleQuery {
  limit?: number
  ids?: string[]
}

function sampleQuery(limitOrQuery: number | StyleSampleQuery | undefined): { limit: number; ids: Set<string> | null } {
  if (typeof limitOrQuery === 'number') return { limit: limitOrQuery, ids: null }
  const limit = typeof limitOrQuery?.limit === 'number' && limitOrQuery.limit > 0 ? limitOrQuery.limit : 30
  const ids = (limitOrQuery?.ids ?? []).map((id) => String(id ?? '').trim()).filter(Boolean)
  return { limit, ids: ids.length > 0 ? new Set(ids) : null }
}

/** 取最近 N 条 assistant 消息的文本(工具调用/结果/媒体不参与) */
export function selectRecentAssistantTexts(messages: AgentMessage[], limit = 30): string[] {
  const out: string[] = []
  for (const m of messages) {
    if (m.role !== 'assistant') continue
    const text = textOf(m)
    if (!text) continue
    out.push(text.slice(0, 800))
  }
  return out.slice(-limit)
}

/**
 * 评审输入:助手回复 + 前一条用户原话 + 闲聊/任务标记。
 * 第二个参数可以是条数,或 `{ ids }` 只取当前窗口里勾选的消息。
 * 勾选时不再截最近 30 条,最多仍保留 30 条以免提示过长。
 */
export function prepareStyleReviewSamples(
  messages: AgentMessage[],
  limitOrQuery: number | StyleSampleQuery = 30,
): StyleReviewSample[] {
  const { limit, ids } = sampleQuery(limitOrQuery)
  const samples: StyleReviewSample[] = []
  let pendingUser = ''
  for (const m of messages) {
    if (m.role === 'user') {
      pendingUser = textOf(m).slice(0, 120)
      continue
    }
    if (m.role !== 'assistant') continue
    if (ids && !ids.has(m.id)) {
      pendingUser = ''
      continue
    }
    const raw = textOf(m)
    if (!raw) continue
    const assistant = stripCodeForReview(raw).slice(0, 800)
    if (!assistant) continue
    samples.push({
      user: pendingUser,
      assistant,
      mode: styleModeForText(raw),
    })
    pendingUser = ''
  }
  return samples.slice(-limit)
}

function collectMarkerHits(samples: StyleReviewSample[]): string[] {
  const all = samples.map((s) => s.assistant).join('\n')
  const chat = samples
    .filter((s) => s.mode === 'chat')
    .map((s) => s.assistant)
    .join('\n')
  const found: string[] = []
  for (const marker of AI_MARKERS) {
    const hay = marker.where === 'chat' ? chat : all
    if (countOccurs(hay, marker.phrase) >= marker.min) found.push(marker.phrase)
  }
  // 「希望对你有帮助」已包含在更长的「希望这对你有帮助」里时只留长的
  return found.filter((phrase) => !found.some((other) => other !== phrase && other.includes(phrase)))
}

export function buildStyleReviewSystem(): string {
  return (
    '你是"去 AI 味"评审器。输入是岛灵最近若干条真实回复,只分析**说话方式**,不改事实、不评价内容对错,不改人设。' +
    '标了[任务]的回复:代码、链接、用户明确要的步骤清单不算 AI 腔。' +
    '重点找:助手腔开场("当然可以/我来帮你")、结尾客套("希望有帮助/随时告诉我")、闲聊里的首先/其次/综上所述、' +
    '闲聊分点或小标题、过度礼貌与道歉、未被请求的反问("需要我…吗")、emoji/感叹号过多、' +
    '机械排比与三段式、每段总结、复述用户问题、解释自己正在做什么。' +
    '已有禁用词、反例和整合区里写过的规则不要再提。' +
    '输出 JSON(必须含 "json" 字样):' +
    '{"issues":["问题(引用原句片段,≤60字)"],' +
    '"notes":["可直接写进人格卡的风格规则(≤80字,具体可执行,最多5条)"],' +
    '"antiExamples":["绝不要这样说的反例,尽量引用原句(≤120字,最多3条)"],' +
    '"bannedPhrases":["回复原文里真实出现的短套话,≤30字,最多8条"]}。' +
    '要求:notes 必须具体("少用首先其次,直接说事"),不要空泛("要自然一点");' +
    'bannedPhrases 只能摘原文,不要发明卡上没有出现过的词;' +
    '如果回复已经自然,四个数组都留空。只输出 JSON,不要解释。'
  )
}

function cardBrief(card?: Pick<PersonaCard, 'name' | 'prompt' | 'notes' | 'style'> | null): string {
  if (!card) return '【当前人格卡】未提供。只根据回复本身判断,不要编造人设。'
  const style = card.style
  const lines = [
    `【当前人格卡 · ${card.name || '未命名'}】`,
    `提示词摘要:${String(card.prompt ?? '').trim().slice(0, 400) || '(空)'}`,
    `语气:${style?.tone || '(未设)'}`,
    `已有禁用词:${style?.bannedPhrases?.join('、') || '(无)'}`,
    `已有反例:${style?.antiExamples?.join(' / ') || '(无)'}`,
    `整合区:${String(card.notes ?? '').trim().slice(0, 800) || '(空)'}`,
    '不要重复上面已有的规则,也不要建议改语气或重写提示词。',
  ]
  return lines.join('\n')
}

function buildStyleReviewUser(
  samples: StyleReviewSample[],
  card?: Pick<PersonaCard, 'name' | 'prompt' | 'notes' | 'style'> | null,
): string {
  const body = samples
    .map((sample, index) => {
      const user = sample.user ? `用户:${sample.user}\n` : ''
      const tag = sample.mode === 'task' ? '任务' : '闲聊'
      return `${index + 1}. [${tag}]\n${user}岛灵:${sample.assistant}`
    })
    .join('\n\n')
  return `${cardBrief(card)}\n\n【最近 ${samples.length} 条岛灵回复】\n${body}`
}

/** 从混有说明文字的输出里切出第一个完整 JSON 对象 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/** 宽松 JSON 解析(容忍代码块包裹/前后说明) */
export function parseStyleReviewJson(raw: string): StyleReviewResult | null {
  const text = String(raw ?? '').trim()
  if (!text) return null
  const fenced = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
  const extracted = extractJsonObject(fenced) ?? extractJsonObject(text)
  const candidates = [text, fenced, extracted ?? '']
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      const list = (v: unknown, max: number, len: number) =>
        Array.isArray(v)
          ? v
              .map((x) => String(x ?? '').trim())
              .filter(Boolean)
              .slice(0, max)
              .map((s) => s.slice(0, len))
          : []
      return {
        issues: list(parsed.issues, 6, 80),
        notes: list(parsed.notes, 5, 120),
        antiExamples: list(parsed.antiExamples, 3, 160),
        bannedPhrases: list(parsed.bannedPhrases, 8, 30),
      }
    } catch {
      // 尝试下一个候选
    }
  }
  return null
}

/**
 * 把模型输出收成可合并的建议。
 * 禁用词必须在样本原文里出现,且不与卡上已有项重复;
 * 套话标记由代码补上,不依赖模型记得报。
 */
export function finalizeStyleReview(
  raw: StyleReviewResult,
  ctx: {
    samples: StyleReviewSample[]
    card?: Pick<PersonaCard, 'name' | 'prompt' | 'notes' | 'style'> | null
  },
): StyleReviewResult {
  const card = ctx.card
  const bannedHave = new Set((card?.style?.bannedPhrases ?? []).map(normKey))
  const antiHave = new Set((card?.style?.antiExamples ?? []).map(normKey))
  const noteHave = new Set(
    String(card?.notes ?? '')
      .split('\n')
      .map((line) => normKey(line.replace(/^[-*•]\s*/, '')))
      .filter(Boolean),
  )
  const corpus = normKey(ctx.samples.map((s) => s.assistant).join('\n'))
  const banned: string[] = []
  const pushBan = (phrase: string) => {
    const s = phrase.trim().slice(0, 30)
    const key = normKey(s)
    if (s.length < 2 || !key || bannedHave.has(key)) return
    if (!corpus.includes(key)) return
    bannedHave.add(key)
    banned.push(s)
  }
  for (const marker of collectMarkerHits(ctx.samples)) pushBan(marker)
  for (const phrase of raw.bannedPhrases ?? []) pushBan(phrase)

  const anti: string[] = []
  for (const line of raw.antiExamples ?? []) {
    const s = line.trim().slice(0, 160)
    const key = normKey(s)
    if (s.length < 8 || !key || antiHave.has(key)) continue
    const grounded =
      corpus.includes(key) || banned.some((phrase) => key.includes(normKey(phrase)) && normKey(phrase).length >= 2)
    if (!grounded) continue
    antiHave.add(key)
    anti.push(s)
    if (anti.length >= 3) break
  }

  const notes: string[] = []
  const pushNote = (line: string) => {
    const s = line.trim().replace(/^[-*•]\s*/, '').slice(0, 120)
    const key = normKey(s)
    if (s.length < 6 || !key || noteHave.has(key) || VAGUE_NOTE.test(s)) return
    noteHave.add(key)
    notes.push(s)
  }
  for (const note of raw.notes ?? []) pushNote(note)
  for (const phrase of banned) {
    if (notes.length >= 5) break
    pushNote(`少用「${phrase}」,直接把事说完`)
  }

  const issues = (raw.issues ?? [])
    .map((s) => s.trim().slice(0, 80))
    .filter(Boolean)
    .filter((s, index, arr) => arr.findIndex((x) => normKey(x) === normKey(s)) === index)
    .slice(0, 6)

  if (issues.length === 0 && notes.length === 0 && anti.length === 0 && banned.length === 0) return EMPTY
  return {
    issues,
    notes: notes.slice(0, 5),
    antiExamples: anti,
    bannedPhrases: banned.slice(0, 8),
  }
}

export function createStyleReviewAgent(deps: {
  getConfig: () => AgentConfig
  stream?: (params: LlmStreamParams) => Promise<ProviderOutcome>
}): {
  review(
    messages: AgentMessage[],
    card?: Pick<PersonaCard, 'name' | 'prompt' | 'notes' | 'style'> | null,
    query?: StyleSampleQuery,
  ): Promise<StyleReviewResult>
} {
  const stream = deps.stream ?? defaultSubStream
  return {
    async review(messages, card, query) {
      const samples = prepareStyleReviewSamples(messages, query?.ids?.length ? { ...query, limit: query.limit ?? 30 } : (query?.limit ?? 30))
      if (samples.length === 0) return EMPTY
      const { config, ready } = prepareSubCall(deps.getConfig)
      if (!ready) throw new Error('尚未配置 Sub Agent API Key,无法进行去 AI 味评审')
      const parsed = await runSubJson<StyleReviewResult>({
        config,
        stream,
        system: buildStyleReviewSystem(),
        history: singleUserHistory('style-review', buildStyleReviewUser(samples, card)),
        timeoutMs: 90_000,
        parse: parseStyleReviewJson,
        fallback: EMPTY,
        maxOutputTokens: 2048,
      })
      return finalizeStyleReview(parsed, { samples, card })
    },
  }
}
