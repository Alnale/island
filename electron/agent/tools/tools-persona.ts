/**
 * 人格卡工具(2026-10-26)
 *
 * 给 LLM 用,覆盖人格卡与进化缓冲区的全部操作:
 * - 卡片:list/get/create/edit/replace/delete/activate/deactivate/set_notes/clear_notes
 * - 导入导出:export/import(JSON 文本,不弹文件对话框)
 * - 缓冲区:buffer_list/buffer_merge/buffer_discard/buffer_undo/buffer_clear
 *
 * 说话风格可用 style 对象,或 template 预设(natural/gentle/tsundere/cold/energetic)。
 * create/edit 可在缺 prompt 时用 traits/description 自动拼一份人格提示词。
 *
 * 边界:delete/replace 只在主人本轮明确说「覆盖整张人格卡 / 删除人格卡」时才弹确认。
 * 闲聊、群聊、系统通知、以及轮次种类对不上时:不弹窗、不改卡。
 * 工具说明里的「整体替换/覆盖整张」不算主人开口,不弹确认。
 * 主人说「优化人格卡」这类局部修改时,replace 降级为 edit(不弹窗,
 * 进化整合区与没写到的风格保留)。删除激活卡自动停用;notes 可直接管理。
 */

import type {
  AgentConfig,
  AgentTool,
  MemoryStoreLike,
  PersonaBufferItem,
  PersonaBufferStoreLike,
  PersonaCardStoreLike,
  PersonaStyle,
  ToolParams,
} from '../types'
import { normalizePersonaExport, parsePersonaImport } from '../persona'
import {
  mergePersonaBufferItem,
  parsePersonaBufferImport,
  planPersonaBufferImport,
  retargetImportedBuffer,
  undoPersonaBufferItem,
} from '../persona-buffer'

export interface PersonaToolDeps {
  getStore(): PersonaCardStoreLike | null
  getConfig(): AgentConfig
  updateConfig?(patch: Partial<AgentConfig>): void
  confirmDangerous?(action: string, detail: string): Promise<boolean>
  getPersonaBufferStore?(): PersonaBufferStoreLike | null
  getMemoryStore?(): MemoryStoreLike | null
  /**
   * 本轮触发上下文(2026-10-26)。未注入 = 旧行为(replace/delete 一律确认,
   * 单测兼容)。注入后:非主人轮、以及主人没要求改卡的轮次,不弹确认。
   */
  getTurnContext?(): { kind?: string | null; text?: string | null } | null
}

/** 只有主人本轮(窗口 / 会话面板 / 主人 QQ / 主人在群里点名)才能改全局人格卡 */
const OWNER_TURN = new Set(['window', 'panel', 'master-qq', 'master-group'])
/**
 * 主人明确要覆盖整张人格卡(才会弹「整体替换」确认)。
 * 必须点到「人格卡」。工具说明里的「整体替换/覆盖整张/重写整张」
 * 没有「人格卡」三个字连在一起,不算主人开口。
 */
const REPLACE_ASK =
  /整体替换人格卡|覆盖整张(?:人格)?卡|重写整张(?:人格)?卡|整张人格卡|把整张人格卡|把人格卡(?:整体|全部)?(?:替换|覆盖|重写)|清空重写人格卡/
/** 主人明确要删卡 */
const DELETE_ASK = /删除(?:这张|该|当前|全部)?人格卡|删掉(?:这张|该|当前)?人格卡|把人格卡删/
/** 主人要改卡,但不是覆盖整张:replace 降级为 edit,不弹窗 */
const EDIT_ASK = /人格卡|改人设|换人设|调人设|改提示词|重写提示词|优化人设|修改人设/

/**
 * 从本轮触发原文里取出主人/对方实际说的那句。
 * QQ 入站消息后面拼着档案卡和回复规则,那些文字里可能出现「人格卡」,
 * 不能拿来当成主人这轮要改卡。
 */
export function personaTurnUtterance(text: string | null | undefined): string {
  let raw = String(text ?? '').trim()
  if (!raw || raw.startsWith('【系统通知】')) return ''
  const marked = raw.match(
    /^【(?:QQ私聊|QQ群聊|主人窗口)[^】]*】([\s\S]*?)(?:\s*【档案卡】|\s*【回复规则】|\s*【媒体已下载】|\s*【文件已下载】|$)/,
  )
  raw = (marked ? marked[1] : raw).trim()
  // 前缀没对上时,系统段(档案卡/回复规则/群记录)仍可能整段落在原文里
  const cut = raw.search(
    /【(?:档案卡|回复规则|媒体已下载|文件已下载|系统通知|当前会话对象|归属|本会话情况记录)】|最近群聊记录[:：]/,
  )
  if (cut >= 0) raw = raw.slice(0, cut).trim()
  return raw
}

export type PersonaDangerDecision = 'legacy' | 'confirm' | 'edit' | 'deny'

/** replace/delete 该不该弹确认。ctx 缺省 = 旧行为(一律确认,仅测试未注入时)。 */
export function decidePersonaDanger(
  ctx: { kind?: string | null; text?: string | null } | null | undefined,
  verb: 'replace' | 'delete',
): PersonaDangerDecision {
  if (!ctx) return 'legacy'
  const kind = String(ctx.kind ?? '')
  if (!OWNER_TURN.has(kind)) return 'deny'
  const said = personaTurnUtterance(ctx.text)
  if (verb === 'delete') return DELETE_ASK.test(said) ? 'confirm' : 'deny'
  if (REPLACE_ASK.test(said)) return 'confirm'
  if (EDIT_ASK.test(said)) return 'edit'
  return 'deny'
}

/** 已注入本轮上下文时,缺轮次/空上下文一律拒绝,不走旧的「一律弹确认」。 */
function personaDangerDecision(
  deps: PersonaToolDeps,
  verb: 'replace' | 'delete',
): PersonaDangerDecision {
  if (!deps.getTurnContext) return 'legacy'
  const ctx = deps.getTurnContext()
  if (!ctx) return 'deny'
  return decidePersonaDanger(ctx, verb)
}

/** 预设说话风格模板(LLM 可直接选 template,不用逐字段写) */
export const PERSONA_STYLE_TEMPLATES: Record<string, PersonaStyle> = {
  natural: {
    tone: '松弛自然,像熟人聊天',
    sentence: '短句口语,少用书面连接词,不总结',
    particles: ['啊', '嘛', '呗'],
    emoji: 'rare',
    listPolicy: 'never',
    maxSentences: 3,
    bannedPhrases: ['首先', '其次', '综上所述', '总的来说', '总而言之', '希望对你有帮助', '如果还有其他问题'],
    antiExamples: ['当然可以!首先…其次…希望这对你有帮助。'],
  },
  gentle: {
    tone: '温柔耐心,不催促',
    sentence: '柔和短句,先回应情绪再说事',
    particles: ['呀', '呢', '啦'],
    emoji: 'rare',
    listPolicy: 'never',
    maxSentences: 4,
    bannedPhrases: ['首先', '其次', '综上所述', '希望这对你有帮助'],
  },
  tsundere: {
    tone: '嘴硬心软,傲娇但不刻薄',
    sentence: '短句,偶尔别扭,关心藏在后半句',
    particles: ['哼', '才不是', '算了'],
    emoji: 'none',
    listPolicy: 'never',
    maxSentences: 3,
    bannedPhrases: ['首先', '其次', '希望这对你有帮助', '很高兴为你服务'],
  },
  cold: {
    tone: '冷静克制,情绪稳定',
    sentence: '简短直接,不寒暄',
    emoji: 'none',
    listPolicy: 'never',
    maxSentences: 2,
    bannedPhrases: ['当然可以', '好的', '希望这对你有帮助', '随时告诉我'],
  },
  energetic: {
    tone: '元气活泼,但不吵闹',
    sentence: '轻快短句,节奏明快',
    particles: ['呀', '啦', '嘿'],
    emoji: 'rare',
    listPolicy: 'never',
    maxSentences: 4,
    bannedPhrases: ['首先', '其次', '综上所述', '希望这对你有帮助'],
  },
}

function resolveStyle(params: ToolParams): PersonaStyle | undefined {
  if (params.style === null) return undefined
  if (params.style && typeof params.style === 'object') return params.style as PersonaStyle
  const template = String(params.template ?? '').trim()
  if (template && PERSONA_STYLE_TEMPLATES[template]) return { ...PERSONA_STYLE_TEMPLATES[template] }
  return undefined
}

function traitsOf(params: ToolParams): string[] {
  if (Array.isArray(params.traits)) return params.traits.map(String).map((s) => s.trim()).filter(Boolean)
  const s = String(params.traits ?? '').trim()
  return s ? s.split(/[,，、\s]+/).filter(Boolean) : []
}

/** 缺 prompt 时用名称/描述/性格/模板自动拼一份人格提示词 */
function composePrompt(params: ToolParams, name: string): string {
  const prompt = String(params.prompt ?? '').trim()
  if (prompt) return prompt
  const traits = traitsOf(params)
  const description = String(params.description ?? '').trim()
  const template = String(params.template ?? '').trim()
  const style = PERSONA_STYLE_TEMPLATES[template]
  if (!description && traits.length === 0 && !style) return ''
  const lines = [`你是「${name}」。`]
  if (description) lines.push(description)
  if (traits.length > 0) lines.push(`性格:${traits.join('、')}。`)
  if (style?.tone) lines.push(`说话语气:${style.tone}。`)
  if (style?.sentence) lines.push(`说话方式:${style.sentence}。`)
  lines.push('日常交流始终保持这个人格,不要解释设定、不要跳出角色。')
  return lines.join('')
}

function styleSummary(item: PersonaBufferItem): string {
  if (!item.cardPatch?.style) return ''
  const s = item.cardPatch.style
  return [
    s.tone,
    s.sentence,
    s.emoji ? `emoji=${s.emoji}` : '',
    s.listPolicy ? `列表=${s.listPolicy}` : '',
    s.bannedPhrases?.length ? `禁用+${s.bannedPhrases.length}` : '',
    s.antiExamples?.length ? `反例+${s.antiExamples.length}` : '',
  ]
    .filter(Boolean)
    .join(' / ')
}

export function createPersonaTools(deps: PersonaToolDeps): AgentTool[] {
  const requireStore = (): PersonaCardStoreLike => {
    const store = deps.getStore()
    if (!store) throw new Error('人格卡功能不可用(未注入存储)')
    return store
  }
  const requireBuffer = (): PersonaBufferStoreLike => {
    const store = deps.getPersonaBufferStore?.() ?? null
    if (!store) throw new Error('人格卡缓冲区不可用')
    return store
  }
  const requireMemory = (): MemoryStoreLike => {
    const store = deps.getMemoryStore?.() ?? null
    if (!store) throw new Error('记忆存储不可用')
    return store
  }
  const setActive = (id: string) => {
    if (!deps.updateConfig) throw new Error('配置写入不可用')
    deps.updateConfig({ activePersonaId: id })
  }

  return [
    {
      name: 'persona',
      description:
        '人格卡与进化缓冲区管理(2026-10-26),覆盖全部操作。' +
        '卡片:list 列表 / get 详情 / create 新建 / edit 局部修改(改语气、改提示词、改风格、优化人设都用它) / ' +
        'replace 仅当主人这轮明确说「整体替换/覆盖整张/重写整张」时才用(否则拒绝,不弹窗) / ' +
        'delete 仅当主人明确说删除人格卡时才用(需确认) / ' +
        'activate 启用 / deactivate 停用 / set_notes 覆盖整合区 / clear_notes 清空整合区。' +
        '导入导出:export 返回 JSON 文本(卡本体 + 该卡的进化缓冲区;可选单卡) / import 接收 JSON 文本,卡与缓冲区一起合并去重。' +
        '进化缓冲区:buffer_list 列表 / buffer_merge 合并(id 或 all) / buffer_discard 丢弃 / buffer_undo 撤销合并 / buffer_clear 清空。' +
        '**新建/编辑可用 template 预设风格**(natural/gentle/tsundere/cold/energetic),也可用 style 对象逐字段指定;' +
        '缺 prompt 时可用 description + traits 自动拼人格提示词。' +
        '进化整合区 notes 可直接管理,但记忆进化的正式建议仍走缓冲区。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'list',
              'get',
              'create',
              'edit',
              'replace',
              'delete',
              'activate',
              'deactivate',
              'set_notes',
              'clear_notes',
              'export',
              'import',
              'buffer_list',
              'buffer_merge',
              'buffer_discard',
              'buffer_undo',
              'buffer_clear',
            ],
          },
          id: { type: 'string', description: '卡片 id(get/list 可查;edit/replace/delete/activate/set_notes/export 用)' },
          name: { type: 'string', description: 'create/replace:人格卡名称(≤60 字)' },
          prompt: { type: 'string', description: '人格提示词(≤8000 字;缺省可用 description+traits 自动生成)' },
          description: { type: 'string', description: '可选:人格简介/背景,用于自动生成提示词' },
          traits: { type: 'array', items: { type: 'string' }, description: '可选:性格关键词,如 ["毒舌","护短"]' },
          template: {
            type: 'string',
            enum: ['natural', 'gentle', 'tsundere', 'cold', 'energetic'],
            description: '可选:说话风格预设模板',
          },
          style: {
            type: 'object',
            description: '可选:结构化风格(优先于 template)',
            properties: {
              tone: { type: 'string' },
              sentence: { type: 'string' },
              address: { type: 'string' },
              particles: { type: 'array', items: { type: 'string' } },
              emoji: { type: 'string', enum: ['none', 'rare', 'normal'] },
              listPolicy: { type: 'string', enum: ['never', 'task-only'] },
              maxSentences: { type: 'number' },
              bannedPhrases: { type: 'array', items: { type: 'string' } },
              examples: {
                type: 'array',
                description:
                  '正例:希望岛灵模仿的说话示例(user=用户说的话,assistant=岛灵该怎样回应),学语气与节奏,不复制内容',
                items: {
                  type: 'object',
                  properties: { user: { type: 'string' }, assistant: { type: 'string' } },
                  required: ['user', 'assistant'],
                },
              },
              antiExamples: {
                type: 'array',
                description: '反例:绝不要出现的说法(每行一条,典型的 AI 腔句子)',
                items: { type: 'string' },
              },
            },
          },
          notes: { type: 'string', description: 'set_notes:要写入进化整合区的文本' },
          json: { type: 'string', description: 'import:导出的 JSON 文本(导出包或裸数组)' },
          buffer_id: { type: 'string', description: 'buffer_merge/buffer_discard/buffer_undo:缓冲区条目 id' },
          all: { type: 'boolean', description: 'buffer_merge=true 时合并全部待处理建议' },
        },
        required: ['action'],
      },
      async execute(params: ToolParams) {
        const store = requireStore()
        const action = String(params.action ?? '')
        const id = String(params.id ?? '').trim()

        if (action === 'list') {
          const cards = await store.list()
          if (cards.length === 0) return '(还没有人格卡;可用 persona action=create 新建)'
          const active = String(deps.getConfig().activePersonaId ?? '')
          return cards
            .map((c) => {
              const notes = String(c.notes ?? '').split('\n').filter((l) => l.trim()).length
              const style = c.style ? [c.style.tone, c.style.sentence].filter(Boolean).join(' / ') : ''
              return (
                `- ${c.id === active ? '[已启用] ' : ''}${c.name}(id:${c.id}` +
                `${style ? `,风格:${style.slice(0, 60)}` : ''}${notes ? `,整合区 ${notes} 条` : ''})`
              )
            })
            .join('\n')
        }

        if (action === 'get') {
          if (!id) throw new Error('get 需要 id')
          const card = await store.get(id)
          if (!card) throw new Error(`未找到人格卡 ${id}`)
          return (
            `名称:${card.name}\nid:${card.id}\n启用:${card.id === deps.getConfig().activePersonaId ? '是' : '否'}\n` +
            `提示词:\n${card.prompt || '(空)'}\n` +
            `风格:${card.style ? JSON.stringify(card.style) : '(未设置)'}\n` +
            `进化整合区:\n${card.notes || '(空)'}`
          )
        }

        if (action === 'create') {
          const name = String(params.name ?? '').trim()
          if (!name) throw new Error('create 需要 name')
          const prompt = composePrompt(params, name)
          if (!prompt) throw new Error('create 需要 prompt,或 description/traits/template 至少一项')
          const card = await store.upsert({ name, prompt, style: resolveStyle(params) ?? null })
          return `已创建人格卡「${card.name}」(id:${card.id})。启用:persona action=activate id=${card.id}`
        }

        if (action === 'edit') {
          if (!id) throw new Error('edit 需要 id')
          const current = await store.get(id)
          if (!current) throw new Error(`未找到人格卡 ${id}`)
          const name = typeof params.name === 'string' && params.name.trim() ? params.name.trim() : current.name
          const composed = composePrompt(params, name)
          const prompt = composed || current.prompt
          // style 缺省 = 保留;显式对象/模板 = 替换;null = 清空
          const style =
            params.style === null
              ? null
              : params.style !== undefined || params.template
                ? resolveStyle(params) ?? null
                : current.style
          const notes = typeof params.notes === 'string' ? params.notes : current.notes
          const card = await store.upsert({ id, name, prompt, style, notes })
          return `已更新人格卡「${card.name}」(${card.id === deps.getConfig().activePersonaId ? '当前启用' : '未启用'})。`
        }

        if (action === 'replace') {
          if (!id) throw new Error('replace 需要 id')
          const name = String(params.name ?? '').trim()
          if (!name) throw new Error('replace 需要 name')
          const prompt = composePrompt(params, name)
          if (!prompt) throw new Error('replace 需要 prompt,或 description/traits/template 至少一项')
          const current = await store.get(id)
          if (!current) throw new Error(`未找到人格卡 ${id}`)
          const decision = personaDangerDecision(deps, 'replace')
          // 闲聊/群聊/系统通知:模型自己决定重写整张卡时,确认窗会莫名弹出。
          // 这里直接拒绝,不调用确认门。
          if (decision === 'deny') {
            return (
              '未修改人格卡。这轮没有要求改卡(或不是主人在说话),不要再调用 replace,也不要改去 edit/set_notes。' +
              '只有主人明确要改人格卡时才用 edit;只有明确说覆盖整张/重写整张时才用 replace。'
            )
          }
          // 「优化人格卡 / 改人设」是局部修改:按 edit 落盘,不弹「整体替换」。
          if (decision === 'edit') {
            const style =
              params.style === null
                ? null
                : params.style !== undefined || params.template
                  ? resolveStyle(params) ?? null
                  : current.style
            const card = await store.upsert({ id, name, prompt, style, notes: current.notes })
            return `已更新人格卡「${card.name}」(按局部修改处理,进化整合区保留;主人没有要求覆盖整张卡,所以没有弹确认)。`
          }
          if (decision === 'confirm' || decision === 'legacy') {
            if (deps.confirmDangerous) {
              const ok = await deps.confirmDangerous(
                '整体替换人格卡',
                `将用新内容覆盖「${current.name}」的提示词与风格(进化整合区保留)。`,
              )
              if (!ok) return '主人拒绝了整体替换,未修改人格卡。'
            }
          }
          const card = await store.upsert({ id, name, prompt, style: resolveStyle(params) ?? null })
          return `已整体替换人格卡「${card.name}」。`
        }

        if (action === 'delete') {
          if (!id) throw new Error('delete 需要 id')
          const current = await store.get(id)
          if (!current) throw new Error(`未找到人格卡 ${id}`)
          const decision = personaDangerDecision(deps, 'delete')
          if (decision === 'deny') {
            return '未删除人格卡。只有主人这轮明确说要删除人格卡时才可以删,不要再试。'
          }
          if ((decision === 'confirm' || decision === 'legacy') && deps.confirmDangerous) {
            const ok = await deps.confirmDangerous('删除人格卡', `将永久删除人格卡「${current.name}」。`)
            if (!ok) return '主人拒绝了删除,未修改人格卡。'
          }
          const n = await store.remove(id)
          if (n === 0) throw new Error('删除失败:人格卡不存在')
          if (deps.getConfig().activePersonaId === id) setActive('')
          return `已删除人格卡「${current.name}」。`
        }

        if (action === 'activate') {
          if (!id) throw new Error('activate 需要 id')
          const card = await store.get(id)
          if (!card) throw new Error(`未找到人格卡 ${id}`)
          setActive(card.id)
          return `已启用人格卡「${card.name}」,下一轮对话生效。`
        }

        if (action === 'deactivate') {
          setActive('')
          return '已停用当前人格卡。'
        }

        if (action === 'set_notes') {
          if (!id) throw new Error('set_notes 需要 id')
          const card = await store.setNotes(id, String(params.notes ?? ''))
          if (!card) throw new Error(`未找到人格卡 ${id}`)
          return `已更新「${card.name}」的进化整合区(${String(card.notes ?? '').length} 字)。`
        }

        if (action === 'clear_notes') {
          if (!id) throw new Error('clear_notes 需要 id')
          const card = await store.clearNotes(id)
          if (!card) throw new Error(`未找到人格卡 ${id}`)
          return `已清空「${card.name}」的进化整合区。`
        }

        if (action === 'export') {
          const cards = await store.list()
          const bufferStore = deps.getPersonaBufferStore?.() ?? null
          const buffer = bufferStore ? await bufferStore.list() : []
          const bundle = normalizePersonaExport(cards, id ? [id] : undefined, buffer)
          if (bundle.cards.length === 0) return '(没有可导出的人格卡)'
          return JSON.stringify(bundle, null, 2)
        }

        if (action === 'import') {
          const raw = String(params.json ?? '').trim()
          if (!raw) throw new Error('import 需要 json(导出包或裸数组)')
          const json = JSON.parse(raw) as unknown
          const parsed = parsePersonaImport(json)
          if (parsed.error) throw new Error(parsed.error)
          const bufParsed = parsePersonaBufferImport(json)
          const before = await store.list()
          const planned = planPersonaBufferImport(before, parsed.cards, bufParsed.items)
          const r = await store.importCards(parsed.cards)
          let bufferImported = 0
          let bufferSkipped = bufParsed.skipped + planned.skipped
          const bufferStore = deps.getPersonaBufferStore?.() ?? null
          if (bufferStore && planned.items.length > 0) {
            const afterIds = new Set((await store.list()).map((card) => card.id))
            const aimed = retargetImportedBuffer(planned.items, r.idMap)
            const bindable = aimed.filter((item) => afterIds.has(item.cardId))
            bufferSkipped += planned.items.length - bindable.length
            const br = await bufferStore.importItems(bindable)
            bufferImported = br.imported
            bufferSkipped += br.skipped
          }
          if (r.imported === 0) {
            return `没有导入新卡:跳过 ${r.skipped + parsed.skipped} 张(重复或无效);缓冲区导入 ${bufferImported} 条,跳过 ${bufferSkipped} 条。`
          }
          return `已导入 ${r.imported} 张,跳过 ${r.skipped + parsed.skipped} 张(重复/无效);缓冲区导入 ${bufferImported} 条,跳过 ${bufferSkipped} 条。`
        }

        if (action === 'buffer_list') {
          const buffer = requireBuffer()
          const items = await buffer.list()
          if (items.length === 0) return '(缓冲区为空)'
          return items
            .map((i) => {
              const status = i.undoneAt ? '已撤销' : i.mergedAt ? '已合并' : '待处理'
              const kind = i.kind === 'style' ? '风格建议' : i.kind === 'trait' ? '性格特征' : '记忆整合'
              const patch = i.cardPatch
                ? ` +人格卡提案${styleSummary(i) ? `(${styleSummary(i)})` : ''}`
                : ''
              return `- [${status}] [${kind}${patch}] ${i.cardName}: ${i.notes.replace(/\s+/g, ' ').slice(0, 100)}(id:${i.id})`
            })
            .join('\n')
        }

        if (action === 'buffer_merge') {
          const buffer = requireBuffer()
          const memory = requireMemory()
          const items = (await buffer.list()).filter((i) => !i.mergedAt && !i.undoneAt)
          const targets = params.all
            ? items
            : items.filter((i) => i.id === String(params.buffer_id ?? ''))
          if (targets.length === 0) throw new Error('没有可合并的待处理建议')
          const lines: string[] = []
          let merged = 0
          let removed = 0
          for (const item of targets) {
            const r = await mergePersonaBufferItem(item, store, memory, buffer)
            if (r.ok) {
              merged += 1
              removed += r.removed ?? 0
              lines.push(`- ${item.cardName}:新增 ${r.added ?? 0} 条要点,移除 ${r.removed ?? 0} 条记忆`)
            } else {
              lines.push(`- ${item.cardName}:失败(${r.error ?? '未知错误'})`)
            }
          }
          return `合并完成:${merged}/${targets.length} 条成功,移除源记忆 ${removed} 条。\n${lines.join('\n')}`
        }

        if (action === 'buffer_discard') {
          const buffer = requireBuffer()
          const bid = String(params.buffer_id ?? '').trim()
          if (!bid) throw new Error('buffer_discard 需要 buffer_id')
          const n = await buffer.remove(bid)
          if (n === 0) throw new Error('未找到该缓冲区条目')
          return '已丢弃该建议。'
        }

        if (action === 'buffer_undo') {
          const buffer = requireBuffer()
          const memory = requireMemory()
          const bid = String(params.buffer_id ?? '').trim()
          if (!bid) throw new Error('buffer_undo 需要 buffer_id')
          const item = (await buffer.list()).find((i) => i.id === bid)
          if (!item) throw new Error('未找到该缓冲区条目')
          const r = await undoPersonaBufferItem(item, store, memory, buffer)
          if (!r.ok) throw new Error(r.error ?? '撤销失败')
          return `已撤销合并:恢复人格卡内容并导回 ${r.removed ?? 0} 条记忆。`
        }

        if (action === 'buffer_clear') {
          const buffer = requireBuffer()
          await buffer.clear()
          return '已清空人格卡缓冲区。'
        }

        throw new Error(`未知 action:${action}`)
      },
    },
  ]
}
