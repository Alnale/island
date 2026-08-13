/**
 * Provider 分发 —— 独立模块(engine 与 evolution 共用,避免循环依赖)
 *
 * 本文件是各 LLM 供应商的**唯一路由层**:
 * - 导入 DeepSeek / MiMo / Anthropic 各自的独立实现;
 * - 提供统一的 detectProvider / providerLabel 自动判定;
 * - streamByConfig 按判定结果分发到对应 provider 的流式函数。
 *
 * 各供应商完全独立(高内聚低耦合):
 * - deepseek.ts / chat.ts / anthropic.ts  → DeepSeek 适配(deepseek-constants.ts)
 * - mimo-responses.ts / mimo-chat.ts     → 小米 MiMo 适配(mimo-constants.ts)
 *
 * Provider 自动判定规则(按 baseURL):
 * 1. 含 "anthropic" → Anthropic Messages API;
 * 2. 含 "xiaomimimo"/"mimo"(且非 deepseek) → MiMo 供应商:
 *    - 含 "chat" → MiMo Chat Completions API;
 *    - 否则 → MiMo Responses API(推荐);
 * 3. 含 "chat"(非 MiMo)→ DeepSeek Chat Completions API;
 * 4. 其余(默认)→ DeepSeek Responses API。
 */

import { streamResponse } from './deepseek'
import { streamChatCompletion } from './chat'
import { streamAnthropic } from './anthropic'
import { mimoStreamResponse } from './mimo-responses'
import { mimoStreamChatCompletion } from './mimo-chat'
import { isMimoProvider, detectMimoProtocol, mimoProviderLabel } from './mimo-constants'
import { isDeepSeekProvider, detectDeepSeekProtocol, deepseekProviderLabel } from './deepseek-constants'
import type { AgentConfig, AgentEvent, AgentMessage, AgentTool, ProviderOutcome } from './types'

/** 所有支持的 provider 协议标识 */
export type ProviderProtocol =
  | 'responses'      // DeepSeek Responses
  | 'chat'           // DeepSeek Chat Completions
  | 'anthropic'      // Anthropic Messages(DeepSeek/MiMo 兼容端点均可)
  | 'mimo-responses' // MiMo Responses
  | 'mimo-chat'      // MiMo Chat Completions

/**
 * 自动判定 provider 协议(引擎分发 + 渲染端设置界面协议提示共用)
 */
export function detectProvider(baseURL: string): ProviderProtocol {
  const url = baseURL.toLowerCase()
  if (url.includes('anthropic')) return 'anthropic'
  if (isMimoProvider(url)) {
    const proto = detectMimoProtocol(url)
    if (proto === 'mimo-chat') return 'mimo-chat'
    if (proto === 'anthropic') return 'anthropic'
    return 'mimo-responses'
  }
  // 默认归为 DeepSeek(含空地址、自定义代理地址等)
  const proto = detectDeepSeekProtocol(url)
  if (proto === 'chat') return 'chat'
  if (proto === 'anthropic') return 'anthropic'
  return 'responses'
}

/** Provider 展示名(设置界面头部提示行) */
export function providerLabel(baseURL: string): string {
  const url = baseURL.toLowerCase()
  if (url.includes('anthropic')) return 'Anthropic Messages'
  if (isMimoProvider(url)) return mimoProviderLabel(url)
  if (isDeepSeekProvider(url)) return deepseekProviderLabel(url)
  // 兜底:未知地址,按 DeepSeek Responses 显示
  return deepseekProviderLabel(url)
}

// 供渲染端/其他模块使用的便捷判定
export { isMimoProvider } from './mimo-constants'
export { isDeepSeekProvider } from './deepseek-constants'
export {
  MIMO_DEFAULT_BASE_URL,
  MIMO_DEFAULT_MODEL,
  MIMO_PLATFORM_URL,
} from './mimo-constants'
export {
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MODEL,
  DEEPSEEK_TOPUP_URL,
  DEEPSEEK_PLATFORM_URL,
} from './deepseek-constants'

/** 按配置发起流式请求(五个 provider 同构返回 ProviderOutcome;
 * jsonMode/noThinking 所有支持的 provider 均兼容,Anthropic 路径忽略)。
 * 共用方:引擎主循环 / delegate 子代理 / 总结 Sub Agent / 自我进化 harness */
export function streamByConfig(params: {
  config: AgentConfig
  system: string
  history: AgentMessage[]
  tools: AgentTool[]
  signal: AbortSignal
  onEvent: (event: AgentEvent) => void
  jsonMode?: boolean
  noThinking?: boolean
  /** 输出上限覆盖(主对话循环 8192 防工具参数被截断,2026-08-08) */
  maxOutputTokens?: number
}): Promise<ProviderOutcome> {
  switch (detectProvider(params.config.baseURL)) {
    case 'anthropic':
      return streamAnthropic(params)
    case 'mimo-chat':
      return mimoStreamChatCompletion(params)
    case 'mimo-responses':
      return mimoStreamResponse(params)
    case 'chat':
      return streamChatCompletion(params)
    case 'responses':
    default:
      return streamResponse(params)
  }
}
