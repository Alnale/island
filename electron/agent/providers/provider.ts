/**
 * Provider 分发 —— 兼容层(2026-08-14 插件化重构)
 *
 * 原硬编码 switch 路由已迁至能力接缝 plugin/llm.ts(ctx.llm):
 * 五个供应商作为 LlmAdapter 注册进接缝,执行时解析。
 * 本文件保留旧导出面(渲染端设置界面与尚未迁移的调用方共用),
 * 内部全部委托接缝实现,行为不变:
 * - detectProvider / providerLabel:协议判定与展示名(设置界面用);
 * - streamByConfig:经**默认 LLM 运行时**分发(五个内置适配器预注册)。
 *
 * 新代码请直接经 ctx.get('llm').stream() 调用(Consumer 约定:
 * 永不 import 具体供应商实现)。
 */

import { getDefaultLlmRuntime, protocolOf } from '../plugin/llm'
import type { LlmProtocol, LlmStreamParams } from '../plugin/llm'
import { isMimoProvider, mimoProviderLabel } from './mimo-constants'
import { isDeepSeekProvider, deepseekProviderLabel } from './deepseek-constants'
import type { ProviderOutcome } from '../types'

/** 所有支持的 provider 协议标识(与接缝 LlmProtocol 同款) */
export type ProviderProtocol = LlmProtocol

/**
 * 自动判定 provider 协议(引擎分发 + 渲染端设置界面协议提示共用)。
 * 语义与原实现完全一致,判定源唯一化为接缝的 protocolOf。
 */
export function detectProvider(baseURL: string): ProviderProtocol {
  return protocolOf(baseURL)
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

/** 按配置发起流式请求(经默认 LLM 接缝分发;五个 provider 同构返回
 * ProviderOutcome;jsonMode/noThinking 所有支持的 provider 均兼容,
 * Anthropic 路径忽略)。共用方:delegate 子代理 / 总结 Sub Agent /
 * 自我进化 harness(主循环已迁至 ctx.llm) */
export function streamByConfig(params: LlmStreamParams): Promise<ProviderOutcome> {
  return getDefaultLlmRuntime().stream(params)
}
