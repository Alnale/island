/**
 * 消息气泡 Markdown 渲染组件(配合 markdownParser.ts 使用)
 *
 * - `Markdown`:块级渲染(段落/标题/列表/引用/代码块/表格/分隔线),
 *   行内渲染(粗体/斜体/删除线/行内代码/链接)。全部文本经 React 转义,
 *   无 HTML 注入面;
 * - `MermaidBlock`:```mermaid 代码块 → 图表。mermaid 懒加载(dynamic
 *   import,构建按需分包,首次遇到图表才下载)+ 模块级渲染缓存(流式
 *   增量重解析时同代码直接复用 SVG,不重复渲染);securityLevel 'strict'
 *   由 mermaid 自身转义 HTML 标签,插入 SVG 前无外部数据;
 * - 链接:http(s) 渲染为可点击锚点,点击经 `window.desktop.openExternal`
 *   (挂件)用系统浏览器打开,Web 演示版回退 window.open;
 * - `CopyButton`:从 AgentView 迁出(消息气泡与代码块头部共用)。
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { parseMarkdown, type MdBlock, type MdInline } from './markdownParser'

/** 写入剪贴板:Clipboard API 优先,失败(非安全上下文等)回退 execCommand */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }
}

/** 复制按钮:点击把文本写入剪贴板,短暂显示 ✓ 反馈。
 * 拦截左键 pointerdown —— 消息区内交互元素,长按不触发岛体收回 */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className={`island-agent-copy${copied ? ' copied' : ''}`}
      title="复制"
      aria-label="复制"
      onPointerDown={(event) => {
        if (event.button === 0) event.stopPropagation()
      }}
      onClick={(event) => {
        event.stopPropagation()
        void copyToClipboard(text).then((ok) => {
          if (!ok) return
          setCopied(true)
          window.setTimeout(() => setCopied(false), 900)
        })
      }}
    >
      {copied ? (
        '✓'
      ) : (
        <svg
          className="island-ctl-svg"
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  )
}

/** 挂件(desktop.preload)里用系统浏览器打开;Web 演示版回退新标签页 */
function openExternalUrl(url: string) {
  const api = (window as unknown as {
    desktop?: { openExternal?: (url: string) => void }
  }).desktop
  if (api?.openExternal) {
    api.openExternal(url)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

/** 链接:仅 http(s) 渲染为可点击锚点,其余原样文本(防协议注入) */
function LinkNode({ h, c }: { h: string; c: MdInline[] }) {
  const href = h
  if (!/^https?:\/\//i.test(href)) return <>{renderInlines(c)}</>
  return (
    <a
      href={href}
      className="island-agent-md-link"
      title={href}
      onPointerDown={(event) => {
        if (event.button === 0) event.stopPropagation()
      }}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        openExternalUrl(href)
      }}
    >
      {renderInlines(c)}
    </a>
  )
}

/** 行内节点 → React 元素(文本全部经 React 转义) */
function renderInlines(inl: MdInline[]): ReactNode[] {
  return inl.map((node, i) => {
    switch (node.t) {
      case 'text':
        return node.s
      case 'br':
        return <br key={i} />
      case 'b':
        return <strong key={i}>{renderInlines(node.c)}</strong>
      case 'i':
        return <em key={i}>{renderInlines(node.c)}</em>
      case 's':
        return <del key={i}>{renderInlines(node.c)}</del>
      case 'code':
        return <code key={i}>{node.s}</code>
      case 'a':
        return <LinkNode key={i} h={node.h} c={node.c} />
    }
  })
}

/** 表格对齐 → 单元格 style */
function alignStyle(a: 'l' | 'c' | 'r' | undefined) {
  if (a === 'c') return { textAlign: 'center' as const }
  if (a === 'r') return { textAlign: 'right' as const }
  return undefined
}

/** 围栏代码块:头部(语言标签 + 复制按钮)+ 代码(超出滚动) */
function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const label = lang.replace(/[^\w+#-]/g, '').slice(0, 24)
  return (
    <div className="island-agent-code">
      <div className="island-agent-code-head">
        {label && <span className="island-agent-code-lang">{label}</span>}
        <CopyButton text={code} />
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  )
}

/* ============================== Mermaid ============================== */

/** mermaid API 最小类型(避免依赖其完整 d.ts 的形状演进) */
type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void
  render: (id: string, text: string) => Promise<{ svg: string }>
}

/** 模块级懒加载单例:首次遇到 mermaid 块才下载图表引擎(构建分包) */
let mermaidPromise: Promise<MermaidApi> | null = null
/** 已渲染 SVG 缓存:流式重解析 / 视图来回切换同代码不重复渲染 */
const mermaidSvgCache = new Map<string, string>()
/** 渲染失败的代码:不再重试(避免每次挂载都白跑一次) */
const mermaidFailCache = new Set<string>()
let mermaidSeq = 0

/** 懒加载 mermaid 并做一次性初始化(深色主题匹配岛体) */
function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid')
      .then(async (mod) => {
        const m = mod.default as unknown as MermaidApi
        // 主题色/字体从岛体实时计算样式读取(自定义主题色与字体跟随)
        const island = document.querySelector<HTMLElement>('.island-demo')
        const styles = island ? getComputedStyle(island) : null
        const accent =
          styles?.getPropertyValue('--state-color').trim() || '#4d6bfe'
        m.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          themeVariables: {
            background: 'transparent',
            primaryColor: '#1d2742',
            primaryTextColor: '#e9edf5',
            primaryBorderColor: accent,
            lineColor: '#55607a',
            secondaryColor: '#232c41',
            tertiaryColor: '#161d2e',
            clusterBkg: '#131a28',
            clusterBorder: '#2c3650',
            edgeLabelBackground: '#131a28',
            fontFamily: styles?.fontFamily || `'Segoe UI', system-ui, sans-serif`,
            fontSize: '13px',
          },
        })
        return m
      })
      .catch((err) => {
        mermaidPromise = null // 加载失败可重试
        throw err
      })
  }
  return mermaidPromise
}

/** mermaid 块:懒加载渲染图表,失败回退源码代码块 */
function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(() => mermaidSvgCache.get(code) ?? null)
  const [failed, setFailed] = useState(() => mermaidFailCache.has(code))
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    if (failed) return
    const cached = mermaidSvgCache.get(code)
    if (cached) {
      setSvg(cached)
      return
    }
    let cancelled = false
    const id = `md-mermaid-${++mermaidSeq}`
    loadMermaid()
      .then((m) => m.render(id, code))
      .then(({ svg: out }) => {
        if (cancelled || !mountedRef.current) return
        mermaidSvgCache.set(code, out)
        setSvg(out)
      })
      .catch(() => {
        if (cancelled) return
        mermaidFailCache.add(code)
        setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [code, failed])

  useEffect(() => () => void (mountedRef.current = false), [])

  if (failed) {
    return (
      <>
        <div className="island-agent-mermaid-err">图表渲染失败,已显示源码</div>
        <CodeBlock lang="mermaid" code={code} />
      </>
    )
  }
  if (!svg) {
    return <div className="island-agent-mermaid-loading">正在渲染图表…</div>
  }
  return (
    <div
      className="island-agent-mermaid"
      aria-label="Mermaid 图表"
      // mermaid 自身在 securityLevel 'strict' 下已转义标签,产物可信
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

/* ============================== 块级渲染 ============================== */

/**
 * 渲染块。trailing:流式光标等尾随节点——块是段落时插到段内行内末尾
 * (光标贴住正在流的文字),其他块型则忽略(光标只属于文本流)
 */
function renderBlock(b: MdBlock, key: number, plainMermaid: boolean, trailing?: ReactNode): ReactNode {
  switch (b.t) {
    case 'p':
      return (
        <p key={key}>
          {renderInlines(b.c)}
          {trailing}
        </p>
      )
    case 'h': {
      const Tag = `h${Math.min(6, Math.max(1, b.l))}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
      return <Tag key={key}>{renderInlines(b.c)}</Tag>
    }
    case 'ul':
      return (
        <ul key={key}>
          {b.items.map((item, i) => (
            <li key={i}>
              {renderInlines(item.c)}
              {item.sub.length > 0 && <>{item.sub.map((s, j) => renderBlock(s, j, plainMermaid))}</>}
            </li>
          ))}
        </ul>
      )
    case 'ol':
      return (
        <ol key={key} start={b.start}>
          {b.items.map((item, i) => (
            <li key={i}>
              {renderInlines(item.c)}
              {item.sub.length > 0 && <>{item.sub.map((s, j) => renderBlock(s, j, plainMermaid))}</>}
            </li>
          ))}
        </ol>
      )
    case 'q':
      return (
        <blockquote key={key}>
          {b.c.map((s, i) => renderBlock(s, i, plainMermaid))}
        </blockquote>
      )
    case 'code':
      // ```mermaid 渲染图表;plainMermaid(用户气泡)按普通代码块显示
      return b.lang.toLowerCase() === 'mermaid' && !plainMermaid ? (
        <MermaidBlock key={key} code={b.s} />
      ) : (
        <CodeBlock key={key} lang={b.lang} code={b.s} />
      )
    case 'table':
      return (
        <div className="island-agent-table-wrap" key={key}>
          <table>
            <thead>
              <tr>
                {b.header.map((c, i) => (
                  <th key={i} style={alignStyle(b.align[i])}>
                    {renderInlines(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci} style={alignStyle(b.align[ci])}>
                      {renderInlines(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'hr':
      return <hr key={key} />
  }
}

/**
 * Markdown 渲染入口。
 * @param plainMermaid 用户气泡:```mermaid 按普通代码块显示(图表是深色
 *   主题,塞进浅色用户气泡里不可读)
 * @param caret 流式光标:附加在最后一个段落文本末尾(贴住正在流的文字)
 */
export function Markdown({
  text,
  plainMermaid = false,
  caret = false,
}: {
  text: string
  plainMermaid?: boolean
  caret?: boolean
}) {
  const blocks = useMemo(() => parseMarkdown(text), [text])
  return (
    <div className="island-agent-md">
      {blocks.map((b, i) =>
        renderBlock(
          b,
          i,
          plainMermaid,
          caret && i === blocks.length - 1 ? (
            <span className="island-agent-caret" aria-hidden="true" />
          ) : undefined,
        ),
      )}
    </div>
  )
}
