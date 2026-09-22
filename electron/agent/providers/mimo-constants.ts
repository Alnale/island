/**
 * MiMo Provider 专属常量与纯函数(小米 MiMo 大模型)
 *
 * 完全独立模块——不引用 deepseek/anthropic 任何业务代码。
 * MiMo 官方文档:https://mimo.mi.com/docs/zh-CN/
 */

/** MiMo 默认 Base URL(小米 MiMo 官方端点) */
export const MIMO_DEFAULT_BASE_URL = 'https://api.xiaomimimo.com'
/** MiMo 默认模型(2026-09-22 官网现行旗舰,多模态可用) */
export const MIMO_DEFAULT_MODEL = 'mimo-v2.6-pro'
/** MiMo 模型清单(2026-09-22 官网:文本生成 + 图/音频/视频理解) */
export const MIMO_MODEL_V26_PRO = 'mimo-v2.6-pro'
/** v2.6 快档(批量推理两支持模型之一,价格减半档) */
export const MIMO_MODEL_V26_FLASH = 'mimo-v2.6-flash'
/** v2.6 极速档 */
export const MIMO_MODEL_V26_ULTRASPEED = 'mimo-v2.6-pro-ultraspeed'
/** v2.5 多模态可用(图/音频/视频理解支持清单内) */
export const MIMO_MODEL_V25 = 'mimo-v2.5'
/** v2.5 旧旗舰(文本生成仍可用;**多模态支持清单不含本模型**,见 mimoSupportsMedia) */
export const MIMO_MODEL_V25_PRO = 'mimo-v2.5-pro'

/**
 * 多模态(图/音频/视频)理解能力判定(2026-09-22 官网多模态文档 + 活体实证):
 * 三篇多模态文档(图片/音频/视频理解)的支持清单一致——mimo-v2.6-flash /
 * mimo-v2.6-pro / mimo-v2.6-pro-ultraspeed / mimo-v2.5,不含 mimo-v2.5-pro。
 * 活体探针实证(2026-09-22):mimo-v2.5-pro + input_image → 404
 * "No endpoints found that support image input"——拦截为占位防断整轮。
 * 未知新模型缺省**放行**(防误杀未来型号),能力不符由 404 错误映射兜底提示。
 */
export function mimoSupportsMedia(model: string): boolean {
  return !/^mimo-v2\.5-pro\b/i.test(model.trim())
}

/** 批量推理 region 缺省(真实值以 MiMo 控制台「批量推理」页为准) */
export const MIMO_BATCH_DEFAULT_REGION = 'cn'

/**
 * 批量推理 Base URL(官网 Batch API 文档:https://batch-api-${region}.xiaomimimo.com,
 * region 从控制台批量推理页面获取)。与实时对话端点(api.xiaomimimo.com)是
 * **不同主机**;非法 region 直接抛错(防拼出怪异主机名)。
 */
export function mimoBatchBaseUrl(region: string): string {
  const r = String(region ?? '').trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(r)) {
    throw new Error(`MiMo 批量推理 region 不合法:"${region}"(从 MiMo 控制台「批量推理」页面获取,如 cn;也可直接传 batch_base_url 完整地址)`)
  }
  return `https://batch-api-${r}.xiaomimimo.com`
}

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
