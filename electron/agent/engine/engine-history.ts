/**
 * 上下文预算治理(历史裁剪)
 *
 * 2026-08-14 插件化三期从 engine-loop.ts 拆出:主循环发送前按 token
 * 粗估裁剪历史,超限从最旧丢弃(至少保留最近 MIN_KEEP_MESSAGES 条)。
 */

import type { AgentMessage } from '../types'

/** 上下文 token 预算上限(粗估口径) */
export const MAX_CONTEXT_TOKENS = 400_000
/** 裁剪时至少保留的最近消息条数 */
export const MIN_KEEP_MESSAGES = 10

/**
 * 单张图片的粗估 token(官方 DeepSeek vision 指南:每张图片 token 上限
 * 1024——小图等比放大、大图缩到约 1300×1300 后上限一致)。不计会让
 * trimHistory 对图片历史完全失察(图片 part 记 0 token,长对话收图多了
 * 历史只涨不裁)
 */
const IMAGE_TOKENS = 1024

/**
 * 估算消息 token 数(粗估:文本类按 0.6/字符,工具参数按 0.3/字符,
 * 图片按 1024/张)
 */
export function estimateMessageTokens(m: AgentMessage): number {
  let n = 0
  for (const p of m.parts) {
    if (p.type === 'text' || p.type === 'reasoning') n += p.text.length * 0.6
    else if (p.type === 'tool-result') n += p.result.length * 0.6
    else if (p.type === 'tool-call') n += JSON.stringify(p.args ?? {}).length * 0.3
    // 图片附件(image part / QQ 收图、拖拽上传的 img 媒体)按官方上限粗估
    else if (p.type === 'image' || (p.type === 'media' && p.kind === 'img')) n += IMAGE_TOKENS
  }
  return Math.ceil(n)
}

/**
 * 历史裁剪:总量未超限原样返回;超限从最旧丢弃,保底最近 10 条
 */
export function trimHistory(history: AgentMessage[]): AgentMessage[] {
  let total = 0
  for (const m of history) total += estimateMessageTokens(m)
  if (total <= MAX_CONTEXT_TOKENS) return history
  const keep: AgentMessage[] = []
  let sum = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const t = estimateMessageTokens(history[i])
    if (sum + t > MAX_CONTEXT_TOKENS && keep.length >= MIN_KEEP_MESSAGES) break
    keep.unshift(history[i])
    sum += t
  }
  return keep
}
