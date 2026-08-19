/**
 * LM Studio 本地工作站常量(2026-08-18 本地部署接入)
 *
 * LM Studio 是本地模型工作站:启动 Developer 服务器(默认端口 1234)
 * 后同时暴露两套 API:
 * - OpenAI 兼容层:/v1/chat/completions(对话,支持 tools/stream,
 *   delta.reasoning_content 输出思维链)——本引擎经 lmstudio-chat.ts 调用;
 * - Native 管理层:/api/v0/models(列表)/ /api/v0/models/load(加载,可指定
 *   context_length 上下文长度与 n_gpu_layers GPU 挂载层数)/
 *   /api/v0/models/unload(卸载)——设置界面「模型挂载管理」面板经
 *   main.cjs agent:lmstudio-models IPC 调用(0.3.6+ 支持)。
 *
 * 本地部署无需 API Key(留空直连);设置了访问密钥则非空携带 Bearer。
 * 与 DeepSeek/MiMo 模块零相互导入(工程约定:厂商模块完全独立)。
 */

/** 默认地址(LM Studio 本地服务器默认端口 1234) */
export const LMSTUDIO_DEFAULT_BASE_URL = 'http://127.0.0.1:1234'

/** 默认模型(空 = 未选择;由挂载面板「选用」写入,或手填已加载模型 key) */
export const LMSTUDIO_DEFAULT_MODEL = ''

/** LM Studio 官网(设置界面引导) */
export const LMSTUDIO_PLATFORM_URL = 'https://lmstudio.ai'

/**
 * 判定 baseURL 是否指向 LM Studio:地址含 "lmstudio" 或默认本地端口
 * (127.0.0.1:1234 / localhost:1234 / [::1]:1234)
 */
export function isLMStudioProvider(baseURL: string): boolean {
  const url = (baseURL || '').toLowerCase()
  if (!url) return false
  if (url.includes('lmstudio')) return true
  return url.includes('127.0.0.1:1234') || url.includes('localhost:1234') || url.includes('[::1]:1234')
}

/** Provider 展示名(设置界面协议提示行) */
export function lmstudioProviderLabel(_baseURL: string): string {
  return 'LM Studio Chat'
}

/**
 * HTTP 错误码 → 中文可读提示(与 deepseek/mimo 同款约定)
 */
export function lmstudioErrorMessage(status: number, detail: string): string {
  const tail = detail ? `:${detail.slice(0, 300)}` : ''
  if (status === 401 || status === 403) return `LM Studio 拒绝访问(${status})——服务器设置了访问密钥,请在 API Key 填写${tail}`
  if (status === 404) return `LM Studio 接口不存在(404)——请确认服务器已启动且版本 ≥ 0.3.6${tail}`
  if (status === 400) return `LM Studio 请求参数错误(400)——模型可能未加载或名称不匹配${tail}`
  if (status === 500 || status === 502 || status === 503) return `LM Studio 服务器内部错误(${status})——模型可能加载失败/显存不足${tail}`
  return `LM Studio 请求失败(HTTP ${status})${tail}`
}
