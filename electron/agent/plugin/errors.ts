/**
 * 插件内核 —— 错误码
 *
 * 仓库级约定"misconfiguration fails loud":配置/装配错误在最早可解析点
 * 以**专属错误码**大声失败,绝不静默跳过。所有错误码集中于此,
 * 前缀 AGENT_ = 内核/装配域,LLM_ = LLM 能力接缝域。
 */

/** ctx.get 的服务未注册 */
export const AGENT_SERVICE_MISSING = 'AGENT_SERVICE_MISSING'
/** 插件声明的 inject 依赖缺失(挂载时立即失败) */
export const AGENT_PLUGIN_DEP_MISSING = 'AGENT_PLUGIN_DEP_MISSING'
/** 上下文已 dispose 后仍尝试注册 */
export const AGENT_CONTEXT_DISPOSED = 'AGENT_CONTEXT_DISPOSED'
/** 组合层行的 name 不在插件工厂注册表 */
export const AGENT_COMPOSITION_LINE_UNKNOWN = 'AGENT_COMPOSITION_LINE_UNKNOWN'
/** 组合层行 id 重复(一条行最多属于一个层) */
export const AGENT_COMPOSITION_ID_DUP = 'AGENT_COMPOSITION_ID_DUP'

/** 配置显式指定的适配器 id 未注册 */
export const LLM_ADAPTER_MISSING = 'LLM_ADAPTER_MISSING'
/** 未指定适配器且零个匹配 baseURL */
export const LLM_ADAPTER_UNAVAILABLE = 'LLM_ADAPTER_UNAVAILABLE'
/** 未指定适配器且多个匹配(选择永不依赖注册顺序) */
export const LLM_ADAPTER_AMBIGUOUS = 'LLM_ADAPTER_AMBIGUOUS'

/** 携带错误码的错误(测试与上层可据 code 精确分支) */
export class CodedError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(`[${code}] ${message}`)
    this.code = code
    this.name = 'CodedError'
  }
}
