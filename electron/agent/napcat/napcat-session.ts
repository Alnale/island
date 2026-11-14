/**
 * NapCat 会话键与归属指纹(纯函数簇)
 *
 * 2026-08-14 插件化四期从 napcat.ts 拆出;2026-09-22 归属指纹机制重设计
 * (用户定案四规则):
 *   ① 对话窗口发给 LLM 的信息永远是主人信息;
 *   ② 主人 QQ 私聊/群聊发给 LLM 的信息永远是主人信息(群聊需意图识别
 *      ——主人发言不一定指向 LLM,未指向的按环境闲聊处理);
 *   ③ 其它信息都是别人的信息;
 *   ④ 据此路由:**归属由触发来源在程序入口判定,回复默认落点随归属走**,
 *      LLM 不再写【指纹:xxx】/【主人指纹:xxx】文本标记(整套双指纹文本
 *      协议退役——服从性 ~50% 导致扣留丢消息/串台,21 轮修不完)。
 * 跨归属外发(替主人转达 / 向主人汇报)只走 napcat send/send_group 工具,
 * 判定器仅做错配安全网;轮次指纹 turnTag 由程序签发、附事件元数据、落定
 * 核对——「指纹对不上就不发送」语义保留在程序侧(LLM 服从性归零)。
 * 全部纯函数,无 IO/无状态,被 napcat 客户端/工具与 main.cjs 消息分流共用。
 */

import { randomInt } from 'node:crypto'
import { stripMindMarks } from '../mind-mark'

// ---- 会话键 ----
export function sessionKeyFor(qq: string, groupId?: string): string {
  return groupId ? `group:${groupId}` : `private:${qq}`
}
export function isValidSessionKey(key: string): boolean {
  return /^(private:\d+|group:\d+)$/.test(key)
}

// ---- 群上下文隔离 ----
// 各群的最近消息必须分桶。一条全局缓冲会把 A 群的话写进 B 群的提示词，
// 模型接着把那些话当成 B 群的上下文，回复就发到了别的群。

const MASTER_TURN_KINDS = new Set(['window', 'panel', 'master-qq', 'master-group'])

export function isMasterTurnKind(kind: string | null | undefined): boolean {
  return MASTER_TURN_KINDS.has(String(kind ?? ''))
}

function sessionGroupId(sessionKey: string | null | undefined): string {
  return /^group:(\d+)$/.exec(String(sessionKey ?? ''))?.[1] ?? ''
}

function sessionPrivateId(sessionKey: string | null | undefined): string {
  return /^private:(\d+)$/.exec(String(sessionKey ?? ''))?.[1] ?? ''
}

export interface GroupContextEntry {
  groupId: string
  qq: string
  text: string
  atMe: boolean
  /** 这条消息当时的群名片或昵称。档案没备注时，艾特仍认得出这个人。 */
  name?: string
}

/**
 * 提示词里「有人在 @ 机器人」的记号。
 * 不能写成 @名字:模型会把这串抄进群回复,QQ 上就是艾特自己。
 */
export const BOT_MENTION_MARK = '（提到你）'

/** 机器人自称。回复里这些称呼是在说自己,不能拿去艾特任何群友。 */
export const BOT_SELF_NAMES = ['岛灵', '鲸鱼娘', '小鲸'] as const

export function isBotSelfName(name: string): boolean {
  const n = String(name ?? '').trim()
  return (BOT_SELF_NAMES as readonly string[]).includes(n)
}

/** 记下一条群消息。只进该群自己的桶，并按群号做 LRU。 */
export function rememberGroupContext(
  buckets: Map<string, GroupContextEntry[]>,
  entry: { groupId?: string; qq?: string; text?: string; atMe?: boolean; name?: string },
  limits?: { perGroup?: number; maxGroups?: number },
): void {
  const groupId = String(entry.groupId ?? '').trim()
  const text = String(entry.text ?? '')
  if (!groupId || !text.trim()) return
  const perGroup = limits?.perGroup ?? 20
  const maxGroups = limits?.maxGroups ?? 40
  const list = buckets.get(groupId) ?? []
  const name = String(entry.name ?? '').trim()
  list.push({
    groupId,
    qq: String(entry.qq ?? ''),
    text,
    atMe: !!entry.atMe,
    ...(name.length >= 2 ? { name } : {}),
  })
  const trimmed = list.length > perGroup ? list.slice(-perGroup) : list
  buckets.delete(groupId)
  buckets.set(groupId, trimmed)
  while (buckets.size > maxGroups) {
    const oldest = buckets.keys().next().value
    if (oldest === undefined) break
    buckets.delete(oldest)
  }
}

/** 只取这一个群的最近几条。别的群不在结果里。 */
export function recentGroupContext(
  buckets: ReadonlyMap<string, GroupContextEntry[]>,
  groupId: string,
  limit = 8,
): GroupContextEntry[] {
  const list = buckets.get(String(groupId ?? '').trim()) ?? []
  if (limit <= 0) return []
  return list.slice(-limit)
}

/** 拼进提示词的群记录行。调用方只传入同一个群的条目。 */
export function formatGroupContextLines(
  lines: ReadonlyArray<{ qq?: string; text?: string; atMe?: boolean; name?: string }>,
): string {
  return lines
    .map((m) => {
      const qq = String(m.qq ?? '')
      const name = String(m.name ?? '').trim()
      const text = String(m.text ?? '').slice(0, 60)
      return `${qq}${name ? `(${name})` : ''}: ${text}${m.atMe ? ` ${BOT_MENTION_MARK}` : ''}`
    })
    .join('\n')
}

/**
 * 群触发轮的自动回复落点。会话键里的群号优先于路由上的 target：
 * target 一旦和本会话不一致，就不能把本群的回复发到那个群。
 */
export function pinGroupReplyTarget(
  sessionKey: string | null | undefined,
  target: string | null | undefined,
): string {
  const sessionGroup = sessionGroupId(sessionKey)
  if (sessionGroup) return sessionGroup
  return String(target ?? '').trim()
}

/**
 * send_group / 合并转发的目标群。
 * 别人的群会话只能发回本群；别人的私聊不能发群。
 * 主人轮(窗口 / 面板 / 主人 QQ)可以指定别的群。
 */
export function resolveGroupSendTarget(input: {
  requested?: string | null
  sessionKey?: string | null
  turnKind?: string | null
}): { ok: true; groupId: string } | { ok: false; error: string } {
  const sessionGroup = sessionGroupId(input.sessionKey)
  const sessionPrivate = sessionPrivateId(input.sessionKey)
  const requested = String(input.requested ?? '').trim()
  const groupId = requested || sessionGroup
  if (!groupId) return { ok: false, error: 'send_group 需要 group_id(目标群号)' }
  const master = isMasterTurnKind(input.turnKind)
  if (sessionGroup && groupId !== sessionGroup && !master) {
    return {
      ok: false,
      error: `当前是群 ${sessionGroup} 的会话，不能把消息发到群 ${groupId}。各群上下文互相隔离，只回复本群。`,
    }
  }
  if (sessionPrivate && !master) {
    return {
      ok: false,
      error: `当前是 QQ ${sessionPrivate} 的私聊，不能把消息发到群 ${groupId}。给群发消息只受主人指示。`,
    }
  }
  return { ok: true, groupId }
}

/**
 * recent / chats 的读取范围。
 * 群会话默认只看本群，私聊会话默认只看这条私聊。
 * 主人轮可以显式点名另一个群或另一个 QQ；别人的会话点名别的会话直接拒绝。
 */
export function scopeTranscriptQuery(input: {
  sessionKey?: string | null
  turnKind?: string | null
  groupId?: string | null
  userId?: string | null
}): { groupId: string; userId: string; error?: string } {
  const sessionGroup = sessionGroupId(input.sessionKey)
  const sessionPrivate = sessionPrivateId(input.sessionKey)
  const master = isMasterTurnKind(input.turnKind)
  const reqG = String(input.groupId ?? '').trim()
  const reqU = String(input.userId ?? '').trim()
  if (!sessionGroup && !sessionPrivate) return { groupId: reqG, userId: reqU }
  if (sessionGroup) {
    if (reqU && !master) {
      return { groupId: '', userId: '', error: `当前是群 ${sessionGroup} 的会话，不能读取其它私聊记录。` }
    }
    if (reqG && reqG !== sessionGroup && !master) {
      return {
        groupId: '',
        userId: '',
        error: `当前是群 ${sessionGroup} 的会话，不能读取群 ${reqG} 的记录。各群上下文互相隔离。`,
      }
    }
    if (master && (reqG || reqU)) return { groupId: reqG, userId: reqU }
    return { groupId: sessionGroup, userId: '' }
  }
  if (reqG && !master) {
    return { groupId: '', userId: '', error: `当前是 QQ ${sessionPrivate} 的私聊，不能读取群记录。` }
  }
  if (reqU && reqU !== sessionPrivate && !master) {
    return { groupId: '', userId: '', error: `当前是 QQ ${sessionPrivate} 的私聊，不能读取 QQ ${reqU} 的记录。` }
  }
  if (master && (reqG || reqU)) return { groupId: reqG, userId: reqU }
  return { groupId: '', userId: sessionPrivate }
}

/**
 * 群会话里的私聊发送。别人的群回合只能私发给主人;
 * 别人的私聊只能回当前对象或主人。缺少轮次时按会话类型收紧权限。
 */
export function resolvePrivateSendTarget(input: {
  requested?: string | null
  sessionKey?: string | null
  turnKind?: string | null
  masterQQ?: string | null
}): { ok: true; userId: string } | { ok: false; error: string } {
  const requested = String(input.requested ?? '').trim()
  const sessionPrivate = sessionPrivateId(input.sessionKey)
  const sessionGroup = sessionGroupId(input.sessionKey)
  const masterQQ = String(input.masterQQ ?? '').trim()
  const kind = String(input.turnKind ?? '') || (sessionGroup ? 'group' : sessionPrivate ? 'contact' : 'silent')
  const masterTurn = isMasterTurnKind(kind)
  const needUser = 'send 需要 user_id(目标QQ号)。发给别人必须写对方的 QQ 号;主人自己的会话里不能省略'
  if (!requested && sessionPrivate && sessionPrivate === masterQQ) return { ok: false, error: needUser }
  if (masterTurn) {
    if (requested) return { ok: true, userId: requested }
    if (sessionPrivate && sessionPrivate !== masterQQ) return { ok: true, userId: sessionPrivate }
    return { ok: false, error: needUser }
  }
  if (sessionGroup) {
    const g = sessionGroup
    if (!requested) {
      return { ok: false, error: `send 需要 user_id(目标QQ号)。当前是群 ${g} 的会话,私发只能写主人的 QQ,不能发给别人。` }
    }
    if (masterQQ && requested === masterQQ) return { ok: true, userId: requested }
    return {
      ok: false,
      error: masterQQ
        ? `当前是群 ${g} 的会话,不能把消息私发给 QQ ${requested}。给主人汇报请写主人的 QQ ${masterQQ}。`
        : `当前是群 ${g} 的会话,不能把消息私发给 QQ ${requested}。`,
    }
  }
  if (sessionPrivate || kind === 'contact' || kind === 'ask') {
    const allowed = new Set([sessionPrivate, masterQQ].filter(Boolean))
    if (requested && allowed.has(requested)) return { ok: true, userId: requested }
    if (!requested && sessionPrivate && sessionPrivate !== masterQQ) return { ok: true, userId: sessionPrivate }
    return {
      ok: false,
      error: `当前私聊不能把消息发给其它 QQ。只能回复当前对象${masterQQ ? `或主人 ${masterQQ}` : ''}。`,
    }
  }
  if (requested) return { ok: true, userId: requested }
  return { ok: false, error: needUser }
}

// ---- 群艾特:按回复在对谁说话,不按「谁刚发了这条」 ----

export interface GroupParticipant {
  qq: string
  name?: string
  /** 群名片、昵称、档案备注。同一个 QQ 可能有不止一个叫法。 */
  names?: string[]
}

const MENTION_EDGE = /[\s,，.。!！?？:：;；、~～]/
const MENTION_REQUEST = /(?:帮我|替我|请你)?(?:回|回复|告诉|转告|问|叫|喊|艾特)(?:一下|下)?$/

interface NamedQQ {
  qq: string
  name: string
}

function mentionNames(participants: ReadonlyArray<GroupParticipant>, self: string): { named: NamedQQ[]; allow: Set<string> } {
  const allow = new Set<string>()
  const named: NamedQQ[] = []
  const seenName = new Set<string>()
  const addName = (qq: string, name: string) => {
    const n = name.trim()
    // 岛灵/鲸鱼娘/小鲸是机器人自称。群名片碰巧同名时也不艾特,
    // 否则回复里一提自己的名字就会在群里艾特自己。
    if (n.length < 2 || isBotSelfName(n)) return
    const key = `${qq}\0${n}`
    if (seenName.has(key)) return
    seenName.add(key)
    named.push({ qq, name: n })
  }
  for (const p of participants) {
    const qq = String(p.qq ?? '').trim()
    if (!qq || qq === self || !/^\d{5,12}$/.test(qq)) continue
    allow.add(qq)
    addName(qq, String(p.name ?? ''))
    for (const alias of p.names ?? []) addName(qq, String(alias ?? ''))
  }
  named.sort((a, b) => b.name.length - a.name.length)
  return { named, allow }
}

function scanMentionQQs(text: string, allow: Set<string>): string[] {
  const hits: string[] = []
  // CQ at 码/全角＠/@QQ:号 也算点名写法(2026-10-28:正文里的写法会被
  // stripMentionMarkup 剥掉,艾特改由 at 段发,这里要先认出来)
  const re = /\[CQ:at,qq=(\d{5,12})[^\]]*\]|(?:QQ|qq|[@＠])\s*[:：]?\s*(\d{5,12})/g
  for (const m of text.matchAll(re)) {
    const id = m[1] || m[2]
    if (!id || !allow.has(id) || hits.includes(id)) continue
    hits.push(id)
  }
  return hits
}

/** 称呼：名字单独成词，或后面紧跟「你」。顺口提起不算。 */
function scanVocative(text: string, named: readonly NamedQQ[]): string[] {
  return scanNameHits(text, named, 'vocative')
}

/** 触发消息里「回复/问/告诉某人」。这是要去找的人，不是这句的听众。 */
function scanRequested(text: string, named: readonly NamedQQ[]): string[] {
  return scanNameHits(text, named, 'request')
}

function scanNameHits(text: string, named: readonly NamedQQ[], mode: 'vocative' | 'request'): string[] {
  const hits: string[] = []
  const taken: Array<[number, number]> = []
  const overlaps = (start: number, end: number) => taken.some(([s, e]) => start < e && end > s)
  for (const { qq, name } of named) {
    let from = 0
    while (from <= text.length - name.length) {
      const at = text.indexOf(name, from)
      if (at < 0) break
      const end = at + name.length
      const prev = at === 0 ? '' : text[at - 1]
      const next = end >= text.length ? '' : text[end]
      const lead = at === 0 || MENTION_EDGE.test(prev) || prev === '@'
      const tail = end === text.length || MENTION_EDGE.test(next) || next === '你' || next === '您'
      const request = MENTION_REQUEST.test(text.slice(Math.max(0, at - 8), at))
      const ok = mode === 'vocative' ? lead && tail : request
      if (ok && !overlaps(at, end)) {
        taken.push([at, end])
        if (!hits.includes(qq)) hits.push(qq)
      }
      from = end
    }
  }
  return hits
}

function talksToEveryone(text: string): boolean {
  const t = text.trim()
  return /^(大家|各位|大伙儿|同志们|所有人|群友们)/.test(t) || /^(跟|向)(大家|全群|群里)/.test(t)
}

/**
 * 这条群回复应该 @ 谁。
 * 回复里用称呼叫到的人优先。没叫人时，看触发消息在让机器人回谁、@ 了谁。
 * 都没有，并且对方是在问机器人，才 @ 发消息的人。对全群说的话不 @。
 * 顺口提起（「别叫张三」「张三说得对」）不 @。机器人自己永远不 @。
 */
export function resolveGroupMention(input: {
  reply?: string | null
  speakerQQ?: string | null
  directed?: boolean
  participants?: ReadonlyArray<GroupParticipant>
  selfQQ?: string | null
  /** 触发这轮的群消息原文，不是注入后的提示词 */
  trigger?: string | null
  /** 触发消息里 @ 到的 QQ，不含机器人自己 */
  triggerAtQQs?: readonly string[] | null
}): string[] {
  const reply = String(input.reply ?? '').trim()
  if (!reply || reply.startsWith('【不回复')) return []
  const self = String(input.selfQQ ?? '').trim()
  const speaker = String(input.speakerQQ ?? '').trim()
  const participants = [...(input.participants ?? [])]
  if (speaker && speaker !== self) participants.push({ qq: speaker })
  for (const id of input.triggerAtQQs ?? []) participants.push({ qq: String(id ?? '') })
  const { named, allow } = mentionNames(participants, self)
  if (speaker && speaker !== self && /^\d{5,12}$/.test(speaker)) allow.add(speaker)

  const replyHits = [...scanMentionQQs(reply, allow), ...scanVocative(reply, named)]
  const uniqueReply: string[] = []
  for (const id of replyHits) {
    if (id !== self && allow.has(id) && !uniqueReply.includes(id)) uniqueReply.push(id)
  }
  if (uniqueReply.length > 0) return uniqueReply.slice(0, 3)
  if (talksToEveryone(reply)) return []

  const trigger = String(input.trigger ?? '').trim()
  const fromTrigger = [
    ...scanRequested(trigger, named),
    ...scanVocative(trigger, named),
    ...scanMentionQQs(trigger, allow),
  ]
  for (const id of input.triggerAtQQs ?? []) fromTrigger.push(String(id ?? '').trim())
  const third: string[] = []
  for (const id of fromTrigger) {
    if (!id || id === self || id === speaker || !allow.has(id) || third.includes(id)) continue
    third.push(id)
  }
  if (third.length > 0) return third.slice(0, 3)
  if (input.directed && speaker && speaker !== self && allow.has(speaker)) return [speaker]
  return []
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

/** recordSent 在纯媒体(图/文件/语音、无正文)发送时写的占位文本 */
export const SENT_MEDIA_TEXT = '(图片/文件/语音)'

/** 这条已发消息是**文字**回复(而非纯媒体占位)。send_group 带图/文件/语音
 * 且无正文时 text 是占位,不算"已文字回复"——带媒体时对话文本仍是发群的
 * 回复/配文,不能据此判定"工具已发过、对话文本=给主人的汇报"(2026-10-28) */
export function sentMessageIsText(s: { text?: string; type?: string; target?: string } | null | undefined): boolean {
  const t = String(s?.text ?? '').trim()
  return !!t && t !== SENT_MEDIA_TEXT
}

/** 本轮是否已用 send_group 发过**文字**回复(工具文字=回复,纯媒体不算)。
 * 只统计目标群的文字发送数是否超过轮前快照 before,与 turnAlreadySentToTarget
 * 同构但排除媒体误报——修"发图 + 文字回复被误转主人 QQ" */
export function turnAlreadySentGroupText(
  now: Array<{ type: string; target: string; text?: string }>,
  before: number,
  groupId: string,
): boolean {
  return now.filter((s) => s.type === 'group' && s.target === groupId && sentMessageIsText(s)).length > before
}

// ---- 消息归属与轮次分类(归属指纹,2026-09-22) ----

/** 回复归属:master = 给主人的话 / peer = 给对方(触发者/群)的话 */
export type ReplyOwner = 'master' | 'peer'

/**
 * 轮次种类(决定默认落点):
 * - window      主人主对话窗口输入 → 留窗口
 * - panel       主人外部会话面板输入 → 留窗口(2026-09-22 用户定案:规则①
 *               「窗口 = 主人信息」严格一致,发对方必须明确指示走工具)
 * - master-qq   主人 QQ 私聊 → 回主人 QQ
 * - master-group 主人 QQ 群聊且指向 LLM(意图识别)→ 私发主人 QQ(2026-09-22
 *               用户定案:与「主人信息 → 给主人」一致,主人明确要求才在群里回)
 * - contact     扩展信任私聊(别人)→ 回对方
 * - group       群聊发言(别人;含主人未指向 LLM 的闲聊)→ 回群
 * - ask         陌生人询问轮 → 私发主人 QQ(询问怎么回复)
 * - silent      系统/主动轮 → 永不路由
 */
export type TurnKind = 'window' | 'panel' | 'master-qq' | 'master-group' | 'contact' | 'group' | 'ask' | 'silent'

/**
 * 轮次分类(纯函数,main.cjs agent:send 调用):按触发来源 + 消息归属推
 * 轮次种类与回复归属。**owner = 消息归属**(规则①-③入口判定随消息传递;
 * 缺省时窗口=主人、qq 按 target 是否主人推,group 缺省按别人——安全侧,
 * 主人群聊指向 LLM 必须由入口显式传 'master' 才私发主人)
 */
export function classifyTurn(input: {
  source?: string | null
  target?: string | null
  sessionKey?: string | null
  owner?: string | null
  masterQQ?: string | null
}): { kind: TurnKind; replyOwner: ReplyOwner | null } {
  const { source, target, sessionKey, masterQQ } = input
  const mq = typeof masterQQ === 'string' ? masterQQ : ''
  // 消息归属:显式传入优先(群聊必须显式——target 是群号,推不出说话人)
  let owner: ReplyOwner
  if (input.owner === 'master' || input.owner === 'peer') owner = input.owner
  else if (source === 'window') owner = 'master'
  else if (source === 'qq' && mq && target === mq) owner = 'master'
  else if (source === 'ask') owner = 'peer' // 陌生人消息 = 别人的信息(规则③)
  else owner = 'peer'
  switch (source) {
    case 'ask':
      // 询问轮:别人的消息,但策略上回复 = 询问主人(陌生人先问主人再回)
      return { kind: 'ask', replyOwner: 'master' }
    case 'qq':
      return owner === 'master'
        ? { kind: 'master-qq', replyOwner: 'master' }
        : { kind: 'contact', replyOwner: 'peer' }
    case 'group':
      return owner === 'master'
        ? { kind: 'master-group', replyOwner: 'master' }
        : { kind: 'group', replyOwner: 'peer' }
    case 'window':
      return {
        kind: sessionKey && sessionKey !== 'main' ? 'panel' : 'window',
        replyOwner: 'master',
      }
    default:
      return { kind: 'silent', replyOwner: null }
  }
}

/**
 * 主人群聊消息是否指向 LLM(规则②意图识别,2026-09-22):显式信号优先——
 * @机器人(atMe)/句首明确称呼机器人。普通第二人称或祈使句不升级权限。
 * 模糊样本按「未指向」处理(安全:按环境闲聊,LLM 看场合决定是否回群;
 * 主人想唤起岛灵 @ 一下或叫名字即可)。纯函数可测
 */
export function isDirectedToBot(text: string, atMe?: boolean): boolean {
  if (atMe) return true
  // 只有明确叫机器人才能把群聊提升为主人指令；「你」「帮我」可能在叫群友。
  const t = String(text ?? '').trim()
  return /^(?:(?:嗨|你好|喂|嘿)[,，、!！\s]*)?(?:岛灵|鲸鱼娘|鲸鱼|小鲸|小岛|机器人)/i.test(t)
}

// ---- 询问轮判定(给主人的话不外发;安全网启发式) ----
const ASK_TURN_STRONG = [
  // 「你说回」必须接着回复对象/内容。光「回」会命中「你说回家吧」
  /你说回(他|她|复|啥|什么|一句|一下|点)/,
  /你(想|要|说)怎么回/,
  /等你(的)?(指示|发话)/,
  /问(问|一下|下|个)?主人/,
  // 必须点到第三人称对象。「要不要我说个笑话」「要不要我发给你」
  // 是对对方说的话,整段转给主人会把私聊内容送错人
  /要不要我(回|回复|发|发给|说)(给)?(他|她|他们|对方)/,
  /我建议[^。!？]{0,16}(回|回复|发给|告诉)(他|她|他们|对方)/,
  /要(不)要我[^。!？]{0,10}(回|发|说)他/,
]
const ASK_TURN_WEAK = [
  /怎么回/,
  /(回|发|说)(他|她|他们|对方)[^。!？]{0,8}(什么|啥|点啥|吗|吧|如何|怎样|怎么样)/,
]
const ASK_TURN_QUESTION_END = /[?？~～…]$|[吗吧呢呀好]$/
export function isAskTurnToMaster(text: string): boolean {
  const t = String(text ?? '')
  if (!t.trim()) return false
  if (ASK_TURN_STRONG.some((re) => re.test(t))) return true
  return ASK_TURN_QUESTION_END.test(t.trim()) && ASK_TURN_WEAK.some((re) => re.test(t))
}

/**
 * 回复是否在直接对主人说话(别人触发轮的安全网,2026-09-22):归属指纹
 * 机制下别人轮的回复默认发对方——LLM 偶发把「给主人的汇报/请示」写进
 * 回复(「主人,魔精问你明天有没有空~」),启发式命中后扣留,防泄露
 * 给对方。保守:只认开头称呼主人 + 明确汇报/请示动词,普通回复不误伤
 */
export function looksLikeMasterAddressed(text: string): boolean {
  const t = String(text ?? '').replace(/^\s*/, '').trim()
  if (!t) return false
  // 开头直接称呼主人(主人,/主人。/主人!等 + 标点)——第三人称提及
  // (「主人是谁」「我问主人」)后跟非标点,不命中
  if (/^(给|向)?主人[,，:：。!！\s~～]/.test(t)) return true
  // 汇报/请示必须在句首。句中「我跟主人说了你明天有空」是讲给对方听的,
  // 整段改投主人会把私聊原文送错
  if (/^(给|向|跟)主人(汇报|说|报告|请示|问|讲)/.test(t)) return true
  return false
}

/** 群回复的私下内容粗筛。仅供扣留使用，不能用自然语言判断更换收件人。 */
export function shouldHandGroupReplyToMaster(text: string): boolean {
  // 保留函数名供旧调用兼容。只标记疑似私下内容，调用方扣留，不据此改收件人。
  // 「大家」等词可能是汇报对象，不能作为公开发送的通行证。
  return looksLikeMasterAddressed(text)
}

/**
 * 触发消息是否是「指示把回复/话发给某人」(2026-09-22 归属指纹:触发侧
 * 执行判定——主人轮默认回复给主人,只有触发消息本身是转达/指示回复时,
 * 回复内容才是替主人发给对方的话)。超集 of looksLikeForwardInstruction:
 * 补「回他:/回复某某:」内容指示式与「跟某某说」人名形式
 */
export function isReplyInstruction(text: string): boolean {
  const t = String(text ?? '').replace(/^【主人窗口】\s*/, '')
  if (!t) return false
  if (looksLikeForwardInstruction(t)) return true
  // 内容指示式:回他:/回复他:/发他:……(冒号后 = 要发的内容)
  if (/(回|回复|发|告诉|转告)(给|一下)?(他|她|他们|对方|大家|群友)[^。!？\n]{0,2}[:：]/.test(t)) return true
  // 人名对象:回张三:… / 跟小李说… / 告诉老王…(looksLikeForwardInstruction
  // 的「告诉/发给」分支已覆盖大部分,补 跟<人名>说/回<人名>[:：] 两式)
  if (/跟[^。!？\n,，]{1,6}(说|讲)[^。!？\n]/.test(t)) return true
  if (/(回|回复)[^。!？\n,，:：]{1,6}[:：]/.test(t)) return true
  // 就这么回 / 按我说的回 / 帮我回这个
  if (/(就这么|按(我|你)说的|照(我|你)说的)(回|发|说)/.test(t)) return true
  return false
}

/**
 * 触发消息是否含"把话发给别人"的指令(2026-08-16 二轮启发式,2026-09-22
 * 归属指纹机制保留为 isReplyInstruction 子集 + 兜底):正向 = 显式发送/
 * 转达/回复某人;负向 = 日常聊天(不含发送语义)
 */
export function looksLikeForwardInstruction(text: string): boolean {
  const t = String(text ?? '').replace(/^【主人窗口】\s*/, '')
  if (!t) return false
  return (
    // 把/帮/替 X 发给/回复/告诉/转告 某人
    /(把|帮|替)[^。!？\n]{0,14}(发|回|转达|转告|告诉|发给|发消息|说一下)[^。!？\n]{0,8}(他|她|他们|对方|给|一下|句)?/.test(t) ||
    // 回复/告诉/转告/转发/发给 某人(人称或 1-6 字称呼,可带 给/一下)
    // 后接 说/讲/标点/人称/给/我/你 或句尾 = 转达指令(2026-08-16 二轮:
    // 原规则只认人称代词,人名场景漏判;启发式宁宽勿窄——误报 = 扣留
    // 提示,漏报 = 串台)
    /(回复|告诉|转告|转发|发给|发消息|回一下|回个|回条)(给|一下)?([他她他们对方你我]|[^。!？\n]{1,6})(说|讲|,|,|:|:|他|她|他们|对方|给|我|你|。|$)/.test(t) ||
    // 跟某人说/讲
    /跟(他|她|他们|对方)[^。!？\n]{0,6}(说|讲)/.test(t) ||
    // 回他/发他/转达他 一句/话/消息
    /(回|发|转达)[他她他们对方][^。!？\n]{0,6}(一句|话|消息)/.test(t)
  )
}

/**
 * 主人是否明确要求把话发到群里(2026-09-03,修复"群会话窗口里给主人的
 * 回复被发到群"):群会话面板输入 ≠ 群触发轮——主人在窗口打的字默认是
 * 在跟岛灵说话,只有显式「发到群里/回群友/在群里说」或转达指令才允许
 * 外发。剥【主人窗口】前缀再匹配;转达指令复用 looksLikeForwardInstruction
 */
export function looksLikeGroupSendInstruction(text: string): boolean {
  const t = String(text ?? '').replace(/^【主人窗口】\s*/, '').trim()
  if (!t) return false
  // 转达指令必须带群/对象词才算「发到这个群」——「帮我回一下刚才那个问题」
  // 是在问岛灵,不能当成发群(宁漏:主人可再说「发到群里」,误发更糟)
  if (looksLikeForwardInstruction(t) && /群|群友|他|她|他们|大家|对方/.test(t)) return true
  return (
    /发(到|去|给|在)(这[个一]?|本)?群(里|友|消息)?/.test(t) ||
    /发(消息|一句|一声)?到(这[个一]?|本)?群/.test(t) ||
    /发群(里|友|消息)/.test(t) ||
    /在群里(说|发|回|讲)/.test(t) ||
    /回(到)?群(里|友)/.test(t) ||
    /群里(说|回|发)(一声|一句|一下)?/.test(t) ||
    /(告诉|回复|回)群友/.test(t) ||
    /给群友(发|回|说)/.test(t) ||
    /帮我回群/.test(t)
  )
}

/**
 * 群会话窗口输入轮是否把本轮回复发到群(纯函数,main.cjs 落定路由调用)。
 * 默认不发(2026-09-22 归属指纹:窗口 = 主人信息,回复留窗口)——只有
 * 主人明确要求发群,且判定器确认是发给群友的话才发出
 */
export function shouldSendGroupPanelReply(input: {
  alreadySent: boolean
  isAsk: boolean
  triggerText: string
  classifierIntent?: ReplyIntent | null
}): boolean {
  if (input.alreadySent || input.isAsk) return false
  if (!looksLikeGroupSendInstruction(input.triggerText)) return false
  return input.classifierIntent === 'other'
}

// ---- 轮次指纹(turnTag,程序签发) ----
const FINGERPRINT_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const FINGERPRINT_LEN = 6
/** 轮次认证 nonce(2026-09-22 归属指纹):agent:send 签发存 route + 传
 * 引擎附事件元数据,落定核对——对不上 = 陈旧/跨轮投递,不发送(「指纹
 * 对不上就不发送」语义迁到程序侧,LLM 不写不读) */
export function newTurnFingerprint(): string {
  let out = ''
  for (let i = 0; i < FINGERPRINT_LEN; i++) {
    out += FINGERPRINT_ALPHABET[randomInt(FINGERPRINT_ALPHABET.length)]
  }
  return out
}

/**
 * 发送边界残留标记清洗(2026-09-22:旧双指纹文本协议退役后的兼容层)——
 * 用户历史里可能残留旧版【指纹:xxx】/【主人指纹:xxx】/【回复对方】
 * (LLM 会从上下文"抄"到输出),任何发送路径(对方/主人/群)剥掉:
 * 标记物理上到不了任何聊天对象;新协议下标记不参与路由,剥除不影响送达
 */
export function stripFingerprintMarks(text: string): string {
  return stripMindMarks(
    String(text ?? '')
      .replace(/^【回复对方】\s*/, '')
      .replace(/【(?:指纹|主人指纹):[2-9A-HJ-NP-Z]{6}】/g, ''),
  )
}

// ---- 回复意图判定器(错配安全网) ----
// 归属指纹机制(2026-09-22)下路由默认由触发归属决定,判定器**不再是主
// 路由**,只在错配风险点兜底:主人轮疑似转达内容(LLM 忘调 send 工具把
// 要发给对方的话写进回复)/ 面板明确指示发对方/群的确认/内部独白审核。
// 判定失败回退默认行为(不引入新的错误路径)。
/** 意图判定结果:master = 给主人的话 / other = 发给对方的话 / hold = 不应发送 */
export type ReplyIntent = 'master' | 'other' | 'hold'
