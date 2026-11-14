/**
 * 人格卡设置分区(2026-10-25;2026-10-26 UI 重排)
 *
 * 布局原则(用户反馈"非常混乱"):
 * 1. 顶部引导:三步说明 + 当前启用卡摘要;
 * 2. 基础提示词、进化缓冲区默认折叠,避免长文本占满首屏;
 * 3. 卡片列表只保留主操作(启用/编辑),导出/删除收进次级行;
 * 4. 新建/编辑表单独立面板,风格档分「基本 / 说话方式 / 正例与反例」
 *    渐进展开,不再与列表混排。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLeavingList } from '../../../hooks/useLeavingList'
import type {
  AgentConfig,
  AgentMessage,
  PersonaBufferItem,
  PersonaCard,
  PersonaStyle,
} from '../../../agent/types'

type Editor = { id?: string; name: string; prompt: string; style: StyleDraft }

type StyleDraft = {
  tone: string
  sentence: string
  address: string
  particles: string
  emoji: '' | 'none' | 'rare' | 'normal'
  listPolicy: '' | 'never' | 'task-only'
  maxSentences: string
  banned: string
  antiExamples: string
  examples: Array<{ user: string; assistant: string }>
}

export interface PersonaCardsViewProps {
  config: AgentConfig | null
  onSave: (patch: Partial<AgentConfig>) => void
  /** 当前窗口对话。不勾选时评审最近 30 条;勾选后只评审这些岛灵回复 */
  messages?: AgentMessage[]
}

const REVIEW_PICK_CAP = 30
const REVIEW_PICK_LIST = 60

function assistantPreview(message: AgentMessage): string {
  return message.parts
    .filter((part): part is Extract<AgentMessage['parts'][number], { type: 'text' }> => part.type === 'text')
    .map((part) => String(part.text ?? '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const DEFAULT_BANNED = '首先\n其次\n综上所述\n总的来说\n总而言之\n希望对你有帮助\n如果还有其他问题'

const TEMPLATES: Array<{ id: string; label: string }> = [
  { id: 'natural', label: '自然口语' },
  { id: 'gentle', label: '温柔' },
  { id: 'tsundere', label: '傲娇' },
  { id: 'cold', label: '冷淡' },
  { id: 'energetic', label: '元气' },
]

function templateStyle(id: string): StyleDraft {
  const base: StyleDraft = {
    tone: '',
    sentence: '',
    address: '',
    particles: '',
    emoji: 'rare',
    listPolicy: 'never',
    maxSentences: '3',
    banned: DEFAULT_BANNED,
    antiExamples: '当然可以!首先…其次…希望这对你有帮助。\n作为一个AI语言模型,我无法…',
    examples: [],
  }
  if (id === 'natural') return { ...base, tone: '松弛自然,像熟人聊天', sentence: '短句口语,少用书面连接词,不总结', particles: '啊、嘛、呗' }
  if (id === 'gentle') return { ...base, tone: '温柔耐心,不催促', sentence: '柔和短句,先回应情绪再说事', particles: '呀、呢、啦', maxSentences: '4' }
  if (id === 'tsundere') return { ...base, tone: '嘴硬心软,傲娇但不刻薄', sentence: '短句,关心藏在后半句', particles: '哼、才不是', emoji: 'none' }
  if (id === 'cold') return { ...base, tone: '冷静克制,情绪稳定', sentence: '简短直接,不寒暄', emoji: 'none', maxSentences: '2' }
  if (id === 'energetic') return { ...base, tone: '元气活泼,但不吵闹', sentence: '轻快短句,节奏明快', particles: '呀、啦、嘿', maxSentences: '4' }
  return base
}

function styleDraftOf(style?: PersonaStyle): StyleDraft {
  return {
    tone: style?.tone ?? '',
    sentence: style?.sentence ?? '',
    address: style?.address ?? '',
    particles: (style?.particles ?? []).join('、'),
    emoji: style?.emoji ?? '',
    listPolicy: style?.listPolicy ?? '',
    maxSentences: style?.maxSentences ? String(style.maxSentences) : '',
    banned: (style?.bannedPhrases ?? []).join('\n'),
    antiExamples: (style?.antiExamples ?? []).join('\n'),
    examples: (style?.examples ?? []).map((e) => ({ user: e.user, assistant: e.assistant })),
  }
}

function styleFromDraft(d: StyleDraft): PersonaStyle | undefined {
  const lines = (s: string) => s.split(/\n/).map((x) => x.trim()).filter(Boolean)
  const list = (s: string) => s.split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean)
  const style: PersonaStyle = {}
  if (d.tone.trim()) style.tone = d.tone.trim()
  if (d.sentence.trim()) style.sentence = d.sentence.trim()
  if (d.address.trim()) style.address = d.address.trim()
  const particles = list(d.particles)
  if (particles.length) style.particles = particles.slice(0, 10)
  if (d.emoji) style.emoji = d.emoji
  if (d.listPolicy) style.listPolicy = d.listPolicy
  const max = Number(d.maxSentences)
  if (Number.isFinite(max) && max > 0) style.maxSentences = Math.min(10, Math.max(1, Math.round(max)))
  const banned = lines(d.banned)
  if (banned.length) style.bannedPhrases = banned.slice(0, 30)
  const anti = lines(d.antiExamples)
  if (anti.length) style.antiExamples = anti.slice(0, 6)
  const examples = d.examples
    .map((e) => ({ user: e.user.trim(), assistant: e.assistant.trim() }))
    .filter((e) => e.user && e.assistant)
    .slice(0, 6)
  if (examples.length) style.examples = examples
  return Object.keys(style).length > 0 ? style : undefined
}

function errorOf(res: unknown): string {
  if (res && typeof res === 'object' && 'error' in res) return String((res as { error: unknown }).error)
  return ''
}

/** 岛体把 Enter/空格当成按钮激活,会吞掉文本域里的换行和空格。编辑时拦住冒泡。 */
function keepTextKeys(event: { key: string; stopPropagation: () => void }) {
  if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
}

function exportMessage(res: { path?: string; cards?: number; buffer?: number }): string {
  const cards = typeof res.cards === 'number' ? `${res.cards} 张人格卡` : '人格卡'
  const buffer = typeof res.buffer === 'number' ? `${res.buffer} 条缓冲区` : '缓冲区'
  return `已导出 ${cards}和 ${buffer}到 ${res.path ?? ''}`
}

function notesCount(card: PersonaCard): number {
  return String(card.notes ?? '').split('\n').filter((l) => l.trim()).length
}

function bufferStatus(item: PersonaBufferItem): 'pending' | 'merged' | 'undone' {
  if (item.undoneAt) return 'undone'
  if (item.mergedAt) return 'merged'
  return 'pending'
}

function bufferKindLabel(item: PersonaBufferItem): string {
  if (item.kind === 'style') return '风格建议'
  if (item.kind === 'trait') return '性格特征'
  return item.cardPatch ? '记忆整合 + 人格卡提案' : '记忆整合'
}

/** 折叠分区头(整行可点,箭头指示) */
function SectionHead({
  title,
  hint,
  open,
  onToggle,
  extra,
}: {
  title: string
  hint?: string
  open: boolean
  onToggle: () => void
  extra?: React.ReactNode
}) {
  return (
    <div
      className={`island-persona-section-head${open ? ' open' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onToggle()
        }
      }}
    >
      <span className="island-persona-section-caret">{open ? '▾' : '▸'}</span>
      <span className="island-persona-section-title">{title}</span>
      {hint ? <span className="island-persona-section-hint">{hint}</span> : null}
      {extra ? <span className="island-persona-section-extra">{extra}</span> : null}
    </div>
  )
}

export function PersonaCardsView({ config, onSave, messages }: PersonaCardsViewProps) {
  const [cards, setCards] = useState<PersonaCard[]>([])
  const [buffer, setBuffer] = useState<PersonaBufferItem[]>([])
  const [loading, setLoading] = useState(true)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [saving, setSaving] = useState(false)
  const [expandedNotes, setExpandedNotes] = useState<string | null>(null)
  const [notesEditing, setNotesEditing] = useState<{ id: string; text: string } | null>(null)
  const [notesSaving, setNotesSaving] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [basePrompt, setBasePrompt] = useState('')
  const [baseDirty, setBaseDirty] = useState(false)
  const [baseOpen, setBaseOpen] = useState(false)
  const [styleOpen, setStyleOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [bufferOpen, setBufferOpen] = useState(false)
  const [styleReviewing, setStyleReviewing] = useState(false)
  const [pickOpen, setPickOpen] = useState(false)
  const [pickedIds, setPickedIds] = useState<string[]>([])
  const baseDirtyRef = useRef(false)
  const leave = useLeavingList()

  const activeId = String(config?.activePersonaId ?? '')
  const evolveEnabled = config?.personaEvolveEnabled === true
  const activeCard = cards.find((c) => c.id === activeId) ?? null
  const assistantPicks = useMemo(() => {
    const rows: Array<{ id: string; text: string }> = []
    for (const message of messages ?? []) {
      if (message.role !== 'assistant' || !message.id) continue
      const text = assistantPreview(message)
      if (!text) continue
      rows.push({ id: message.id, text: text.slice(0, 72) })
    }
    return rows.slice(-REVIEW_PICK_LIST)
  }, [messages])

  useEffect(() => {
    const live = new Set(assistantPicks.map((row) => row.id))
    setPickedIds((prev) => {
      const next = prev.filter((id) => live.has(id))
      return next.length === prev.length ? prev : next
    })
  }, [assistantPicks])

  useEffect(() => {
    baseDirtyRef.current = baseDirty
  }, [baseDirty])

  useEffect(() => {
    if (!baseDirtyRef.current) setBasePrompt(config?.systemPrompt ?? '')
  }, [config?.systemPrompt])

  const refreshCards = useCallback(async () => {
    try {
      const list = await window.desktop?.agentPersonaGet?.()
      if (Array.isArray(list)) setCards(list as PersonaCard[])
    } catch {
      // 保留当前列表
    }
  }, [])

  const refreshBuffer = useCallback(async () => {
    try {
      const list = await window.desktop?.agentPersonaBufferGet?.()
      if (Array.isArray(list)) setBuffer(list as PersonaBufferItem[])
    } catch {
      // 保留当前列表
    }
  }, [])

  useEffect(() => {
    void (async () => {
      await Promise.all([refreshCards(), refreshBuffer()])
      setLoading(false)
    })()
  }, [refreshCards, refreshBuffer])

  const pendingBuffer = buffer.filter((i) => bufferStatus(i) === 'pending').length

  // 有新的待处理建议时自动展开缓冲区(用户仍可手动收起)
  useEffect(() => {
    if (pendingBuffer > 0) setBufferOpen(true)
  }, [pendingBuffer])

  useEffect(() => {
    const off = window.desktop?.onAgentEvent?.((event) => {
      const type = (event as { type?: string } | null)?.type
      if (type === 'evolution-done') {
        void refreshBuffer()
        void refreshCards()
      }
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [refreshBuffer, refreshCards])

  const openNew = () => {
    setErr('')
    setMsg('')
    setPendingDelete(null)
    setNotesEditing(null)
    setStyleOpen(false)
    setAdvancedOpen(false)
    setEditor({ name: '', prompt: '', style: templateStyle('natural') })
  }

  const openEdit = (card: PersonaCard) => {
    setErr('')
    setMsg('')
    setPendingDelete(null)
    setNotesEditing(null)
    setStyleOpen(false)
    setAdvancedOpen(false)
    setEditor({ id: card.id, name: card.name, prompt: card.prompt, style: styleDraftOf(card.style) })
  }

  const saveCard = async () => {
    if (!editor || saving) return
    const name = editor.name.trim()
    if (!name) {
      setErr('人格卡名称不能为空')
      return
    }
    setSaving(true)
    setErr('')
    try {
      const res = await window.desktop?.agentPersonaSet?.({
        upsert: { id: editor.id, name, prompt: editor.prompt, style: styleFromDraft(editor.style) ?? null },
      })
      const e = errorOf(res)
      if (e) {
        setErr(`保存失败:${e}`)
        return
      }
      if (Array.isArray(res)) setCards(res as PersonaCard[])
      setEditor(null)
      setMsg(editor.id ? '人格卡已更新' : '人格卡已创建,可在列表里启用')
    } catch {
      setErr('保存失败,请重试')
    } finally {
      setSaving(false)
    }
  }

  const toggleActive = (card: PersonaCard) => {
    setErr('')
    setMsg('')
    setPendingDelete(null)
    if (card.id === activeId) {
      onSave({ activePersonaId: '' })
      setMsg(`已停用「${card.name}」`)
    } else {
      onSave({ activePersonaId: card.id })
      setMsg(`已启用「${card.name}」,下一轮对话生效`)
    }
  }

  const removeCard = (card: PersonaCard) => {
    if (pendingDelete !== card.id) {
      setPendingDelete(card.id)
      setMsg('')
      setErr('')
      return
    }
    setPendingDelete(null)
    if (card.id === activeId) onSave({ activePersonaId: '' })
    leave.beginLeave(card.id, () => {
      void (async () => {
        try {
          const res = await window.desktop?.agentPersonaSet?.({ remove: card.id })
          const e = errorOf(res)
          if (e) {
            setErr(`删除失败:${e}`)
            return
          }
          if (Array.isArray(res)) setCards(res as PersonaCard[])
          if (expandedNotes === card.id) setExpandedNotes(null)
          setMsg(`已删除「${card.name}」`)
        } catch {
          setErr('删除失败,请重试')
        }
      })()
    })
  }

  const clearNotes = async (card: PersonaCard) => {
    setErr('')
    try {
      const res = await window.desktop?.agentPersonaSet?.({ clearNotes: card.id })
      const e = errorOf(res)
      if (e) {
        setErr(`清空失败:${e}`)
        return
      }
      if (Array.isArray(res)) setCards(res as PersonaCard[])
      setNotesEditing(null)
      setMsg(`已清空「${card.name}」的进化整合区`)
    } catch {
      setErr('清空失败,请重试')
    }
  }

  // 整合区双击编辑(2026-10-26):双击内容进入文本域,Enter/Ctrl+Enter 或「保存」
  // 提交,Esc/取消放弃;保存走 upsert(notes 显式传入,提示词/风格原样带回)
  const beginNotesEdit = (card: PersonaCard) => {
    setErr('')
    setMsg('')
    setPendingDelete(null)
    setExpandedNotes(card.id)
    setNotesEditing({ id: card.id, text: String(card.notes ?? '') })
  }

  const saveNotes = async (card: PersonaCard) => {
    if (!notesEditing || notesEditing.id !== card.id || notesSaving) return
    setNotesSaving(true)
    setErr('')
    try {
      const res = await window.desktop?.agentPersonaSet?.({
        upsert: {
          id: card.id,
          name: card.name,
          prompt: card.prompt,
          notes: notesEditing.text,
          // style 缺省保留原值;这里显式回传避免不同步
          style: card.style ?? null,
        },
      })
      const e = errorOf(res)
      if (e) {
        setErr(`保存整合区失败:${e}`)
        return
      }
      if (Array.isArray(res)) setCards(res as PersonaCard[])
      setNotesEditing(null)
      setMsg(`已更新「${card.name}」的进化整合区`)
    } catch {
      setErr('保存整合区失败,请重试')
    } finally {
      setNotesSaving(false)
    }
  }

  const exportOne = async (card: PersonaCard) => {
    setErr('')
    setMsg('')
    const res = await window.desktop?.agentPersonaExport?.(card.id)
    if (!res || res.canceled) return
    if (res.error) setErr(`导出失败:${res.error}`)
    else setMsg(exportMessage(res))
  }

  const exportAll = async () => {
    setErr('')
    setMsg('')
    const res = await window.desktop?.agentPersonaExport?.()
    if (!res || res.canceled) return
    if (res.error) setErr(`导出失败:${res.error}`)
    else setMsg(exportMessage(res))
  }

  const importCards = async () => {
    setErr('')
    setMsg('')
    try {
      const res = await window.desktop?.agentPersonaImport?.()
      if (!res || res.canceled) return
      if (res.error || (res.imported ?? 0) === 0) {
        setErr(`导入失败:${res.error ?? '没有导入任何人格卡'}`)
        await refreshCards()
        return
      }
      const buf =
        typeof res.bufferImported === 'number' ? `,缓冲区 ${res.bufferImported} 条` : ''
      const bufSkip = res.bufferSkipped ? `,跳过缓冲 ${res.bufferSkipped} 条` : ''
      setMsg(
        `已导入 ${res.imported ?? 0} 张${buf}${res.skipped ? `,跳过 ${res.skipped} 张(重复/无效)` : ''}${bufSkip}`,
      )
      await Promise.all([refreshCards(), refreshBuffer()])
    } catch (err) {
      setErr(`导入失败:${err instanceof Error ? err.message : '请重试'}`)
    }
  }

  const saveBasePrompt = () => {
    setErr('')
    onSave({ systemPrompt: basePrompt.trim() })
    setBaseDirty(false)
    setMsg('基础提示词已保存(所有人格卡共用)')
  }

  const bufferAction = async (kind: 'merge' | 'discard' | 'undo', item: PersonaBufferItem) => {
    setErr('')
    setMsg('')
    try {
      const res =
        kind === 'merge'
          ? await window.desktop?.agentPersonaBufferMerge?.(item.id)
          : kind === 'discard'
            ? await window.desktop?.agentPersonaBufferDiscard?.(item.id)
            : await window.desktop?.agentPersonaBufferUndo?.(item.id)
      if (!res?.ok) {
        setErr(`${kind === 'merge' ? '合并' : kind === 'discard' ? '丢弃' : '撤销'}失败:${res?.error ?? '未知错误'}`)
        return
      }
      if (kind === 'merge') {
        setMsg(`已合并到「${item.cardName}」:新增 ${res.added ?? 0} 条要点,移除 ${res.removed ?? 0} 条源记忆`)
      } else if (kind === 'discard') {
        setMsg('建议已丢弃')
      } else {
        setMsg(`已撤销合并:恢复人格卡内容并导回 ${res.removed ?? 0} 条记忆`)
      }
      await Promise.all([refreshCards(), refreshBuffer()])
    } catch {
      setErr('缓冲区操作失败,请重试')
    }
  }

  const mergeAllBuffer = async () => {
    setErr('')
    setMsg('')
    try {
      const res = await window.desktop?.agentPersonaBufferMergeAll?.()
      if (!res?.ok && !res?.merged) {
        setErr(`合并失败:${res?.error ?? res?.errors?.join(';') ?? '未知错误'}`)
        return
      }
      setMsg(
        `已合并 ${res.merged ?? 0} 条建议(新增 ${res.added ?? 0} 条要点,移除 ${res.removed ?? 0} 条记忆)` +
          (res.failed ? `,${res.failed} 条失败:${res.errors?.join(';') ?? ''}` : ''),
      )
      await Promise.all([refreshCards(), refreshBuffer()])
    } catch {
      setErr('批量合并失败,请重试')
    }
  }

  const clearBuffer = async () => {
    setErr('')
    const res = await window.desktop?.agentPersonaBufferClear?.()
    if (!res?.ok) {
      setErr(`清空失败:${res?.error ?? '未知错误'}`)
      return
    }
    setMsg('人格卡缓冲区已清空')
    await refreshBuffer()
  }

  const runStyleReview = async () => {
    if (styleReviewing) return
    setErr('')
    setMsg('')
    setStyleReviewing(true)
    try {
      const res = await window.desktop?.agentStyleReview?.(
        pickedIds.length > 0 ? { messages: messages ?? [], ids: pickedIds } : (messages ?? []),
      )
      if (!res?.ok) {
        setErr(`评审失败:${res?.error ?? '未知错误'}`)
        return
      }
      if (res.buffered) {
        const bans = res.bannedPhrases?.length ?? 0
        const traitN = res.traits?.length ?? 0
        const parts: string[] = []
        if (traitN > 0) parts.push(`${traitN} 条新性格`)
        if ((res.notes?.length ?? 0) > 0 || bans > 0) {
          parts.push(`去 AI 味 ${res.notes?.length ?? 0} 条规则${bans ? `、${bans} 个禁用词` : ''}`)
        }
        const side = [res.styleError ? `去 AI 味未完成:${res.styleError}` : '', res.traitError ? `性格提取未完成:${res.traitError}` : '']
          .filter(Boolean)
          .join(' ')
        setMsg(`已进入缓冲区(${parts.join(',') || '建议'})${side ? `。${side}` : ''}`)
        setBufferOpen(true)
        await refreshBuffer()
      } else {
        setMsg(res.message ?? '最近 30 条里没有新的性格特征,回复也已经比较自然')
      }
    } catch {
      setErr('评审失败,请重试')
    } finally {
      setStyleReviewing(false)
    }
  }

  const activeTone = activeCard?.style?.tone?.trim()
  const baseCustomized = String(config?.systemPrompt ?? '').trim().length > 0

  return (
    <div className="island-persona-page">
      {/* 顶部引导:三步 + 主操作 */}
      <div className="island-persona-hero">
        <div className="island-persona-hero-main">
          <span className="island-persona-hero-title">人格卡</span>
          <span className="island-persona-hero-desc">
            给岛灵准备多套人格与说话方式。启用后下一轮对话立即生效;提示词与风格由你掌握,进化只提供建议。
          </span>
        </div>
        <div className="island-persona-steps">
          <span><b>1</b> 写基础提示词</span>
          <span><b>2</b> 新建并启用卡片</span>
          <span><b>3</b> 对话 / 缓冲区微调</span>
        </div>
        <div className="island-persona-hero-actions">
          <button type="button" className="island-persona-primary" onClick={openNew}>
            新建人格卡
          </button>
          <button type="button" className="island-agent-scale-btn" onClick={() => void importCards()}>
            导入
          </button>
          <button
            type="button"
            className="island-agent-scale-btn"
            disabled={cards.length === 0}
            onClick={() => void exportAll()}
          >
            导出全部
          </button>
        </div>
      </div>

      {/* 当前启用卡摘要 */}
      <div className={`island-persona-active${activeCard ? ' on' : ''}`}>
        <div className="island-persona-active-main">
          <span className="island-persona-active-label">当前启用</span>
          <span className="island-persona-active-name">{activeCard?.name ?? '未启用人格卡'}</span>
          <span className="island-persona-active-hint">
            {activeCard
              ? [
                  activeTone ?? '未设置语气',
                  notesCount(activeCard) ? `整合区 ${notesCount(activeCard)} 条` : '整合区为空',
                ].join(' · ')
              : '启用一张卡后,岛灵才会按卡内设定说话。'}
          </span>
        </div>
        {activeCard ? (
          <button type="button" className="island-agent-scale-btn" onClick={() => toggleActive(activeCard)}>
            停用
          </button>
        ) : null}
      </div>

      {/* 基础提示词:默认折叠 */}
      <section className="island-persona-section">
        <SectionHead
          title="基础提示词"
          hint={baseCustomized ? '所有人格卡共用 · 已自定义' : '所有人格卡共用'}
          open={baseOpen}
          onToggle={() => setBaseOpen((v) => !v)}
        />
        {baseOpen ? (
          <div className="island-persona-section-body">
            <span className="island-agent-section-hint">
              原「行为与界面 → 自定义提示词」已整合到这里。它定义岛灵的通用行为;人格卡负责身份与说话方式。
            </span>
            <textarea
              className="island-persona-textarea"
              value={basePrompt}
              maxLength={20000}
              spellCheck={false}
              placeholder="如:你是桌面灵动岛里的个人助手,叫岛灵;回答简洁自然…"
              onKeyDown={keepTextKeys}
              onChange={(event) => {
                setBaseDirty(true)
                setBasePrompt(event.target.value)
              }}
            />
            <div className="island-agent-scale-row">
              <span className="island-persona-count">{basePrompt.length}/20000</span>
              <button type="button" className="island-agent-scale-btn" disabled={!baseDirty} onClick={saveBasePrompt}>
                保存基础提示词
              </button>
            </div>
          </div>
        ) : null}
      </section>

      {/* 编辑面板:独立于列表,渐进展开 */}
      {editor ? (
        <section className="island-persona-editor">
          <div className="island-persona-editor-head">
            <span className="island-persona-editor-title">{editor.id ? '编辑人格卡' : '新建人格卡'}</span>
            <button type="button" className="island-agent-scale-btn" onClick={() => setEditor(null)}>
              关闭
            </button>
          </div>
          <span className="island-agent-section-hint">
            先写名称与提示词;需要更自然的说话方式时再展开下面的风格设置。
          </span>

          <div className="island-persona-field">
            <span className="island-persona-field-label">名称</span>
            <input
              type="text"
              className="island-persona-input"
              value={editor.name}
              maxLength={60}
              placeholder="如:温柔助手 / 毒舌搭档"
              spellCheck={false}
              onChange={(event) => setEditor((e) => (e ? { ...e, name: event.target.value } : e))}
            />
          </div>

          <div className="island-persona-field">
            <span className="island-persona-field-label">人格提示词</span>
            <textarea
              className="island-persona-textarea"
              value={editor.prompt}
              maxLength={8000}
              placeholder="身份、称谓、说话方式、性格、口头禅、禁忌等(进化不会改动这段原文)"
              spellCheck={false}
              onKeyDown={keepTextKeys}
              onChange={(event) => setEditor((e) => (e ? { ...e, prompt: event.target.value } : e))}
            />
          </div>

          <div className="island-persona-field">
            <span className="island-persona-field-label">风格模板(一键填充,可再微调)</span>
            <div className="island-persona-chips">
              {TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="island-persona-chip"
                  onClick={() => setEditor((e) => (e ? { ...e, style: templateStyle(t.id) } : e))}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <SectionHead
            title="说话方式"
            hint={editor.style.tone || '未设置'}
            open={styleOpen}
            onToggle={() => setStyleOpen((v) => !v)}
          />
          {styleOpen ? (
            <div className="island-persona-section-body">
              <div className="island-persona-grid">
                <input
                  className="island-persona-input"
                  value={editor.style.tone}
                  placeholder="语气:松弛自然 / 毒舌但不伤人"
                  onChange={(event) =>
                    setEditor((e) => (e ? { ...e, style: { ...e.style, tone: event.target.value } } : e))
                  }
                />
                <input
                  className="island-persona-input"
                  value={editor.style.sentence}
                  placeholder="句式:短句口语,少用书面连接词"
                  onChange={(event) =>
                    setEditor((e) => (e ? { ...e, style: { ...e.style, sentence: event.target.value } } : e))
                  }
                />
                <input
                  className="island-persona-input"
                  value={editor.style.address}
                  placeholder="自称/称呼:自称我,叫用户老板"
                  onChange={(event) =>
                    setEditor((e) => (e ? { ...e, style: { ...e.style, address: event.target.value } } : e))
                  }
                />
                <input
                  className="island-persona-input"
                  value={editor.style.particles}
                  placeholder="语气词:啊、嘛、呗"
                  onChange={(event) =>
                    setEditor((e) => (e ? { ...e, style: { ...e.style, particles: event.target.value } } : e))
                  }
                />
                <input
                  type="number"
                  className="island-persona-input"
                  min={1}
                  max={10}
                  value={editor.style.maxSentences}
                  placeholder="闲聊句数上限 1-10"
                  onChange={(event) =>
                    setEditor((e) => (e ? { ...e, style: { ...e.style, maxSentences: event.target.value } } : e))
                  }
                />
              </div>
              <div className="island-agent-scale-row">
                <span className="island-persona-count">emoji</span>
                {(['none', 'rare', 'normal'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    className={`island-persona-chip${editor.style.emoji === v ? ' on' : ''}`}
                    onClick={() => setEditor((e) => (e ? { ...e, style: { ...e.style, emoji: v } } : e))}
                  >
                    {v === 'none' ? '无' : v === 'rare' ? '少量' : '正常'}
                  </button>
                ))}
                <span className="island-persona-count">列表</span>
                {(['never', 'task-only'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    className={`island-persona-chip${editor.style.listPolicy === v ? ' on' : ''}`}
                    onClick={() => setEditor((e) => (e ? { ...e, style: { ...e.style, listPolicy: v } } : e))}
                  >
                    {v === 'never' ? '闲聊禁列' : '仅任务可用'}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <SectionHead
            title="正例、反例与禁用词"
            hint="可选,进阶"
            open={advancedOpen}
            onToggle={() => setAdvancedOpen((v) => !v)}
          />
          {advancedOpen ? (
            <div className="island-persona-section-body">
              {/* 三个子区分组(2026-10-26:用户反馈"两个正例区"/布局重叠——
                  去掉顶部总述行,每个子区独立描边卡片 + 标题行,互不粘连) */}
              <div className="island-persona-block">
                <div className="island-persona-block-head">
                  <span className="island-persona-block-title">正例</span>
                  <span className="island-persona-block-hint">希望岛灵模仿的说法,学语气不抄内容</span>
                  <button
                    type="button"
                    className="island-agent-scale-btn"
                    disabled={editor.style.examples.length >= 6}
                    onClick={() =>
                      setEditor((e) =>
                        e
                          ? {
                              ...e,
                              style: { ...e.style, examples: [...e.style.examples, { user: '', assistant: '' }] },
                            }
                          : e,
                      )
                    }
                  >
                    添加
                  </button>
                </div>
                {editor.style.examples.length === 0 ? (
                  <span className="island-persona-block-empty">还没有正例。点「添加」写一条「用户说 → 岛灵回」。</span>
                ) : null}
                {editor.style.examples.map((ex, idx) => (
                  <div key={idx} className="island-persona-grid island-persona-example">
                    <input
                      className="island-persona-input"
                      value={ex.user}
                      placeholder="用户说:今天好累"
                      onChange={(event) =>
                        setEditor((e) =>
                          e
                            ? {
                                ...e,
                                style: {
                                  ...e.style,
                                  examples: e.style.examples.map((x, i) =>
                                    i === idx ? { ...x, user: event.target.value } : x,
                                  ),
                                },
                              }
                            : e,
                        )
                      }
                    />
                    <input
                      className="island-persona-input"
                      value={ex.assistant}
                      placeholder="岛灵回:那就别硬撑了,先躺会儿。"
                      onChange={(event) =>
                        setEditor((e) =>
                          e
                            ? {
                                ...e,
                                style: {
                                  ...e.style,
                                  examples: e.style.examples.map((x, i) =>
                                    i === idx ? { ...x, assistant: event.target.value } : x,
                                  ),
                                },
                              }
                            : e,
                        )
                      }
                    />
                    <button
                      type="button"
                      className="island-agent-scale-btn island-mcp-remove"
                      onClick={() =>
                        setEditor((e) =>
                          e
                            ? {
                                ...e,
                                style: { ...e.style, examples: e.style.examples.filter((_, i) => i !== idx) },
                              }
                            : e,
                        )
                      }
                    >
                      删
                    </button>
                  </div>
                ))}
              </div>

              <div className="island-persona-block">
                <div className="island-persona-block-head">
                  <span className="island-persona-block-title">反例</span>
                  <span className="island-persona-block-hint">绝不要出现的说法,每行一条</span>
                </div>
                <textarea
                  className="island-persona-textarea island-persona-textarea--short"
                  value={editor.style.antiExamples}
                  placeholder="如:当然可以!首先…其次…希望这对你有帮助。"
                  onKeyDown={keepTextKeys}
                  onChange={(event) =>
                    setEditor((e) => (e ? { ...e, style: { ...e.style, antiExamples: event.target.value } } : e))
                  }
                />
              </div>

              <div className="island-persona-block">
                <div className="island-persona-block-head">
                  <span className="island-persona-block-title">禁用词</span>
                  <span className="island-persona-block-hint">直接禁止出现的词句,每行一个</span>
                </div>
                <textarea
                  className="island-persona-textarea island-persona-textarea--short"
                  value={editor.style.banned}
                  placeholder={'每行一个,如:\n首先\n其次\n综上所述\n希望对你有帮助'}
                  onKeyDown={keepTextKeys}
                  onChange={(event) =>
                    setEditor((e) => (e ? { ...e, style: { ...e.style, banned: event.target.value } } : e))
                  }
                />
              </div>
            </div>
          ) : null}

          <div className="island-persona-editor-foot">
            <span className="island-persona-count">{editor.prompt.length}/8000</span>
            <button type="button" className="island-agent-scale-btn" disabled={saving} onClick={() => setEditor(null)}>
              取消
            </button>
            <button type="button" className="island-persona-primary" disabled={saving} onClick={() => void saveCard()}>
              {saving ? '保存中…' : editor.id ? '保存修改' : '创建人格卡'}
            </button>
          </div>
        </section>
      ) : null}

      {/* 人格卡列表 */}
      <section className="island-persona-section">
        <div className="island-persona-section-head static">
          <span className="island-persona-section-title">我的人格卡</span>
          <span className="island-persona-section-hint">{cards.length} 张 · 点「启用」切换</span>
        </div>
        {loading ? <span className="island-agent-section-hint">加载中…</span> : null}
        {!loading && cards.length === 0 ? (
          <div className="island-persona-empty">
            <span>还没有人格卡。</span>
            <button type="button" className="island-persona-primary" onClick={openNew}>
              新建第一张
            </button>
          </div>
        ) : null}

        {cards.map((card) => {
          const active = card.id === activeId
          const notes = String(card.notes ?? '').trim()
          const preview = String(card.prompt ?? '').replace(/\s+/g, ' ').trim().slice(0, 90)
          return (
            <div
              key={card.id}
              className={
                'island-persona-card' +
                (active ? ' active' : '') +
                (leave.leavingIds.includes(card.id) ? ' island-ui-leave' : '')
              }
            >
              <div className="island-persona-head">
                <span className="island-persona-name" title={card.name}>
                  {card.name}
                </span>
                {active ? <span className="island-persona-badge">已启用</span> : null}
                {card.style?.tone ? <span className="island-persona-tag">{card.style.tone.slice(0, 10)}</span> : null}
                {notes ? <span className="island-persona-notes-count">整合 {notesCount(card)} 条</span> : null}
              </div>
              <span className="island-persona-preview" title={card.prompt}>
                {preview || '(未填写人格提示词)'}
              </span>

              <div className="island-persona-card-main">
                <button
                  type="button"
                  className={`island-agent-scale-btn${active ? ' on' : ''}`}
                  onClick={() => toggleActive(card)}
                >
                  {active ? '停用' : '启用'}
                </button>
                <button type="button" className="island-agent-scale-btn" onClick={() => openEdit(card)}>
                  编辑
                </button>
                <button
                  type="button"
                  className="island-agent-scale-btn"
                  onClick={() => setExpandedNotes((id) => (id === card.id ? null : card.id))}
                >
                  {expandedNotes === card.id ? '收起整合区' : '整合区'}
                </button>
              </div>

              <div className="island-persona-card-secondary">
                <button type="button" className="island-persona-link" onClick={() => void exportOne(card)}>
                  导出
                </button>
                <button
                  type="button"
                  className={`island-persona-link danger${pendingDelete === card.id ? ' confirm' : ''}`}
                  onClick={() => removeCard(card)}
                  onBlur={() => setPendingDelete((id) => (id === card.id ? null : id))}
                >
                  {pendingDelete === card.id ? '确认删除?' : '删除'}
                </button>
              </div>

              {expandedNotes === card.id ? (
                <div className="island-persona-notes">
                  {notesEditing?.id === card.id ? (
                    <>
                      <textarea
                        className="island-persona-textarea island-persona-textarea--short"
                        value={notesEditing.text}
                        maxLength={12000}
                        autoFocus
                        spellCheck={false}
                        placeholder="每行一条整合记忆,如:称呼主人为老板"
                        onChange={(event) =>
                          setNotesEditing((n) => (n && n.id === card.id ? { ...n, text: event.target.value } : n))
                        }
                        onKeyDown={(event) => {
                          keepTextKeys(event)
                          if (event.key === 'Escape') {
                            event.preventDefault()
                            setNotesEditing(null)
                          }
                          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                            event.preventDefault()
                            void saveNotes(card)
                          }
                        }}
                      />
                      <div className="island-agent-scale-row">
                        <span className="island-persona-count">{notesEditing.text.length}/12000</span>
                        <button
                          type="button"
                          className="island-agent-scale-btn"
                          disabled={notesSaving}
                          onClick={() => setNotesEditing(null)}
                        >
                          取消
                        </button>
                        <button
                          type="button"
                          className="island-persona-primary"
                          disabled={notesSaving}
                          onClick={() => void saveNotes(card)}
                        >
                          {notesSaving ? '保存中…' : '保存'}
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      {notes ? (
                        <pre title="双击编辑" onDoubleClick={() => beginNotesEdit(card)}>
                          {notes}
                        </pre>
                      ) : (
                        <span className="island-persona-notes-empty" onDoubleClick={() => beginNotesEdit(card)}>
                          (空)双击添加整合内容…
                        </span>
                      )}
                      {notes ? (
                        <button type="button" className="island-agent-scale-btn" onClick={() => void clearNotes(card)}>
                          清空整合区
                        </button>
                      ) : (
                        <button type="button" className="island-agent-scale-btn" onClick={() => beginNotesEdit(card)}>
                          添加整合内容
                        </button>
                      )}
                    </>
                  )}
                </div>
              ) : null}
            </div>
          )
        })}
      </section>

      {/* 进化缓冲区:默认折叠,有待处理时自动展开 */}
      <section className="island-persona-section">
        <SectionHead
          title="进化缓冲区"
          hint={
            pendingBuffer > 0
              ? `${pendingBuffer} 条待处理`
              : buffer.length > 0
                ? `${buffer.length} 条历史`
                : '暂无建议'
          }
          open={bufferOpen}
          onToggle={() => setBufferOpen((v) => !v)}
          extra={
            <button
              type="button"
              className={`island-persona-chip${evolveEnabled ? ' on' : ''}`}
              onClick={(event) => {
                event.stopPropagation()
                onSave({ personaEvolveEnabled: !evolveEnabled })
                setMsg(
                  evolveEnabled
                    ? '已关闭记忆进化优化人格卡'
                    : '已开启记忆进化优化人格卡:建议会先进入缓冲区',
                )
              }}
            >
              {evolveEnabled ? '自动优化已开' : '开启自动优化'}
            </button>
          }
        />
        {bufferOpen ? (
          <div className="island-persona-section-body">
            <span className="island-agent-section-hint">
              记忆进化、新性格和「去 AI 味」的建议都先放在这里。点「合并」才会写入人格卡;性格写进整合区后,下一轮按这个人的口气说话。合并后可撤销。
            </span>
            <div className="island-persona-buffer-actions">
              <button
                type="button"
                className="island-persona-primary"
                disabled={styleReviewing || !activeId}
                title={
                  !activeId
                    ? '请先启用一张人格卡'
                    : pickedIds.length > 0
                      ? '只评审当前窗口里勾选的岛灵回复'
                      : '从最近 30 条对话提取新性格,并检查 AI 腔'
                }
                onClick={() => void runStyleReview()}
              >
                {styleReviewing ? '评审中…' : pickedIds.length > 0 ? `评审所选 ${pickedIds.length} 条` : '分析最近30条'}
              </button>
              <button
                type="button"
                className={`island-persona-chip${pickOpen || pickedIds.length > 0 ? ' on' : ''}`}
                disabled={assistantPicks.length === 0}
                title={assistantPicks.length === 0 ? '当前窗口还没有岛灵回复' : '勾选后只评审这些回复'}
                onClick={() => setPickOpen((open) => !open)}
              >
                {pickedIds.length > 0 ? `已选 ${pickedIds.length} 条` : '选择回复'}
              </button>
              {pendingBuffer > 0 ? (
                <button type="button" className="island-agent-scale-btn" onClick={() => void mergeAllBuffer()}>
                  合并全部({pendingBuffer})
                </button>
              ) : null}
              {buffer.length > 0 ? (
                <button type="button" className="island-persona-link danger" onClick={() => void clearBuffer()}>
                  清空缓冲
                </button>
              ) : null}
            </div>
            {pickOpen ? (
              <div className="island-persona-pick-list">
                <span className="island-agent-section-hint">
                  勾选当前窗口里的岛灵回复,最多 {REVIEW_PICK_CAP} 条。不勾选就评审最近 30 条。
                </span>
                {assistantPicks.map((row) => {
                  const on = pickedIds.includes(row.id)
                  const full = !on && pickedIds.length >= REVIEW_PICK_CAP
                  return (
                    <label
                      key={row.id}
                      className={`island-persona-pick${on ? ' on' : ''}${full ? ' full' : ''}`}
                      onKeyDown={keepTextKeys}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={full}
                        onChange={() => {
                          setPickedIds((prev) => {
                            if (prev.includes(row.id)) return prev.filter((id) => id !== row.id)
                            if (prev.length >= REVIEW_PICK_CAP) return prev
                            return [...prev, row.id]
                          })
                        }}
                      />
                      <span>{row.text}</span>
                    </label>
                  )
                })}
                {pickedIds.length > 0 ? (
                  <button type="button" className="island-persona-link" onClick={() => setPickedIds([])}>
                    清除选择
                  </button>
                ) : null}
              </div>
            ) : null}

            {buffer.length === 0 ? (
              <div className="island-persona-empty">
                <span>暂无建议。</span>
                <span className="island-agent-section-hint">
                  运行记忆进化,或启用一张人格卡后点「分析最近30条」。也可以先勾选当前窗口里的几条回复,只评审那几条。
                </span>
              </div>
            ) : null}

            {buffer.map((item) => {
              const status = bufferStatus(item)
              return (
                <div key={item.id} className="island-persona-buffer-item">
                  <div className="island-persona-buffer-head">
                    <span className={`island-persona-status ${status}`}>
                      {status === 'pending' ? '待处理' : status === 'merged' ? '已合并' : '已撤销'}
                    </span>
                    <span className="island-persona-name">{item.cardName}</span>
                    <span className="island-persona-tag">{bufferKindLabel(item)}</span>
                  </div>
                  <span className="island-persona-preview">{item.notes.replace(/\s+/g, ' ').slice(0, 100)}</span>
                  <details className="island-persona-buffer-detail">
                    <summary>查看完整建议</summary>
                    <pre>{item.notes}</pre>
                    {item.cardPatch?.prompt ? (
                      <>
                        <span className="island-persona-field-label">人格提示词提案(合并后生效)</span>
                        <pre>{item.cardPatch.prompt}</pre>
                        {(() => {
                          const current = cards.find((c) => c.id === item.cardId)?.prompt
                          if (!current || current === item.cardPatch?.prompt) return null
                          return (
                            <details>
                              <summary>查看当前提示词</summary>
                              <pre>{current}</pre>
                            </details>
                          )
                        })()}
                      </>
                    ) : null}
                    {item.cardPatch?.style &&
                    (item.cardPatch.style.tone || item.cardPatch.style.emoji || item.cardPatch.style.listPolicy) ? (
                      <span className="island-agent-section-hint">
                        风格提案:语气 {item.cardPatch.style.tone ?? '(不变)'}
                        {item.cardPatch.style.emoji ? ` · emoji ${item.cardPatch.style.emoji}` : ''}
                        {item.cardPatch.style.listPolicy ? ` · 列表 ${item.cardPatch.style.listPolicy}` : ''}
                      </span>
                    ) : null}
                    {item.cardPatch?.style?.bannedPhrases?.length ? (
                      <span className="island-agent-section-hint">
                        合并后追加禁用词:{item.cardPatch.style.bannedPhrases.join('、')}
                      </span>
                    ) : null}
                    {item.cardPatch?.style?.antiExamples?.length ? (
                      <span className="island-agent-section-hint">
                        合并后追加反例 {item.cardPatch.style.antiExamples.length} 条(不覆盖已有反例)
                      </span>
                    ) : null}
                  </details>
                  <div className="island-persona-buffer-actions">
                    {status === 'pending' ? (
                      <>
                        <button type="button" className="island-agent-scale-btn" onClick={() => void bufferAction('merge', item)}>
                          合并到人格卡
                        </button>
                        <button
                          type="button"
                          className="island-persona-link danger"
                          onClick={() => void bufferAction('discard', item)}
                        >
                          丢弃
                        </button>
                      </>
                    ) : status === 'merged' ? (
                      <button type="button" className="island-agent-scale-btn" onClick={() => void bufferAction('undo', item)}>
                        撤销合并
                      </button>
                    ) : (
                      <span className="island-agent-section-hint">已撤销,不可重复合并</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        ) : null}
      </section>

      {err ? <span className="island-mcp-test-result fail">{err}</span> : null}
      {msg ? <span className="island-mcp-test-result ok">{msg}</span> : null}
    </div>
  )
}
