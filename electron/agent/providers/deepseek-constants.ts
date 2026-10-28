/**
 * DeepSeek Provider 专属常量与纯函数
 *
 * 完全独立模块——不引用 mimo/anthropic 任何业务代码。
 * DeepSeek 官方文档:https://api-docs.deepseek.com/zh-cn/
 */

/** DeepSeek 默认 Base URL */
export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com'
/** DeepSeek 默认模型(Responses API 默认) */
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash'
/** DeepSeek Pro 模型 */
export const DEEPSEEK_MODEL_PRO = 'deepseek-v4-pro'
/** DeepSeek Chat 模型(chat 端点用) */
export const DEEPSEEK_MODEL_CHAT = 'deepseek-chat'
/**
 * DeepSeek 图像理解模型(官方 vision 指南:图像理解主推 deepseek-flash;
 * create-response 参考:"图片仅支持 deepseek-flash 模型")。带图请求在
 * 配置模型不支持图像理解时换用本模型(见 deepseekModelForInput)
 */
export const DEEPSEEK_VISION_MODEL = 'deepseek-flash'

/**
 * 模型是否支持图像理解(官方:图片仅 deepseek-flash 支持;旧名
 * deepseek-v4-flash-vision-exp 下线后由最新 Flash 模型处理)。
 * flash / vision 家族视为支持;pro / chat 等不支持
 */
export function isDeepseekVisionModel(model: string): boolean {
  const m = model.trim().toLowerCase()
  return m.includes('flash') || m.includes('vision') || m.includes('-vl')
}

/**
 * 带图请求的实际模型:hasImages 且配置模型不支持图像理解(pro/chat 等)
 * 时换 DEEPSEEK_VISION_MODEL——不换会 400("图片仅支持 deepseek-flash"),
 * 换了图像理解开箱即用;纯文本请求/flash 家族保持配置模型不动
 */
export function deepseekModelForInput(model: string, hasImages: boolean): string {
  const m = model.trim()
  if (!hasImages || isDeepseekVisionModel(m)) return m || DEEPSEEK_DEFAULT_MODEL
  return DEEPSEEK_VISION_MODEL
}

/**
 * 判断是否为 DeepSeek 供应商(地址含 deepseek,且非 mimo)
 */
export function isDeepSeekProvider(baseURL: string): boolean {
  const url = baseURL.toLowerCase()
  if (url.includes('xiaomimimo') || url.includes('mimo.mi.com')) return false
  // 纯 mimo 字样(非 deepseek)也排除
  if (url.includes('mimo') && !url.includes('deepseek')) return false
  return url.includes('deepseek') || url === '' || (!url.includes('anthropic') && !url.includes('mimo'))
}

/**
 * DeepSeek 协议判定(在确定是 DeepSeek 供应商后细分):
 * - 含 "anthropic" → Anthropic Messages(走 anthropic.ts,非本文件处理)
 * - 含 "chat" → DeepSeek Chat Completions(/chat/completions)
 * - 否则 → DeepSeek Responses API(/responses,默认)
 */
export type DeepSeekProtocol = 'responses' | 'chat' | 'anthropic'

export function detectDeepSeekProtocol(baseURL: string): DeepSeekProtocol {
  const url = baseURL.toLowerCase()
  if (url.includes('anthropic')) return 'anthropic'
  if (url.includes('chat')) return 'chat'
  return 'responses'
}

/** DeepSeek Provider 展示名(设置界面头部协议提示行) */
export function deepseekProviderLabel(baseURL: string): string {
  switch (detectDeepSeekProtocol(baseURL)) {
    case 'chat':
      return 'DeepSeek Chat'
    case 'anthropic':
      return 'DeepSeek Anthropic'
    case 'responses':
    default:
      return 'DeepSeek Responses'
  }
}

/**
 * 带 tools 的思考请求里,助手消息缺思维链会被 400。空串同样被拒
 * (2026-10 官方思考模式:每一轮都要回传,没调用工具的轮次也算)。
 * 历史里没存到原文时回一个空格,字段非空才能过校验。
 */
export const DEEPSEEK_MISSING_REASONING = ' '

/**
 * 思考模式思维链没带回。Responses 原文含 reasoning_text,Chat 原文含
 * reasoning_content,两句都要求 passed back。命中后不再把英文和
 * request_id 拼进气泡。
 */
function isDeepseekReasoningReplayError(message: string): boolean {
  const text = message.toLowerCase()
  const aboutReasoning = text.includes('reasoning_text') || text.includes('reasoning_content')
  return aboutReasoning && text.includes('passed back')
}

/**
 * DeepSeek API 错误码 → 中文提示(官方文档 https://api-docs.deepseek.com/zh-cn/quick_start/error_codes)
 */
export function deepseekErrorMessage(status: number, detail: string): string {
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
  // 思考链缺失是独立失败,不能落进「格式 / 超长 / 不合规」那一筐
  if (isDeepseekReasoningReplayError(message)) {
    return (
      'API 请求失败:思考链没有带回接口。DeepSeek 思考模式要求把上一轮思维链原样再发回去,这次缺了。' +
      '请重发这一轮;还不行就点「清空」清掉当前对话,或到 Agent 设置把思考强度改成「关」'
    )
  }
  const detailHint = message ? `:${message.slice(0, 300)}` : ''
  const known: Record<number, string> = {
    400: '请求参数错误(参数格式/JSON 无效/上下文超长或内容不合规)',
    401: '认证失败(API Key 无效,请检查 Agent 设置里的 API Key)',
    402: '余额不足(Insufficient Balance,请前往 DeepSeek 平台充值)',
    422: '请求参数校验失败',
    429: '请求频率超限(并发/速率超限,请稍后重试或降低请求频率)',
    500: 'DeepSeek 服务器内部错误',
    503: 'DeepSeek 服务器繁忙(过载或维护中,请稍后重试)',
    529: 'DeepSeek 服务器繁忙(过载,请稍后重试)',
  }
  return `API 请求失败:${known[status] ?? `HTTP ${status}`}${detailHint}`
}

/** DeepSeek 充值页地址 */
export const DEEPSEEK_TOPUP_URL = 'https://platform.deepseek.com/top_up'
/** DeepSeek 平台首页 */
export const DEEPSEEK_PLATFORM_URL = 'https://platform.deepseek.com'
