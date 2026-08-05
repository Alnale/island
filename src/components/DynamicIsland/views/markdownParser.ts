/**
 * 消息气泡 Markdown 解析器(纯函数,零依赖,不依赖 DOM/React)
 *
 * 支持 GitHub 风格子集,面向 LLM 输出设计:
 * - 块级:段落(单换行 = 软换行 <br>)、标题(#~######)、setext 标题、
 *   hr、无序/有序列表(缩进嵌套、有序 start 序号)、引用(递归解析,
 *   可嵌列表/代码块)、围栏代码块(```lang)、GFM 表格(对齐 `:---:`、
 *   转义管道 `\|`、行内代码内的管道不拆分);
 * - 行内:**粗体** / *斜体* / ~~删除线~~ / `行内代码` / [链接](url) /
 *   裸 http(s) URL 自动链接 / <url> / ![图片](url) → 渲染为链接(岛内
 *   不显示远程图片)/ 反斜杠转义。
 *
 * 流式友好:未闭合的围栏/表格/强调在增量文本里自然退化为普通段落,
 * 内容补齐后重新解析即成形(渲染端对每次增量重新 parse,天然收敛)。
 * 全部文本最终经 React 转义输出,无 HTML 注入面。
 */

/** 行内节点(递归容器:c 为子节点) */
export type MdInline =
  | { t: 'text'; s: string }
  | { t: 'br' }
  | { t: 'b'; c: MdInline[] }
  | { t: 'i'; c: MdInline[] }
  | { t: 's'; c: MdInline[] }
  | { t: 'code'; s: string }
  | { t: 'a'; h: string; c: MdInline[] }

/** 列表项:主体行内内容 + 后续子块(嵌套列表/段落) */
export type MdListItem = { c: MdInline[]; sub: MdBlock[] }

/** 表格行 = 格数组;格 = 行内节点数组 */
export type MdTableRow = MdInline[][]

/** 块级节点 */
export type MdBlock =
  | { t: 'p'; c: MdInline[] }
  | { t: 'h'; l: number; c: MdInline[] }
  | { t: 'ul'; items: MdListItem[] }
  | { t: 'ol'; start: number; items: MdListItem[] }
  | { t: 'q'; c: MdBlock[] }
  | { t: 'code'; lang: string; s: string }
  | { t: 'table'; align: Array<'l' | 'c' | 'r'>; header: MdTableRow; rows: MdTableRow[] }
  | { t: 'hr' }

/**
 * 行内词法:单条全局正则按序交替匹配,捕获组区分类型。
 * 定界符用非捕获组,组号 = 内容本身:
 * 1/2 反引号对与内容 | 3 **粗体 | 4 __粗体 | 5 *斜体 | 6 _斜体 |
 * 7 ~~删除线 | 8/9 图片 alt/url | 10/11 链接文本/url | 12 裸 URL |
 * 13/14 反斜杠转义。
 * 注意:必须用 text.matchAll(内部克隆正则,递归安全)——共享单例 + /g
 * 的 lastIndex 会被递归的内层 parseInlines 重置,外层 exec 从 0 重新
 * 匹配 = 死循环 OOM(实测 `~~s~~` 链接分支复现)
 */
const INLINE_TOKEN =
  /(`{1,2})([^`\n]+)\1|(?:\*\*)(.+?)(?:\*\*)|(?:__)(.+?)(?:__)|(?:\*)(.+?)(?:\*)|(?:_)([^_\n]+?)(?:_)|(?:~~)(.+?)(?:~~)|!\[([^\]]*)\]\(([^)\s]+)[^)]*\)|\[([^\]]+)\]\(([^)\s]+)[^)]*\)|(https?:\/\/[^\s<>"')\]]+)|(\\)([\\`*_[\]{}()#+\-.!|>])/g

/** 行内文本两侧的"词字符"(下划线强调判定用:CJK 也算词) */
const WORD_RE = /[\w一-鿿]/

/** 裸 URL 尾部常见的标点(不属于 URL 的一部分) */
const URL_TRAIL = /[.,;:!?。，；：、]+$/

/** 表格分隔行:每格(去掉首尾管道)形如 :---: / --- / ---: 等 */
const TABLE_SEP_CELL = /^:?-+:?$/

/** 围栏代码块起始 / 引用行前缀 / 列表项标记 / 标题 / hr / setext */
const FENCE_RE = /^( {0,3})(`{3,}|~{3,})\s*(\S*)\s*$/
const QUOTE_RE = /^ {0,3}> ?/
const LIST_RE = /^( {0,3})([-*+]|\d+\.)( +)(.*)$/
const HEADING_RE = /^( {0,3})(#{1,6})[ \t]+(.*)$/
const HR_RE = /^( {0,3})(-{3,}|\*{3,}|_{3,})\s*$/
const SETEXT_RE = /^( {0,3})(={3,}|-{3,})\s*$/

/** 行内代码 / 引用 / 围栏 / 列表 / 表格起始:段落遇到即终止 */
function startsBlock(line: string, next: string | undefined): boolean {
  return (
    HEADING_RE.test(line) ||
    FENCE_RE.test(line) ||
    QUOTE_RE.test(line) ||
    LIST_RE.test(line) ||
    (!!next && line.includes('|') && isTableSep(next))
  )
}

/** 表格行拆分:按未转义的管道切分,行内代码(反引号对数)内的管道不切 */
function splitTableRow(line: string): string[] {
  const s = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let cur = ''
  let ticks = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '`') ticks++
    if (ch === '|' && s[i - 1] !== '\\' && ticks % 2 === 0) {
      cells.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  cells.push(cur.trim())
  return cells
}

/** 表格分隔行判定:≥2 格且每格都是 :---: 形态 */
function isTableSep(line: string): boolean {
  const t = line.trim()
  if (!t.includes('|')) return false
  const cells = splitTableRow(t)
  return cells.length >= 2 && cells.every((c) => TABLE_SEP_CELL.test(c))
}

/** URL 清洗:截掉尾随标点(裸 URL 自动链接常见) */
function cleanUrl(raw: string): string {
  return raw.trim().replace(URL_TRAIL, '')
}

/** 行内解析:matchAll 全串扫描 + 递归(粗体里嵌斜体等) */
export function parseInlines(text: string): MdInline[] {
  const out: MdInline[] = []
  let pos = 0
  for (const m of text.matchAll(INLINE_TOKEN)) {
    const start = m.index
    if (start > pos) out.push({ t: 'text', s: text.slice(pos, start) })
    const before = text[start - 1]
    const after = text[start + m[0].length]
    if (m[2] !== undefined) out.push({ t: 'code', s: m[2] })
    else if (m[3] !== undefined) out.push({ t: 'b', c: parseInlines(m[3]) })
    else if (m[4] !== undefined) out.push({ t: 'b', c: parseInlines(m[4]) })
    else if (m[5] !== undefined) out.push({ t: 'i', c: parseInlines(m[5]) })
    else if (m[6] !== undefined) {
      // 下划线强调:两侧贴词字符(标识符 foo_bar)不视为强调
      if ((before !== undefined && WORD_RE.test(before)) || (after !== undefined && WORD_RE.test(after))) {
        out.push({ t: 'text', s: m[0] })
      } else {
        out.push({ t: 'i', c: parseInlines(m[6]) })
      }
    } else if (m[7] !== undefined) out.push({ t: 's', c: parseInlines(m[7]) })
    else if (m[8] !== undefined) {
      // 图片 → 链接(岛内不加载远程图片,只给可点击文本)
      out.push({ t: 'a', h: cleanUrl(m[9]), c: [{ t: 'text', s: m[8] || m[9] }] })
    } else if (m[10] !== undefined) out.push({ t: 'a', h: cleanUrl(m[11]), c: parseInlines(m[10]) })
    else if (m[12] !== undefined) {
      const url = cleanUrl(m[12])
      out.push({ t: 'a', h: url, c: [{ t: 'text', s: url }] })
    } else if (m[13] !== undefined) out.push({ t: 'text', s: m[14] })
    pos = start + m[0].length
  }
  if (pos < text.length) out.push({ t: 'text', s: text.slice(pos) })
  return out
}

/** 段落:多行合并,行间插入软换行 <br>(单换行 = 换行,双换行 = 新段落) */
function parseParagraph(lines: string[]): MdInline[] {
  const out: MdInline[] = []
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) out.push({ t: 'br' })
    out.push(...parseInlines(lines[i]))
  }
  return out
}

/** 列表项构建:首行为主体行内内容,其余行递归解析为子块(嵌套列表等) */
function buildListItem(lines: string[]): MdListItem {
  const first = lines[0] ?? ''
  const sub = lines.slice(1)
  if (sub.length === 0) return { c: parseInlines(first), sub: [] }
  const blocks = parseMarkdown(sub.join('\n'))
  const head = first.trim() ? [{ t: 'p' as const, c: parseInlines(first) }] : []
  const merged = [...head, ...blocks]
  const c = merged[0]?.t === 'p' ? merged[0].c : []
  const rest = merged[0]?.t === 'p' ? merged.slice(1) : merged
  return { c, sub: rest }
}

/** 列表项 marker 类型是否一致(无序 vs 有序) */
const sameListType = (a: string, b: string) => /^\d/.test(a) === /^\d/.test(b)

/**
 * 块级解析主入口:逐行扫描,遇到块结构立即产出,普通行累积为段落。
 * 递归用于引用内容 / 列表项内容(嵌套结构天然支持)。
 */
export function parseMarkdown(text: string): MdBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blocks: MdBlock[] = []
  let i = 0
  const n = lines.length

  while (i < n) {
    const line = lines[i]

    if (/^\s*$/.test(line)) {
      i++
      continue
    }

    // 围栏代码块(未闭合则一直吃到结尾——GFM 语义,流式增量自然未闭合)
    const fence = FENCE_RE.exec(line)
    if (fence) {
      const ch = fence[2][0]
      const minLen = fence[2].length
      const lang = fence[3]
      const buf: string[] = []
      i++
      while (i < n) {
        const l = lines[i]
        const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(l)
        if (close && close[1][0] === ch && close[1].length >= minLen) break
        buf.push(l)
        i++
      }
      i++ // 跳过闭合围栏(或已到结尾)
      blocks.push({ t: 'code', lang, s: buf.join('\n') })
      continue
    }

    // 标题
    const heading = HEADING_RE.exec(line)
    if (heading) {
      blocks.push({ t: 'h', l: heading[2].length, c: parseInlines(heading[3]) })
      i++
      continue
    }

    // 水平线
    if (HR_RE.test(line)) {
      blocks.push({ t: 'hr' })
      i++
      continue
    }

    // 引用(连续行,内容去掉前缀后递归解析)
    if (QUOTE_RE.test(line)) {
      const buf: string[] = []
      while (i < n && QUOTE_RE.test(lines[i])) {
        buf.push(lines[i].replace(QUOTE_RE, ''))
        i++
      }
      blocks.push({ t: 'q', c: parseMarkdown(buf.join('\n')) })
      continue
    }

    // 表格:当前行含管道 + 下一行为分隔行
    if (line.includes('|') && i + 1 < n && isTableSep(lines[i + 1])) {
      const header = splitTableRow(line)
      const seps = splitTableRow(lines[i + 1])
      const align = seps.map((c) => {
        const l = c.startsWith(':')
        const r = c.endsWith(':')
        return (l && r ? 'c' : r ? 'r' : 'l') as 'l' | 'c' | 'r'
      })
      i += 2
      const rows: MdTableRow[] = []
      while (i < n) {
        const l = lines[i]
        if (!l.includes('|') || /^\s*$/.test(l) || QUOTE_RE.test(l) || FENCE_RE.test(l)) break
        rows.push(splitTableRow(l).map(parseInlines))
        i++
      }
      blocks.push({
        t: 'table',
        align,
        header: header.map(parseInlines),
        rows,
      })
      continue
    }

    // 列表:同缩进同类型 marker 归一组,更深的行作当前项续行(递归解析)
    const list = LIST_RE.exec(line)
    if (list) {
      const indent = list[1].length
      const marker = list[2]
      const ordered = /^\d/.test(marker)
      const start = ordered ? parseInt(marker, 10) : 1
      const items: MdListItem[] = []
      let cur: string[] | null = null
      const flush = () => {
        if (cur) {
          items.push(buildListItem(cur))
          cur = null
        }
      }
      while (i < n) {
        const l = lines[i]
        // 空行跳过:后跟同缩进 marker = 松列表继续;后跟更深缩进 = 当前项续行
        if (/^\s*$/.test(l)) {
          i++
          continue
        }
        const lm = LIST_RE.exec(l)
        if (lm && lm[1].length === indent && sameListType(lm[2], marker)) {
          flush()
          cur = [lm[4]]
          i++
          continue
        }
        // 更深缩进 = 当前项续行(剥掉列表缩进,保留相对缩进给递归解析)
        if (cur && /^\s/.test(l) && (l.match(/^\s*/)?.[0].length ?? 0) > indent) {
          cur.push(l.slice(indent))
          i++
          continue
        }
        break
      }
      flush()
      blocks.push(ordered ? { t: 'ol', start, items } : { t: 'ul', items })
      continue
    }

    // 段落(累积到下一个块结构 / setext / 空行)
    const buf: string[] = []
    let pushed = false
    while (i < n) {
      const l = lines[i]
      if (/^\s*$/.test(l)) break
      // setext 下划线:整个段落成为 h1(=) / h2(-)(已由 push 消费,不再落段落)
      const setext = SETEXT_RE.exec(l)
      if (setext) {
        blocks.push(
          buf.length > 0
            ? { t: 'h', l: setext[2][0] === '=' ? 1 : 2, c: parseParagraph(buf) }
            : { t: 'hr' },
        )
        pushed = true
        i++
        break
      }
      if (startsBlock(l, lines[i + 1])) break
      buf.push(l)
      i++
    }
    if (!pushed && buf.length > 0) blocks.push({ t: 'p', c: parseParagraph(buf) })
  }

  return blocks
}
