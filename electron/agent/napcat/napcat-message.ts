/**
 * NapCat 消息解析(纯函数簇 + 消息类型)
 *
 * 2026-08-14 插件化五期从 napcat.ts 拆出:OneBot 消息段文本化(CQ码与
 * 段数组双形态)、图片段提取、CQ 码 @ 判定——全部纯函数,无 IO/无状态;
 * 消息类型定义随函数同迁。napcat.ts barrel 兼容 re-export,
 * engine.ts/main.cjs 既有导入路径不变。
 */

import { BOT_MENTION_MARK } from './napcat-session'

// ---- 消息段文本化 ----
/** OneBot 消息 → 文本(兼容 string 与段数组;测试用导出):text 段拼接,
 * face/emoji 标注,@ 段标注(机器人自身 = （提到你）,不写 @名字,避免模型抄回去艾特自己),
 * 其它段(图片/语音/视频等)标注类型 */
export function napcatMessageText(msg: unknown, botQQ?: string): string {
  if (typeof msg === 'string') {
    // CQ码字符串消息:处理CQ:at
    return msg.replace(/\[CQ:at,qq=(\d+)(?:,name=([^\]]*))?\]/g, (_m, qq: string, name?: string) => {
      return String(qq) === String(botQQ ?? '') ? BOT_MENTION_MARK : `@${name || qq}`
    }).replace(/\[CQ:image[^\]]*\]/g, '[图片]')
      .replace(/\[CQ:record[^\]]*\]/g, '[语音]')
      .replace(/\[CQ:video[^\]]*\]/g, '[视频]')
      .replace(/\[CQ:file[^\]]*\]/g, '[文件]')
      // CQ 字符串形态的卡片:data= 内是转义后的 JSON/XML(&#44; 逗号、
      // &#91;/&#93; 方括号、&amp; &),反转义后与段数组走同一套结构化解析
      .replace(/\[CQ:(?:json|xml),data=([^\]]*)\]/g, (_m, payload: string) => {
        const unescaped = payload
          .replace(/&#44;/g, ',')
          .replace(/&#91;/g, '[')
          .replace(/&#93;/g, ']')
          .replace(/&amp;/g, '&')
        return cardLabel({ data: unescaped })
      })
      .replace(/\[CQ:json[^\]]*\]/g, '[卡片]')
      .replace(/\[CQ:xml[^\]]*\]/g, '[卡片]')
      .replace(/\[CQ:mface[^\]]*\]/g, '[表情包]')
      .replace(/\[CQ:forward[^\]]*\]/g, '[转发消息]')
      .replace(/\[CQ:reply[^\]]*\]/g, '[回复]')
      .replace(/\[CQ:face[^\]]*\]/g, '[表情]')
      .replace(/\[CQ:[a-z]+[^\]]*\]/g, (m) => `[${m.slice(4, -1).split(',')[0]}]`)
  }
  if (Array.isArray(msg)) {
    return msg
      .map((seg) => {
        const s = seg as { type?: string; data?: Record<string, unknown> }
        if (s?.type === 'text') return String(s.data?.text ?? '')
        if (s?.type === 'face' || s?.type === 'emoji') return `[${s.type}]`
        if (s?.type === 'at') {
          const qq = String(s.data?.qq ?? '')
          return qq === String(botQQ ?? '') ? BOT_MENTION_MARK : `@${qq}`
        }
        if (s?.type === 'image') return '[图片]'
        if (s?.type === 'record') return '[语音]'
        if (s?.type === 'video') return '[视频]'
        if (s?.type === 'file') {
          const name = String(s.data?.name ?? s.data?.file_name ?? '').trim()
          return name ? `[文件:${name}]` : '[文件]'
        }
        if (s?.type === 'json' || s?.type === 'xml') return cardLabel(s.data)
        if (s?.type === 'markdown') {
          const content = String(s.data?.content ?? '').trim()
          return content || '[markdown]'
        }
        if (s?.type === 'mface') return '[表情包]'
        if (s?.type === 'dice') return '[骰子]'
        if (s?.type === 'rps') return '[猜拳]'
        if (s?.type === 'poke') return '[戳一戳]'
        if (s?.type === 'forward') return '[转发消息]'
        if (s?.type === 'reply') return '[回复]'
        return `[${s.type ?? 'segment'}]`
      })
      .join('')
  }
  return String(msg ?? '')
}

// ---- 卡片消息解析(QQ小程序 / 分享 / 音乐 / 新闻等 JSON/XML 卡片) ----
/** 卡片字段清洗:HTML 实体解码 + 零宽字符剔除 + 空白压成单空格 */
function cleanCardValue(value: unknown): string {
  const decode = (code: number) => {
    try {
      return String.fromCodePoint(code)
    } catch {
      return ''
    }
  }
  return String(value ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => decode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => decode(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 字段截断(码元安全):卡片字段各有预算,防长描述把正文挤掉 */
function clipCard(value: string, max: number): string {
  const chars = Array.from(value)
  return chars.length > max ? chars.slice(0, max).join('') + '…' : value
}

/** 组合统一卡片标签:[类型:主标题 | 字段 | 链接] */
function composeCardLabel(kind: string, head: string, fields: string[]): string {
  const seen = new Set<string>()
  if (head) seen.add(head)
  const body: string[] = []
  for (const raw of fields) {
    const f = raw.trim()
    if (!f || seen.has(f)) continue
    seen.add(f)
    body.push(f)
  }
  return `[${kind}${head ? `:${clipCard(head, 60)}` : ''}${body.length ? ` | ${body.join(' | ')}` : ''}]`
}

/** URL 字段优先级:小程序深链/跳转/分享/音乐地址,http(s) 优先 */
const CARD_URL_KEYS = ['qqdocurl', 'jumpUrl', 'jump_url', 'shareUrl', 'share_url', 'musicUrl', 'music_url', 'url']

function pickCardUrl(pick: (key: string) => string): string {
  let fallback = ''
  for (const key of CARD_URL_KEYS) {
    const v = pick(key)
    if (!v) continue
    if (/^https?:\/\//i.test(v)) return clipCard(v, 160)
    if (!fallback) fallback = v
  }
  return fallback ? clipCard(fallback, 160) : ''
}

/** JSON 解析(容忍 double-encoded:string 内再套一段 JSON 字符串) */
function parseCardJson(raw: string): Record<string, unknown> | null {
  let text = raw.trim()
  for (let i = 0; i < 2; i++) {
    try {
      const parsed = JSON.parse(text) as unknown
      if (typeof parsed === 'string') {
        text = parsed.trim()
        continue
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
      return null
    } catch {
      return null
    }
  }
  return null
}

/** JSON 卡片(小程序/分享/音乐/新闻)→ 结构化标签 */
function jsonCardLabel(parsed: Record<string, unknown>): string {
  const app = cleanCardValue(parsed.app)
  const desc = cleanCardValue(parsed.desc)
  const prompt = cleanCardValue(parsed.prompt)
  // prompt 形如 "[QQ小程序]哔哩哔哩"/"[分享]标题":括号前缀是类型,余下是主标题
  const promptBody = prompt.replace(/^\[[^\]]{0,12}\]\s*/, '').trim() || prompt
  const metas: Array<Record<string, unknown>> = []
  if (parsed.meta && typeof parsed.meta === 'object' && !Array.isArray(parsed.meta)) {
    for (const v of Object.values(parsed.meta as Record<string, unknown>)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) metas.push(v as Record<string, unknown>)
    }
  }
  const extra =
    parsed.extra && typeof parsed.extra === 'object' && !Array.isArray(parsed.extra)
      ? (parsed.extra as Record<string, unknown>)
      : {}
  /** meta(多段合并)优先,再 extra,最后顶层——统一按字段取第一个非空 */
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      for (const m of metas) {
        const v = cleanCardValue(m[key])
        if (v) return v
      }
      const ev = cleanCardValue(extra[key])
      if (ev) return ev
      const tv = cleanCardValue(parsed[key])
      if (tv) return tv
    }
    return ''
  }
  /** 只取 meta 里的字段(顶层 desc 常是"QQ小程序"这类类型词,不能当正文) */
  const pickMeta = (key: string): string => {
    for (const m of metas) {
      const v = cleanCardValue(m[key])
      if (v) return v
    }
    return ''
  }
  const isMiniapp = /miniapp/i.test(app) || /QQ小程序/.test(desc) || /^\[QQ小程序\]/.test(prompt)
  const isMusic = /music/i.test(app)
  const isShare = /news|structmsg|share/i.test(app) || /分享/.test(prompt)
  const kind = isMiniapp ? 'QQ小程序' : isMusic ? '音乐卡片' : isShare ? '分享卡片' : '卡片'
  const url = pickCardUrl(pick)
  if (isMiniapp) {
    // 小程序:应用名(场景名/来源名)做主标题,正文标题/摘要/深链随后
    const appName = pick('sceneDesc', 'scene_desc', 'appName') || pickMeta('desc') || promptBody
    const title = pickMeta('title') || pick('title')
    const summary = pickMeta('summary') || pick('summary')
    return composeCardLabel(kind, appName || title, [clipCard(title, 80), clipCard(summary, 60), url])
  }
  // 分享/音乐/普通卡片:标题做主标题,描述 + 链接随后
  const title = pickMeta('title') || pick('title') || promptBody
  const summary = pickMeta('desc') || pickMeta('summary') || pick('summary')
  return composeCardLabel(kind, title, [clipCard(summary, 60), url])
}

/** XML 卡片(旧版结构化消息)→ 结构化标签 */
function xmlCardLabel(raw: string): string {
  const attr = (name: string): string => {
    const m = new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i').exec(raw)
    return cleanCardValue(m?.[2] ?? '')
  }
  const tag = (name: string): string => {
    const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i').exec(raw)
    return cleanCardValue((m?.[1] ?? '').replace(/<!\[CDATA\[|\]\]>/g, ''))
  }
  const brief = attr('brief')
  const briefKind = /^\[([^\]]{1,12})\]/.exec(brief)?.[1] ?? ''
  const briefBody = brief.replace(/^\[[^\]]{1,12}\]\s*/, '').trim()
  const source = (() => {
    const m = /<source\b[^>]*\bname\s*=\s*(["'])([\s\S]*?)\1/i.exec(raw)
    return cleanCardValue(m?.[2] ?? '')
  })()
  const title = tag('title')
  const summary = tag('summary') || tag('desc')
  const urlRaw = attr('url') || tag('url')
  const url = urlRaw ? clipCard(urlRaw, 160) : ''
  const isMiniapp = /QQ小程序/.test(brief) || /QQ小程序/.test(source)
  const kind = isMiniapp
    ? 'QQ小程序'
    : briefKind && briefKind !== '分享'
      ? briefKind
      : /分享|新闻|音乐/.test(briefKind) || /分享/.test(brief)
        ? '分享卡片'
        : '卡片'
  if (isMiniapp) {
    return composeCardLabel(kind, briefBody || source, [clipCard(title, 80), clipCard(summary, 60), url])
  }
  return composeCardLabel(kind, title || briefBody || source, [clipCard(summary, 60), url])
}

/** 卡片消息(json/xml)标签:优先结构化提取(小程序应用名/标题/摘要/深链),
 * 取不到回退 [卡片:标题] / [卡片] */
export function cardLabel(data?: Record<string, unknown>): string {
  if (!data) return '[卡片]'
  // 标准形态:卡片 JSON/XML 字符串包在 data/content/json/xml 字段里
  for (const raw of [data.data, data.content, data.json, data.xml]) {
    if (typeof raw === 'string' && raw.trim()) {
      const text = raw.trim()
      const parsed = parseCardJson(text)
      if (parsed) return jsonCardLabel(parsed)
      if (text.startsWith('<')) return xmlCardLabel(text)
    } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return jsonCardLabel(raw as Record<string, unknown>)
    }
  }
  // 段 data 直接就是卡片对象(部分实现不再包一层 data 字符串)
  if (typeof data.app === 'string' || data.meta || typeof data.prompt === 'string') {
    return jsonCardLabel(data)
  }
  const fallback = cleanCardValue(data.title) || cleanCardValue(data.summary) || cleanCardValue(data.desc)
  return fallback ? `[卡片:${clipCard(fallback, 60)}]` : '[卡片]'
}

// ---- 类型定义 ----
/** 收到的 QQ 消息(私聊;群消息复用并带 groupId) */
export interface NapcatMessage {
  qq: string
  text: string
  messageId: string
  time: number
  replied?: boolean
  images?: NapcatImage[]
  /** 语音段(2026-09-22 收语音链路:get_record 转 mp3 后作 audio media
   * part,气泡 VoiceBubble 可播放,不再只显示 [语音] 占位) */
  voices?: NapcatVoice[]
  /** 视频段(2026-10-25 全量适配:get_file 落地后作 video media part) */
  videos?: NapcatVideo[]
  /** 文件段(2026-10-25:落地后仅标注路径,不塞进 media) */
  files?: NapcatFile[]
  /** 合并转发 ID(2026-10-25:get_forward_msg 展开成文本) */
  forwardIds?: string[]
  /** 群号(有值 = 群消息,无值 = 私聊) */
  groupId?: string
}

/** 收到的群消息 */
export interface NapcatGroupMessage {
  groupId: string
  qq: string
  text: string
  atMe: boolean
  /** 这条消息 @ 到的其他人，不含机器人 */
  atQQs?: string[]
  /** 群名片或昵称 */
  senderName?: string
  messageId: string
  time: number
  images?: NapcatImage[]
  voices?: NapcatVoice[]
  videos?: NapcatVideo[]
  files?: NapcatFile[]
  forwardIds?: string[]
}

/** 消息中的图片段 */
export interface NapcatImage {
  file?: string
  url?: string
}

/** 消息中的语音段(record;file = 文件标识/路径,url = 直链) */
export interface NapcatVoice {
  file?: string
  url?: string
}

/** 消息中的视频段(video;file_id 走 get_file 落地) */
export interface NapcatVideo {
  file?: string
  file_id?: string
  url?: string
  name?: string
}

/** 消息中的文件段(file;file_id 走 get_file 落地) */
export interface NapcatFile {
  file?: string
  file_id?: string
  url?: string
  name?: string
  size?: number
}

/** 机器人发出的消息 */
export interface NapcatSentMessage {
  messageId: string
  type: 'private' | 'group'
  target: string
  text: string
  time: number
}

/** 提取消息中的图片段 */
export function napcatMessageImages(msg: unknown): NapcatImage[] {
  if (!Array.isArray(msg)) return []
  const out: NapcatImage[] = []
  for (const seg of msg) {
    const s = seg as { type?: string; data?: Record<string, unknown> }
    if (s?.type === 'image') {
      out.push({
        file: s.data?.file !== undefined ? String(s.data.file) : undefined,
        url: s.data?.url !== undefined ? String(s.data.url) : undefined,
      })
    }
  }
  return out
}

/** 提取消息中的语音段(record,2026-09-22 收语音链路;与图片提取同构) */
export function napcatMessageVoices(msg: unknown): NapcatVoice[] {
  if (!Array.isArray(msg)) return []
  const out: NapcatVoice[] = []
  for (const seg of msg) {
    const s = seg as { type?: string; data?: Record<string, unknown> }
    if (s?.type === 'record') {
      out.push({
        file: s.data?.file !== undefined ? String(s.data.file) : undefined,
        url: s.data?.url !== undefined ? String(s.data.url) : undefined,
      })
    }
  }
  return out
}

/** 提取消息中的视频段(video,2026-10-25 全量适配) */
export function napcatMessageVideos(msg: unknown): NapcatVideo[] {
  if (!Array.isArray(msg)) return []
  const out: NapcatVideo[] = []
  for (const seg of msg) {
    const s = seg as { type?: string; data?: Record<string, unknown> }
    if (s?.type === 'video') {
      out.push({
        file: s.data?.file !== undefined ? String(s.data.file) : undefined,
        file_id: s.data?.file_id !== undefined ? String(s.data.file_id) : undefined,
        url: s.data?.url !== undefined ? String(s.data.url) : undefined,
        name: s.data?.name !== undefined ? String(s.data.name) : undefined,
      })
    }
  }
  return out
}

/** 提取消息中的文件段(file,2026-10-25) */
export function napcatMessageFiles(msg: unknown): NapcatFile[] {
  if (!Array.isArray(msg)) return []
  const out: NapcatFile[] = []
  for (const seg of msg) {
    const s = seg as { type?: string; data?: Record<string, unknown> }
    if (s?.type === 'file') {
      out.push({
        file: s.data?.file !== undefined ? String(s.data.file) : undefined,
        file_id: s.data?.file_id !== undefined ? String(s.data.file_id) : undefined,
        url: s.data?.url !== undefined ? String(s.data.url) : undefined,
        name: (s.data?.name ?? s.data?.file_name) !== undefined ? String(s.data?.name ?? s.data?.file_name) : undefined,
        size: typeof s.data?.file_size === 'number' ? s.data.file_size : undefined,
      })
    }
  }
  return out
}

/** 提取消息中的合并转发 ID(forward 段,2026-10-25) */
export function napcatMessageForwardIds(msg: unknown): string[] {
  if (!Array.isArray(msg)) return []
  const out: string[] = []
  for (const seg of msg) {
    const s = seg as { type?: string; data?: Record<string, unknown> }
    if (s?.type === 'forward') {
      const id = s.data?.id ?? s.data?.message_id ?? s.data?.forward_id
      if (id !== undefined && String(id).trim()) out.push(String(id).trim())
    }
  }
  return out
}

/** 提取消息中的引用回复 ID(reply 段,2026-10-25) */
export function napcatMessageReplyId(msg: unknown): string {
  if (!Array.isArray(msg)) return ''
  for (const seg of msg) {
    const s = seg as { type?: string; data?: Record<string, unknown> }
    if (s?.type === 'reply') {
      const id = s.data?.id ?? s.data?.message_id
      if (id !== undefined && String(id).trim()) return String(id).trim()
    }
  }
  return ''
}

/** get_forward_msg 返回体里的节点列表(2026-10-27 抽出共用):兼容
 * messages/message/content 三种包装与"根即数组"形态,最多 20 条 */
function forwardNodesOf(data: unknown): Array<Record<string, unknown>> {
  let nodes: unknown[] = []
  if (Array.isArray(data)) {
    nodes = data
  } else {
    const obj = (data ?? {}) as Record<string, unknown>
    nodes = Array.isArray(obj.messages)
      ? obj.messages
      : Array.isArray(obj.message)
        ? obj.message
        : Array.isArray(obj.content)
          ? obj.content
          : []
  }
  return nodes.slice(0, 20).map((raw) => (raw ?? {}) as Record<string, unknown>)
}

/** CQ 码字符串 → 段数组(2026-10-27:合并转发节点正文的字符串形态;
 * 只还原段结构与参数值的 CQ 反转义,不做展示文案映射) */
function cqStringSegments(msg: string): Array<{ type: string; data: Record<string, string> }> {
  const out: Array<{ type: string; data: Record<string, string> }> = []
  const re = /\[CQ:([a-zA-Z_]+)((?:,[^\]]*)*)\]/g
  for (const m of msg.matchAll(re)) {
    const data: Record<string, string> = {}
    const params = (m[2] ?? '').replace(/^,/, '')
    for (const kv of params.split(',')) {
      const eq = kv.indexOf('=')
      if (eq <= 0) continue
      data[kv.slice(0, eq)] = kv
        .slice(eq + 1)
        .replace(/&#44;/g, ',')
        .replace(/&#91;/g, '[')
        .replace(/&#93;/g, ']')
        .replace(/&amp;/g, '&')
    }
    out.push({ type: m[1] ?? '', data })
  }
  return out
}

/** 节点正文 → 段数组(2026-10-27:content/message 可能是段数组或 CQ 字符串) */
function forwardNodeSegments(node: Record<string, unknown>): unknown[] {
  const content = node.content ?? node.message ?? ''
  if (Array.isArray(content)) return content
  if (typeof content === 'string') return cqStringSegments(content)
  return []
}

/** 合并转发内容 → 可读文本(2026-10-25:get_forward_msg 的 data 交给 LLM) */
export function napcatForwardText(data: unknown): string {
  const lines: string[] = []
  for (const node of forwardNodesOf(data)) {
    const sender = (node.sender ?? {}) as Record<string, unknown>
    const name = String(sender.nickname ?? node.nickname ?? '').trim()
    const qq = String(sender.user_id ?? node.user_id ?? '').trim()
    const content = node.content ?? node.message ?? ''
    const text = napcatMessageText(content).replace(/\s+/g, ' ').trim()
    if (!text && !name) continue
    lines.push(`- ${name || qq}${name && qq ? `(${qq})` : ''}:${text.slice(0, 100)}`)
  }
  return lines.join('\n')
}

/** 合并转发节点里的媒体资源 */
export interface NapcatForwardMedia {
  images: NapcatImage[]
  voices: NapcatVoice[]
  videos: NapcatVideo[]
  files: NapcatFile[]
}

/** 合并转发节点里的媒体资源(2026-10-27:图片/语音/视频/文件段的实际
 * 资源引用,不再只有 [图片] 等占位):遍历节点正文(段数组或 CQ 字符串),
 * 按 kind+url/file/file_id 去重;三项全无的段丢弃(拿不到资源) */
export function napcatForwardMedia(data: unknown): NapcatForwardMedia {
  const images: NapcatImage[] = []
  const voices: NapcatVoice[] = []
  const videos: NapcatVideo[] = []
  const files: NapcatFile[] = []
  const seen = new Set<string>()
  const take = <T extends { file?: string; url?: string; file_id?: string }>(
    kind: string,
    list: T[],
    out: T[],
  ): void => {
    for (const item of list) {
      const key = item.url || item.file || item.file_id || ''
      if (!key || seen.has(`${kind}:${key}`)) continue
      seen.add(`${kind}:${key}`)
      out.push(item)
    }
  }
  for (const node of forwardNodesOf(data)) {
    const segs = forwardNodeSegments(node)
    take('img', napcatMessageImages(segs), images)
    take('voice', napcatMessageVoices(segs), voices)
    take('video', napcatMessageVideos(segs), videos)
    take('file', napcatMessageFiles(segs), files)
  }
  return { images, voices, videos, files }
}

/** 合并转发节点里嵌套的合并转发 ID(2026-10-27:内嵌合并消息可继续展开) */
export function napcatForwardNestedIds(data: unknown): string[] {
  const out: string[] = []
  for (const node of forwardNodesOf(data)) {
    for (const id of napcatMessageForwardIds(forwardNodeSegments(node))) {
      if (id && !out.includes(id)) out.push(id)
    }
  }
  return out
}

/** 消息里 @ 到的 QQ。不含机器人自己，也不含 all。 */
export function napcatMessageAtQQs(msg: unknown, botQQ?: string): string[] {
  const found: string[] = []
  const add = (qq: string) => {
    const id = String(qq ?? '').trim()
    if (!/^\d{5,12}$/.test(id)) return
    if (botQQ && id === botQQ) return
    if (!found.includes(id)) found.push(id)
  }
  if (Array.isArray(msg)) {
    for (const seg of msg) {
      const row = seg as { type?: string; data?: { qq?: unknown } }
      if (row?.type === 'at') add(String(row.data?.qq ?? ''))
    }
    return found
  }
  if (typeof msg === 'string') {
    const re = /\[CQ:at,qq=(\d+)(?:,|\])/g
    for (const m of msg.matchAll(re)) add(m[1] ?? '')
  }
  return found
}

/** OneBot sender 上的群名片优先，没有就用昵称。 */
export function napcatSenderName(sender: unknown): string {
  if (!sender || typeof sender !== 'object') return ''
  const row = sender as { card?: unknown; nickname?: unknown }
  const card = String(row.card ?? '').trim()
  const nick = String(row.nickname ?? '').trim()
  return card || nick
}

/** 检测CQ码字符串消息中的atMe(段数组已在napcatMessageText处理,这里单独检测) */
export function cqAtMe(raw: unknown, botQQ: string): boolean {
  if (typeof raw === 'string') {
    return new RegExp(`\\[CQ:at,qq=${botQQ}(?:,|\\])`).test(raw)
  }
  return false
}

/** OneBot/NapCat 偶发空包:无正文且无图片(含零宽字符/纯空白)。
 * 这类事件进对话会变成"空消息气泡",实际并没有人说话 */
const ZERO_WIDTH_RE = /[\u200b-\u200d\ufeff]/g

export function napcatIncomingIsBlank(text: string, images?: NapcatImage[]): boolean {
  if (Array.isArray(images) && images.some((img) => img && (img.file || img.url))) return false
  return String(text ?? '').replace(ZERO_WIDTH_RE, '').trim().length === 0
}

/** 不是真实聊天的 message 子类型(输入状态/戳一戳/通知),应丢弃 */
export function napcatMessageSubTypeNoise(subType: unknown): boolean {
  const t = String(subType ?? '').toLowerCase()
  return t === 'notice' || t === 'input_status' || t === 'poke' || t === 'typing'
}

/**
 * 该群消息是否放行进对话(2026-09-03,修复"发到未监听群后收不到回复"):
 * - 监听名单为空 = 收全部群(与 set_napcat_config 文案一致);
 * - 在名单里 = 收;
 * - 本进程已向该群发过/已 watch 的临时放行(发完必须能听见回复,等
 *   配置落盘前的窗口也要通)。unwatch 会从 extraListen 移除。
 */
export function shouldAdmitGroupMessage(
  allowedGroups: string[] | undefined,
  groupId: string,
  extraListen?: Iterable<string>,
): boolean {
  const id = String(groupId ?? '')
  if (!id) return false
  const groups = allowedGroups ?? []
  if (groups.length === 0) return true
  if (groups.includes(id)) return true
  if (!extraListen) return false
  for (const g of extraListen) {
    if (String(g) === id) return true
  }
  return false
}
