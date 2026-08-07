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
