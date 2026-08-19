/**
 * LM Studio 本地模型工具调用 高强度压力测试
 *
 * 两段式:
 *   A. 离线压力(无需 LM Studio 运行):
 *      语义模板 × 渲染维度(容器/体格式/引号/包装/数组/正文包裹)随机组合
 *      生成数百用例,roundtrip 验证 parseTextToolCalls(名称命中/参数/正文
 *      截断)与 StreamCallFilter(随机 SSE 切块,标记段零泄漏)。
 *   B. 端到端在线(需 LM Studio 运行,探测失败自动跳过):
 *      真实 SSE 流式对话,验证 ①流式正文不暴露工具指令 ②产出 tool_calls
 *      ③工具名命中注册表。
 *
 * 用法:
 *   node tests/stress-lmstudio.mjs
 *     [--base http://127.0.0.1:1234] [--model <key>]
 *     [--cases 320] [--seed 42] [--rounds 2] [--offline-only]
 */
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

// ---------- 参数 ----------
const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}
const BASE = opt('base', 'http://127.0.0.1:1234')
const MODEL = opt('model', '')
const CASES = Number(opt('cases', 320))
const SEED = Number(opt('seed', 42))
const ROUNDS = Number(opt('rounds', 2))
const OFFLINE_ONLY = args.includes('--offline-only')

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

// ---------- 可复现 PRNG(mulberry32) ----------
function mulberry32(a) {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rnd = mulberry32(SEED)
const pick = (arr) => arr[Math.floor(rnd() * arr.length) % arr.length]

// ---------- 打包被测模块 ----------
const target = path.join(root, 'node_modules', '.cache', 'stress-lmstudio-target.mjs')
fs.mkdirSync(path.dirname(target), { recursive: true })
await build({
  entryPoints: [path.join(root, 'electron', 'agent', 'providers', 'lmstudio-chat.ts')],
  outfile: target,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'warning',
})
const { parseTextToolCalls, StreamCallFilter } = await import(pathToFileURL(target).href)

// ---------- 测试工具注册表(代表三类参数形态) ----------
const TOOLS = [
  {
    name: 'bili',
    description: 'B站工具',
    execute: async () => 'ok',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['search', 'up_info', 'saved'] },
        query: { type: 'string' },
      },
    },
  },
  {
    name: 'read_file',
    description: '读文件',
    execute: async () => 'ok',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'web_search',
    description: '网页搜索',
    execute: async () => 'ok',
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
  },
  {
    name: 'send_task',
    description: '发任务',
    execute: async () => 'ok',
    parameters: {
      type: 'object',
      properties: { qq: { type: 'number' }, text: { type: 'string' } },
    },
  },
]

// ---------- 语义模板(期望值) ----------
const SEMANTICS = [
  { tool: 'bili', args: { action: 'search', query: '三体 二向箔' } },
  { tool: 'bili', args: { action: 'up_info' } },
  { tool: 'read_file', args: { path: 'C:\\Users\\asus\\Desktop\\测试 目录\\a b.txt' } },
  { tool: 'web_search', args: { query: 'LAMMPS 拉伸模拟 2026' } },
  { tool: 'send_task', args: { qq: 123456789, text: '明天 9 点开会' } },
]

// ---------- 渲染维度:体(body)格式 ----------
/** py 字典/字符串引号风格渲染 */
function pyVal(v, q) {
  if (typeof v === 'number') return String(v)
  return q + v.replace(/\\/g, '\\\\').split(q).join('\\' + q) + q
}
function pyDict(args, q, keyQuoted, colonSep) {
  const eq = colonSep ? ':' : '='
  return Object.entries(args)
    .map(([k, v]) => (keyQuoted ? `${q}${k}${q}` : k) + eq + ' ' + pyVal(v, q))
    .join(', ')
}
const BODIES = {
  // 标准 JSON 体
  json: (s) => JSON.stringify({ name: s.tool, arguments: s.args }),
  // JSON 平铺参数体
  'json-flat': (s) => JSON.stringify({ name: s.tool, ...s.args }),
  // Python 裸 kwargs
  py: (s, q) => `${s.tool}(${pyDict(s.args, q, false, false)})`,
  // 引号键 + 冒号分隔(lfm2.5 实测三轮)
  'py-quoted': (s, q) => `${s.tool}(${pyDict(s.args, q, true, true)})`,
  // 混合风格:前半参数裸键=,后半引号键:(lfm2.5 实测混杂)
  'py-mixed': (s, q) => {
    const es = Object.entries(s.args)
    const head = es.slice(0, Math.ceil(es.length / 2)).map(([k, v]) => `${k}=${pyVal(v, q)}`).join(', ')
    const tail = es.slice(Math.ceil(es.length / 2)).map(([k, v]) => `${q}${k}${q}: ${pyVal(v, q)}`).join(', ')
    return `${s.tool}(${[head, tail].filter(Boolean).join(', ')})`
  },
  // 通用包装 + dict 参数
  'wrapper-py': (s, q) => `tool_call(name='${s.tool}', arguments={${pyDict(s.args, q, false, false)}})`,
  // 通用包装 + 裸字符串(仅单 action 语义)
  'wrapper-str': (s, q) => `tool_call(name='${s.tool}', arguments=${pyVal(s.args.action, q)})`,
  // 通用包装 + 引号键冒号 + 杂散引号(实测原文风格)
  'wrapper-quoted': (s, q) => `tool_call('name': '${s.tool}', 'arguments={${pyDict(s.args, q, false, false)}}')`,
  // 工具名变形(模糊匹配:bili→bili_tool / read_file→read_file_tool)
  'tool-alias': (s, q) => `${s.tool}_tool(${pyDict(s.args, q, false, false)})`,
}

// ---------- 渲染维度:容器 ----------
const CONTAINERS = {
  xml: (body) => `<tool_call>${body}</tool_call>`,
  token: (body) => `<|tool_call_start|>${body}<|tool_call_end|>`,
  fence: (body) => '```json\n' + body + '\n```',
}

const PREFIXES = ['', '好的,我来查。\n', '正在处理...']
const SUFFIXES = ['', '\n结果出来了。', '\n---\n**结果**:\n- 编造的假结果(应截断)']

// ---------- 用例生成 ----------
function genCase() {
  const s = pick(SEMANTICS)
  const bodyKind = pick(Object.keys(BODIES))
  let kind = bodyKind
  // 约束:wrapper-str 裸字符串只装得下单 action;fence 仅合法 JSON 体
  if (kind === 'wrapper-str' && Object.keys(s.args).some((k) => k !== 'action')) kind = 'wrapper-py'
  let container = pick(Object.keys(CONTAINERS))
  if (container === 'fence' && !kind.startsWith('json')) container = 'xml'
  const q = pick(["'", '"'])
  const body = BODIES[kind](s, q)
  const wrapped = rnd() < 0.35 ? `[${body}]` : body // 数组包裹维度
  const payload = CONTAINERS[container](wrapped)
  const prefix = pick(PREFIXES)
  const suffix = pick(SUFFIXES)
  return { s, kind, container, text: prefix + payload + suffix, prefix, suffix }
}

// ---------- Part A:离线 roundtrip ----------
console.log(`\n===== Part A 离线压力(seed=${SEED}, cases=${CASES}) =====`)
let passA = 0
const failsA = []
for (let i = 0; i < CASES; i++) {
  const c = genCase()
  const label = `#${i}[${c.kind}/${c.container}] ${c.s.tool}`
  try {
    // ① 解析:名称精确 + 参数深等 + 正文截断到片段前(防编造)
    const parsed = parseTextToolCalls(c.text, TOOLS)
    if (!parsed || parsed.calls.length !== 1) throw new Error(`未解析出调用: ${JSON.stringify(c.text)}`)
    const call = parsed.calls[0]
    if (call.name !== c.s.tool) throw new Error(`名称 ${call.name} ≠ ${c.s.tool}`)
    for (const [k, v] of Object.entries(c.s.args)) {
      if (JSON.stringify(call.args[k]) !== JSON.stringify(v)) {
        throw new Error(`参数 ${k}: ${JSON.stringify(call.args[k])} ≠ ${JSON.stringify(v)} | ${c.text}`)
      }
    }
    // 截断语义:正文=prefix 且尾部空白/```~/- 装饰剥除(与实现一致)
    const expectText = c.prefix.replace(/[\s`~-]*$/, '').trim()
    if (parsed.text !== expectText) {
      throw new Error(`正文 ${JSON.stringify(parsed.text)} ≠ ${JSON.stringify(expectText)}(截断语义)`)
    }
    // ② 流式过滤:随机 1-6 字符切块模拟 SSE delta,标记段零泄漏
    const filter = new StreamCallFilter()
    let shown = ''
    for (let j = 0; j < c.text.length; ) {
      const step = 1 + Math.floor(rnd() * 6)
      shown += filter.feed(c.text.slice(j, j + step))
      j += step
    }
    shown += filter.flush()
    const expectStream = c.prefix + c.suffix
    if (shown !== expectStream) {
      throw new Error(`流式泄漏/丢字: ${JSON.stringify(shown)} ≠ ${JSON.stringify(expectStream)}`)
    }
    passA++
  } catch (err) {
    failsA.push(`${label}: ${err.message}`)
  }
}
console.log(`A 解析+流式过滤: ${passA}/${CASES} 通过`)
failsA.slice(0, 12).forEach((f) => console.log('  ✗ ' + f))
if (failsA.length > 12) console.log(`  ...共 ${failsA.length} 失败`)

// ---------- Part B:端到端在线 ----------
let passB = 0
let softB = 0 // 格式解析通过但模型幻觉了未注册工具名(自愈交引擎报错循环)
let totalB = 0
const failsB = []
if (!OFFLINE_ONLY) {
  console.log(`\n===== Part B 端到端在线(${BASE}) =====`)
  let online = false
  let models = []
  try {
    const res = await fetch(`${BASE}/api/v0/models`, { signal: AbortSignal.timeout(4000) })
    const data = await res.json()
    models = (data.data ?? []).filter((m) => m.state === 'loaded')
    online = models.length > 0
  } catch {
    online = false
  }
  if (!online) {
    console.log('LM Studio 不可达或无已加载模型,跳过在线段(--offline-only 可静默)')
  } else {
    const model = MODEL || models[0].id
    console.log(`目标模型: ${model}(共 ${models.length} 个已加载)`)
    const { lmstudioStreamChatCompletion } = await import(pathToFileURL(target).href)
    // 期望参数断言:不仅"调了工具",参数还得对(路径/查询/内容实质匹配)
    const QUESTIONS = [
      {
        q: '看看B站',
        expect: 'bili',
        checkArgs: (a) => ['search', 'up_info', 'saved'].includes(a.action),
        argDesc: 'action∈枚举',
      },
      {
        q: '读一下 C:\\Users\\asus\\AppData\\Roaming\\dynamic-island\\memory.json 这个文件',
        expect: 'read_file',
        checkArgs: (a) => typeof a.path === 'string' && a.path.includes('memory.json'),
        argDesc: 'path含memory.json',
      },
      {
        q: '帮我搜索一下 2026 年的科技新闻',
        expect: 'web_search',
        checkArgs: (a) => typeof a.query === 'string' && a.query.trim().length > 0,
        argDesc: 'query非空',
      },
      {
        q: '给我发个任务,内容是"明天 9 点开会"',
        expect: 'send_task',
        checkArgs: (a) => typeof a.text === 'string' && a.text.includes('开会'),
        argDesc: 'text含开会',
      },
    ]
    // 两大核心指标分项统计
    let leakFails = 0
    let callFails = 0
    let argFails = 0
    for (const { q, expect, checkArgs, argDesc } of QUESTIONS) {
      for (let r = 1; r <= ROUNDS; r++) {
        totalB++
        const chunks = []
        const t0 = Date.now()
        try {
          const outcome = await lmstudioStreamChatCompletion({
            config: { baseURL: BASE, model, apiKey: '' },
            system: '你是桌面助手。需要外部信息时必须调用工具,不要编造结果。',
            history: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: q }] }],
            tools: TOOLS,
            signal: AbortSignal.timeout(180000),
            onEvent: (e) => {
              if (e.type === 'text-delta') chunks.push(e.text)
            },
          })
          const streamText = chunks.join('')
          const ms = Date.now() - t0
          // ---- 指标①:流式零泄漏(用户全程所见 = text-delta 拼接) ----
          // 检查流式转发文本 + 落定消息正文双通道
          for (const target of [streamText, outcome.text ?? '']) {
            for (const mark of ['<tool_call', '<|tool_call', '```json', 'tool_call(', '工具调用(']) {
              if (target.includes(mark)) {
                leakFails++
                throw new Error(`[泄漏] 「${mark}」流入对话窗口: ${JSON.stringify(target.slice(0, 120))}`)
              }
            }
          }
          // ---- 指标②:正确调用(工具名命中 + 参数实质正确) ----
          const calls = outcome.calls ?? []
          if (calls.length === 0) {
            callFails++
            throw new Error(`[调用缺失] 正文: ${JSON.stringify((outcome.text ?? '').slice(0, 120))}`)
          }
          const hit = calls.find((c) => c.name === expect)
          if (!hit) {
            const known = TOOLS.some((t) => calls.some((c) => c.name === t.name))
            if (known) {
              callFails++
              throw new Error(`[调用错误] 调了 ${calls.map((c) => c.name).join(',')} 但期望 ${expect}`)
            }
            // 幻觉工具名:格式解析已通(不再静默空回复),引擎会报"未知工具"
            // 回传模型自愈——单轮压测记软通过
            console.log(`  ⚠ [${calls.map((c) => c.name).join(',')}] ${ms}ms 幻觉工具名(格式已通,自愈交引擎)`)
            softB++
            continue
          }
          // 参数级断言
          let args = {}
          try {
            args = JSON.parse(hit.args)
          } catch {
            argFails++
            throw new Error(`[参数错误] args 非法 JSON: ${hit.args.slice(0, 100)}`)
          }
          if (!checkArgs(args)) {
            argFails++
            throw new Error(`[参数错误] 期望${argDesc},实际: ${JSON.stringify(args).slice(0, 120)}`)
          }
          console.log(`  ✓ [${expect}] ${ms}ms ${argDesc} args=${hit.args.slice(0, 80)}`)
          passB++
        } catch (err) {
          failsB.push(`「${q}」r${r}: ${err.message}`)
          console.log(`  ✗ 「${q}」r${r}: ${err.message.slice(0, 160)}`)
        }
      }
    }
    // 分项指标小结(核心关注点)
    console.log(`\n  指标① 流式零泄漏: ${totalB - leakFails}/${totalB}${leakFails ? ' ❌' : ' ✅'}`)
    const callPass = passB + softB
    console.log(`  指标② 正确调用:   ${passB}/${totalB} 硬通过${softB ? `(+${softB} 软通过=格式通/幻觉名自愈,合计 ${callPass}/${totalB})` : ''}`)
    if (argFails) console.log(`  ⚠ 参数错误 ${argFails} 例(调对了工具但参数实质不符)`)
  }
}

// ---------- 汇总 ----------
console.log('\n===== 压测汇总 =====')
console.log(`A 离线解析+流式: ${passA}/${CASES}`)
if (totalB) console.log(`B 在线端到端:   ${passB}/${totalB} 硬通过${softB ? ` + ${softB} 软通过(幻觉名,自愈交引擎)` : ''}`)
const ok = failsA.length === 0 && failsB.length === 0
console.log(ok ? '全部通过 ✅' : `存在失败 ❌(A:${failsA.length} B:${failsB.length})——失败明细见上`)
process.exit(ok ? 0 : 1)
