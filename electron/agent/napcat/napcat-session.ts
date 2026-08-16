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
/** 主人指纹标记(2026-08-15 双指纹机制,用户要求"区分主人指纹和他人指纹,
 * 不再以没有指纹为主人消息"):与【指纹:xxx】(发给对方的话)并存的第二个
 * 指纹通道——【主人指纹:xxx】= 给主人的话,落定路由据此发回主人 QQ;
 * 无指纹 = 不发送(扣留)。主人 QQ 触发轮/询问轮/群触发轮注入,LLM 给
 * 主人的回复必须带主人指纹,杜绝"发给别人的话被当汇报发回主人" */
export function masterFingerprintMark(fp: string): string {
  return `【主人指纹:${fp}】`
}
export function stripFingerprintMarks(text: string): string {
  // 发送边界双剥(2026-08-15):他人指纹【指纹:xxx】+ 主人指纹【主人指纹:xxx】
  // ——任一标记漏到对方/主人窗口都会被下一轮 LLM"抄"到(指纹物理上到不了
  // 任何聊天对象,任何路径都靠本函数兜底)
  return String(text ?? '').replace(/【(?:指纹|主人指纹):[2-9A-HJ-NP-Z]{6}】/g, '')
}
/** 语气词前缀(2026-08-14,修复"偶现没发出去"——LLM 偶发在指纹前加
 * 语气词,严格开头匹配导致提取失败被扣留):允许「好的/收到/行/回复」等
 * 语气词 + ≤2 个标点/空白后紧跟指纹标记。安全性不削弱:指纹值验证不变
 * (必须是本轮 fp);白名单词后必须紧跟标点/空白再是指纹——汇报引用
 * 指纹的场景("好的,已按【指纹:xxx】回复他")白名单词后是"已"非标点,
 * 不提取,不会把汇报误发给对方 */
const FINGERPRINT_TONE_PREFIX = /^(?:好的?|收到|嗯+|行|好|回复|发送|这就|马上)[,，。!！:：\s~～]{0,2}/
export function extractTurnFingerprint(text: string, fp: string): { content: string } | null {
  return extractFingerprintCore(text, fp, fingerprintMark)
}

/** 主人指纹提取(2026-08-15 双指纹机制):验证【主人指纹:fp】开头并剥离,
 * 与 extractTurnFingerprint 同构(先导空白/旧【回复对方】标记/语气词前缀
 * 容忍,指纹值验证不变)。互斥性:主人指纹以「【主」开头,不会被他人指纹
 * 提取函数命中,反之亦然——同一回复带哪个指纹由开头标记唯一决定 */
export function extractMasterFingerprint(text: string, fp: string): { content: string } | null {
  return extractFingerprintCore(text, fp, masterFingerprintMark)
}

function extractFingerprintCore(text: string, fp: string, markOf: (fp: string) => string): { content: string } | null {
  let t = String(text ?? '')
    .replace(/^\s*/, '')
    .replace(/^【回复对方】\s*/, '')
    .trimStart()
  const mark = markOf(fp)
  if (!t.startsWith(mark)) {
    // 语气词前缀容忍:白名单词 + 标点后仍是指纹标记才提取
    t = t.replace(FINGERPRINT_TONE_PREFIX, '')
    if (!t.startsWith(mark)) return null
  }
  return { content: t.slice(mark.length).trim() }
}

// ---- 回复意图判定器(2026-08-16 兜底路由)----
// 双指纹协议依赖主 Agent 的服从性:忘带指纹 = 扣留(该发给主人的消息到不了
// 主人)/ 误发(发给别人的话被发回主人 QQ)。落定路由对**指纹缺失/歧义**的
// 轮次调用独立意图判定 Sub Agent(master/other/hold),按判定结果路由——
// 判定器只做单一分类任务(比主 Agent 边生成边记指纹可靠),且失败回退原
// 行为(不引入新的错误路径)。
/** 意图判定结果:master = 给主人的话 / other = 发给对方的话 / hold = 不应发送 */
export type ReplyIntent = 'master' | 'other' | 'hold'
/** 判定器适用轮次(与 main.cjs 落定路由一一对应) */
export type ClassifierTurnKind = 'exec' | 'master-daily' | 'group' | 'contact' | 'panel'
/** 判定结果 → 路由动作(纯函数,main.cjs 按动作执行,测试全覆盖) */
export type ClassifierRouteAction = 'send-master' | 'send-pending' | 'send-target' | 'send-group' | 'hold'
export function routeForClassifierIntent(kind: ClassifierTurnKind, intent: ReplyIntent): ClassifierRouteAction {
  switch (kind) {
    case 'exec':
      // 执行轮(pending 待回复对象存活):给主人的话发主人,发给对方的话发
      // 待回复对象,hold 扣留
      return intent === 'master' ? 'send-master' : intent === 'other' ? 'send-pending' : 'hold'
    case 'master-daily':
      // 主人日常轮:回复无其它路由目标——给主人的话发主人;发给别人的话
      // 没有可发目标(发别人必须用 send 工具),扣留防串台
      return intent === 'master' ? 'send-master' : 'hold'
    case 'group':
      // 群触发轮:发给群友的话发回群,汇报发主人
      return intent === 'master' ? 'send-master' : intent === 'other' ? 'send-group' : 'hold'
    case 'contact':
      // 扩展信任私聊轮:发给对方的话发回对方,汇报发主人(与群触发轮一致)
      return intent === 'master' ? 'send-master' : intent === 'other' ? 'send-target' : 'hold'
    case 'panel':
      // 外部会话面板轮:发给对方的话发回对方;给主人的话留在面板(主人正
      // 在面板查看,无需私发 QQ)
      return intent === 'master' ? 'hold' : intent === 'other' ? 'send-target' : 'hold'
  }
}

/**
 * 触发消息是否含"把话发给别人"的指令(2026-08-16 二轮,判定器失败时的
 * 启发式兜底):主人日常轮判定器不可用(API 失败/超时)时,原实现回退
 * "直发主人"——若回复其实是"替主人发给别人的话"就串台。本函数命中 +
 * 回复较短 → 疑似转达内容,扣留提示用 send 工具(不串台);未命中 → 按
 * 原行为直发主人(不丢主人消息)。纯函数可测:正向 = 显式发送/转达/回复
 * 某人;负向 = 日常聊天(不含发送语义)
 */
export function looksLikeForwardInstruction(text: string): boolean {
  const t = String(text ?? '')
  if (!t) return false
  return (
    // 把/帮/替 X 发给/回复/告诉/转告 某人
    /(把|帮|替)[^。！？\n]{0,14}(发|回|转达|转告|告诉|发给|发消息|说一下)[^。！？\n]{0,8}(他|她|他们|对方|给|一下|句)?/.test(t) ||
    // 回复/告诉/转告/转发/发给 某人(人称或 1-6 字称呼,可带 给/一下)
    // 后接 说/讲/标点/人称/给/我/你 或句尾 = 转达指令(2026-08-16 二轮:
    // 原规则只认人称代词,人名场景漏判;启发式宁宽勿窄——误报 = 扣留
    // 提示,漏报 = 串台)
    /(回复|告诉|转告|转发|发给|发消息|回一下|回个|回条)(给|一下)?([他她他们对方你我]|[^。！？\n]{1,6})(说|讲|,|,|:|:|他|她|他们|对方|给|我|你|。|$)/.test(t) ||
    // 跟某人说/讲
    /跟(他|她|他们|对方)[^。！？\n]{0,6}(说|讲)/.test(t) ||
    // 回他/发他/转达他 一句/话/消息
    /(回|发|转达)[他她他们对方][^。！？\n]{0,6}(一句|话|消息)/.test(t)
  )
}
