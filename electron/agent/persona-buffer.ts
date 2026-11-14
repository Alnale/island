/**
 * 人格卡进化缓冲区(2026-10-26)
 *
 * 记忆进化不再直接改人格卡:评审产生的 personaMerge 先进本缓冲区,
 * 主人在设置页按需「合并到人格卡」或「丢弃」。合并时:
 * - 建议要点追加到卡的 notes(提示词/prompt 永不改写);
 * - 源记忆从长期记忆移除,同时把源快照记进缓冲区,支持「撤销合并」
 *   (恢复 notes + 把删掉的记忆原样导回)。
 *
 * 独立文件 userData/persona-evolution.json;串行原子写。
 */

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type {
  MemoryEntry,
  PersonaBufferItem,
  PersonaBufferSource,
  PersonaBufferStoreLike,
  PersonaCard,
  PersonaStyle,
} from './types'
import type { MemoryStoreLike } from './types'
import type { PersonaCardStoreLike } from './types'
import { MAX_PERSONA_NOTES, MAX_PERSONA_PROMPT, sanitizePersonaStyle, splitNoteLines, writeJsonAtomic } from './persona'

const MAX_BUFFER_ITEMS = 50
const MAX_SOURCES = 50

/** 风格档副本(缓冲区落盘前不与调用方共享引用) */
function cloneStyleForBuffer(style?: PersonaStyle): PersonaStyle | undefined {
  if (!style) return undefined
  return {
    ...style,
    particles: style.particles ? [...style.particles] : undefined,
    bannedPhrases: style.bannedPhrases ? [...style.bannedPhrases] : undefined,
    examples: style.examples ? style.examples.map((e) => ({ ...e })) : undefined,
    antiExamples: style.antiExamples ? [...style.antiExamples] : undefined,
  }
}

function sanitizeSource(raw: unknown): PersonaBufferSource | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const content = String(r.content ?? '').trim().slice(0, 500)
  if (!content) return null
  return {
    id: typeof r.id === 'string' && r.id ? r.id : randomUUID(),
    content,
    type: ['preference', 'fact', 'workflow', 'lesson'].includes(String(r.type))
      ? (r.type as MemoryEntry['type'])
      : 'fact',
    tags: Array.isArray(r.tags) ? r.tags.map(String).slice(0, 8) : undefined,
    source: ['manual', 'agent', 'evolution'].includes(String(r.source))
      ? (r.source as MemoryEntry['source'])
      : undefined,
    protected: r.protected === true,
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : Date.now(),
  }
}

function bufferKind(raw: unknown): 'memory' | 'style' | 'trait' {
  if (raw === 'style') return 'style'
  if (raw === 'trait') return 'trait'
  return 'memory'
}

/** 单条缓冲区记录规范化 */
export function sanitizeBufferItem(raw: unknown): PersonaBufferItem | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const cardId = String(r.cardId ?? '').trim()
  const notes = String(r.notes ?? '').trim().slice(0, MAX_PERSONA_NOTES)
  if (!cardId) return null
  const sources = Array.isArray(r.sources)
    ? r.sources.map((s) => sanitizeSource(s)).filter((s): s is PersonaBufferSource => !!s).slice(0, MAX_SOURCES)
    : []
  const rawPatch = r.cardPatch && typeof r.cardPatch === 'object' ? (r.cardPatch as Record<string, unknown>) : null
  const patchPrompt = rawPatch ? String(rawPatch.prompt ?? '').trim().slice(0, MAX_PERSONA_PROMPT) : ''
  const patchStyle = rawPatch ? sanitizePersonaStyle(rawPatch.style) : undefined
  if (!notes && !patchPrompt && !patchStyle) return null
  return {
    id: typeof r.id === 'string' && r.id ? r.id : randomUUID(),
    kind: bufferKind(r.kind),
    cardId,
    cardName: String(r.cardName ?? '').trim().slice(0, 60) || '(未命名人格卡)',
    notes,
    sourceIds: sources.map((s) => s.id),
    sources,
    ...(patchPrompt || patchStyle
      ? { cardPatch: { ...(patchPrompt ? { prompt: patchPrompt } : {}), ...(patchStyle ? { style: patchStyle } : {}) } }
      : {}),
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
    evolutionVersion: Number.isInteger(r.evolutionVersion) ? Number(r.evolutionVersion) : undefined,
    mergedAt: typeof r.mergedAt === 'number' ? r.mergedAt : undefined,
    beforeNotes: typeof r.beforeNotes === 'string' ? r.beforeNotes : undefined,
    beforePrompt: typeof r.beforePrompt === 'string' ? r.beforePrompt : undefined,
    beforeStyle: sanitizePersonaStyle(r.beforeStyle),
    afterNotes: typeof r.afterNotes === 'string' ? r.afterNotes : undefined,
    afterPrompt: typeof r.afterPrompt === 'string' ? r.afterPrompt : undefined,
    afterStyle: sanitizePersonaStyle(r.afterStyle),
    removed: Array.isArray(r.removed)
      ? r.removed.map((s) => sanitizeSource(s)).filter((s): s is PersonaBufferSource => !!s)
      : undefined,
    undoneAt: typeof r.undoneAt === 'number' ? r.undoneAt : undefined,
  }
}

export function createPersonaBufferStore(getPath: () => string): PersonaBufferStoreLike {
  let items: PersonaBufferItem[] = []
  let writeChain: Promise<void> = Promise.resolve()
  let loaded = false
  let loadPromise: Promise<void> | null = null

  function load() {
    if (loadPromise) return loadPromise
    loadPromise = (async () => {
      try {
        const raw = await fs.readFile(getPath(), 'utf8')
        const data = JSON.parse(raw) as { items?: unknown }
        if (Array.isArray(data.items)) {
          items = data.items
            .map((i) => sanitizeBufferItem(i))
            .filter((i): i is PersonaBufferItem => !!i)
            .slice(0, MAX_BUFFER_ITEMS)
        }
      } catch {
        items = []
      }
      loaded = true
    })().finally(() => {
      loadPromise = null
    })
    return loadPromise
  }

  function scheduleWrite(): Promise<void> {
    const payload = JSON.stringify({ items }, null, 2)
    const job = writeChain.then(() => writeJsonAtomic(getPath(), payload))
    writeChain = job.catch((err) => {
      console.warn('[persona] 缓冲区落盘失败:', err instanceof Error ? err.message : err)
    })
    return job
  }

  async function ensureLoaded() {
    if (loaded) return
    await load()
  }

  return {
    async list(): Promise<PersonaBufferItem[]> {
      await ensureLoaded()
      return [...items].sort((a, b) => b.createdAt - a.createdAt)
    },
    async add(input) {
      await ensureLoaded()
      const kind = bufferKind(input.kind)
      const sources = (input.sources ?? [])
        .map((s) => sanitizeSource(s))
        .filter((s): s is PersonaBufferSource => !!s)
        .slice(0, MAX_SOURCES)
      const notes = String(input.notes ?? '').trim().slice(0, MAX_PERSONA_NOTES)
      const patchInput = input.cardPatch
      const patchPrompt = String(patchInput?.prompt ?? '').trim().slice(0, MAX_PERSONA_PROMPT)
      const patchStyle = sanitizePersonaStyle(patchInput?.style)
      const cardPatch =
        patchPrompt || patchStyle
          ? { ...(patchPrompt ? { prompt: patchPrompt } : {}), ...(patchStyle ? { style: patchStyle } : {}) }
          : undefined
      if (!notes && !cardPatch) throw new Error('人格卡建议为空')
      // 同一张卡 + 同类型已有待处理建议 → 合并去重,避免进化/评审反复跑产生多条
      const pending = items.find(
        (i) => !i.mergedAt && !i.undoneAt && i.cardId === String(input.cardId) && (i.kind ?? 'memory') === kind,
      )
      if (pending) {
        const seen = new Set<string>()
        const mergedLines: string[] = []
        for (const line of [...splitNoteLines(pending.notes), ...splitNoteLines(notes)]) {
          const key = line.toLowerCase().replace(/\s+/g, '')
          if (!key || seen.has(key)) continue
          const nextLen = mergedLines.reduce((n, l) => n + l.length + 3, 0) + line.length
          if (nextLen > MAX_PERSONA_NOTES) continue
          seen.add(key)
          mergedLines.push(line)
        }
        const sourceMap = new Map<string, PersonaBufferSource>()
        for (const s of [...pending.sources, ...sources]) sourceMap.set(s.id, s)
        pending.notes = mergedLines.map((l) => `- ${l}`).join('\n')
        pending.sources = [...sourceMap.values()].slice(0, MAX_SOURCES)
        pending.sourceIds = pending.sources.map((s) => s.id)
        if (cardPatch) pending.cardPatch = cardPatch
        pending.createdAt = Date.now()
        if (typeof input.evolutionVersion === 'number') pending.evolutionVersion = input.evolutionVersion
        scheduleWrite()
        return { ...pending }
      }
      const item: PersonaBufferItem = {
        id: randomUUID(),
        kind,
        cardId: String(input.cardId),
        cardName: String(input.cardName ?? '').trim().slice(0, 60) || '(未命名人格卡)',
        notes: String(input.notes ?? '').trim().slice(0, MAX_PERSONA_NOTES),
        sourceIds: sources.map((s) => s.id),
        sources,
        cardPatch,
        createdAt: Date.now(),
        evolutionVersion: input.evolutionVersion,
      }
      // 风格建议没有源记忆;记忆整合可只带人格卡提案
      if (!item.notes && !item.cardPatch) throw new Error('人格卡建议为空')
      items.unshift(item)
      items = items.slice(0, MAX_BUFFER_ITEMS)
      scheduleWrite()
      return { ...item }
    },
    async remove(id: string): Promise<number> {
      await ensureLoaded()
      const before = items.length
      items = items.filter((i) => i.id !== id)
      const n = before - items.length
      if (n > 0) scheduleWrite()
      return n
    },
    async markMerged(id, patch) {
      await ensureLoaded()
      const item = items.find((i) => i.id === id)
      if (!item) return null
      item.mergedAt = Date.now()
      item.beforeNotes = String(patch.beforeNotes ?? '').slice(0, MAX_PERSONA_NOTES)
      item.beforePrompt = String(patch.beforePrompt ?? '').slice(0, MAX_PERSONA_PROMPT)
      item.beforeStyle = sanitizePersonaStyle(patch.beforeStyle) ? cloneStyleForBuffer(patch.beforeStyle) : undefined
      item.afterNotes = String(patch.afterNotes ?? '').slice(0, MAX_PERSONA_NOTES)
      item.afterPrompt = String(patch.afterPrompt ?? '').slice(0, MAX_PERSONA_PROMPT)
      item.afterStyle = cloneStyleForBuffer(patch.afterStyle)
      item.removed = patch.removed
      item.undoneAt = undefined
      scheduleWrite()
      return { ...item }
    },
    async markUndone(id) {
      await ensureLoaded()
      const item = items.find((i) => i.id === id)
      if (!item) return null
      item.undoneAt = Date.now()
      scheduleWrite()
      return { ...item }
    },
    /** 进化回滚到更早版本时,清掉之后尚未合并的建议(已合并保留撤销记录) */
    async removeAfterVersion(version: number): Promise<number> {
      await ensureLoaded()
      const before = items.length
      items = items.filter((i) => {
        if (typeof i.evolutionVersion !== 'number') return false
        if (i.mergedAt) return true
        return i.evolutionVersion <= version
      })
      const n = before - items.length
      if (n > 0) scheduleWrite()
      return n
    },
    async clear(): Promise<void> {
      await ensureLoaded()
      items = []
      scheduleWrite()
    },
    /** 导入导出包中的缓冲区。保留原 id、合并/撤销状态;同 id 或非法条目跳过。 */
    async importItems(next: PersonaBufferItem[]): Promise<{ imported: number; skipped: number }> {
      await ensureLoaded()
      const previous = items
      const seen = new Set(items.map((i) => i.id))
      const fresh: PersonaBufferItem[] = []
      let skipped = 0
      for (const raw of next) {
        const item = sanitizeBufferItem(raw)
        if (!item || seen.has(item.id) || previous.length + fresh.length >= MAX_BUFFER_ITEMS) {
          skipped += 1
          continue
        }
        seen.add(item.id)
        fresh.push(item)
      }
      if (fresh.length === 0) return { imported: 0, skipped }
      items = [...previous, ...fresh]
      try {
        await scheduleWrite()
      } catch (err) {
        items = previous
        throw err instanceof Error ? err : new Error(String(err))
      }
      return { imported: fresh.length, skipped }
    },
  }
}

/**
 * 风格评审的补丁只追加禁用词和反例。
 * 语气、句式、emoji、正例等主人已经写好的字段保持原样。
 */
export function extendPersonaStyle(base: PersonaStyle | undefined, patch: PersonaStyle | undefined): PersonaStyle | undefined {
  if (!patch && !base) return undefined
  const union = (a: string[] | undefined, b: string[] | undefined, max: number) => {
    const out: string[] = []
    const seen = new Set<string>()
    for (const item of [...(a ?? []), ...(b ?? [])]) {
      const s = String(item ?? '').trim()
      const key = s.toLowerCase().replace(/\s+/g, '')
      if (!s || !key || seen.has(key)) continue
      seen.add(key)
      out.push(s)
      if (out.length >= max) break
    }
    return out
  }
  const next: PersonaStyle = base
    ? {
        ...base,
        particles: base.particles ? [...base.particles] : undefined,
        bannedPhrases: base.bannedPhrases ? [...base.bannedPhrases] : undefined,
        examples: base.examples ? base.examples.map((e) => ({ ...e })) : undefined,
        antiExamples: base.antiExamples ? [...base.antiExamples] : undefined,
      }
    : {}
  const banned = union(base?.bannedPhrases, patch?.bannedPhrases, 30)
  const anti = union(base?.antiExamples, patch?.antiExamples, 6)
  if (banned.length) next.bannedPhrases = banned
  else delete next.bannedPhrases
  if (anti.length) next.antiExamples = anti
  else delete next.antiExamples
  return sanitizePersonaStyle(next)
}

/** 从导出包取出缓冲区(无 buffer 字段 = 旧文件,返回空列表) */
export function parsePersonaBufferImport(raw: unknown): { items: PersonaBufferItem[]; skipped: number } {
  const list =
    raw && typeof raw === 'object' && Array.isArray((raw as { buffer?: unknown }).buffer)
      ? (raw as { buffer: unknown[] }).buffer
      : []
  const items: PersonaBufferItem[] = []
  let skipped = 0
  for (const item of list) {
    const sanitized = sanitizeBufferItem(item)
    if (!sanitized) skipped += 1
    else items.push(sanitized)
  }
  return { items, skipped }
}

/**
 * 把导出包里的缓冲区挂回导入后的卡。
 * 同 id 的卡直接沿用;name+prompt 已存在但 id 不同时,改挂到现有卡上。
 * 对不上任何导入卡的条目计入 skipped。
 */
export function planPersonaBufferImport(
  existing: Array<Pick<PersonaCard, 'id' | 'name' | 'prompt'>>,
  incoming: Array<Pick<PersonaCard, 'id' | 'name' | 'prompt'>>,
  buffer: PersonaBufferItem[],
): { items: PersonaBufferItem[]; skipped: number } {
  const byId = new Set(existing.map((c) => c.id))
  const byKey = new Map(existing.map((c) => [`${c.name}\n${c.prompt}`, c.id]))
  const idMap = new Map<string, string>()
  for (const card of incoming) {
    if (byId.has(card.id)) {
      idMap.set(card.id, card.id)
      continue
    }
    idMap.set(card.id, byKey.get(`${card.name}\n${card.prompt}`) ?? card.id)
  }
  const items: PersonaBufferItem[] = []
  let skipped = 0
  for (const item of buffer) {
    const nextId = idMap.get(item.cardId)
    if (!nextId) {
      skipped += 1
      continue
    }
    items.push(nextId === item.cardId ? item : { ...item, cardId: nextId })
  }
  return { items, skipped }
}

/**
 * 同 id 内容不同而另存的卡,缓冲区改挂到新 id,条目也换新 id。
 * 否则旧缓冲条目的 id 已在库里,会被当成重复丢掉,新卡就没有这份记录。
 */
export function retargetImportedBuffer(
  items: PersonaBufferItem[],
  idMap: Record<string, string> | undefined,
): PersonaBufferItem[] {
  if (!idMap || Object.keys(idMap).length === 0) return items
  return items.map((item) => {
    const nextCard = idMap[item.cardId]
    if (!nextCard) return item
    return { ...item, id: randomUUID(), cardId: nextCard }
  })
}

export type PersonaBufferStore = ReturnType<typeof createPersonaBufferStore>

// ---------------------------------------------------------------------------
// 合并 / 撤销(主进程 IPC 与测试共用)
// ---------------------------------------------------------------------------

export interface MergeBufferResult {
  ok: boolean
  error?: string
  item?: PersonaBufferItem
  added?: number
  removed?: number
}

/** 把缓冲区建议合并进人格卡:先追加 notes,再删源记忆,并记录撤销所需快照 */
export async function mergePersonaBufferItem(
  item: PersonaBufferItem,
  personaStore: PersonaCardStoreLike,
  memoryStore: MemoryStoreLike,
  bufferStore: PersonaBufferStoreLike,
): Promise<MergeBufferResult> {
  if (item.mergedAt && !item.undoneAt) return { ok: false, error: '该建议已经合并过了' }
  if (item.undoneAt) return { ok: false, error: '该建议已撤销,不能重复合并' }
  const card = await personaStore.get(item.cardId)
  if (!card) return { ok: false, error: '目标人格卡不存在' }
  const beforeNotes = String(card.notes ?? '')
  const beforePrompt = String(card.prompt ?? '')
  const beforeStyle = cloneStyleForBuffer(card.style)
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '')
  const existing = splitNoteLines(card.notes)
  const seen = new Set(existing.map(norm))
  const freshLines: string[] = []
  for (const line of splitNoteLines(item.notes)) {
    const k = norm(line)
    if (!k || seen.has(k)) continue
    seen.add(k)
    freshLines.push(line)
  }
  if (freshLines.length > 0) {
    const projected = [...existing.map((l) => `- ${l}`), ...freshLines.map((l) => `- ${l}`)].join('\n')
    if (projected.length > MAX_PERSONA_NOTES) {
      return { ok: false, error: '人格卡整合区已满,请先清空或精简' }
    }
  }
  const patchPrompt = item.cardPatch?.prompt
  const patchStyle = item.cardPatch?.style
  // 风格评审只追加禁用词/反例;记忆进化的提案仍整体替换 style
  const nextStyle = item.kind === 'style' && patchStyle ? extendPersonaStyle(beforeStyle, patchStyle) : patchStyle
  const promptChanged = typeof patchPrompt === 'string' && patchPrompt !== beforePrompt
  const styleChanged = !!nextStyle && JSON.stringify(nextStyle) !== JSON.stringify(beforeStyle ?? null)
  if (freshLines.length === 0 && !promptChanged && !styleChanged) {
    return { ok: false, error: '建议与当前人格卡一致,无需合并' }
  }
  // 先把人格卡内容提案落到卡上(提示词/风格);notes 随后追加
  if (promptChanged || styleChanged) {
    await personaStore.upsert({
      id: item.cardId,
      name: card.name,
      prompt: typeof patchPrompt === 'string' ? patchPrompt : beforePrompt,
      style: styleChanged ? (nextStyle ?? null) : (beforeStyle ?? null),
      notes: beforeNotes,
    })
  }
  if (freshLines.length > 0) {
    const appended = await personaStore.appendNotes(item.cardId, freshLines)
    if (appended.added === 0) {
      return {
        ok: false,
        error: appended.reason === 'full' ? '人格卡整合区已满' : '这些要点已经全部存在,无需重复合并',
      }
    }
  }
  const afterCard = await personaStore.get(item.cardId)
  // 只删除"内容仍是建议时快照"的源条目:若主人中途改过内容,保留新内容
  const current = await memoryStore.list()
  const currentById = new Map(current.map((e) => [e.id, e]))
  const removed: PersonaBufferSource[] = []
  for (const source of item.sources) {
    const now = currentById.get(source.id)
    if (!now || now.content !== source.content) continue
    const n = await memoryStore.remove(source.id)
    if (n > 0) removed.push(source)
  }
  const next = await bufferStore.markMerged(item.id, {
    beforeNotes,
    beforePrompt,
    beforeStyle,
    afterNotes: String(afterCard?.notes ?? ''),
    afterPrompt: String(afterCard?.prompt ?? ''),
    afterStyle: afterCard?.style,
    removed,
  })
  return { ok: true, item: next ?? undefined, added: freshLines.length, removed: removed.length }
}

/** 撤销一次已合并的建议:恢复合并前 notes + 把删掉的记忆导回 */
export async function undoPersonaBufferItem(
  item: PersonaBufferItem,
  personaStore: PersonaCardStoreLike,
  memoryStore: MemoryStoreLike,
  bufferStore: PersonaBufferStoreLike,
): Promise<MergeBufferResult> {
  if (!item.mergedAt || item.undoneAt) return { ok: false, error: '该建议没有可撤销的合并' }
  const card = await personaStore.get(item.cardId)
  if (!card) return { ok: false, error: '目标人格卡不存在' }
  // 合并后若主人又改过 notes/提示词/风格,直接覆盖会吞掉后续修改 → 拒绝自动撤销
  if (item.afterNotes !== undefined && String(card.notes ?? '') !== item.afterNotes) {
    return { ok: false, error: '整合区在合并后已被修改,无法自动撤销;请先确认当前内容' }
  }
  if (item.afterPrompt !== undefined && String(card.prompt ?? '') !== item.afterPrompt) {
    return { ok: false, error: '人格提示词在合并后已被修改,无法自动撤销' }
  }
  if (item.afterStyle !== undefined && JSON.stringify(card.style ?? null) !== JSON.stringify(item.afterStyle)) {
    return { ok: false, error: '人格风格在合并后已被修改,无法自动撤销' }
  }
  await personaStore.upsert({
    id: item.cardId,
    name: card.name,
    prompt: item.beforePrompt ?? card.prompt,
    style: item.beforeStyle ?? null,
    notes: item.beforeNotes ?? '',
  })
  if (item.removed && item.removed.length > 0) {
    await memoryStore.importEntries(item.removed as MemoryEntry[])
  }
  const undone = await bufferStore.markUndone(item.id)
  return { ok: true, item: undone ?? undefined, removed: item.removed?.length ?? 0 }
}
