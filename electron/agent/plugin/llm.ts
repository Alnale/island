/**
 * 能力接缝 1:LLM 流式调用(ctx.llm)
 *
 * 三角色模型(缺一不可):
 * - **Service Definition(本文件)**:LlmRuntime 拥有 ctx.llm key,维护
 *   适配器注册表与**执行时解析**——配置指定 id 未注册 → LLM_ADAPTER_MISSING;
 *   未指定且零个匹配 → LLM_ADAPTER_UNAVAILABLE;多个匹配 → LLM_ADAPTER_AMBIGUOUS
 *   (选择永不依赖注册顺序);恰好一个 → 自动选中。
 * - **Service Provider**:deepseek.ts / chat.ts / anthropic.ts /
 *   mimo-responses.ts / mimo-chat.ts / lmstudio-chat.ts 各包一层
 *   LlmAdapter 声明(见 ALL_LLM_ADAPTERS)——provider **不拥有** key,
 *   只经 registerAdapter 注册进本接缝,正如 web-search-exa 注册进 ctx.web。
 * - **Consumer**:engine-loop(主循环)/ engine-tool-execution(delegate
 *   子代理)/ subagents / evolution——经 ctx.get('llm').stream() 调用,
 *   永不 import 具体供应商实现。
 */

import { streamResponse } from '../providers/deepseek'
import { streamChatCompletion } from '../providers/chat'
import { streamAnthropic } from '../providers/anthropic'
import { mimoStreamResponse } from '../providers/mimo-responses'
import { mimoStreamChatCompletion } from '../providers/mimo-chat'
import { lmstudioStreamChatCompletion } from '../providers/lmstudio-chat'
import { glmCloudStreamChatCompletion } from '../providers/glm-cloud'
import { isMimoProvider, detectMimoProtocol } from '../providers/mimo-constants'
import { isLMStudioProvider } from '../providers/lmstudio-constants'
import { isGlmCloudProvider } from '../providers/glm-cloud-constants'
import { detectDeepSeekProtocol } from '../providers/deepseek-constants'
import { CodedError, LLM_ADAPTER_AMBIGUOUS, LLM_ADAPTER_MISSING, LLM_ADAPTER_UNAVAILABLE } from './errors'
import { createContext } from './kernel'
import type { AgentContext, Disposer, Plugin } from './kernel'
import type { AgentConfig, AgentEvent, AgentMessage, AgentTool, ProviderOutcome } from '../types'

declare module './kernel' {
  interface ContextServices {
    llm: LlmRuntime
  }
}

/** 所有支持的 provider 协议标识(与 provider.ts 的 ProviderProtocol 同款) */
export type LlmProtocol = 'responses' | 'chat' | 'anthropic' | 'mimo-responses' | 'mimo-chat' | 'lmstudio-chat' | 'glm-chat'

/** 流式调用统一入参(各适配器同构) */
export interface LlmStreamParams {
  config: AgentConfig
  system: string
  history: AgentMessage[]
  tools: AgentTool[]
  signal: AbortSignal
  onEvent: (event: AgentEvent) => void
  jsonMode?: boolean
  noThinking?: boolean
  /** 输出上限覆盖(主对话循环防工具参数被截断) */
  maxOutputTokens?: number
}

/** LLM 适配器(provider 注册进接缝的最小契约) */
export interface LlmAdapter {
  /** 协议 id(唯一;可被配置显式指定) */
  id: LlmProtocol
  /** 展示名(设置界面协议提示行) */
  label: string
  /** baseURL 匹配判定(各适配器互斥,保证解析唯一) */
  match(baseURL: string): boolean
  stream(params: LlmStreamParams): Promise<ProviderOutcome>
}

/**
 * 协议自动判定(按 baseURL)——是各适配器 match() 的唯一判定源,保证解析互斥:
 * 1. 含 "anthropic" → Anthropic Messages;
 * 2. 含 mimo 关键词(且非 deepseek):含 "chat" → MiMo Chat;否则 MiMo Responses;
 * 3. LM Studio 本地地址(lmstudio/127.0.0.1:1234/localhost:1234)→
 *    LM Studio Chat(2026-08-18 本地部署接入;必须在 DeepSeek 兜底之前
 *    判定——DeepSeek 会吞掉一切未知地址);
 * 4. 智谱 GLM 云端地址(含 bigmodel)→ GLM Chat(2026-08-19 云端
 *    接入;同样必须在 DeepSeek 兜底之前判定);
 * 5. 其余(含 deepseek/空/自定义代理):含 "chat" → DeepSeek Chat;否则 Responses。
 */
export function protocolOf(baseURL: string): LlmProtocol {
  const url = baseURL.toLowerCase()
  if (url.includes('anthropic')) return 'anthropic'
  if (isMimoProvider(url)) {
    return detectMimoProtocol(url) === 'mimo-chat' ? 'mimo-chat' : 'mimo-responses'
  }
  if (isLMStudioProvider(url)) return 'lmstudio-chat'
  if (isGlmCloudProvider(url)) return 'glm-chat'
  return detectDeepSeekProtocol(url) === 'chat' ? 'chat' : 'responses'
}

/** LLM 接缝运行时(Service Definition) */
export interface LlmRuntime {
  /** 注册适配器(即可逆效果:返回 disposer 注销) */
  registerAdapter(adapter: LlmAdapter): Disposer
  /** 执行时解析适配器(规则见文件头;每种失败都有专属错误码) */
  resolve(baseURL: string, preferId?: string): LlmAdapter
  /** 解析 + 流式调用 */
  stream(params: LlmStreamParams): Promise<ProviderOutcome>
  /** 当前已注册适配器快照(诊断/设置界面用) */
  adapters(): LlmAdapter[]
}

export function createLlmRuntime(ctx: AgentContext): LlmRuntime {
  const registry = new Map<LlmProtocol, LlmAdapter>()

  const runtime: LlmRuntime = {
    registerAdapter(adapter) {
      return ctx.effect(
        () => {
          registry.set(adapter.id, adapter)
          return () => {
            if (registry.get(adapter.id) === adapter) registry.delete(adapter.id)
          }
        },
        `llm.registerAdapter(${adapter.id})`,
      )
    },
    resolve(baseURL, preferId) {
      if (preferId) {
        const hit = registry.get(preferId as LlmProtocol)
        if (!hit) {
          throw new CodedError(LLM_ADAPTER_MISSING, `配置指定的 LLM 适配器未注册:${preferId}`)
        }
        return hit
      }
      const matched = [...registry.values()].filter((a) => a.match(baseURL))
      if (matched.length === 0) {
        throw new CodedError(LLM_ADAPTER_UNAVAILABLE, `没有可用的 LLM 适配器匹配:${baseURL || '(默认地址)'}`)
      }
      if (matched.length > 1) {
        throw new CodedError(
          LLM_ADAPTER_AMBIGUOUS,
          `多个 LLM 适配器同时匹配 ${baseURL}:${matched.map((a) => a.id).join('、')}——请显式指定 llmAdapter`,
        )
      }
      return matched[0]
    },
    stream(params) {
      const adapter = runtime.resolve(params.config.baseURL, params.config.llmAdapter)
      return adapter.stream(params)
    },
    adapters() {
      return [...registry.values()]
    },
  }
  return runtime
}

/** 类型化取服务 */
export function getLlmRuntime(ctx: AgentContext): LlmRuntime {
  return ctx.get('llm')
}

/** LLM 接缝初始化插件:注册 ctx.llm + 七个内置适配器(接缝自带默认装配) */
export function llmSeamPlugin(): Plugin {
  return {
    name: 'seam-llm',
    apply(ctx: AgentContext) {
      const runtime = createLlmRuntime(ctx)
      ctx.register('llm', runtime)
      for (const adapter of ALL_LLM_ADAPTERS) runtime.registerAdapter(adapter)
    },
  }
}

// ---------------------------------------------------------------------------
// 五个内置适配器(Service Provider 声明;流式实现在各自文件内不动)
// ---------------------------------------------------------------------------

export const deepseekResponsesAdapter: LlmAdapter = {
  id: 'responses',
  label: 'DeepSeek Responses',
  match: (u) => protocolOf(u) === 'responses',
  stream: streamResponse,
}

export const deepseekChatAdapter: LlmAdapter = {
  id: 'chat',
  label: 'DeepSeek Chat',
  match: (u) => protocolOf(u) === 'chat',
  stream: streamChatCompletion,
}

export const anthropicAdapter: LlmAdapter = {
  id: 'anthropic',
  label: 'Anthropic Messages',
  match: (u) => protocolOf(u) === 'anthropic',
  stream: streamAnthropic,
}

export const mimoResponsesAdapter: LlmAdapter = {
  id: 'mimo-responses',
  label: 'MiMo Responses',
  match: (u) => protocolOf(u) === 'mimo-responses',
  stream: mimoStreamResponse,
}

export const mimoChatAdapter: LlmAdapter = {
  id: 'mimo-chat',
  label: 'MiMo Chat',
  match: (u) => protocolOf(u) === 'mimo-chat',
  stream: mimoStreamChatCompletion,
}

/** LM Studio Chat 适配器(2026-08-18 本地部署接入) */
export const lmstudioChatAdapter: LlmAdapter = {
  id: 'lmstudio-chat',
  label: 'LM Studio Chat',
  match: (u) => protocolOf(u) === 'lmstudio-chat',
  stream: lmstudioStreamChatCompletion,
}

/** 智谱 GLM 云端 Chat 适配器(2026-08-19 云端接入) */
export const glmCloudChatAdapter: LlmAdapter = {
  id: 'glm-chat',
  label: '智谱 GLM 云端',
  match: (u) => protocolOf(u) === 'glm-chat',
  stream: glmCloudStreamChatCompletion,
}

/** 内置适配器全集(装配层一键注册;外部新增适配器平行挂载即可) */
export const ALL_LLM_ADAPTERS: LlmAdapter[] = [
  deepseekResponsesAdapter,
  deepseekChatAdapter,
  anthropicAdapter,
  mimoResponsesAdapter,
  mimoChatAdapter,
  lmstudioChatAdapter,
  glmCloudChatAdapter,
]

// ---------------------------------------------------------------------------
// 默认运行时(provider.ts 兼容层用:模块级单例,行为与旧 streamByConfig 一致)
// ---------------------------------------------------------------------------

let defaultRuntime: LlmRuntime | null = null

/** 懒加载默认运行时(五个内置适配器预注册) */
export function getDefaultLlmRuntime(): LlmRuntime {
  if (!defaultRuntime) {
    const ctx = createContext('default-llm')
    defaultRuntime = createLlmRuntime(ctx)
    for (const adapter of ALL_LLM_ADAPTERS) defaultRuntime.registerAdapter(adapter)
  }
  return defaultRuntime
}
