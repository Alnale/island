/**
 * LM Studio Chat Completions Provider(本地工作站 OpenAI 兼容层)
 *
 * 端点:POST {baseURL}/v1/chat/completions(默认 http://127.0.0.1:1234;
 * baseURL 以 /v1 结尾时不再重复拼接——兼容 OpenAI 习惯地址)。
 *
 * 与云端 DeepSeek Chat(chat.ts)的关键差异(本模块独立实现,不导入
 * DeepSeek/MiMo 业务代码):
 * - **不发送思考参数**:LM Studio 不支持 thinking/reasoning_effort,
 *   思考与否由所加载模型决定(推理模型自动输出思维链);设置界面在
 *   LM Studio 激活时已屏蔽「思考强度」;
 * - **不发送 max_tokens(输出预算)**:本地推理由 LM Studio 应用(加载
 *   模型时的配置)管理输出长度——不消耗云端额度,程序不设硬编码上限
 *   (2026-08-18;旧硬编码 4096 会把思维链超长的推理模型正文掐断);
 * - **历史不回传 reasoning_content**:LM Studio 无 DeepSeek 的多轮
 *   思考回传要求,assistant 消息只带 content/tool_calls(未知字段有
 *   被严格校验拒绝的风险,不带最安全);
 * - **API Key 可选**:本地部署默认免鉴权,非空才带 Bearer 头;
 * - **思维链输出**:推理模型经 delta.reasoning_content 输出(OpenAI
 *   兼容层与 DeepSeek R1 格式对齐),照常转发 reasoning-delta 事件;
 * - **模型须已加载**:model 为空时直接报可读错误(引导到设置界面的
 *   「模型挂载管理」面板选用已加载模型)。
 *
 * 流式 SSE:OpenAI 格式 data: {...} 帧,最后 data: [DONE];工具调用按
 * index 流式 delta(首个 delta 带 id/name,后续只带 arguments 增量);
 * usage 在末尾 chunk 返回。
 */

import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { parseSse, sanitizeJsonStrings, truncateResult } from './sse'
import { lmstudioErrorMessage } from './lmstudio-constants'
// GLM-4-9B 系专属档位(2026-08-19 实测优化,适配独立:仅 isGlm4Model 命中
// 时生效,其它模型不经过 lmstudio-glm4 任何代码路径)
import {
  GLM4_TOOL_GUIDE_ADDON,
  Glm4StreamGuard,
  glm4ParseBareCalls,
  glm4SanitizeText,
  isGlm4Model,
} from './lmstudio-glm4'
import type { AgentConfig, AgentEvent, AgentMessage, AgentPart, AgentTool, ProviderOutcome } from '../types'

/** 工具 → Chat Completions tools(OpenAI 格式:function 嵌套) */
function lmstudioTools(tools: AgentTool[]) {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

// ---------------------------------------------------------------------------
// 文本工具调用幻觉解析(2026-08-19 修复本地模型不调工具)
// ---------------------------------------------------------------------------
// 小模型(nanbeige4.2-3b / lfm2.5-2.6b 等)的 chat template 不支持 OpenAI
// tools 协议,LM Studio 不会把它们的工具意图解析成 tool_calls 通道,而是
// 原样吐正文——两种实测形态:
// ① 特殊 token 格式(lfm2.5,Llama 系模板标记):
//   <|tool_call_start|>bili_tool(action='up_info', params={'path': '...'})<|tool_call_end|>
// ② markdown JSON 块(nanbeige,模仿工具协议的自由文本):
//   ```json {"action": "search", "params": {"type": "download_dir"}} ```
//   且常伴随编造的"结果"段落——必须截断丢弃,引擎执行真工具后回填。
// 解析策略:片段提取 → 名称模糊匹配已注册工具(bili_tool→bili) →
// params/arguments 嵌套提升 → 参数按键名过滤(只留 schema 已定义键) →
// 正文截断到首个调用片段前。

/** 文本幻觉调用的 id 前缀(历史回传分流标记:伪调用转文本,协议调用保持原样) */
export const TEXT_CALL_ID_PREFIX = 'lms-txt-'

/**
 * 工具调用格式指引(2026-08-19 完整工具闭环):LM Studio 的多数本地小
 * 模型没有协议级工具通道——tools 只被渲染进 prompt,模型的调用意图不会
 * 回到 tool_calls 通道而是混在正文里。注入规范格式指引 + 文本解析 +
 * 历史文本回传,形成与云端模型一致的工具体验(支持协议的模型不受影响:
 * 它们走 tool_calls 通道,指引仅是冗余文本)。格式采用 Qwen/Hermes 系
 * 模型训练熟悉的 <tool_call> 标签(ReAct 惯例),提高小模型依从率。
 */
const TOOL_CALL_GUIDE = `

## 工具调用方法(重要)
你可以调用上述工具。需要调用时,严格按此格式输出,一次一个:
<tool_call>
{"name": "工具名", "arguments": {"参数名": "参数值"}}
</tool_call>
规则:
- 输出 </tool_call> 后立即停止,等待工具执行;绝对不要自己编造工具的执行结果
- 工具的真实结果会以 <tool_result> 标签送回,届时基于真实结果继续回答
- 不需要工具时直接回答,不要输出任何工具格式`

/** 工具名归一:小写 + 去非字母数字汉字 */
const normToolName = (s: string) => s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '')

/** 工具名模糊匹配:精确 → 互含(取最短命中,最精确) */
function fuzzyToolName(name: string, tools: AgentTool[]): AgentTool | null {
  const n = normToolName(name)
  if (!n) return null
  let best: AgentTool | null = null
  let bestLen = Infinity
  for (const t of tools) {
    const tn = normToolName(t.name)
    if (!tn) continue
    if (n === tn) return t
    if ((n.includes(tn) || tn.includes(n)) && tn.length < bestLen) {
      best = t
      bestLen = tn.length
    }
  }
  return best
}

/** Python 字面量解析(单/双引号字符串、数字、true/false/None、嵌套
 *  dict/list)——解析 `<|tool_call_start|>name(key=val, ...)` 括号内
 *  的 kwargs(lfm2.5 输出单引号 dict,JSON.parse 不吃) */
function parsePyValue(src: string, pos: { i: number }): unknown {
  while (pos.i < src.length && /\s/.test(src[pos.i]!)) pos.i++
  const c = src[pos.i]
  if (c === '{') {
    pos.i++
    const out: Record<string, unknown> = {}
    while (pos.i < src.length) {
      while (pos.i < src.length && /[\s,]/.test(src[pos.i]!)) pos.i++
      if (src[pos.i] === '}') {
        pos.i++
        return out
      }
      const key = String(parsePyValue(src, pos))
      // 分隔符:= 或 : 皆可(2026-08-19 压测:lfm2.5 也输出 {action= 'search'}
      // 等号分隔的 dict——旧实现只跳 [:=] 遇 = 卡死循环)
      while (pos.i < src.length && /[\s=:]/.test(src[pos.i]!)) pos.i++
      out[key] = parsePyValue(src, pos)
    }
    return out
  }
  if (c === '[') {
    pos.i++
    const arr: unknown[] = []
    while (pos.i < src.length) {
      while (pos.i < src.length && /[\s,]/.test(src[pos.i]!)) pos.i++
      if (src[pos.i] === ']') {
        pos.i++
        return arr
      }
      arr.push(parsePyValue(src, pos))
    }
    return arr
  }
  if (c === "'" || c === '"') {
    const quote = c
    pos.i++
    let s = ''
    while (pos.i < src.length) {
      const ch = src[pos.i]!
      if (ch === '\\') {
        const next = src[pos.i + 1]
        pos.i += 2
        // 路径安全转义(2026-08-19 实测回归):仅收敛 \\ \' \",其余
        // (\U \A \d 等 Windows 路径段)原样保留反斜杠——旧实现丢反斜杠
        // 把 C:\Users 解析成 C:Users,工具拿到损坏路径
        if (next === '\\') s += '\\'
        else if (next === "'") s += "'"
        else if (next === '"') s += '"'
        else if (next === undefined) s += '\\'
        else s += `\\${next}`
        continue
      }
      if (ch === quote) {
        pos.i++
        return s
      }
      s += ch
      pos.i++
    }
    return s
  }
  // 标识符字面量(true/false/None)或数字
  let word = ''
  while (pos.i < src.length && /[A-Za-z0-9_+\-.]/.test(src[pos.i]!)) {
    word += src[pos.i]
    pos.i++
  }
  if (word === 'true') return true
  if (word === 'false') return false
  if (word === 'None' || word === 'null') return null
  // 防死循环(2026-08-19 压测发现):首字符不可识别(= } ) 等)时 word 为空,
  // Number('')===0 非 NaN 返回但未消费字符 → 调用方 while 永不前进挂死。
  // 必须消费一个字符并按原样返回。
  if (!word) {
    const ch = src[pos.i] ?? ''
    pos.i++
    return ch
  }
  const num = Number(word)
  return Number.isNaN(num) ? word : num
}

/** `name(key=val, ...)` Python 风格调用 → {name, args} */
function parsePyCall(src: string): { name: string; args: Record<string, unknown> } | null {
  // 函数名含中文(在线压测实测:工具调用(name='read_file', ...))
  const m = /^([A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff]*)\s*\(/.exec(src.trim())
  if (!m) return null
  const name = m[1]!
  const inner = src.trim().slice(m[0].length).replace(/\)\s*$/, '')
  const pos = { i: 0 }
  const args: Record<string, unknown> = {}
  while (pos.i < inner.length) {
    while (pos.i < inner.length && /[\s,]/.test(inner[pos.i]!)) pos.i++
    if (pos.i >= inner.length) break
    // 键:裸标识符或带引号('name'/"name")——lfm2.5 实测混杂
    // 'name': 'x' 与 'arguments= 杂散引号格式(2026-08-19 回归)
    const quote = inner[pos.i] === "'" || inner[pos.i] === '"' ? inner[pos.i] : ''
    if (quote) pos.i++
    let key = ''
    while (pos.i < inner.length && /[A-Za-z0-9_]/.test(inner[pos.i]!)) {
      key += inner[pos.i]
      pos.i++
    }
    if (quote && inner[pos.i] === quote) pos.i++
    // 分隔符:= (kwargs 风格)或 : (dict 风格)皆可
    while (pos.i < inner.length && /[\s=:]/.test(inner[pos.i]!)) pos.i++
    if (!key) {
      pos.i++
      continue
    }
    args[key] = parsePyValue(inner, pos)
  }
  return { name, args }
}

/** 剥离 [...] 数组包裹(lfm2.5 实测把调用放数组里:[name(kwargs)]) */
function stripArrayWrap(body: string): string {
  let s = body
  while (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim()
    if (!inner) return ''
    s = inner
  }
  return s
}

/**
 * 通用包装函数名(2026-08-19 实测回归):lfm2.5 有时把调用再包一层——
 * tool_call(name='bili-tool', arguments='up_info')。函数名本身是
 * 通用词(非真实工具),真实工具名在 name= 参数,arguments= 常是裸
 * 字符串(action 值)而非 dict——需解包后才能匹配到工具。
 */
const GENERIC_WRAPPER_NAMES = new Set([
  'toolcall',
  'tool',
  'function',
  'functioncall',
  'call',
  'tooluse',
  'usetool',
  // 中文包装词(在线压测实测 lfm2.5:工具名('read_file', ...)/工具名='search', ...)
  '工具名',
  '函数名',
  '工具调用',
  '函数调用',
  '工具',
  '函数',
  '调用工具',
  '调用函数',
])

/**
 * 解通用包装:tool_call(name='bili-tool', arguments=X) →
 * {name:'bili-tool', args:X 归一}。非包装格式原样返回。
 * 无嵌套 name= 时返回 undefined 名称(交 resolveCall 走 action 枚举反查)。
 */
function unwrapGenericCall(py: { name: string; args: Record<string, unknown> }): {
  name: string | undefined
  args: Record<string, unknown>
} {
  if (!GENERIC_WRAPPER_NAMES.has(normToolName(py.name))) return py
  // name 来源:name= / tool_name= / 工具名= 等元键(值形式)
  let innerName = ''
  for (const [k, v] of Object.entries(py.args)) {
    if (typeof v !== 'string') continue
    const nk = normToolName(k)
    if (nk === 'name' || nk === 'toolname' || nk === 'functionname' || nk === '工具名' || nk === '函数名') {
      innerName = v
      break
    }
  }
  const rawArgs = py.args.arguments ?? py.args.params ?? py.args.parameters ?? py.args.args
  let innerArgs: Record<string, unknown> = {}
  if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
    innerArgs = rawArgs as Record<string, unknown>
  } else if (typeof rawArgs === 'string' && rawArgs.trim()) {
    const s = rawArgs.trim()
    try {
      const v = JSON.parse(s) as unknown
      innerArgs =
        v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { action: s }
    } catch {
      // 裸字符串('up_info')→ action 值(绝大多数工具以 action 分发;
      // 若不匹配枚举,resolveCall 的键过滤会兜底)
      innerArgs = { action: s }
    }
  } else {
    // 无 arguments= 形参:其余键(action=... 等)即真实参数(剥中英文元键)
    const meta = new Set(['name', 'tool', 'tool_name', 'function', 'function_name', '工具名', '函数名'])
    innerArgs = Object.fromEntries(Object.entries(py.args).filter(([k]) => !meta.has(k)))
  }
  return { name: innerName || undefined, args: innerArgs }
}

interface ParsedTextCall {
  name: string
  args: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// 流式正文工具标记过滤(2026-08-19 SSE 暴露修复)
// ---------------------------------------------------------------------------
// SSE 流式转发时,模型的工具调用意图(<tool_call>/特殊 token/```json 块)
// 会作为正文实时打到对话窗口——用户要求合成后才显示。本过滤器在转发前
// 抑制标记段:标记前正文照常转发(打字机体验保留);标记段(开始→结束)
// 不转发,流结束后由 parseTextToolCalls 解析为真实调用。fence 误伤的
// 普通 JSON 展示块在 flush 补发(落定时随 message 一次性补显)。

/** 流式需抑制的标记对(fence:flush 未闭合时补发而非丢弃——可能是展示块) */
const STREAM_MARKS: Array<{ start: string; end: string; fence?: boolean }> = [
  { start: '<tool_call>', end: '</tool_call>' },
  { start: '<|tool_call_start|>', end: '<|tool_call_end|>' },
  { start: '```json', end: '```', fence: true },
]

/** 最长开始标记长度(尾部前缀保护窗口) */
const MAX_MARK_LEN = Math.max(...STREAM_MARKS.map((m) => m.start.length))

/** 流式正文工具标记过滤器:feed 喂 delta 返回可安全转发的文本 */
export class StreamCallFilter {
  private pending = ''
  private suppressing = false
  private endMark = ''
  private markStart = ''
  private fence = false
  /** 累计抑制的字符数(调用标记段);>0 且最终解析失败 → 防静默空回复 */
  suppressedChars = 0

  /** 喂入一个 delta,返回本次可安全转发的文本(可能为空串) */
  feed(delta: string): string {
    this.pending += delta
    let out = ''
    for (;;) {
      if (!this.suppressing) {
        // 最早出现的开始标记(多标记取最先)
        let hit: { idx: number; mark: (typeof STREAM_MARKS)[number] } | null = null
        for (const mark of STREAM_MARKS) {
          const idx = this.pending.indexOf(mark.start)
          if (idx >= 0 && (!hit || idx < hit.idx)) hit = { idx, mark }
        }
        if (hit) {
          out += this.pending.slice(0, hit.idx)
          // 跳过开始标记再找结束(fence 开始自身含 ```,不跳会立即误闭合)
          this.pending = this.pending.slice(hit.idx + hit.mark.start.length)
          this.suppressing = true
          this.endMark = hit.mark.end
          this.markStart = hit.mark.start
          this.fence = !!hit.mark.fence
          if (!this.fence) this.suppressedChars += hit.mark.start.length
          continue
        }
        // 无完整标记:尾部可能是标记前缀(跨 delta 分割)的字符暂缓转发
        const hold = this.trailingPrefixHold()
        if (this.pending.length > hold) {
          out += this.pending.slice(0, this.pending.length - hold)
          this.pending = this.pending.slice(this.pending.length - hold)
        }
        return out
      }
      // 抑制中:找结束标记,闭合则丢弃标记段继续处理剩余
      const idx = this.pending.indexOf(this.endMark)
      if (idx >= 0) {
        if (!this.fence) this.suppressedChars += idx + this.endMark.length
        this.pending = this.pending.slice(idx + this.endMark.length)
        this.suppressing = false
        this.endMark = ''
        this.markStart = ''
        this.fence = false
        continue
      }
      return out
    }
  }

  /** 尾部是某开始标记前缀的长度(防 `<tool_` + `call>` 分割漏判) */
  private trailingPrefixHold(): number {
    for (let hold = Math.min(this.pending.length, MAX_MARK_LEN); hold > 0; hold--) {
      const tail = this.pending.slice(-hold)
      if (STREAM_MARKS.some((m) => m.start.startsWith(tail))) return hold
    }
    return 0
  }

  /** 流结束:fence 未闭合补发含开始标记的整段(可能误伤的展示块);
   * 调用标记未闭合丢弃(半截调用无意义,parseTextToolCalls 的
   * 未闭合剥离保持正文一致) */
  flush(): string {
    if (this.suppressing) {
      const rest = this.fence ? this.markStart + this.pending : ''
      this.pending = ''
      this.suppressing = false
      this.endMark = ''
      this.markStart = ''
      this.fence = false
      return rest
    }
    const rest = this.pending
    this.pending = ''
    return rest
  }
}

/** 未闭合调用段剥离(流截断的半截标记:无结束标签的尾部段不进正文/解析;
 * 与 StreamCallFilter 的 flush 丢弃保持 UI 流式与落定 message 一致) */
function stripUnterminated(text: string): string {
  let lastOpen = text.lastIndexOf('<tool_call>')
  if (lastOpen >= 0 && text.lastIndexOf('</tool_call>') < lastOpen) {
    text = text.slice(0, lastOpen)
  }
  lastOpen = text.lastIndexOf('<|tool_call_start|>')
  if (lastOpen >= 0 && text.lastIndexOf('<|tool_call_end|>') < lastOpen) {
    text = text.slice(0, lastOpen)
  }
  return text
}

/** 参数名同义表(小模型参数名幻觉,值正确键不对:在线压测实测
 * read_file(file_path=...) 而 schema 是 path)——synonym → canonical */
const ARG_SYNONYMS: Record<string, string[]> = {
  path: ['file_path', 'filepath', 'file', 'filename', '路径', '文件路径', '文件'],
  query: ['q', 'search', 'search_text', 'searchtext', 'keyword', 'keywords', '关键词', '搜索词', '搜索内容'],
  text: ['content', 'message', 'msg', 'body', '内容', '文本', '消息', '任务内容', 'description', 'task_name', 'task'],
  qq: ['qq号', 'qq_number', 'user_qq', 'qqid', 'qq_id'],
  url: ['link', 'href', '网址', '链接', 'address'],
}
/** 同义词 → 规范名 反查(小写归一) */
const SYN2CANON: Record<string, string> = {}
for (const [canon, syns] of Object.entries(ARG_SYNONYMS)) {
  for (const s of syns) SYN2CANON[s.toLowerCase()] = canon
}
/** 键是否"内容风格"(中文/空格/非标识符)——键值颠倒幻觉的判别特征:
 * {"2026年科技新闻": "..."}(键是查询内容,值是别的) */
function isContentLikeKey(k: string): boolean {
  return !/^[A-Za-z_][\w]*$/.test(k)
}
/** 工具主 string 参数(required 优先,否则首个 string 属性)——单键值
 * 兜底映射目标 */
function primaryStringProp(tool: AgentTool): string | null {
  const props = (tool.parameters?.properties ?? {}) as Record<string, { type?: string }>
  const required = tool.parameters?.required
  if (Array.isArray(required)) {
    for (const r of required) {
      if (typeof r === 'string' && props[r]?.type === 'string') return r
    }
  }
  for (const [k, v] of Object.entries(props)) {
    if (v?.type === 'string') return k
  }
  return null
}

/**
 * 文本工具调用幻觉解析主入口:从正文里提取真实工具调用。
 * 返回 null = 没有可识别的调用(原样交给上层);命中时返回
 * { calls, text }(text 截断到首个调用片段前,编造结果全丢弃)。
 */
export function parseTextToolCalls(
  text: string,
  tools: AgentTool[],
): { calls: ParsedTextCall[]; text: string } | null {
  if (tools.length === 0) return null
  text = stripUnterminated(text)

  /**
   * 单个片段(obj/name 已提取)→ 归一为注册工具调用。
   * strict(默认):fence/裸 JSON 通道——未命中注册表返回 null(防普通
   * JSON 展示块误判);非严格(①/①b 容器内):明确的调用意图但工具名
   * 幻觉(在线压测实测 google/add_task)→ 按原名产出,引擎执行时报
   * "未知工具"错误回传 LLM,下一轮自愈改用正确工具——优于静默空回复
   * (流式过滤已吞掉标记段,解析失败用户只会看到空白)。
   */
  const resolveCall = (
    rawName: string | undefined,
    rawArgs: Record<string, unknown> | null,
    strict = true,
  ): ParsedTextCall | null => {
    let name = (rawName ?? '').trim()
    let args: Record<string, unknown> = rawArgs ?? {}
    // JSON 幻觉常见 {"action": "...", "params": {...}}:无工具名,靠
    // action 枚举值反查唯一命中工具(bili.action enum 含 'search')
    let tool = name ? fuzzyToolName(name, tools) : null
    if (!tool && typeof args.action === 'string') {
      for (const t of tools) {
        const act = t.parameters?.properties?.action as { enum?: unknown[] } | undefined
        if (act && Array.isArray(act.enum) && act.enum.includes(args.action)) {
          tool = t
          break
        }
      }
    }
    if (!tool) {
      if (strict || !name) return null
      // 幻觉名按原样产出:args 剥元键(name/tool/arguments)后原样携带
      const { name: _n, tool: _t, arguments: _a, ...rest } = args
      return { name, args: rest }
    }
    // params/arguments 嵌套提升:{"action","params"} → action 平铺 + params 展开
    if (args.params && typeof args.params === 'object' && !Array.isArray(args.params)) {
      const { action, ...rest } = args
      args = { ...(action !== undefined ? { action } : {}), ...(args.params as Record<string, unknown>), ...rest }
    } else if (args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)) {
      args = args.arguments as Record<string, unknown>
    }
    // 参数键过滤:只留 schema 定义过的键(去幻觉键,如 path);同义词
    // 归一(file_path→path);单键值内容风格键值颠倒兜底
    const allowed = tool.parameters?.properties ?? {}
    const filtered: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(args)) {
      if (k in allowed) {
        filtered[k] = v
        continue
      }
      // 同义词归一(read_file(file_path=...) → path);多键竞争同一名时
      // 取信息量更大的值(task_name='开会' vs description='明天 9 点开会')
      const canon = SYN2CANON[k.toLowerCase()]
      if (canon && canon in allowed) {
        const prev = filtered[canon]
        const better =
          !(canon in filtered) ||
          (typeof v === 'string' && typeof prev === 'string' && v.length > prev.length)
        if (better) filtered[canon] = v
      }
    }
    if (Object.keys(filtered).length === 0) {
      // 键值颠倒兜底:{"2026年科技新闻": "..."}(内容当键)→ 主参数=键名
      const entries = Object.entries(args)
      if (entries.length === 1 && typeof entries[0]![1] === 'string' && isContentLikeKey(entries[0]![0])) {
        const primaryKey = primaryStringProp(tool)
        if (primaryKey) filtered[primaryKey] = entries[0]![0]
      } else if (typeof args.action === 'string' && 'action' in allowed) {
        filtered.action = args.action
      } else if (Object.keys(args).length > 0) {
        // 小模型参数名幻觉(在线压测实测:send_task(task_name='开会',
        // description='明天 9 点开会') 而 schema 只有 text/qq——值对键
        // 不对,全滤掉会变 args={}:参数全可选的工具将静默空执行。
        // 原样保留(剥元键),引擎 validateRequiredArgs 报错回传自愈
        const { name: _n, tool: _t, arguments: _a, ...rest } = args
        Object.assign(filtered, rest)
      }
    }
    return { name: tool.name, args: filtered }
  }

  /** 片段定位:首个片段起始 index(正文截断点) */
  let cutAt = text.length
  const calls: ParsedTextCall[] = []
  // 已提取片段区间(同片段防多通道重复提取:①/①b 命中后,② 的裸 JSON
  // 行会把 <tool_call> 块内的 JSON 再提一遍 → 同一调用执行两次)
  const claimed: Array<[number, number]> = []
  const isClaimed = (start: number) => claimed.some(([s, e]) => start >= s && start < e)
  const push = (start: number, end: number, call: ParsedTextCall | null) => {
    if (call) {
      calls.push(call)
      cutAt = Math.min(cutAt, start)
      claimed.push([start, end])
    }
  }

  /**
   * 单片段体解析(①/①b 共用):JSON 对象 → 单调用;JSON 数组 → 逐元素;
   * 非 JSON → 位置式三件套 → 剥 [...] 数组包裹后按 Python name(kwargs) 解析。
   * (2026-08-19 实测回归:lfm2.5 输出 [bili_tool(...)],旧解析器
   * parsePyCall 要求以函数名开头,被前导方括号卡住 → 整段放弃原文输出)
   */
  const parseBody = (raw: string, strict: boolean): ParsedTextCall[] => {
    const body = raw.trim()
    if (!body) return []
    try {
      const v = JSON.parse(body) as unknown
      const items = Array.isArray(v) ? v : [v]
      const out: ParsedTextCall[] = []
      for (const item of items) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue
        const obj = item as Record<string, unknown>
        const name =
          typeof obj.name === 'string' ? obj.name : typeof obj.tool === 'string' ? obj.tool : undefined
        const args =
          obj.arguments && typeof obj.arguments === 'object' && !Array.isArray(obj.arguments)
            ? (obj.arguments as Record<string, unknown>)
            : obj
        const call = resolveCall(name, args, strict)
        if (call) out.push(call)
      }
      return out
    } catch {
      // 非 JSON:按位置式三件套 / Python 调用解析
    }
    // 位置式三件套(在线压测实测 lfm2.5 中文包装):
    // 工具名('read_file', '参数名': 'path', '参数值': 'C:\...')
    // 工具名='search', 参数名='query', 值='...'(键名含 值/参数值 变体)
    const posRe =
      /['"]?(?:工具名|函数名|tool_?name|function_?name)['"]?\s*[=(]\s*['"]([^'"]+)['"].*?['"]?(?:参数名|param_?name|键名?)['"]?\s*[:=]\s*['"]([^'"]+)['"].*?['"]?(?:参数值|param_?value|参数|值)['"]?\s*[:=]\s*['"]([^'"]*)['"]/s
    const pos = posRe.exec(body)
    if (pos) {
      const call = resolveCall(pos[1], { [pos[2]!]: pos[3] }, strict)
      if (call) return [call]
    }
    // 两件套变体:工具名='search', 参数={'query': '...', ...}(dict 直给)
    const posDictRe =
      /['"]?(?:工具名|函数名|tool_?name|function_?name)['"]?\s*[=(]\s*['"]([^'"]+)['"].*?['"]?(?:参数|param_?value|arguments|params|parameters)['"]?\s*[=:]\s*(\{[^{}]*\})/s
    const posDict = posDictRe.exec(body)
    if (posDict) {
      try {
        const dict = parsePyValue(posDict[2]!, { i: 0 })
        if (dict && typeof dict === 'object' && !Array.isArray(dict)) {
          const call = resolveCall(posDict[1], dict as Record<string, unknown>, strict)
          if (call) return [call]
        }
      } catch {
        // dict 解析失败 → 走 py 调用兜底
      }
    }
    const parsed = parsePyCall(stripArrayWrap(body))
    if (!parsed) return []
    const py = unwrapGenericCall(parsed)
    const call = resolveCall(py.name, py.args, strict)
    return call ? [call] : []
  }

  // ① 特殊 token:<|tool_call_start|>...<|tool_call_end|>(lfm2.5 实测)
  const tokenRe = /<\|tool_call_start\|>([\s\S]*?)<\|tool_call_end\|>/g
  for (const m of text.matchAll(tokenRe)) {
    const start = m.index ?? 0
    const end = start + m[0].length
    for (const call of parseBody(m[1] ?? '', false)) push(start, end, call)
  }

  // ①b <tool_call> XML 标签(本适配器 TOOL_CALL_GUIDE 引导的规范格式,
  //    也是 Qwen/Hermes 系模型的原生训练格式)
  const xmlRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g
  for (const m of text.matchAll(xmlRe)) {
    const start = m.index ?? 0
    const end = start + m[0].length
    for (const call of parseBody(m[1] ?? '', false)) push(start, end, call)
  }

  // ② fenced 代码块(```json {...} ```,nanbeige 实测)与裸 JSON 行
  const jsonCandidates: Array<{ start: number; body: string; strict: boolean }> = []
  const fenceRe = /```[a-zA-Z]*\s*([\s\S]*?)```/g
  for (const m of text.matchAll(fenceRe)) {
    // fence 严格:代码块里普通 JSON 展示常见,未命中注册表不产出
    jsonCandidates.push({ start: m.index ?? 0, body: (m[1] ?? '').trim(), strict: true })
  }
  // 裸 JSON 行(整行就是一个对象,贪婪到行尾配平的 },JSON.parse 兜底
  // 校验;避免把正文里碰巧的花括号误伤)
  for (const m of text.matchAll(/^[ \t]*(\{.*\})[ \t]*$/gm)) {
    // 非严格仅限"整条回复就是 JSON"(在线压测实测:{"name": "create_task",
    // ...} 幻觉名整身输出)——最强信号,引擎报"未知工具"让模型自愈;
    // 正文中间夹的展示 JSON 行保持严格,防普通展示块误判
    const wholeBody = m[1]!.trim()
    const isWholeReply = text.trim() === wholeBody
    jsonCandidates.push({ start: m.index ?? 0, body: wholeBody, strict: !isWholeReply })
  }
  for (const cand of jsonCandidates) {
    // 已被 ①/①b 提取的区间(如 <tool_call> 内的 JSON 行)不重复处理
    if (isClaimed(cand.start)) continue
    // 复用 parseBody(2026-08-19 压测:fence/裸 JSON 里的数组体
    // [{"name":...}] 旧实现 Array.isArray 直接跳过;且统一走
    // resolveCall 归一——纯展示块无 action/name 线索时自然返回空)
    for (const call of parseBody(cand.body, cand.strict)) {
      push(cand.start, cand.start + cand.body.length, call)
    }
  }

  if (calls.length === 0) return null
  return { calls, text: text.slice(0, cutAt).replace(/[\s`~-]*$/, '').trim() }
}

// ---------------------------------------------------------------------------
// 视觉输入(2026-08-19 GLM-4.6V-Flash 等本地视觉模型):user 消息的
// image part(base64 dataUrl)/ media part(kind=img,本地路径——QQ 收图
// 下载 / 拖拽上传)→ OpenAI vision content 数组。
// 仅 vision 模型发送图片;文本模型保持纯字符串 content(现状不破坏,
// 【图片已下载】文本标注兜底,LLM 仍可 read_file 读路径)。
// assistant 消息里的 image part(工具截图产物)不回传——OpenAI 格式
// assistant content 不支持 image_url,保持仅渲染端展示。
// ---------------------------------------------------------------------------

/** 单图文件上限(超出跳过该图;文本标注仍在,不破坏链路) */
const IMAGE_MAX_BYTES = 20 * 1024 * 1024
/** 单条消息最多附图(防多图撑爆上下文) */
const MESSAGE_MAX_IMAGES = 8
/** dataUrl 缓存上限(历史每轮回传,避免同一图片反复读盘编码) */
const IMAGE_CACHE_LIMIT = 16

/**
 * vision 模型识别(模型 key 命名启发式,覆盖主流本地视觉模型):
 * - 含 vl:qwen2.5-vl / qwen3-vl / internvl / minimax-vl 等
 * - 含 vision / llava / minicpm-v / moondream / pixtral
 * - "数字.数字v" 模式:glm-4.6v-flash / glm-4.5v 等 GLM 视觉系
 * 文本模型(lfm2.5-2.6b / nanbeige / qwen3-8b / glm-4.7-flash)不命中。
 */
export function isVisionModel(model: string): boolean {
  const m = model.toLowerCase()
  return (
    m.includes('vl') ||
    m.includes('vision') ||
    m.includes('llava') ||
    m.includes('minicpm-v') ||
    m.includes('moondream') ||
    m.includes('pixtral') ||
    /\d\.\d+v/.test(m)
  )
}

/** 扩展名 → MIME(未知扩展名按 jpeg 兜底) */
function imageMime(ext: string): string {
  switch (ext) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.bmp':
      return 'image/bmp'
    default:
      return 'image/jpeg'
  }
}

/** 本地图片 → dataUrl 缓存(path → {mtimeMs, dataUrl},mtime 变了重读) */
const imageDataUrlCache = new Map<string, { mtimeMs: number; dataUrl: string }>()

/** 本地图片文件 → base64 dataUrl(超限/读失败返回 null,由调用方跳过) */
async function localImageToDataUrl(path: string): Promise<string | null> {
  try {
    const st = await stat(path)
    if (!st.isFile() || st.size > IMAGE_MAX_BYTES) return null
    const cached = imageDataUrlCache.get(path)
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.dataUrl
    const buf = await readFile(path)
    const dataUrl = `data:${imageMime(extname(path).toLowerCase())};base64,${buf.toString('base64')}`
    // 重插保证 LRU 语义(Map 迭代序 = 插入序,超限删最旧)
    if (imageDataUrlCache.has(path)) imageDataUrlCache.delete(path)
    imageDataUrlCache.set(path, { mtimeMs: st.mtimeMs, dataUrl })
    if (imageDataUrlCache.size > IMAGE_CACHE_LIMIT) {
      const oldest = imageDataUrlCache.keys().next().value
      if (oldest !== undefined) imageDataUrlCache.delete(oldest)
    }
    return dataUrl
  } catch {
    return null
  }
}

/** 是否本地绝对路径(Windows 盘符 / UNC / POSIX 根) */
function isLocalFilePath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/')
}

/**
 * user 消息 parts → image_url 项的 url 列表:
 * - image part:dataUrl 直取(格式校验);
 * - media part(kind=img):本地路径读文件转 dataUrl(远程 URL 跳过,
 *   QQ 收图 main.cjs 已下载本地,远程场景由文本标注兜底)。
 */
async function collectImageUrls(parts: AgentPart[]): Promise<string[]> {
  const urls: string[] = []
  for (const p of parts) {
    if (urls.length >= MESSAGE_MAX_IMAGES) break
    if (p.type === 'image' && p.dataUrl.startsWith('data:image/')) {
      urls.push(p.dataUrl)
    } else if (p.type === 'media' && p.kind === 'img' && isLocalFilePath(p.url)) {
      const d = await localImageToDataUrl(p.url)
      if (d) urls.push(d)
    }
  }
  return urls
}

/** 文本 parts 拼接(user 消息 / assistant content) */
function joinText(parts: AgentPart[]): string {
  return parts
    .filter((p): p is Extract<AgentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

/** 最近一条 user 消息文本(上下文参数注入源:GLM-4-9B 漏填工具 query
 * 时引擎据此回填 B站链接/BV号——见 glm4ParseBareCalls 的 context 参数) */
function lastUserText(history: AgentMessage[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]
    if (m.role === 'user') return joinText(m.parts)
  }
  return ''
}

/**
 * 历史消息 → Chat Completions messages:
 * - user → {role:'user', content};**vision 模型且有图片 part 时**
 *   content 为数组([{type:'text'},{type:'image_url'}] OpenAI vision
 *   格式,2026-08-19 GLM-4.6V-Flash 支持)——无图/文本模型保持纯字符串;
 * - assistant → content + tool_calls(**不带 reasoning_content**,见文件头);
 * - 工具结果 → 独立的 {role:'tool', tool_call_id, content} 消息。
 *
 * 文本幻觉调用分流(2026-08-19 完整工具闭环):id 带 TEXT_CALL_ID_PREFIX
 * 前缀的调用是文本解析产出的伪调用——模型 chat template 不认识
 * tool_calls 消息/role:'tool'(LM Studio Jinja 渲染会失败或报 400),
 * 回传时转为文本形式:
 * - 伪调用 → assistant content 里回放规范 <tool_call> 块(模型看过
 *   自己的输出,格式一致续写自然);
 * - 伪调用结果 → user 消息 <tool_result> 包裹(配合 system 指引,
 *   模型知道这是工具的真实返回)。
 * 协议通道真调用(qwen3 等支持工具的模型)保持 OpenAI 原生格式不变。
 *
 * async(2026-08-19 视觉支持):本地图片读文件转 base64 dataUrl。
 */
export async function lmstudioHistoryToMessages(
  history: AgentMessage[],
  model = '',
): Promise<Array<Record<string, unknown>>> {
  const vision = isVisionModel(model)
  const out: Array<Record<string, unknown>> = []
  for (const msg of history) {
    if (msg.role === 'user') {
      const text = joinText(msg.parts)
      const imageUrls = vision ? await collectImageUrls(msg.parts) : []
      if (imageUrls.length > 0) {
        // vision content 数组:text part(空文本也保留占位)+ image_url 项
        out.push({
          role: 'user',
          content: [
            { type: 'text', text },
            ...imageUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
          ],
        })
      } else if (text) {
        out.push({ role: 'user', content: text })
      }
      continue
    }
    if (msg.role === 'system') {
      const text = joinText(msg.parts)
      if (text) out.push({ role: 'system', content: text })
      continue
    }
    const text = joinText(msg.parts)
    const calls = msg.parts.filter(
      (p): p is Extract<AgentPart, { type: 'tool-call' }> => p.type === 'tool-call',
    )
    const results = msg.parts.filter(
      (p): p is Extract<AgentPart, { type: 'tool-result' }> => p.type === 'tool-result',
    )
    // 分流:协议通道真调用 vs 文本解析伪调用
    const protoCalls = calls.filter((c) => !c.id.startsWith(TEXT_CALL_ID_PREFIX))
    const textCalls = calls.filter((c) => c.id.startsWith(TEXT_CALL_ID_PREFIX))
    const textCallIds = new Set(textCalls.map((c) => c.id))

    // 伪调用展开为规范文本回放(与 TOOL_CALL_GUIDE 引导格式一致)
    let content = text
    if (textCalls.length > 0) {
      const callText = textCalls
        .map((c) => {
          const args = typeof c.args === 'string' ? safeParseArgs(c.args) : (c.args ?? {})
          return `<tool_call>\n${JSON.stringify({ name: c.name, arguments: args })}\n</tool_call>`
        })
        .join('\n')
      content = content ? `${content}\n${callText}` : callText
    }

    const assistant: Record<string, unknown> = { role: 'assistant' }
    if (content) assistant.content = content
    if (protoCalls.length > 0) {
      assistant.tool_calls = protoCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
      }))
    }
    if (assistant.content || assistant.tool_calls) out.push(assistant)
    for (const p of results) {
      if (textCallIds.has(p.id)) {
        // 伪调用结果:user 消息回传(template 不支持 role:'tool')
        out.push({ role: 'user', content: `<tool_result>\n${truncateResult(p.result)}\n</tool_result>` })
      } else {
        out.push({ role: 'tool', tool_call_id: p.id, content: truncateResult(p.result) })
      }
    }
  }
  return out
}

/** 伪调用 args 字符串安全解析(引擎存 parts 时已对象化,字符串仅为防御) */
function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * 文本解析调用去重:同工具 + 同参数(键排序稳定 JSON)只保留第一个。
 * (2026-08-19 播放视频实测:GLM 对同一视频重复输出两个相同 open_file
 * 调用,引擎 batch 全执行 → 一次性播放两次。双保险:glm4ParseBareCalls
 * 内部已去重,此处兜底覆盖 parseTextToolCalls 来源,防漏网)
 */
function dedupeTextCalls<T extends { name: string; args: string }>(calls: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const c of calls) {
    let norm: string
    try {
      const obj = JSON.parse(c.args) as unknown
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        const sorted: Record<string, unknown> = {}
        for (const k of Object.keys(obj as Record<string, unknown>).sort()) {
          sorted[k] = (obj as Record<string, unknown>)[k]
        }
        norm = JSON.stringify(sorted)
      } else {
        norm = c.args
      }
    } catch {
      norm = c.args
    }
    const key = `${c.name}::${norm}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(c)
  }
  return out
}

/**
 * 发起一次流式请求(LM Studio /v1/chat/completions)。
 * 事件经 onEvent 实时转发(text-delta / reasoning-delta /
 * tool-partial-call / tool-call),完成后返回统一 ProviderOutcome。
 */
export async function lmstudioStreamChatCompletion(params: {
  config: AgentConfig
  system: string
  history: AgentMessage[]
  tools: AgentTool[]
  signal: AbortSignal
  onEvent: (event: AgentEvent) => void
  jsonMode?: boolean
  /** 兼容接缝签名:LM Studio 思考由模型决定,此参数忽略 */
  noThinking?: boolean
  /** 兼容接缝签名:LM Studio 不发送 max_tokens,输出预算由 LM Studio
   * 应用管理(见文件头注释);此参数在本适配器忽略 */
  maxOutputTokens?: number
}): Promise<ProviderOutcome> {
  const { config, system, history, tools, signal, onEvent, jsonMode } = params
  const model = config.model.trim()
  if (!model) {
    throw new Error('LM Studio 未选择模型——请在 Agent 设置「模型挂载管理」选用已加载模型(或手填模型 key)')
  }

  // GLM-4-9B 系档位(2026-08-19 实测:裸 Python 调用当正文 + 编造结果):
  // 追加第五解析通道/流式裸调用抑制/残片清洗;非 GLM 模型各接缝全部
  // 保持原行为(适配独立,互不干扰)
  const glm4 = isGlm4Model(model)
  const glm4BareNames = glm4 && tools.length > 0 ? tools.map((t) => t.name) : null
  // 地址归一:去尾部斜杠;/v1 结尾(OpenAI 习惯)不再重复拼
  const base = config.baseURL.trim().replace(/\/+$/, '')
  const v1 = base.toLowerCase().endsWith('/v1') ? base : `${base}/v1`
  const url = `${v1}/chat/completions`

  // 防"卸载后又自动加载"(2026-08-18 用户实测确认):LM Studio 对
  // chat/completions 里未加载的 model 会自动懒加载——若配置残留引用
  // 已卸载的模型,任何对话(主 Agent/Sub Agent 后台任务)都会把它重新
  // 拉回。发请求前先确认目标模型已加载,未加载直接报错引导手动加载,
  // 而不是靠 chat 触发懒加载。list 探测失败时放行(由后续请求自行报错)
  const root = base.toLowerCase().endsWith('/v1') ? base.slice(0, -3) : base
  try {
    const ctl = AbortSignal.timeout(5000)
    let lres = await fetch(`${root}/api/v0/models`, { signal: ctl })
    if (lres.status === 404 || lres.status === 405) {
      lres = await fetch(`${root}/api/v1/models`, { signal: AbortSignal.timeout(5000) })
    }
    if (lres.ok) {
      const ldata = (await lres.json()) as { data?: Array<Record<string, unknown>> }
      const larr = Array.isArray(ldata?.data) ? ldata.data : []
      const hit = larr.find(
        (m) =>
          (typeof m.id === 'string' ? m.id : '') === model || (typeof m.key === 'string' ? m.key : '') === model,
      )
      const state = hit && typeof hit.state === 'string' ? hit.state : hit ? 'loaded' : 'not-loaded'
      if (!hit || state === 'not-loaded') {
        throw new Error(
          `LM Studio 模型「${model}」当前未加载——请在 Agent 设置「模型挂载管理」先加载该模型(已卸载/未加载的模型不会自动加载,需手动加载后再对话)`,
        )
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('LM Studio 模型「')) throw err
    // 其它异常(list 网络失败等)放行,由后续 chat 请求自行报错
  }

  // API Key 可选:本地部署默认免鉴权,非空才带
  const key = config.apiKey.trim()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (key) headers.Authorization = `Bearer ${key}`

  // 小模型工具引导(2026-08-19 完整工具闭环):多数本地模型没有协议级
  // 工具通道,注入规范格式指引引导其输出可解析的 <tool_call> 块;配
  // parseTextToolCalls + 历史文本回传,形成与云端一致的工具体验。
  // 支持协议的模型(qwen3 等)走 tool_calls 通道,指引不生效仅为冗余。
  // GLM-4-9B 档位:追加专属补充指引(认可其裸 Python 调用习惯 + 反编造)
  const finalSystem =
    tools.length > 0 ? system + TOOL_CALL_GUIDE + (glm4 ? GLM4_TOOL_GUIDE_ADDON : '') : system

  /**
   * 组装请求体(tools 可选——本地模型常不支持 function calling;
   * stream 可选——推理模型(如 nanbeige4.2)流式时思维链会把预算耗尽、
   * 正文出不来,需非流式兜底;json 可选——response_format json_object,
   * 不支持 structured output 的模型会 400,由外层去掉后重发)。
   *
   * **不发送 max_tokens**(2026-08-18):输出预算/推理长度完全交由
   * LM Studio 应用(加载模型时配置)管理——本地模型不消耗云端额度,
   * 且屏蔽了程序内"输出预算"设置,这里也不该再有任何硬编码上限
   * (旧实现 `maxOutputTokens ?? 4096` 既没用设置值、又会在思维链
   * 超长时把正文掐断成空消息)。请求体不发 max_tokens,LM Studio
   * 按其内部配置自由输出。
   */
  const buildBody = async (useTools: boolean, stream: boolean, useJson: boolean): Promise<Record<string, unknown>> => ({
    model,
    messages: [
      ...(finalSystem ? [{ role: 'system', content: finalSystem }] : []),
      ...(await lmstudioHistoryToMessages(history, model)),
    ],
    // 有工具才带 tools(请求体最小化)
    ...(useTools ? { tools: lmstudioTools(tools) } : {}),
    // JSON 输出(LM Studio 支持 json_object;不支持 grammar 的模型 400,
    // 外层捕获后去 response_format 重发——prompt 里已要求 JSON,靠
    // prompt 约束 + 上层严格解析兜底)
    ...(useJson ? { response_format: { type: 'json_object' } } : {}),
    // 注意:不设 max_tokens——由 LM Studio 应用管理输出预算(见文件头注释)
    stream,
  })

  /**
   * 发起一次请求(流式或非流式)并解析。返回累积正文/工具调用/usage。
   * 空响应(无正文无工具调用)不在本层报错,由外层决定降级策略。
   */
  async function requestOnce(useTools: boolean, stream: boolean, useJson: boolean): Promise<{
    texts: string[]
    calls: Array<{ id: string; name: string; args: string }>
    usage: { input_tokens: number; output_tokens: number } | null
    truncated: boolean
    /** HTTP 状态码(!res.ok 时保留供外层 400 降级判断) */
    status?: number
  }> {
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        // 请求体深度清洗孤立代理(与其它 provider 同款,见 sse.ts)
        body: JSON.stringify(sanitizeJsonStrings(await buildBody(useTools, stream, useJson))),
        // 不传 signal(llhttp UAF 规避,见 sse.ts parseSse 注释)
      })
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err
      throw new Error(
        `无法连接 LM Studio(${url}):${(err as Error).message}——请确认 LM Studio 已启动 Developer 服务器(默认端口 1234)`,
      )
    }

    if (!res.ok || !res.body) {
      let detail = ''
      try {
        detail = (await res.text()).slice(0, 500)
      } catch {
        // 忽略读失败
      }
      // 400 且本次带了 response_format:标记给外层(可能是模型不支持
      // structured output,去掉 response_format 重发可救)
      if (res.status === 400 && useJson) {
        return { texts: [], calls: [], usage: null, truncated: false, status: 400 }
      }
      throw new Error(lmstudioErrorMessage(res.status, detail))
    }

    // ---------- 非流式:一次性解析 JSON ----------
    if (!stream) {
      const data = (await res.json()) as {
        choices?: Array<Record<string, unknown>>
        usage?: Record<string, unknown>
      }
      const msg = (data.choices?.[0]?.message ?? {}) as Record<string, unknown>
      const texts: string[] = []
      const calls: Array<{ id: string; name: string; args: string }> = []
      // 注意:非流式是本降级链的最后兜底——思维链已在先前的流式尝试里
      // 转发过,这里不再重复 emit reasoning(避免 UI 重复展示深度学习)
      const content = msg.content
      if (typeof content === 'string' && content) {
        texts.push(content)
        // 非流式:一次性转发正文——过标记过滤器(工具调用指令不暴露);
        // GLM 档位换用含裸调用抑制的防护过滤器
        const filter = glm4BareNames ? new Glm4StreamGuard(glm4BareNames) : new StreamCallFilter()
        const safe = filter.feed(content) + filter.flush()
        if (safe) onEvent({ type: 'text-delta', text: safe })
      }
      const tcs = msg.tool_calls
      if (Array.isArray(tcs)) {
        for (const tc of tcs as Array<Record<string, unknown>>) {
          const fn = tc.function as Record<string, unknown> | undefined
          const tcId = typeof tc.id === 'string' ? tc.id : ''
          const name = typeof fn?.name === 'string' ? fn.name : ''
          const args =
            typeof fn?.arguments === 'string'
              ? fn.arguments
              : typeof fn?.arguments === 'object'
                ? JSON.stringify(fn.arguments)
                : ''
          if (tcId) {
            calls.push({ id: tcId, name, args })
            onEvent({ type: 'tool-call', id: tcId, name, args })
          }
        }
      }
      const u = data.usage as Record<string, unknown> | undefined
      const usage: { input_tokens: number; output_tokens: number } | null =
        u && typeof u.prompt_tokens === 'number'
          ? {
              input_tokens: u.prompt_tokens,
              output_tokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : 0,
            }
          : null
      return {
        texts,
        calls,
        usage,
        truncated: data.choices?.[0]?.finish_reason === 'length',
      }
    }

    // ---------- 流式:SSE 增量 ----------
    // 流式工具调用按 index 累积(OpenAI 格式)
    const callDeltas = new Map<number, { id: string; name: string; args: string }>()
    const textParts: string[] = []
    let usage: { input_tokens: number; output_tokens: number } | null = null
    let truncated = false
    // 正文标记过滤(2026-08-19 SSE 暴露修复):工具调用指令(<tool_call>/
    // 特殊 token/```json 块)不实时打到对话窗口,正文照常打字机转发;
    // GLM 档位换用含裸调用抑制的防护过滤器(exec_command(…) 也不暴露)
    const sseFilter = glm4BareNames ? new Glm4StreamGuard(glm4BareNames) : new StreamCallFilter()

    for await (const evt of parseSse(res.body, signal)) {
      const d = evt.data
      const choice = (Array.isArray(d.choices) ? d.choices[0] : undefined) as
        | Record<string, unknown>
        | undefined
      const delta = choice?.delta as Record<string, unknown> | undefined
      if (delta) {
        // 思维链增量(推理模型:delta.reasoning_content)
        const rc = delta.reasoning_content
        if (typeof rc === 'string' && rc) onEvent({ type: 'reasoning-delta', text: rc })
        // 正文增量(过标记过滤器:调用指令段抑制,不暴露到窗口)
        const content = delta.content
        if (typeof content === 'string' && content) {
          textParts.push(content)
          const safe = sseFilter.feed(content)
          if (safe) onEvent({ type: 'text-delta', text: safe })
        }
        // 工具调用增量(同一 chunk 可含多条 index)
        const tcs = delta.tool_calls
        if (Array.isArray(tcs)) {
          for (const tc of tcs as Array<Record<string, unknown>>) {
            const index = typeof tc.index === 'number' ? tc.index : 0
            const fn = tc.function as Record<string, unknown> | undefined
            const entry = callDeltas.get(index) ?? { id: '', name: '', args: '' }
            if (typeof tc.id === 'string' && tc.id) entry.id = tc.id
            if (typeof fn?.name === 'string' && fn.name) entry.name = fn.name
            if (typeof fn?.arguments === 'string' && fn.arguments) entry.args += fn.arguments
            callDeltas.set(index, entry)
            if (entry.id) {
              onEvent({ type: 'tool-partial-call', id: entry.id, name: entry.name, args: entry.args })
            }
          }
        }
      }
      // 末尾 chunk 带 usage
      const u = d.usage as Record<string, unknown> | undefined
      if (u && typeof u.prompt_tokens === 'number') {
        usage = {
          input_tokens: u.prompt_tokens,
          output_tokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : 0,
        }
      }
      // 输出预算截断(finish_reason 'length')
      if (choice?.finish_reason === 'length') truncated = true
      if (signal.aborted) throw new DOMException('aborted', 'AbortError')
    }

    // 流结束:过滤器残余结算(fence 误伤的展示块补发;调用标记段已抑制)
    const tail = sseFilter.flush()
    if (tail) onEvent({ type: 'text-delta', text: tail })

    // 收尾:按 index 顺序输出完整工具调用(id 缺失的丢弃)
    const calls: Array<{ id: string; name: string; args: string }> = []
    for (const entry of callDeltas.values()) {
      if (!entry.id) continue
      calls.push({ id: entry.id, name: entry.name, args: entry.args })
      onEvent({ type: 'tool-call', id: entry.id, name: entry.name, args: entry.args })
    }

    return { texts: textParts, calls, usage, truncated }
  }

  // 降级链(2026-08-18 两轮实测调优):
  // ① 流式带工具(常规)→ ② 流式无工具(本地模型常不支持 function
  //   calling,空响应时降级)→ ③ 非流式无工具(推理模型如 nanbeige4.2
  //   流式时思维链耗尽预算、正文出不来;非流式能正确出正文)
  // 每级仅在上一级"空响应"(无正文无工具调用)时才触发
  async function runChain(useJson: boolean) {
    let out = await requestOnce(tools.length > 0, true, useJson)
    // 400 短路(不支持的 response_format 每级都会 400,直接交外层降级)
    if (out.status === 400) return out
    if (out.texts.length === 0 && out.calls.length === 0 && tools.length > 0) {
      out = await requestOnce(false, true, useJson)
    }
    if (out.texts.length === 0 && out.calls.length === 0) {
      out = await requestOnce(false, false, useJson)
    }
    return out
  }
  let out = await runChain(jsonMode === true)
  // json_object 兼容降级(2026-08-19 修复本地模型 Sub Agent 失效):
  // 不支持 structured output(grammar)的模型对 response_format 直接
  // 400——去掉 response_format 重发整条链,prompt 里已要求 JSON 输出,
  // 靠 prompt 约束 + 上层严格解析(extractJsonTitle 等)兜底;若 400
  // 另有原因,重发同样 400 → status 仍 400 → 走空响应报错
  if (out.status === 400 && jsonMode) {
    out = await runChain(false)
  }
  // 仍为空:报可读错误,避免引擎把空响应落定为"空消息"
  if (out.texts.length === 0 && out.calls.length === 0) {
    throw new Error(
      'LM Studio 返回空响应(无任何输出)——通常是所选模型未真正加载或当前模型不支持工具调用。请在「模型挂载管理」重新加载后重试;若不支持工具,可关闭部分工具再对话',
    )
  }

  // 文本工具调用幻觉解析(2026-08-19):小模型把工具调用当正文输出
  // (特殊 token / markdown JSON 块)——解析为真正的 tool_calls,正文
  // 截断到首个调用片段前(编造的"结果"段落丢弃,引擎执行真工具回填)。
  // 仅在协议通道没有产出任何 tool_calls 时介入(不干扰正常流)。
  // GLM-4-9B 档位:共享四通道未命中时追加第五通道——裸 Python 调用
  // (实测 exec_command("bili-tool login/whoami") 无任何包装标记)
  let finalText = out.texts.join('')
  let finalCalls = out.calls
  if (finalCalls.length === 0 && finalText && tools.length > 0) {
    // GLM-4-9B 上下文参数注入源(2026-08-20):最近 user 消息文本,
    // 供 glm4ParseBareCalls 在 bili 漏填 query 时回填链接/BV号
    const bareContext = glm4BareNames ? lastUserText(history) : undefined
    const parsed =
      parseTextToolCalls(finalText, tools) ??
      (glm4BareNames ? glm4ParseBareCalls(finalText, tools, bareContext) : null)
    if (parsed) {
      finalText = parsed.text
      finalCalls = dedupeTextCalls(
        parsed.calls.map((c, i) => ({
          id: `${TEXT_CALL_ID_PREFIX}${Date.now()}-${i}`,
          name: c.name,
          args: JSON.stringify(c.args),
        })),
      )
      for (const c of finalCalls) {
        onEvent({ type: 'tool-call', id: c.id, name: c.name, args: c.args })
      }
    } else {
      // 解析失败防落定泄漏(在线压测实测):流式过滤器吞了标记段(用户
      // 流式所见干净),但 finalText 仍含原始标记——落定 message 会把
      // <tool_call>/<|tool_call_start|> 原样显示。剥标记与流式一致;
      // 剥空且有抑制时给可见提示而非空白
      const stripper = glm4BareNames ? new Glm4StreamGuard(glm4BareNames) : new StreamCallFilter()
      const cleaned = stripper.feed(finalText) + stripper.flush()
      if (cleaned.trim() || stripper.suppressedChars === 0) {
        finalText = cleaned
      } else {
        finalText = '(模型尝试调用工具,但调用格式无法识别,已忽略)'
        onEvent({ type: 'text-delta', text: finalText })
      }
    }
  }

  // GLM-4-9B 档位正文清洗:残片标签(</tool_result> 等)与**工具名标签包裹**
  // (<工具名>…</工具名>,如 <notify>…</notify>)移除——实测编造结果带
  // </tool_result> 回声,调用意图会被当 XML 标签输出;真实结果经 user
  // 消息回传,正文里这些一律是伪造/残片。
  if (glm4) finalText = glm4SanitizeText(finalText, glm4BareNames ?? undefined)

  return {
    calls: finalCalls,
    text: finalText,
    usage: out.usage,
    aborted: signal.aborted,
    truncated: out.truncated || undefined,
  }
}
