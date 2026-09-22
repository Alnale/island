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

// ---- 会话键 ----
export function sessionKeyFor(qq: string, groupId?: string): string {
  return groupId ? `group:${groupId}` : `private:${qq}`
}
export function isValidSessionKey(key: string): boolean {
  return /^(private:\d+|group:\d+)$/.test(key)
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
 * @机器人(atMe)/称呼岛灵名字/第二人称疑问句/对助手式祈使(帮我查…)。
 * 模糊样本按「未指向」处理(安全:按环境闲聊,LLM 看场合决定是否回群;
 * 主人想唤起岛灵 @ 一下或叫名字即可)。纯函数可测
 */
export function isDirectedToBot(text: string, atMe?: boolean): boolean {
  if (atMe) return true
  const t = String(text ?? '').trim()
  if (!t) return false
  // 称呼机器人(岛灵人设名 + 常见简称)
  if (/岛灵|鲸鱼娘|鲸鱼|小鲸|小岛|机器人/i.test(t)) return true
  // 第二人称疑问(你觉得呢 / 你说好不好 / 你帮我看看)
  if (/(你|您)[^。!？?\n]{0,14}(吗|呢|么|啥|什么|谁|哪|几|多少|怎么|如何|为什么|好不好|行不行|可以吗)/.test(t)) return true
  // 对助手式祈使(帮我查/给我看/找一下/下载…)——发起者大概率在使唤机器人
  if (/(帮我|给我|麻烦你|劳驾|拜托)[^。!？?\n]{0,16}(查|看|发|问|搜|下载|打开|找|做|搞|弄|算|翻译|写)/.test(t)) return true
  return false
}

// ---- 询问轮判定(给主人的话不外发;安全网启发式) ----
const ASK_TURN_STRONG = [
  /你说回/,
  /你(想|要|说)怎么回/,
  /等你(的)?(指示|发话)/,
  /问(问|一下|下|个)?主人/,
  // (?!给?你):排除第二人称——「要不要我发给你?」是发给对方的建议,
  // 「要不要我回他?」才是询问主人(2026-08-14 修复"自主回复发给主人":
  // LLM 自主回复常带"要不要我把链接发给你"自问句式,原规则误判询问
  // → 回复被拦截并发到主人 QQ)
  /要不要我(回|发|说)(?!给?你)/,
  /我建议[^。!？]{0,12}(回|发|说)/,
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
 * 回复(「主人,魔精问你明天有没有空~」),启发式命中的改发主人,防泄露
 * 给对方。保守:只认开头称呼主人 + 明确汇报/请示动词,普通回复不误伤
 */
export function looksLikeMasterAddressed(text: string): boolean {
  const t = String(text ?? '').replace(/^\s*/, '').trim()
  if (!t) return false
  // 开头直接称呼主人(主人,/主人。/主人!等 + 标点)——第三人称提及
  // (「主人是谁」「我问主人」)后跟非标点,不命中
  if (/^(给|向)?主人[,，:：。!！\s~～]/.test(t)) return true
  // 汇报/请示动词显式点名主人
  if (/(向|给|跟)主人(汇报|说|报告|请示|问|讲)/.test(t)) return true
  return false
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
  return String(text ?? '')
    .replace(/^【回复对方】\s*/, '')
    .replace(/【(?:指纹|主人指纹):[2-9A-HJ-NP-Z]{6}】/g, '')
}

// ---- 回复意图判定器(错配安全网) ----
// 归属指纹机制(2026-09-22)下路由默认由触发归属决定,判定器**不再是主
// 路由**,只在错配风险点兜底:主人轮疑似转达内容(LLM 忘调 send 工具把
// 要发给对方的话写进回复)/ 面板明确指示发对方/群的确认/内部独白审核。
// 判定失败回退默认行为(不引入新的错误路径)。
/** 意图判定结果:master = 给主人的话 / other = 发给对方的话 / hold = 不应发送 */
export type ReplyIntent = 'master' | 'other' | 'hold'
