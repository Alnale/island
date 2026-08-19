/**
 * 智谱 GLM 云端供应商常量与纯函数(2026-08-19 云端接入)
 *
 * 智谱开放平台(BigModel)官方 API:https://docs.bigmodel.cn
 * - 对话补全:POST {baseURL}/chat/completions(OpenAI 兼容格式,
 *   Bearer 认证,SSE 流式 + data: [DONE] 结束帧);
 * - API Key 在 https://bigmodel.cn/usercenter/proj-mgmt/apikeys 创建;
 * - 错误码:HTTP 状态码 + 响应体业务错误码 {"error":{code,message}}
 *   (https://docs.bigmodel.cn/cn/api/api-code)。
 *
 * 完全独立模块——与 deepseek/mimo/lmstudio/anthropic 零相互导入
 * (工程约定:厂商模块完全独立,允许合理重复)。
 */

/** GLM 云端默认 Base URL(智谱开放平台 v4 端点,不含 /chat/completions) */
export const GLM_CLOUD_DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'

/** GLM 云端默认模型(4.7 系 flash 变体:高性能低价格,适合默认;
 * 旗舰 glm-5.2 / glm-4.7 等可在设置界面手填切换) */
export const GLM_CLOUD_DEFAULT_MODEL = 'glm-4.7-flash'

/** 智谱开放平台控制台(设置界面引导/充值跳转) */
export const GLM_CLOUD_PLATFORM_URL = 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys'

/**
 * 判定 baseURL 是否指向智谱 GLM 云端:地址含 "bigmodel"
 * (open.bigmodel.cn 官方端点及自定义代理均命中)。
 * 必须在 DeepSeek 兜底判定之前调用——DeepSeek 会吞掉一切未知地址。
 */
export function isGlmCloudProvider(baseURL: string): boolean {
  const url = (baseURL || '').toLowerCase()
  return url.includes('bigmodel')
}

/** Provider 展示名(设置界面协议提示行) */
export function glmCloudProviderLabel(_baseURL: string): string {
  return '智谱 GLM 云端'
}

/**
 * GLM 云端错误 → 中文可读提示(官方错误码文档:
 * https://docs.bigmodel.cn/cn/api/api-code——外层 HTTP 状态码 +
 * 内层业务错误码,按业务码优先映射,未识别回落 HTTP 状态码)
 */
export function glmCloudErrorMessage(status: number, detail: string): string {
  let code = ''
  let message = ''
  const body = String(detail ?? '').trim()
  if (body) {
    try {
      const parsed = JSON.parse(body) as { error?: { code?: string | number; message?: string } }
      const err = parsed?.error
      if (err && typeof err === 'object') {
        code = String(err.code ?? '')
        message = String(err.message ?? '')
      }
    } catch {
      message = body.slice(0, 200)
    }
  }
  // 业务错误码映射(官方错误码表全文对齐)
  const byCode: Record<string, string> = {
    '1000': '身份验证失败(API Key 无效,请检查 Agent 设置里的 API Key)',
    '1001': '未收到鉴权参数(请求头缺少 Authorization,请检查 API Key)',
    '1003': 'API Key 已过期,请重新生成',
    '1005': '已开启二次认证保护,请前往智谱开放平台完成二次认证',
    '1113': '账户已欠费,请前往智谱开放平台充值后重试',
    '1200': 'API 调用失败(智谱服务器错误,请稍后重试)',
    '1210': 'API 调用参数有误,请检查请求参数',
    '1211': '模型不存在,请检查模型代码',
    '1212': '当前模型不支持该调用方式',
    '1213': '未正常接收到请求参数',
    '1214': '请求参数非法,请检查文档',
    '1220': '无权访问该 API',
    '1221': '该 API 已下线',
    '1222': '该 API 不存在',
    '1230': 'API 调用流程出错(智谱服务器错误)',
    '1234': '网络错误,请联系智谱客服',
    '1261': 'Prompt 超长(上下文超出模型限制,请精简对话或清空会话)',
    '1301': '内容安全拦截(输入或生成内容包含敏感内容,请调整措辞)',
    '1302': '已达速率限制,请控制请求频率',
    '1305': '该模型当前访问量过大,请稍后再试',
    '1308': '已达使用上限,限额将在重置时间后恢复',
    '1309': 'GLM Coding Plan 套餐已到期,请前往官网续订',
    '1310': '已达每周/每月使用上限,限额将在重置时间后恢复',
    '1311': '当前订阅套餐未开放该模型权限,请更换模型或升级套餐',
    '1314': '企业套餐已失效,请联系企业管理员',
    '1315': '该 API Key 仅限企业编程套餐场景使用,请更换产品类型的 API Key',
    '1316': '已达 5 小时使用上限(主账号余额不足),限额将在重置时间后恢复',
    '1317': '已达 7 天使用上限(主账号余额不足),限额将在重置时间后恢复',
    '1318': '已达 5 小时使用上限(子账号月消费上限),请联系管理员调整',
    '1319': '已达 7 天使用上限(子账号月消费上限),请联系管理员调整',
    '1320': '已达 5 小时使用上限(企业级月消费上限),限额将在重置时间后恢复',
    '1321': '已达 7 天使用上限(企业级月消费上限),限额将在重置时间后恢复',
  }
  // HTTP 状态码兜底(业务码未识别时)
  const byStatus: Record<number, string> = {
    400: '请求参数错误(参数格式/JSON 无效/Prompt 超长或内容不合规)',
    401: '认证失败(API Key 无效,请检查 Agent 设置里的 API Key)',
    403: '无权访问该接口(套餐/权限限制)',
    429: '请求频率或额度超限(欠费/速率限制/使用上限,请稍后重试或充值)',
    500: '智谱服务器内部错误,请稍后重试',
    503: '智谱服务器繁忙(过载或维护中,请稍后重试)',
  }
  if (code && byCode[code]) {
    const hint = message ? `:${message.slice(0, 300)}` : ''
    return `智谱 GLM API 请求失败(${code}):${byCode[code]}${hint}`
  }
  const fallback = byStatus[status] ?? `HTTP ${status}`
  const hint = message ? `:${message.slice(0, 300)}` : body ? `:${body.slice(0, 200)}` : ''
  return `智谱 GLM API 请求失败:${fallback}${hint}`
}
