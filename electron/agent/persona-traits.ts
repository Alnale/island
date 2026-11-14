/**
 * 从近 30 条聊天里提取新性格(2026-10-26)
 *
 * 与去 AI 味评审共用同一窗口(最近 30 条用户原话 + 岛灵回复),
 * 但只找人格卡上还没有的性格。证据必须是对话原文里的连续片段,
 * 编造的引用会被丢掉。结果写成「性格:词——怎么体现」,进缓冲区
 * kind=trait;主人合并后才进入整合区,由叙事层织进系统提示。
 * 不改手写提示词,不改语气和风格档。
 */

import type { LlmStreamParams } from './plugin/llm'
import { formatTraitNote } from './persona'
import { prepareStyleReviewSamples, type StyleReviewSample, type StyleSampleQuery } from './style-review'
import type { AgentConfig, AgentMessage, PersonaCard, ProviderOutcome } from './types'
import {
  defaultSubStream,
  prepareSubCall,
  runSubJson,
  singleUserHistory,
} from './subagents/runtime'

export interface ExtractedTrait {
  label: string
  detail: string
  evidence: string
}

export interface TraitReviewResult {
  traits: ExtractedTrait[]
  /** 可追加到进化整合区的「性格:」行 */
  notes: string[]
}

const EMPTY: TraitReviewResult = { traits: [], notes: [] }

/** 空泛词不算性格 */
const VAGUE_TRAIT =
  /^(?:自然|口语|口语化|有人味|接地气|像人|正常|友好|礼貌|温柔一点|自然一点|少客套|不要太\s*ai|有个性|更自然|像个人)$/i

/** 功能词 / 对话角色,不是性格 */
const NOT_A_TRAIT =
  /^(?:这个|那个|然后|就是|可以|不是|没有|什么|怎么|这样|那样|一下|一点|一些|我们|你们|他们|主人|岛灵|回复|说话|性格|特质|用户)$/

function normKey(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '')
}

function cardText(card?: Pick<PersonaCard, 'name' | 'prompt' | 'notes' | 'style'> | null): string {
  if (!card) return ''
  const style = card.style
  return [
    card.name,
    card.prompt,
    card.notes,
    style?.tone,
    style?.sentence,
    style?.address,
    ...(style?.particles ?? []),
  ]
    .filter(Boolean)
    .join('\n')
}

function evidenceInSamples(samples: StyleReviewSample[], evidence: string): boolean {
  const needle = normKey(evidence)
  if (needle.length < 4) return false
  return samples.some((sample) => normKey(sample.user).includes(needle) || normKey(sample.assistant).includes(needle))
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

export function parseTraitReviewJson(raw: string): { traits: ExtractedTrait[] } | null {
  const text = String(raw ?? '').trim()
  if (!text) return null
  const fenced = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
  const extracted = extractJsonObject(fenced) ?? extractJsonObject(text)
  for (const candidate of [text, fenced, extracted ?? '']) {
    if (!candidate) continue
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      const list = Array.isArray(parsed.traits) ? parsed.traits : []
      const traits: ExtractedTrait[] = []
      for (const item of list) {
        if (!item || typeof item !== 'object') continue
        const row = item as Record<string, unknown>
        traits.push({
          label: String(row.label ?? '').trim().slice(0, 12),
          detail: String(row.detail ?? '').trim().slice(0, 80),
          evidence: String(row.evidence ?? '').trim().slice(0, 80),
        })
        if (traits.length >= 8) break
      }
      return { traits }
    } catch {
      // 尝试下一个候选
    }
  }
  return null
}

/**
 * 收成可合并的新性格。
 * 引用必须能在近 30 条原文里找到;卡上已有的性格、空泛词丢掉。
 */
export function finalizeTraitReview(
  raw: { traits?: ExtractedTrait[] } | null,
  ctx: {
    samples: StyleReviewSample[]
    card?: Pick<PersonaCard, 'name' | 'prompt' | 'notes' | 'style'> | null
  },
): TraitReviewResult {
  const known = normKey(cardText(ctx.card))
  const traits: ExtractedTrait[] = []
  const seen = new Set<string>()
  for (const item of raw?.traits ?? []) {
    const label = String(item?.label ?? '').trim().slice(0, 12)
    const detail = String(item?.detail ?? '').trim().slice(0, 80)
    const evidence = String(item?.evidence ?? '').trim().slice(0, 80)
    const key = normKey(label)
    if (label.length < 2 || label.length > 12 || !key || seen.has(key)) continue
    if (VAGUE_TRAIT.test(label) || NOT_A_TRAIT.test(label)) continue
    if (!evidenceInSamples(ctx.samples, evidence)) continue
    if (known.includes(key)) continue
    seen.add(key)
    traits.push({ label, detail, evidence })
    if (traits.length >= 5) break
  }
  const notes = traits.map((trait) => formatTraitNote(trait.label, trait.detail)).filter(Boolean)
  if (notes.length === 0) return EMPTY
  return { traits, notes }
}

export function buildTraitReviewSystem(): string {
  return (
    '你从岛灵最近的真实对话里找出**新长出来的性格**。只看性格,不改事实,不评价对错,不重写人格卡。' +
    '性格要具体(护短、嘴硬、爱拆台、先凶后软),不要写「更自然」「有人味」「少客套」。' +
    '只收有原文证据的:用户明确纠正或要求(「别那么客套」「毒一点」「叫我老板」),或同一性格在多轮里稳定出现、且人格卡上还没有。' +
    '单次玩笑、任务步骤、代码讲解、清单格式不要当成性格。已写在提示词、语气或整合区里的性格不要再提。' +
    '输出 JSON(必须含 "json" 字样):' +
    '{"traits":[{"label":"2到8字性格词","detail":"这个性格在说话里怎么体现,不超过40字","evidence":"从对话原文逐字摘的短句,必须能在输入里找到"}]}。' +
    '没有新性格就输出 {"traits":[]}。不要输出 prompt,不要解释。'
  )
}

function buildTraitReviewUser(
  samples: StyleReviewSample[],
  card?: Pick<PersonaCard, 'name' | 'prompt' | 'notes' | 'style'> | null,
): string {
  const style = card?.style
  const brief = card
    ? [
        `【当前人格卡 · ${card.name || '未命名'}】`,
        `提示词:${String(card.prompt ?? '').trim().slice(0, 500) || '(空)'}`,
        `语气:${style?.tone || '(未设)'}`,
        `整合区:${String(card.notes ?? '').trim().slice(0, 800) || '(空)'}`,
        '上面已经有的性格不要再输出。',
      ].join('\n')
    : '【当前人格卡】未提供。只根据对话判断,不要编造人设。'
  const body = samples
    .map((sample, index) => {
      const user = sample.user ? `用户:${sample.user}\n` : ''
      const tag = sample.mode === 'task' ? '任务' : '闲聊'
      return `${index + 1}. [${tag}]\n${user}岛灵:${sample.assistant}`
    })
    .join('\n\n')
  return `${brief}\n\n【最近 ${samples.length} 条对话】\n${body}`
}

export function createTraitReviewAgent(deps: {
  getConfig: () => AgentConfig
  stream?: (params: LlmStreamParams) => Promise<ProviderOutcome>
}): {
  review(
    messages: AgentMessage[],
    card?: Pick<PersonaCard, 'name' | 'prompt' | 'notes' | 'style'> | null,
    query?: StyleSampleQuery,
  ): Promise<TraitReviewResult>
} {
  const stream = deps.stream ?? defaultSubStream
  return {
    async review(messages, card, query) {
      const samples = prepareStyleReviewSamples(messages, query?.ids?.length ? { ...query, limit: query.limit ?? 30 } : (query?.limit ?? 30))
      if (samples.length === 0) return EMPTY
      const { config, ready } = prepareSubCall(deps.getConfig)
      if (!ready) throw new Error('尚未配置 Sub Agent API Key,无法从聊天里提取性格')
      const parsed = await runSubJson<{ traits: ExtractedTrait[] }>({
        config,
        stream,
        system: buildTraitReviewSystem(),
        history: singleUserHistory('persona-traits', buildTraitReviewUser(samples, card)),
        timeoutMs: 90_000,
        parse: parseTraitReviewJson,
        fallback: { traits: [] },
        maxOutputTokens: 2048,
      })
      return finalizeTraitReview(parsed, { samples, card })
    },
  }
}
