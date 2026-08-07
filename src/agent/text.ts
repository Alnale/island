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
