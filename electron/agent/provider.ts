/**
 * Provider 分发 —— 独立模块(engine 与 evolution 共用,避免循环依赖)
 *
 * Provider 自动判定:按配置的请求地址切换协议。
 * - 地址含 "anthropic"(如 https://api.deepseek.com/anthropic 或
 *   https://api.anthropic.com)→ Anthropic Messages API;
 * - 地址含 "chat" → DeepSeek Chat Completions API(官方指南
 *   multi_round_chat / tool_calls / json_mode 体系);
 * - 其余(**默认** https://api.deepseek.com)→ DeepSeek Responses API
 *   (官方指南 + API 参考,当前默认,模型 deepseek-v4-flash)。
 */

import { streamResponse } from './deepseek'
import { streamChatCompletion } from './chat'
import { streamAnthropic } from './anthropic'
import { detectProvider } from './constants'
import type { AgentConfig, AgentEvent, AgentMessage, AgentTool, ProviderOutcome } from './types'

// detectProvider 定义在 constants.ts(渲染端设置界面共用,垂直解耦);
// 测试导入路径保持 from './provider'
export { detectProvider } from './constants'

/** 按配置发起流式请求(三个 provider 同构返回 ProviderOutcome;
 * jsonMode/noThinking 仅 DeepSeek 两个 provider 使用(官方 JSON 输出 /
 * 思考模式开关),Anthropic 路径忽略)。
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
    case 'chat':
      return streamChatCompletion(params)
    default:
      return streamResponse(params)
  }
}
