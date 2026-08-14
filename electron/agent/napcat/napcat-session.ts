/**
 * NapCat 会话键与轮次指纹(纯函数簇)
 *
 * 2026-08-14 插件化四期从 napcat.ts 拆出:会话键编解码、回复陌生人标记、
 * 防重发判定、询问轮判定、轮次指纹——全部纯函数,无 IO/无状态,
 * 被 napcat 客户端/工具与 main.cjs 消息分流共用。
 */

import { randomInt } from 'node:crypto'

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
