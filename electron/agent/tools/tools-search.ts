/**
 * 网页搜索/抓取簇(Bing 主用 + DuckDuckGo 回退;直连抓取兜底)
 *
 * 2026-08-14 插件化六期从 tools.ts 拆出:HTML 标签/实体清理、Bing b_algo
 * 结果块解析、DDG html 端点解析、双源回退编排。2026-10-22 补网页抓取
 * 兜底(DeepSeek 官方 /v1/tools/fetch 不可用时直连取正文)与正文格式化。
 * 仅依赖全局 fetch,无模块状态。tools.ts barrel 兼容 re-export。
 */

/** HTML 标签与实体清理 */
export function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const SEARCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/** Bing 搜索(国内可达;解析 b_algo 结果块) */
export async function searchBing(query: string, n: number): Promise<string> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${n}`
  const res = await fetch(url, { headers: { 'User-Agent': SEARCH_UA }, signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`Bing 返回 HTTP ${res.status}`)
  const html = await res.text()
  const itemRe =
    /<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)?[\s\S]*?<\/li>/g
  const results: string[] = []
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(html)) && results.length < n) {
    const href = m[1]
    if (!/^https?:\/\//i.test(href)) continue
    const title = stripHtml(m[2])
    const snippet = stripHtml(m[3] ?? '')
    if (!title) continue
    results.push(`${results.length + 1}. ${title}\n   ${href}\n   ${snippet}`)
  }
  if (results.length === 0) throw new Error('Bing 未解析到结果')
  return results.join('\n')
}

/** DuckDuckGo 搜索(回退;国内不可达,部分网络环境可用) */
export async function searchDuckDuckGo(query: string, n: number): Promise<string> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const res = await fetch(url, { headers: { 'User-Agent': SEARCH_UA }, signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`DDG 返回 HTTP ${res.status}`)
  const html = await res.text()
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g
  const links: Array<{ href: string; title: string }> = []
  let m: RegExpExecArray | null
  while ((m = linkRe.exec(html)) && links.length < n) {
    const href = m[1].replace(/^\/\/duckduckgo\.com\/l\/\?uddg=/, '').replace(/&rut=.*$/, '')
    links.push({ href: decodeURIComponent(href), title: stripHtml(m[2]) })
  }
  const snippets: string[] = []
  while ((m = snippetRe.exec(html)) && snippets.length < n) snippets.push(stripHtml(m[1]))
  if (links.length === 0) throw new Error('DDG 未解析到结果')
  return links.map((l, i) => `${i + 1}. ${l.title}\n   ${l.href}\n   ${snippets[i] ?? ''}`).join('\n')
}

/** 网页搜索(Bing 主用,DDG 回退;均失败给出明确提示) */
export async function webSearch(query: string, count: number): Promise<string> {
  const n = Math.min(Math.max(count || 5, 1), 10)
  try {
    return await searchBing(query, n)
  } catch {
    try {
      return await searchDuckDuckGo(query, n)
    } catch {
      return '(搜索服务暂不可达,可稍后重试或换关键词)'
    }
  }
}

/**
 * 网页抓取兜底(DeepSeek 官方 /v1/tools/fetch 不可用时):直连 URL 取正文
 * ——HTML 去脚本/样式/标签留段落感,非 HTML(text/plain/markdown/json)
 * 原文返回。失败抛中文错误(调用方回填 LLM 自纠)
 */
export async function fetchPageFallback(rawUrl: string): Promise<{ title: string; content: string }> {
  const url = String(rawUrl ?? '').trim()
  if (!/^https?:\/\//i.test(url)) throw new Error('仅支持 http/https 网址')
  const res = await fetch(url, {
    headers: {
      'User-Agent': SEARCH_UA,
      Accept: 'text/html,application/xhtml+xml,text/plain,text/markdown;q=0.9,*/*;q=0.5',
    },
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`目标站点返回 HTTP ${res.status}`)
  const ctype = (res.headers.get('content-type') ?? '').toLowerCase()
  const body = await res.text()
  if (!ctype.includes('html')) return { title: '', content: body }
  const title = stripHtml(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1] ?? '')
  const text = body
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|br|li|h[1-6]|tr|section|article|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
  const content = text
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { title, content }
}

/**
 * 网页正文 → LLM 面向文本(标题 + 正文)。截断到回填预算内
 * (truncateResult = 8000 字符,超出会被砍成无提示半截——此处主动
 * 截断并注明总长)
 */
export function formatPageResult(title: string, content: string, url?: string): string {
  const head = title ? `《${title}》${url ? `(${url})` : ''}` : url || '(无标题网页)'
  const body = String(content ?? '').trim()
  if (!body) return `${head}\n\n(该页面没有可读正文)`
  const max = 7600
  const trimmed =
    body.length > max
      ? `${body.slice(0, max)}\n…(正文过长已截断,完整正文共 ${body.length} 字)`
      : body
  return `${head}\n\n${trimmed}`
}
