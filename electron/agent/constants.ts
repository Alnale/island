/**
 * 引擎 ↔ 渲染端共享常量与纯函数(2026-08-07 垂直解耦,审计 P2 #11)
 *
 * 跨层耦合修复:渲染端此前硬编码引擎的格式/判定规则(MCP 描述前缀
 * 正则、provider 判定三连问)——引擎改格式 UI 静默失效。本模块零
 * node 依赖,渲染端可安全 import(与 types.ts 同款,编译期/运行期
 * 均无副作用)。
 */

/**
 * MCP 服务工具描述前缀(引擎 mcp.ts 生成工具描述、渲染端 AgentView
 * 剥前缀展示共用;格式变更只改此处)
 */
export const MCP_SERVICE_LABEL_PREFIX = '[MCP 服务:'

/** 从 MCP 工具描述中剥掉「[MCP 服务:xxx] 」前缀(UI 展示纯工具名用) */
export function stripMcpServiceLabel(description: string): string {
  return description.replace(/^\[MCP 服务:[^\]]+\]\s*/, '')
}

/**
 * Provider 自动判定(引擎 provider.ts 分发与设置界面协议提示共用):
 * 地址含 "anthropic" → Anthropic Messages;含 "chat" → DeepSeek Chat
 * Completions(备选);否则(**默认**)→ DeepSeek Responses API
 */
export function detectProvider(baseURL: string): 'anthropic' | 'chat' | 'responses' {
  const url = baseURL.toLowerCase()
  if (url.includes('anthropic')) return 'anthropic'
  if (url.includes('chat')) return 'chat'
  return 'responses'
}

/** Provider 展示名(设置界面头部提示行,与 detectProvider 同规则) */
export function providerLabel(baseURL: string): string {
  switch (detectProvider(baseURL)) {
    case 'anthropic':
      return 'Anthropic Messages'
    case 'chat':
      return 'DeepSeek Chat'
    default:
      return 'DeepSeek Responses'
  }
}

/**
 * API 错误码 → 人话提示(2026-08-10,用户要求"增加对应API错误码的支持",
 * 官方文档 https://api-docs.deepseek.com/zh-cn/quick_start/error_codes):
 * 三 provider(Responses / Chat / Anthropic)的非 2xx 响应统一经此映射,
 * 错误从"HTTP 400:xxx"变成用户能看懂的中文(余额不足/密钥无效/限流/
 * 服务器繁忙…)。detail = 响应体原文(截断 500),解析其中的 message 字段
 * 追加展示;未知状态码回退 HTTP <status> + 原文
 */
export function apiErrorMessage(status: number, detail: string): string {
  const body = String(detail ?? '').trim()
  // 响应体里的 message(openai/deepseek 格式 error.message / 纯文本)
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
    // 非 JSON(纯文本)整体作 message
    if (!message && body) message = body.slice(0, 200)
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

/**
 * 总结标题文风预设(2026-08-07 Sub Agent 设置):id 入库(settings.json),
 * desc 为提示词片段(引擎注入总结系统提示);name 设置界面展示。
 * 8 种预设 = 文风 4 + 人格 4;渲染端可安全 import(零 node 依赖)
 */
export const SUMMARY_STYLES = [
  { id: 'concise', name: '简洁明了', desc: '文风:极度简洁,用最少字数概括主题,不加修饰语。' },
  { id: 'lively', name: '活泼俏皮', desc: '文风:活泼俏皮,带拟人语气,让标题有生气。' },
  { id: 'literary', name: '文艺诗意', desc: '文风:文艺诗意,可用四字词或对仗,意境优先。' },
  { id: 'formal', name: '正式稳重', desc: '文风:正式稳重,用词规范,不口语化。' },
] as const

/** 心理揣测人格预设(2026-08-07 Sub Agent 设置):id 入库,desc 为提示词
 * 片段(引擎注入揣测系统提示);name 设置界面展示 */
export const MIND_PERSONAS = [
  { id: 'catgirl', name: '俏皮猫娘', desc: '人格:俏皮猫娘,揣测带喵语与活泼口癖。' },
  { id: 'tender', name: '温柔贴心', desc: '人格:温柔贴心,揣测用暖心的语气。' },
  { id: 'aloof', name: '高冷克制', desc: '人格:高冷克制,揣测短促冷淡,惜字如金。' },
  { id: 'witty', name: '知性风趣', desc: '人格:知性风趣,揣测带点观察者的机敏。' },
] as const

/** 主人 QQ(2026-08-12 用户要求"主人永远只有 1178821869 这一个账号,
 * 别的都不是,不要产生幻觉"):**硬编码唯一主人,不受任何配置影响**。
 * 引擎侧(napcat.ts 工具文案/提示词)与 main.cjs(trusted 判定/询问轮
 * 同步)两处同值——main.cjs 是手写 CJS 无法 import 本模块,改动时
 * 两处必须同步(main.cjs 的 MASTER_QQ 有互指注释) */
export const MASTER_QQ = '1178821869'
