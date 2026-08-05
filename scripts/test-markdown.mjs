/**
 * Markdown 解析器测试 —— 纯函数直测,不经 React 渲染
 *
 * esbuild 把 markdownParser.ts 打包为 ESM(零依赖,无 DOM/React),
 * data URL 导入后在 node 里跑断言。覆盖块级(段落/标题/setext/hr/
 * 列表嵌套/有序 start/引用/围栏/表格对齐与转义)、行内(粗斜删/
 * 行内代码/链接/裸 URL/下划线词内不强调/转义)与流式退化场景。
 *
 * 用法:node scripts/test-markdown.mjs
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const entry = path.join(
  root,
  'src',
  'components',
  'DynamicIsland',
  'views',
  'markdownParser.ts',
)

const result = await build({
  entryPoints: [entry],
  bundle: true,
  write: false,
  format: 'esm',
  logLevel: 'warning',
})
const code = result.outputFiles[0].text
const mod = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
const { parseMarkdown, parseInlines } = mod

let passed = 0
let failed = 0
function check(name, cond) {
  if (cond) {
    passed++
  } else {
    failed++
    console.error(`✗ ${name}`)
  }
}

/** 深比较(数组/对象,字符串直比) */
function eq(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (Array.isArray(a)) {
    return a.length === b.length && a.every((x, i) => eq(x, b[i]))
  }
  if (a && b && typeof a === 'object') {
    const ka = Object.keys(a)
    return ka.length === Object.keys(b).length && ka.every((k) => eq(a[k], b[k]))
  }
  return false
}

/** 断言两个解析结果相等(输出差异方便定位) */
function checkEq(name, got, want) {
  if (eq(got, want)) {
    passed++
  } else {
    failed++
    console.error(`✗ ${name}`)
    console.error(`  got:  ${JSON.stringify(got)}`)
    console.error(`  want: ${JSON.stringify(want)}`)
  }
}

/* ------------------------------ 块级 ------------------------------ */

checkEq('空文本 → 无块', parseMarkdown(''), [])
checkEq('空行文本 → 无块', parseMarkdown('\n  \n'), [])

checkEq(
  '段落',
  parseMarkdown('hello world'),
  [{ t: 'p', c: [{ t: 'text', s: 'hello world' }] }],
)

checkEq(
  '段落单换行 = 软换行',
  parseMarkdown('第一行\n第二行'),
  [
    {
      t: 'p',
      c: [
        { t: 'text', s: '第一行' },
        { t: 'br' },
        { t: 'text', s: '第二行' },
      ],
    },
  ],
)

check('双换行 → 两个段落', parseMarkdown('a\n\nb').map((b) => b.t).join() === 'p,p')

checkEq(
  '标题级别',
  parseMarkdown('# 一\n### 三'),
  [
    { t: 'h', l: 1, c: [{ t: 'text', s: '一' }] },
    { t: 'h', l: 3, c: [{ t: 'text', s: '三' }] },
  ],
)

checkEq(
  'setext h1/h2',
  parseMarkdown('标题一\n===\n\n标题二\n---'),
  [
    { t: 'h', l: 1, c: [{ t: 'text', s: '标题一' }] },
    { t: 'h', l: 2, c: [{ t: 'text', s: '标题二' }] },
  ],
)

checkEq(
  '独立分隔线 hr',
  parseMarkdown('a\n\n---\n\nb'),
  [
    { t: 'p', c: [{ t: 'text', s: 'a' }] },
    { t: 'hr' },
    { t: 'p', c: [{ t: 'text', s: 'b' }] },
  ],
)

checkEq(
  '无序列表',
  parseMarkdown('- a\n- b'),
  [
    {
      t: 'ul',
      items: [
        { c: [{ t: 'text', s: 'a' }], sub: [] },
        { c: [{ t: 'text', s: 'b' }], sub: [] },
      ],
    },
  ],
)

checkEq(
  '有序列表 start 序号',
  parseMarkdown('3. a\n4. b'),
  [
    {
      t: 'ol',
      start: 3,
      items: [
        { c: [{ t: 'text', s: 'a' }], sub: [] },
        { c: [{ t: 'text', s: 'b' }], sub: [] },
      ],
    },
  ],
)

check(
  '列表嵌套',
  parseMarkdown('- a\n  - b\n- c')[0].t === 'ul' &&
    parseMarkdown('- a\n  - b\n- c')[0].items[0].sub[0].t === 'ul',
)

check(
  '列表后接段落',
  parseMarkdown('- a\n- b\n\n正文').map((b) => b.t).join() === 'ul,p',
)

checkEq(
  '引用',
  parseMarkdown('> 引用内容'),
  [
    {
      t: 'q',
      c: [{ t: 'p', c: [{ t: 'text', s: '引用内容' }] }],
    },
  ],
)

check(
  '引用内嵌套列表',
  parseMarkdown('> - a\n> - b')[0].t === 'q' && parseMarkdown('> - a\n> - b')[0].c[0].t === 'ul',
)

check(
  '引用内代码块',
  parseMarkdown('> ```js\n> const a = 1\n> ```')[0].c[0].t === 'code' &&
    parseMarkdown('> ```js\n> const a = 1\n> ```')[0].c[0].s === 'const a = 1',
)

checkEq(
  '围栏代码块(语言 + 内容)',
  parseMarkdown('```js\nconst a = 1\n```'),
  [{ t: 'code', lang: 'js', s: 'const a = 1' }],
)

checkEq(
  'mermaid 围栏',
  parseMarkdown('```mermaid\nflowchart TD\nA-->B\n```'),
  [{ t: 'code', lang: 'mermaid', s: 'flowchart TD\nA-->B' }],
)

check(
  '未闭合围栏吃到结尾',
  parseMarkdown('```js\nconst a = 1')[0].t === 'code' &&
    parseMarkdown('```js\nconst a = 1')[0].s === 'const a = 1',
)

checkEq(
  '表格(对齐)',
  parseMarkdown('| a | b |\n|---|---:|\n| 1 | 2 |'),
  [
    {
      t: 'table',
      align: ['l', 'r'],
      header: [
        [{ t: 'text', s: 'a' }],
        [{ t: 'text', s: 'b' }],
      ],
      rows: [[[{ t: 'text', s: '1' }], [{ t: 'text', s: '2' }]]],
    },
  ],
)

const tblPipe = parseMarkdown('| a | b \\| c |\n|---|---|').find((b) => b.t === 'table')
const cellText = (nodes) => nodes.map((n) => (n.t === 'text' ? n.s : '')).join('')
check(
  '表格转义管道:单元格不拆、内容还原为 |',
  tblPipe && cellText(tblPipe.header[0]) === 'a' && cellText(tblPipe.header[1]) === 'b | c',
)

const tblCode = parseMarkdown('| a | `x|y` |\n|---|---|\n| 1 | 2 |').find((b) => b.t === 'table')
check(
  '表格行内代码内管道不拆分',
  tblCode &&
    tblCode.header.length === 2 &&
    tblCode.header[1].every((n) => n.t === 'code' && n.s === 'x|y'),
)

check(
  '流式部分表格(无分隔行)→ 段落',
  parseMarkdown('| a | b |')[0].t === 'p',
)

/* ------------------------------ 行内 ------------------------------ */

checkEq(
  '粗体/斜体/删除线',
  parseInlines('**b** *i* ~~s~~'),
  [
    { t: 'b', c: [{ t: 'text', s: 'b' }] },
    { t: 'text', s: ' ' },
    { t: 'i', c: [{ t: 'text', s: 'i' }] },
    { t: 'text', s: ' ' },
    { t: 's', c: [{ t: 'text', s: 's' }] },
  ],
)

checkEq(
  '粗体内嵌斜体',
  parseInlines('**b *i* b**'),
  [{ t: 'b', c: [{ t: 'text', s: 'b ' }, { t: 'i', c: [{ t: 'text', s: 'i' }] }, { t: 'text', s: ' b' }] }],
)

checkEq('行内代码', parseInlines('`code`'), [{ t: 'code', s: 'code' }])

check(
  '单词内下划线不强调',
  parseInlines('foo_bar_baz').every((n) => n.t === 'text'),
)

checkEq(
  '下划线斜体',
  parseInlines('_it_ ok'),
  [{ t: 'i', c: [{ t: 'text', s: 'it' }] }, { t: 'text', s: ' ok' }],
)

checkEq(
  '链接',
  parseInlines('[text](https://a.com)'),
  [{ t: 'a', h: 'https://a.com', c: [{ t: 'text', s: 'text' }] }],
)

checkEq(
  '裸 URL 自动链接(去尾随标点)',
  parseInlines('看 https://a.com/x。'),
  [
    { t: 'text', s: '看 ' },
    { t: 'a', h: 'https://a.com/x', c: [{ t: 'text', s: 'https://a.com/x' }] },
  ],
)

checkEq(
  '图片 → 链接',
  parseInlines('![图](https://a.com/i.png)'),
  [{ t: 'a', h: 'https://a.com/i.png', c: [{ t: 'text', s: '图' }] }],
)

check(
  '反斜杠转义(相邻 text 节点渲染时连成一体)',
  parseInlines('\\*x\\*').every((n) => n.t === 'text') &&
    parseInlines('\\*x\\*').map((n) => n.s).join('') === '*x*',
)

check(
  '流式未闭合强调退化为文本',
  parseInlines('**b').every((n) => n.t === 'text'),
)

checkEq(
  '__粗体(双下划线)',
  parseInlines('__b__'),
  [{ t: 'b', c: [{ t: 'text', s: 'b' }] }],
)

// 回归:共享 /g 正则 lastIndex 被递归内层重置 → 外层从 0 重扫 = 死循环 OOM。
// 以下输入都经过递归分支(~~链接 / 链接文本内嵌粗体 / _斜体)
check(
  '递归不循环(回归:lastIndex 死循环)',
  parseInlines('~~s~~ 和 [**b**](https://a.com) 和 _it_ 和 `c`').length > 0,
)

/* ------------------------------ 汇总 ------------------------------ */

console.log(`Markdown 解析器测试:${passed} 通过,${failed} 失败`)
if (failed > 0) process.exit(1)
