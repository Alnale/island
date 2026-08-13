/**
 * MiMo Provider 专属常量与纯函数(小米 MiMo 大模型)
 *
 * 完全独立模块——不引用 deepseek/anthropic 任何业务代码。
 * MiMo 官方文档:https://mimo.mi.com/docs/zh-CN/
 */

/** MiMo 默认 Base URL(小米 MiMo 官方端点) */
export const MIMO_DEFAULT_BASE_URL = 'https://api.xiaomimimo.com'
/** MiMo 默认模型(功能最全,推荐) */
export const MIMO_DEFAULT_MODEL = 'mimo-v2.5-pro'
/** MiMo 备选模型 */
export const MIMO_MODEL_V25 = 'mimo-v2.5'

/**
 * 判断是否为 MiMo 供应商(地址含 xiaomimimo / mimo.mi.com / mimo 关键词,且非 deepseek)
 */
export function isMimoProvider(baseURL: string): boolean {
  const url = baseURL.toLowerCase()
  if (url.includes('deepseek')) return false
  return url.includes('xiaomimimo') || url.includes('mimo.mi.com') || url.includes('mimo')
}

/**
 * MiMo 协议判定(在确定是 MiMo 供应商后细分):
 * - 含 "chat" → MiMo Chat Completions(/v1/chat/completions)
 * - 含 "anthropic" → Anthropic Messages 兼容(走 anthropic.ts,非本文件处理)
 * - 否则 → MiMo Responses API(/v1/responses,推荐)
 */
export type MimoProtocol = 'mimo-responses' | 'mimo-chat' | 'anthropic'

export function detectMimoProtocol(baseURL: string): MimoProtocol {
  const url = baseURL.toLowerCase()
  if (url.includes('anthropic')) return 'anthropic'
  if (url.includes('chat')) return 'mimo-chat'
  return 'mimo-responses'
}

/** MiMo Provider 展示名(设置界面头部协议提示行) */
export function mimoProviderLabel(baseURL: string): string {
  switch (detectMimoProtocol(baseURL)) {
    case 'mimo-chat':
      return 'MiMo Chat'
    case 'anthropic':
      return 'MiMo Anthropic'
    case 'mimo-responses':
    default:
      return 'MiMo Responses'
  }
}

/**
 * MiMo API 错误码 → 中文提示(官方文档 https://mimo.mi.com/docs/zh-CN/api/guidance/error-codes)
 *
 * MiMo 特有错误码:
 *   403 拒绝访问(地区不支持/风控)
 *   404 资源未找到(接口/模型不支持图像输入)
 *   421 内容拦截(内容审核)
 * 共用错误码 400/401/402/429/500/503 按 MiMo 语义给出中文提示
 */
export function mimoErrorMessage(status: number, detail: string): string {
  const body = String(detail ?? '').trim()
  let message = ''
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string; type?: string } | string
      message?: string
    }
    if (parsed && typeof parsed === 'object') {
      const err = parsed.error
      message = typeof err === 'string' ? err : err?.message ?? parsed.message ?? ''
    }
  } catch {
    if (!message && body) message = body.slice(0, 200)
  }
  const detailHint = message ? `:${message.slice(0, 300)}` : ''
  const known: Record<number, string> = {
    400: 'MiMo 请求参数错误(格式错误/JSON无效/消息格式不符合要求/多轮思考未回传reasoning_content)',
    401: 'MiMo 认证失败(API Key 无效或格式错误,请检查;Token Plan 与按量付费 Key 不可混用)',
    402: 'MiMo 余额不足(请前往 MiMo 平台充值)',
    403: 'MiMo 拒绝访问(服务暂不支持当前地区,或 API Key 被风控,请新建 API Key 并注意输入内容安全)',
    404: 'MiMo 资源未找到(接口或模型不支持图像/音频/视频输入,请确认模型能力)',
    421: 'MiMo 内容拦截(内容审核拦截,请避免输入不安全或敏感内容)',
    429: 'MiMo 请求超限(并发/速率超限或 Token Plan 额度耗尽,请降低频率或升级套餐)',
    500: 'MiMo 服务器内部错误',
    503: 'MiMo 服务器繁忙(负载过高,请稍后重试)',
  }
  return `MiMo API 请求失败:${known[status] ?? `HTTP ${status}`}${detailHint}`
}

/** MiMo 平台地址(充值/开通页面) */
export const MIMO_PLATFORM_URL = 'https://mimo.mi.com'
