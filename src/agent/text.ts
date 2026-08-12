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
