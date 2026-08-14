/**
 * 网页搜索簇(Bing 主用 + DuckDuckGo 回退)
 *
 * 2026-08-14 插件化六期从 tools.ts 拆出:HTML 标签/实体清理、Bing b_algo
 * 结果块解析、DDG html 端点解析、双源回退编排。仅依赖全局 fetch,
 * 无模块状态。tools.ts barrel 兼容 re-export。
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
