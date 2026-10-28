/**
 * DeepSeek 官方网页搜索/抓取 API 客户端(2026-10-22 联网搜索/网页抓取适配)
 *
 * 官方文档:
 * - 指南 https://api-docs.deepseek.com/zh-cn/guides/search
 * - 网页搜索 https://api-docs.deepseek.com/zh-cn/api/search
 *   (POST {base}/v1/tools/search,自研搜索引擎)
 * - 网页抓取 https://api-docs.deepseek.com/zh-cn/api/fetch
 *   (POST {base}/v1/tools/fetch,返回标题 + Markdown 正文)
 *
 * 计费(官方):按**成功请求次数**计费,Search 与 Fetch 均 5 元/千次
 * (约 0.005 元/次;仅 HTTP 200 且有结果才计费,失败/无结果/超时不计费,
 * count 不影响单价)。限速(按账号):Search QPS 100 / Fetch QPS 25,超限 429。
 *
 * 错误(官方):400 参数不合法 / 401 Key 缺失或无效 / 402 余额不足 /
 * 403 抓取被安全策略拒绝 / 404 页面无可用内容 / 408 读取请求体超时 /
 * 413 请求体过大 / 429 超 QPS / 500 服务器错误 / 504 下游超时;
 * 408/429/5xx 可稍后重试,其余 4xx 不改请求不要重试。
 *
 * 响应字段(搜索):rerank_score(0-3 排序分,官方:≥1.5 为优质结果)/
 * title / url / snippet(100-200 字,**适合展示**)/ summary(600-800 字,
 * **官方:适用于给模型阅读**)/ content(need_content=true 才有)/
 * site_name / site_icon / date(UTC RFC 3339)/ authority(0-4,-1 未知,
 * 官方:≥3 极权威)。
 *
 * 鉴权:Authorization: Bearer <DeepSeek API Key>(与 chat 同一 Key)。
 * 请求一律**不传 signal**(providers 域硬约束:fetch 中止销毁 socket =
 * Node 22 llhttp UAF 主进程段错误,见 sse.ts parseSse 注释;工具层
 * 60s 兜底超时防挂死)。
 */

import { DEEPSEEK_DEFAULT_BASE_URL } from './deepseek-constants'

/** DeepSeek 官方搜索/抓取凭据(providers.deepseek 桶,与激活供应商无关) */
export interface DeepseekWebCreds {
  apiKey: string
  baseURL: string
}

/** 搜索结果条目(字段语义见文件头官方注释) */
export interface DeepseekSearchItem {
  title: string
  url: string
  /** 短摘要(约 100-200 字,适合展示) */
  snippet: string
  /** 长摘要(约 600-800 字,官方:适用于给模型阅读) */
  summary: string
  /** 网页正文(仅 need_content=true 时非空) */
  content: string
  siteName: string | null
  date: string | null
  /** 排序分 0-3(官方:≥1.5 为优质结果) */
  rerankScore: number
  /** 权威性 0-4(-1 未知;官方:≥3 极权威) */
  authority: number
}

/**
 * 端点拼装:协议后缀(/anthropic /chat /v1)归一后挂 /v1/tools/<kind>
 * (官方:POST https://api.deepseek.com/v1/tools/search|fetch;用户配置的
 * baseURL 可能带协议后缀,统一剥掉)
 */
export function deepseekToolsEndpoint(baseURL: string, kind: 'search' | 'fetch'): string {
  const raw = String(baseURL ?? '').trim() || DEEPSEEK_DEFAULT_BASE_URL
  const base = raw.replace(/\/+$/, '').replace(/\/(anthropic|chat|v1)$/i, '')
  return `${base}/v1/tools/${kind}`
}

/**
 * 抓取 URL 校验(官方:非空、≤8192 字符、含 host 的 http/https、
 * 不能携带用户名或密码)。合法返回原 URL,非法抛中文错误
 */
export function assertWebFetchUrl(raw: string): string {
  const url = String(raw ?? '').trim()
  if (!url) throw new Error('url 不能为空')
  if (url.length > 8192) throw new Error('url 超过 8192 字符上限')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('url 不是合法的 http/https 网址')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('仅支持 http/https 网址')
  }
  if (!parsed.hostname) throw new Error('url 缺少主机名')
  if (parsed.username || parsed.password) {
    throw new Error('url 不能携带用户名或密码')
  }
  return url
}

/** 错误码 → 中文提示(官方错误表,见文件头) */
function webErrorMessage(status: number, detail: string): string {
  let message = ''
  try {
    const parsed = JSON.parse(detail) as {
      error?: { message?: string; type?: string; code?: string } | string
      message?: string
    }
    if (parsed && typeof parsed === 'object') {
      const err = parsed.error
      message = typeof err === 'string' ? err : (err?.message ?? parsed.message ?? '')
    }
  } catch {
    message = detail.trim().slice(0, 200)
  }
  const known: Record<number, string> = {
    400: '请求参数错误',
    401: '认证失败(API Key 无效,请检查 Agent 设置里的 API Key)',
    402: '余额不足(请前往 DeepSeek 平台充值)',
    403: '抓取被目标站点安全策略拒绝',
    404: '页面无可用内容(不可达/被拦截/内容类型不支持)',
    408: '读取请求体超时(可稍后重试)',
    413: '请求体过大',
    429: '请求频率超限(账号 QPS:搜索 100 / 抓取 25,可稍后重试)',
    500: 'DeepSeek 服务器内部错误(可稍后重试)',
    504: '目标站点超时(可稍后重试)',
  }
  const hint = message ? `:${message.slice(0, 300)}` : ''
  return `DeepSeek 网页工具请求失败:${known[status] ?? `HTTP ${status}`}${hint}`
}

/** JSON POST(带 Bearer 鉴权;失败抛中文错误) */
async function postJson(url: string, apiKey: string, body: unknown): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey.trim()}`,
      },
      body: JSON.stringify(body),
      // 不传 signal(llhttp UAF 规避,见文件头;工具层兜底超时)
    })
  } catch (err) {
    throw new Error(`无法连接 DeepSeek 网页工具 API(${url}):${(err as Error).message}`)
  }
  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.text()).slice(0, 500)
    } catch {
      // 忽略读失败
    }
    throw new Error(webErrorMessage(res.status, detail))
  }
  return res.json()
}

/**
 * 网页搜索(POST /v1/tools/search)。
 * opts.needContent=true 才回传网页正文 content(默认 summary 供模型阅读
 * 即可,正文让 LLM 用 web_fetch 按需抓);query/ori_question 官方限 1-128
 * 字符,count 1-50(缺省 10)
 */
export async function deepseekWebSearch(
  creds: DeepseekWebCreds,
  opts: { query: string; count?: number; oriQuestion?: string; needContent?: boolean },
): Promise<DeepseekSearchItem[]> {
  const query = String(opts.query ?? '').trim()
  if (!query) throw new Error('query 不能为空')
  const count = Math.min(Math.max(Math.round(Number(opts.count) || 10), 1), 50)
  const oriQuestion = String(opts.oriQuestion ?? '').trim().slice(0, 128) || undefined
  const data = (await postJson(deepseekToolsEndpoint(creds.baseURL, 'search'), creds.apiKey, {
    query: query.slice(0, 128),
    count,
    ...(oriQuestion ? { ori_question: oriQuestion } : {}),
    need_content: opts.needContent === true,
  })) as { results?: unknown[] }
  const raw = Array.isArray(data.results) ? data.results : []
  return raw.slice(0, count).map((item): DeepseekSearchItem => {
    const r = (item ?? {}) as Record<string, unknown>
    const str = (v: unknown) => (typeof v === 'string' ? v : '')
    return {
      title: str(r.title),
      url: str(r.url),
      snippet: str(r.snippet),
      summary: str(r.summary),
      content: str(r.content),
      siteName: typeof r.site_name === 'string' && r.site_name ? r.site_name : null,
      date: typeof r.date === 'string' && r.date ? r.date : null,
      rerankScore: typeof r.rerank_score === 'number' ? r.rerank_score : 0,
      authority: typeof r.authority === 'number' ? r.authority : -1,
    }
  })
}

/**
 * 搜索结果 → LLM 面向文本(官方:summary"适用于给模型阅读",snippet
 * 短摘要兜底;相关度 ≥1.5/权威 ≥3 标注,方便 LLM 判断可信度)
 */
export function formatDeepseekSearchResults(results: DeepseekSearchItem[], query: string): string {
  if (results.length === 0) return `(未找到与「${query}」相关的结果,可换关键词再搜)`
  const lines: string[] = [
    `「${query}」的搜索结果 ${results.length} 条(摘要供阅读,需要全文可对链接用 web_fetch 抓取):`,
  ]
  results.forEach((r, i) => {
    const meta: string[] = []
    if (r.siteName) meta.push(`来源:${r.siteName}`)
    if (r.date) meta.push(`发布:${r.date.slice(0, 10)}`)
    if (r.rerankScore >= 1.5) meta.push(`优质·相关度 ${r.rerankScore.toFixed(1)}`)
    if (r.authority >= 3) meta.push(`权威 ${r.authority}/4`)
    lines.push(`${i + 1}. ${r.title || '(无标题)'}\n   ${r.url}\n   ${r.summary || r.snippet || '(无摘要)'}`)
    if (meta.length > 0) lines.push(`   [${meta.join(' · ')}]`)
  })
  return lines.join('\n')
}

/**
 * 网页抓取(POST /v1/tools/fetch):返回页面标题 + Markdown 正文。
 * 校验走 assertWebFetchUrl(官方:≤8192 字符、http/https、无凭据)
 */
export async function deepseekWebFetchPage(
  creds: DeepseekWebCreds,
  url: string,
): Promise<{ title: string; content: string }> {
  const data = (await postJson(deepseekToolsEndpoint(creds.baseURL, 'fetch'), creds.apiKey, {
    url: assertWebFetchUrl(url),
  })) as { title?: unknown; content?: unknown }
  return {
    title: typeof data.title === 'string' ? data.title : '',
    content: typeof data.content === 'string' ? data.content : '',
  }
}
