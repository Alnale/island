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
  // (?!给?你):排除第二人称——「要不要我发给你?」是发给对方的建议,
  // 「要不要我回他?」才是询问主人(2026-08-14 修复"自主回复发给主人":
  // LLM 自主回复常带"要不要我把链接发给你"自问句式,原规则误判询问
  // → 回复被拦截并发到主人 QQ)
  /要不要我(回|发|说)(?!给?你)/,
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
/** 语气词前缀(2026-08-14,修复"偶现没发出去"——LLM 偶发在指纹前加
 * 语气词,严格开头匹配导致提取失败被扣留):允许「好的/收到/行/回复」等
 * 语气词 + ≤2 个标点/空白后紧跟指纹标记。安全性不削弱:指纹值验证不变
 * (必须是本轮 fp);白名单词后必须紧跟标点/空白再是指纹——汇报引用
 * 指纹的场景("好的,已按【指纹:xxx】回复他")白名单词后是"已"非标点,
 * 不提取,不会把汇报误发给对方 */
const FINGERPRINT_TONE_PREFIX = /^(?:好的?|收到|嗯+|行|好|回复|发送|这就|马上)[,，。!！:：\s~～]{0,2}/
export function extractTurnFingerprint(text: string, fp: string): { content: string } | null {
  let t = String(text ?? '')
    .replace(/^\s*/, '')
    .replace(/^【回复对方】\s*/, '')
    .trimStart()
  const mark = fingerprintMark(fp)
  if (!t.startsWith(mark)) {
    // 语气词前缀容忍:白名单词 + 标点后仍是指纹标记才提取
    t = t.replace(FINGERPRINT_TONE_PREFIX, '')
    if (!t.startsWith(mark)) return null
  }
  return { content: t.slice(mark.length).trim() }
}
