/**
 * NapCat 持久化域(去重/联系人/聊天记录/人格)+ 档案卡聚合
 *
 * 2026-08-14 插件化五期从 napcat.ts 拆出:userData 目录与 napcat-*.json
 * 文件路径、去重 ID 持久化(TTL 过期+总量上限)、联系人/聊天记录/人格的
 * 内存缓存+串行写队列(临时文件 rename 原子落盘)。模块级状态随迁移,
 * 行为零变化;napcat.ts barrel 兼容 re-export。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { masterQQ } from '../privacy'
import type { NapcatContact } from './napcat'

// ---- 存储相关常量(原 napcat.ts 默认配置,仅持久化域使用) ----
const DEFAULT_CHATS_SIZE = 200 // 减少聊天记录条数(原500过大)
const MAX_CHAT_TEXT_LEN = 2000 // 单条聊天记录文本截断
const SEEN_TTL_MS = 60 * 60 * 1000 // 去重ID 1小时过期
export { DEFAULT_CHATS_SIZE }

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
  const displayName = name || (qq === masterQQ() ? '主人' : '(未知)')
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
// ---- 用户数据目录 ----
export function userDataDir(): string {
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
export async function loadSeen(): Promise<void> {
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
export function pruneSeen(): void {
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
export function seenHas(id: string): boolean {
  if (!id) return false
  return Object.prototype.hasOwnProperty.call(seenData.ids, id)
}
export function seenAdd(id: string): void {
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
