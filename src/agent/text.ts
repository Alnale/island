/**
 * 消息文本工具 —— 把消息 parts 里的文本块拼出来。
 * (2026-08-07 审计收敛:原 useAgent 死导出 + AgentMessages/DynamicIsland
 * 各一份内联「filter text parts → join」逐字重复,统一到此处)
 */

import type { AgentMessage, AgentPart } from './types'

/** parts 的纯文本内容(跳过 reasoning/工具调用/结果);无文本返回空串 */
export function textFromParts(parts: AgentPart[], separator = '\n'): string {
  return parts
    .filter((p): p is Extract<AgentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join(separator)
}

/** 消息的纯文本内容(跳过 reasoning/工具调用/结果);无文本返回空串 */
export function textFromMessage(message: AgentMessage, separator = '\n'): string {
  return textFromParts(message.parts, separator)
}

/** 剥离 NapCat 注入的【指令】段——**显示用**(2026-08-12 从 AgentMessages
 * 抽到共享层;2026-08-13 统一模板后扩展段名):【群聊指令】/【私聊指令】/
 * 【主人消息】/【档案卡】/【回复规则】/【群聊上下文】任一指令段 +
 * 后续全部剥离(来源标注【QQ私聊 · QQ xxx】与原文保留显示;档案卡在
 * 渲染端经 profileCard 字段独立展示,文本内剥离避免重复) */
export function stripNapcatInstructions(text: string): string {
  return text
    .replace(/【(?:群聊指令|私聊指令|主人消息|档案卡|回复规则|群聊上下文)】[\s\S]*$/, '')
    .trim()
}

/**
 * 剥离 NapCat 注入的【指令】段——**历史回传用**(2026-08-13,用户澄清
 * "档案卡与消息分类是给历史消息隔离的"):与显示用剥离的区别 =
 * **保留【档案卡】段**——历史里每条 QQ 消息都带着说话人的档案卡
 * (称呼/已知信息/会话人格/记忆相关),LLM 跨轮次能正确区分谁说过
 * 什么、每个人是谁(多人群聊/多私聊对象时靠它隔离);剥离的只有
 * 当轮才生效的指令段(【回复规则】/【群聊上下文】/旧式【私聊指令】
 * 等)——这些不剥离会每轮累积污染(2026-08-12 用户实测"主人账号发
 * 消息被当外人"根因之一:历史上陌生人的「先问主人」指令被沿用)
 */
export function stripNapcatHistoryInstructions(text: string): string {
  return text
    .replace(/【(?:群聊指令|私聊指令|主人消息|回复规则|群聊上下文)】[\s\S]*$/, '')
    .trim()
}

/**
 * 剥离执行回复的轮次标记(2026-08-13 指纹协议):【回复对方】(旧静态
 * 标记,兼容)与【指纹:xxxxxx】(每轮随机指纹)——这两个前缀是给路由层
 * 验证用的(指纹对不上就不发送),**进历史/显示前必须剥掉**:残留的旧
 * 指纹会出现在 LLM 上下文里,下一轮可能被"抄"到过期指纹,指纹验证
 * 对不上 = 回复发不出去(实测);显示层一并使用,气泡不露标记。
 * 2026-08-15 双指纹机制:主人指纹【主人指纹:xxxxxx】同剥(主人 QQ 轮
 * 回复 = 给主人的话带主人指纹,历史/显示同样不能残留——LLM 从上下文
 * "抄"到旧主人指纹,验证对不上 = 回复发不回主人)
 */
export function stripTurnMarks(text: string): string {
  return String(text ?? '')
    .replace(/^\s*/, '')
    .replace(/^【回复对方】\s*/, '')
    .replace(/^【(?:指纹|主人指纹):[2-9A-HJ-NP-Z]{6}】\s*/, '')
}

/**
 * 文本开头是否命中轮次标记(2026-08-14 指纹 UI):必须在**剥离前**检测——
 * 命中【指纹:xxxx】/【回复对方】= 该回复会被路由层发给 QQ 对方,
 * 显示层据此给消息打 sentToPeer 标记,气泡用"发给对方"风格与普通
 * 回复区分(见 AgentMessages 的 PeerTurnTag)
 */
export function hasTurnMark(text: string): boolean {
  return /^\s*(?:【回复对方】|【指纹:[2-9A-HJ-NP-Z]{6}】)/.test(String(text ?? ''))
}

/**
 * 文本开头是否命中**主人指纹**(2026-08-15 双指纹机制 UI):【主人指纹:xx】
 * = 该回复会路由发回主人 QQ(与【指纹:xx】= 发给对方的双通道并存,开头
 * 标记互斥——一条回复不可能同时命中两者)。显示层据此打 sentToMaster
 * 标记,气泡挂"发给主人"标签与"发给对方"/普通回复区分
 */
export function hasMasterTurnMark(text: string): boolean {
  return /^\s*【主人指纹:[2-9A-HJ-NP-Z]{6}】/.test(String(text ?? ''))
}
