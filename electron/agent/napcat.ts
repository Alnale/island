/**
 * NapCat QQ 机器人桥(2026-08-14 全面优化版)
 *
 * OneBot 11 协议 WebSocket 客户端,零第三方依赖(全局 WebSocket,Node 22+):
 * - 正向 WS 连接 NapCat(默认 ws://127.0.0.1:3001),断线指数退避重连+熔断;
 * - 收到**私聊消息**事件 → 回调 onMessage(QQ 号 + 文本)——main.cjs 转发
 *   渲染端作为用户消息进入对话(同步上下文),LLM 回复后经 sendToQQ 发回
 *    QQ(用户要求"对话窗口和 QQ 自己回复我");
 * - 收到**群消息**事件 → 回调 onGroupMessage(群号 + QQ + 文本)——main.cjs
 *   自主判断是否接话(防刷屏),接话进对话,回复发回群;
 * - 长期记忆自动生效(QQ 对话走主引擎,系统提示含记忆块);
 * - 消息缓存(可配置,默认50条)供 napcat 工具查询;
 * - 去重持久化(重启不丢),文件写队列防并发,危险操作确认门。
 *
 * 协议要点(OneBot 11):
 * - 事件:{"post_type":"message","message_type":"private|group","user_id":...,
 *   "group_id":...,"message":"文本","raw_message":"文本","message_id":...,"time":...}
 *   (message 可能是 string 或段数组,统一转文本;@ 段标注);
 * - 动作:{"action":"send_private_msg|send_group_msg","params":{...},"echo":".."},
 *   响应 {"status":"ok","retcode":0,"data":{"message_id":..}};
 * - 心跳:服务端发 heartbeat 事件,客户端无需响应。
 */

import { existsSync, promises as fs } from 'node:fs'
import { randomInt } from 'node:crypto'
import path from 'node:path'
import { app } from 'electron'
import type { AgentConfig, AgentTool, ToolParams } from './types'
import { MASTER_QQ } from './constants'
import { createWsSocket, type WsConn } from './wsclient'

// ---- 默认配置常量(可被 agent 配置覆盖) ----
const DEFAULT_WS_URL = 'ws://127.0.0.1:3001'
const DEFAULT_CACHE_SIZE = 50
const DEFAULT_SENT_SIZE = 50
const DEFAULT_CHATS_SIZE = 200 // 减少聊天记录条数(原500过大)
const MAX_CHAT_TEXT_LEN = 2000 // 单条聊天记录文本截断
const ACTION_TIMEOUT_MS = 15000
// 文件/视频上传超时(2026-08-14 修复):upload_private_file/upload_group_file
// 大视频上传到 QQ 动辄几十秒,原统一 15s 会先触发超时——QQ 实际收到了
// 视频但工具报"超时失败",LLM 误报没发成功;延长到 180s
const FILE_UPLOAD_TIMEOUT_MS = 180_000
const MAX_IMAGE_SIZE = 20 * 1024 * 1024 // 20MB(原50MB过大)
const MAX_RECONNECT_FAILS = 10 // 连续失败N次后熔断
const IMAGE_DOWNLOAD_TIMEOUT_MS = 10000 // 图片下载超时
const RECONNECT_CAP_MS = 30000
const SEEN_TTL_MS = 60 * 60 * 1000 // 去重ID 1小时过期
const SEEN_CLEANUP_INTERVAL_MS = 10 * 60 * 1000 // 10分钟清理一次过期ID
const QZONE_RATE_LIMIT_MS = 1000 // QQ空间接口最小间隔

// ---- 消息段文本化 ----
/** OneBot 消息 → 文本(兼容 string 与段数组;测试用导出):text 段拼接,
 * face/emoji 标注,@ 段标注(机器人自身 = @鲸鱼娘),其它段(图片/语音/视频等)标注类型 */
export function napcatMessageText(msg: unknown, botQQ?: string): string {
  if (typeof msg === 'string') {
    // CQ码字符串消息:处理CQ:at
    return msg.replace(/\[CQ:at,qq=(\d+)(?:,name=([^\]]*))?\]/g, (_m, qq: string, name?: string) => {
      return String(qq) === String(botQQ ?? '') ? '@鲸鱼娘' : `@${name || qq}`
    }).replace(/\[CQ:image[^\]]*\]/g, '[图片]')
      .replace(/\[CQ:record[^\]]*\]/g, '[语音]')
      .replace(/\[CQ:video[^\]]*\]/g, '[视频]')
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
          return qq === String(botQQ ?? '') ? '@鲸鱼娘' : `@${qq}`
        }
        if (s?.type === 'image') return '[图片]'
        if (s?.type === 'record') return '[语音]'
        if (s?.type === 'video') return '[视频]'
        if (s?.type === 'forward') return '[转发消息]'
        if (s?.type === 'reply') return '[回复]'
        return `[${s.type ?? 'segment'}]`
      })
      .join('')
  }
  return String(msg ?? '')
}

// ---- 类型定义 ----
/** 收到的 QQ 消息(私聊) */
export interface NapcatMessage {
  qq: string
  text: string
  messageId: string
  time: number
  replied?: boolean
  images?: NapcatImage[]
}

/** 收到的群消息 */
export interface NapcatGroupMessage {
  groupId: string
  qq: string
  text: string
  atMe: boolean
  messageId: string
  time: number
  images?: NapcatImage[]
}

/** 消息中的图片段 */
export interface NapcatImage {
  file?: string
  url?: string
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

/** 检测CQ码字符串消息中的atMe(段数组已在napcatMessageText处理,这里单独检测) */
function cqAtMe(raw: unknown, botQQ: string): boolean {
  if (typeof raw === 'string') {
    return new RegExp(`\\[CQ:at,qq=${botQQ}(?:,|\\])`).test(raw)
  }
  return false
}

/** 连接状态 */
export interface NapcatStatus {
  connected: boolean
  url: string
  lastError: string
  receivedCount: number
  repliedCount: number
  allowed?: string[]
  allowedGroups?: string[]
  circuitBroken?: boolean
}

/** 通知事件(撤回/好友请求/群邀请) */
export interface NapcatNotice {
  type: 'group_recall' | 'friend_recall' | 'friend_request' | 'group_request' | 'group_increase' | 'group_decrease'
  /** 相关QQ号(操作者/申请人) */
  userId?: string
  /** 群号 */
  groupId?: string
  /** 被操作者(被踢/加入) */
  targetId?: string
  /** 请求flag(需通过操作接受/拒绝) */
  flag?: string
  /** 附加信息(验证消息/理由) */
  comment?: string
}

/** 主进程注入的依赖 */
export interface NapcatDeps {
  getConfig(): AgentConfig
  onMessage(msg: NapcatMessage): void
  onGroupMessage(msg: NapcatGroupMessage): void
  notify?(title: string, body: string): void
  listSessions?(): Array<{ key: string; title: string; kind: 'private' | 'group'; muted: boolean }>
  muteSession?(key: string, muted: boolean): void
  bindSession?(key: string): void
  /** 监听增删(2026-08-14 manage_sessions 工具):写 napcatAllowed /
   * napcatAllowedGroups 配置 → applyAgentConfigPatch 自动广播会话种子,
   * 渲染端会话面板立即建条目 */
  watchSession?(kind: 'private' | 'group', id: string): void
  unwatchSession?(kind: 'private' | 'group', id: string): void
  onSent?(msg: { type: 'private' | 'group'; target: string; text: string; images?: string[] }): void
  /** 错误上报(不再静默catch——发送失败/API错误经此回调通知主进程) */
  onError?(message: string): void
  /** 通知事件(撤回/好友请求等) */
  onNotice?(notice: NapcatNotice): void
}

// ---- 联系人档案 ----
export interface NapcatContact {
  qq: string
  name?: string
  info?: string
  source?: 'private' | 'group'
  updatedAt: number
}

/** 档案卡聚合(联系人+人格+记忆+最近发言) */
export function buildProfileCard(
  qq: string,
  data: {
    contact?: NapcatContact | null
    persona?: string
    memories?: Array<{ content: string }>
    chats?: Array<{ id?: string; text: string; type?: string }>
    excludeId?: string
  },
): string {
  const lines: string[] = []
  const name = data.contact?.name?.trim()
  const info = data.contact?.info?.trim()
  const persona = data.persona?.trim()
  const displayName = name || (qq === MASTER_QQ ? '主人' : '(未知)')
  lines.push(`称呼:${displayName}`)
  if (info) lines.push(`已知:${info.slice(0, 300)}`)
  if (persona) lines.push(`会话人格:${persona.slice(0, 200)}`)
  const mems = (data.memories ?? [])
    .map((m) => m.content.trim())
    .filter((c) => c && (c.includes(qq) || (name ? c.includes(name) : false)))
    .slice(0, 4)
  if (mems.length > 0) {
    lines.push('记忆相关:')
    for (const c of mems) lines.push(`- ${c.slice(0, 120)}`)
  }
  const chats = (data.chats ?? [])
    .filter((c) => c && typeof c.text === 'string' && c.text.trim() && c.id !== data.excludeId)
    .slice(-3)
  if (chats.length > 0) {
    lines.push('最近发言:')
    for (const c of chats) {
      const channel = c.type === 'group' ? '群聊' : '私聊'
      lines.push(`- [${channel}] ${c.text.replace(/\s+/g, ' ').trim().slice(0, 50)}`)
    }
  }
  if (lines.length === 1) lines.push('(尚无已知信息,交流中可用 contact_update 记录)')
  return lines.join('\n')
}

// ---- 会话键 ----
export function sessionKeyFor(qq: string, groupId?: string): string {
  return groupId ? `group:${groupId}` : `private:${qq}`
}
export function isValidSessionKey(key: string): boolean {
  return /^(private:\d+|group:\d+)$/.test(key)
}

// ---- 回复标记 ----
export const REPLY_TO_STRANGER_MARK = '【回复对方】'
export function extractReplyToStranger(text: string): string | null {
  if (!String(text).startsWith(REPLY_TO_STRANGER_MARK)) return null
  return String(text).slice(REPLY_TO_STRANGER_MARK.length).trim()
}

// ---- 防重发判定 ----
export function turnAlreadySentToTarget(
  now: Array<{ type: string; target: string }>,
  before: number,
  type: string,
  target: string,
): boolean {
  return now.filter((s) => s.type === type && s.target === target).length > before
}
export function turnAlreadySentToPending(
  now: Array<{ type: string; target: string }>,
  before: number,
  qq: string,
): boolean {
  return turnAlreadySentToTarget(now, before, 'private', qq)
}

// ---- 询问轮判定(给主人的话不外发) ----
const ASK_TURN_STRONG = [
  /你说回/,
  /你(想|要|说)怎么回/,
  /等你(的)?(指示|发话)/,
  /问(问|一下)?主人/,
  /要不要我(回|发|说)/,
  /我建议[^。！？]{0,12}(回|发|说)/,
  /要(不)要我[^。！？]{0,10}(回|发|说)他/,
]
const ASK_TURN_WEAK = [
  /怎么回/,
  /(回|发|说)(他|她|他们|对方)[^。！？]{0,8}(什么|啥|点啥|吗|吧|如何|怎样|怎么样)/,
]
const ASK_TURN_QUESTION_END = /[?？~～…]$|[吗吧呢呀好]$/
export function isAskTurnToMaster(text: string): boolean {
  const t = String(text ?? '')
  if (!t.trim()) return false
  if (ASK_TURN_STRONG.some((re) => re.test(t))) return true
  return ASK_TURN_QUESTION_END.test(t.trim()) && ASK_TURN_WEAK.some((re) => re.test(t))
}

// ---- 轮次指纹 ----
const FINGERPRINT_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const FINGERPRINT_LEN = 6
export function newTurnFingerprint(): string {
  let out = ''
  for (let i = 0; i < FINGERPRINT_LEN; i++) {
    out += FINGERPRINT_ALPHABET[randomInt(FINGERPRINT_ALPHABET.length)]
  }
  return out
}
export function fingerprintMark(fp: string): string {
  return `【指纹:${fp}】`
}
export function stripFingerprintMarks(text: string): string {
  return String(text ?? '').replace(/【指纹:[2-9A-HJ-NP-Z]{6}】/g, '')
}
export function extractTurnFingerprint(text: string, fp: string): { content: string } | null {
  const t = String(text ?? '')
    .replace(/^\s*/, '')
    .replace(/^【回复对方】\s*/, '')
    .trimStart()
  const mark = fingerprintMark(fp)
  if (!t.startsWith(mark)) return null
  return { content: t.slice(mark.length).trim() }
}

// ---- 用户数据目录 ----
function userDataDir(): string {
  try {
    return app.getPath('userData')
  } catch {
    return path.join(process.env.APPDATA ?? '', 'dynamic-island')
  }
}

// ---- 文件路径 ----
export function napcatContactsPath(): string {
  return path.join(userDataDir(), 'napcat-contacts.json')
}
export function napcatChatsPath(): string {
  return path.join(userDataDir(), 'napcat-chats.json')
}
export function napcatPersonasPath(): string {
  return path.join(userDataDir(), 'napcat-personas.json')
}
function napcatSeenPath(): string {
  return path.join(userDataDir(), 'napcat-seen.json')
}

// ---- 聊天记录 ----
export interface NapcatChatRecord {
  id: string
  type: 'private' | 'group'
  target: string
  qq: string
  text: string
  atMe?: boolean
  time: number
}
export function personaScope(type: 'private' | 'group', target: string): string {
  return `${type}:${target}`
}
export interface NapcatPersona {
  persona: string
  updatedAt: number
}

// ---- 去重持久化 ----
interface SeenData {
  /** messageId -> timestamp(ms) */
  ids: Record<string, number>
}
let seenData: SeenData = { ids: {} }
let seenLoaded = false
async function loadSeen(): Promise<void> {
  if (seenLoaded) return
  try {
    const raw = await fs.readFile(napcatSeenPath(), 'utf8')
    const obj = JSON.parse(raw) as Partial<SeenData>
    if (obj && typeof obj === 'object' && obj.ids && typeof obj.ids === 'object') {
      seenData = { ids: obj.ids }
    }
  } catch {
    seenData = { ids: {} }
  }
  seenLoaded = true
  // 清理过期ID
  pruneSeen()
}
let seenWriteChain: Promise<unknown> = Promise.resolve()
function saveSeen(): void {
  seenWriteChain = seenWriteChain.then(async () => {
    try {
      const p = napcatSeenPath()
      await fs.mkdir(path.dirname(p), { recursive: true })
      const tmp = p + '.tmp'
      await fs.writeFile(tmp, JSON.stringify(seenData), 'utf8')
      await fs.rename(tmp, p)
    } catch {
      // 写入失败静默(去重是增强功能)
    }
  }).catch(() => {})
}
function pruneSeen(): void {
  const now = Date.now()
  let changed = false
  for (const [id, ts] of Object.entries(seenData.ids)) {
    if (now - ts > SEEN_TTL_MS) {
      delete seenData.ids[id]
      changed = true
    }
  }
  if (changed) saveSeen()
}
function seenHas(id: string): boolean {
  if (!id) return false
  return Object.prototype.hasOwnProperty.call(seenData.ids, id)
}
function seenAdd(id: string): void {
  if (!id) return
  seenData.ids[id] = Date.now()
  // 限制总量不超过5000条(防止无限增长)
  const keys = Object.keys(seenData.ids)
  if (keys.length > 5000) {
    // 删除最旧的一半
    const sorted = keys.sort((a, b) => seenData.ids[a] - seenData.ids[b])
    for (let i = 0; i < sorted.length / 2; i++) delete seenData.ids[sorted[i]]
  }
  saveSeen()
}

// ---- 联系人持久化(带内存缓存+写队列) ----
let contactWriteChain: Promise<unknown> = Promise.resolve()
let contactsCache: Record<string, NapcatContact> | null = null
let contactsCacheLoaded = false

export async function loadNapcatContacts(): Promise<Record<string, NapcatContact>> {
  if (contactsCacheLoaded && contactsCache) return { ...contactsCache }
  try {
    const raw = await fs.readFile(napcatContactsPath(), 'utf8')
    const obj = JSON.parse(raw) as Record<string, Partial<NapcatContact>>
    const out: Record<string, NapcatContact> = {}
    for (const [qq, c] of Object.entries(obj)) {
      if (c && typeof c === 'object' && typeof qq === 'string') {
        out[qq] = {
          qq,
          name: typeof c.name === 'string' ? c.name.slice(0, 50) : undefined,
          info: typeof c.info === 'string' ? c.info.slice(0, 500) : undefined,
          source: c.source === 'group' ? 'group' : 'private',
          updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : 0,
        }
      }
    }
    contactsCache = { ...out }
    contactsCacheLoaded = true
    return out
  } catch {
    contactsCache = {}
    contactsCacheLoaded = true
    return {}
  }
}
export async function saveNapcatContacts(contacts: Record<string, NapcatContact>): Promise<void> {
  contactsCache = { ...contacts }
  contactsCacheLoaded = true
  contactWriteChain = contactWriteChain.then(async () => {
    try {
      const p = napcatContactsPath()
      await fs.mkdir(path.dirname(p), { recursive: true })
      const tmp = p + '.tmp'
      await fs.writeFile(tmp, JSON.stringify(contacts, null, 2), 'utf8')
      await fs.rename(tmp, p)
    } catch (e) {
      console.warn('[napcat] save contacts failed:', (e as Error)?.message)
    }
  }).catch(() => {})
  await contactWriteChain
}

// ---- 聊天记录持久化(带内存缓存+写队列,性能优化) ----
let chatWriteChain: Promise<unknown> = Promise.resolve()
let chatsCache: NapcatChatRecord[] | null = null
let chatsCacheLoaded = false

export async function loadNapcatChats(maxChats?: number): Promise<NapcatChatRecord[]> {
  if (chatsCacheLoaded && chatsCache) {
    const limit = maxChats ?? DEFAULT_CHATS_SIZE
    return chatsCache.slice(-limit)
  }
  try {
    const raw = await fs.readFile(napcatChatsPath(), 'utf8')
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) {
      chatsCache = []
      chatsCacheLoaded = true
      return []
    }
    chatsCache = arr.filter(
      (c): c is NapcatChatRecord =>
        !!c &&
        typeof c === 'object' &&
        typeof (c as NapcatChatRecord).id === 'string' &&
        typeof (c as NapcatChatRecord).text === 'string' &&
        ((c as NapcatChatRecord).type === 'private' || (c as NapcatChatRecord).type === 'group'),
    ).map(c => ({
      ...c,
      text: c.text.length > MAX_CHAT_TEXT_LEN ? c.text.slice(0, MAX_CHAT_TEXT_LEN) + '…(截断)' : c.text,
    }))
    chatsCacheLoaded = true
    const limit = maxChats ?? DEFAULT_CHATS_SIZE
    return chatsCache.slice(-limit)
  } catch {
    chatsCache = []
    chatsCacheLoaded = true
    return []
  }
}
export function appendNapcatChat(record: NapcatChatRecord, maxChats?: number): void {
  // 消息文本截断(防止超大消息占用内存和磁盘)
  const safeRecord: NapcatChatRecord = {
    ...record,
    text: record.text.length > MAX_CHAT_TEXT_LEN 
      ? record.text.slice(0, MAX_CHAT_TEXT_LEN) + '…(截断)' 
      : record.text,
  }
  chatWriteChain = chatWriteChain
    .then(async () => {
      if (!chatsCacheLoaded) await loadNapcatChats(maxChats)
      const chats = chatsCache ?? []
      if (chats.some((c) => c.id === safeRecord.id)) return
      chats.push(safeRecord)
      const limit = maxChats ?? DEFAULT_CHATS_SIZE
      const trimmed = chats.length > limit ? chats.slice(-limit) : chats
      chatsCache = trimmed
      const p = napcatChatsPath()
      await fs.mkdir(path.dirname(p), { recursive: true })
      const tmp = p + '.tmp'
      await fs.writeFile(tmp, JSON.stringify(trimmed, null, 1), 'utf8')
      await fs.rename(tmp, p)
    })
    .catch((err) => console.warn('[napcat] append chat failed:', err?.message))
}

// ---- 人格持久化(带写队列) ----
let personaWriteChain: Promise<unknown> = Promise.resolve()
export async function loadNapcatPersonas(): Promise<Record<string, NapcatPersona>> {
  try {
    const raw = await fs.readFile(napcatPersonasPath(), 'utf8')
    const obj = JSON.parse(raw) as Record<string, Partial<NapcatPersona>>
    const out: Record<string, NapcatPersona> = {}
    for (const [scope, p] of Object.entries(obj)) {
      if (p && typeof p === 'object' && typeof p.persona === 'string' && p.persona.trim()) {
        out[scope] = { persona: p.persona.trim().slice(0, 500), updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : 0 }
      }
    }
    return out
  } catch {
    return {}
  }
}
export async function saveNapcatPersona(scope: string, persona: string): Promise<NapcatPersona | null> {
  return new Promise((resolve) => {
    personaWriteChain = personaWriteChain.then(async () => {
      try {
        const personas = await loadNapcatPersonas()
        const p = napcatPersonasPath()
        await fs.mkdir(path.dirname(p), { recursive: true })
        if (!persona.trim()) {
          delete personas[scope]
          const tmp = p + '.tmp'
          await fs.writeFile(tmp, JSON.stringify(personas, null, 2), 'utf8')
          await fs.rename(tmp, p)
          resolve(null)
          return
        }
        const next: NapcatPersona = { persona: persona.trim().slice(0, 500), updatedAt: Math.floor(Date.now() / 1000) }
        personas[scope] = next
        const tmp = p + '.tmp'
        await fs.writeFile(tmp, JSON.stringify(personas, null, 2), 'utf8')
        await fs.rename(tmp, p)
        resolve(next)
      } catch {
        resolve(null)
      }
    }).catch(() => resolve(null))
  })
}

// ---- QQ空间 g_tk 计算 ----
export function gtkFromCookie(cookie: string): string {
  const m = /p_skey=([^;]+)/.exec(cookie) ?? /skey=([^;]+)/.exec(cookie)
  if (!m) return ''
  let hash = 5381
  for (let i = 0; i < m[1].length; i++) hash += (hash << 5) + m[1].charCodeAt(i)
  return String(hash & 0x7fffffff)
}

// ---- 文本清洗函数 ----
/** 工具调用叙述句剥离(对外人不暴露内部工作流) */
const TOOL_NARRATION_ACTION =
  /(我去|我来|我直接|我先|我再|我换|我细看|我用|我基于|我拿到|拿到|我找到|找到|拿到了|发现|定位|我挖|我探|我绘|我调用|我搜|我开|我拼|我测|我下载|我解析|我查|探测|拼接|绘制|下载|解析|抓取|爬取|请求|接口是|接口走)/
const TOOL_NARRATION_WORD =
  /(接口|API|api|数据源|数据端点|端点|路径|域名|JS|脚本|命令|直播间|URL|网址|matplotlib|环境|胜率曲线|曲线|cookies|二维码|数据库|服务器|fetch|请求|响应|解析|网页|抓|爬|绘图|拼接|打开网页|打开浏览器|数据)/
export function stripToolNarration(text: string): string {
  const t = String(text ?? '').trim()
  if (!t) return t
  const sentences = t.split(/(?<=[。！？!?\n])/).map((s) => s.replace(/^[^\S\n]*/, ''))
  if (sentences.length < 2) return t
  const isNarration = (s: string) => TOOL_NARRATION_ACTION.test(s) && TOOL_NARRATION_WORD.test(s)
  const flags = sentences.map(isNarration)
  const keep: string[] = []
  let i = 0
  while (i < sentences.length) {
    if (flags[i]) {
      let j = i
      while (j < sentences.length && flags[j]) j++
      if (j - i >= 2) {
        i = j
        continue
      }
    }
    keep.push(sentences[i])
    i++
  }
  const out = keep.join('').trim()
  return out || t
}

/** 主人视角叙述句剥离(「展示给你看」「他回你了」不外发) */
const MASTER_NARRATION_RE =
  /(他|她)(回你|回我|发来|发的是|发了|在回|回应)|(回你|回你了|发来)|(给你看|展示给|展示在|先展示)|(窗口里|你可以看看)|(识别一下|识别出来|临时文件|清理掉|清理了|顺便把)/
export function stripMasterNarration(text: string): string {
  const t = String(text ?? '').trim()
  if (!t) return t
  const sentences = t.split(/(?<=[。！？!?\n])/).map((s) => s.replace(/^[^\S\n]*/, ''))
  if (sentences.length < 2) return t
  const flags = sentences.map((s) => MASTER_NARRATION_RE.test(s))
  const keep: string[] = []
  let i = 0
  while (i < sentences.length) {
    if (flags[i]) {
      let j = i
      while (j < sentences.length && flags[j]) j++
      if (j - i >= 2) {
        i = j
        continue
      }
    }
    keep.push(sentences[i])
    i++
  }
  const out = keep.join('').trim()
  if (out) return out
  const quoted = /回(他|她|对方)[^。！？!?\n]{0,20}[「"“]([\s\S]{2,120}?)[」"”]/.exec(t)
  if (quoted && quoted[2].trim()) return quoted[2].trim()
  return t
}

/** 从文本中提取夹带的图片路径/URL(用于发图兜底)
 * 加强边界条件:必须在行首/空白/引号/括号之后,避免"C盘的那个.png我看过了"误提取 */
export function extractImageRefs(text: string): { text: string; images: string[] } {
  const images: string[] = []
  // 路径前必须是空白、引号、括号、中文标点或行首,避免在句子中间误匹配
  const cleaned = String(text ?? '').replace(
    /(^|[\s，,。;；!！?？"'“”‘’【】(（)）>》])((?:[A-Za-z]:[\\/]|https?:\/\/)[^\s，,。;；!！?？"'“”‘’【】()（）<>《》]+\.(?:png|jpe?g|gif|webp|bmp)(?:[?#&][^\s，,。;；!！"'“”‘’【】()（）<>《》？]*)?)/gi,
    (_m, prefix: string, p: string) => {
      images.push(p)
      return prefix
    },
  )
  return { text: cleaned.replace(/\(\)|（）|\[]|【】/g, '').replace(/\s+/g, ' ').trim(), images }
}

/** 思考腔开头剥离 */
const THINK_LEAD =
  /^(好的|好|嗯|嗯嗯|OK|ok|okay|可以的|可以|没问题|收到|明白了|行|行吧)[,，、\s]*(让我|我先|我|让我来|我来)先?(分析|梳理|思考|想想|整理|回顾|总结|看一下|看看|确认|理一下|查一下|研究)/
const THINK_START = /^(让我|我先|我(来)?|容我)先?(分析|梳理|思考|想想|整理|回顾|总结|看一下|看看|理一下)/
export function stripThinkingPreamble(text: string): string {
  const t = String(text ?? '').trim()
  if (!t) return t
  const m = /^([\s\S]*?[。！？!?\n:：])/.exec(t)
  if (!m) return t
  const head = m[1]
  if (head.length > 40) return t
  const headTrimmed = head.replace(/[。！？!?\n:：]+$/, '').trim()
  if (!headTrimmed) return t
  const isThink = THINK_LEAD.test(headTrimmed) || THINK_START.test(headTrimmed)
  if (!isThink) return t
  const rest = t.slice(m[1].length).trim()
  return rest || t
}

// ---- NapCat 客户端 ----
export interface NapcatClient {
  start(): void
  stop(): void
  status(): NapcatStatus
  downloadImages(images?: NapcatImage[]): Promise<string[]>
  appendChat(record: Omit<NapcatChatRecord, 'time'> & { time?: number }): void
  sendToQQ(qq: string, text: string, opts?: { image?: string; file?: string }): Promise<string>
  sendToGroup(groupId: string, text: string, filePath?: string, image?: string): Promise<string>
  recallMessage(messageId: string): Promise<void>
  getRecentMessages(): NapcatMessage[]
  getSentMessages(): NapcatSentMessage[]
  getContacts(): Promise<Record<string, NapcatContact>>
  updateContact(patch: { qq: string; name?: string; info?: string; source?: 'private' | 'group' }): Promise<NapcatContact>
  getChats(): Promise<NapcatChatRecord[]>
  getPersonas(): Promise<Record<string, NapcatPersona>>
  setPersona(scope: string, persona: string): Promise<NapcatPersona | null>
  mergeContactNames(entries: Array<{ qq: string; name?: string; source?: 'private' | 'group' }>): Promise<void>
  getGroupMembers(groupId: string): Promise<Array<{ user_id: string; nickname?: string; card?: string }>>
  getFriendList(): Promise<Array<{ user_id: string; nickname?: string; remark?: string }>>
  getStrangerInfo(qq: string): Promise<{ nickname?: string; age?: number; sex?: string }>
  getGroupInfo(groupId: string): Promise<{ groupName?: string; memberCount?: number }>
  setGroupBan(groupId: string, qq: string, durationSec: number): Promise<void>
  setGroupKick(groupId: string, qq: string): Promise<void>
  setGroupWholeBan(groupId: string, enable: boolean): Promise<void>
  getQzoneFeeds(qq: string, num: number): Promise<Array<{ tid: string; content: string; createTime: number; picnum: number; commentnum: number; likenum: number }>>
  markReplied(messageId: string): void
  getBotQQ(): string
  /** 会话面板管理(2026-08-14 manage_sessions 工具):主进程经 NapcatDeps
   * 注入后透传,未注入时工具侧拿到的都是空实现/空列表 */
  listSessions?(): Array<{ key: string; title: string; kind: 'private' | 'group'; muted: boolean }>
  muteSession?(key: string, muted: boolean): void
  bindSession?(key: string): void
  watchSession?(kind: 'private' | 'group', id: string): void
  unwatchSession?(kind: 'private' | 'group', id: string): void
}

export function createNapcatClient(deps: NapcatDeps): NapcatClient {
  let ws: WsConn | null = null
  let stopped = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let seenCleanupTimer: ReturnType<typeof setInterval> | null = null
  let reconnectDelay = 1000
  let reconnectFails = 0
  let circuitBroken = false
  let lastError = ''
  let receivedCount = 0
  let repliedCount = 0
  let lastQzoneCall = 0
  const messages: NapcatMessage[] = []
  const sentMessages: NapcatSentMessage[] = []
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  let echoSeq = 0

  // ---- 发送频率限制(2026-08-14 防刷屏/QQ客户端卡死) ----
  const MIN_SEND_INTERVAL_MS = 800 // 同一目标最小发送间隔
  const MAX_SENDS_PER_MINUTE = 25 // 全局每分钟最大发送数
  const sendTimestamps: number[] = [] // 滑动窗口记录发送时间
  const lastSentAt = new Map<string, number>() // target -> 上次发送时间戳
  function checkRateLimit(target: string): { ok: boolean; reason?: string } {
    const now = Date.now()
    // 清理1分钟前的记录
    while (sendTimestamps.length > 0 && now - sendTimestamps[0] > 60000) sendTimestamps.shift()
    if (sendTimestamps.length >= MAX_SENDS_PER_MINUTE) {
      return { ok: false, reason: `发送过于频繁(${MAX_SENDS_PER_MINUTE}条/分钟),请稍后再试` }
    }
    const last = lastSentAt.get(target)
    if (last && now - last < MIN_SEND_INTERVAL_MS) {
      return { ok: false, reason: '发送间隔太短,请稍候' }
    }
    return { ok: true }
  }
  function recordSend(target: string): void {
    const now = Date.now()
    sendTimestamps.push(now)
    lastSentAt.set(target, now)
  }

  // 加载去重数据
  void loadSeen()

  const cfg = () => deps.getConfig()
  const botQQ = () => String(cfg().napcatBotQQ ?? '108724305')
  const cacheSize = () => DEFAULT_CACHE_SIZE
  const sentSize = () => DEFAULT_SENT_SIZE
  const chatsSize = () => DEFAULT_CHATS_SIZE

  function recordSent(msg: Omit<NapcatSentMessage, 'time'> & { time?: number }): void {
    if (!msg.messageId) return
    sentMessages.push({ ...msg, time: msg.time ?? Math.floor(Date.now() / 1000) })
    const limit = sentSize()
    while (sentMessages.length > limit) sentMessages.shift()
  }

  function reportError(message: string): void {
    lastError = message
    deps.onError?.(message)
    console.error('[napcat]', message)
  }

  function extractText(msg: unknown): string {
    return napcatMessageText(msg, botQQ())
  }

  function connect() {
    if (stopped || circuitBroken) return
    const url = cfg().napcatWsUrl?.trim() || DEFAULT_WS_URL
    try {
      lastError = ''
      const socket = createWsSocket(url, {
        onOpen: () => {
          reconnectDelay = 1000
          reconnectFails = 0
          circuitBroken = false
          deps.notify?.('NapCat 已连接', `QQ 消息桥就绪(${url})`)
          // 启动定期清理过期seen
          if (!seenCleanupTimer) {
            seenCleanupTimer = setInterval(pruneSeen, SEEN_CLEANUP_INTERVAL_MS)
          }
        },
        onMessage: (text) => {
          let data: unknown
          try {
            data = JSON.parse(String(text))
          } catch {
            return
          }
          const obj = data as Record<string, unknown>
          // 动作响应
          if (typeof obj.echo === 'string' && pending.has(obj.echo)) {
            const p = pending.get(obj.echo)!
            pending.delete(obj.echo)
            clearTimeout(p.timer)
            if (obj.status === 'failed' || obj.retcode !== 0) {
              const msg = String(obj.msg ?? obj.wording ?? '动作执行失败')
              p.reject(new Error(`NapCat ${msg}(retcode=${obj.retcode ?? '?'})`))
            } else {
              p.resolve(obj)
            }
            return
          }
          // 心跳(不处理)
          if (obj.post_type === 'meta_event' && obj.meta_event_type === 'heartbeat') return
          if (obj.post_type === 'meta_event' && obj.meta_event_type === 'lifecycle') return

          // 通知事件(撤回/好友请求等)
          if (obj.post_type === 'notice') {
            handleNotice(obj)
            return
          }
          if (obj.post_type === 'request') {
            handleRequest(obj)
            return
          }

          // 私聊消息
          if (obj.post_type === 'message' && obj.message_type === 'private') {
            const qq = String(obj.user_id ?? '')
            if (!qq) return
            if (qq === botQQ()) return // 跳过自己
            const messageId = String(obj.message_id ?? '')
            // 去重键区分私聊/群聊前缀(2026-08-14:不同会话message_id可能同值,分开去重)
            const dedupKey = messageId ? `private:${messageId}` : ''
            if (dedupKey && seenHas(dedupKey)) return
            if (dedupKey) seenAdd(dedupKey)
            const raw = obj.message ?? obj.raw_message
            const text = extractText(raw)
            const images = napcatMessageImages(raw)
            const msg: NapcatMessage = {
              qq,
              text,
              messageId,
              time: Number(obj.time ?? Math.floor(Date.now() / 1000)),
              images,
            }
            messages.push(msg)
            const limit = cacheSize()
            while (messages.length > limit) messages.shift()
            receivedCount++
            if (text) {
              deps.notify?.(`QQ 消息(${qq})`, text.length > 50 ? text.slice(0, 50) + '…' : text)
            }
            try { deps.onMessage(msg) } catch (e) { reportError(`onMessage处理失败:${(e as Error).message}`) }
          }
          // 群消息
          if (obj.post_type === 'message' && obj.message_type === 'group') {
            const groupId = String(obj.group_id ?? '')
            const qq = String(obj.user_id ?? '')
            if (!groupId || !qq) return
            if (qq === botQQ()) return // 跳过自己
            const groups = cfg().napcatAllowedGroups ?? []
            if (groups.length > 0 && !groups.includes(groupId)) return
            const messageId = String(obj.message_id ?? '')
            // 去重键区分私聊/群聊前缀(2026-08-14:不同会话message_id可能同值,分开去重)
            const dedupKey = messageId ? `group:${messageId}` : ''
            if (dedupKey && seenHas(dedupKey)) return
            if (dedupKey) seenAdd(dedupKey)
            const raw = obj.message ?? obj.raw_message
            const text = extractText(raw)
            const images = napcatMessageImages(raw)
            // @ 机器人检测:段数组 + CQ码字符串
            const bqq = botQQ()
            const atMe =
              (Array.isArray(raw)
                ? raw.some((seg: { type?: string; data?: Record<string, unknown> }) =>
                    seg?.type === 'at' && String(seg.data?.qq ?? '') === bqq)
                : false) || cqAtMe(raw, bqq)
            const msg: NapcatGroupMessage = {
              groupId,
              qq,
              text,
              atMe,
              messageId,
              time: Number(obj.time ?? Math.floor(Date.now() / 1000)),
              images,
            }
            receivedCount++
            if (text) {
              deps.notify?.(
                `${msg.atMe ? '@鲸鱼娘 ' : ''}群消息(QQ ${qq})`,
                text.length > 50 ? text.slice(0, 50) + '…' : text,
              )
            }
            try { deps.onGroupMessage(msg) } catch (e) { reportError(`onGroupMessage处理失败:${(e as Error).message}`) }
          }
        },
        onError: (message) => {
          lastError = message || '连接错误(请确认 NapCat 已启动且 WS 端口开放)'
        },
        onClose: () => {
          if (ws === socket) ws = null
          reconnectFails++
          if (reconnectFails >= MAX_RECONNECT_FAILS) {
            circuitBroken = true
            deps.notify?.('NapCat 连接失败', `连续${MAX_RECONNECT_FAILS}次连接失败，已停止重连。请确认NapCat已启动后重启应用或重新连接。`)
            reportError(`NapCat连续${MAX_RECONNECT_FAILS}次连接失败，已熔断`)
            return
          }
          scheduleReconnect()
        },
      })
      ws = socket
    } catch (e) {
      lastError = (e as Error).message
      reconnectFails++
      if (reconnectFails >= MAX_RECONNECT_FAILS) {
        circuitBroken = true
        deps.notify?.('NapCat 连接失败', `连续${MAX_RECONNECT_FAILS}次连接失败，已停止重连。`)
        return
      }
      scheduleReconnect()
    }
  }

  function handleNotice(obj: Record<string, unknown>) {
    const noticeType = String(obj.notice_type ?? '')
    // OneBot v11字段语义(2026-08-14 修复字段颠倒):
    // - user_id: 事件主体(被踢的人/加入的人/离开的人/消息发送者)
    // - operator_id: 操作者(踢人的管理员/邀请人/撤回操作者;主动退群时=user_id)
    // 接口定义:userId=操作者,targetId=被操作者
    const subjectId = obj.user_id !== undefined ? String(obj.user_id) : undefined
    const operatorId = obj.operator_id !== undefined ? String(obj.operator_id) : undefined
    const groupId = obj.group_id !== undefined ? String(obj.group_id) : undefined
    const msg: NapcatNotice = {
      type: noticeType as NapcatNotice['type'],
      userId: operatorId ?? subjectId, // 操作者优先;无operator时主体即操作者
      groupId,
      targetId: operatorId ? subjectId : undefined, // 有操作者时主体是被操作目标
    }
    if (noticeType === 'group_recall' || noticeType === 'friend_recall') {
      // 撤回事件:user_id=消息发送者,operator_id=撤回者(可能相同)
      msg.type = noticeType
      msg.userId = operatorId ?? subjectId
      msg.targetId = operatorId && operatorId !== subjectId ? subjectId : undefined
    } else if (noticeType === 'group_increase') {
      msg.type = 'group_increase'
      // 加入事件:user_id=加入者,operator_id=邀请者/同意者
      msg.targetId = subjectId
      msg.userId = operatorId ?? subjectId
    } else if (noticeType === 'group_decrease') {
      msg.type = 'group_decrease'
      // 离开事件:user_id=离开者,operator_id=踢人者(主动退群时operator=user)
      msg.targetId = subjectId
      msg.userId = operatorId ?? subjectId
    } else {
      return // 其他notice暂不处理
    }
    deps.onNotice?.(msg)
  }

  function handleRequest(obj: Record<string, unknown>) {
    const reqType = String(obj.request_type ?? '')
    const flag = String(obj.flag ?? '')
    const comment = obj.comment !== undefined ? String(obj.comment) : undefined
    const userId = obj.user_id !== undefined ? String(obj.user_id) : undefined
    const groupId = obj.group_id !== undefined ? String(obj.group_id) : undefined
    if (reqType === 'friend') {
      deps.onNotice?.({ type: 'friend_request', userId, flag, comment })
      deps.notify?.('QQ好友请求', `QQ ${userId} 请求加好友${comment ? `:${comment}` : ''}`)
    } else if (reqType === 'group' && (String(obj.sub_type ?? '') === 'add' || String(obj.sub_type ?? '') === 'invite')) {
      deps.onNotice?.({ type: 'group_request', userId, groupId, flag, comment })
      deps.notify?.('QQ群请求', `QQ ${userId} 请求加入/邀请加入群 ${groupId}${comment ? `:${comment}` : ''}`)
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer || circuitBroken) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_CAP_MS)
  }

  function callAction<T = unknown>(action: string, params: Record<string, unknown>, timeoutMs: number = ACTION_TIMEOUT_MS): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!ws || !ws.open) {
        reject(new Error('NapCat 未连接(请确认 NapCat 已启动)'))
        return
      }
      const echo = `napcat-${++echoSeq}-${randomInt(1 << 24).toString(36)}`
      const timer = setTimeout(() => {
        pending.delete(echo)
        reject(new Error(`NapCat 动作 ${action} 超时(${Math.round(timeoutMs / 1000)}s)`))
      }, timeoutMs)
      pending.set(echo, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      })
      try {
        ws.send(JSON.stringify({ action, params, echo }))
      } catch (e) {
        clearTimeout(timer)
        pending.delete(echo)
        reject(new Error(`NapCat 发送失败:${(e as Error).message}`))
      }
    })
  }

  const mediaDir = () => path.join(userDataDir(), 'napcat-media')

  async function downloadImage(img: NapcatImage): Promise<string | null> {
    try {
      await fs.mkdir(mediaDir(), { recursive: true })
      let localPath = ''
      if (img.file) {
        try {
          const res = await callAction<{ data?: { file?: string } }>('get_image', { file: img.file }) as {
            status?: string
            retcode?: number
            data?: { file?: string }
          }
          const p = res?.data?.file
          if (p && existsSync(p)) localPath = p
        } catch {
          // get_image失败走url下载
        }
      }
      if (!localPath && img.file && existsSync(img.file)) localPath = img.file
      if (!localPath && img.url) {
        try {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), IMAGE_DOWNLOAD_TIMEOUT_MS)
          const resp = await fetch(img.url, { signal: controller.signal })
          clearTimeout(timer)
          if (resp.ok) {
            const buf = Buffer.from(await resp.arrayBuffer())
            if (buf.length > MAX_IMAGE_SIZE) {
              reportError(`图片过大(${Math.round(buf.length / 1024 / 1024)}MB>20MB)，跳过下载`)
              return null
            }
            const ct = String(resp.headers.get('content-type') ?? '')
            const ext = /image\/(png|jpe?g|gif|webp|bmp)/.exec(ct)?.[1]?.replace('jpeg', 'jpg') ?? 'jpg'
            localPath = path.join(mediaDir(), `${Date.now()}-${randomInt(1 << 24).toString(36)}.${ext}`)
            await fs.writeFile(localPath, buf)
            return localPath
          }
        } catch (e) {
          const msg = (e as Error).message
          if (msg?.includes('abort')) {
            reportError(`图片下载超时(>${IMAGE_DOWNLOAD_TIMEOUT_MS / 1000}s)`)
          } else {
            reportError(`图片下载失败:${msg}`)
          }
          return null
        }
      }
      if (!localPath) return null
      const ext = path.extname(localPath) || '.img'
      const dest = path.join(mediaDir(), `${Date.now()}-${randomInt(1 << 24).toString(36)}${ext}`)
      await fs.copyFile(localPath, dest)
      return dest
    } catch (e) {
      reportError(`图片处理失败:${(e as Error).message}`)
      return null
    }
  }

  function prepareOutgoingText(text: string, isMaster: boolean): string {
    let t = text
    if (!isMaster) {
      t = stripThinkingPreamble(stripMasterNarration(stripToolNarration(stripFingerprintMarks(t))))
    } else {
      t = stripFingerprintMarks(t)
    }
    return t
  }

  return {
    getBotQQ: botQQ,
    async downloadImages(images?: NapcatImage[]): Promise<string[]> {
      if (!images || images.length === 0) return []
      const out: string[] = []
      for (const img of images) {
        const p = await downloadImage(img)
        if (p) out.push(p)
      }
      return out
    },
    appendChat(record: Omit<NapcatChatRecord, 'time'> & { time?: number }) {
      appendNapcatChat({
        ...record,
        time: record.time ?? Math.floor(Date.now() / 1000),
      }, chatsSize())
    },
    start() {
      stopped = false
      circuitBroken = false
      reconnectFails = 0
      connect()
    },
    stop() {
      stopped = true
      circuitBroken = true
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
      if (seenCleanupTimer) { clearInterval(seenCleanupTimer); seenCleanupTimer = null }
      for (const [, p] of pending) {
        clearTimeout(p.timer)
        p.reject(new Error('NapCat已停止'))
      }
      pending.clear()
      try { ws?.close() } catch { /* 已关闭 */ }
      ws = null
    },
    async sendToQQ(qq: string, text: string, opts?: { image?: string; file?: string }): Promise<string> {
      const isMaster = qq === MASTER_QQ
      const cleaned = prepareOutgoingText(text, isMaster)
      const paramImage = typeof opts?.image === 'string' && opts.image.trim() ? opts.image.trim() : ''
      const file = typeof opts?.file === 'string' && opts.file.trim() ? opts.file.trim() : ''
      const { text: cleanText, images: refImages } = extractImageRefs(cleaned)
      if (!cleanText.trim() && refImages.length === 0 && !paramImage && !file) return ''
      if (file) {
        if (!existsSync(file)) throw new Error(`文件不存在:${file}(send 的 file 需要本地绝对路径)`)
        try {
          const up = await callAction<{ status?: string; retcode?: number }>('upload_private_file', {
            user_id: qq, file, name: path.basename(file),
          }, FILE_UPLOAD_TIMEOUT_MS) as { status?: string; retcode?: number }
          if (up?.status !== 'ok' && up?.retcode !== 0) throw new Error(`文件上传失败(${up?.retcode ?? '未知'})`)
        } catch (e) {
          reportError(`私聊文件上传失败:${(e as Error).message}`)
          throw e
        }
      }
      if (paramImage && !/^https?:|^data:image\//.test(paramImage) && !existsSync(paramImage)) {
        throw new Error(`图片不存在:${paramImage}(image 需要本地绝对路径或 http(s) 链接)`)
      }
      const seen = new Set<string>()
      const finalImages: string[] = []
      const backToText: string[] = []
      for (const p of [paramImage, ...refImages].filter(Boolean)) {
        if (seen.has(p)) continue
        seen.add(p)
        if (/^[A-Za-z]:[\\/]/.test(p) && !existsSync(p)) backToText.push(p)
        else finalImages.push(p)
      }
      const finalText = [cleanText, ...backToText].join(' ').trim()
      // 发送频率限制检查(2026-08-14 防刷屏)
      const rate = checkRateLimit(`private:${qq}`)
      if (!rate.ok) {
        reportError(`私聊发送限流(QQ ${qq}):${rate.reason}`)
        throw new Error(rate.reason || '发送限流')
      }
      let message: unknown = finalText
      if (finalImages.length > 0) {
        const segs: unknown[] = []
        if (finalText) segs.push({ type: 'text', data: { text: finalText } })
        for (const img of finalImages) segs.push({ type: 'image', data: { file: img } })
        message = segs
      }
      try {
        const res = await callAction<{ status?: string; data?: { message_id?: number } }>('send_private_msg', {
          user_id: qq, message,
        }) as { status?: string; retcode?: number; data?: { message_id?: number } }
        if (res?.status !== 'ok' && res?.retcode !== 0) throw new Error(`QQ 发送失败(${res?.retcode ?? '未知'})`)
        recordSend(`private:${qq}`)
        const id = String(res?.data?.message_id ?? '')
        recordSent({ messageId: id, type: 'private', target: qq, text: finalText.slice(0, 100) || '(图片/文件)' })
        repliedCount++
        deps.onSent?.({ type: 'private', target: qq, text: finalText, images: finalImages })
        return id
      } catch (e) {
        reportError(`私聊消息发送失败(QQ ${qq}):${(e as Error).message}`)
        throw e
      }
    },
    async getContacts(): Promise<Record<string, NapcatContact>> {
      return loadNapcatContacts()
    },
    async getChats(): Promise<NapcatChatRecord[]> {
      return loadNapcatChats(chatsSize())
    },
    async getPersonas(): Promise<Record<string, NapcatPersona>> {
      return loadNapcatPersonas()
    },
    async setPersona(scope: string, persona: string): Promise<NapcatPersona | null> {
      return saveNapcatPersona(scope, persona)
    },
    async updateContact(patch: { qq: string; name?: string; info?: string; source?: 'private' | 'group' }): Promise<NapcatContact> {
      const contacts = await loadNapcatContacts()
      const prev = contacts[patch.qq] ?? { qq: patch.qq, updatedAt: 0 }
      const next: NapcatContact = {
        qq: patch.qq,
        name: patch.name !== undefined ? patch.name.slice(0, 50) : prev.name,
        info: patch.info !== undefined ? patch.info.slice(0, 500) : prev.info,
        source: patch.source ?? prev.source ?? 'private',
        updatedAt: Math.floor(Date.now() / 1000),
      }
      contacts[patch.qq] = next
      await saveNapcatContacts(contacts)
      return next
    },
    async sendToGroup(groupId: string, text: string, filePath?: string, image?: string): Promise<string> {
      const cleaned = prepareOutgoingText(text, false)
      const paramImage = typeof image === 'string' && image.trim() ? image.trim() : ''
      const file = typeof filePath === 'string' && filePath.trim() ? filePath.trim() : ''
      const { text: cleanText, images: refImages } = extractImageRefs(cleaned)
      if (!cleanText.trim() && refImages.length === 0 && !file && !paramImage) return ''
      if (file) {
        if (!existsSync(file)) throw new Error(`文件不存在:${file}(send_group 的 file 需要本地绝对路径)`)
        try {
          const up = await callAction<{ status?: string; retcode?: number }>('upload_group_file', {
            group_id: groupId, file, name: path.basename(file),
          }, FILE_UPLOAD_TIMEOUT_MS) as { status?: string; retcode?: number }
          if (up?.status !== 'ok' && up?.retcode !== 0) throw new Error(`群文件上传失败(${up?.retcode ?? '未知'})`)
        } catch (e) {
          reportError(`群文件上传失败(群 ${groupId}):${(e as Error).message}`)
          throw e
        }
      }
      if (paramImage && !/^https?:|^data:image\//.test(paramImage) && !existsSync(paramImage)) {
        throw new Error(`图片不存在:${paramImage}(send_group 的 image 需要本地绝对路径或 http(s) 链接)`)
      }
      const seen = new Set<string>()
      const finalImages: string[] = []
      const backToText: string[] = []
      for (const p of [paramImage, ...refImages].filter(Boolean)) {
        if (seen.has(p)) continue
        seen.add(p)
        if (/^[A-Za-z]:[\\/]/.test(p) && !existsSync(p)) backToText.push(p)
        else finalImages.push(p)
      }
      const finalText = [cleanText, ...backToText].join(' ').trim()
      // 发送频率限制检查(2026-08-14 防刷屏)
      const rateKey = `group:${groupId}`
      const rate = checkRateLimit(rateKey)
      if (!rate.ok) {
        reportError(`群发送限流(群 ${groupId}):${rate.reason}`)
        throw new Error(rate.reason || '发送限流')
      }
      let message: unknown = finalText
      if (finalImages.length > 0) {
        const segs: unknown[] = []
        if (finalText) segs.push({ type: 'text', data: { text: finalText } })
        for (const img of finalImages) segs.push({ type: 'image', data: { file: img } })
        message = segs
      }
      let messageId = ''
      if (finalText.trim() || finalImages.length > 0) {
        try {
          const res = await callAction<{ status?: string; data?: { message_id?: number } }>('send_group_msg', {
            group_id: groupId, message,
          }) as { status?: string; retcode?: number; data?: { message_id?: number } }
          if (res?.status !== 'ok' && res?.retcode !== 0) throw new Error(`群发送失败(${res?.retcode ?? '未知'})`)
          recordSend(rateKey)
          messageId = String(res?.data?.message_id ?? '')
        } catch (e) {
          reportError(`群消息发送失败(群 ${groupId}):${(e as Error).message}`)
          throw e
        }
      }
      recordSent({ messageId, type: 'group', target: groupId, text: finalText.slice(0, 100) || '(图片/文件)' })
      deps.onSent?.({ type: 'group', target: groupId, text: finalText, images: finalImages })
      repliedCount++
      return messageId
    },
    async recallMessage(messageId: string): Promise<void> {
      try {
        const res = await callAction<{ status?: string; retcode?: number }>('delete_msg', { message_id: messageId }) as {
          status?: string; retcode?: number
        }
        if (res?.status !== 'ok' && res?.retcode !== 0) throw new Error(`撤回失败(${res?.retcode ?? '未知'})`)
      } catch (e) {
        reportError(`消息撤回失败:${(e as Error).message}`)
        throw e
      }
    },
    async getGroupMembers(groupId: string): Promise<Array<{ user_id: string; nickname?: string; card?: string }>> {
      const res = await callAction<{ data?: Array<Record<string, unknown>> }>('get_group_member_list', { group_id: groupId }) as {
        status?: string; retcode?: number; data?: Array<Record<string, unknown>>
      }
      if (res?.status !== 'ok' && res?.retcode !== 0) throw new Error(`群成员列表获取失败(${res?.retcode ?? '未知'})`)
      return (res?.data ?? []).map((m) => ({
        user_id: String(m.user_id ?? ''),
        nickname: m.nickname !== undefined ? String(m.nickname) : undefined,
        card: m.card !== undefined ? String(m.card) : undefined,
      }))
    },
    async getFriendList(): Promise<Array<{ user_id: string; nickname?: string; remark?: string }>> {
      const res = await callAction<{ data?: Array<Record<string, unknown>> }>('get_friend_list', {}) as {
        status?: string; retcode?: number; data?: Array<Record<string, unknown>>
      }
      if (res?.status !== 'ok' && res?.retcode !== 0) throw new Error(`好友列表获取失败(${res?.retcode ?? '未知'})`)
      return (res?.data ?? []).map((m) => ({
        user_id: String(m.user_id ?? ''),
        nickname: m.nickname !== undefined ? String(m.nickname) : undefined,
        remark: m.remark !== undefined ? String(m.remark) : undefined,
      }))
    },
    async getStrangerInfo(qq: string): Promise<{ nickname?: string; age?: number; sex?: string }> {
      const res = await callAction<{ data?: Record<string, unknown> }>('get_stranger_info', { user_id: qq }) as {
        status?: string; retcode?: number; data?: Record<string, unknown>
      }
      if (res?.status !== 'ok' && res?.retcode !== 0) throw new Error(`资料查询失败(${res?.retcode ?? '未知'})`)
      const d = res?.data ?? {}
      return {
        nickname: d.nickname !== undefined ? String(d.nickname) : undefined,
        age: typeof d.age === 'number' ? d.age : undefined,
        sex: d.sex !== undefined ? String(d.sex) : undefined,
      }
    },
    async getGroupInfo(groupId: string): Promise<{ groupName?: string; memberCount?: number }> {
      const res = await callAction<{ data?: Record<string, unknown> }>('get_group_info', { group_id: groupId }) as {
        status?: string; retcode?: number; data?: Record<string, unknown>
      }
      if (res?.status !== 'ok' && res?.retcode !== 0) throw new Error(`群信息获取失败(${res?.retcode ?? '未知'})`)
      const d = res?.data ?? {}
      return {
        groupName: d.group_name !== undefined ? String(d.group_name) : undefined,
        memberCount: typeof d.member_count === 'number' ? d.member_count : undefined,
      }
    },
    async getQzoneFeeds(
      qq: string,
      num: number,
    ): Promise<Array<{ tid: string; content: string; createTime: number; picnum: number; commentnum: number; likenum: number }>> {
      // 简单频率限制
      const now = Date.now()
      if (now - lastQzoneCall < QZONE_RATE_LIMIT_MS) {
        await new Promise((r) => setTimeout(r, QZONE_RATE_LIMIT_MS - (now - lastQzoneCall)))
      }
      lastQzoneCall = Date.now()
      const res = await callAction<{ cookies?: string; bkn?: string }>('get_cookies', { domain: 'qzone.qq.com' }) as {
        status?: string; retcode?: number; cookies?: string; bkn?: string
      }
      if (res?.status !== 'ok' && res?.retcode !== 0) throw new Error(`QQ 空间 Cookie 获取失败(${res?.retcode ?? '未知'})`)
      const cookies = String(res?.cookies ?? '')
      if (!cookies) throw new Error('QQ 空间 Cookie 为空(NapCat版本可能过旧)')
      const gtk = String(res?.bkn ?? '') || gtkFromCookie(cookies)
      if (!gtk) throw new Error('无法计算 g_tk')
      const url =
        `https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_msglist_v6` +
        `?uin=${encodeURIComponent(qq)}&ftype=0&sort=0&pos=0&num=${Math.min(Math.max(num, 1), 20)}&replynum=3&g_tk=${encodeURIComponent(gtk)}`
      let resp: Response
      try {
        resp = await fetch(url, {
          headers: {
            Cookie: cookies,
            Referer: `https://user.qzone.qq.com/${qq}`,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          },
        })
      } catch (e) {
        throw new Error(`QQ 空间接口请求失败:${(e as Error).message}`)
      }
      if (!resp.ok) throw new Error(`QQ 空间接口请求失败(HTTP ${resp.status})`)
      let data: Record<string, unknown>
      try {
        data = (await resp.json()) as Record<string, unknown>
      } catch {
        throw new Error('QQ 空间接口响应非 JSON(可能被风控拦截)')
      }
      if (data.code !== 0) {
        throw new Error(`QQ 空间接口返回错误(${data.code}${data.message ? ' ' + String(data.message) : ''})`)
      }
      const msglist = Array.isArray(data.msglist) ? (data.msglist as Array<Record<string, unknown>>) : []
      return msglist.map((m) => ({
        tid: String(m.tid ?? ''),
        content: typeof m.content === 'string' ? m.content : '',
        createTime: typeof m.createTime === 'number' ? m.createTime : 0,
        picnum: typeof m.picnum === 'number' ? m.picnum : (Array.isArray(m.pictures) ? m.pictures.length : 0),
        commentnum: typeof m.commentnum === 'number' ? m.commentnum : 0,
        likenum: typeof m.likenum === 'number' ? m.likenum : 0,
      }))
    },
    async setGroupBan(groupId: string, qq: string, durationSec: number): Promise<void> {
      const res = await callAction<{ status?: string; retcode?: number }>('set_group_ban', {
        group_id: groupId, user_id: qq, duration: durationSec,
      }) as { status?: string; retcode?: number }
      if (res?.status !== 'ok' && res?.retcode !== 0) throw new Error(`禁言失败(${res?.retcode ?? '未知'})`)
    },
    async setGroupKick(groupId: string, qq: string): Promise<void> {
      const res = await callAction<{ status?: string; retcode?: number }>('set_group_kick', {
        group_id: groupId, user_id: qq,
      }) as { status?: string; retcode?: number }
      if (res?.status !== 'ok' && res?.retcode !== 0) throw new Error(`踢人失败(${res?.retcode ?? '未知'})`)
    },
    async setGroupWholeBan(groupId: string, enable: boolean): Promise<void> {
      const res = await callAction<{ status?: string; retcode?: number }>('set_group_whole_ban', {
        group_id: groupId, enable,
      }) as { status?: string; retcode?: number }
      if (res?.status !== 'ok' && res?.retcode !== 0) throw new Error(`全员禁言设置失败(${res?.retcode ?? '未知'})`)
    },
    async mergeContactNames(entries: Array<{ qq: string; name?: string; source?: 'private' | 'group' }>): Promise<void> {
      try {
        const contacts = await loadNapcatContacts()
        const now = Math.floor(Date.now() / 1000)
        let changed = false
        for (const e of entries) {
          if (!e.name?.trim()) continue
          const prev = contacts[e.qq]
          if (prev?.name) continue
          contacts[e.qq] = {
            qq: e.qq,
            name: e.name.trim().slice(0, 50),
            info: prev?.info,
            source: e.source ?? prev?.source ?? 'group',
            updatedAt: now,
          }
          changed = true
        }
        if (changed) await saveNapcatContacts(contacts)
      } catch (e) {
        reportError(`联系人昵称补全失败:${(e as Error).message}`)
      }
    },
    markReplied(messageId: string) {
      const m = messages.find((x) => x.messageId === messageId)
      if (m) m.replied = true
    },
    // 会话面板管理透传(2026-08-14 manage_sessions 工具:主进程经
    // NapcatDeps 注入实现,这里只把 deps 回调暴露给工具层)
    listSessions: () => deps.listSessions?.() ?? [],
    muteSession: (key: string, muted: boolean) => deps.muteSession?.(key, muted),
    bindSession: (key: string) => deps.bindSession?.(key),
    watchSession: (kind: 'private' | 'group', id: string) => deps.watchSession?.(kind, id),
    unwatchSession: (kind: 'private' | 'group', id: string) => deps.unwatchSession?.(kind, id),
    status(): NapcatStatus {
      return {
        connected: !!ws && ws.open,
        url: cfg().napcatWsUrl?.trim() || DEFAULT_WS_URL,
        lastError,
        receivedCount,
        repliedCount,
        allowed: cfg().napcatAllowed ?? [],
        allowedGroups: cfg().napcatAllowedGroups ?? [],
        circuitBroken,
      }
    },
    getRecentMessages(): NapcatMessage[] {
      return [...messages].reverse()
    },
    getSentMessages(): NapcatSentMessage[] {
      return [...sentMessages].reverse()
    },
  }
}

export type { NapcatClient as NapcatClientType }

// ---- napcat 工具(给 LLM 用) ----
export interface NapcatToolDeps {
  client: NapcatClient
  getSessionKey?(): string | null
  /** 危险操作确认回调(群管理/踢人/禁言等) */
  confirmDangerous?(action: string, detail: string): Promise<boolean>
}

export function createNapcatTools(deps: NapcatToolDeps): AgentTool[] {
  const { client, confirmDangerous } = deps
  const opts = { getSessionKey: deps.getSessionKey }
  return [
    {
      name: 'napcat',
      description:
        'NapCat QQ 机器人(2026-08-14):查询连接状态 / 最近 QQ 消息 / **机器人发出的消息(带 ID 可撤回)** / 联系人档案 / **聊天记录备份(工具记忆)** / 主动发私聊或群消息 / **图片收发** / 群成员好友查询 / 撤回消息 / 群管理(需主人确认) / **查看 QQ 空间动态** / 会话管理。' +
        '**QQ 消息自动回复是系统链路**(收到私聊/群聊自动进入对话并回复——无需调用本工具);' +
        '**收到图片自动下载保存并进对话**(主人窗口可见图片,文本标注路径);' +
        '本工具适合:用户问"QQ 那边有消息吗""NapCat 连上没""之前和谁聊过什么""看看我的 QQ 动态"时查询;' +
        '**交流中认识新联系人/群成员时,用 contact_update 记录对方信息**;' +
        '或需要**主动**发消息时(action=send/send_group)。' +
        'action=status 查连接状态;action=recent 最近收到的消息;action=sent 已发出消息(可撤回);' +
        'action=contacts/contact_update/chats/persona/persona_set 档案与人格管理;' +
        'action=send/send_group 发消息(image 发图;file 发文件/视频,大视频上传可达 3 分钟);action=recall 撤回;' +
        'action=zone QQ空间动态;action=members/friends/profile/group_info 查询;' +
        'action=group_manage 群管理(踢人/禁言/全员禁言,需要主人确认);' +
        'action=sessions/session_mute/session_bind 会话管理。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'status', 'recent', 'sent', 'contacts', 'contact_update', 'chats', 'persona', 'persona_set', 'send',
              'send_group', 'recall', 'zone', 'members', 'friends', 'profile', 'group_info', 'group_manage',
              'sessions', 'session_mute', 'session_bind',
            ],
            description: '操作类型',
          },
          user_id: { type: 'string', description: 'send:目标QQ号;chats:按QQ过滤;profile:查询QQ;group_manage(ban/kick):目标成员' },
          group_id: { type: 'string', description: 'send_group:目标群号;chats:按群过滤;members/group_info/group_manage:目标群' },
          message: { type: 'string', description: 'send/send_group:消息文本' },
          image: { type: 'string', description: 'send/send_group:图片路径或URL(真正发图)' },
          file: { type: 'string', description: 'send/send_group:本地文件路径(真正上传文件/视频,如 .mp4)' },
          message_id: { type: 'string', description: 'recall:要撤回的消息ID' },
          qq: { type: 'string', description: 'contact_update:联系人QQ;zone:查看谁的动态(缺省主人)' },
          num: { type: 'number', description: 'zone:条数(1-20,缺省10)' },
          name: { type: 'string', description: 'contact_update:备注名' },
          info: { type: 'string', description: 'contact_update:已知信息' },
          source: { type: 'string', enum: ['private', 'group'], description: 'contact_update:认识来源' },
          scope: { type: 'string', description: 'persona_set:会话范围(private:<QQ>/group:<群号>)' },
          persona: { type: 'string', description: 'persona_set:人格描述(空串=删除)' },
          op: { type: 'string', enum: ['ban', 'kick', 'whole_ban'], description: 'group_manage:操作类型' },
          duration: { type: 'number', description: 'group_manage ban:禁言秒数(0=解除)' },
          enable: { type: 'boolean', description: 'group_manage whole_ban:true开启/false关闭' },
          key: { type: 'string', description: 'session_mute/session_bind:会话键' },
          muted: { type: 'boolean', description: 'session_mute:true屏蔽/false解除' },
        },
        required: ['action'],
      },
      // 引擎兜底超时覆盖(2026-08-14):file 发视频内部上传等待可达 180s,
      // 引擎默认 60s 统一超时会把上传中途杀掉——QQ 实际收到了但工具报
      // 超时,LLM 误报没发成功(与 xxt/doc_convert 同款审计陷阱)
      timeoutMs: 200_000,
      async execute(params: ToolParams) {
        const action = String(params.action ?? '')
        if (action === 'status') {
          const s = client.status()
          return (
            `NapCat 状态:${s.connected ? '已连接' : s.circuitBroken ? '已熔断(需重启)' : '未连接'}(${s.url})` +
            (s.lastError ? `\n最近错误:${s.lastError}` : '') +
            `\n收到消息 ${s.receivedCount} 条,已回复 ${s.repliedCount} 条` +
            `\n主人:${MASTER_QQ}(唯一主人,硬编码)` +
            `\n私聊扩展信任:${s.allowed && s.allowed.length > 0 ? s.allowed.join('、') : '(仅主人)'}` +
            `\n监听群:${s.allowedGroups && s.allowedGroups.length > 0 ? s.allowedGroups.join('、') : '(无)'}`
          )
        }
        if (action === 'recent') {
          const list = client.getRecentMessages()
          if (list.length === 0) return '(最近没有收到 QQ 消息)'
          return list.slice(0, 10).map((m) =>
            `- ${m.replied ? '[已回复]' : '[未回复]'} ${m.qq}(${new Date(m.time * 1000).toLocaleTimeString('zh-CN')}):${m.text.slice(0, 80)}`
          ).join('\n')
        }
        if (action === 'sent') {
          const list = client.getSentMessages()
          if (list.length === 0) return '(机器人还没有发出过消息)'
          return list.slice(0, 10).map((m) =>
            `- ${new Date(m.time * 1000).toLocaleString('zh-CN')} [${m.type === 'group' ? `群${m.target}` : `QQ${m.target}`}] ${(m.text || '(图片/文件)').slice(0, 60)}(message_id ${m.messageId})`
          ).join('\n')
        }
        if (action === 'zone') {
          const qq = String(params.qq ?? '').trim()
          const num = params.num !== undefined ? Math.floor(Number(params.num)) : 10
          if (!Number.isFinite(num) || num < 1 || num > 20) throw new Error('zone 的 num 需要在 1-20 之间')
          const feeds = await client.getQzoneFeeds(qq || MASTER_QQ, num)
          if (feeds.length === 0) return `(QQ ${qq || MASTER_QQ} 的动态为空)`
          return `QQ ${qq || MASTER_QQ} 的最近动态(${feeds.length} 条):\n` +
            feeds.map((f, i) =>
              `${i + 1}. ${new Date(f.createTime * 1000).toLocaleString('zh-CN')} ${(f.content || '(无文字)').slice(0, 100)}` +
              `${f.picnum > 0 ? ` [图片×${f.picnum}]` : ''}${f.likenum > 0 ? ` 👍${f.likenum}` : ''}${f.commentnum > 0 ? ` 💬${f.commentnum}` : ''}`
            ).join('\n')
        }
        if (action === 'sessions') {
          // 列表直接可查(2026-08-14);增删监听/屏蔽/绑定走 manage_sessions
          const list = client.listSessions?.() ?? []
          if (list.length === 0) return '(暂无已知会话;可用 manage_sessions 工具 action=watch 新建监听会话)'
          return list.map((s) => `- ${s.key}(${s.title})[${s.kind === 'group' ? '群聊' : '私聊'}]${s.muted ? '[已屏蔽]' : ''}`).join('\n')
        }
        if (action === 'session_mute') {
          return '(会话屏蔽请通过 manage_sessions 工具操作)'
        }
        if (action === 'session_bind') {
          return '(会话绑定请通过 manage_sessions 工具操作)'
        }
        if (action === 'contacts') {
          const contacts = await client.getContacts()
          const list = Object.values(contacts)
          if (list.length === 0) return '(联系人档案为空)'
          return list.slice().sort((a, b) => b.updatedAt - a.updatedAt).map((c) =>
            `- ${c.qq}${c.name ? `(${c.name})` : ''}${c.info ? `: ${c.info}` : ''}${c.source === 'group' ? ' [群聊]' : ' [私聊]'}`
          ).join('\n')
        }
        if (action === 'chats') {
          const chats = await client.getChats()
          const qqFilter = String(params.user_id ?? '').trim()
          const groupFilter = String(params.group_id ?? '').trim()
          let list = chats
          if (qqFilter) list = list.filter((c) => c.type === 'private' && c.target === qqFilter)
          if (groupFilter) list = list.filter((c) => c.type === 'group' && c.target === groupFilter)
          if (list.length === 0) return '(聊天记录为空' + (qqFilter || groupFilter ? `(按${qqFilter || groupFilter}过滤)` : '') + ')'
          return list.slice(-20).map((c) =>
            `- ${new Date(c.time * 1000).toLocaleString('zh-CN')} [${c.type === 'group' ? `群${c.target}` : `QQ${c.target}`}] ${c.qq}: ${c.text.slice(0, 80)}${c.atMe ? ' (@鲸鱼娘)' : ''}`
          ).join('\n')
        }
        if (action === 'contact_update') {
          const qq = String(params.qq ?? '').trim()
          if (!qq) throw new Error('contact_update 需要 qq(联系人QQ号)')
          const c = await client.updateContact({
            qq,
            name: params.name !== undefined ? String(params.name) : undefined,
            info: params.info !== undefined ? String(params.info) : undefined,
            source: params.source === 'group' ? 'group' : 'private',
          })
          return `已记录联系人 ${c.qq}${c.name ? `(${c.name})` : ''}${c.info ? `: ${c.info}` : ''}`
        }
        if (action === 'send') {
          let qq = String(params.user_id ?? '').trim()
          if (!qq) {
            const pm = /^private:(\d+)$/.exec(opts?.getSessionKey?.() ?? '')
            if (pm) qq = pm[1]
          }
          if (!qq) throw new Error('send 需要 user_id(目标QQ号)')
          const text = String(params.message ?? '').trim()
          const image = String(params.image ?? '').trim()
          const file = String(params.file ?? '').trim()
          if (!text && !image && !file) throw new Error('send 需要 message/image/file 至少一个')
          if (image && !/^https?:|^data:image\//.test(image) && !existsSync(image)) {
            throw new Error(`图片不存在:${image}`)
          }
          const id = await client.sendToQQ(qq, text, { image: image || undefined, file: file || undefined })
          return `已发送给 ${qq}(message_id ${id}${image ? ',含图片' : ''}${file ? ',含文件' : ''})`
        }
        if (action === 'persona') {
          const personas = await client.getPersonas()
          const list = Object.entries(personas)
          if (list.length === 0) return '(未设置会话人格)'
          return list.sort((a, b) => b[1].updatedAt - a[1].updatedAt).map(([scope, p]) => `- ${scope}: ${p.persona}`).join('\n')
        }
        if (action === 'persona_set') {
          const scope = String(params.scope ?? '').trim()
          if (!/^(private|group):[0-9]+$/.test(scope)) throw new Error('scope 需要是 private:<QQ> 或 group:<群号>')
          const persona = String(params.persona ?? '').trim()
          const next = await client.setPersona(scope, persona)
          if (!next) return `已删除会话 ${scope} 的人格`
          return `已设置会话 ${scope} 的人格:「${next.persona}」`
        }
        if (action === 'send_group') {
          let groupId = String(params.group_id ?? '').trim()
          if (!groupId) {
            const gm = /^group:(\d+)$/.exec(opts?.getSessionKey?.() ?? '')
            if (gm) groupId = gm[1]
          }
          if (!groupId) throw new Error('send_group 需要 group_id(目标群号)')
          const text = String(params.message ?? '').trim()
          const file = String(params.file ?? '').trim()
          const image = String(params.image ?? '').trim()
          if (!text && !file && !image) throw new Error('send_group 需要 message/file/image 至少一个')
          if (image && !/^https?:|^data:image\//.test(image) && !existsSync(image)) {
            throw new Error(`图片不存在:${image}`)
          }
          const id = await client.sendToGroup(groupId, text, file || undefined, image || undefined)
          return `已发送到群 ${groupId}${file ? '(含文件)' : ''}${image ? '(含图片)' : ''}(message_id ${id})`
        }
        if (action === 'recall') {
          const messageId = String(params.message_id ?? '').trim()
          if (!messageId) throw new Error('recall 需要 message_id')
          await client.recallMessage(messageId)
          return `已撤回消息 ${messageId}`
        }
        if (action === 'members') {
          const groupId = String(params.group_id ?? '').trim()
          if (!groupId) throw new Error('members 需要 group_id')
          const members = await client.getGroupMembers(groupId)
          if (members.length === 0) return '(群成员列表为空)'
          void client.mergeContactNames(members.map((m) => ({ qq: m.user_id, name: m.card || m.nickname, source: 'group' as const })))
          return members.slice(0, 200).map((m) => `- ${m.user_id}${m.card || m.nickname ? `(${m.card || m.nickname})` : ''}`).join('\n')
        }
        if (action === 'friends') {
          const list = await client.getFriendList()
          if (list.length === 0) return '(好友列表为空)'
          return list.slice(0, 200).map((m) => `- ${m.user_id}${m.remark || m.nickname ? `(${m.remark || m.nickname})` : ''}`).join('\n')
        }
        if (action === 'profile') {
          const qq = String(params.user_id ?? '').trim()
          if (!qq) throw new Error('profile 需要 user_id')
          const p = await client.getStrangerInfo(qq)
          return `QQ ${qq}:${p.nickname ? `昵称${p.nickname}` : '无昵称'}${p.sex ? `,性别${p.sex}` : ''}${p.age !== undefined ? `,年龄${p.age}` : ''}`
        }
        if (action === 'group_info') {
          const groupId = String(params.group_id ?? '').trim()
          if (!groupId) throw new Error('group_info 需要 group_id')
          const g = await client.getGroupInfo(groupId)
          return `群 ${groupId}:${g.groupName ? `群名「${g.groupName}」` : '群名未知'}${g.memberCount !== undefined ? `,成员${g.memberCount}人` : ''}`
        }
        if (action === 'group_manage') {
          const groupId = String(params.group_id ?? '').trim()
          if (!groupId) throw new Error('group_manage 需要 group_id')
          const op = String(params.op ?? '').trim()
          if (!op) throw new Error('group_manage 需要 op(ban/kick/whole_ban)')
          // 危险操作确认门
          if (confirmDangerous) {
            let confirmMsg = ''
            if (op === 'ban') {
              const qq = String(params.user_id ?? '').trim()
              const duration = params.duration !== undefined ? Number(params.duration) : NaN
              confirmMsg = `确认禁言 QQ ${qq} ${Math.floor(duration)}秒?`
            } else if (op === 'kick') {
              const qq = String(params.user_id ?? '').trim()
              confirmMsg = `确认把 QQ ${qq} 移出群 ${groupId}?`
            } else if (op === 'whole_ban') {
              confirmMsg = `确认${params.enable ? '开启' : '解除'}群 ${groupId} 全员禁言?`
            }
            if (confirmMsg) {
              const ok = await confirmDangerous('group_manage', confirmMsg)
              if (!ok) return '操作已取消(主人未确认)'
            }
          }
          if (op === 'ban') {
            const qq = String(params.user_id ?? '').trim()
            if (!qq) throw new Error('ban 需要 user_id')
            const duration = params.duration !== undefined ? Number(params.duration) : NaN
            if (!Number.isFinite(duration) || duration < 0) throw new Error('ban 需要 duration(秒)')
            await client.setGroupBan(groupId, qq, Math.floor(duration))
            return duration === 0 ? `已解除 ${qq} 的禁言` : `已禁言 ${qq}(${Math.floor(duration)}秒)`
          }
          if (op === 'kick') {
            const qq = String(params.user_id ?? '').trim()
            if (!qq) throw new Error('kick 需要 user_id')
            await client.setGroupKick(groupId, qq)
            return `已把 ${qq} 移出群 ${groupId}`
          }
          if (op === 'whole_ban') {
            if (typeof params.enable !== 'boolean') throw new Error('whole_ban 需要 enable')
            await client.setGroupWholeBan(groupId, params.enable)
            return params.enable ? `已开启全员禁言` : `已解除全员禁言`
          }
          throw new Error('op 仅支持 ban/kick/whole_ban')
        }
        throw new Error('未知action')
      },
    },
    {
      // 会话面板管理(2026-08-14 用户要求"灵动岛设置工具支持接入会话
      // 面板,支持 LLM 直接将监听会话在会话面板中新建"):watch 把
      // QQ/群号写入监听名单 → 配置变更自动广播会话种子 → 会话面板
      // 立即出现新条目(不等消息到达)
      name: 'manage_sessions',
      description:
        '会话面板管理(2026-08-14):灵动岛会话面板展示各 QQ 私聊/群聊会话窗口。' +
        'action=list 列出已知会话(键/名称/类型/是否屏蔽);' +
        'action=watch **把某个 QQ 或群加入监听名单**——对方消息将自动回复,且会话面板立即出现该会话条目' +
        '(用户说"监听某某/接入某群/给他建个会话/盯着这个群"时用;kind=private私聊/group群聊,id=QQ号或群号);' +
        'action=unwatch 移出监听名单(不再自动回复);' +
        'action=mute/unmute 屏蔽/解除屏蔽会话(消息仍记录但不自动回复);' +
        'action=bind 在挂件会话面板中打开指定会话。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'watch', 'unwatch', 'mute', 'unmute', 'bind'], description: '操作类型' },
          kind: { type: 'string', enum: ['private', 'group'], description: 'watch/unwatch:目标类型(private=QQ私聊 / group=群聊)' },
          id: { type: 'string', description: 'watch/unwatch:目标 QQ 号或群号(纯数字)' },
          key: { type: 'string', description: 'mute/unmute/bind:会话键(private:<QQ> 或 group:<群号>;bind 可用 main 打开主对话)' },
        },
        required: ['action'],
      },
      async execute(params: ToolParams) {
        const action = String(params.action ?? '')
        if (action === 'list') {
          const list = client.listSessions?.() ?? []
          if (list.length === 0) return '(暂无已知会话;用 action=watch 新建监听会话)'
          return list.map((s) => `- ${s.key}(${s.title})[${s.kind === 'group' ? '群聊' : '私聊'}]${s.muted ? '[已屏蔽]' : ''}`).join('\n')
        }
        if (action === 'watch' || action === 'unwatch') {
          const kind = params.kind === 'group' ? 'group' : params.kind === 'private' ? 'private' : null
          if (!kind) throw new Error(`${action} 需要 kind(private=QQ私聊 / group=群聊)`)
          const id = String(params.id ?? '').trim()
          if (!/^\d+$/.test(id)) throw new Error(`${action} 需要 id(纯数字的 QQ 号或群号)`)
          if (action === 'watch') {
            client.watchSession?.(kind, id)
            return kind === 'group'
              ? `已将群 ${id} 加入监听名单——群消息将自动回复,会话面板已出现该会话条目`
              : `已将 QQ ${id} 加入监听名单(扩展信任)——其私聊消息将自动回复,会话面板已出现该会话条目`
          }
          client.unwatchSession?.(kind, id)
          return kind === 'group' ? `已将群 ${id} 移出监听名单(不再自动回复)` : `已将 QQ ${id} 移出监听名单(不再自动回复)`
        }
        if (action === 'mute' || action === 'unmute') {
          const key = String(params.key ?? '').trim()
          if (!/^(private|group):\d+$/.test(key)) throw new Error('mute/unmute 需要 key(private:<QQ> 或 group:<群号>)')
          client.muteSession?.(key, action === 'mute')
          return action === 'mute' ? `已屏蔽会话 ${key}(消息仍记录,不再自动回复)` : `已解除会话 ${key} 的屏蔽`
        }
        if (action === 'bind') {
          const key = String(params.key ?? '').trim()
          if (!key) throw new Error('bind 需要 key(会话键;main = 主对话)')
          client.bindSession?.(key)
          return `已在会话面板中打开 ${key}`
        }
        throw new Error('manage_sessions action 仅支持 list/watch/unwatch/mute/unmute/bind')
      },
    },
  ]
}
