/**
 * LM Studio GLM-4-9B 系模型适配(2026-08-19 GLM-4-9B-0414 实测优化)
 *
 * 实测问题(用户问「我B站登录了吗」,GLM-4-9B-0414 正文原样返回):
 *   exec_command("bili-tool login/whoami")ili-tool.exe: -352, 二维码过期,请重新生成并扫码确认
 *   </tool_result>
 * ① 调用意图当正文:GLM-4-9B 的 chat template 不把工具意图送 tool_calls
 *   协议通道,也不遵循 <tool_call> 指引,而是按其训练习惯输出**裸 Python
 *   风格调用**(无任何包装标记)——共享解析器(lmstudio-chat.ts)的四条
 *   通道(特殊 token / <tool_call> / fence / 裸 JSON 行)全部不命中,整段
 *   被当成正文落定,工具不执行;
 * ② 编造工具结果:调用后自行虚构 bili-tool.exe 的输出(-352 二维码过期),
 *   还模仿历史回传的 </tool_result> 标签——违反「停止等待真实结果」约定。
 *
 * 本模块是 GLM-4-9B 专属档位(工程约定:各模型的优化互相独立、零相互
 * 导入)——lmstudio-chat.ts 仅在 isGlm4Model 命中时接入本模块,其它模型
 * (nanbeige / lfm2.5 / qwen3 / glm-4.6v 等)不经过本模块任何代码路径,
 * 已调好的共享解析行为不受影响:
 * - isGlm4Model:GLM-4-9B 系识别;
 * - GLM4_TOOL_GUIDE_ADDON:GLM 专属补充指引(认可裸调用格式 + 反编造);
 * - glm4ParseBareCalls:落定裸调用解析(裸 Python 调用 → 真实 tool_calls,
 *   位置参数映射工具主参数,调用后编造的结果整体截断丢弃);
 * - Glm4StreamGuard:流式防护(标记对抑制 + 裸调用段抑制,API 与共享
 *   StreamCallFilter 同构,GLM 档位下直接替换);
 * - glm4SanitizeText:正文残片标签清洗(</tool_result> 等)。
 */

import type { AgentTool } from '../types'

// ---------------------------------------------------------------------------
// 模型识别
// ---------------------------------------------------------------------------

/**
 * GLM-4-9B 系识别:model key 归一(小写去非字母数字)后含 "glm49b"——
 * 覆盖 glm-4-9b / glm-4-9b-chat / glm-4-9b-chat-0414 及厂商前缀
 * (thudm/…、zai-org/…)变体。glm-4.5 / glm-4.6v / qwen / nanbeige 等
 * 其它系不命中(互不干扰)。
 */
export function isGlm4Model(model: string): boolean {
  return model.toLowerCase().replace(/[^a-z0-9]/g, '').includes('glm49b')
}

// ---------------------------------------------------------------------------
// 系统提示补充指引(GLM 档位专用,拼在共享 TOOL_CALL_GUIDE 之后)
// ---------------------------------------------------------------------------

/**
 * GLM-4-9B 不遵循 <tool_call> JSON 指引而坚持输出裸 Python 调用——与其
 * 对抗不如顺势认可:指引里明确两种格式皆可 + 反编造强化(实测它会接着
 * 调用虚构命令输出)。
 *
 * 2026-08-19 二轮实测修正:示例曾用 exec_command("bili-tool login/whoami")
 * ——有害示范(裸命令名不在 PATH 必然执行失败 + login/whoami 非法组合),
 * 模型照抄后向用户报"工具无法识别/未安装"。改为示范直接调用注册工具,
 * 并明令:B 站操作一律走 bili 工具(扫码登录的二维码展示/后台轮询等增强
 * 只在引擎 bili 工具里),exec_command 跑 bili-tool 命令行一律禁止。
 *
 * 2026-08-19 三轮实测修正(播放视频习惯性拒绝):用户说"播放视频",
 * 模型回"抱歉,我无法直接播放视频。请使用您的媒体播放器打开该文件
 * 进行播放"——按通用助手的训练习惯断定自己做不到,**根本没查工具表**
 * 就拒绝了(open_file 明明支持媒体在对话窗口内直接播放)。9B 模型的
 * 能力自我认知缺陷,须显式纠偏:能力判断规则(先查工具表再下结论 +
 * 禁止让用户自己操作) + 场景→工具映射表(播放/打开/执行/搜索)。
 */
export const GLM4_TOOL_GUIDE_ADDON = `

## 工具调用补充
除 <tool_call> 格式外,你也可以直接输出 Python 风格调用(单个参数可省略参数名):
bili(action="whoami")
read_file(path="C:\\test.txt")
remember(content="我是一只鲸鱼娘,温柔可爱", type="preference", tags=["人设"], protected=true)

## 能力判断(重要——回答前必读)与场景→工具映射
你不是纯文字助手:你有几十个工具。说"我无法/不能做"之前必须先查上方工具列表,
工具能做到就直接调用;禁止让用户自己操作、禁止反问"用哪个工具",自己按下面选。
**映射表**(→ 左边触发场景,右边优先工具;一个场景可列多个候选工具):
- 播视频/音频/图片、听歌、放歌 → open_file(path=完整路径),媒体在对话窗口直接播放
- 读文件内容/查看/分析 → read_file;写/建/保存文件 → write_file(content=全文,path=路径)
- 列目录/找文件 → list_dir(path);打开文档→展示给用户 → open_file
- 查时间/日期 → get_time;查系统信息/内存/系统状态 → system_info
- 发系统通知/提醒 → notify;调系统音量 → set_system_volume
- 执行命令/跑脚本/查进程 → exec_command;联网查资料/百度 → web_search
- 打开网页/网址 → open_url
- **音乐模式切换:用户明确说"切到/回到/换成音乐模式""音乐界面""播放控制界面" → switch_to_music**——注意:用户说"听歌/放首歌/放点音乐"是让本助手播放,**默认用 open_file 打开音频在对话窗口播放,不要切音乐模式**
- **记住/记忆/人设/身份/性格/偏好 → remember(content=完整原话,type,tags=["人设"],protected=true)**;忘/删 → forget;查记忆 → list_memory;改记忆 → update_memory;进化记忆 → evolve_memory
- 查对话窗口有什么媒体/改媒体参数 → list_conversation_media;设背景图 → import_background(path);列表/查设置 → get_island_settings
- 改主题色/缩放/字体/歌词源/背景/文字色 → set_theme_color / set_agent_scale / import_font / list_fonts / rename_font / set_font_color / set_font_weight / set_background_opacity / set_background_crop / set_lyric_provider
- 媒体库(播放列表/音频库/视频库) → music_control / list_playlist / remove_playlist_item / list_audio_library / import_audio_library / add_audio_to_playlist / remove_background / rename_audio_library / remove_audio_library / list_video_library / import_video_library / rename_video_library / remove_video_library / play_library_video / set_video_config / set_audio_config;列表/管理图片库 → list_library_images / rename_library_image;调媒体窗口宽 → set_media_window_size
- 提取图片/文档文字(OCR/解析) → glm_ocr / glm_file_parse;文档格式转换 → doc_convert
- B 站(登录/搜索/下载/扫码)→ bili;超星答题 → xxt
- 会话情况记录(说话风格/群特定要求)→ set_session_note;查/清 → get_session_note / clear_session_context;设定总结/心理揣测文风人格 → set_sub_agent_config;设主动陪伴开关/间隔 → set_proactive_config
- 配置 MCP/技能/工具开关/输出目录/QQ → mcp_config / skills_config / tools_config / set_output_dir / set_napcat_config / set_owner_qq;设输出预算/查余额 → set_output_budget / get_deepseek_balance;介绍功能/如何用 → get_feature_guide

规则:
- 有专用工具的场景**必须**用专用工具,禁止用 exec_command 绕路(如音量/通知/时间/记忆/媒体播放)
- 用户没给路径 → 先 list_dir 找,不要猜路径、不要因此拒绝
- 严禁说"我无法播放视频/音频,请用您的播放器打开"——open_file 就能播,必须调用
- B 站一律走 bili,禁止 exec_command 跑 bili-tool 命令行(不在 PATH 必失败)
- exec_command 只跑 shell 命令,可执行文件写完整路径
- 输出调用后立即停止,等 <tool_result> 送回真实结果;严禁编造执行结果(命令输出/文件内容/登录状态/识别结果等一律等真实返回)`

// ---------------------------------------------------------------------------
// 工具名匹配 / Python 字面量解析(与共享实现同语义的独立副本——
// 工程约定:模型适配模块自包含,不跨模块取工具函数)
// ---------------------------------------------------------------------------

/** 工具名归一:小写 + 去非字母数字汉字 */
const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '')

/** 工具名模糊匹配:精确 → 互含(取最短命中,最精确) */
function fuzzyToolName(name: string, tools: AgentTool[]): AgentTool | null {
  const n = normName(name)
  if (!n) return null
  let best: AgentTool | null = null
  let bestLen = Infinity
  for (const t of tools) {
    const tn = normName(t.name)
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
 *  dict/list)。反斜杠仅收敛 \\ \' \",其余(\U \d 等 Windows 路径段)
 *  原样保留——路径安全(与共享 parsePyValue 同款语义)。 */
function parsePyValue(src: string, pos: { i: number }): unknown {
  while (pos.i < src.length && /\s/.test(src[pos.i]!)) pos.i++
  const c = src[pos.i]
  if (c === '{' || c === '[') {
    const isObj = c === '{'
    pos.i++
    const obj: Record<string, unknown> = {}
    const arr: unknown[] = []
    while (pos.i < src.length) {
      while (pos.i < src.length && /[\s,]/.test(src[pos.i]!)) pos.i++
      if (src[pos.i] === (isObj ? '}' : ']')) {
        pos.i++
        return isObj ? obj : arr
      }
      if (isObj) {
        const key = String(parsePyValue(src, pos))
        // 分隔符:= 或 : 皆可(等号分隔的 dict 实测存在)
        while (pos.i < src.length && /[\s=:]/.test(src[pos.i]!)) pos.i++
        obj[key] = parsePyValue(src, pos)
      } else {
        arr.push(parsePyValue(src, pos))
      }
    }
    return isObj ? obj : arr
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
  // 防死循环:首字符不可识别时必须消费一个字符
  if (!word) {
    const ch = src[pos.i] ?? ''
    pos.i++
    return ch
  }
  const num = Number(word)
  return Number.isNaN(num) ? word : num
}

/** 从 openIdx(指向 '{')提取配平花括号内文(JSON 对象);未闭合返回 null */
function extractBraceBalanced(text: string, openIdx: number): { inner: string; end: number } | null {
  let depth = 0
  let quote = ''
  let escaped = false
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i]!
    if (quote) {
      if (escaped) {
        escaped = false
        continue
      }
      if (c === '\\') {
        escaped = true
        continue
      }
      if (c === quote) quote = ''
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return { inner: text.slice(openIdx + 1, i), end: i + 1 }
    }
  }
  return null
}

/** 从 openIdx(指向 '(')提取配平括号内文;未闭合(流截断)返回 null */
function extractBalanced(text: string, openIdx: number): { inner: string; end: number } | null {
  let depth = 0
  let quote = ''
  let escaped = false
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i]!
    if (quote) {
      if (escaped) {
        escaped = false
        continue
      }
      if (c === '\\') {
        escaped = true
        continue
      }
      if (c === quote) quote = ''
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      continue
    }
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return { inner: text.slice(openIdx + 1, i), end: i + 1 }
    }
  }
  return null
}

/** 顶层逗号切分(引号/括号/花括号内不切) */
function splitTopLevel(s: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote = ''
  let escaped = false
  let cur = ''
  for (const c of s) {
    if (quote) {
      cur += c
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === quote) quote = ''
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      cur += c
      continue
    }
    if (c === '(' || c === '[' || c === '{') {
      depth++
      cur += c
      continue
    }
    if (c === ')' || c === ']' || c === '}') {
      depth--
      cur += c
      continue
    }
    if (c === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  parts.push(cur)
  return parts
}

// ---------------------------------------------------------------------------
// 裸调用参数归一
// ---------------------------------------------------------------------------

/** 参数名同义归一表(精简副本,模块自包含约定)——synonym → canonical */
const ARG_SYNONYMS: Record<string, string> = {
  file_path: 'path', filepath: 'path', file: 'path', filename: 'path',
  路径: 'path', 文件路径: 'path', 文件: 'path',
  q: 'query', keyword: 'query', keywords: 'query', search_text: 'query',
  关键词: 'query', 搜索词: 'query', 搜索内容: 'query',
  content: 'text', message: 'text', msg: 'text', body: 'text', task_name: 'text',
  内容: 'text', 文本: 'text', 消息: 'text', 任务内容: 'text',
  qq号: 'qq', qq_number: 'qq', user_qq: 'qq', qqid: 'qq', qq_id: 'qq',
  link: 'url', href: 'url', 网址: 'url', 链接: 'url',
}

/** 工具主 string 参数(required 优先,否则首个 string 属性)——位置参数
 * (exec_command("cmd"))的映射目标 */
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

export interface Glm4ParsedCall {
  name: string
  args: Record<string, unknown>
}

/**
 * 裸调用参数解析与归一:
 * - kwargs:exec_command(command="x") / read_file('path'='C:\\…');
 * - 位置参数:exec_command("x") → 工具主参数(exec_command 的 command);
 * - params/arguments 嵌套提升、schema 键过滤、同义词归一、键全幻觉时
 *   原样保留(引擎 validateRequiredArgs 报错回传 LLM 自愈,不静默空执行)。
 */
function resolveBareArgs(tool: AgentTool, inner: string): Record<string, unknown> {
  const kwargs: Record<string, unknown> = {}
  const positional: unknown[] = []
  for (const part of splitTopLevel(inner)) {
    const s = part.trim()
    if (!s) continue
    const kw = /^['"]?([A-Za-z_]\w*)['"]?\s*=(?!=)\s*([\s\S]+)$/.exec(s)
    if (kw) {
      kwargs[kw[1]!] = parsePyValue(kw[2]!, { i: 0 })
    } else {
      positional.push(parsePyValue(s, { i: 0 }))
    }
  }
  // params/arguments/parameters 嵌套提升(bili(action='x', params={...}))
  for (const nested of ['params', 'arguments', 'parameters']) {
    const v = kwargs[nested]
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(kwargs, v as Record<string, unknown>)
      delete kwargs[nested]
    }
  }
  const allowed = tool.parameters?.properties ?? {}
  const filtered: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(kwargs)) {
    if (k === 'name' || k === 'tool') continue // 元键剥离
    if (k in allowed) {
      filtered[k] = v
      continue
    }
    const canon = ARG_SYNONYMS[k] ?? ARG_SYNONYMS[k.toLowerCase()]
    if (canon && canon in allowed) {
      const prev = filtered[canon]
      const better =
        !(canon in filtered) ||
        (typeof v === 'string' && typeof prev === 'string' && v.length > prev.length)
      if (better) filtered[canon] = v
    }
  }
  // 位置参数 → 工具主 string 参数(GLM-4-9B 实测:exec_command("cmd"))
  if (positional.length > 0) {
    const primary = primaryStringProp(tool)
    if (primary && !(primary in filtered)) {
      const p = positional[0]!
      filtered[primary] = typeof p === 'string' ? p : String(p)
    }
  }
  if (Object.keys(filtered).length === 0 && Object.keys(kwargs).length > 0) {
    // 键全幻觉:原样保留(剥元键),引擎报必填参数错误回传自愈
    const { name: _n, tool: _t, ...rest } = kwargs
    Object.assign(filtered, rest)
  }
  return filtered
}

// ---------------------------------------------------------------------------
// 落定裸调用解析
// ---------------------------------------------------------------------------

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 参数对象稳定序列化(键排序)——重复调用判定用:同工具 + 同参数只留一个 */
function stableArgsJson(args: Record<string, unknown>): string {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(args).sort()) out[k] = args[k]
  return JSON.stringify(out)
}

/**
 * 工具名匹配集:原名 + 去下划线变体(read_file → readfile)。模型实测
 * 两类变体:下划线后缀/省略下划线(bili_tool / readfile / listdir)。
 * 去下划线形式经 fuzzyToolName 归一后与注册名 exact 命中,零歧义。
 */
function nameAlternatives(names: string[]): string[] {
  const out: string[] = []
  for (const n of names) {
    out.push(n)
    const flat = n.replace(/_/g, '')
    if (flat !== n && flat.length > 2) out.push(flat)
  }
  return out
}

/**
 * exec_command 里的裸 bili-tool CLI 调用 → bili 工具调用转写
 * (2026-08-19 二轮实测:模型受系统提示 CLI 用法引导,稳定输出裸命令名
 * `bili-tool login --json`——不在 PATH 必失败,然后向用户报"工具无法
 * 识别/未安装")。转写后走引擎 bili 工具——扫码登录的二维码展示/后台
 * 轮询/下载管理等增强只在引擎工具里。保守条件任一不满足保持原调用:
 * - command 形如 `bili-tool[.exe] <action> [...params]`(裸命令名,无路径
 *   分隔符——模型已写完整路径的说明能执行成功,尊重原调用);
 * - action 必须在 bili 工具 action 枚举内(防幻觉 action 越权转写);
 * - 位置参数(非 -- 开头 token)拼接为 query,--flag 丢弃(引擎工具
 *   有自己的参数语义)。
 */
function rewriteBiliCli(call: Glm4ParsedCall, tools: AgentTool[]): Glm4ParsedCall {
  if (call.name !== 'exec_command') return call
  const cmd = typeof call.args.command === 'string' ? call.args.command.trim() : ''
  if (!cmd) return call
  const m = /^bili-tool(?:\.exe)?\s+([A-Za-z_]+)(?:\s+(.*))?$/.exec(cmd)
  if (!m) return call
  const bili = tools.find((t) => t.name === 'bili')
  if (!bili) return call
  const actEnum = (bili.parameters?.properties?.action as { enum?: unknown[] } | undefined)?.enum
  if (!Array.isArray(actEnum) || !actEnum.includes(m[1]!)) return call
  const rest = (m[2] ?? '')
    .split(/\s+/)
    .filter((s) => s && !s.startsWith('--'))
  const args: Record<string, unknown> = { action: m[1]! }
  if (rest.length > 0) args.query = rest.join(' ')
  return { name: 'bili', args }
}

/**
 * GLM-4-9B 裸调用解析主入口:从正文里提取裸 Python 风格调用。
 * 返回 null = 没有可识别的调用(原样交给上层);命中时返回
 * { calls, text }(text 截断到首个调用前——其后编造的"结果"段落
 * (如实测的 ili-tool.exe: -352 … + </tool_result>)整体丢弃,引擎执行
 * 真工具后回填)。
 *
 * 安全边界(裸调用无包装标记,须防普通正文误判):
 * - 只认注册工具名(模糊匹配),幻觉名不认——正文里碰巧的 foo(x) 不触发;
 * - 工具名与 '(' 之间不允许空白(防 "exec_command (see docs)" 类散文
 *   括号被当成调用触发真实命令执行);
 * - 括号必须配平(未闭合 = 流截断的半截调用,返回 null 交给上层流式
 *   一致的剥离路径)。
 *
 * 变体名支持(2026-08-19 逐工具对照测试发现):模型实测会输出注册名的
 * 变体(bili_tool / readfile / listdir——下划线后缀或省略下划线),旧
 * 入口正则只认精确注册名,这些调用整段漏掉被当正文。匹配集扩为
 * 原名 + 去下划线变体,再加最多 16 字符标识符延伸,实际命中的完整
 * token 经 fuzzyToolName 互含归一到注册工具(bili_tool → bili);
 * "名与 '(' 间无空白 / 括号配平"两道防线不变。
 *
 * 裸名 + 裸 JSON 形态(2026-08-19 播放视频实测):模型对带参工具
 * 输出"名独占一行 + 下一行裸 JSON"——`open_file\n{"path": "..."}`,
 * 名后**无括号**。旧实现两条通道(裸名 solo / 括号调用)都不认,整段
 * 漏掉不执行。新增通道 2 识别(名 + 换行 + JSON 对象配平)。
 *
 * 重复调用去重(2026-08-19 播放视频实测):模型对同一视频**重复输出
 * 两个相同 open_file 调用**(裸名+JSON × 2),引擎 batch 全执行 →
 * 一次性播放两次。返回前对 同工具 + 同参数(稳定 JSON) 去重,只留
 * 第一个——模型合法地多调同工具不同参数(如加两首歌)不受影响。
 */
export function glm4ParseBareCalls(
  text: string,
  tools: AgentTool[],
): { calls: Glm4ParsedCall[]; text: string } | null {
  if (!text || tools.length === 0) return null
  const calls: Glm4ParsedCall[] = []
  let cutAt = text.length

  // 通道 1:整条回复就只是一个工具名(端到端实测:无参工具只吐名不带
  // 括号——整条正文就是 "get_time")。整条唯一 token 是极强调用信号,
  // 误伤面极小(正常回复不会整条只有一个工具名),按无参调用产出
  const trimmed = text.trim()
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    const solo = fuzzyToolName(trimmed, tools)
    if (solo) return { calls: [{ name: solo.name, args: {} }], text: '' }
  }
  const alt = nameAlternatives(tools.map((t) => t.name)).map(escapeRe).join('|')

  // 通道 2:裸名独占一行 + 下一行裸 JSON(播放视频实测形态)。名后无
  // 括号、无空白连接——名独占一行的强调用信号 + 独立 JSON 参数行。
  // 误伤面:普通正文里"工具名独行 + 花括号行"极罕见
  const soloJsonRe = new RegExp(
    `(?:^|\\n)[ \\t]*(${alt})[A-Za-z0-9_]{0,16}[ \\t]*\\n[ \\t]*\\{`,
    'gm',
  )
  for (const m of text.matchAll(soloJsonRe)) {
    const start = m.index!
    const braceIdx = start + m[0].length - 1
    const bal = extractBraceBalanced(text, braceIdx)
    if (!bal) break // 未闭合 JSON:半截调用,交上层剥离路径
    const tool = fuzzyToolName(m[1]!, tools)
    if (!tool) continue
    let obj: unknown
    try {
      // bal.inner 不含外层花括号,需包回形成完整对象再 JSON.parse
      obj = JSON.parse(`{${bal.inner}}`)
    } catch {
      continue // JSON 不合法:不是调用段,跳过防误判
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue
    const raw = obj as Record<string, unknown>
    // 键过滤(schema 定义键优先,同义词归一,全幻觉原样保留由引擎自愈)
    const allowed = tool.parameters?.properties ?? {}
    const filtered: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(raw)) {
      if (k in allowed) {
        filtered[k] = v
        continue
      }
      const canon = ARG_SYNONYMS[k] ?? ARG_SYNONYMS[k.toLowerCase()]
      if (canon && canon in allowed) filtered[canon] = v
    }
    if (Object.keys(filtered).length === 0 && Object.keys(raw).length > 0) {
      Object.assign(filtered, raw)
    }
    calls.push({ name: tool.name, args: filtered })
    cutAt = Math.min(cutAt, start)
  }

  // 通道 3:括号裸调用(原逻辑,变体名 + 可选延伸)
  const re = new RegExp(`\\b(?:${alt})[A-Za-z0-9_]{0,16}\\(`, 'g')
  let searchFrom = 0
  for (;;) {
    re.lastIndex = searchFrom
    const m = re.exec(text)
    if (!m) break
    const start = m.index
    const openIdx = start + m[0].length - 1
    const bal = extractBalanced(text, openIdx)
    if (!bal) break // 未闭合半截调用:无法产出,交上层剥离路径
    const name = m[0].slice(0, -1) // 去尾 '('
    const tool = fuzzyToolName(name, tools)
    if (tool) {
      calls.push({ name: tool.name, args: resolveBareArgs(tool, bal.inner) })
      cutAt = Math.min(cutAt, start)
    }
    searchFrom = bal.end
  }

  if (calls.length === 0) return null
  // 裸 bili-tool CLI(exec_command 包装)→ bili 工具调用转写(见 rewriteBiliCli)
  const rewritten = calls.map((c) => rewriteBiliCli(c, tools))
  // 去重:同工具 + 同参数(稳定 JSON)只保留第一个——防"播放两次"
  const seen = new Set<string>()
  const uniq: Glm4ParsedCall[] = []
  for (const c of rewritten) {
    const key = `${c.name}::${stableArgsJson(c.args)}`
    if (seen.has(key)) continue
    seen.add(key)
    uniq.push(c)
  }
  return { calls: uniq, text: text.slice(0, cutAt).replace(/[\s`~-]*$/, '').trim() }
}

// ---------------------------------------------------------------------------
// 流式防护(GLM 档位替换共享 StreamCallFilter)
// ---------------------------------------------------------------------------

/** 抑制标记对(与共享 STREAM_MARKS 同款:双通道一致,UI 所见与落定一致) */
const G4_MARKS: Array<{ start: string; end: string; fence?: boolean }> = [
  { start: '<tool_call>', end: '</tool_call>' },
  { start: '<|tool_call_start|>', end: '<|tool_call_end|>' },
  { start: '```json', end: '```', fence: true },
]

/**
 * GLM-4-9B 流式防护过滤器:在共享标记对抑制(<tool_call>/特殊 token/
 * ```json fence)之上追加**裸调用段抑制**——注册工具名 + '(' 起吞到配平
 * 括号,调用指令不实时打到对话窗口;流结束由 glm4ParseBareCalls 解析为
 * 真实调用。API 与共享 StreamCallFilter 同构(feed/flush/suppressedChars),
 * GLM 档位下直接替换使用。
 *
 * 一致性约定(与落定解析严格对齐):
 * - 闭合裸调用段:流式丢弃 ↔ 落定解析截断;
 * - 裸调用闭合后的后续正文:一律抑制(drain)——落定按"截断到首个调用
 *   前"语义整体丢弃,且实测 GLM 调用后的"结果"段落全是编造;
 * - 未闭合裸调用(流截断):flush 丢弃 ↔ 落定解析返回 null(上层剥离路径)。
 *
 * 裸名 + 裸 JSON 形态(2026-08-19 播放视频实测):模型输出
 * "open_file\n{...}"(名独占一行无括号 + 独立 JSON 参数行),与括号裸
 * 调用同等抑制——solojson 模式吞到 JSON 花括号配平闭合,闭合后 drain
 * (与落定解析的通道 2 严格对齐)。
 */
export class Glm4StreamGuard {
  private pending = ''
  private mode: 'pass' | 'mark' | 'bare' | 'solojson' | 'drain' = 'pass'
  private endMark = ''
  private markStart = ''
  private fence = false
  private depth = 0
  private quote = ''
  private escaped = false
  private bareRe: RegExp
  private soloJsonRe: RegExp
  private rawNames: string[]
  private maxStartLen: number
  private maxNameLen: number
  /** 累计抑制的字符数(调用标记段/裸调用段);>0 且最终解析失败 → 防静默空回复 */
  suppressedChars = 0

  constructor(names: string[]) {
    this.rawNames = nameAlternatives(names)
    const alt = this.rawNames.map(escapeRe).join('|')
    // 与 glm4ParseBareCalls 同款:\b + 名(含去下划线变体) + 可选标识符
    // 延伸 + '('(名与括号间无空白;匹配变体名 bili_tool/readfile,
    // 流式与落定一致)
    this.bareRe = names.length
      ? new RegExp(`\\b(?:${alt})[A-Za-z0-9_]{0,16}\\(`, 'g')
      : /(?!)\(/g // 空名单兜底:空负向前瞻恒失败,永不匹配
    // 裸名独占一行 + 下一行 '{'(solo-json 形态,与落定通道 2 一致)
    this.soloJsonRe = names.length
      ? new RegExp(`(?:^|\\n)[ \\t]*(?:${alt})[A-Za-z0-9_]{0,16}[ \\t]*\\n[ \\t]*\\{`, 'gm')
      : /(?!)\(/g
    this.maxStartLen = Math.max(...G4_MARKS.map((m) => m.start.length))
    this.maxNameLen = names.reduce((m, n) => Math.max(m, n.length), 0)
  }

  /** 喂入一个 delta,返回本次可安全转发的文本(可能为空串) */
  feed(delta: string): string {
    this.pending += delta
    let out = ''
    for (;;) {
      if (this.mode === 'drain') {
        // 首个裸调用已闭合:其后正文全部抑制(与落定"截断到首个调用前"
        // 一致;实测调用后的"结果"段落是编造)
        this.suppressedChars += this.pending.length
        this.pending = ''
        return out
      }
      if (this.mode === 'mark') {
        const idx = this.pending.indexOf(this.endMark)
        if (idx >= 0) {
          if (!this.fence) this.suppressedChars += idx + this.endMark.length
          this.pending = this.pending.slice(idx + this.endMark.length)
          this.mode = 'pass'
          this.endMark = ''
          this.markStart = ''
          this.fence = false
          continue
        }
        return out
      }
      if (this.mode === 'bare') {
        let i = 0
        let closed = false
        while (i < this.pending.length) {
          const c = this.pending[i]!
          if (this.quote) {
            if (this.escaped) {
              this.escaped = false
              i++
              continue
            }
            if (c === '\\') {
              this.escaped = true
              i++
              continue
            }
            if (c === this.quote) this.quote = ''
            i++
            continue
          }
          if (c === "'" || c === '"') {
            this.quote = c
            i++
            continue
          }
          if (c === '(') this.depth++
          else if (c === ')') {
            this.depth--
            if (this.depth <= 0) {
              i++
              closed = true
              break
            }
          }
          i++
        }
        const consumed = Math.min(i, this.pending.length)
        this.suppressedChars += consumed
        this.pending = this.pending.slice(consumed)
        if (closed) {
          this.depth = 0
          this.quote = ''
          this.escaped = false
          this.mode = 'drain'
          continue
        }
        return out
      }
      if (this.mode === 'solojson') {
        // 裸名 + JSON 对象:吞到花括号配平闭合(引号内跳过)
        let i = 0
        let closed = false
        while (i < this.pending.length) {
          const c = this.pending[i]!
          if (this.quote) {
            if (this.escaped) {
              this.escaped = false
              i++
              continue
            }
            if (c === '\\') {
              this.escaped = true
              i++
              continue
            }
            if (c === this.quote) this.quote = ''
            i++
            continue
          }
          if (c === "'" || c === '"') {
            this.quote = c
            i++
            continue
          }
          if (c === '{') this.depth++
          else if (c === '}') {
            this.depth--
            if (this.depth <= 0) {
              i++
              closed = true
              break
            }
          }
          i++
        }
        const consumed = Math.min(i, this.pending.length)
        this.suppressedChars += consumed
        this.pending = this.pending.slice(consumed)
        if (closed) {
          this.depth = 0
          this.quote = ''
          this.escaped = false
          this.mode = 'drain'
          continue
        }
        return out
      }
      // pass:标记对 / 括号裸调用 / 裸名+JSON 取**最早**命中
      let hitIdx = Infinity
      let hitMark: (typeof G4_MARKS)[number] | null = null
      for (const mk of G4_MARKS) {
        const idx = this.pending.indexOf(mk.start)
        if (idx >= 0 && idx < hitIdx) {
          hitIdx = idx
          hitMark = mk
        }
      }
      this.bareRe.lastIndex = 0
      const bm = this.bareRe.exec(this.pending)
      this.soloJsonRe.lastIndex = 0
      const sm = this.soloJsonRe.exec(this.pending)
      // 三者取最早:标记对 / 括号裸调用 / 裸名+JSON
      let kind: 'bare' | 'solojson' | 'mark' = 'mark'
      if (bm && bm.index < hitIdx) {
        hitIdx = bm.index
        kind = 'bare'
      }
      if (sm && sm.index < hitIdx) {
        hitIdx = sm.index
        kind = 'solojson'
      }
      if (kind === 'bare' && bm) {
        out += this.pending.slice(0, bm.index)
        this.suppressedChars += bm[0].length
        this.pending = this.pending.slice(bm.index + bm[0].length)
        this.mode = 'bare'
        this.depth = 1
        this.quote = ''
        this.escaped = false
        continue
      }
      if (kind === 'solojson' && sm) {
        out += this.pending.slice(0, sm.index)
        const consumeTo = sm.index + sm[0].length - 1 // 指向 '{',留给配平
        this.suppressedChars += consumeTo - sm.index
        this.pending = this.pending.slice(consumeTo)
        this.mode = 'solojson'
        this.depth = 1
        this.quote = ''
        this.escaped = false
        continue
      }
      if (hitMark) {
        out += this.pending.slice(0, hitIdx)
        this.pending = this.pending.slice(hitIdx + hitMark.start.length)
        this.mode = 'mark'
        this.endMark = hitMark.end
        this.markStart = hitMark.start
        this.fence = !!hitMark.fence
        if (!this.fence) this.suppressedChars += hitMark.start.length
        continue
      }
      // 无命中:尾部可能是标记/工具名前缀(跨 delta 分割)的字符暂缓转发
      const hold = this.trailingHold()
      if (this.pending.length > hold) {
        out += this.pending.slice(0, this.pending.length - hold)
        this.pending = this.pending.slice(this.pending.length - hold)
      }
      return out
    }
  }

  /** 尾部暂缓长度:标记/工具名前缀/工具名变体延伸段;此外尾字符为标识符
   * 字符时暂留 1 字符(防上一 delta 放行的词尾字符与本 delta 工具名拼接
   * 出伪 \b 边界:"not"+"exec_command(" 拼成 notexec_command( 不得命中) */
  private trailingHold(): number {
    const max = Math.min(this.pending.length, Math.max(this.maxStartLen, this.maxNameLen + 16))
    for (let hold = max; hold > 0; hold--) {
      const tail = this.pending.slice(-hold)
      if (G4_MARKS.some((m) => m.start.startsWith(tail))) return hold
      // tail 是工具名前缀('bil'→bili),或 tail 以工具名开头且更长
      // ('bili_to'→变体延伸段 bili_tool)——跨 delta 调用中段,暂缓
      if (this.rawNames.some((n) => n.startsWith(tail) || (tail.length > n.length && tail.startsWith(n)))) {
        return hold
      }
    }
    if (this.pending.length > 0 && /[A-Za-z0-9_]/.test(this.pending.slice(-1))) return 1
    return 0
  }

  /** 流结束:未闭合 fence 补发(可能是展示块);未闭合调用标记/裸调用
   * 丢弃(半截调用无意义,与落定解析截断一致);drain 残余一并丢弃 */
  flush(): string {
    if (this.mode === 'mark') {
      const rest = this.fence ? this.markStart + this.pending : ''
      this.pending = ''
      this.mode = 'pass'
      this.endMark = ''
      this.markStart = ''
      this.fence = false
      return rest
    }
    if (this.mode === 'bare' || this.mode === 'solojson' || this.mode === 'drain') {
      this.pending = ''
      this.mode = 'pass'
      this.depth = 0
      this.quote = ''
      this.escaped = false
      return ''
    }
    const rest = this.pending
    this.pending = ''
    return rest
  }
}

// ---------------------------------------------------------------------------
// 正文残片清洗
// ---------------------------------------------------------------------------

/**
 * 正文残片标签清洗(GLM 实测:编造结果带 </tool_result> 残片;真实工具
 * 结果经 user 消息回传,assistant 正文里出现这些标签一律是伪造/回声):
 * - <tool_result>…</tool_result> 整对:内容是编造的"结果",整体丢弃;
 * - 孤立残片(开/闭标签)单独移除。
 */
export function glm4SanitizeText(text: string): string {
  if (!text) return text
  let out = text.replace(/<tool_result>[\s\S]*?<\/tool_result>/g, '')
  out = out.replace(/<\/?tool_result>/g, '')
  out = out.replace(/<\/tool_call>/g, '')
  out = out.replace(/<\|tool_call_end\|>/g, '')
  return out
}
