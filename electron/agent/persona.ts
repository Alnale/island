/**
 * 人格卡系统 —— 多套人格的独立资产(2026-10-25)
 *
 * 与长期记忆(memory.json)分离:
 * - 卡片本体存 userData/persona-cards.json(低频变更、体量可控);
 * - 激活状态存 AgentConfig.activePersonaId(引擎每轮读配置 = 热插拔);
 * - **prompt 由主人手写,自我进化绝不改写**;进化只维护卡内独立的
 *   notes「进化整合区」,把零散的人设/说话风格记忆沉淀进卡。
 *
 * 存储纪律与 memory.ts 同款:内存态 + 串行写队列 + 临时文件 rename
 * 原子落盘;上限 50 张、name ≤60、prompt ≤8000、notes ≤12000。
 */

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { isPersonaClassified } from './constants'
import type { MemoryEntry, PersonaBufferItem, PersonaCard, PersonaStyle, PersonaStyleExample } from './types'

export const MAX_PERSONA_CARDS = 50
export const MAX_PERSONA_NAME = 60
export const MAX_PERSONA_PROMPT = 8000
export const MAX_PERSONA_NOTES = 12000
/** 注入系统提示的人格卡块最大长度(截断防膨胀;须容得下 prompt + notes + 风格全满) */
const BLOCK_MAX = 30000

/** 说话风格/偏好关键词(人设标签之外的候选判定;保守,避免吞普通偏好) */
const STYLE_RE =
  /(说话|语气|口癖|口头禅|称呼|自称|性格|表达|回复风格|聊天风格|说话风格|简洁|幽默|温柔|直接|撒娇|吐槽|毒舌|傲娇|冷淡|亲切|人设|人格|角色|岛灵)/

/**
 * 记忆条目是否可整合进人格卡(2026-10-25 用户定案:人设 + 说话风格/偏好):
 * - 人格分类条目(人设/人格/角色/岛灵标签或人设内容)→ 是;
 * - preference 类且命中说话风格关键词 → 是;
 * - 普通 fact / workflow / lesson 不纳入(避免把记忆系统整体吞进人格卡)。
 * 注意用「人格分类」而非 protected:显式锁定的非人格条目(如授权)不属于人设。
 */
export function isPersonaMergeCandidate(e: { type: MemoryEntry['type']; content: string; tags?: string[]; protected?: boolean }): boolean {
  if (isPersonaClassified(e)) return true
  if (e.type === 'preference') return STYLE_RE.test(e.content)
  return false
}

/** 行归一化(去重/包含判定用):去列表符号、折叠空白、小写 */
function normalizeLine(line: string): string {
  return String(line ?? '')
    .replace(/^\s*[-*•]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** notes 文本 → 去空行数组 */
export function splitNoteLines(notes?: string): string[] {
  return String(notes ?? '')
    .split(/\n/)
    .map((l) => l.replace(/^\s*[-*•]\s*/, '').trim())
    .filter(Boolean)
}

/** 深拷贝风格档(防止调用方误改内存态) */
function cloneStyle(style?: PersonaStyle): PersonaStyle | undefined {
  if (!style) return undefined
  return {
    ...style,
    particles: style.particles ? [...style.particles] : undefined,
    bannedPhrases: style.bannedPhrases ? [...style.bannedPhrases] : undefined,
    examples: style.examples ? style.examples.map((e) => ({ ...e })) : undefined,
    antiExamples: style.antiExamples ? [...style.antiExamples] : undefined,
  }
}

/** 人格卡深拷贝(store 对外只给副本;内部写盘才动真对象) */
function cloneCard(card: PersonaCard): PersonaCard {
  return { ...card, style: cloneStyle(card.style) }
}

/** 字符串列表规范化(兼容工具传字符串:逗号/顿号/空白分隔) */
function styleList(raw: unknown, maxItems: number, maxChars: number): string[] | undefined {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[,，、\s]+/)
      : []
  const out: string[] = []
  for (const item of list) {
    const s = String(item ?? '').trim().slice(0, maxChars)
    if (s && !out.includes(s)) out.push(s)
    if (out.length >= maxItems) break
  }
  return out.length > 0 ? out : undefined
}

/** 结构化风格档规范化(导入/工具/落盘共用;空对象返回 undefined) */
export function sanitizePersonaStyle(raw: unknown): PersonaStyle | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const str = (v: unknown, n = 200) => String(v ?? '').trim().slice(0, n)
  const style: PersonaStyle = {}
  const tone = str(r.tone)
  if (tone) style.tone = tone
  const sentence = str(r.sentence)
  if (sentence) style.sentence = sentence
  const address = str(r.address)
  if (address) style.address = address
  const particles = styleList(r.particles, 10, 10)
  if (particles) style.particles = particles
  if (r.emoji === 'none' || r.emoji === 'rare' || r.emoji === 'normal') style.emoji = r.emoji
  if (r.listPolicy === 'never' || r.listPolicy === 'task-only') style.listPolicy = r.listPolicy
  const max = Number(r.maxSentences)
  if (Number.isFinite(max)) style.maxSentences = Math.min(10, Math.max(1, Math.round(max)))
  const banned = styleList(r.bannedPhrases, 30, 30)
  if (banned) style.bannedPhrases = banned
  if (Array.isArray(r.examples)) {
    const examples: PersonaStyleExample[] = []
    for (const item of r.examples) {
      if (!item || typeof item !== 'object') continue
      const ex = item as Record<string, unknown>
      const user = str(ex.user, 200)
      const assistant = str(ex.assistant, 300)
      if (user && assistant) examples.push({ user, assistant })
      if (examples.length >= 6) break
    }
    if (examples.length > 0) style.examples = examples
  }
  const anti = styleList(r.antiExamples, 6, 300)
  if (anti) style.antiExamples = anti
  return Object.keys(style).length > 0 ? style : undefined
}

/** 从近 30 条对话里抽出、合并进整合区的性格行 */
export interface PersonaTraitLine {
  label: string
  detail: string
}

const TRAIT_NOTE = /^(?:性格|特质)\s*[:：]\s*(.+)$/

/** 性格建议的统一写法,叙事层只认这一行 */
export function formatTraitNote(label: string, detail: string): string {
  const name = String(label ?? '').trim().slice(0, 12)
  const how = String(detail ?? '').trim().slice(0, 80)
  if (!name) return ''
  return how ? `性格:${name}——${how}` : `性格:${name}`
}

function parseTraitBody(body: string): PersonaTraitLine | null {
  const text = String(body ?? '').trim()
  if (!text) return null
  const split = text.match(/^(.{1,12}?)(?:——|--|—|–)\s*(.+)$/)
  if (split) {
    const label = split[1].trim()
    const detail = split[2].trim().replace(/[）)]$/, '')
    if (label.length >= 2) return { label: label.slice(0, 12), detail: detail.slice(0, 80) }
  }
  const paren = text.match(/^(.{1,12}?)[（(]\s*(.+?)[）)]?$/)
  if (paren) {
    const label = paren[1].trim()
    const detail = paren[2].trim()
    if (label.length >= 2) return { label: label.slice(0, 12), detail: detail.slice(0, 80) }
  }
  if (text.length >= 2 && text.length <= 12) return { label: text, detail: '' }
  return null
}

/** 整合区里的「性格:」行抽出来叙事,其余要点仍按原样保留 */
export function splitPersonaNotes(notes?: string): { traits: PersonaTraitLine[]; rest: string[] } {
  const traits: PersonaTraitLine[] = []
  const rest: string[] = []
  const seen = new Set<string>()
  for (const line of splitNoteLines(notes)) {
    const matched = line.match(TRAIT_NOTE)
    const trait = matched ? parseTraitBody(matched[1]) : null
    if (!trait) {
      rest.push(line)
      continue
    }
    const key = trait.label.toLowerCase().replace(/\s+/g, '')
    if (!key || seen.has(key)) continue
    seen.add(key)
    traits.push(trait)
  }
  return { traits, rest }
}

/** 把抽出的性格写成第二人称叙事,避免模型把性格当清单念出来 */
export function weaveTraitNarrative(name: string, traits: PersonaTraitLine[]): string {
  if (traits.length === 0) return ''
  const who = String(name ?? '').trim() || '岛灵'
  const labels = traits.map((t) => t.label).join('、')
  const scenes = traits
    .filter((t) => t.detail)
    .map((t) => `${t.label},体现在:${t.detail.replace(/[。！!？?；;]+$/g, '')}`)
  return [
    `你是「${who}」,近来说话里长出了这些性格:${labels}。`,
    scenes.length > 0 ? `${scenes.join('。')}。` : '',
    '这些已经是你的口气,不是清单。回答时自然带着,不要逐条宣布,也不要解释「我的性格是」。',
  ]
    .filter(Boolean)
    .join('')
}

/** 风格档 → 系统提示段(硬约束 + 正例 + 反例) */
export function formatPersonaStyleBlock(style?: PersonaStyle): string {
  if (!style) return ''
  const lines: string[] = []
  if (style.tone) lines.push(`- 语气:${style.tone}`)
  if (style.sentence) lines.push(`- 句式:${style.sentence}`)
  if (style.address) lines.push(`- 称呼/自称:${style.address}`)
  if (style.particles?.length) lines.push(`- 常用语气词:${style.particles.join('、')}`)
  if (style.emoji === 'none') lines.push('- 不出现任何 emoji')
  else if (style.emoji === 'rare') lines.push('- emoji 最多 0-1 个,没有也正常')
  if (style.listPolicy === 'never') lines.push('- 日常聊天绝对不列清单、不写标题、不总结、不分点')
  else if (style.listPolicy === 'task-only') lines.push('- 只有任务步骤可以分点;闲聊用连续口语')
  if (typeof style.maxSentences === 'number') lines.push(`- 日常聊天回复不超过 ${style.maxSentences} 句`)
  if (style.bannedPhrases?.length) lines.push(`- 禁用词句:${style.bannedPhrases.join('、')}`)
  lines.push('- 不客套、不反问"还需要我…"、不复述用户问题、不解释自己正在做什么')
  const parts: string[] = []
  if (lines.length > 0) {
    parts.push(
      '【说话方式(硬约束)】',
      '这是你的口气,做到就行,不要在回复里提到这些规则。',
      lines.join('\n'),
    )
  }
  if (style.examples?.length) {
    const ex = style.examples.map((e) => `用户:${e.user}\n你:${e.assistant}`).join('\n\n')
    parts.push('【说话正例(模仿语气与节奏,不要复制内容)】', ex)
  }
  if (style.antiExamples?.length) {
    parts.push('【反例(绝不要这样说)】', style.antiExamples.map((s) => `- ${s}`).join('\n'))
  }
  return parts.join('\n')
}

/**
 * 人格卡 → 系统提示词块(2026-10-26)
 * - 无激活卡 / id 失效 → 空串(静默跳过,不阻断对话);
 * - 先用第二人称把这张卡说成「你这个人」,再给手写提示词和说话方式;
 * - 整合区里的「性格:」行织进叙事,其余要点仍留在进化整合区;
 * - 整块超长截断。提示词原文不在这里改写。
 */
export function formatPersonaBlock(cards: PersonaCard[], activeId?: string): string {
  const id = String(activeId ?? '').trim()
  if (!id) return ''
  const card = cards.find((c) => c.id === id)
  if (!card) return ''
  const prompt = String(card.prompt ?? '').trim()
  const notes = String(card.notes ?? '').trim()
  const styleBlock = formatPersonaStyleBlock(card.style)
  const { traits, rest } = splitPersonaNotes(notes)
  const traitBlock = weaveTraitNarrative(card.name, traits)
  if (!prompt && !notes && !styleBlock) return ''
  const parts = [
    `【当前人格卡 · ${card.name}】`,
    `你就是「${card.name}」。下面是你这个人,不是一份待执行的说明书。`,
    '用这个人的口气说话:先有态度,再把事说完;不要解释设定,不要跳出角色,不要把规则念出来。',
    '说话风格与长期记忆冲突时,以这个人格为准;事实类记忆(用户资料、项目信息)仍然有效。',
    prompt,
  ].filter(Boolean)
  if (styleBlock) parts.push(styleBlock)
  if (traitBlock) parts.push('【你近来的性格】', traitBlock)
  if (rest.length > 0) {
    parts.push('【人格卡 · 进化整合区】', rest.map((line) => `- ${line}`).join('\n'))
  }
  let block = parts.join('\n')
  if (block.length > BLOCK_MAX) {
    block = block.slice(0, BLOCK_MAX) + '\n…(人格卡过长,已截断)'
  }
  return block
}

// ---------------------------------------------------------------------------
// 导入 / 导出(2026-10-25):设置页"快捷导入导出"的纯函数层
// ---------------------------------------------------------------------------

export interface PersonaExportBundle {
  format: 'island-persona-cards'
  /** 2 = 卡 + 缓冲区;1 = 只有卡(旧文件,导入时缓冲区为空) */
  version: 1 | 2
  exportedAt: string
  cards: PersonaCard[]
  /** 与 cards 对应的进化缓冲区(待处理 / 已合并 / 已撤销都保留) */
  buffer: PersonaBufferItem[]
}

/**
 * 导出包(ids 缺省 = 全部;未知 id 忽略)。
 * buffer 只带上本次导出的卡;不传则缓冲区为空数组(旧调用方仍可只导卡)。
 */
export function normalizePersonaExport(
  cards: PersonaCard[],
  ids?: string[],
  buffer?: PersonaBufferItem[],
): PersonaExportBundle {
  const wanted = Array.isArray(ids) && ids.length > 0 ? new Set(ids.map(String)) : null
  const exported = cards.filter((c) => !wanted || wanted.has(c.id))
  const cardIds = new Set(exported.map((c) => c.id))
  return {
    format: 'island-persona-cards',
    version: 2,
    exportedAt: new Date().toISOString(),
    cards: exported,
    buffer: (buffer ?? []).filter((item) => cardIds.has(item.cardId)).map((item) => ({ ...item })),
  }
}

/** 判断两张卡是不是同一份内容。同 id 时用它决定跳过还是另存。 */
export function personaContentKey(card: Pick<PersonaCard, 'name' | 'prompt' | 'notes' | 'style'>): string {
  return JSON.stringify({
    name: card.name,
    prompt: card.prompt,
    notes: card.notes ?? '',
    style: card.style ?? null,
  })
}

function cardText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** 单卡规范化(导入/落盘共用;非法返回 null) */
export function sanitizePersonaCard(raw: unknown): PersonaCard | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const nested = r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? (r.data as Record<string, unknown>) : null
  const name = cardText(r.name ?? r.title ?? r.cardName ?? r.char_name ?? nested?.name ?? nested?.char_name)
    .trim()
    .slice(0, MAX_PERSONA_NAME)
  if (!name) return null
  const now = Date.now()
  const prompt = cardText(
    r.prompt ?? r.systemPrompt ?? r.description ?? r.personality ?? nested?.description ?? nested?.personality ?? nested?.prompt,
  ).trim().slice(0, MAX_PERSONA_PROMPT)
  const notes = String(r.notes ?? '').trim().slice(0, MAX_PERSONA_NOTES)
  return {
    id: typeof r.id === 'string' && r.id ? r.id : randomUUID(),
    name,
    prompt,
    notes,
    style: sanitizePersonaStyle(r.style),
    createdAt: typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : now,
    updatedAt: typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) ? r.updatedAt : now,
  }
}

function personaCardList(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  if (Array.isArray(row.cards)) return row.cards
  if (Array.isArray(row.personas)) return row.personas
  // 单张卡,或角色卡包 { data: { name, description } }
  const nested = row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? (row.data as Record<string, unknown>) : null
  const named =
    typeof row.name === 'string' ||
    typeof row.title === 'string' ||
    typeof row.cardName === 'string' ||
    typeof nested?.name === 'string'
  if (named) return [raw]
  return null
}

/**
 * 导入解析:兼容导出包 {cards:[...]}、裸数组、单张卡对象。
 * 字符串会再解析一次(文件被包成 JSON 字符串、或带 BOM)。
 * 一张都读不出来时带 error,避免界面把「导入 0 张」显示成成功。
 */
export function parsePersonaImport(raw: unknown): { cards: PersonaCard[]; skipped: number; error?: string } {
  let value = raw
  if (typeof value === 'string') {
    const text = value.replace(/^\uFEFF/, '').trim()
    if (!text) return { cards: [], skipped: 0, error: '文件是空的' }
    try {
      value = JSON.parse(text) as unknown
    } catch (err) {
      return { cards: [], skipped: 0, error: `JSON 无法解析:${err instanceof Error ? err.message : String(err)}` }
    }
  }
  const list = personaCardList(value)
  if (!list) return { cards: [], skipped: 0, error: '文件格式不正确:需要人格卡数组、{cards:[...]} 导出包,或带 name 的单张卡' }
  if (list.length === 0) return { cards: [], skipped: 0, error: '文件里没有人格卡' }
  const cards: PersonaCard[] = []
  let skipped = 0
  for (const item of list) {
    const card = sanitizePersonaCard(item)
    if (!card) skipped += 1
    else cards.push(card)
  }
  if (cards.length === 0) {
    return { cards: [], skipped, error: `没有可导入的人格卡:${skipped} 条缺少名称` }
  }
  return { cards, skipped }
}

/** 原子写 JSON。Windows 上目标已存在时 rename 会失败,这时改为覆盖原文件。 */
export async function writeJsonAtomic(filePath: string, payload: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.tmp`
  await fs.writeFile(tmp, payload, 'utf8')
  try {
    await fs.rename(tmp, filePath)
  } catch (err) {
    try {
      await fs.copyFile(tmp, filePath)
    } catch (copyErr) {
      await fs.unlink(tmp).catch(() => {})
      throw copyErr instanceof Error ? copyErr : err
    }
    await fs.unlink(tmp).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// 长期记忆 → 人格卡迁移(2026-10-26 用户定案:长期记忆不再保留「人格」分类)
// ---------------------------------------------------------------------------

export interface PersonaMemorySource {
  list(): Promise<Array<{ id: string; content: string; tags?: string[] }>>
  remove(id: string): Promise<number>
}

export interface PersonaNotesSink {
  appendNotes(
    id: string,
    lines: string[],
  ): Promise<{ card: PersonaCard | null; added: number; reason?: 'full' | 'duplicate' }>
}

/**
 * 把长期记忆里的人格分类条目(人设/人格/角色/岛灵标签或人设内容)并入
 * 当前激活人格卡的「进化整合区」,逐条写入成功后再从长期记忆删除:
 * - 无激活卡 → 一条都不删(宁可留着也不丢信息);
 * - 整合区满(12000 字硬顶)→ 该条保留在长期记忆,返回 reason='full';
 * - 内容已存在于整合区(duplicate)→ 视为已迁移,删除源条目。
 */
export async function migratePersonaMemoriesFromLongTerm(input: {
  memory: PersonaMemorySource
  personas: PersonaNotesSink
  activePersonaId?: string
}): Promise<{
  cardId: string
  cardName: string
  migrated: number
  kept: number
  reason?: 'no-card' | 'full'
}> {
  const id = String(input.activePersonaId ?? '').trim()
  const entries = await input.memory.list()
  const targets = entries.filter((e) => isPersonaClassified(e))
  if (!id) return { cardId: '', cardName: '', migrated: 0, kept: targets.length, reason: 'no-card' }
  const result = { cardId: id, cardName: '', migrated: 0, kept: 0, reason: undefined as 'full' | undefined }
  for (const e of targets) {
    const lines = e.content
      .split(/\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    const r = await input.personas.appendNotes(id, lines)
    if (!r.card) return { ...result, kept: targets.length - result.migrated, reason: 'no-card' }
    result.cardName = r.card.name
    if (r.reason === 'full') {
      result.kept += 1
      result.reason = 'full'
      continue
    }
    await input.memory.remove(e.id)
    result.migrated += 1
  }
  return result
}

// ---------------------------------------------------------------------------
// 存储
// ---------------------------------------------------------------------------

export function createPersonaStore(getPath: () => string) {
  let cards: PersonaCard[] = []
  let writeChain: Promise<void> = Promise.resolve()
  let loaded = false
  let loadPromise: Promise<void> | null = null

  function load() {
    if (loadPromise) return loadPromise
    loadPromise = (async () => {
      try {
        const raw = await fs.readFile(getPath(), 'utf8')
        const data = JSON.parse(raw) as { cards?: unknown }
        if (Array.isArray(data.cards)) {
          cards = data.cards
            .map((c) => sanitizePersonaCard(c))
            .filter((c): c is PersonaCard => !!c)
            .slice(0, MAX_PERSONA_CARDS)
        }
      } catch {
        cards = []
      }
      loaded = true
    })().finally(() => {
      loadPromise = null
    })
    return loadPromise
  }

  /** 串行原子写。返回的 Promise 会在失败时拒绝;队列本身吞掉错误以便下一笔继续写。 */
  function scheduleWrite(): Promise<void> {
    const payload = JSON.stringify({ cards }, null, 2)
    const job = writeChain.then(() => writeJsonAtomic(getPath(), payload))
    writeChain = job.catch((err) => {
      console.warn('[persona] 人格卡落盘失败:', err instanceof Error ? err.message : err)
    })
    return job
  }

  async function ensureLoaded() {
    if (loaded) return
    await load()
  }

  function sorted(): PersonaCard[] {
    return [...cards].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  return {
    async list(): Promise<PersonaCard[]> {
      await ensureLoaded()
      return sorted().map(cloneCard)
    },
    async get(id: string): Promise<PersonaCard | null> {
      await ensureLoaded()
      const card = cards.find((c) => c.id === id)
      return card ? cloneCard(card) : null
    },
    async upsert(input: {
      id?: string
      name: string
      prompt: string
      notes?: string
      style?: PersonaStyle | null
    }): Promise<PersonaCard> {
      await ensureLoaded()
      const name = String(input.name ?? '').trim().slice(0, MAX_PERSONA_NAME)
      if (!name) throw new Error('人格卡名称不能为空')
      const prompt = String(input.prompt ?? '').trim().slice(0, MAX_PERSONA_PROMPT)
      const now = Date.now()
      const id = String(input.id ?? '').trim()
      const existing = id ? cards.find((c) => c.id === id) : undefined
      // notes 缺省 = 保留原值(设置页编辑提示词时不清空进化整合区)
      const notes = (input.notes === undefined ? (existing?.notes ?? '') : String(input.notes))
        .trim()
        .slice(0, MAX_PERSONA_NOTES)
      // style 缺省 = 保留原值;null = 显式清空;对象 = 规范化后整体替换
      const style =
        input.style === undefined
          ? existing?.style
          : input.style === null
            ? undefined
            : sanitizePersonaStyle(input.style)
      if (existing) {
        existing.name = name
        existing.prompt = prompt
        existing.notes = notes
        existing.style = style
        existing.updatedAt = now
        scheduleWrite()
        return cloneCard(existing)
      }
      if (cards.length >= MAX_PERSONA_CARDS) {
        // 超限:淘汰最旧(按 updatedAt),新卡总是保留
        const oldest = [...cards].sort((a, b) => a.updatedAt - b.updatedAt)[0]
        if (oldest) cards = cards.filter((c) => c.id !== oldest.id)
      }
      const card: PersonaCard = {
        id: id || randomUUID(),
        name,
        prompt,
        notes,
        style,
        createdAt: now,
        updatedAt: now,
      }
      cards.push(card)
      scheduleWrite()
      return cloneCard(card)
    },
    async remove(id: string): Promise<number> {
      await ensureLoaded()
      const before = cards.length
      cards = cards.filter((c) => c.id !== id)
      const removed = before - cards.length
      if (removed > 0) scheduleWrite()
      return removed
    },
    /** 清空进化整合区(prompt 不动) */
    async clearNotes(id: string): Promise<PersonaCard | null> {
      await ensureLoaded()
      const card = cards.find((c) => c.id === id)
      if (!card) return null
      card.notes = ''
      card.updatedAt = Date.now()
      scheduleWrite()
      return cloneCard(card)
    },
    /** 整体写回整合区(缓冲区撤销合并用;prompt/style 不动) */
    async setNotes(id: string, notes: string): Promise<PersonaCard | null> {
      await ensureLoaded()
      const card = cards.find((c) => c.id === id)
      if (!card) return null
      card.notes = String(notes ?? '').trim().slice(0, MAX_PERSONA_NOTES)
      card.updatedAt = Date.now()
      scheduleWrite()
      return cloneCard(card)
    },
    /**
     * 追加进化整合区(按行去重;超出 12000 硬顶时整批不写,宁可不整合
     * 也不截断——调用方据此决定是否删除源记忆)。返回实际新增行数。
     */
    async appendNotes(
      id: string,
      lines: string[],
    ): Promise<{ card: PersonaCard | null; added: number; reason?: 'full' | 'duplicate' }> {
      await ensureLoaded()
      const card = cards.find((c) => c.id === id)
      if (!card) return { card: null, added: 0 }
      const existing = splitNoteLines(card.notes)
      const seen = new Set(existing.map(normalizeLine))
      const fresh: string[] = []
      for (const raw of lines) {
        const line = String(raw ?? '').replace(/^\s*[-*•]\s*/, '').trim()
        if (!line) continue
        const n = normalizeLine(line)
        if (!n || seen.has(n)) continue
        seen.add(n)
        fresh.push(line)
      }
      if (fresh.length === 0) return { card: cloneCard(card), added: 0, reason: 'duplicate' }
      const next = [...existing.map((l) => `- ${l}`), ...fresh.map((l) => `- ${l}`)].join('\n')
      // 超限整批不写(宁可不整合也不截断);调用方据 reason 不删除源记忆
      if (next.length > MAX_PERSONA_NOTES) return { card: cloneCard(card), added: 0, reason: 'full' }
      card.notes = next
      card.updatedAt = Date.now()
      scheduleWrite()
      return { card: cloneCard(card), added: fresh.length }
    },
    /** 整组替换(进化快照回滚用) */
    async replaceAll(next: PersonaCard[]): Promise<PersonaCard[]> {
      await ensureLoaded()
      cards = next
        .map((c) => sanitizePersonaCard(c))
        .filter((c): c is PersonaCard => !!c)
        .slice(0, MAX_PERSONA_CARDS)
      scheduleWrite()
      return sorted().map(cloneCard)
    },
    /**
     * 导入合并。
     * 同 id 且名称/提示词/整合区/风格都相同才跳过。
     * 同 id 但内容不同则换新 id 另存一张(idMap 记下旧 id → 新 id,缓冲区跟着新卡走)。
     * 不同 id 但 name+prompt 相同仍视为重复。同名不同内容追加「(导入)」。
     */
    async importCards(next: PersonaCard[]): Promise<{ imported: number; skipped: number; idMap: Record<string, string> }> {
      await ensureLoaded()
      const byId = new Map(cards.map((c) => [c.id, c]))
      const seenKeys = new Set(cards.map((c) => `${c.name}\n${c.prompt}`))
      const usedNames = new Set(cards.map((c) => c.name))
      const fresh: PersonaCard[] = []
      const idMap: Record<string, string> = {}
      let skipped = 0
      for (const raw of next) {
        const card = sanitizePersonaCard(raw)
        if (!card) {
          skipped += 1
          continue
        }
        const occupied = byId.get(card.id)
        if (occupied && personaContentKey(occupied) === personaContentKey(card)) {
          skipped += 1
          continue
        }
        if (occupied) {
          const previousId = card.id
          card.id = randomUUID()
          idMap[previousId] = card.id
        } else if (seenKeys.has(`${card.name}\n${card.prompt}`)) {
          skipped += 1
          continue
        }
        if (usedNames.has(card.name)) {
          let n = 2
          let name = `${card.name} (导入)`
          while (usedNames.has(name) && n < 100) name = `${card.name} (导入${n++})`
          card.name = name.slice(0, MAX_PERSONA_NAME)
        }
        card.updatedAt = Date.now()
        byId.set(card.id, card)
        seenKeys.add(`${card.name}\n${card.prompt}`)
        usedNames.add(card.name)
        fresh.push(card)
      }
      const kept = fresh.slice(0, MAX_PERSONA_CARDS)
      const truncated = fresh.length - kept.length
      const previous = cards
      const existingSorted = sorted()
      cards = [...kept, ...existingSorted].slice(0, MAX_PERSONA_CARDS)
      if (kept.length > 0) {
        try {
          await scheduleWrite()
        } catch (err) {
          cards = previous
          throw err instanceof Error ? err : new Error(String(err))
        }
      }
      return { imported: kept.length, skipped: skipped + truncated, idMap }
    },
  }
}

export type PersonaStore = ReturnType<typeof createPersonaStore>
