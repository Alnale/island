/**
 * 人格风格出站清洗(2026-10-26)
 *
 * 目的:提示词只能"建议"风格,模型仍会冒默认助手腔。本模块在**消息落定
 * 与 QQ 出站边界**做确定性清洗——去 AI 开场/结尾、去未被请求的反问、
 * 去闲聊里的分点/标题/总结、按人格卡限制 emoji;代码块/表格/URL/行内
 * 代码一律原样保留。
 *
 * 全部纯函数,无 IO;调用方只在激活人格卡时启用,避免影响技术任务输出。
 */

import type { PersonaStyle } from './types'

export type StyleMode = 'chat' | 'task'

/** 默认 AI 腔开场(只匹配整段开头,避免误伤正文) */
const AI_OPEN_RE =
  /^(?:当然可以|没问题|好的|好呀|可以的)[，,、!！。.\s]*(?:我(?:来|这就|马上)?(?:帮你|为你|给你)|这就(?:帮你|为你)|很高兴为你|很乐意)[^。！？!?\n]*[。！？!?]?\s*/u
/** "作为一个 AI" 类自述(整句删除) */
const AI_SELF_RE = /(?:作为(?:一个)?(?:AI|人工智能|语言模型|AI\s*助手)|我是(?:一个)?(?:AI|人工智能|语言模型))[^。！？!?\n]*[。！？!?]?\s*/iu
/** 结尾客套(整段删除) */
const AI_CLOSE_RE =
  /(?:希望(?:这|以上|我的回答)?(?:对|能对)?你?(?:有|有所|起到)?(?:所)?帮助|如果(?:你)?(?:还)?有(?:任何|其他|别的)?(?:问题|疑问|需要)[^。！？!?\n]*|随时(?:告诉|联系|找)我|需要的话(?:可以|随时)[^。！？!?\n]*)[。！？!?]?\s*$/u
/** 未被请求的主动提议(结尾问句) */
const AI_OFFER_RE = /(?:需要我|要不要我|我可以帮你|我可以为你)[^。！？!?\n]*[？?]\s*$/u
/** 闲聊里的书面连接词(按句首删除) */
const DISCOURSE_RE = /(^|[。！？!?\n])\s*(?:首先|其次|再次|然后|另外|此外|总的来说|综上所述|总而言之|最后)[，,、]?\s*/gu
/** emoji(含变体选择符/零宽连接) */
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]|\uFE0F|\u200D/gu
/** 受保护片段:代码块 / 行内代码 / URL */
const PROTECTED_RE = /```[\s\S]*?```|`[^`\n]*`|https?:\/\/[^\s]+/g

/** 文本形态判定:代码/表格/URL → task(保留结构化排版),否则 chat */
export function styleModeForText(text: string): StyleMode {
  const t = String(text ?? '')
  if (/```|`[^`\n]+`|^\s*\|.*\|\s*$|\bhttps?:\/\//m.test(t)) return 'task'
  return 'chat'
}

/** 对非受保护片段应用清洗(代码块/行内代码/URL 原样保留) */
function mapUnprotected(text: string, fn: (chunk: string) => string): string {
  let last = 0
  let out = ''
  const re = new RegExp(PROTECTED_RE.source, PROTECTED_RE.flags)
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0
    out += fn(text.slice(last, idx))
    out += m[0]
    last = idx + m[0].length
  }
  out += fn(text.slice(last))
  return out
}

/** 按人格卡限制 emoji */
function limitEmoji(text: string, style?: PersonaStyle): string {
  if (!style || style.emoji === 'normal' || !style.emoji) return text
  if (style.emoji === 'none') return text.replace(EMOJI_RE, '')
  let seen = 0
  return text.replace(EMOJI_RE, (m) => {
    seen += 1
    return seen <= 1 ? m : ''
  })
}

/** 去掉标题、分点、加粗。listPolicy=never 时任务正文也要脱掉这些排版 */
function stripStructure(text: string): string {
  return text
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*•]|\d+[.)、])\s+/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
}

/** 闲聊模式:去标题/列表/加粗/多余换行(仅在文本较短且无代码时) */
function deFormatChat(text: string): string {
  let t = stripStructure(text)
  // 短闲聊里换行 = 分点排版,压成连续口语;长文/多段保留可读性
  if (t.length <= 500 && !/\n\s*\n/.test(t)) t = t.replace(/\n+/g, ' ')
  return t
}

/** 闲聊句数上限。按句末标点计数,不按字数硬切;没有标点的整段算一句 */
function limitSentences(text: string, max: number): string {
  if (!Number.isFinite(max) || max < 1) return text
  const pieces = text.match(/[^。！？!?\n]+[。！？!?]*|[。！？!?\n]+/g) ?? []
  let count = 0
  let out = ''
  for (const piece of pieces) {
    if (/^[。！？!?\n\s]+$/.test(piece)) {
      if (count > 0 && count <= max) out += piece
      continue
    }
    count += 1
    if (count <= max) out += piece
  }
  return out.trim()
}

/** 只保留第一个感叹号(闲聊) */
function limitExclamation(text: string): string {
  let seen = false
  return text.replace(/[！!]/g, () => {
    if (!seen) {
      seen = true
      return '！'
    }
    return '。'
  })
}

function cleanOnce(text: string, style: PersonaStyle | undefined, mode: StyleMode): string {
  let t = text
  t = t.replace(AI_SELF_RE, '')
  t = t.replace(AI_OPEN_RE, '')
  t = t.replace(AI_OFFER_RE, '')
  t = t.replace(AI_CLOSE_RE, '')
  if (style?.bannedPhrases?.length) {
    for (const phrase of style.bannedPhrases) {
      const p = String(phrase ?? '').trim()
      if (!p) continue
      t = t.split(p).join('')
    }
  }
  if (mode === 'chat') {
    t = mapUnprotected(t, (chunk) => {
      DISCOURSE_RE.lastIndex = 0
      return deFormatChat(chunk).replace(DISCOURSE_RE, '$1')
    })
    t = mapUnprotected(t, limitExclamation)
  } else if (style?.listPolicy === 'never') {
    // 带链接或代码会被判成 task,清单会漏网。never 时保护代码后仍脱掉分点
    t = mapUnprotected(t, (chunk) => {
      DISCOURSE_RE.lastIndex = 0
      return stripStructure(chunk).replace(DISCOURSE_RE, '$1')
    })
  }
  t = mapUnprotected(t, (chunk) => limitEmoji(chunk, style))
  if (mode === 'chat' && typeof style?.maxSentences === 'number') {
    t = limitSentences(t, style.maxSentences)
  }
  t = t
    .replace(/[ \t]+([，。！？；：、])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return t
}

/**
 * 出站 AI 味清洗(幂等)。
 * - 任何模式:去 AI 自述/开场/结尾客套/未请求反问;
 * - chat:去标题/分点/加粗/书面连接词,限 emoji、感叹号,并遵守 maxSentences;
 * - task:保留清单/代码/表格,只做边界客套清洗;listPolicy=never 时分点也脱掉,代码仍保留。
 * 清洗后为空时回退原文,绝不把有效内容删光。
 */
export function sanitizeAiFlavor(
  text: string,
  opts: { style?: PersonaStyle; mode?: StyleMode } = {},
): string {
  const original = String(text ?? '')
  if (!original.trim()) return original
  const mode = opts.mode ?? styleModeForText(original)
  let out = cleanOnce(original, opts.style, mode)
  // 二次清洗保证幂等(残留的"当然可以,我帮你"叠加形态)
  out = cleanOnce(out, opts.style, mode)
  if (!out.trim()) return original.trim()
  return out
}

/** AI 腔命中统计(测试/调试用;不参与线上决策) */
export function scoreAiFlavor(text: string): { score: number; hits: string[] } {
  const t = String(text ?? '')
  const hits: string[] = []
  if (AI_OPEN_RE.test(t)) hits.push('ai-opener')
  if (AI_SELF_RE.test(t)) hits.push('ai-self')
  if (AI_CLOSE_RE.test(t)) hits.push('ai-closer')
  if (AI_OFFER_RE.test(t)) hits.push('ai-offer')
  if (/^\s*(?:[-*•]|\d+[.)、])\s+/m.test(t)) hits.push('list')
  if (/^\s*#{1,6}\s+/m.test(t)) hits.push('heading')
  if (/(?:首先|其次|综上所述|总的来说|总而言之)[，,、]?/u.test(t)) hits.push('discourse')
  if (t.match(EMOJI_RE)) hits.push('emoji')
  if ((t.match(/[！!]/g) ?? []).length > 1) hits.push('exclamation')
  return { score: hits.length, hits }
}
