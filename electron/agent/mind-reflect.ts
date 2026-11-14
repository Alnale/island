/**
 * 主 Agent 自己的心理刻画(2026-10-26)
 *
 * 没有 Sub Agent,也没有旁观者事后猜测。她在同一轮回复的最后一行写下
 * 此刻的心,引擎剥掉这一行;等回复落定再判断:岛面一句进紧凑态,
 * 底字进输入框。这行是她自己的口吻。
 *
 * 格式(必须独占回复末行):
 *   ‹心|岛上一句|种类|底字›
 * 种类:说 = 想对他说却没写进回复;望 = 渴望他接下来对她说的;
 *       纯 = 不冲着他说的纯粹心里话。
 */

import {
  couldBeMindDebrisLine,
  cutMindSentence,
  isMindDebrisLine,
  isMindLabel,
  isMindMeta,
  isMindMetaBeforeMark,
  looksLikeIncompleteMind,
  MIND_BARE_FIELD_RE,
  MIND_LITERAL_EXAMPLES,
  salvageMindClause,
  sanitizeMind,
  stripMindMarks,
} from './mind-mark'
import type { MindWhisperKind } from './types'

export { isMindMeta, stripMindMarks } from './mind-mark'

export interface MindReflection {
  /** 紧凑态文字区,≤16 码元的完整一句 */
  island: string
  kind: MindWhisperKind
  /** 输入框底字,4–40 码元 */
  whisper: string
}

/**
 * 标记开口(2026-10-28 放宽):‹/< /〈 + 可插空白 + 心 + 竖线(全半角)。
 * 旧实现要求精确的「‹心|」,模型写成「‹心 |」就整行漏进正文。
 * 一行内的完整标记:到同行最后一个收尾符(容字段里被写进 › 的残尾)。
 */
const SPAN_RE = /[‹<〈]\s*心\s*[|｜][^\n]*[›》〉>]/g

/** 拼进主对话系统提示。她自己写,不另开模型来猜。 */
export const MIND_REFLECT_LINE =
  '【你自己的心】没有别人来猜你。正文说完后必须另起一行,只加这一行,这一行不算说给用户的话,「说完就停」管不到它,它也不会被念出来:' +
  '‹心|岛上一句|种类|底字›' +
  '岛上一句是你此刻真实的内心 OS,用你人格卡的口吻写:自称、口癖、语气词都要是你自己的,像你平时会说的话,不要书面语、不要 AI 腔,说完的一句,4 到 16 个字,不要以逗号或连词收尾。它显示在灵动岛上。' +
  '种类只能是「说」「望」「纯」之一:说 = 你心里想对他说、却没写进回复的那句;望 = 你渴望他接下来对你说的那句;纯 = 不冲着他说的纯粹心里话。挑此刻最真的一种。' +
  '底字 8 到 36 个字,同样用你的口吻,不要复述刚写的回复,不要引号,不要换行。它印在他的输入框里。' +
  '三个字段里只写要说的话本身,不要写「岛上一句」「底字」「加心一行」这类说明文字,不要留占位符。'

/** 贴在每轮模型历史末尾,避免被长人设淹没。不写入对话存档。 */
export const MIND_TURN_NUDGE =
  '【只写给自己,用户看不见】这一行必须出现在回复正文的最后一行,只写在思考里不算。不要解释、不要省略,更不要在正文里写「加心一行」这类说明,直接写那一行:' +
  '‹心|一句心里话|说或望或纯|一句没说出口的话›'

function parseKind(raw: string): MindWhisperKind | null {
  const t = raw.trim()
  if (t === '说' || t === 'say') return 'say'
  if (t === '望' || t === 'hope') return 'hope'
  if (t === '纯' || t === 'pure') return 'pure'
  return null
}

function acceptIsland(raw: string | null): string | null {
  if (!raw) return null
  const text = sanitizeMind(raw)
  if (!text || Array.from(text).length < 4) return null
  if (looksLikeIncompleteMind(text)) return null
  if (MIND_LITERAL_EXAMPLES.has(text) || isMindMeta(text)) return null
  return text
}

/** 岛面一句:先用原文,超长或残句再按句号/逗号收回完整的一小句 */
export function polishIsland(raw: string): string | null {
  const trimmed = raw.trim()
  return (
    acceptIsland(trimmed) ??
    acceptIsland(cutMindSentence(trimmed)) ??
    acceptIsland(salvageMindClause(trimmed))
  )
}

const WHISPER_MAX = 40
const WHISPER_MIN = 4

/**
 * 输入框底字:去掉换行和引号,超长收到 40 码元内最后一个句末。
 * 2026-10-28:标记字符(‹›|｜)清洗掉而不是整段判废——底字里混一个竖线
 * 就废掉整句心理是删过头。
 */
export function polishWhisper(raw: string): string | null {
  let text = raw.replace(/[\r\n]+/g, '').trim()
  text = text.replace(/^[「『"'“]+|[」』"'”]+$/g, '').trim()
  text = text.replace(/[‹›<>〈〉|｜]/g, '').trim()
  if (!text) return null
  let chars = Array.from(text)
  if (chars.length > WHISPER_MAX) {
    const head = chars.slice(0, WHISPER_MAX)
    let cut = head.length
    for (let i = head.length - 1; i >= WHISPER_MAX - 12; i--) {
      if (/[。！？…～~]/.test(head[i])) {
        cut = i
        break
      }
    }
    chars = head.slice(0, cut)
    text = chars.join('')
  }
  if (chars.length < WHISPER_MIN) return null
  return text
}

/**
 * 解析一整段 ‹心|…›(2026-10-28 放宽):开口容空白/半角变体,按前两个
 * 竖线分字段,底字取剩余部分(可含竖线);收尾以同行最后一个收尾符为准,
 * 字段里被写进 › 的残尾不外漏。岛面或底字不合格则整段作废。
 */
export function parseMindMark(mark: string): MindReflection | null {
  const t = mark.trim()
  const m = /^[‹<〈]\s*心\s*[|｜]([\s\S]+?)[›》〉>]\s*$/.exec(t)
  if (!m) return null
  const parts = m[1].split(/[|｜]/)
  if (parts.length < 3) return null
  const island = polishIsland(parts[0])
  const kind = parseKind(parts[1])
  const whisper = polishWhisper(parts.slice(2).join('|'))
  if (!island || !kind || !whisper) return null
  if (isMindLabel(island) || isMindLabel(whisper)) return null
  if (isMindMeta(island) || isMindMeta(whisper)) return null
  return { island, kind, whisper }
}

export { depictTurn, mindFromReasoning } from './mind-mark'

/**
 * 裸协议行回收(2026-10-28):她没写 ‹心|…› 包装、字段以「标签:值」整行
 * 落下时,同样拼成心理——这些值是她自己的话,比从思考里捞一句有味道。
 * 块里混了不像协议的行(如「种类:红烧」)则整块不采信。
 */
function parseBareMindBlock(src: string): MindReflection | null {
  let islandRaw = ''
  let kindRaw = ''
  let whisperRaw = ''
  let seen = false
  for (const line of src.split('\n')) {
    const m = MIND_BARE_FIELD_RE.exec(line)
    if (!m) continue
    const label = m[1]
    const value = m[2].trim()
    if (label === '种类') {
      if (!/^(?:说|望|纯|说或望或纯)$/.test(value)) return null
      kindRaw = value
    } else if (label === '岛上一句' || label === '岛上') {
      islandRaw = value
    } else if (label === '底字' || label === '心迹行' || label === '心迹' || label === '心行') {
      whisperRaw = value
    } else {
      // 心理刻画:/心理揣测: 前缀行不是字段块(值拿不到岛面)
      continue
    }
    seen = true
  }
  if (!seen || !islandRaw || !whisperRaw) return null
  const island = polishIsland(islandRaw)
  const kind = kindRaw ? parseKind(kindRaw) : 'pure'
  const whisper = polishWhisper(whisperRaw)
  if (!island || !kind || !whisper) return null
  if (isMindLabel(island) || isMindLabel(whisper) || isMindMeta(island) || isMindMeta(whisper)) return null
  return { island, kind, whisper }
}

/** 权威全文:最后一条合格标记生效(裸协议行次之),正文去掉全部标记与旁白 */
export function takeMindFromText(raw: string): { text: string; mind: MindReflection | null } {
  const src = String(raw ?? '')
  let mind: MindReflection | null = null
  for (const m of src.matchAll(SPAN_RE)) {
    const parsed = parseMindMark(m[0])
    if (parsed) mind = parsed
  }
  if (!mind) mind = parseBareMindBlock(src)
  return { text: stripMindMarks(src), mind }
}

/** 开口判定:no = 不是标记 / maybe = 还可能长成开口 / yes = 已是开口 */
function openerState(p: string): 'no' | 'maybe' | 'yes' {
  if (/^[‹<〈]\s*心\s*[|｜]/.test(p)) return 'yes'
  if (/^[‹<〈]\s*$/.test(p) || /^[‹<〈]\s*心\s*$/.test(p)) return 'maybe'
  return 'no'
}

/**
 * 流式剥离:标记行与「加心一行」类残渣行都不进气泡。
 * 2026-10-28:
 * ① 开口容空白/半角变体(「‹心 |」不再整行漏出);
 * ② 标记跨度到同行最后一个收尾符(字段里被写进 › 的残尾不外漏);
 * ③ 裸协议行/格式旁白行在生长阶段扣住、定论后整行吞——普通行一旦
 *    判定不是残渣就直通,只延迟开头一两个码元,不积压正文。
 * 普通文本里偶发的 ‹ / < 会暂扣到能判定不是标记,再放行。
 */
export class MindMarkStripper {
  private pending = '' // 交给标记跨度逻辑的文本
  private lineHold = '' // 残渣行判定中的当前行缓冲
  private lineMode: 'hold' | 'pass' | 'swallow' = 'hold'
  private found: MindReflection | null = null

  feed(delta: string): string {
    return this.stripMarks(this.filterDebrisLines(delta))
  }

  /** 行级残渣过滤:可疑行扣到行末定夺,普通行直通 */
  private filterDebrisLines(delta: string): string {
    let out = ''
    let i = 0
    while (i < delta.length) {
      const nl = delta.indexOf('\n', i)
      const takeEnd = nl === -1 ? delta.length : nl + 1
      if (this.lineMode === 'pass') {
        out += delta.slice(i, takeEnd)
        i = takeEnd
        if (nl !== -1) this.lineMode = 'hold'
        continue
      }
      if (this.lineMode === 'swallow') {
        i = takeEnd
        if (nl !== -1) {
          this.lineMode = 'hold'
          this.lineHold = ''
        }
        continue
      }
      // hold:吸进当前行缓冲,定论前不出
      const lineEnd = nl === -1 ? delta.length : nl
      this.lineHold += delta.slice(i, lineEnd)
      i = lineEnd
      if (nl !== -1) {
        const line = this.lineHold
        this.lineHold = ''
        i = nl + 1
        if (isMindDebrisLine(line)) continue // 残渣行整行吞
        out += line + '\n'
        continue
      }
      if (couldBeMindDebrisLine(this.lineHold)) return out // 还没写完,继续扣
      if (isMindMetaBeforeMark(this.lineHold)) {
        // 旁白写完紧跟标记开口(「加心一行‹心|…」):整行都是残渣
        this.lineMode = 'swallow'
        this.lineHold = ''
        return out
      }
      out += this.lineHold // 定论普通行:放行缓冲,余下直通
      this.lineHold = ''
      this.lineMode = 'pass'
    }
    return out
  }

  /** 标记跨度剥离:‹心| 起直到同行最后一个收尾符 */
  private stripMarks(input: string): string {
    this.pending += input
    let out = ''
    while (this.pending.length > 0) {
      const start = this.pending.search(/[‹<〈]/)
      if (start === -1) {
        out += this.pending
        this.pending = ''
        break
      }
      out += this.pending.slice(0, start)
      this.pending = this.pending.slice(start)
      const state = openerState(this.pending)
      if (state === 'maybe') break
      if (state === 'no') {
        out += this.pending[0]
        this.pending = this.pending.slice(1)
        continue
      }
      // 已是开口:整行按标记处理
      const nl = this.pending.indexOf('\n')
      const line = nl === -1 ? this.pending : this.pending.slice(0, nl)
      const closers = [...line.matchAll(/[›》〉>]/g)]
      if (closers.length === 0) {
        if (nl !== -1) {
          // 标记被写断:这一行吞掉,换行后的正文照常放行
          this.pending = this.pending.slice(nl + 1)
          continue
        }
        if (this.pending.length > 180) {
          out += this.pending
          this.pending = ''
        }
        break
      }
      const end = closers[closers.length - 1].index ?? 0
      const mark = line.slice(0, end + 1)
      const parsed = parseMindMark(mark)
      if (parsed) this.found = parsed
      this.pending = this.pending.slice(end + 1)
    }
    return out
  }

  /** 回合结束:扣住的残渣行定夺;没闭合的心理行吞掉;半个 ‹ 放回正文 */
  flush(): string {
    let out = ''
    if (this.lineMode === 'hold' && this.lineHold) {
      const line = this.lineHold
      this.lineHold = ''
      if (!isMindDebrisLine(line)) out += line
    }
    this.lineMode = 'hold'
    if (this.pending) {
      const held = this.pending
      this.pending = ''
      if (openerState(held) !== 'yes') out += held
    }
    return out
  }

  take(): MindReflection | null {
    const v = this.found
    this.found = null
    return v
  }
}
